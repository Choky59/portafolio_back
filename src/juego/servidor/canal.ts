import { PeerConnection, type DataChannel } from "node-datachannel";

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
 */

export const canalEncendido = () => process.env.JUEGO_DATACHANNEL !== "false";

export interface SenalRtc {
  sdp?: string;
  type?: string;
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

export function abrirCanal(id: string, avisos: Avisos): CanalRapido {
  const puerto = Number(process.env.JUEGO_RTC_PUERTO) || 0;
  const ipPublica = process.env.JUEGO_RTC_IP?.trim();
  const pc = new PeerConnection(id, {
    iceServers: [process.env.JUEGO_RTC_STUN || "stun:stun.l.google.com:19302"],
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
    avisos.alSenal({ sdp, type });
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
  dc.onOpen(() => avisos.alAbrir());
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
