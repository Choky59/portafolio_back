import http from "http";
import { AddressInfo } from "net";
import { io as conectar, Socket } from "socket.io-client";
import { RTCPeerConnection as RTCPeerConnectionPolyfill } from "node-datachannel/polyfill";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RTCPeerConnection = RTCPeerConnectionPolyfill as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cualquiera = any;
import { cleanup } from "node-datachannel";
import { iniciarJuego } from "../src/juego/servidor/socket";
import { EVENTOS, Respuesta } from "../src/juego/compartido/protocolo";

/**
 * EL CANAL RÁPIDO de punta a punta: un "navegador" (el RTCPeerConnection de node-datachannel)
 * hace el mismo saludo que crash_game/src/juego/red/conexion.js y juega por el canal.
 */

let server: http.Server;
let juego: ReturnType<typeof iniciarJuego>;
let url: string;

beforeAll((listo) => {
  server = http.createServer();
  juego = iniciarJuego(server);
  server.listen(0, () => {
    url = `http://localhost:${(server.address() as AddressInfo).port}/juego`;
    listo();
  });
});

afterAll(async () => {
  juego.cerrar();
  await new Promise((listo) => server.close(listo));
  cleanup();
});

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** El saludo del navegador: pide el canal, responde la oferta y espera a que abra */
function abrirCanalComoNavegador(s: Socket) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const pendientes: { candidate: string; sdpMid: string }[] = [];
  let canal: Cualquiera = null;
  const abierto = new Promise<Cualquiera>((ok) => {
    pc.ondatachannel = (ev: Cualquiera) => {
      canal = ev.channel;
      if (canal.readyState === "open") ok(canal);
      else canal.onopen = () => ok(canal);
    };
  });
  pc.onicecandidate = (ev: Cualquiera) => {
    if (ev.candidate) s.emit(EVENTOS.rtcSenal, { candidate: ev.candidate.candidate, mid: ev.candidate.sdpMid });
  };
  s.on(EVENTOS.rtcSenal, async (senal: { sdp?: string; type?: string; candidate?: string; mid?: string }) => {
    if (senal.sdp && senal.type === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: senal.sdp });
      for (const c of pendientes) await pc.addIceCandidate(c).catch(() => {});
      const respuesta = await pc.createAnswer();
      await pc.setLocalDescription(respuesta);
      s.emit(EVENTOS.rtcSenal, { sdp: pc.localDescription!.sdp, type: pc.localDescription!.type });
    } else if (senal.candidate) {
      const c = { candidate: senal.candidate.replace(/^a=/, ""), sdpMid: senal.mid ?? "0" };
      if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
      else pendientes.push(c);
    }
  });
  return { pc, abierto };
}

test("los estados llegan por el canal (y no por el socket) y los controles por el canal llegan al servidor", async () => {
  const s = conectar(url, { transports: ["websocket"], forceNew: true });
  await new Promise<void>((ok) => s.on("connect", () => ok()));
  const { pc, abierto } = abrirCanalComoNavegador(s);
  const pedido: Respuesta = await new Promise((ok) => s.emit(EVENTOS.rtcPedir, {}, ok));
  expect(pedido.ok).toBe(true);
  const canal = await Promise.race([abierto, esperar(8000).then(() => null)]);
  expect(canal).not.toBeNull();

  const porCanal: unknown[] = [];
  canal!.onmessage = (ev: Cualquiera) => {
    const m = JSON.parse(String(ev.data));
    if (m.e === EVENTOS.estado) porCanal.push(m.d);
  };
  let porSocket = 0;
  s.on(EVENTOS.estado, () => porSocket++);

  const r = await new Promise<Respuesta>((ok) => s.emit(EVENTOS.crear, { nombre: "Ana", color: "rojo" }, ok));
  if (!r.ok) throw new Error(r.error);
  await esperar(600);
  expect(porCanal.length).toBeGreaterThan(5);
  expect(porSocket).toBe(0);

  // Controles por el canal, cada paquete con los últimos varios (redundancia)
  const ultimos: number[][] = [];
  for (let seq = 0; seq < 10; seq++) {
    ultimos.push([seq, 0, 255, 0, 0]);
    if (ultimos.length > 6) ultimos.shift();
    canal!.send(JSON.stringify({ c: ultimos }));
  }
  await esperar(300);
  const jugador = juego.gestor.buscar(r.sala.codigo)!.jugadores.get(s.id!)!;
  expect(jugador.ultimoSeq).toBe(9);

  // Se cierra el canal: los estados vuelven por el socket
  pc.close();
  await esperar(1500);
  const antes = porSocket;
  await esperar(500);
  expect(porSocket).toBeGreaterThan(antes);
  s.disconnect();
}, 20000);

test("con JUEGO_DATACHANNEL=false no hay canal y todo sigue por el socket", async () => {
  process.env.JUEGO_DATACHANNEL = "false";
  try {
    const s = conectar(url, { transports: ["websocket"], forceNew: true });
    await new Promise<void>((ok) => s.on("connect", () => ok()));
    const pedido: Respuesta = await new Promise((ok) => s.emit(EVENTOS.rtcPedir, {}, ok));
    expect(pedido.ok).toBe(false);
    s.disconnect();
  } finally {
    delete process.env.JUEGO_DATACHANNEL;
  }
});
