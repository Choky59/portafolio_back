import http from "http";
import { AddressInfo } from "net";
import { MongoMemoryServer } from "mongodb-memory-server";
import { io as conectar, Socket } from "socket.io-client";
import { EVENTOS, type SalaDeAmigo } from "../src/juego/compartido/protocolo";
import { cerrarCuentas, cuentas } from "../src/juego/servidor/cuentas";
import { guardarToken, mandarInvitacion, mensajeInvitacion, quitarToken, sanearToken, usarEnvioDePrueba, MAX_TOKENS } from "../src/juego/servidor/push";
import { iniciarJuego } from "../src/juego/servidor/socket";

const TOKEN = (n: number | string) => `token-de-prueba-${n}-${"x".repeat(30)}`;
const SALA: SalaDeAmigo = { codigo: "HMO-1234", circuito: "hermosillo", jugadores: 2, privada: true, abierta: true, enPartida: false };

describe("push tokens and messages (pure)", () => {
  it("a token is a long string without spaces; the platform and the language default to android / es", () => {
    expect(sanearToken({ token: "corto" })).toMatchObject({ error: expect.any(String) });
    expect(sanearToken({ token: `${TOKEN(1)} con espacio` })).toMatchObject({ error: expect.any(String) });
    expect(sanearToken({ token: TOKEN(1) })).toEqual({ token: TOKEN(1), plataforma: "android", idioma: "es" });
    expect(sanearToken({ token: TOKEN(1), plataforma: "ios", idioma: "en" })).toEqual({ token: TOKEN(1), plataforma: "ios", idioma: "en" });
  });

  it("the invitation speaks the phone's language and carries the room for the app", () => {
    const de = { codigo: "111111", nombre: "Beto" };
    const es = mensajeInvitacion({ token: TOKEN(1), idioma: "es" }, de, SALA, "Hermosillo").message;
    expect(es.notification).toEqual({ title: "¡Te invitan a correr!", body: "Beto te invita a su sala en Hermosillo" });
    expect(JSON.parse(es.data.sala)).toEqual(SALA);
    expect(JSON.parse(es.data.de)).toEqual(de);
    expect(es.data.tipo).toBe("invitacion");
    expect(es.android).toMatchObject({ priority: "HIGH", notification: { channel_id: "invitaciones" } });
    const en = mensajeInvitacion({ token: TOKEN(1), idioma: "en" }, de, SALA, "Hermosillo").message;
    expect(en.notification).toEqual({ title: "You're invited to race!", body: "Beto invites you to their room on Hermosillo" });
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

describe("push notifications", () => {
  let mongo: MongoMemoryServer;
  let server: http.Server;
  let juego: ReturnType<typeof iniciarJuego>;
  let url: string;
  const abiertos: Socket[] = [];
  const antes = { ...process.env };
  /** Lo que se "mandó" a Firebase */
  let enviados: { url: string; cuerpo: { message: { token: string; notification: { body: string }; data: Record<string, string> } } }[] = [];
  /** Lo que contesta el Firebase de mentiras a cada token */
  let respuesta: (token: string) => { status: number; error?: string } = () => ({ status: 200 });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
    process.env.JUEGO_MONGO_DB = mongo.getUri();
    process.env.JUEGO_MONGO_DB_NAME = "edge_racers_push";
    process.env.JUEGO_FIREBASE_PROYECTO = PROYECTO;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
    await cerrarCuentas();
    server = http.createServer();
    juego = iniciarJuego(server);
    await new Promise<void>((listo) => server.listen(0, () => listo()));
    url = `http://localhost:${(server.address() as AddressInfo).port}/juego`;
  }, 180000);
  beforeEach(() => {
    enviados = [];
    respuesta = () => ({ status: 200 });
    usarEnvioDePrueba(async (u, cuerpo) => {
      const c = cuerpo as (typeof enviados)[number]["cuerpo"];
      enviados.push({ url: u, cuerpo: c });
      return respuesta(c.message.token);
    });
  });
  afterEach(() => abiertos.splice(0).forEach((s) => s.disconnect()));
  afterAll(async () => {
    usarEnvioDePrueba(null);
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
  const tokensDe = async (uid: string) => ((await (await cuentas())!.findOne({ _id: uid }))?.pushTokens ?? []).map((t) => t.token);

  it("each account keeps its latest phones; a phone belongs to one account", async () => {
    const col = (await cuentas())!;
    await col.insertMany([
      { _id: "push-ana", paquetes: [], creada: new Date() },
      { _id: "push-beto", paquetes: [], creada: new Date() },
    ]);
    for (let i = 0; i < MAX_TOKENS + 2; i++) expect(await guardarToken("push-ana", { token: TOKEN(i) })).toEqual({ ok: true });
    expect(await tokensDe("push-ana")).toEqual(Array.from({ length: MAX_TOKENS }, (_, i) => TOKEN(i + 2)));
    // The same one again goes to the end (the most recent), no duplicates
    await guardarToken("push-ana", { token: TOKEN(3) });
    expect((await tokensDe("push-ana")).filter((t) => t === TOKEN(3))).toHaveLength(1);
    expect((await tokensDe("push-ana")).at(-1)).toBe(TOKEN(3));
    // Beto signs in on that phone: it stops being Ana's
    await guardarToken("push-beto", { token: TOKEN(3), idioma: "en" });
    expect(await tokensDe("push-ana")).not.toContain(TOKEN(3));
    expect(await tokensDe("push-beto")).toEqual([TOKEN(3)]);
    await quitarToken("push-beto", TOKEN(3));
    expect(await tokensDe("push-beto")).toEqual([]);
  });

  it("an invitation goes to every phone of the friend; a phone Firebase forgot is deleted", async () => {
    const col = (await cuentas())!;
    await col.insertOne({ _id: "push-caro", paquetes: [], creada: new Date() });
    await guardarToken("push-caro", { token: TOKEN("caro-1") });
    await guardarToken("push-caro", { token: TOKEN("caro-2"), idioma: "en" });
    respuesta = (t) => (t === TOKEN("caro-1") ? { status: 404, error: "UNREGISTERED" } : { status: 200 });
    expect(await mandarInvitacion("push-caro", { codigo: "111111", nombre: "Beto" }, SALA, "Hermosillo")).toBe(1);
    expect(enviados).toHaveLength(2);
    expect(enviados[0].url).toBe(`https://fcm.googleapis.com/v1/projects/${PROYECTO}/messages:send`);
    expect(enviados.find((e) => e.cuerpo.message.token === TOKEN("caro-2"))?.cuerpo.message.notification.body).toBe("Beto invites you to their room on Hermosillo");
    expect(await tokensDe("push-caro")).toEqual([TOKEN("caro-2")]);
  });

  it("the host invites a friend who closed the game: only the notification reaches them, once every 30 s", async () => {
    const dani = await cliente({ token: token("push-dani") });
    const eli = await cliente({ token: token("push-eli") });
    const ld = await pedir(dani, EVENTOS.amigos, { nombre: "Dani" });
    const le = await pedir(eli, EVENTOS.amigos, { nombre: "Eli" });
    expect(await pedir(eli, EVENTOS.pushToken, { token: TOKEN("eli"), plataforma: "android", idioma: "es" })).toEqual({ ok: true });
    // Friends (straight in the database)
    const col = (await cuentas())!;
    await col.updateOne({ _id: "push-dani" }, { $set: { amigos: ["push-eli"] } });
    await col.updateOne({ _id: "push-eli" }, { $set: { amigos: ["push-dani"] } });
    // Eli closes the game
    eli.disconnect();
    await esperar(100);
    const r = await pedir(dani, EVENTOS.crear, { nombre: "Dani", color: "rojo", multi: true, privada: true, circuito: "hermosillo" });
    expect(r.ok).toBe(true);
    expect(await pedir(dani, EVENTOS.amigoInvitar, { codigos: [le.lista.codigo] })).toEqual({ ok: true, invitados: 1 });
    await esperar(100);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].cuerpo.message).toMatchObject({ token: TOKEN("eli"), notification: { body: expect.stringMatching(/^Dani te invita a su sala/) } });
    expect(JSON.parse(enviados[0].cuerpo.message.data.sala)).toMatchObject({ codigo: r.sala.codigo });
    // Again right away: no second notification
    expect(await pedir(dani, EVENTOS.amigoInvitar, { codigos: [le.lista.codigo] })).toEqual({ ok: true, invitados: 1 });
    await esperar(100);
    expect(enviados).toHaveLength(1);
    expect(ld.ok).toBe(true);
  });

  it("signing out removes the phone", async () => {
    const fer = await cliente({ token: token("push-fer") });
    await pedir(fer, EVENTOS.amigos, { nombre: "Fer" });
    await pedir(fer, EVENTOS.pushToken, { token: TOKEN("fer") });
    expect(await tokensDe("push-fer")).toEqual([TOKEN("fer")]);
    expect(await pedir(fer, EVENTOS.pushQuitar, { token: TOKEN("fer") })).toEqual({ ok: true });
    expect(await tokensDe("push-fer")).toEqual([]);
  });
});
