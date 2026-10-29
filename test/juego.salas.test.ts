import { readFileSync } from "fs";
import http from "http";
import { AddressInfo } from "net";
import path from "path";
import { io as conectar, Socket } from "socket.io-client";
import { iniciarJuego } from "../src/juego/servidor/socket";
import { Sala } from "../src/juego/servidor/salas";
import { Circuito } from "../src/juego/compartido/tipos";
import { prepararPista } from "../src/juego/compartido/pista";
import { PARAMETROS_FISICA, avanzarCarro, copiarCarro } from "../src/juego/compartido/fisica";
import {
  ControlesRed,
  EVENTOS,
  Instantanea,
  Respuesta,
  desempacarCarro,
  normalizarCodigo,
  sanearControles,
} from "../src/juego/compartido/protocolo";

let server: http.Server;
let juego: ReturnType<typeof iniciarJuego>;
let url: string;
const abiertos: Socket[] = [];

beforeAll((listo) => {
  server = http.createServer();
  juego = iniciarJuego(server);
  server.listen(0, () => {
    url = `http://localhost:${(server.address() as AddressInfo).port}/juego`;
    listo();
  });
});

afterEach(() => {
  abiertos.splice(0).forEach((s) => s.disconnect());
});

afterAll((listo) => {
  juego.cerrar();
  server.close(() => listo());
});

function cliente(): Promise<Socket> {
  const s = conectar(url, { transports: ["websocket"], forceNew: true });
  abiertos.push(s);
  return new Promise((ok) => s.on("connect", () => ok(s)));
}

function pedir(s: Socket, evento: string, datos: unknown): Promise<Respuesta> {
  return new Promise((ok) => s.emit(evento, datos, ok));
}

