import {
  BOLETOS,
  MAX_STICKERS_BARRA,
  PRECIO_STICKER,
  PRECIO_VEHICULO,
  STICKERS,
  STICKERS_GRATIS,
  barraDeStickers,
  stickersPropios,
  PREMIO_LUGAR,
  PREMIO_MULTI,
  VEHICULOS_DE_PAGA,
  fusionarProgreso,
  maxBoletos,
  puedeUsar,
  type Cuenta,
  type Progreso,
  type ResultadoCopa,
  type ResultadoMulti,
  type Vehiculo,
} from "../compartido/protocolo";
import { cuentas, type DocCuenta, type Quien } from "./cuentas";

/**
 * EL MONEDERO de cada cuenta: boletos, monedas y vehículos comprados con ellas. Vive en la cuenta
 * (MongoDB, `juego_cuentas`) y solo el servidor lo cambia. Quién informa el resultado de una copa
 * es aparte (hoy la sala del servidor: salas.ts / socket.ts): aquí solo se cobra y se paga.
 *
 * Cada escritura lleva de condición lo que se leyó (si otra petición lo cambió en medio, se vuelve
 * a leer): dos peticiones juntas no gastan el mismo boleto ni cobran dos veces.
 */

/* ------------------------------- Puras ------------------------------- */

type DocBoletos = Pick<DocCuenta, "boletos" | "recargaDesde" | "boletera">;

/** Los boletos ahora: los guardados más los recargados desde `recargaDesde`, con tope (5, o 10 con la boletera) */
export function boletosAhora(doc: DocBoletos | null, ahora: number) {
  const { recargaMs } = BOLETOS;
  const max = maxBoletos(doc?.boletera);
  const guardados = doc?.boletos ?? max;
  if (guardados >= max) return { cantidad: max, siguienteEnMs: null, desde: null };
  const desde = doc?.recargaDesde ? +doc.recargaDesde : ahora;
  const recargados = Math.max(0, Math.floor((ahora - desde) / recargaMs));
  const cantidad = Math.min(max, guardados + recargados);
  if (cantidad >= max) return { cantidad: max, siguienteEnMs: null, desde: null };
  // Lo que ya avanzó la recarga del siguiente se conserva
  const nuevoDesde = desde + recargados * recargaMs;
  return { cantidad, siguienteEnMs: nuevoDesde + recargaMs - ahora, desde: nuevoDesde };
}

/** Gasta un boleto: lo que hay que guardar, o null si no hay. Con el tope lleno, la recarga empieza ahora */
export function gastarBoleto(doc: DocBoletos | null, ahora: number) {
  const b = boletosAhora(doc, ahora);
  if (b.cantidad < 1) return null;
  return { boletos: b.cantidad - 1, recargaDesde: new Date(b.desde ?? ahora) };
}

const FECHA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Hermosillo", year: "numeric", month: "2-digit", day: "2-digit" });
/** El día (en Hermosillo) de una fecha: "2026-11-04". Las monedas de cada copa se ganan una vez por día */
export const diaDe = (fecha: Date): string => FECHA.format(fecha);

/** Monedas por el lugar final de una copa en Difícil */
export const premioDeLugar = (lugar: number): number => PREMIO_LUGAR[lugar - 1] ?? 0;

/**
 * Las monedas ya no se desbloquean: cualquier copa en Difícil paga desde la primera vez, según el
 * lugar. Se queda la función (y `Cuenta.monedasActivas`, siempre true) para las apps que aún lo leen
 */
export const monedasActivas = (_progreso: Progreso = {}): boolean => true;

/** La cuenta como la ve el cliente, desde su documento */
export function cuentaDesde(quien: Pick<Quien, "uid" | "invitado">, doc: DocCuenta | null, ahora = Date.now()): Cuenta {
  const b = boletosAhora(doc, ahora);
  const hoy = diaDe(new Date(ahora));
  const progreso = doc?.progreso ?? {};
  return {
    uid: quien.uid,
    invitado: quien.invitado,
    paquetes: doc?.paquetes ?? [],
    vehiculos: doc?.vehiculos ?? [],
    stickers: stickersPropios(doc?.stickers),
    barraStickers: barraDeStickers(doc?.barraStickers, stickersPropios(doc?.stickers)),
    monedas: doc?.monedas ?? 0,
    monedasActivas: monedasActivas(progreso),
    boletera: doc?.boletera ?? false,
    boletos: { cantidad: b.cantidad, max: maxBoletos(doc?.boletera), siguienteEnMs: b.siguienteEnMs },
    pagadasHoy: Object.entries(doc?.monedasDia ?? {})
      .filter(([, dia]) => dia === hoy)
      .map(([copa]) => copa),
    progreso,
  };
}

