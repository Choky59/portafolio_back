import { PeerConnection, type DataChannel, type IceServer } from "node-datachannel";

/**
 * EL CANAL RÁPIDO: un WebRTC DataChannel sin orden ni reintentos (UDP, en el fondo) por jugador,
 * solo para lo de tiempo real: los estados del servidor y los controles.
 *
 * Por qué: Socket.IO va sobre TCP, y en Wi-Fi un paquete perdido DETIENE todo lo que viene
 * detrás hasta retransmitirlo (head-of-line blocking): cortes de 0.3 a 1 s y luego todo de golpe
 * (lo que mostró el iPhone en la página de admin). Aquí un paquete perdido se pierde solo: el
 * siguiente estado llega a tiempo, y los controles van con redundancia (los últimos varios).
 *
 * Socket.IO sigue para todo lo demás y de respaldo: si el canal no abre (una red que bloquea UDP)
 * o se cierra, se juega por Socket.IO como antes. La señalización va por Socket.IO.
 *
 * Variables (todas opcionales):
 *   JUEGO_DATACHANNEL=false   apagarlo (encendido por defecto)
 *   JUEGO_RTC_PUERTO=10000    un solo puerto UDP para todos (ICE UDP mux), el que se abre en el
 *                             firewall y se publica en Docker; sin él, puertos al azar (local)
 *   JUEGO_RTC_IP=1.2.3.4      la IP pública del servidor: se anuncia como candidato (en Docker el
 *                             servidor solo ve la IP del contenedor)
 *   JUEGO_RTC_STUN=stun:…     el servidor STUN (por defecto el de Google)
 *   JUEGO_TURN_KEY_ID=…       la llave TURN de Cloudflare Realtime (su ID y su token de API):
 *   JUEGO_TURN_TOKEN=…        ver serviciosIce. Secretos: se quedan en el servidor
 *
 * EL RELEVO (TURN). Un servidor detrás de NAT sin puertos abiertos (el de casa, por el túnel de
 * Cloudflare, que solo pasa TCP) no recibe UDP directo de nadie. Con TURN, el servidor y el
 * navegador se conectan HACIA AFUERA a un relevo de Cloudflare y el UDP pasa por ahí: sin abrir
 * puertos ni revelar la IP. Las credenciales son temporales (las pide serviciosIce con la llave)
 * y van al navegador junto con la oferta.
 */

export const canalEncendido = () => process.env.JUEGO_DATACHANNEL !== "false";

export interface SenalRtc {
  sdp?: string;
  type?: string;
  /** Solo en la oferta del servidor: los servidores ICE para el navegador */
  iceServers?: IceNavegador[];
  candidate?: string;
  mid?: string;
}

export interface CanalRapido {
  /** La señal que manda el navegador (su respuesta y sus candidatos) */
  senal(s: SenalRtc): void;
  enviar(texto: string): boolean;
  abierto(): boolean;
  /** Bytes que esperan salir (si crece, el servidor manda más de lo que la red de esa persona se lleva) */
  buffer(): number;
  cerrar(): void;
}

interface Avisos {
  /** Señal para el navegador (la oferta y los candidatos del servidor) */
  alSenal(s: SenalRtc): void;
  alAbrir(): void;
  alCerrar(): void;
  alMensaje(texto: string): void;
}

const TIPOS = new Set(["offer", "answer", "pranswer", "rollback"]);

/** Un servidor ICE como lo recibe RTCPeerConnection en el navegador */
export interface IceNavegador {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Cuánto duran las credenciales del relevo (s); a la mitad se piden otras */
const TTL_TURN_S = 12 * 3600;
/** Si Cloudflare no contestó, cuándo se vuelve a intentar (ms); mientras, solo STUN */
const REINTENTO_TURN_MS = 60_000;
const ESPERA_TURN_MS = 3000;
let iceCache: { servidores: IceNavegador[]; vence: number } | null = null;
let iceEnCamino: Promise<IceNavegador[]> | null = null;

/** Sin relevo: solo el STUN (el de siempre) */
const soloStun = (): IceNavegador[] => [{ urls: process.env.JUEGO_RTC_STUN || "stun:stun.l.google.com:19302" }];

/** Para las pruebas: olvidar las credenciales guardadas */
export function olvidarIce(): void {
  iceCache = null;
  iceEnCamino = null;
}

/**
 * Los servidores ICE para un canal: con JUEGO_TURN_KEY_ID y JUEGO_TURN_TOKEN, los de Cloudflare
 * (STUN + TURN con credenciales temporales, POST …/credentials/generate-ice-servers), guardados
 * hasta la mitad de su vida; sin ellos o si falla, solo STUN. Nunca truena
 */
export async function serviciosIce(): Promise<IceNavegador[]> {
  const llave = process.env.JUEGO_TURN_KEY_ID?.trim();
  const token = process.env.JUEGO_TURN_TOKEN?.trim();
  if (!llave || !token) return soloStun();
  if (iceCache && Date.now() < iceCache.vence) return iceCache.servidores;
  iceEnCamino ??= (async () => {
    try {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(llave)}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: TTL_TURN_S }),
        signal: AbortSignal.timeout(ESPERA_TURN_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const datos = (await r.json()) as { iceServers?: unknown };
      const servidores = limpiarIce(datos.iceServers);
      if (!servidores.some((s) => urlsDe(s).some((u) => u.startsWith("turn")))) throw new Error("sin TURN en la respuesta");
      iceCache = { servidores, vence: Date.now() + (TTL_TURN_S * 1000) / 2 };
      console.info("[juego] credenciales TURN listas");
      return servidores;
    } catch (e) {
      console.error("[juego] no se pudieron pedir las credenciales TURN:", (e as Error).message);
      iceCache = { servidores: soloStun(), vence: Date.now() + REINTENTO_TURN_MS };
      return iceCache.servidores;
    } finally {
      iceEnCamino = null;
    }
  })();
  return iceEnCamino;
}

