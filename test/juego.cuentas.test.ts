import http from "http";
import { AddressInfo } from "net";
import { io as conectar, Socket } from "socket.io-client";
import { iniciarJuego } from "../src/juego/servidor/socket";
import { verificarToken } from "../src/juego/servidor/cuentas";
import { EVENTOS, puedeUsar } from "../src/juego/compartido/protocolo";

// Firebase project for the tests, and emulator-style tokens (unsigned): no network, no database
const PROYECTO = "edge-racers-pruebas";
const antes = { ...process.env };
beforeAll(() => {
  process.env.JUEGO_FIREBASE_PROYECTO = PROYECTO;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
  delete process.env.JUEGO_MONGO_DB;
  delete process.env.MONGO_DB;
  delete process.env.JUEGO_VEHICULOS_DESBLOQUEADOS;
});
afterAll(() => {
  process.env = antes;
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A token like the Firebase emulator's: header.payload. with no signature */
function token(uid: string, proveedor = "anonymous", aud = PROYECTO) {
  const ahora = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: `https://securetoken.google.com/${aud}`,
    aud,
    sub: uid,
    iat: ahora,
    exp: ahora + 3600,
    firebase: { sign_in_provider: proveedor },
  })}.`;
}

describe("verificarToken", () => {
  it("knows guests from Google/Apple accounts", async () => {
    expect(await verificarToken(token("inv-1"))).toEqual({ uid: "inv-1", invitado: true });
    expect(await verificarToken(token("g-1", "google.com"))).toEqual({ uid: "g-1", invitado: false });
    expect(await verificarToken(token("a-1", "apple.com"))).toEqual({ uid: "a-1", invitado: false });
  });

  it("rejects other projects' tokens and garbage", async () => {
    expect(await verificarToken(token("x", "google.com", "otro-proyecto"))).toBeNull();
    expect(await verificarToken("no-es-un-token")).toBeNull();
    expect(await verificarToken(undefined)).toBeNull();
  });
});

describe("puedeUsar", () => {
  it("the default vehicle always; the others with their package", () => {
    expect(puedeUsar("clasico", [])).toBe(true);
    expect(puedeUsar("grua", [])).toBe(false);
    expect(puedeUsar("grua", ["chamba"])).toBe(true);
    expect(puedeUsar("grua", ["calle"])).toBe(false);
  });
});

describe("accounts over the connection", () => {
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
    delete process.env.JUEGO_VEHICULOS_DESBLOQUEADOS;
  });
  afterAll((listo) => {
    juego.cerrar();
    server.close(() => listo());
  });

  function cliente(auth?: object): Promise<Socket> {
    const s = conectar(url, { transports: ["websocket"], forceNew: true, auth });
    abiertos.push(s);
    return new Promise((ok) => s.on("connect", () => ok(s)));
  }
  const pedir = (s: Socket, evento: string, datos: unknown = {}): Promise<any> => new Promise((ok) => s.emit(evento, datos, ok));

  it("tells the client which account it connected with", async () => {
    const conCuenta = await cliente({ token: token("inv-7") });
    expect(await pedir(conCuenta, EVENTOS.cuenta)).toEqual({ ok: true, cuenta: { uid: "inv-7", invitado: true, paquetes: [] } });
    const sinCuenta = await cliente();
    expect(await pedir(sinCuenta, EVENTOS.cuenta)).toEqual({ ok: true, cuenta: null });
  });

  it("a vehicle the account doesn't have becomes the default one", async () => {
    const s = await cliente({ token: token("g-2", "google.com") });
    const r = await pedir(s, EVENTOS.crear, { nombre: "Ana", color: "rojo", vehiculo: "grua" });
    expect(r.ok).toBe(true);
    expect(r.sala.jugadores[0]).not.toHaveProperty("vehiculo");
  });

  it("everybody can use every vehicle with JUEGO_VEHICULOS_DESBLOQUEADOS (testing)", async () => {
    process.env.JUEGO_VEHICULOS_DESBLOQUEADOS = "true";
    const s = await cliente();
    const r = await pedir(s, EVENTOS.crear, { nombre: "Ana", color: "rojo", vehiculo: "grua" });
    expect(r.sala.jugadores[0]).toMatchObject({ vehiculo: "grua" });
  });

  it("only deletes an account it can verify", async () => {
    expect(await pedir(await cliente(), EVENTOS.borrarCuenta)).toMatchObject({ ok: false });
    expect(await pedir(await cliente({ token: token("inv-9") }), EVENTOS.borrarCuenta)).toEqual({ ok: true });
  });
});
