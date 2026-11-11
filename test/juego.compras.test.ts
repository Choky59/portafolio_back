import http from "http";
import { AddressInfo } from "net";
import { MongoMemoryServer } from "mongodb-memory-server";
import { io as conectar, Socket } from "socket.io-client";
import { BOLETOS, EVENTOS, PRODUCTOS_DINERO, productoDeTienda } from "../src/juego/compartido/protocolo";
import { cerrarCuentas, cuentas } from "../src/juego/servidor/cuentas";
import { acreditar, tiendas, type CompraVerificada } from "../src/juego/servidor/compras";
import { usarBoleto } from "../src/juego/servidor/monedero";
import { iniciarJuego } from "../src/juego/servidor/socket";

const PROYECTO = "edge-racers-pruebas";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A token like the Firebase emulator's: header.payload. with no signature */
function token(uid: string, proveedor = "google.com") {
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

const producto = (id: string) => PRODUCTOS_DINERO.find((p) => p.id === id)!;
const compra = (id: string, clave: string): CompraVerificada => ({ clave, producto: producto(id), plataforma: "ios", entorno: "Sandbox" });

describe("the products sold for money", () => {
  it("have unique store ids that both stores accept (lowercase, digits, dots)", () => {
    const ids = PRODUCTOS_DINERO.map((p) => p.tienda);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9._]*$/);
    expect(productoDeTienda("mx.jorgeandresgarcia.edgeracers.monedas500")?.id).toBe("monedas-500");
    expect(productoDeTienda("otra.cosa")).toBeNull();
  });

  it("the real Apple check loads its root certificate and refuses a forged JWS", async () => {
    const falso = `${b64({ alg: "ES256", x5c: ["AAAA"] })}.${b64({ productId: producto("monedas-500").tienda, transactionId: "1" })}.firma`;
    expect(await tiendas.verificarApple(falso)).toEqual({ ok: false, error: "No se pudo verificar la compra con Apple" });
  });

  it("only the big ticket box is forever", () => {
    expect(PRODUCTOS_DINERO.filter((p) => !p.consumible).map((p) => p.id)).toEqual(["boletera"]);
  });
});

