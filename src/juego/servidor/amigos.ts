import type { Collection } from "mongodb";
import { LARGO_NOMBRE } from "../compartido/protocolo";
import { nombreOfensivo } from "../compartido/nombres";
import { baseJuego, cuentas, type DocCuenta } from "./cuentas";

/**
 * LOS AMIGOS. Cada cuenta tiene un código de amigo de 6 números (`codigoAmigo`, único) que se
 * comparte; con él se manda una solicitud y el otro la acepta (o la rechaza). La amistad es mutua.
 * Todo vive en el documento de la cuenta (juego_cuentas): `amigos`, `solicitudes` (las que le
 * llegaron) y `enviadas` (las suyas, pendientes), como uids. Hacia el navegador nunca sale un uid:
 * a cada persona se le conoce por su código de amigo.
 *
 * Quién está conectado y en qué sala lo sabe el socket (socket.ts): aquí solo la base.
 */

/** Lo más que se guarda de cada lista (una cuenta no puede llenar la de otra sin fin) */
export const MAX_AMIGOS = 100;
export const MAX_SOLICITUDES = 50;

type Resultado<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const SIN_BASE = { ok: false as const, error: "No se pudo conectar con las cuentas; intenta en un rato" };

const indices = new WeakMap<object, Promise<unknown>>();

/** Las cuentas, con el índice único de los códigos de amigo (se crea una vez) */
async function coleccion(): Promise<Collection<DocCuenta> | null> {
  const base = await baseJuego();
  const col = await cuentas();
  if (!base || !col) return null;
  if (!indices.has(base)) {
    indices.set(
      base,
      col.createIndex({ codigoAmigo: 1 }, { unique: true, partialFilterExpression: { codigoAmigo: { $type: "string" } } }).catch((e) => {
        indices.delete(base);
        console.error("[juego] no se pudo crear el índice de los códigos de amigo:", (e as Error).message);
      }),
    );
  }
  await indices.get(base);
  return col;
}

/** Un código de amigo: 6 números, sin empezar en 0 */
export const codigoAlAzar = (azar: () => number = Math.random) => String(100000 + Math.floor(azar() * 900000));

/** El código tal como lo escribió (con espacios o guiones): los 6 números, o null */
export function normalizarCodigoAmigo(texto: unknown): string | null {
  if (typeof texto !== "string" && typeof texto !== "number") return null;
  const digitos = String(texto).replace(/\D/g, "");
  return /^[1-9]\d{5}$/.test(digitos) ? digitos : null;
}

/** El nombre que se guarda para que lo vean sus amigos ('' si no sirve) */
export function sanearNombreAmigo(nombre: unknown): string {
  if (typeof nombre !== "string") return "";
  const limpio = nombre.trim().replace(/\s+/g, " ").slice(0, LARGO_NOMBRE);
  return limpio && !nombreOfensivo(limpio) ? limpio : "";
}

/**
 * El código de amigo de la cuenta; la primera vez se le da uno nuevo (si choca con otro, se
 * intenta con otro). También guarda el nombre con que la verán sus amigos, si lo trae
 */