function siguiente<T>(s: Socket, evento: string, cumple: (x: T) => boolean = () => true): Promise<T> {
  return new Promise((ok) => {
    const f = (x: T) => {
      if (!cumple(x)) return;
      s.off(evento, f);
      ok(x);
    };
    s.on(evento, f);
  });
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function crearSala(nombre = "Ana", color = "rojo") {
  const s = await cliente();
  const r = await pedir(s, EVENTOS.crear, { nombre, color });
  if (!r.ok) throw new Error(r.error);
  return { s, r };
}

describe("protocolo", () => {
  it("normalizes room codes", () => {
    expect(normalizarCodigo("hmo 4821")).toBe("HMO-4821");
    expect(normalizarCodigo("4821")).toBe("HMO-4821");
    expect(normalizarCodigo("HMO-48")).toBeNull();
    expect(normalizarCodigo(4821)).toBeNull();
  });

  it("clamps controls coming from the browser", () => {
    expect(sanearControles({ seq: 3, giro: 9, acel: 5, freno: -2, mano: "si" })).toEqual({
      seq: 3,
      giro: 1,
      acel: 1,
      freno: 0,
      mano: false,
      item: false,
    });
    expect(sanearControles({ seq: -1 })).toBeNull();
    expect(sanearControles("hola")).toBeNull();
  });
});

describe("salas", () => {
  it("creates a room with a short code and the creator as host", async () => {
    const { s, r } = await crearSala();
    if (!r.ok) throw new Error();
    expect(r.sala.codigo).toMatch(/^HMO-\d{4}$/);
    expect(r.sala.anfitrion).toBe(s.id);
    expect(r.sala.jugadores).toEqual([{ id: s.id, nombre: "Ana", color: "rojo" }]);
  });

  it("requires a name", async () => {
    const s = await cliente();
    const r = await pedir(s, EVENTOS.crear, { nombre: "   ", color: "rojo" });
    expect(r).toEqual({ ok: false, error: "Escribe tu nombre" });
    expect(juego.gestor.total).toBe(0);
  });

  it("lets others join by code and tells everyone", async () => {
    const { s: ana, r } = await crearSala();
    if (!r.ok) throw new Error();
    const aviso = siguiente<{ jugadores: unknown[] }>(ana, EVENTOS.sala, (e) => e.jugadores.length === 2);
    const beto = await cliente();
    const r2 = await pedir(beto, EVENTOS.unirse, { codigo: r.sala.codigo.toLowerCase(), nombre: "Beto", color: "rojo" });
    if (!r2.ok) throw new Error(r2.error);
    // Red was taken: Beto gets the first free color
    expect(r2.sala.jugadores[1]).toEqual({ id: beto.id, nombre: "Beto", color: "azul" });
    expect((await aviso).jugadores).toHaveLength(2);
  });

  it("rejects unknown codes and a fifth player", async () => {
    const { r } = await crearSala();
    if (!r.ok) throw new Error();
    const otro = await cliente();
    expect(await pedir(otro, EVENTOS.unirse, { codigo: "HMO-0000", nombre: "X" })).toMatchObject({ ok: false });

    for (const nombre of ["B", "C", "D"]) {
      const s = await cliente();
      expect(await pedir(s, EVENTOS.unirse, { codigo: r.sala.codigo, nombre })).toMatchObject({ ok: true });
    }
    const quinto = await cliente();
    expect(await pedir(quinto, EVENTOS.unirse, { codigo: r.sala.codigo, nombre: "E" })).toEqual({
      ok: false,
      error: "La sala ya tiene 4 jugadores",
    });
  });

  it("lists the open rooms for the lobby, without the full ones", async () => {
    const { r: abierta } = await crearSala("Ana");
    const { s: llenaHost, r: llena } = await crearSala("Beto");
    if (!abierta.ok || !llena.ok) throw new Error();
    // Fill Beto's room with bots
    await new Promise((ok) => llenaHost.emit(EVENTOS.bots, { cantidad: 3 }, ok));

    const visitante = await cliente();
    const lista: { codigo: string; anfitrion: string; jugadores: number; bots: number; fase: string }[] =
      await visitante.timeout(2000).emitWithAck(EVENTOS.salas);
    expect(lista).toContainEqual({ codigo: abierta.sala.codigo, anfitrion: "Ana", jugadores: 1, bots: 0, fase: "espera" });
    expect(lista.map((s) => s.codigo)).not.toContain(llena.sala.codigo);
  });

  it("removes a player who disconnects and deletes the empty room", async () => {
    const { s: ana, r } = await crearSala();
    if (!r.ok) throw new Error();
    const beto = await cliente();
    await pedir(beto, EVENTOS.unirse, { codigo: r.sala.codigo, nombre: "Beto" });

    const aviso = siguiente<{ jugadores: unknown[] }>(ana, EVENTOS.sala, (e) => e.jugadores.length === 1);
    beto.disconnect();
    expect((await aviso).jugadores).toHaveLength(1);

    ana.disconnect();
    await esperar(100);
    expect(juego.gestor.buscar(r.sala.codigo)).toBeUndefined();
  });
});

describe("simulación", () => {
  it("streams every car's state and moves only with the player's controls", async () => {
    const { s, r } = await crearSala();
    if (!r.ok) throw new Error();
    const antes = desempacarCarro((await siguiente<Instantanea>(s, EVENTOS.estado)).c[0]);

    for (let seq = 0; seq < 20; seq++) {
      s.emit(EVENTOS.controles, { seq, giro: 0, acel: 1, freno: 0, mano: false });
      await esperar(1000 / 30);
    }
    const despues = desempacarCarro(
      (await siguiente<Instantanea>(s, EVENTOS.estado, (i) => i.c[0][10] === 19)).c[0],
    );
    expect(despues.id).toBe(s.id);
    expect(despues.seq).toBe(19);
    expect(Math.hypot(despues.estado.x - antes.estado.x, despues.estado.y - antes.estado.y)).toBeGreaterThan(3);
  });

  it("keeps real time: about 30 ticks per second even with imprecise timers", async () => {
    const { r } = await crearSala();
    if (!r.ok) throw new Error();
    const sala = juego.gestor.buscar(r.sala.codigo)!;
    const t0 = performance.now();
    const tick0 = sala.tick;
    await esperar(1000);
    const esperados = ((performance.now() - t0) / 1000) * 30;
    expect(Math.abs(sala.tick - tick0 - esperados)).toBeLessThanOrEqual(2);
  });

  it("answers pings", async () => {
    const s = await cliente();
    await expect(s.timeout(1000).emitWithAck(EVENTOS.ping)).resolves.toBeUndefined();
  });
});

describe("Sala: controls applied on arrival", () => {
  const circuito: Circuito = JSON.parse(
    readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", "prueba.json"), "utf8"),
  );
  const HZ = 30;
  const controles = (n: number, desde = 0): ControlesRed[] =>
    Array.from({ length: n }, (_, i) => ({
      seq: desde + i,
      giro: Math.sin((desde + i) / 7),
      acel: 1,
      freno: 0,
      mano: (desde + i) % 40 > 30,
      item: false,
    }));

  function nuevaSala() {
    const sala = new Sala("HMO-1234", circuito, HZ);
    sala.agregar("a", { nombre: "Ana", color: "rojo" });
    return { sala, jugador: sala.jugadores.get("a")! };
  }

  it("ends in exactly the state the browser predicts (no rubber-banding)", () => {
    const { sala, jugador } = nuevaSala();
    // What the browser predicts: the same controls, one physics step each
    const predicho = copiarCarro(jugador.carro);
    const pista = prepararPista(circuito);
    const lista = controles(90);
    for (const c of lista) avanzarCarro(predicho, c, PARAMETROS_FISICA, pista, 1 / HZ);

    // The server gets them in uneven bursts while its own ticks run
    let i = 0;
    for (const rafaga of [1, 3, 0, 2, 1, 4, 0, 0, 1]) {
      for (let k = 0; k < rafaga && i < lista.length; k++) sala.recibirControles("a", lista[i++]);
      sala.paso();
    }
    while (i < lista.length) {
      sala.recibirControles("a", lista[i++]);
      sala.paso();
    }
    for (let t = 0; t < 10; t++) sala.paso();

    expect(jugador.ultimoSeq).toBe(89);
    expect(jugador.carro).toEqual(predicho);
  });

  it("doesn't lose a short burst of controls", () => {
    const { sala, jugador } = nuevaSala();
    controles(6).forEach((c) => sala.recibirControles("a", c));
    for (let t = 0; t < 6; t++) sala.paso();
    expect(jugador.ultimoSeq).toBe(5);
  });

  it("won't go faster than about one control per tick, however many arrive", () => {
    const { sala, jugador } = nuevaSala();
    controles(200).forEach((c) => sala.recibirControles("a", c));
    for (let t = 0; t < 10; t++) sala.paso();
    // Seq 0 and 1 go through right away with the starting credit; of the rest only the last
    // 10 stay queued (190 … 199) and they're applied one credit (1.05 per tick) at a time
    const aplicados = 2 + (jugador.ultimoSeq - 190 + 1);
    expect(aplicados).toBeLessThanOrEqual(2 + 1.05 * 10);
    expect(jugador.cola.length + jugador.ultimoSeq - 189).toBe(10);
  });

  it("can't drive through another car, even when controls arrive in a burst", () => {
    const sala = new Sala("HMO-1234", circuito, HZ);
    sala.agregar("a", { nombre: "Ana", color: "rojo" });
    sala.agregar("b", { nombre: "Beto", color: "azul" });
    const a = sala.jugadores.get("a")!;
    const b = sala.jugadores.get("b")!;
    // B parked sideways across A's way, 8 m ahead; A arrives fast
    Object.assign(a.carro, { x: 4, y: 0, angulo: 0, vx: 45, vy: 0, w: 0 });
    Object.assign(b.carro, { x: 12, y: 0, angulo: Math.PI / 2, vx: 0, vy: 0, w: 0 });
    a.creditos = 6;
    // Six controls in one go (network jitter): ~9 m of travel before the room's next tick
    for (let seq = 0; seq < 6; seq++) sala.recibirControles("a", { seq, giro: 0, acel: 1, freno: 0, mano: false, item: false });
    sala.paso();
    expect(a.carro.x).toBeLessThan(b.carro.x); // still behind B, not through it
    expect(b.carro.vx).toBeGreaterThan(5); // and B got shoved
  });

  it("doesn't simulate a player who sends nothing", () => {
    const { sala, jugador } = nuevaSala();
    sala.recibirControles("a", controles(1)[0]);
    const antes = copiarCarro(jugador.carro);
    for (let t = 0; t < 30; t++) sala.paso();
    expect(jugador.carro).toEqual(antes);
  });
});