const urlsDe = (s: { urls?: unknown }): string[] =>
  (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u): u is string => typeof u === "string");

/** Lo que manda Cloudflare, revisado; sin el puerto 53 (los navegadores lo bloquean y se espera en balde) */
export function limpiarIce(lista: unknown): IceNavegador[] {
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      urls: urlsDe(s).filter((u) => /^(stun|turns?):/.test(u) && !/:53(\?|$)/.test(u)),
      ...(typeof s.username === "string" ? { username: s.username } : {}),
      ...(typeof s.credential === "string" ? { credential: s.credential } : {}),
    }))
    .filter((s) => s.urls.length);
}

/**
 * Los mismos servidores para node-datachannel (libjuice: el relevo solo por UDP): el STUN como
 * texto y cada TURN por UDP como objeto con sus credenciales
 */
export function iceParaServidor(lista: IceNavegador[]): (string | IceServer)[] {
  const salida: (string | IceServer)[] = [];
  for (const s of lista) {
    for (const u of urlsDe(s)) {
      const m = /^(stun|turn):([^:?]+):(\d+)(?:\?transport=(\w+))?$/.exec(u);
      if (!m) continue;
      const [, tipo, hostname, puerto, transporte] = m;
      if (tipo === "stun") salida.push(u);
      else if ((transporte ?? "udp") === "udp" && s.username && s.credential) {
        salida.push({ hostname, port: Number(puerto), username: s.username, password: s.credential, relayType: "TurnUdp" });
      }
    }
  }
  return salida.length ? salida : [process.env.JUEGO_RTC_STUN || "stun:stun.l.google.com:19302"];
}

/** `ice`: de serviciosIce (sin él, solo STUN). El navegador recibe los mismos con la oferta */
export function abrirCanal(id: string, avisos: Avisos, ice: IceNavegador[] = soloStun()): CanalRapido {
  const puerto = Number(process.env.JUEGO_RTC_PUERTO) || 0;
  const ipPublica = process.env.JUEGO_RTC_IP?.trim();
  const pc = new PeerConnection(id, {
    iceServers: iceParaServidor(ice),
    ...(puerto ? { portRangeBegin: puerto, portRangeEnd: puerto, enableIceUdpMux: true } : {}),
  });
  let cerrado = false;
  let avisoCerrar = false;
  const cerrarUnaVez = () => {
    if (avisoCerrar) return;
    avisoCerrar = true;
    avisos.alCerrar();
  };

  pc.onLocalDescription((sdp, type) => {
    // Con la oferta van los servidores ICE (con las credenciales temporales del relevo)
    avisos.alSenal({ sdp, type, ...(type === "offer" ? { iceServers: ice } : {}) });
    // Detrás de Docker/NAT: también el candidato con la IP pública y el puerto publicado
    if (ipPublica && puerto) {
      const mid = /a=mid:(\S+)/.exec(sdp)?.[1] ?? "0";
      avisos.alSenal({ candidate: `candidate:9 1 UDP 2122260223 ${ipPublica} ${puerto} typ host`, mid });
    }
  });
  pc.onLocalCandidate((candidate, mid) => avisos.alSenal({ candidate, mid }));
  pc.onStateChange((estado) => {
    if (estado === "failed" || estado === "closed" || estado === "disconnected") cerrarUnaVez();
  });

  // Sin orden ni reintentos: lo viejo no sirve, lo perdido no detiene lo nuevo
  const dc: DataChannel = pc.createDataChannel("juego", { unordered: true, maxRetransmits: 0 });
  dc.onOpen(() => {
    // Por dónde se conectó (relay: por el relevo TURN; host/srflx/prflx: directo), para el log
    try {
      const par = pc.getSelectedCandidatePair();
      console.info(`[juego] canal rápido abierto: ${par?.local.type ?? "?"} -> ${par?.remote.type ?? "?"}`);
    } catch {}
    avisos.alAbrir();
  });
  dc.onClosed(cerrarUnaVez);
  dc.onError(cerrarUnaVez);
  dc.onMessage((m) => {
    if (typeof m === "string") avisos.alMensaje(m);
    else avisos.alMensaje(Buffer.from(m as ArrayBuffer).toString("utf8"));
  });

  return {
    senal(s) {
      if (cerrado) return;
      try {
        if (typeof s?.sdp === "string" && typeof s.type === "string" && TIPOS.has(s.type)) {
          pc.setRemoteDescription(s.sdp, s.type as "answer");
        } else if (typeof s?.candidate === "string" && s.candidate) {
          pc.addRemoteCandidate(s.candidate, typeof s.mid === "string" ? s.mid : "0");
        }
      } catch {
        // Una señal mala no tumba nada: sin canal, se sigue por Socket.IO
      }
    },
    enviar(texto) {
      if (cerrado || !dc.isOpen()) return false;
      try {
        return dc.sendMessage(texto);
      } catch {
        return false;
      }
    },
    abierto: () => !cerrado && dc.isOpen(),
    buffer: () => {
      try {
        return cerrado ? 0 : dc.bufferedAmount();
      } catch {
        return 0;
      }
    },
    cerrar() {
      if (cerrado) return;
      cerrado = true;
      try {
        dc.close();
      } catch {}
      try {
        pc.close();
      } catch {}
      cerrarUnaVez();
    },
  };
}