export async function prepararAmigo(uid: string, nombre?: unknown): Promise<Resultado<{ codigo: string; doc: DocCuenta }>> {
  const col = await coleccion();
  if (!col) return SIN_BASE;
  const limpio = sanearNombreAmigo(nombre);
  let doc = await col.findOne({ _id: uid });
  if (!doc) return { ok: false, error: "Entra con una cuenta para tener amigos" };
  if (limpio && doc.nombre !== limpio) {
    await col.updateOne({ _id: uid }, { $set: { nombre: limpio } });
    doc = { ...doc, nombre: limpio };
  }
  for (let intento = 0; !doc.codigoAmigo && intento < 8; intento++) {
    const codigo = codigoAlAzar();
    try {
      const r = await col.updateOne({ _id: uid, codigoAmigo: { $exists: false } }, { $set: { codigoAmigo: codigo } });
      doc = (await col.findOne({ _id: uid })) ?? doc;
      if (!r.modifiedCount && !doc.codigoAmigo) continue;
    } catch (e) {
      // Ese código ya era de alguien (índice único): otro
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  if (!doc.codigoAmigo) return { ok: false, error: "No se pudo crear tu código de amigo; intenta en un rato" };
  return { ok: true, codigo: doc.codigoAmigo, doc };
}

/** El uid de quien tiene ese código (null si nadie) */
export async function uidDeCodigo(codigo: unknown): Promise<string | null> {
  const limpio = normalizarCodigoAmigo(codigo);
  const col = await coleccion();
  if (!limpio || !col) return null;
  return (await col.findOne({ codigoAmigo: limpio }, { projection: { _id: 1 } }))?._id ?? null;
}

/** Una persona como la ve el navegador: su código y su nombre */
export interface Persona {
  codigo: string;
  nombre: string;
}

/** Las cuentas de esos uids (las que ya no existen se omiten), en el mismo orden */
export async function personas(uids: string[]): Promise<(Persona & { uid: string })[]> {
  const col = await coleccion();
  if (!col || !uids.length) return [];
  const docs = await col.find({ _id: { $in: uids } }, { projection: { codigoAmigo: 1, nombre: 1 } }).toArray();
  const porId = new Map(docs.map((d) => [d._id, d]));
  return uids
    .map((uid) => porId.get(uid))
    .filter((d): d is DocCuenta => !!d?.codigoAmigo)
    .map((d) => ({ uid: d._id, codigo: d.codigoAmigo!, nombre: d.nombre || "Corredor" }));
}

/**
 * Manda una solicitud a quien tenga `codigo`. Si esa persona ya le había mandado una, quedan como
 * amigos de una vez. Devuelve el uid del otro y si ya son amigos
 */
export async function solicitar(uid: string, codigo: unknown): Promise<Resultado<{ otro: string; amigos: boolean }>> {
  const col = await coleccion();
  if (!col) return SIN_BASE;
  if (!normalizarCodigoAmigo(codigo)) return { ok: false, error: "El código de amigo son 6 números" };
  const otro = await uidDeCodigo(codigo);
  if (!otro) return { ok: false, error: "No hay nadie con ese código de amigo" };
  if (otro === uid) return { ok: false, error: "Ese es tu propio código" };
  const yo = await col.findOne({ _id: uid });
  if (!yo) return { ok: false, error: "Entra con una cuenta para tener amigos" };
  if (yo.amigos?.includes(otro)) return { ok: false, error: "Ya son amigos" };
  // Ya te la había mandado: se acepta
  if (yo.solicitudes?.includes(otro)) {
    const r = await aceptar(uid, otro);
    return r.ok ? { ok: true, otro, amigos: true } : r;
  }
  if (yo.enviadas?.includes(otro)) return { ok: false, error: "Ya le mandaste una solicitud" };
  if ((yo.amigos?.length ?? 0) >= MAX_AMIGOS) return { ok: false, error: `Ya tienes ${MAX_AMIGOS} amigos` };
  if ((yo.enviadas?.length ?? 0) >= MAX_SOLICITUDES) return { ok: false, error: "Tienes demasiadas solicitudes sin contestar" };
  const r = await col.updateOne(
    { _id: otro, [`solicitudes.${MAX_SOLICITUDES - 1}`]: { $exists: false } },
    { $addToSet: { solicitudes: uid } },
  );
  if (!r.matchedCount) return { ok: false, error: "Esa persona tiene demasiadas solicitudes; intenta después" };
  await col.updateOne({ _id: uid }, { $addToSet: { enviadas: otro } });
  return { ok: true, otro, amigos: false };
}

/** Acepta la solicitud que le mandó `otro`: quedan como amigos los dos */
export async function aceptar(uid: string, otro: string): Promise<Resultado> {
  const col = await coleccion();
  if (!col) return SIN_BASE;
  const r = await col.updateOne({ _id: uid, solicitudes: otro }, { $pull: { solicitudes: otro, enviadas: otro }, $addToSet: { amigos: otro } });
  if (!r.matchedCount) return { ok: false, error: "Esa solicitud ya no existe" };
  await col.updateOne({ _id: otro }, { $pull: { enviadas: uid, solicitudes: uid }, $addToSet: { amigos: uid } });
  return { ok: true };
}

/**
 * Deshace lo que haya con `otro`: rechaza su solicitud, cancela la suya o deja de ser su amigo
 * (de los dos lados)
 */
export async function quitar(uid: string, otro: string): Promise<Resultado> {
  const col = await coleccion();
  if (!col) return SIN_BASE;
  await col.updateOne({ _id: uid }, { $pull: { amigos: otro, solicitudes: otro, enviadas: otro } });
  await col.updateOne({ _id: otro }, { $pull: { amigos: uid, solicitudes: uid, enviadas: uid } });
  return { ok: true };
}
