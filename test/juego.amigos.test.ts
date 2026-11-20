import http from "http";
import { AddressInfo } from "net";
import { MongoMemoryServer } from "mongodb-memory-server";
import { io as conectar, Socket } from "socket.io-client";
import { EVENTOS } from "../src/juego/compartido/protocolo";
import { codigoAlAzar, normalizarCodigoAmigo, sanearNombreAmigo } from "../src/juego/servidor/amigos";
import { cerrarCuentas, cuentas } from "../src/juego/servidor/cuentas";
import { iniciarJuego } from "../src/juego/servidor/socket";

describe("friend codes (pure)", () => {
  it("six digits, never starting with 0", () => {
    expect(codigoAlAzar(() => 0)).toBe("100000");
    expect(codigoAlAzar(() => 0.999999)).toBe("999999");
    expect(normalizarCodigoAmigo(" 123 456 ")).toBe("123456");
    expect(normalizarCodigoAmigo("123-456")).toBe("123456");
    expect(normalizarCodigoAmigo("012345")).toBeNull();
    expect(normalizarCodigoAmigo("12345")).toBeNull();
    expect(normalizarCodigoAmigo(null)).toBeNull();
  });

  it("names are trimmed and checked", () => {
    expect(sanearNombreAmigo("  Ana   Lu ")).toBe("Ana Lu");
    expect(sanearNombreAmigo(42)).toBe("");
  });
});

const PROYECTO = "edge-racers-pruebas";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(uid: string) {
  const ahora = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${PROYECTO}`,
    aud: PROYECTO,
    sub: uid,
    iat: ahora,
    exp: ahora + 3600,
    firebase: { sign_in_provider: "google.com" },
  })}.`;
}

