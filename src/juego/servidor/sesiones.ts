import { randomUUID } from "crypto";
import type { Collection } from "mongodb";
import { MAX_JUGADORES } from "../compartido/protocolo";
import { baseJuego } from "./cuentas";
import { duracionMinimaCopa, PISTAS_POR_COPA, type CopaDatos } from "./montaje";
import { resultadoCopa } from "./salas";

/**
 * LAS SESIONES DE COPA: la copa se juega en el navegador (sin servidor), pero el boleto se gasta
 * aquí y el premio se cobra aquí. Al entrar a una copa (con internet) se gasta el boleto y se
 * abre una sesión; al terminar, el navegador manda los lugares de cada pista y la sesión se
 * cierra y se paga, una sola vez. Viven en MongoDB (`juego_sesiones`), no en memoria, para
 * sobrevivir reinicios y funcionar con varias instancias del servidor.
 *
 * Validación ligera: una sesión se cobra una sola vez, nunca antes de lo que dura una copa
 * (duracionMinimaCopa) ni después de que caduca (CADUCA_MS), y los lugares tienen que ser
 * coherentes. El lugar final y los puntos los calcula el servidor (resultadoCopa); lo que diga el
 * navegador de ellos no cuenta.
 */

/**
 * Cuánto tiempo hay para cobrar una copa desde que se gastó su boleto. Es largo para que quien se
 * quedó sin internet a media copa la pueda cobrar al día siguiente (el navegador la guarda)
 */
export const CADUCA_MS = 24 * 60 * 60 * 1000;

export interface DocSesion {
  _id: string;
  uid: string;
  copa: string;
  dificil: boolean;
  creada: Date;
  /** MongoDB la borra sola después de esta fecha (índice TTL) */
  caduca: Date;
  estado: "abierta" | "cerrada";
  cerrada?: Date;
}

/** El índice TTL, creado una vez por conexión a la base */
const indices = new WeakMap<object, Promise<unknown>>();

/** La colección de las sesiones (null si no hay base), con su índice TTL */
export async function sesiones(): Promise<Collection<DocSesion> | null> {
  const base = await baseJuego();
  if (!base) return null;
  const col = base.collection<DocSesion>("juego_sesiones");
  if (!indices.has(base)) {
    indices.set(base, col.createIndex({ caduca: 1 }, { expireAfterSeconds: 0 }).catch((e) => {
      indices.delete(base);
      console.error("[juego] no se pudo crear el índice de las sesiones:", (e as Error).message);
    }));
  }
  await indices.get(base);
  return col;
}

type Resultado<T> = ({ ok: true } & T) | { ok: false; error: string; definitivo?: boolean };
const SIN_BASE = { ok: false as const, error: "No se pudo conectar con las cuentas; intenta en un rato" };

/** Abre la sesión de una copa (el boleto ya se gastó) */
export async function abrirSesionCopa(uid: string, copa: string, dificil: boolean, ahora = new Date()): Promise<Resultado<{ sesion: string }>> {
  const col = await sesiones();
  if (!col) return SIN_BASE;
  const sesion = randomUUID();
  await col.insertOne({ _id: sesion, uid, copa, dificil, creada: ahora, caduca: new Date(+ahora + CADUCA_MS), estado: "abierta" });
  return { ok: true, sesion };
}

/**
 * Los lugares de cada pista que manda el navegador, revisados: 3 pistas, cada una con los mismos
 * participantes (2 a MAX_JUGADORES ids distintos), y `yo` entre ellos. null si no cuadran
 */
export function sanearLugares(raw: unknown, yo: unknown): { pistas: string[][]; yo: string } | null {
  if (typeof yo !== "string" || !yo || yo.length > 64) return null;
  if (!Array.isArray(raw) || raw.length !== PISTAS_POR_COPA) return null;
  const pistas: string[][] = [];
  for (const lista of raw) {
    if (!Array.isArray(lista) || lista.length < 2 || lista.length > MAX_JUGADORES) return null;
    if (!lista.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) return null;
    if (new Set(lista).size !== lista.length) return null;
    pistas.push(lista as string[]);
  }
  const quienes = [...pistas[0]].sort().join("|");
  if (!pistas.every((p) => [...p].sort().join("|") === quienes)) return null;
  if (!pistas[0].includes(yo)) return null;
  return { pistas, yo };
}

/**
 * Cobra una sesión: la cierra (una sola vez) y da el resultado de la copa, calculado aquí.
 * `definitivo`: no tiene caso volver a intentarlo (ya se cobró, caducó, no es suya o los datos no
 * cuadran); sin él, fue un problema de la base y se puede reintentar
 */
export async function cerrarSesionCopa(
  uid: string,
  sesion: unknown,
  lugares: unknown,
  yo: unknown,
  copas: readonly CopaDatos[],
  ahora = new Date(),
): Promise<Resultado<{ copa: string; dificil: boolean; lugar: number; puntos: number }>> {
  if (typeof sesion !== "string" || !sesion) return { ok: false, error: "Esa copa no existe", definitivo: true };
  const datos = sanearLugares(lugares, yo);
  if (!datos) return { ok: false, error: "El resultado de la copa no cuadra", definitivo: true };
  const col = await sesiones();
  if (!col) return SIN_BASE;
  const doc = await col.findOne({ _id: sesion, uid });
  if (!doc) return { ok: false, error: "Esa copa no existe o ya caducó", definitivo: true };
  if (doc.estado !== "abierta") return { ok: false, error: "Esa copa ya se cobró", definitivo: true };
  if (+doc.caduca <= +ahora) return { ok: false, error: "Esa copa ya caducó", definitivo: true };
  const copa = copas.find((c) => c.id === doc.copa);
  if (!copa) return { ok: false, error: "Esa copa ya no existe", definitivo: true };
  if (+ahora - +doc.creada < duracionMinimaCopa(copa) * 1000) return { ok: false, error: "Esa copa no se pudo haber terminado tan rápido", definitivo: true };
  // Se cierra solo si sigue abierta: dos envíos juntos no cobran dos veces
  const cerrada = await col.findOneAndUpdate({ _id: sesion, uid, estado: "abierta" }, { $set: { estado: "cerrada", cerrada: ahora } });
  if (!cerrada) return { ok: false, error: "Esa copa ya se cobró", definitivo: true };
  const { lugar, puntos } = resultadoCopa(datos.pistas, datos.yo);
  return { ok: true, copa: doc.copa, dificil: doc.dificil, lugar, puntos };
}
