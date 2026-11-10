import { readFileSync } from "fs";
import http from "http";
import { AddressInfo } from "net";
import path from "path";
import { io as conectar, Socket } from "socket.io-client";
import { iniciarJuego } from "../src/juego/servidor/socket";
import { GestorSalas, Sala } from "../src/juego/servidor/salas";
import { rng } from "./juego.utiles";
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

  it("tells everyone each player's vehicle (an unknown one becomes the default)", async () => {
    // Without accounts nobody owns a paid vehicle: unlocked for this test (see juego.cuentas.test)
    process.env.JUEGO_VEHICULOS_DESBLOQUEADOS = "true";
    const { r } = await crearSala();
    if (!r.ok) throw new Error();
    const beto = await cliente();
    const r2 = await pedir(beto, EVENTOS.unirse, { codigo: r.sala.codigo, nombre: "Beto", color: "azul", vehiculo: "grua" });
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.sala.jugadores[1]).toMatchObject({ nombre: "Beto", vehiculo: "grua" });
    const caro = await cliente();
    const r3 = await pedir(caro, EVENTOS.unirse, { codigo: r.sala.codigo, nombre: "Caro", color: "verde", vehiculo: "nave" });
    if (!r3.ok) throw new Error(r3.error);
    expect(r3.sala.jugadores[2]).not.toHaveProperty("vehiculo");
    delete process.env.JUEGO_VEHICULOS_DESBLOQUEADOS;
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

  it("creates the room on the chosen map; unknown or hidden maps fall back to the default", async () => {
    const elegir = async (circuito: unknown) => {
      const s = await cliente();
      const r = await pedir(s, EVENTOS.crear, { nombre: "Ana", circuito });
      if (!r.ok) throw new Error(r.error);
      return r.sala.circuito;
    };
    expect(await elegir("san-carlos")).toBe("san-carlos");
    expect(await elegir("no-existe")).toBe("hermosillo");
    expect(await elegir("prueba")).toBe("hermosillo"); // the lab circuit is hidden
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
    expect(lista).toContainEqual({ codigo: abierta.sala.codigo, circuito: "hermosillo", anfitrion: "Ana", jugadores: 1, bots: 0, fase: "espera" });
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

describe("listos y ajustes entre partidas", () => {
  it("tells everyone who is ready; the match waits for the host", async () => {
    const { s: ana, r } = await crearSala("Ana", "rojo");
    if (!r.ok) throw new Error();
    const beto = await cliente();
    await pedir(beto, EVENTOS.unirse, { nombre: "Beto", color: "azul", codigo: r.sala.codigo });
    const visto = siguiente<{ jugadores: { nombre: string; listo?: boolean }[] }>(ana, EVENTOS.sala, (e) =>
      e.jugadores.some((j) => j.nombre === "Beto" && j.listo),
    );
    expect(await pedir(beto, EVENTOS.listo, { listo: true })).toEqual({ ok: true });
    await visto;
    const cuenta = siguiente<{ fase: string }>(beto, EVENTOS.partida, (p) => p.fase === "cuenta");
    expect(await pedir(ana, EVENTOS.empezar, {})).toEqual({ ok: true });
    await cuenta;
  });

  it("the host kicks a player (who is told and is out) or a bot", async () => {
    const { s: ana, r } = await crearSala("Ana", "rojo");
    if (!r.ok) throw new Error();
    const beto = await cliente();
    const r2 = await pedir(beto, EVENTOS.unirse, { nombre: "Beto", color: "azul", codigo: r.sala.codigo });
    if (!r2.ok) throw new Error();
    expect(await pedir(beto, EVENTOS.expulsar, { id: ana.id })).toMatchObject({ ok: false });
    const fuera = siguiente(beto, EVENTOS.expulsado);
    const sinBeto = siguiente<{ jugadores: unknown[] }>(ana, EVENTOS.sala, (e) => e.jugadores.length === 1);
    expect(await pedir(ana, EVENTOS.expulsar, { id: r2.id })).toEqual({ ok: true });
    await fuera;
    await sinBeto;

    await pedir(ana, EVENTOS.bots, { cantidad: 2 });
    const conUno = siguiente<{ jugadores: { bot?: boolean }[] }>(ana, EVENTOS.sala, (e) => e.jugadores.filter((j) => j.bot).length === 1);
    expect(await pedir(ana, EVENTOS.bots, { cantidad: 1 })).toEqual({ ok: true });
    const sala = await conUno;
    const bot = (sala.jugadores as { id: string; bot?: boolean }[]).find((j) => j.bot)!;
    const sinBots = siguiente<{ jugadores: unknown[] }>(ana, EVENTOS.sala, (e) => e.jugadores.length === 1);
    expect(await pedir(ana, EVENTOS.expulsar, { id: bot.id })).toEqual({ ok: true });
    await sinBots;
  });

  it("changes your color and, for the host, the map", async () => {
    const { s: ana, r } = await crearSala("Ana", "rojo");
    if (!r.ok) throw new Error();
    const beto = await cliente();
    await pedir(beto, EVENTOS.unirse, { nombre: "Beto", color: "azul", codigo: r.sala.codigo });
    expect(await pedir(beto, EVENTOS.ajustes, { color: "rojo" })).toEqual({ ok: false, error: "Ese color ya lo trae Ana" });
    expect(await pedir(beto, EVENTOS.ajustes, { circuito: "san-carlos" })).toMatchObject({ ok: false });
    const nuevo = siguiente<{ circuito: string }>(beto, EVENTOS.sala, (e) => e.circuito === "san-carlos");
    expect(await pedir(ana, EVENTOS.ajustes, { circuito: "san-carlos", color: "verde" })).toEqual({ ok: true });
    await nuevo;
    expect(await pedir(ana, EVENTOS.ajustes, { circuito: "prueba" })).toEqual({ ok: false, error: "Ese mapa no existe" });
    const tres = siguiente<{ meta: number }>(beto, EVENTOS.partida, (p) => p.meta === 3);
    expect(await pedir(ana, EVENTOS.ajustes, { meta: 3 })).toEqual({ ok: true });
    await tres;
    expect(await pedir(beto, EVENTOS.ajustes, { meta: 7 })).toMatchObject({ ok: false });
  });
});

describe("reportes", () => {
  it("logs a report of another player once, without connection data", async () => {
    const { s: ana, r } = await crearSala("Ana", "rojo");
    if (!r.ok) throw new Error();
    const beto = await cliente();
    const r2 = await pedir(beto, EVENTOS.unirse, { nombre: "Beto", color: "azul", codigo: r.sala.codigo });
    if (!r2.ok) throw new Error();
    const avisos = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await pedir(beto, EVENTOS.reportar, { id: ana.id, motivo: "nombre" })).toEqual({ ok: true });
    expect(await pedir(beto, EVENTOS.reportar, { id: ana.id, motivo: "nombre" })).toEqual({ ok: true });
    expect(await pedir(beto, EVENTOS.reportar, { id: r2.id })).toMatchObject({ ok: false });
    const reportes = avisos.mock.calls.filter((c) => String(c[0]).includes("[juego] reporte"));
    avisos.mockRestore();
    expect(reportes).toHaveLength(1);
    expect(String(reportes[0][0])).toContain('"nombre":"Ana"');
    expect(String(reportes[0][0])).not.toContain(String(ana.id));
  });

  it("refuses an offensive name when creating a room", async () => {
    const s = await cliente();
    expect(await pedir(s, EVENTOS.crear, { nombre: "p3nd3jo", color: "rojo" })).toEqual({ ok: false, error: "Ese nombre no está permitido: elige otro" });
  });
});

describe("modo local (pantalla + celulares)", () => {
  it("the screen creates the room without a car, hosts it, and phones join as players", async () => {
    const pantalla = await cliente();
    const r = await pedir(pantalla, EVENTOS.pantalla, { circuito: "san-carlos" });
    if (!r.ok) throw new Error(r.error);
    expect(r.sala).toMatchObject({ local: true, circuito: "san-carlos", anfitrion: pantalla.id, jugadores: [] });

    const cel1 = await cliente();
    const cel2 = await cliente();
    const u1 = await pedir(cel1, EVENTOS.unirse, { nombre: "Ana", codigo: r.sala.codigo });
    const u2 = await pedir(cel2, EVENTOS.unirse, { nombre: "Beto", codigo: r.sala.codigo });
    if (!u1.ok || !u2.ok) throw new Error("no se pudo unir");
    expect(u2.sala.jugadores.map((j) => j.nombre)).toEqual(["Ana", "Beto"]);
    // Different colors even if both asked for none
    expect(new Set(u2.sala.jugadores.map((j) => j.color)).size).toBe(2);
    // Local rooms aren't in the public list
    const lista = await pedir(cel1, EVENTOS.salas, null);
    expect(lista as unknown as { codigo: string }[]).not.toContainEqual(expect.objectContaining({ codigo: r.sala.codigo }));

    // Only the screen starts
    expect(await pedir(cel1, EVENTOS.empezar, null)).toMatchObject({ ok: false });
    expect(await pedir(pantalla, EVENTOS.empezar, null)).toMatchObject({ ok: true });
  });

  it("when the screen leaves, the room closes and the phones are told", async () => {
    const pantalla = await cliente();
    const r = await pedir(pantalla, EVENTOS.pantalla, {});
    if (!r.ok) throw new Error(r.error);
    const cel = await cliente();
    await pedir(cel, EVENTOS.unirse, { nombre: "Ana", codigo: r.sala.codigo });
    const cerrada = siguiente(cel, EVENTOS.cerrada);
    pantalla.disconnect();
    await cerrada;
    expect(juego.gestor.buscar(r.sala.codigo)).toBeUndefined();
  });
});

describe("simulación", () => {
  it("streams every car's state and moves only with the player's controls", async () => {
    const { s, r } = await crearSala();
    if (!r.ok) throw new Error();
    const antes = desempacarCarro((await siguiente<Instantanea>(s, EVENTOS.estado)).c[0]);

    // Two thirds of a second of throttle, one control per tick (whatever the server's tickHz)
    const n = Math.round(r.sala.tickHz * 0.66);
    for (let seq = 0; seq < n; seq++) {
      s.emit(EVENTOS.controles, { seq, giro: 0, acel: 1, freno: 0, mano: false });
      await esperar(1000 / r.sala.tickHz);
    }
    const despues = desempacarCarro(
      (await siguiente<Instantanea>(s, EVENTOS.estado, (i) => i.c[0][10] === n - 1)).c[0],
    );
    expect(despues.id).toBe(s.id);
    expect(despues.seq).toBe(n - 1);
    expect(Math.hypot(despues.estado.x - antes.estado.x, despues.estado.y - antes.estado.y)).toBeGreaterThan(3);
  });

  it("keeps real time: tickHz ticks per second even with imprecise timers", async () => {
    const { r } = await crearSala();
    if (!r.ok) throw new Error();
    const sala = juego.gestor.buscar(r.sala.codigo)!;
    const t0 = performance.now();
    const tick0 = sala.tick;
    await esperar(1000);
    const esperados = ((performance.now() - t0) / 1000) * sala.tickHz;
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

describe("lab: fixed items (JUEGO_PRUEBAS)", () => {
  const leer = (id: string): Circuito => JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", `${id}.json`), "utf8"));
  const ITEMS = JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "items.json"), "utf8"));

  it("a fixed item comes back right after it's used", () => {
    const sala = new Sala("HMO-5555", leer("hermosillo"), 30, 5, ITEMS);
    sala.agregar("yo", { nombre: "Ana", color: "rojo" });
    const indice = ITEMS.findIndex((i: { id: string }) => i.id === "tope");
    sala.itemsFijos.set("yo", indice);
    sala.paso();
    expect(sala.jugadores.get("yo")!.item).toBe(indice);
    sala.jugadores.get("yo")!.item = -1; // as if it was used
    sala.paso();
    expect(sala.jugadores.get("yo")!.item).toBe(indice);
  });

  it("hidden circuits are only for the lab", () => {
    const gestor = new GestorSalas(["hermosillo", "canada"].map(leer), "hermosillo", 5, 30, 5, ITEMS);
    expect(gestor.crear("canada")!.circuito.id).toBe("hermosillo");
    expect(gestor.crear("canada", true)!.circuito.id).toBe("canada");
  });
});

describe("lab: traps ahead of the start (JUEGO_PRUEBAS)", () => {
  const leer = (id: string): Circuito => JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", `${id}.json`), "utf8"));
  const ITEMS = JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "items.json"), "utf8"));
  it.each(["bache", "tope", "cemento", "clavos", "andamio", "cactus", "espejismo", "charco", "poste"])("%s is placed ahead of the grid every round", (id) => {
    const sala = new Sala("HMO-6666", leer("hermosillo"), 30, 5, ITEMS);
    sala.agregar("yo", { nombre: "Ana", color: "rojo" });
    sala.agregarBot();
    const indice = ITEMS.findIndex((i: { id: string }) => i.id === id);
    sala.trampaPrueba = { item: indice, metros: [60] };
    expect(sala.empezar("yo")).toBeNull();
    const mias = sala.entidades.filter((e) => e.item === indice);
    expect(mias.length).toBeGreaterThan(0);
    const yo = sala.jugadores.get("yo")!.carro;
    const d = Math.min(...mias.map((e) => Math.hypot(e.x - yo.x, e.y - yo.y)));
    expect(d).toBeGreaterThan(40);
    expect(d).toBeLessThan(90);
  });
});