describe("friends", () => {
  let mongo: MongoMemoryServer;
  let server: http.Server;
  let juego: ReturnType<typeof iniciarJuego>;
  let url: string;
  const abiertos: Socket[] = [];
  const antes = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
    process.env.JUEGO_MONGO_DB = mongo.getUri();
    process.env.JUEGO_MONGO_DB_NAME = "edge_racers_amigos";
    process.env.JUEGO_FIREBASE_PROYECTO = PROYECTO;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const siguienteAviso = (s: Socket): Promise<any> => new Promise((ok) => s.once(EVENTOS.amigosAviso, ok));

  it("needs an account", async () => {
    expect(await pedir(await cliente(), EVENTOS.amigos)).toMatchObject({ ok: false, error: expect.stringMatching(/cuenta/) });
  });

  it("request, accept, see online and in a room, invite, remove", async () => {
    const ana = await cliente({ token: token("amigo-ana") });
    const beto = await cliente({ token: token("amigo-beto") });
    const la = await pedir(ana, EVENTOS.amigos, { nombre: "Ana" });
    const lb = await pedir(beto, EVENTOS.amigos, { nombre: "Beto" });
    expect(la).toMatchObject({ ok: true, lista: { codigo: expect.stringMatching(/^[1-9]\d{5}$/), amigos: [], solicitudes: [], enviadas: [] } });
    expect(lb.lista.codigo).not.toBe(la.lista.codigo);
    // The code is kept
    expect((await pedir(ana, EVENTOS.amigos)).lista.codigo).toBe(la.lista.codigo);

    expect(await pedir(ana, EVENTOS.amigoSolicitar, { codigo: la.lista.codigo })).toMatchObject({ ok: false, error: expect.stringMatching(/propio/) });
    expect(await pedir(ana, EVENTOS.amigoSolicitar, { codigo: "999998" })).toMatchObject({ ok: false });

    const aviso = siguienteAviso(beto);
    expect(await pedir(ana, EVENTOS.amigoSolicitar, { codigo: lb.lista.codigo })).toMatchObject({ ok: true, amigos: false });
    expect(await aviso).toEqual({ tipo: "solicitud", de: { codigo: la.lista.codigo, nombre: "Ana" } });
    expect(await pedir(ana, EVENTOS.amigoSolicitar, { codigo: lb.lista.codigo })).toMatchObject({ ok: false, error: expect.stringMatching(/Ya le mandaste/) });
    expect((await pedir(ana, EVENTOS.amigos)).lista.enviadas).toEqual([{ codigo: lb.lista.codigo, nombre: "Beto" }]);
    expect((await pedir(beto, EVENTOS.amigos)).lista.solicitudes).toEqual([{ codigo: la.lista.codigo, nombre: "Ana" }]);

    const aceptada = siguienteAviso(ana);
    expect(await pedir(beto, EVENTOS.amigoAceptar, { codigo: la.lista.codigo })).toMatchObject({ ok: true });
    expect(await aceptada).toMatchObject({ tipo: "aceptada", de: { nombre: "Beto" } });
    const deAna = (await pedir(ana, EVENTOS.amigos)).lista;
    expect(deAna).toMatchObject({ solicitudes: [], enviadas: [], amigos: [{ codigo: lb.lista.codigo, nombre: "Beto", conectado: true, sala: null }] });

    // Beto creates a private room: Ana sees it and can be invited
    await (await cuentas())!.updateOne({ _id: "amigo-beto" }, { $set: { boletos: 5 } });
    const r = await pedir(beto, EVENTOS.crear, { nombre: "Beto", color: "rojo", multi: true, privada: true });
    expect(r.ok).toBe(true);
    const enSala = (await pedir(ana, EVENTOS.amigos)).lista.amigos[0];
    expect(enSala.sala).toMatchObject({ codigo: r.sala.codigo, privada: true, abierta: true });
    const invitacion = siguienteAviso(ana);
    expect(await pedir(beto, EVENTOS.amigoInvitar, { codigos: [la.lista.codigo, "123456"] })).toEqual({ ok: true, invitados: 1 });
    expect(await invitacion).toMatchObject({ tipo: "invitacion", de: { nombre: "Beto" }, sala: { codigo: r.sala.codigo } });
    // Ana isn't in a room: she can't invite
    expect(await pedir(ana, EVENTOS.amigoInvitar, { codigos: [lb.lista.codigo] })).toMatchObject({ ok: false });

    // Beto closes the game: offline
    beto.disconnect();
    await esperar(100);
    expect((await pedir(ana, EVENTOS.amigos)).lista.amigos[0]).toMatchObject({ conectado: false, sala: null });

    expect(await pedir(ana, EVENTOS.amigoQuitar, { codigo: lb.lista.codigo })).toMatchObject({ ok: true });
    expect((await pedir(ana, EVENTOS.amigos)).lista.amigos).toEqual([]);
    expect((await (await cuentas())!.findOne({ _id: "amigo-beto" }))?.amigos).toEqual([]);
  });

  it("two crossed requests become a friendship; rejecting clears both sides", async () => {
    const c = await cliente({ token: token("amigo-c") });
    const d = await cliente({ token: token("amigo-d") });
    const e = await cliente({ token: token("amigo-e") });
    const [lc, ld, le] = await Promise.all([pedir(c, EVENTOS.amigos, { nombre: "Ce" }), pedir(d, EVENTOS.amigos, { nombre: "De" }), pedir(e, EVENTOS.amigos, { nombre: "E" })]);
    await pedir(c, EVENTOS.amigoSolicitar, { codigo: ld.lista.codigo });
    expect(await pedir(d, EVENTOS.amigoSolicitar, { codigo: lc.lista.codigo })).toMatchObject({ ok: true, amigos: true });
    expect((await pedir(c, EVENTOS.amigos)).lista.amigos.map((a: { nombre: string }) => a.nombre)).toEqual(["De"]);

    await pedir(e, EVENTOS.amigoSolicitar, { codigo: lc.lista.codigo });
    expect(await pedir(c, EVENTOS.amigoQuitar, { codigo: le.lista.codigo })).toMatchObject({ ok: true });
    expect((await pedir(c, EVENTOS.amigos)).lista.solicitudes).toEqual([]);
    expect((await pedir(e, EVENTOS.amigos)).lista.enviadas).toEqual([]);
  });
});
