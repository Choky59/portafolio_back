import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { io as conectar, Socket } from "socket.io-client";
import { iniciarJuego } from "../src/juego/servidor/socket";
import { ColectorEstado, claveAdminValida, registrarEstadoLocal } from "../src/juego/servidor/estado";
import { RendimientoServidor } from "../src/juego/servidor/rendimiento";
import { EVENTOS, Respuesta } from "../src/juego/compartido/protocolo";
import { login, setupTestApp } from "./helpers";

describe("ColectorEstado", () => {
  test("guarda a lo más `capacidad` muestras, la más nueva al final", () => {
    const rendimiento = new RendimientoServidor();
    const c = new ColectorEstado(
      { salas: () => [], simulada: () => false, sockets: () => 3, ping: () => undefined, rendimiento, tickHz: 60, estadoHz: 30 },
      4,
      0,
    );
    for (let i = 0; i < 10; i++) c.muestrear();
    const { historial, vivo } = c.resumen();
    expect(historial).toHaveLength(4);
    expect(historial.at(-1)!.t).toBeGreaterThanOrEqual(historial[0].t);
    expect(vivo).toMatchObject({ sockets: 3, tickHz: 60, estadoHz: 30, salas: [] });
    expect(historial[0]).toMatchObject({ salas: 0, personas: 0, pingP50: null });
    c.cerrar();
    rendimiento.cerrar();
  });

  test("la clave de admin: nunca sin JUEGO_ADMIN_TOKEN, y solo la misma", () => {
    const antes = process.env.JUEGO_ADMIN_TOKEN;
    delete process.env.JUEGO_ADMIN_TOKEN;
    expect(claveAdminValida("")).toBe(false);
    expect(claveAdminValida("x")).toBe(false);
    process.env.JUEGO_ADMIN_TOKEN = "una-clave-larga";
    expect(claveAdminValida("una-clave-larga")).toBe(true);
    expect(claveAdminValida("otra")).toBe(false);
    expect(claveAdminValida(undefined)).toBe(false);
    if (antes === undefined) delete process.env.JUEGO_ADMIN_TOKEN;
    else process.env.JUEGO_ADMIN_TOKEN = antes;
  });
});

describe("el servidor del juego en el estado", () => {
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

  afterAll((listo) => {
    abiertos.splice(0).forEach((s) => s.disconnect());
    juego.cerrar();
    server.close(() => listo());
  });

  test("lista la sala con el ping que reporta el cliente", async () => {
    const s = conectar(url, { transports: ["websocket"], forceNew: true });
    abiertos.push(s);
    await new Promise<void>((ok) => s.on("connect", () => ok()));
    const r: Respuesta = await new Promise((ok) => s.emit(EVENTOS.crear, { nombre: "Ana", color: "rojo" }, ok));
    expect(r.ok).toBe(true);
    await new Promise((ok) => s.emit(EVENTOS.ping, { rtt: 42.4 }, ok));

    const muestra = juego.estado.muestrear();
    expect(muestra.personas).toBe(1);
    expect(muestra.pingP50).toBe(42);
    const { vivo } = juego.estado.resumen();
    expect(vivo.sockets).toBe(1);
    expect(vivo.salas).toHaveLength(1);
    expect(vivo.salas[0]).toMatchObject({ personas: 1, pings: [{ color: "rojo", ping: 42 }] });
  });
});

describe("GET /api/juego/status", () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>;
  const rendimiento = new RendimientoServidor();
  const colector = new ColectorEstado(
    { salas: () => [], simulada: () => false, sockets: () => 0, ping: () => undefined, rendimiento, tickHz: 60, estadoHz: 30 },
    10,
    0,
  );

  beforeAll(async () => {
    ctx = await setupTestApp();
  }, 180000);

  afterAll(async () => {
    registrarEstadoLocal(null);
    colector.cerrar();
    rendimiento.cerrar();
    delete process.env.JUEGO_STATUS_URL;
    delete process.env.JUEGO_ADMIN_TOKEN;
    await ctx.teardown();
  });

  test("pide sesión", async () => {
    const res = await request(ctx.app).get("/api/juego/status");
    expect(res.status).toBe(401);
  });

  test("sin JUEGO_STATUS_URL: el servidor del juego de este proceso", async () => {
    const token = await login(ctx.app);
    registrarEstadoLocal(null);
    const apagado = await request(ctx.app).get("/api/juego/status").set("session", token);
    expect(apagado.status).toBe(503);

    registrarEstadoLocal(colector);
    colector.muestrear();
    const res = await request(ctx.app).get("/api/juego/status").set("session", token);
    expect(res.status).toBe(200);
    expect(res.body.origen).toBe("local");
    expect(res.body.historial).toHaveLength(1);
    expect(res.body.vivo.tickHz).toBe(60);
  });

  test("con JUEGO_STATUS_URL: le pregunta al de la VM con la clave", async () => {
    const vm = http.createServer((req, res) => {
      const ok = req.url === "/admin/metricas" && req.headers["x-juego-admin"] === "clave-de-prueba";
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(ok ? JSON.stringify({ vivo: { tickHz: 60 }, historial: [] }) : "");
    });
    await new Promise<void>((ok) => vm.listen(0, ok));
    process.env.JUEGO_STATUS_URL = `http://localhost:${(vm.address() as AddressInfo).port}/`;
    const token = await login(ctx.app);
    try {
      process.env.JUEGO_ADMIN_TOKEN = "otra";
      const mal = await request(ctx.app).get("/api/juego/status").set("session", token);
      expect(mal.status).toBe(502);

      process.env.JUEGO_ADMIN_TOKEN = "clave-de-prueba";
      const res = await request(ctx.app).get("/api/juego/status").set("session", token);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ origen: "remoto", vivo: { tickHz: 60 }, historial: [] });
    } finally {
      await new Promise((ok) => vm.close(ok));
    }
  });
});
