import { GoogleAuth } from "google-auth-library";
import { cuentas, type TokenPush } from "./cuentas";
import type { SalaDeAmigo } from "../compartido/protocolo";

/**
 * LAS NOTIFICACIONES PUSH (Firebase Cloud Messaging, API HTTP v1). Cada cuenta guarda los tokens de
 * sus teléfonos con permiso (pushTokens en juego_cuentas); el servidor les manda la invitación de un
 * amigo aunque la app esté cerrada. Sin `firebase-admin`: un POST con un token de acceso de la
 * cuenta de servicio.
 *
 * Variables:
 *   JUEGO_FCM_CUENTA_SERVICIO  el JSON de una cuenta de servicio del proyecto de Firebase con el rol
 *                              "Firebase Cloud Messaging API Admin". Sin ella no se manda nada (el
 *                              juego funciona igual: la invitación llega solo por el socket)
 *   JUEGO_FIREBASE_PROYECTO    el proyecto (el mismo de las cuentas)
 */

/** Los teléfonos que guarda cada cuenta (los más recientes) */
export const MAX_TOKENS = 5;
/** Una invitación vieja ya no sirve: Firebase la descarta si no se entregó en este tiempo */
const VIDA_INVITACION_S = 10 * 60;

let auth: GoogleAuth | null = null;
let avisadoSinConfig = false;