/* ----------------------------- Con la base ----------------------------- */

type Resultado<T> = ({ ok: true } & T) | { ok: false; error: string };
const SIN_BASE = { ok: false as const, error: "No se pudo conectar con las cuentas; intenta en un rato" };
const INTENTOS = 5;

/** Condición "este campo sigue como lo leí" (o sigue sin existir), para los filtros de MongoDB */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const igualA = (valor: unknown): any => (valor === undefined ? { $exists: false } : valor);

/**
 * Escribe con upsert; si otra petición creó la cuenta al mismo tiempo (clave duplicada), regresa
 * null para que se vuelva a leer y a intentar
 */
async function escribir<T>(op: () => Promise<T>): Promise<T | null> {
  try {
    return await op();
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return null;
    throw e;
  }
}

/** La cuenta como la ve el cliente (sin base: la de una cuenta nueva) */
export async function cuentaDe(quien: Quien): Promise<Cuenta> {
  const doc = await (await cuentas())?.findOne({ _id: quien.uid });
  return cuentaDesde(quien, doc ?? null);
}

/** Gasta un boleto para entrar a una copa */
export async function usarBoleto(uid: string, ahora = Date.now()): Promise<Resultado<{ boletos: number }>> {
  const col = await cuentas();
  if (!col) return SIN_BASE;
  for (let i = 0; i < INTENTOS; i++) {
    const doc = await col.findOne({ _id: uid });
    const nuevo = gastarBoleto(doc, ahora);
    if (!nuevo) {
      const minutos = Math.max(1, Math.ceil((boletosAhora(doc, ahora).siguienteEnMs ?? 0) / 60000));
      return { ok: false, error: `No tienes boletos: el siguiente llega en ${minutos} min` };
    }
    const r = await escribir(() =>
      col.updateOne(
        { _id: uid, boletos: igualA(doc?.boletos), recargaDesde: igualA(doc?.recargaDesde) },
        { $set: nuevo, $setOnInsert: { paquetes: [], creada: new Date(ahora) } },
        { upsert: !doc },
      ),
    );
    if (r && (r.modifiedCount || r.upsertedCount)) return { ok: true, boletos: nuevo.boletos };
  }
  return { ok: false, error: "No se pudo usar el boleto; intenta otra vez" };
}

/** ¿Tiene al menos un boleto? (sin gastarlo) Devuelve un error o null */
export async function revisarBoleto(uid: string, ahora = Date.now()): Promise<string | null> {
  const col = await cuentas();
  if (!col) return SIN_BASE.error;
  const b = boletosAhora(await col.findOne({ _id: uid }), ahora);
  if (b.cantidad >= 1) return null;
  const minutos = Math.max(1, Math.ceil((b.siguienteEnMs ?? 0) / 60000));
  return `No tienes boletos: el siguiente llega en ${minutos} min`;
}

/** Monedas por el lugar final de una partida multijugador */
export const premioMulti = (lugar: number): number => PREMIO_MULTI[lugar - 1] ?? 0;

/** Terminó una partida multijugador: paga el lugar (sin límite por día: ya costó un boleto) */
export async function premiarMulti(uid: string, lugar: number, ahora = new Date()): Promise<Resultado<{ resultado: ResultadoMulti }>> {
  const monedas = premioMulti(lugar);
  const resultado: ResultadoMulti = { lugar, monedas };
  if (monedas <= 0) return { ok: true, resultado };
  const col = await cuentas();
  if (!col) return SIN_BASE;
  await col.updateOne({ _id: uid }, { $inc: { monedas }, $setOnInsert: { paquetes: [], creada: ahora } }, { upsert: true });
  return { ok: true, resultado };
}

/**
 * Terminó una copa (`lugar` final, `puntos` de copa): guarda lo mejor en el progreso y, en Difícil
 * con las monedas activas (esta misma copa puede activarlas), paga el lugar si hoy no había pagado
 */
