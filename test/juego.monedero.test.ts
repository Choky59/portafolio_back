import { readFileSync } from "fs";
import http from "http";
import { AddressInfo } from "net";
import path from "path";
import { MongoMemoryServer } from "mongodb-memory-server";
import { io as conectar, Socket } from "socket.io-client";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { BOLETOS, EVENTOS, PRECIO_STICKER, PRECIO_VEHICULO, PREMIO_LUGAR } from "../src/juego/compartido/protocolo";
import { Sala } from "../src/juego/servidor/salas";
import { boletosAhora, comprarVehiculo, diaDe, gastarBoleto, monedasActivas, premiarCopa, premiarMulti, premioDeLugar, premioMulti, usarBoleto } from "../src/juego/servidor/monedero";
import { cerrarCuentas, cuentas } from "../src/juego/servidor/cuentas";
import { iniciarJuego } from "../src/juego/servidor/socket";
import { resultadoCopa } from "../src/juego/servidor/salas";
import { duracionMinimaCopa } from "../src/juego/servidor/montaje";
import { sanearLugares, sesiones } from "../src/juego/servidor/sesiones";
import { rng } from "./juego.utiles";

const DIR = path.join(__dirname, "..", "content", "juego");
const leerCircuito = (id: string): Circuito => JSON.parse(readFileSync(path.join(DIR, "circuitos", `${id}.json`), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HORA = BOLETOS.recargaMs;

describe("tickets (pure)", () => {
  const t0 = Date.UTC(2026, 10, 4, 12);

  it("a new account is full; spending one starts the recharge now", () => {
    expect(boletosAhora(null, t0)).toEqual({ cantidad: 5, siguienteEnMs: null, desde: null });
    expect(gastarBoleto(null, t0)).toEqual({ boletos: 4, recargaDesde: new Date(t0) });
    expect(boletosAhora({ boletos: 4, recargaDesde: new Date(t0) }, t0 + 15 * 60000)).toMatchObject({ cantidad: 4, siguienteEnMs: 45 * 60000 });
  });

  it("one comes back every hour, up to the cap, keeping the progress of the next one", () => {
    const doc = { boletos: 1, recargaDesde: new Date(t0) };
    expect(boletosAhora(doc, t0 + 2.5 * HORA)).toMatchObject({ cantidad: 3, siguienteEnMs: 0.5 * HORA });
    // Spending keeps the half hour already recharged
    expect(gastarBoleto(doc, t0 + 2.5 * HORA)).toEqual({ boletos: 2, recargaDesde: new Date(t0 + 2 * HORA) });
    expect(boletosAhora(doc, t0 + 10 * HORA)).toEqual({ cantidad: 5, siguienteEnMs: null, desde: null });
  });

  it("with none left you can't spend, and it says when the next comes", () => {
    const doc = { boletos: 0, recargaDesde: new Date(t0) };
    expect(gastarBoleto(doc, t0 + 20 * 60000)).toBeNull();
    expect(boletosAhora(doc, t0 + 20 * 60000).siguienteEnMs).toBe(40 * 60000);
  });
});

describe("coins (pure)", () => {
  it("pay by place: a vehicle is 10 wins, 20 seconds or 40 thirds", () => {
    expect(PREMIO_LUGAR.map((_, i) => premioDeLugar(i + 1))).toEqual([400, 200, 100, 0]);
    expect(premioDeLugar(1) * 10).toBe(PRECIO_VEHICULO);
    expect(premioDeLugar(2) * 20).toBe(PRECIO_VEHICULO);
    expect(premioDeLugar(3) * 40).toBe(PRECIO_VEHICULO);
  });

  it("there's nothing to unlock: coins are always on", () => {
    expect(monedasActivas({})).toBe(true);
    expect(monedasActivas({ "desierto-dificil": { mejorLugar: 2, mejoresPuntos: 20 } })).toBe(true);
  });

  it("the day is Hermosillo's", () => {
    // 2026-11-05 03:00 UTC is still the 4th in Hermosillo (UTC-7)
    expect(diaDe(new Date(Date.UTC(2026, 10, 5, 3)))).toBe("2026-11-04");
    expect(diaDe(new Date(Date.UTC(2026, 10, 5, 8)))).toBe("2026-11-05");
  });
});

describe("a cup run by the server", () => {
  const pistas = ["hermosillo", "san-carlos", "desierto"].map(leerCircuito);
  function salaDeCopa() {
    const sala = new Sala("HMO-7777", pistas[0], 30, 3, ITEMS, rng(4));
    sala.agregar("yo", { nombre: "Jorge", color: "rojo" });
    for (let i = 0; i < 3; i++) sala.agregarBot(0, true);
    sala.copa = { id: "desierto", dificil: false, pistas: pistas.map((p) => p.id), indice: 0, puntos: {}, dueno: "yo", uid: "u1", contada: false, final: null, premiada: false };
    return sala;
  }
  /** Ends the current track with these race points (yo, bot-1, bot-2, bot-3) */
  function terminar(sala: Sala, puntos: number[]) {
    ["yo", "bot-1", "bot-2", "bot-3"].forEach((id, i) => (sala.jugadores.get(id)!.puntos = puntos[i]));
    (sala as unknown as { contarCopa(): void }).contarCopa();
  }

  it("adds cup points per track and only lets you go to the next one", () => {
    const sala = salaDeCopa();
    expect(sala.cambiarCircuito("yo", pistas[1])).toMatch(/en orden/); // not finished yet
    terminar(sala, [3, 1, 0, 2]); // yo 1st (10), bot-3 2nd (7), bot-1 3rd (5), bot-2 4th (3)
    expect(sala.copa!.puntos).toEqual({ yo: 10, "bot-3": 7, "bot-1": 5, "bot-2": 3 });
    expect(sala.empezar("yo")).toMatch(/siguiente pista/);
    expect(sala.cambiarCircuito("yo", pistas[2])).toMatch(/en orden/); // skipping one
    expect(sala.cambiarCircuito("yo", pistas[1])).toBeNull();
    expect(sala.copa!.indice).toBe(1);
  });

  it("after the last track it knows the owner's final place", () => {
    const sala = salaDeCopa();
    terminar(sala, [3, 1, 0, 2]);
    sala.cambiarCircuito("yo", pistas[1]);
    terminar(sala, [0, 3, 1, 2]); // yo 4th (+3) → 13
    expect(sala.copa!.final).toBeNull();
    sala.cambiarCircuito("yo", pistas[2]);
    terminar(sala, [0, 3, 2, 1]); // yo 4th again (+3) → 16; bot-1 10+... wins
    expect(sala.copa!.final).toMatchObject({ puntos: 16 });
    expect(sala.copa!.final!.lugar).toBeGreaterThan(1);
  });

  it("the server's count from the places of each track is the same the room makes", () => {
    const sala = salaDeCopa();
    const ordenes: string[][] = [];
    const orden = (puntos: number[]) => ["yo", "bot-1", "bot-2", "bot-3"].map((id, i) => ({ id, p: puntos[i], i })).sort((a, b) => b.p - a.p || a.i - b.i).map((j) => j.id);
    for (const [i, puntos] of [[3, 1, 0, 2], [0, 3, 1, 2], [0, 3, 2, 1]].entries()) {
      if (i) sala.cambiarCircuito("yo", pistas[i]);
      terminar(sala, puntos);
      ordenes.push(orden(puntos));
    }
    expect(resultadoCopa(ordenes, "yo")).toEqual(sala.copa!.final);
    // A tie in cup points goes to the one who did better on the last track
    expect(resultadoCopa([["a", "b"], ["b", "a"], ["b", "a"]], "a")).toEqual({ lugar: 2, puntos: 24 });
  });

  it("the places a browser reports must make sense", () => {
    const ok = [["yo", "bot-1", "bot-2", "bot-3"], ["bot-1", "yo", "bot-2", "bot-3"], ["bot-3", "bot-2", "bot-1", "yo"]];
    expect(sanearLugares(ok, "yo")).toEqual({ pistas: ok, yo: "yo" });
    expect(sanearLugares(ok.slice(0, 2), "yo")).toBeNull(); // 2 tracks
    expect(sanearLugares(ok, "otro")).toBeNull(); // not in the cup
    expect(sanearLugares([ok[0], ok[1], ["yo", "yo", "bot-1", "bot-2"]], "yo")).toBeNull(); // repeated
    expect(sanearLugares([ok[0], ok[1], ["yo", "bot-1", "bot-2", "intruso"]], "yo")).toBeNull(); // different people
    expect(sanearLugares([ok[0], ok[1], [...ok[2], "quinto"]], "yo")).toBeNull(); // too many
    expect(sanearLugares("nada", "yo")).toBeNull();
  });

  it("a cup room isn't listed for others to join", () => {
    const { GestorSalas } = jest.requireActual("../src/juego/servidor/salas");
    const gestor = new GestorSalas(pistas, "hermosillo", 5, 30, 3, ITEMS);
    const sala = gestor.crear("hermosillo");
    sala.agregar("yo", { nombre: "Jorge", color: "rojo" });
    expect(gestor.abiertas()).toHaveLength(1);
    sala.copa = { id: "desierto" } as never;
    expect(gestor.abiertas()).toHaveLength(0);
  });
});

/* ------------------------------ With the database ------------------------------ */

const PROYECTO = "edge-racers-pruebas";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(uid: string, proveedor = "anonymous") {
  const ahora = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${PROYECTO}`,
    aud: PROYECTO,
    sub: uid,
    iat: ahora,
    exp: ahora + 3600,
    firebase: { sign_in_provider: proveedor },
  })}.`;
}

describe("the wallet in the account", () => {
  let mongo: MongoMemoryServer;
  let server: http.Server;
  let juego: ReturnType<typeof iniciarJuego>;
  let url: string;
  const abiertos: Socket[] = [];
  const antes = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
    process.env.JUEGO_MONGO_DB = mongo.getUri();
    process.env.JUEGO_MONGO_DB_NAME = "edge_racers_pruebas";
    process.env.JUEGO_FIREBASE_PROYECTO = PROYECTO;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
    delete process.env.JUEGO_VEHICULOS_DESBLOQUEADOS;
    server = http.createServer();
    juego = iniciarJuego(server);
    await new Promise<void>((listo) => server.listen(0, () => listo()));
    url = `http://localhost:${(server.address() as AddressInfo).port}/juego`;
  }, 180000);
  afterEach(() => abiertos.splice(0).forEach((s) => s.disconnect()));
  afterAll(async () => {
    juego.cerrar();
    await new Promise((listo) => server.close(listo));
    await cerrarCuentas();
    await mongo.stop();
    process.env = antes;
  });

  function cliente(auth?: object): Promise<Socket> {
    const s = conectar(url, { transports: ["websocket"], forceNew: true, auth });
    abiertos.push(s);
    return new Promise((ok) => s.on("connect", () => ok(s)));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pedir = (s: Socket, evento: string, datos: unknown = {}): Promise<any> => new Promise((ok) => s.emit(evento, datos, ok));
  const JUGADOR = { nombre: "Ana", color: "rojo" };
  const coleccion = async () => (await cuentas())!;

  it("entering a cup spends a ticket, builds the room with its bots, and the 6th in a row is refused", async () => {
    const s = await cliente({ token: token("boletos-1") });
    const cambios: unknown[] = [];
    s.on(EVENTOS.cuentaCambio, (c) => cambios.push(c));
    const r = await pedir(s, EVENTOS.crear, { ...JUGADOR, copa: "desierto" });
    expect(r.ok).toBe(true);
    expect(r.sala.circuito).toBe("hermosillo");
    expect((await pedir(s, EVENTOS.cuenta)).cuenta.boletos).toMatchObject({ cantidad: 4, max: 5 });
    for (let i = 0; i < 4; i++) expect((await pedir(s, EVENTOS.crear, { ...JUGADOR, copa: "desierto" })).ok).toBe(true);
    const sexto = await pedir(s, EVENTOS.crear, { ...JUGADOR, copa: "desierto" });
    expect(sexto).toMatchObject({ ok: false, error: expect.stringMatching(/boletos/) });
    expect(cambios.length).toBeGreaterThan(0);
  });

  it("no account, a locked cup or a locked Hard: refused, and no ticket is spent", async () => {
    const sinCuenta = await cliente();
    expect(await pedir(sinCuenta, EVENTOS.crear, { ...JUGADOR, copa: "desierto" })).toMatchObject({ ok: false, error: expect.stringMatching(/cuenta/) });
    const s = await cliente({ token: token("cerradas-1") });
    expect(await pedir(s, EVENTOS.crear, { ...JUGADOR, copa: "construccion" })).toMatchObject({ ok: false, error: expect.stringMatching(/podio/) });
    expect(await pedir(s, EVENTOS.crear, { ...JUGADOR, copa: "desierto", dificil: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Difícil/) });
    expect((await pedir(s, EVENTOS.cuenta)).cuenta.boletos.cantidad).toBe(5);
  });

  it("the phone can't write progress anymore: the server's is what counts", async () => {
    const s = await cliente({ token: token("tramposo-1") });
    const r = await pedir(s, EVENTOS.progreso, { progreso: { "desierto-dificil": { mejorLugar: 1, mejoresPuntos: 30 } } });
    expect(r).toEqual({ ok: true, progreso: {} });
    expect((await pedir(s, EVENTOS.cuenta)).cuenta.progreso).toEqual({});
  });

  it("Hard pays by place from the very first cup; the same cup pays once a day", async () => {
    const dia = new Date(Date.UTC(2026, 10, 4, 18));
    // Normal: no coins (not Hard)
    expect(await premiarCopa("rico-1", "desierto", false, 1, 30, dia)).toMatchObject({ ok: true, resultado: { monedas: 0 } });
    // The first Hard cup ever, in 2nd place: it pays already
    expect(await premiarCopa("segundo-1", "desierto", true, 2, 24, dia)).toMatchObject({ ok: true, resultado: { monedas: 200, desbloqueo: false } });
    const primera = await premiarCopa("rico-1", "desierto", true, 1, 30, dia);
    expect(primera).toMatchObject({ ok: true, resultado: { monedas: 400, desbloqueo: false, yaPagoHoy: false } });
    const otraVez = await premiarCopa("rico-1", "desierto", true, 2, 24, dia);
    expect(otraVez).toMatchObject({ ok: true, resultado: { monedas: 0, yaPagoHoy: true } });
    // The next day it pays again
    const manana = await premiarCopa("rico-1", "desierto", true, 3, 20, new Date(+dia + 24 * HORA));
    expect(manana).toMatchObject({ ok: true, resultado: { monedas: 100, yaPagoHoy: false } });
    const doc = await (await coleccion()).findOne({ _id: "rico-1" });
    expect(doc?.monedas).toBe(500);
    // The best place is kept
    expect(doc?.progreso?.["desierto-dificil"]).toEqual({ mejorLugar: 1, mejoresPuntos: 30 });
  });

  it("two results at the same time don't pay twice", async () => {
    const dia = new Date(Date.UTC(2026, 10, 6, 18));
    await premiarCopa("doble-1", "desierto", false, 1, 30, dia);
    await premiarCopa("doble-1", "desierto", true, 1, 30, dia);
    await (await coleccion()).updateOne({ _id: "doble-1" }, { $unset: { "monedasDia.desierto": "" }, $set: { monedas: 0 } });
    const [a, b] = await Promise.all([premiarCopa("doble-1", "desierto", true, 1, 30, dia), premiarCopa("doble-1", "desierto", true, 1, 30, dia)]);
    expect([a, b].filter((r) => r.ok && r.resultado.monedas > 0)).toHaveLength(1);
    expect((await (await coleccion()).findOne({ _id: "doble-1" }))?.monedas).toBe(400);
  });

  it("buying: needs enough coins, and the vehicle then rides", async () => {
    const s = await cliente({ token: token("comprador-1") });
    expect(await pedir(s, EVENTOS.comprar, { vehiculo: "troca" })).toMatchObject({ ok: false, error: expect.stringMatching(/faltan/) });
    await premiarCopa("comprador-1", "desierto", false, 1, 30);
    await premiarCopa("comprador-1", "desierto", true, 1, 30);
    expect(await pedir(s, EVENTOS.comprar, { vehiculo: "troca" })).toMatchObject({ ok: false, error: expect.stringMatching(/faltan/) });
    expect(await comprarVehiculo("comprador-1", "arenero")).toMatchObject({ ok: false }); // prize-only
    // The Hard win already paid 400: still short of 4000
    await (await coleccion()).updateOne({ _id: "comprador-1" }, { $set: { monedas: PRECIO_VEHICULO + 50 } });
    const compra = await pedir(s, EVENTOS.comprar, { vehiculo: "troca" });
    expect(compra).toMatchObject({ ok: true, cuenta: { monedas: 50, vehiculos: ["troca"] } });
    expect(await pedir(s, EVENTOS.comprar, { vehiculo: "troca" })).toMatchObject({ ok: false, error: expect.stringMatching(/ya es tuyo/) });
    const r = await pedir(s, EVENTOS.crear, { ...JUGADOR, vehiculo: "troca" });
    expect(r.sala.jugadores[0]).toMatchObject({ vehiculo: "troca" });
  });

  it("stickers: two free ones, the rest cost coins, and the bar keeps up to 4 of your own", async () => {
    const s = await cliente({ token: token("stickers-1") });
    const inicio = await pedir(s, EVENTOS.cuenta);
    expect(inicio.cuenta).toMatchObject({ stickers: ["aprobacion", "celebracion"], barraStickers: ["aprobacion", "celebracion"] });
    expect(await pedir(s, EVENTOS.comprar, { sticker: "aprobacion" })).toMatchObject({ ok: false, error: expect.stringMatching(/ya es tuyo/) });
    expect(await pedir(s, EVENTOS.comprar, { sticker: "risa" })).toMatchObject({ ok: false, error: expect.stringMatching(/faltan/) });
    await (await coleccion()).updateOne({ _id: "stickers-1" }, { $set: { monedas: PRECIO_STICKER * 3 + 10 } });
    // Bought with room in the bar: it goes in right away
    const risa = await pedir(s, EVENTOS.comprar, { sticker: "risa" });
    expect(risa).toMatchObject({ ok: true, cuenta: { monedas: PRECIO_STICKER * 2 + 10, barraStickers: ["aprobacion", "celebracion", "risa"] } });
    await pedir(s, EVENTOS.comprar, { sticker: "amor" });
    await pedir(s, EVENTOS.comprar, { sticker: "enojo" });
    const llena = await pedir(s, EVENTOS.cuenta);
    // The 5th one is yours, but the bar was full
    expect(llena.cuenta.stickers).toEqual(["aprobacion", "celebracion", "risa", "enojo", "amor"]);
    expect(llena.cuenta.barraStickers).toEqual(["aprobacion", "celebracion", "risa", "amor"]);
    // Your own order, no repeats, nothing you don't have, no more than 4
    const barra = await pedir(s, EVENTOS.barraStickers, { stickers: ["enojo", "enojo", "victoria", "amor", "risa", "aprobacion", "celebracion"] });
    expect(barra).toMatchObject({ ok: true, cuenta: { barraStickers: ["enojo", "amor", "risa", "aprobacion"] } });
    expect(await pedir(s, EVENTOS.comprar, { sticker: "no-existe" })).toMatchObject({ ok: false });
  });

  describe("a cup played in the browser", () => {
    const LUGARES = [["yo", "bot-1", "bot-2", "bot-3"], ["yo", "bot-2", "bot-1", "bot-3"], ["bot-1", "yo", "bot-2", "bot-3"]];
    const MINIMO_MS = duracionMinimaCopa({ pistas: ["a", "b", "c"], meta: 3 }) * 1000;
    /** Makes the session look as old as a whole cup (the test can't wait that long) */
    const envejecer = async (sesion: string, ms = MINIMO_MS + 1000) =>
      (await sesiones())!.updateOne({ _id: sesion }, { $set: { creada: new Date(Date.now() - ms) } });

    it("starting spends one ticket and opens a session, without creating any room", async () => {
      const s = await cliente({ token: token("local-1") });
      const r = await pedir(s, EVENTOS.copaIniciar, { copa: "desierto" });
      expect(r).toMatchObject({ ok: true, sesion: expect.any(String), cuenta: { boletos: { cantidad: 4 } } });
      expect(juego.gestor.total).toBe(0);
      const doc = await (await sesiones())!.findOne({ _id: r.sesion });
      expect(doc).toMatchObject({ uid: "local-1", copa: "desierto", dificil: false, estado: "abierta" });
    });

    it("no account, or a locked cup: refused, and no ticket is spent", async () => {
      expect(await pedir(await cliente(), EVENTOS.copaIniciar, { copa: "desierto" })).toMatchObject({ ok: false, error: expect.stringMatching(/cuenta/) });
      const s = await cliente({ token: token("local-2") });
      expect(await pedir(s, EVENTOS.copaIniciar, { copa: "construccion" })).toMatchObject({ ok: false, error: expect.stringMatching(/podio/) });
      expect(await pedir(s, EVENTOS.copaIniciar, { copa: "desierto", dificil: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Difícil/) });
      expect((await pedir(s, EVENTOS.cuenta)).cuenta.boletos.cantidad).toBe(5);
    });

    it("the result is paid once, with the place the server counts", async () => {
      const s = await cliente({ token: token("local-3") });
      const { sesion } = await pedir(s, EVENTOS.copaIniciar, { copa: "desierto" });
      await envejecer(sesion);
      const cambios: unknown[] = [];
      s.on(EVENTOS.cuentaCambio, (c) => cambios.push(c));
      // yo: 10 + 10 + 7 = 27, bot-1: 5 + 7 + 10 = 22 → 1st
      const r = await pedir(s, EVENTOS.copaResultado, { sesion, lugares: LUGARES, yo: "yo", lugar: 4, puntos: 0 });
      expect(r).toMatchObject({ ok: true, copa: { copa: "desierto", lugar: 1, puntos: 27 }, cuenta: { progreso: { desierto: { mejorLugar: 1, mejoresPuntos: 27 } } } });
      expect(cambios).toHaveLength(1);
      // The same result again: already paid, don't retry
      expect(await pedir(s, EVENTOS.copaResultado, { sesion, lugares: LUGARES, yo: "yo" })).toMatchObject({ ok: false, definitivo: true, error: expect.stringMatching(/ya se cobró/) });
    });

    it("two results at the same time pay once", async () => {
      const s = await cliente({ token: token("local-4") });
      const { sesion } = await pedir(s, EVENTOS.copaIniciar, { copa: "desierto" });
      await envejecer(sesion);
      const rs = await Promise.all([1, 2, 3].map(() => pedir(s, EVENTOS.copaResultado, { sesion, lugares: LUGARES, yo: "yo" })));
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
    });

    it("too soon, expired, someone else's, or places that don't add up: refused", async () => {
      const s = await cliente({ token: token("local-5") });
      const { sesion } = await pedir(s, EVENTOS.copaIniciar, { copa: "desierto" });
      // A cup can't be over this fast
      expect(await pedir(s, EVENTOS.copaResultado, { sesion, lugares: LUGARES, yo: "yo" })).toMatchObject({ ok: false, definitivo: true, error: expect.stringMatching(/rápido/) });
      await envejecer(sesion);
      // Someone else can't cash it
      const otro = await cliente({ token: token("local-6") });
      expect(await pedir(otro, EVENTOS.copaResultado, { sesion, lugares: LUGARES, yo: "yo" })).toMatchObject({ ok: false, definitivo: true });
      expect(await pedir(s, EVENTOS.copaResultado, { sesion, lugares: LUGARES.slice(0, 2), yo: "yo" })).toMatchObject({ ok: false, definitivo: true, error: expect.stringMatching(/no cuadra/) });
      expect(await pedir(s, EVENTOS.copaResultado, { sesion, lugares: LUGARES, yo: "yo", vehiculo: "troca" })).toMatchObject({ ok: false, error: expect.stringMatching(/no es tuyo/) });
      // None of those closed it: the honest result still counts
      expect(await pedir(s, EVENTOS.copaResultado, { sesion, lugares: LUGARES, yo: "yo", vehiculo: "clasico" })).toMatchObject({ ok: true });
      // After a day it's gone
      const vieja = (await pedir(s, EVENTOS.copaIniciar, { copa: "desierto" })).sesion;
      await (await sesiones())!.updateOne({ _id: vieja }, { $set: { caduca: new Date(Date.now() - 1000) } });
      await envejecer(vieja);
      expect(await pedir(s, EVENTOS.copaResultado, { sesion: vieja, lugares: LUGARES, yo: "yo" })).toMatchObject({ ok: false, definitivo: true, error: expect.stringMatching(/caducó/) });
    });
  });

  it("two tickets spent at the same time are two tickets", async () => {
    await (await coleccion()).deleteOne({ _id: "carrera-1" });
    const rs = await Promise.all([usarBoleto("carrera-1"), usarBoleto("carrera-1"), usarBoleto("carrera-1")]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect((await (await coleccion()).findOne({ _id: "carrera-1" }))?.boletos).toBe(2);
  });
});

describe("online play: tickets and prizes", () => {
  let mongo: MongoMemoryServer;
  let server: http.Server;
  let juego: ReturnType<typeof iniciarJuego>;
  let url: string;
  const abiertos: Socket[] = [];
  const antes = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
    process.env.JUEGO_MONGO_DB = mongo.getUri();
    process.env.JUEGO_MONGO_DB_NAME = "edge_racers_multi";
    process.env.JUEGO_FIREBASE_PROYECTO = PROYECTO;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
    delete process.env.JUEGO_VEHICULOS_DESBLOQUEADOS;
    await cerrarCuentas();
    server = http.createServer();
    juego = iniciarJuego(server);
    await new Promise<void>((listo) => server.listen(0, () => listo()));
    url = `http://localhost:${(server.address() as AddressInfo).port}/juego`;
  }, 180000);
  afterEach(() => abiertos.splice(0).forEach((s) => s.disconnect()));
  afterAll(async () => {
    juego.cerrar();
    await new Promise((listo) => server.close(listo));
    await cerrarCuentas();
    await mongo.stop();
    process.env = antes;
  });

  function cliente(auth?: object): Promise<Socket> {
    const s = conectar(url, { transports: ["websocket"], forceNew: true, auth });
    abiertos.push(s);
    return new Promise((ok) => s.on("connect", () => ok(s)));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pedir = (s: Socket, evento: string, datos: unknown = {}): Promise<any> => new Promise((ok) => s.emit(evento, datos, ok));
  const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  const JUGADOR = { nombre: "Ana", color: "rojo" };

  it("pays 150 / 75 / 25 / 0 with no daily limit", async () => {
    expect([1, 2, 3, 4].map(premioMulti)).toEqual([150, 75, 25, 0]);
    await premiarMulti("multi-rico", 1);
    await premiarMulti("multi-rico", 1);
    await premiarMulti("multi-rico", 3);
    expect((await (await cuentas())!.findOne({ _id: "multi-rico" }))?.monedas).toBe(325);
  });

  it("needs an account and a ticket to play online", async () => {
    expect(await pedir(await cliente(), EVENTOS.rapida, JUGADOR)).toMatchObject({ ok: false, error: expect.stringMatching(/cuenta/) });
    expect(await pedir(await cliente(), EVENTOS.crear, { ...JUGADOR, multi: true })).toMatchObject({ ok: false, error: expect.stringMatching(/cuenta/) });
    await (await cuentas())!.updateOne({ _id: "multi-pobre" }, { $set: { boletos: 0, recargaDesde: new Date() } }, { upsert: true });
    const pobre = await cliente({ token: token("multi-pobre") });
    expect(await pedir(pobre, EVENTOS.rapida, JUGADOR)).toMatchObject({ ok: false, error: expect.stringMatching(/boletos/) });
  });

  it("quick match: a new room with one bot; a second player joins it; a private room stays out", async () => {
    const ana = await cliente({ token: token("multi-ana") });
    const r = await pedir(ana, EVENTOS.rapida, { ...JUGADOR, circuito: "desierto" });
    expect(r).toMatchObject({ ok: true, sala: { multi: true, circuito: "desierto" } });
    // Online it's always first to 3, and it can't be changed
    expect(r.partida.meta).toBe(3);
    expect(await pedir(ana, EVENTOS.ajustes, { meta: 5 })).toMatchObject({ ok: false });
    await esperar(50);
    const sala = juego.gestor.buscar(r.sala.codigo)!;
    // Half the time a bot "made" the room (it's there, as host); otherwise you host and it comes a few seconds later
    const bots = [...sala.jugadores.values()].filter((j) => j.mente);
    if (sala.jugadores.get(sala.anfitrion)?.mente) expect(bots).toHaveLength(1);
    else expect(bots).toHaveLength(0);
    // Entering is free: the ticket is spent when a match starts
    expect((await pedir(ana, EVENTOS.cuenta)).cuenta.boletos.cantidad).toBe(5);
    const privada = await pedir(await cliente({ token: token("multi-priv") }), EVENTOS.crear, { ...JUGADOR, multi: true, privada: true, circuito: "desierto" });
    expect(privada).toMatchObject({ ok: true, sala: { privada: true } });
    const beto = await cliente({ token: token("multi-beto") });
    const r2 = await pedir(beto, EVENTOS.rapida, { nombre: "Beto", color: "azul", circuito: "desierto" });
    expect(r2.sala.codigo).toBe(r.sala.codigo);
  });

  it("a private room never gets bots: not over time, not when starting", async () => {
    const ana = await cliente({ token: token("priv-ana") });
    const r = await pedir(ana, EVENTOS.crear, { ...JUGADOR, multi: true, privada: true, circuito: "hermosillo" });
    const sala = juego.gestor.buscar(r.sala.codigo)!;
    expect(await pedir(ana, EVENTOS.empezar)).toMatchObject({ ok: false, error: expect.stringMatching(/al menos 2/) });
    const beto = await cliente({ token: token("priv-beto") });
    await pedir(beto, EVENTOS.unirse, { nombre: "Beto", color: "azul", codigo: r.sala.codigo, multi: true });
    await pedir(beto, EVENTOS.listo, { listo: true });
    expect(await pedir(ana, EVENTOS.empezar)).toEqual({ ok: true });
    expect(sala.jugadores.size).toBe(2);
    expect([...sala.jugadores.values()].some((j) => j.mente)).toBe(false);
    expect(sala.preparando).toBe(true);
    // Both pick their vehicle and stickers early: the match starts right away, not when time runs out
    expect(await pedir(ana, EVENTOS.listo, { listo: true })).toEqual({ ok: true });
    expect(sala.preparando).toBe(true);
    expect(await pedir(beto, EVENTOS.listo, { listo: true })).toEqual({ ok: true });
    await esperar(200);
    expect(sala.preparando).toBe(false);
    expect(sala.fase).toBe("cuenta");
  });

  it("everyone but the host has to be ready before starting", async () => {
    const ana = await cliente({ token: token("listo-ana") });
    const r = await pedir(ana, EVENTOS.crear, { ...JUGADOR, multi: true, circuito: "hermosillo" });
    const beto = await cliente({ token: token("listo-beto") });
    expect((await pedir(beto, EVENTOS.unirse, { nombre: "Beto", color: "azul", codigo: r.sala.codigo, multi: true })).ok).toBe(true);
    expect(await pedir(ana, EVENTOS.empezar)).toMatchObject({ ok: false, error: expect.stringMatching(/listos/) });
    expect(await pedir(beto, EVENTOS.listo, { listo: true })).toEqual({ ok: true });
    // A bot that is still deciding also holds the start
    const sala = juego.gestor.buscar(r.sala.codigo)!;
    sala.agregarBot(0, false, false, "clasico");
    expect(await pedir(ana, EVENTOS.empezar)).toMatchObject({ ok: false, error: expect.stringMatching(/listos/) });
    sala.jugadores.get("bot-1")!.listo = true;
    expect(await pedir(ana, EVENTOS.empezar)).toEqual({ ok: true });
    expect(juego.gestor.buscar(r.sala.codigo)!.preparando).toBe(true);
  });

  it("Empezar ya plays with whoever is in, closes the room, spends one ticket per person and pays the places", async () => {
    const ana = await cliente({ token: token("multi-host") });
    const cambios: { multi?: { lugar: number; monedas: number } }[] = [];
    ana.on(EVENTOS.cuentaCambio, (c) => cambios.push(c));
    const r = await pedir(ana, EVENTOS.crear, { ...JUGADOR, multi: true, circuito: "hermosillo" });
    expect(r.ok).toBe(true);
    expect(await pedir(ana, EVENTOS.bots, { cantidad: 3 })).toMatchObject({ ok: false });
    // Alone there is no match
    expect(await pedir(ana, EVENTOS.empezar)).toMatchObject({ ok: false, error: expect.stringMatching(/al menos 2/) });
    const sala = juego.gestor.buscar(r.sala.codigo)!;
    sala.agregarBot(0, false, false, "clasico");
    sala.jugadores.get("bot-1")!.listo = true;
    expect(await pedir(ana, EVENTOS.empezar)).toEqual({ ok: true });
    // Nobody fills the empty places, and nobody else can join now
    expect(sala.jugadores.size).toBe(2);
    expect(sala.preparando).toBe(true);
    const tarde = await cliente({ token: token("multi-tarde") });
    expect(await pedir(tarde, EVENTOS.unirse, { nombre: "Tarde", color: "azul", codigo: r.sala.codigo, multi: true })).toMatchObject({ ok: false, error: expect.stringMatching(/en partida/) });
    expect(juego.gestor.rapida("hermosillo")).toBeUndefined();
    await esperar(300);
    expect((await pedir(ana, EVENTOS.cuenta)).cuenta.boletos.cantidad).toBe(4);
    // The match ends with Ana as the winner
    sala.ganador = r.id;
    sala.fase = "resultados";
    await esperar(300);
    expect(cambios.find((c) => c.multi)).toMatchObject({ multi: { lugar: 1, monedas: 150 } });
    expect((await pedir(ana, EVENTOS.cuenta)).cuenta.monedas).toBe(150);
  });
});
