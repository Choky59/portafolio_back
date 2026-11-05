import {
  BOLETOS,
  PRECIO_VEHICULO,
  PREMIO_LUGAR,
  VEHICULOS_DE_PAGA,
  fusionarProgreso,
  puedeUsar,
  type Cuenta,
  type Progreso,
  type ResultadoCopa,
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

/** Los boletos ahora: los guardados más los recargados desde `recargaDesde`, con tope */
export function boletosAhora(doc: Pick<DocCuenta, "boletos" | "recargaDesde"> | null, ahora: number) {
  const { max, recargaMs } = BOLETOS;
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
export function gastarBoleto(doc: Pick<DocCuenta, "boletos" | "recargaDesde"> | null, ahora: number) {
  const b = boletosAhora(doc, ahora);
  if (b.cantidad < 1) return null;
  return { boletos: b.cantidad - 1, recargaDesde: new Date(b.desde ?? ahora) };
}

const FECHA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Hermosillo", year: "numeric", month: "2-digit", day: "2-digit" });
/** El día (en Hermosillo) de una fecha: "2026-11-04". Las monedas de cada copa se ganan una vez por día */
export const diaDe = (fecha: Date): string => FECHA.format(fecha);

/** Monedas por el lugar final de una copa en Difícil */
export const premioDeLugar = (lugar: number): number => PREMIO_LUGAR[lugar - 1] ?? 0;

/** ¿Ya ganó alguna copa en Difícil en 1º? (desde entonces hay monedas) */
export const monedasActivas = (progreso: Progreso = {}): boolean =>
  Object.entries(progreso).some(([copa, v]) => copa.endsWith("-dificil") && v.mejorLugar === 1);

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
    monedas: doc?.monedas ?? 0,
    monedasActivas: monedasActivas(progreso),
    boletos: { cantidad: b.cantidad, max: BOLETOS.max, siguienteEnMs: b.siguienteEnMs },
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
    const activas = dificil && monedasActivas(progreso);
    const yaPagoHoy = activas && doc?.monedasDia?.[copa] === hoy;
    const monedas = activas && !yaPagoHoy ? premioDeLugar(lugar) : 0;
    const resultado: ResultadoCopa = { copa, dificil, lugar, puntos, monedas, yaPagoHoy, desbloqueo: activas && !monedasActivas(antes) };
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

/** Compra un vehículo de paga con monedas */
export async function comprarVehiculo(uid: string, vehiculo: string): Promise<Resultado<{ monedas: number }>> {
  if (!VEHICULOS_DE_PAGA.includes(vehiculo as Vehiculo)) return { ok: false, error: "Ese vehículo no se compra con monedas" };
  const col = await cuentas();
  if (!col) return SIN_BASE;
  const doc = await col.findOne({ _id: uid });
  if (!doc || !monedasActivas(doc.progreso)) return { ok: false, error: "Gana una copa en Difícil para desbloquear las monedas" };
  if (puedeUsar(vehiculo as Vehiculo, doc.paquetes ?? [], doc.progreso ?? {}, doc.vehiculos ?? [])) return { ok: false, error: "Ese vehículo ya es tuyo" };
  const r = await col.updateOne(
    { _id: uid, monedas: { $gte: PRECIO_VEHICULO }, vehiculos: { $ne: vehiculo } },
    { $inc: { monedas: -PRECIO_VEHICULO }, $addToSet: { vehiculos: vehiculo } },
  );
  if (!r.modifiedCount) return { ok: false, error: `Te faltan monedas: cuesta ${PRECIO_VEHICULO}` };
  return { ok: true, monedas: (doc.monedas ?? 0) - PRECIO_VEHICULO };
}