describe("paying with real money", () => {
  let mongo: MongoMemoryServer;
  let server: http.Server;
  let juego: ReturnType<typeof iniciarJuego>;
  let url: string;
  const abiertos: Socket[] = [];
  const antes = { ...process.env };
  const reales = { ...tiendas };
  const cerradas: string[] = [];

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
    process.env.JUEGO_MONGO_DB = mongo.getUri();
    process.env.JUEGO_MONGO_DB_NAME = "edge_racers_compras";
    process.env.JUEGO_FIREBASE_PROYECTO = PROYECTO;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
    // The stores, faked: a JWS "apple:<id>:<product>" and any Google token are valid
    tiendas.verificarApple = async (jws) => {
      const [marca, id, tienda] = jws.split(":");
      const p = productoDeTienda(tienda);
      if (marca !== "apple" || !p) return { ok: false, error: "No se pudo verificar la compra con Apple" };
      return { ok: true, compra: { clave: `apple:${id}`, producto: p, plataforma: "ios", entorno: "Sandbox" } };
    };
    tiendas.verificarGoogle = async (tienda, tok) => {
      const p = productoDeTienda(tienda);
      if (!p) return { ok: false, error: "Esa compra no es de este juego" };
      return { ok: true, compra: { clave: `google:${tok}`, producto: p, plataforma: "android", entorno: "Test", token: tok } };
    };
    tiendas.cerrarGoogle = async (c) => void cerradas.push(c.clave);
    server = http.createServer();
    juego = iniciarJuego(server);
    await new Promise<void>((listo) => server.listen(0, () => listo()));
    url = `http://localhost:${(server.address() as AddressInfo).port}/juego`;
  }, 180000);
  afterEach(() => abiertos.splice(0).forEach((s) => s.disconnect()));
  afterAll(async () => {
    Object.assign(tiendas, reales);
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

  it("coins arrive once, even if the app sends the same purchase twice", async () => {
    const s = await cliente({ token: token("pagador-1") });
    const jws = `apple:1001:${producto("monedas-3000").tienda}`;
    const r = await pedir(s, EVENTOS.validarCompra, { plataforma: "ios", jws });
    expect(r).toMatchObject({ ok: true, producto: "monedas-3000", nueva: true, cuenta: { monedas: 3000 } });
    const otra = await pedir(s, EVENTOS.validarCompra, { plataforma: "ios", jws });
    expect(otra).toMatchObject({ ok: true, nueva: false, cuenta: { monedas: 3000 } });
  });

  it("two copies of one purchase at the same time pay once", async () => {
    const c = compra("monedas-500", "apple:2002");
    const rs = await Promise.all([acreditar("pagador-2", c), acreditar("pagador-2", c), acreditar("pagador-2", c)]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && r.nueva)).toHaveLength(1);
    expect((await (await cuentas())!.findOne({ _id: "pagador-2" }))?.monedas).toBe(500);
  });

  it("a purchase can't be used on a second account", async () => {
    expect(await acreditar("pagador-3", compra("monedas-500", "apple:3003"))).toMatchObject({ ok: true });
    expect(await acreditar("ladron-3", compra("monedas-500", "apple:3003"))).toMatchObject({ ok: false, error: expect.stringMatching(/otra cuenta/) });
  });

  it("guests and players without an account can't buy; nonsense is refused", async () => {
    const jws = `apple:4004:${producto("monedas-500").tienda}`;
    const invitado = await cliente({ token: token("invitado-4", "anonymous") });
    expect(await pedir(invitado, EVENTOS.validarCompra, { plataforma: "ios", jws })).toMatchObject({ ok: false, error: expect.stringMatching(/Google o Apple/) });
    const nadie = await cliente();
    expect(await pedir(nadie, EVENTOS.validarCompra, { plataforma: "ios", jws })).toMatchObject({ ok: false });
    const s = await cliente({ token: token("pagador-4") });
    expect(await pedir(s, EVENTOS.validarCompra, { plataforma: "pc", jws })).toMatchObject({ ok: false, error: "Compra inválida" });
    expect(await pedir(s, EVENTOS.validarCompra, { plataforma: "ios", jws: "falso" })).toMatchObject({ ok: false });
  });

  it("the refill fills the tickets; the big box holds 10 and keeps recharging", async () => {
    const uid = "pagador-5";
    const s = await cliente({ token: token(uid) });
    for (let i = 0; i < 3; i++) expect(await usarBoleto(uid)).toMatchObject({ ok: true });
    const recarga = await pedir(s, EVENTOS.validarCompra, { plataforma: "ios", jws: `apple:5005:${producto("recarga").tienda}` });
    expect(recarga.cuenta.boletos).toEqual({ cantidad: BOLETOS.max, max: BOLETOS.max, siguienteEnMs: null });

    expect(await usarBoleto(uid)).toMatchObject({ ok: true });
    const caja = await pedir(s, EVENTOS.validarCompra, { plataforma: "ios", jws: `apple:5006:${producto("boletera").tienda}` });
    expect(caja.cuenta).toMatchObject({ boletera: true, boletos: { cantidad: 4, max: BOLETOS.maxGrande } });
    expect(caja.cuenta.boletos.siguienteEnMs).toBeGreaterThan(BOLETOS.recargaMs - 60000);

    // Now a refill fills up to 10
    const otra = await pedir(s, EVENTOS.validarCompra, { plataforma: "ios", jws: `apple:5007:${producto("recarga").tienda}` });
    expect(otra.cuenta.boletos).toEqual({ cantidad: BOLETOS.maxGrande, max: BOLETOS.maxGrande, siguienteEnMs: null });
  });

  it("Android: the server consumes coins and acknowledges the big box with Google", async () => {
    cerradas.length = 0;
    const s = await cliente({ token: token("pagador-6") });
    const r = await pedir(s, EVENTOS.validarCompra, { plataforma: "android", producto: producto("monedas-10000").tienda, token: "tok-6" });
    expect(r).toMatchObject({ ok: true, cuenta: { monedas: 10000 } });
    // Sent again (the app didn't hear back): no more coins, but it tries to close it again
    await pedir(s, EVENTOS.validarCompra, { plataforma: "android", producto: producto("monedas-10000").tienda, token: "tok-6" });
    expect(cerradas).toEqual(["google:tok-6", "google:tok-6"]);
    expect((await pedir(s, EVENTOS.cuenta)).cuenta.monedas).toBe(10000);
  });
});