describe("online rooms (multijugador)", () => {
  const leer = (id: string): Circuito => JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", `${id}.json`), "utf8"));
  const ITEMS = JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "items.json"), "utf8"));
  const nuevoGestor = () => new GestorSalas(["hermosillo", "desierto"].map(leer), "hermosillo", 10, 30, 1, ITEMS);
  const multi = (sala: Sala, privada = false) => (sala.multi = { privada, partidas: 0, pagada: false });

  it("a private room is not listed nor found by quick match, but joins by code", () => {
    const gestor = nuevoGestor();
    const privada = gestor.crear("hermosillo")!;
    privada.agregar("ana", { nombre: "Ana", color: "rojo" });
    multi(privada, true);
    expect(gestor.abiertas()).toHaveLength(0);
    expect(gestor.rapida(null)).toBeUndefined();
    expect(gestor.buscar(privada.codigo)).toBe(privada);
    expect(privada.estado()).toMatchObject({ multi: true, privada: true });
  });

  it("quick match finds a public room waiting on the asked track (or any track)", () => {
    const gestor = nuevoGestor();
    const sala = gestor.crear("desierto")!;
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    multi(sala);
    expect(gestor.rapida("desierto")).toBe(sala);
    expect(gestor.rapida(null)).toBe(sala);
    expect(gestor.rapida("hermosillo")).toBeUndefined();
    // Normal (old) rooms are not for quick match
    gestor.crear("desierto")!.agregar("beto", { nombre: "Beto", color: "azul" });
    expect(gestor.rapida("desierto")).toBe(sala);
  });

  it("a bot gives its place to a person, only in the waiting room", () => {
    const sala = new Sala("HMO-4444", leer("hermosillo"), 30, 1, ITEMS);
    multi(sala);
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    for (let i = 0; i < 3; i++) sala.agregarBot(0, false, false, "clasico");
    expect(sala.agregar("beto", { nombre: "Beto", color: "azul" })).toMatch(/ya tiene/);
    expect(sala.hacerLugar()).toBe(true);
    expect(sala.jugadores.has("bot-3")).toBe(false);
    expect(sala.agregar("beto", { nombre: "Beto", color: "azul" })).toBeNull();
    for (const id of ["caro", "dani"]) {
      expect(sala.hacerLugar()).toBe(true);
      expect(sala.agregar(id, { nombre: id, color: "verde" })).toBeNull();
    }
    // Full of people: no place
    expect(sala.hacerLugar()).toBe(false);
  });

  it("full: 30 s of preparation in the waiting room, then the countdown", () => {
    const sala = new Sala("HMO-3333", leer("hermosillo"), 30, 1, ITEMS);
    multi(sala);
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    for (let i = 0; i < 3; i++) sala.agregarBot(0, false, false, "arenero");
    expect(sala.estado().jugadores[1]).toMatchObject({ bot: true, vehiculo: "arenero" });
    expect(sala.empezarPreparacion()).toBeNull();
    expect(sala.preparando).toBe(true);
    expect(sala.multi!.partidas).toBe(1);
    expect(sala.partida()).toMatchObject({ fase: "espera", preparacionMs: 30000 });
    // While preparing, a bot can not give its place and the vehicle can still change
    expect(sala.hacerLugar()).toBe(false);
    expect(sala.cambiarVehiculo("ana", "troca")).toBeNull();
    for (let i = 0; i < 30 * 30 - 1; i++) sala.paso();
    expect(sala.fase).toBe("espera");
    sala.paso();
    expect(sala.fase).toBe("cuenta");
    expect(sala.preparando).toBe(false);
    expect(sala.partida().preparacionMs).toBeUndefined();
  });

  it("online, a bot that got in first is the host; it passes to the next one when it leaves", () => {
    const sala = new Sala("HMO-1111", leer("hermosillo"), 30, 1, ITEMS);
    sala.agregarBot(0, false, false, "clasico", "chuy 07");
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    expect(sala.anfitrion).toBe("ana"); // a normal room: never a bot
    multi(sala);
    expect(sala.anfitrion).toBe("bot-1");
    expect(sala.estado().jugadores[0]).toMatchObject({ nombre: "chuy 07", bot: true });
    sala.quitar("bot-1");
    expect(sala.anfitrion).toBe("ana");
  });

  it("online, a bot keeps its color like a person (elsewhere it gives it up)", () => {
    const sala = new Sala("HMO-1212", leer("hermosillo"), 30, 1, ITEMS, () => 0.99);
    multi(sala);
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    sala.agregarBot(0, false, false, "clasico");
    const delBot = sala.jugadores.get("bot-1")!.color;
    expect(delBot).toBe("rosa"); // a free color at random, not just the first one
    expect(sala.cambiarColor("ana", delBot)).toMatch(/ya lo trae/);
    sala.multi = null;
    expect(sala.cambiarColor("ana", delBot)).toBeNull();
    expect(sala.jugadores.get("bot-1")!.color).toBe("rojo");
  });

  it.each([true, false])("a bot that blew up throws at the others only online (online: %s)", (enLinea) => {
    const sala = new Sala("HMO-1313", leer("hermosillo"), 30, 5, ITEMS, rng(7));
    if (enLinea) multi(sala);
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    sala.agregar("beto", { nombre: "Beto", color: "azul" });
    sala.agregarBot(0, false, false, "clasico");
    expect(sala.empezar("ana")).toBeNull();
    while (sala.fase !== "carrera") sala.paso();
    sala.jugadores.get("ana")!.puntos = 2;
    (sala as unknown as { eliminar(j: unknown, m: string): void }).eliminar(sala.jugadores.get("bot-1"), "atras");
    const tiros: { id: string }[] = [];
    for (let i = 0; i < 30 * 8 && sala.fase === "carrera"; i++) {
      sala.jugadores.get("ana")!.vivo = true;
      sala.jugadores.get("beto")!.vivo = true;
      sala.paso();
      tiros.push(...sala.eventos.splice(0).filter((e) => e.tipo === "meteorito" || e.tipo === "usar") as { id: string }[]);
    }
    if (enLinea) expect(tiros.filter((t) => t.id === "bot-1").length).toBeGreaterThan(0);
    else expect(tiros).toHaveLength(0);
  });

  it("online bots say they are ready 3 to 8 s after arriving, and again after each match", () => {
    const sala = new Sala("HMO-1414", leer("hermosillo"), 30, 1, ITEMS, rng(3));
    multi(sala);
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    sala.agregarBot(0, false, false, "clasico");
    const bot = () => sala.estado().jugadores.find((j) => j.bot)!;
    for (let i = 0; i < 3 * 30 - 1; i++) sala.paso();
    expect(bot().listo).toBeUndefined();
    for (let i = 0; i < 5 * 30 + 1; i++) sala.paso();
    expect(bot()).toMatchObject({ bot: true, listo: true });
    expect(sala.cambioJugadores).toBe(true);
  });

  it("online results last 15 s, then everyone is back in the waiting room, nobody ready", () => {
    const sala = new Sala("HMO-1515", leer("hermosillo"), 30, 1, ITEMS, rng(4));
    multi(sala);
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    sala.agregarBot(0, false, false, "clasico");
    expect(sala.empezar("ana")).toBeNull();
    while (sala.fase !== "carrera") sala.paso();
    (sala as unknown as { eliminar(j: unknown, m: string): void }).eliminar(sala.jugadores.get("bot-1"), "atras");
    while ((sala.fase as string) !== "resultados") sala.paso();
    expect(sala.partida().restanteMs).toBe(15000);
    for (let i = 0; i < 15 * 30 - 1; i++) sala.paso();
    expect(sala.fase).toBe("resultados");
    sala.paso();
    expect(sala.fase).toBe("espera");
    expect(sala.estado().jugadores.some((j) => j.listo)).toBe(false);
  });

  it("final places: the winner first, then by points", () => {
    const sala = new Sala("HMO-2222", leer("hermosillo"), 30, 3, ITEMS);
    sala.agregar("ana", { nombre: "Ana", color: "rojo" });
    for (let i = 0; i < 3; i++) sala.agregarBot();
    ["ana", "bot-1", "bot-2", "bot-3"].forEach((id, i) => (sala.jugadores.get(id)!.puntos = [2, 3, 3, 0][i]));
    sala.ganador = "bot-2";
    expect(sala.lugaresFinales()).toEqual(["bot-2", "bot-1", "ana", "bot-3"]);
  });
});