export async function premiarCopa(
  uid: string,
  copa: string,
  dificil: boolean,
  lugar: number,
  puntos: number,
  ahora = new Date(),
): Promise<Resultado<{ resultado: ResultadoCopa }>> {
  const col = await cuentas();
  if (!col) return SIN_BASE;
  const clave = dificil ? `${copa}-dificil` : copa;
  const hoy = diaDe(ahora);
  for (let i = 0; i < INTENTOS; i++) {
    const doc = await col.findOne({ _id: uid });
    const antes = doc?.progreso ?? {};
    const progreso = fusionarProgreso(antes, { [clave]: { mejorLugar: lugar, mejoresPuntos: puntos } });
    const yaPagoHoy = dificil && doc?.monedasDia?.[copa] === hoy;
    const monedas = dificil && !yaPagoHoy ? premioDeLugar(lugar) : 0;
    const resultado: ResultadoCopa = { copa, dificil, lugar, puntos, monedas, yaPagoHoy, desbloqueo: false };
    const r = await escribir(() =>
      col.updateOne(
        // Que nadie haya pagado esta copa hoy ni cambiado el progreso en medio
        { _id: uid, [`monedasDia.${copa}`]: igualA(doc?.monedasDia?.[copa]), progreso: igualA(doc?.progreso) },
        {
          $set: { progreso, ...(monedas > 0 ? { [`monedasDia.${copa}`]: hoy } : {}) },
          ...(monedas > 0 ? { $inc: { monedas } } : {}),
          $setOnInsert: { paquetes: [], creada: ahora },
        },
        { upsert: !doc },
      ),
    );
    if (r && (r.modifiedCount || r.upsertedCount || r.matchedCount)) return { ok: true, resultado };
  }
  return { ok: false, error: "No se pudo guardar el resultado de la copa" };
}

/**
 * Compra un sticker con monedas (los gratis ya son de todos). Si la barra del festejo tiene lugar,
 * entra en ella de una vez
 */
export async function comprarSticker(uid: string, sticker: string): Promise<Resultado<{ monedas: number }>> {
  if (!(STICKERS as readonly string[]).includes(sticker)) return { ok: false, error: "Ese sticker no existe" };
  if ((STICKERS_GRATIS as readonly string[]).includes(sticker)) return { ok: false, error: "Ese sticker ya es tuyo" };
  const col = await cuentas();
  if (!col) return SIN_BASE;
  const doc = await col.findOne({ _id: uid });
  if (!doc) return { ok: false, error: `Te faltan monedas: cuesta ${PRECIO_STICKER}` };
  if ((doc.stickers ?? []).includes(sticker)) return { ok: false, error: "Ese sticker ya es tuyo" };
  const barra = barraDeStickers(doc.barraStickers, stickersPropios(doc.stickers));
  const r = await col.updateOne(
    { _id: uid, monedas: { $gte: PRECIO_STICKER }, stickers: { $ne: sticker } },
    {
      $inc: { monedas: -PRECIO_STICKER },
      $addToSet: { stickers: sticker },
      ...(barra.length < MAX_STICKERS_BARRA ? { $set: { barraStickers: [...barra, sticker] } } : {}),
    },
  );
  if (!r.modifiedCount) return { ok: false, error: `Te faltan monedas: cuesta ${PRECIO_STICKER}` };
  return { ok: true, monedas: (doc.monedas ?? 0) - PRECIO_STICKER };
}

/** Guarda la barra del festejo (saneada: solo de los suyos, hasta MAX_STICKERS_BARRA) */
export async function ponerBarraStickers(uid: string, pedida: unknown): Promise<Resultado<{ barra: string[] }>> {
  const col = await cuentas();
  if (!col) return SIN_BASE;
  const doc = await col.findOne({ _id: uid });
  const barra = barraDeStickers(pedida, stickersPropios(doc?.stickers));
  // Sin cuenta guardada todavía (se crea al conectarse) solo tiene los gratis: no hay nada que guardar
  if (doc) await col.updateOne({ _id: uid }, { $set: { barraStickers: barra } });
  return { ok: true, barra };
}

/** Compra un vehículo de paga con monedas */
export async function comprarVehiculo(uid: string, vehiculo: string): Promise<Resultado<{ monedas: number }>> {
  if (!VEHICULOS_DE_PAGA.includes(vehiculo as Vehiculo)) return { ok: false, error: "Ese vehículo no se compra con monedas" };
  const col = await cuentas();
  if (!col) return SIN_BASE;
  const doc = await col.findOne({ _id: uid });
  if (!doc) return { ok: false, error: `Te faltan monedas: cuesta ${PRECIO_VEHICULO}` };
  if (puedeUsar(vehiculo as Vehiculo, doc.paquetes ?? [], doc.progreso ?? {}, doc.vehiculos ?? [])) return { ok: false, error: "Ese vehículo ya es tuyo" };
  const r = await col.updateOne(
    { _id: uid, monedas: { $gte: PRECIO_VEHICULO }, vehiculos: { $ne: vehiculo } },
    { $inc: { monedas: -PRECIO_VEHICULO }, $addToSet: { vehiculos: vehiculo } },
  );
  if (!r.modifiedCount) return { ok: false, error: `Te faltan monedas: cuesta ${PRECIO_VEHICULO}` };
  return { ok: true, monedas: (doc.monedas ?? 0) - PRECIO_VEHICULO };
}
