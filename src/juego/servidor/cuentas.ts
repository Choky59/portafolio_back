import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { MongoClient, type Collection } from "mongodb";
import type { Cuenta } from "../compartido/protocolo";

/**
 * Las cuentas de los jugadores. Se entra con Firebase Authentication (Google, Apple o invitado):
 * el navegador manda su token en el `auth` de la conexión y aquí se verifica con las llaves
 * públicas de Google (sin llave de servicio). Lo que el juego guarda de cada cuenta (los paquetes
 * de vehículos comprados) está en MongoDB, en su propia base (edge_racers, aparte de la del
 * portafolio), colección `juego_cuentas`, con el uid de Firebase de id. Cada cuenta se registra
 * ahí en cuanto se conecta (registrarCuenta): con qué entró, cuándo se creó y su última conexión.
 *
 * Variables:
 *   JUEGO_FIREBASE_PROYECTO   el id del proyecto de Firebase de las cuentas. Sin él no hay cuentas:
 *                             todos juegan como antes, solo con el vehículo de todos
 *   JUEGO_MONGO_DB            el servidor de MongoDB (si no, MONGO_DB, el del backend)
 *   JUEGO_MONGO_DB_NAME       el nombre de la base del juego (edge_racers si no se da)
 *   JUEGO_VEHICULOS_DESBLOQUEADOS=true  todos pueden usar todos los vehículos (solo para probar)
 *   FIREBASE_AUTH_EMULATOR_HOST         con el emulador de Firebase (pruebas): sus tokens no van firmados
 */

const LLAVES = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));

export const vehiculosDesbloqueados = () => process.env.JUEGO_VEHICULOS_DESBLOQUEADOS === "true";

/** Quién es: el uid de Firebase y con qué entró ('anonymous', 'google.com', 'apple.com') */
export interface Quien {
  uid: string;
  invitado: boolean;
  proveedor: string;
}

/** Quién es, según su token, o null si no trae uno válido */
export async function verificarToken(token: unknown): Promise<Quien | null> {
  const proyecto = process.env.JUEGO_FIREBASE_PROYECTO;
  if (!proyecto || typeof token !== "string" || !token) return null;
  try {
    const datos = process.env.FIREBASE_AUTH_EMULATOR_HOST
      ? decodeJwt(token)
      : (
          await jwtVerify(token, LLAVES, {
            issuer: `https://securetoken.google.com/${proyecto}`,
            audience: proyecto,
          })
        ).payload;
    if (process.env.FIREBASE_AUTH_EMULATOR_HOST && datos.aud !== proyecto) return null;
    if (typeof datos.sub !== "string" || !datos.sub) return null;
    const proveedor = (datos.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider ?? "desconocido";
    return { uid: datos.sub, invitado: proveedor === "anonymous", proveedor };
  } catch {
    return null;
  }
}

/* --------------------------------- MongoDB --------------------------------- */

interface DocCuenta {
  _id: string;
  paquetes: string[];
  /** Con qué entró la última vez (un invitado que se conecta con Google pasa a 'google.com') */
  proveedor?: string;
  creada: Date;
  ultimaConexion?: Date;
}

let coleccion: Promise<Collection<DocCuenta> | null> | null = null;

/** La colección, conectando la primera vez (null si no hay base configurada o no se pudo) */
function cuentas(): Promise<Collection<DocCuenta> | null> {
  coleccion ??= (async () => {
    const uri = process.env.JUEGO_MONGO_DB || process.env.MONGO_DB;
    if (!uri) return null;
    try {
      const cliente = await MongoClient.connect(uri);
      return cliente.db(process.env.JUEGO_MONGO_DB_NAME || "edge_racers").collection<DocCuenta>("juego_cuentas");
    } catch (e) {
      console.error("[juego] no se pudo conectar a MongoDB para las cuentas:", (e as Error).message);
      coleccion = null; // se intenta otra vez con el siguiente jugador
      return null;
    }
  })();
  return coleccion;
}

/** Los paquetes comprados de una cuenta ([] si no tiene o no hay base) */
export async function paquetesDe(uid: string): Promise<string[]> {
  const doc = await (await cuentas())?.findOne({ _id: uid }, { projection: { paquetes: 1 } });
  return doc?.paquetes ?? [];
}

/** La cuenta completa, como la ve el cliente */
export async function cuentaDe(quien: Quien): Promise<Cuenta> {
  return { uid: quien.uid, invitado: quien.invitado, paquetes: await paquetesDe(quien.uid) };
}

/**
 * Se conectó: la cuenta queda registrada (la primera vez, sin paquetes) y se anota con qué entró y
 * cuándo. No hace nada si no hay base
 */
export async function registrarCuenta(quien: Quien): Promise<void> {
  const ahora = new Date();
  await (await cuentas())?.updateOne(
    { _id: quien.uid },
    { $set: { proveedor: quien.proveedor, ultimaConexion: ahora }, $setOnInsert: { paquetes: [], creada: ahora } },
    { upsert: true },
  );
}

/** Borra lo que el juego guarda de una cuenta (la cuenta de Firebase la borra el propio jugador) */
export async function borrarCuenta(uid: string): Promise<void> {
  await (await cuentas())?.deleteOne({ _id: uid });
}