function clienteFcm(): GoogleAuth | null {
  if (auth) return auth;
  const json = process.env.JUEGO_FCM_CUENTA_SERVICIO;
  if (!json || !process.env.JUEGO_FIREBASE_PROYECTO) {
    if (!avisadoSinConfig) console.info("[juego] sin JUEGO_FCM_CUENTA_SERVICIO: no se mandan notificaciones push");
    avisadoSinConfig = true;
    return null;
  }
  auth = new GoogleAuth({ credentials: JSON.parse(json), scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  return auth;
}

/** Para las pruebas: otra manera de mandar (sin red) y olvidar el cliente */
type Enviar = (url: string, cuerpo: unknown) => Promise<{ status: number; error?: string }>;
let enviarPrueba: Enviar | null = null;
export function usarEnvioDePrueba(fn: Enviar | null): void {
  enviarPrueba = fn;
  auth = null;
}

async function enviar(url: string, cuerpo: unknown): Promise<{ status: number; error?: string }> {
  if (enviarPrueba) return enviarPrueba(url, cuerpo);
  const cliente = clienteFcm();
  if (!cliente) return { status: 0 };
  const acceso = await cliente.getAccessToken();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${acceso}`, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (r.ok) return { status: r.status };
  const datos = (await r.json().catch(() => null)) as { error?: { status?: string; details?: { errorCode?: string }[] } } | null;
  return { status: r.status, error: datos?.error?.details?.find((d) => d.errorCode)?.errorCode ?? datos?.error?.status };
}

/* ------------------------------ Los tokens ------------------------------ */

/** Sanea lo que manda el teléfono. Devuelve el token listo o un error */
export function sanearToken(datos: unknown): Omit<TokenPush, "en"> | { error: string } {
  const d = (datos ?? {}) as { token?: unknown; plataforma?: unknown; idioma?: unknown };
  if (typeof d.token !== "string" || d.token.length < 20 || d.token.length > 4096 || /\s/.test(d.token)) return { error: "Token inválido" };
  const plataforma = d.plataforma === "ios" || d.plataforma === "web" ? d.plataforma : "android";
  const idioma = d.idioma === "en" ? "en" : "es";
  return { token: d.token, plataforma, idioma };
}

/**
 * Guarda el teléfono en la cuenta: un teléfono es de una sola cuenta (si estaba en otra, se le
 * quita) y cada cuenta guarda los MAX_TOKENS más recientes
 */
export async function guardarToken(uid: string, datos: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = sanearToken(datos);
  if ("error" in t) return { ok: false, error: t.error };
  const col = await cuentas();
  if (!col) return { ok: false, error: "No se pudo conectar con las cuentas" };
  await col.updateMany({ _id: { $ne: uid }, "pushTokens.token": t.token }, { $pull: { pushTokens: { token: t.token } } });
  await col.updateOne({ _id: uid }, { $pull: { pushTokens: { token: t.token } } });
  await col.updateOne({ _id: uid }, { $push: { pushTokens: { $each: [{ ...t, en: new Date() }], $slice: -MAX_TOKENS } } });
  return { ok: true };
}

export async function quitarToken(uid: string, token: unknown): Promise<{ ok: true }> {
  if (typeof token !== "string") return { ok: true };
  const col = await cuentas();
  await col?.updateOne({ _id: uid }, { $pull: { pushTokens: { token } } });
  return { ok: true };
}

/* ------------------------------ Los mensajes ------------------------------ */

const TEXTOS = {
  es: { titulo: "¡Te invitan a correr!", cuerpo: (de: string, pista: string) => `${de} te invita a su sala${pista ? ` en ${pista}` : ""}` },
  en: { titulo: "You're invited to race!", cuerpo: (de: string, pista: string) => `${de} invites you to their room${pista ? ` on ${pista}` : ""}` },
};

/** El mensaje de FCM de una invitación, en el idioma del teléfono */
export function mensajeInvitacion(t: Pick<TokenPush, "token" | "idioma">, de: { codigo: string; nombre: string }, sala: SalaDeAmigo, pista: string) {
  const texto = TEXTOS[t.idioma] ?? TEXTOS.es;
  return {
    message: {
      token: t.token,
      notification: { title: texto.titulo, body: texto.cuerpo(de.nombre, pista) },
      // Lo que lee la app al tocarla: abre el aviso "¡Te invitan!" (los valores de `data` son texto)
      data: { tipo: "invitacion", de: JSON.stringify(de), sala: JSON.stringify(sala) },
      android: { priority: "HIGH", ttl: `${VIDA_INVITACION_S}s`, notification: { channel_id: "amigos-invitaciones", sound: "default" } },
      apns: { headers: { "apns-expiration": String(Math.floor(Date.now() / 1000) + VIDA_INVITACION_S) }, payload: { aps: { sound: "default" } } },
    },
  };
}

/** Cómo le fue a un envío a todos los teléfonos de una cuenta */
export interface ResultadoEnvio {
  /** Teléfonos guardados en la cuenta */
  telefonos: number;
  enviados: number;
  /** Lo que salió mal (para el diagnóstico de "Enviarme una prueba") */
  errores: string[];
}

/**
 * Manda a todos los teléfonos de una cuenta el mensaje que arma `armar` para cada uno. Los tokens
 * que Firebase ya no reconoce se borran
 */
async function mandarATelefonos(uid: string, armar: (t: TokenPush) => unknown): Promise<ResultadoEnvio> {
  const proyecto = process.env.JUEGO_FIREBASE_PROYECTO;
  const col = await cuentas();
  const tokens = (await col?.findOne({ _id: uid }, { projection: { pushTokens: 1 } }))?.pushTokens ?? [];
  const resultado: ResultadoEnvio = { telefonos: tokens.length, enviados: 0, errores: [] };
  if (!proyecto) return { ...resultado, errores: ["El servidor no tiene JUEGO_FIREBASE_PROYECTO"] };
  try {
    if (!enviarPrueba && !clienteFcm()) return { ...resultado, errores: ["El servidor no tiene JUEGO_FCM_CUENTA_SERVICIO"] };
  } catch (e) {
    auth = null;
    return { ...resultado, errores: [`La llave JUEGO_FCM_CUENTA_SERVICIO no se pudo leer: ${(e as Error).message}`] };
  }
  const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(proyecto)}/messages:send`;
  await Promise.all(
    tokens.map(async (t) => {
      try {
        const r = await enviar(url, armar(t));
        if (r.status >= 200 && r.status < 300) resultado.enviados++;
        else {
          resultado.errores.push(`Firebase ${r.status} ${r.error ?? ""}`.trim());
          if (r.status === 404 || r.error === "UNREGISTERED") await quitarToken(uid, t.token);
          else console.error("[juego] push no entregada:", r.status, r.error ?? "");
        }
      } catch (e) {
        resultado.errores.push((e as Error).message);
        console.error("[juego] push no entregada:", (e as Error).message);
      }
    }),
  );
  return resultado;
}

/**
 * Le manda la invitación a todos los teléfonos de un amigo (aunque tenga la app cerrada).
 * Devuelve a cuántos teléfonos se mandó
 */
export async function mandarInvitacion(uidAmigo: string, de: { codigo: string; nombre: string }, sala: SalaDeAmigo, pista = ""): Promise<number> {
  if (!process.env.JUEGO_FIREBASE_PROYECTO || (!enviarPrueba && !clienteFcm())) return 0;
  return (await mandarATelefonos(uidAmigo, (t) => mensajeInvitacion(t, de, sala, pista))).enviados;
}

const JUGANDO = {
  es: { titulo: (de: string) => `¡${de} está jugando!`, cuerpo: (pista: string) => `Está en una sala${pista ? ` de ${pista}` : ""}: toca para unirte` },
  en: { titulo: (de: string) => `${de} is playing!`, cuerpo: (pista: string) => `They're in a room${pista ? ` on ${pista}` : ""}: tap to join` },
};

/**
 * "Avísame cuando mis amigos jueguen": un amigo entró a una sala. Al tocarla se entra a esa sala
 * (los mismos datos que una invitación). Devuelve a cuántos teléfonos se mandó
 */
export async function mandarAmigoJugando(uid: string, de: { codigo: string; nombre: string }, sala: SalaDeAmigo, pista = ""): Promise<number> {
  if (!process.env.JUEGO_FIREBASE_PROYECTO || (!enviarPrueba && !clienteFcm())) return 0;
  const r = await mandarATelefonos(uid, (t) => {
    const texto = JUGANDO[t.idioma] ?? JUGANDO.es;
    return {
      message: {
        token: t.token,
        notification: { title: texto.titulo(de.nombre), body: texto.cuerpo(pista) },
        data: { tipo: "invitacion", de: JSON.stringify(de), sala: JSON.stringify(sala) },
        android: { priority: "HIGH", ttl: `${VIDA_INVITACION_S}s`, notification: { channel_id: "amigos-invitaciones" } },
        apns: { headers: { "apns-expiration": String(Math.floor(Date.now() / 1000) + VIDA_INVITACION_S) }, payload: { aps: { sound: "default" } } },
      },
    };
  });
  return r.enviados;
}

const PRUEBA = {
  es: { titulo: "Notificaciones de Edge Racers", cuerpo: "¡Funcionan! Así te avisaremos cuando un amigo te invite." },
  en: { titulo: "Edge Racers notifications", cuerpo: "They work! This is how we'll let you know when a friend invites you." },
};

/** "Enviarme una prueba" (Configuración → Notificaciones): una notificación a tus propios teléfonos */
export async function mandarPrueba(uid: string): Promise<ResultadoEnvio> {
  return mandarATelefonos(uid, (t) => {
    const texto = PRUEBA[t.idioma] ?? PRUEBA.es;
    return {
      message: {
        token: t.token,
        notification: { title: texto.titulo, body: texto.cuerpo },
        data: { tipo: "prueba" },
        android: { priority: "HIGH", notification: { channel_id: "amigos-invitaciones" } },
        apns: { payload: { aps: { sound: "default" } } },
      },
    };
  });
}
