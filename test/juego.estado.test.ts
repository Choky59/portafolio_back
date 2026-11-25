import http from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { io as conectar, Socket } from "socket.io-client";
import { iniciarJuego } from "../src/juego/servidor/socket";
import { ColectorEstado, claveAdminValida, diagnosticar, registrarEstadoLocal, resumirJugador, type MuestraJugador } from "../src/juego/servidor/estado";
import { RendimientoServidor } from "../src/juego/servidor/rendimiento";
import { EVENTOS, Respuesta, sanearReporte, type ReporteCliente } from "../src/juego/compartido/protocolo";
import { MongoMemoryServer } from "mongodb-memory-server";
import { cerrarCuentas } from "../src/juego/servidor/cuentas";
import { login, setupTestApp } from "./helpers";

/** Un reporte de cliente sano (60 fps, estados a 30 Hz, ping 40 ms), con lo que se quiera cambiar */
function reporte(cambios: Partial<ReporteCliente> = {}): ReporteCliente {
  return {
    ventanaMs: 2000, fps: 60, cuadroP50: 16.6, cuadroP95: 18, cuadroMax: 25, cuadrosLargos: 0, cuadros: 120,
    nivelCalidad: null, perfil: null, oculto: false,
    estados: 60, huecoP95: 36, huecoMax: 45, atraso: 5, colchonOtros: 60, colchonCamara: 40, deLargo: 0,
    envioP95: 2, confirmacionP95: 50, pendientes: 3,
    rttP50: 40, rttP95: 45, rttP99: 50, correcciones: 0, ultimaCorreccion: 0, errorChoqueP95: 0.1,
    correccionP95: 0.05, correccionMax: 0.1, correccionesDuras: 0, brincosOtros: 0, brincoOtrosMax: 0, eventos: [],
    ...cambios,
  };
}

const muestra = (cliente: ReporteCliente | null, servidor: Partial<MuestraJugador["servidor"]> = {}): MuestraJugador => ({
  t: Date.now(),
  cliente: cliente as MuestraJugador["cliente"],
  servidor: { ventanaMs: 2000, controles: 120, huecoP95: 18, huecoMax: 25, tirados: 0, hambre: 0, colaMax: 2, buffer: 0, ...servidor },
});

describe("sanearReporte", () => {
  test("acota los números, corta los textos y tira lo que no es reporte", () => {
    expect(sanearReporte(null)).toBeNull();
    expect(sanearReporte([1, 2])).toBeNull();
    expect(sanearReporte({ fps: 60 })).toBeNull(); // sin ventana
    const r = sanearReporte({
      ventanaMs: 2000, fps: 1e9, cuadroP95: -5, huecoP95: "mucho", oculto: "si", perfil: "x".repeat(99),
      dispositivo: { plataforma: "windows-phone", celular: true, dpr: 3, ua: "y".repeat(999) },
    })!;
    expect(r.fps).toBe(500);
    expect(r.cuadroP95).toBe(0);
    expect(r.huecoP95).toBe(0);
    expect(r.oculto).toBe(false);
    expect(r.perfil).toHaveLength(16);
    expect(r.dispositivo).toMatchObject({ plataforma: "web", celular: true, nativo: false, dpr: 3 });
    expect(r.dispositivo!.ua).toHaveLength(200);
    expect(r.eventos).toEqual([]);

    const muchos = Array.from({ length: 30 }, (_, i) => ({ tipo: i % 2 ? "otro" : "nada", valor: 3, hueco: 200, hace: 100 }));
    const conEventos = sanearReporte({ ventanaMs: 2000, eventos: muchos })!;
    expect(conEventos.eventos.length).toBeLessThanOrEqual(10);
    expect(conEventos.eventos.every((e) => e.tipo === "otro")).toBe(true);
  });
});

describe("diagnóstico", () => {
  test("un jugador sano no tiene banderas", () => {
    const r = resumirJugador([muestra(reporte()), muestra(reporte())], 30);
    expect(diagnosticar(r, 30, 60)).toEqual([]);
  });

  test("encuentra de qué lado viene el lag", () => {
    const render = resumirJugador([muestra(reporte({ fps: 20, cuadroP95: 70 }))], 30);
    expect(diagnosticar(render, 30, 60)).toEqual([expect.objectContaining({ clave: "render", nivel: "malo" })]);

    const bajada = resumirJugador([muestra(reporte({ estados: 30, huecoP95: 200, huecoMax: 600 }))], 30);
    expect(diagnosticar(bajada, 30, 60).map((b) => b.clave)).toEqual(["bajada"]);

    const subida = resumirJugador([muestra(reporte(), { huecoP95: 120, hambre: 30 })], 30);
    expect(diagnosticar(subida, 30, 60)).toEqual([expect.objectContaining({ clave: "subida", nivel: "malo" })]);

    // Otros carros saltan después de huecos largos: viene de la bajada
    const brincos = resumirJugador(
      [muestra({ ...reporte({ brincosOtros: 4, brincoOtrosMax: 5 }), eventos: [{ tipo: "otro", valor: 5, hueco: 220, hace: 0 }] } as ReporteCliente)],
      30,
    );
    const bandera = diagnosticar(brincos, 30, 60).find((b) => b.clave === "brincos")!;
    expect(bandera.nivel).toBe("malo");
    expect(bandera.texto).toMatch(/bajada/);
    const duras = resumirJugador([muestra(reporte({ correccionesDuras: 1, correccionMax: 12 }))], 30);
    expect(diagnosticar(duras, 30, 60).find((b) => b.clave === "brincos")!.texto).toMatch(/correcciones duras/);

    const viejo = resumirJugador([muestra(null)], 30);
    expect(diagnosticar(viejo, 30, 60).map((b) => b.clave)).toEqual(["sinDatos"]);
  });

  test("el error de choque se resume solo con las ventanas que tienen carros cerca", () => {
    const r = resumirJugador(
      [muestra(reporte({ errorChoqueP95: 0 })), muestra(reporte({ errorChoqueP95: 0 })), muestra(reporte({ errorChoqueP95: 0 })), muestra(reporte({ errorChoqueP95: 3 })), muestra(reporte({ errorChoqueP95: 5 }))],
      30,
    );
    expect(r.errorChoqueP95).toBe(3);
    expect(r.errorChoqueMax).toBe(5);
    expect(resumirJugador([muestra(reporte({ errorChoqueP95: 0 }))], 30).errorChoqueP95).toBe(0);
  });

  test("la clave de admin: nunca sin JUEGO_ADMIN_TOKEN, y solo la misma", () => {
    const antes = process.env.JUEGO_ADMIN_TOKEN;
    delete process.env.JUEGO_ADMIN_TOKEN;
    expect(claveAdminValida("x")).toBe(false);
    process.env.JUEGO_ADMIN_TOKEN = "una-clave-larga";
    expect(claveAdminValida("una-clave-larga")).toBe(true);
    expect(claveAdminValida("otra")).toBe(false);
    expect(claveAdminValida(undefined)).toBe(false);
    if (antes === undefined) delete process.env.JUEGO_ADMIN_TOKEN;
    else process.env.JUEGO_ADMIN_TOKEN = antes;
  });
});

describe("una partida en el servidor del juego", () => {
  let server: http.Server;
  let juego: ReturnType<typeof iniciarJuego>;
  let url: string;
  const abiertos: Socket[] = [];

  let mongo: MongoMemoryServer;
  const antes = { ...process.env };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
    process.env.JUEGO_MONGO_DB = mongo.getUri();
    process.env.JUEGO_MONGO_DB_NAME = "edge_racers_estado";
    await cerrarCuentas();
    server = http.createServer();
    juego = iniciarJuego(server);
    await new Promise<void>((listo) => server.listen(0, () => listo()));
    url = `http://localhost:${(server.address() as AddressInfo).port}/juego`;
  }, 180000);

  afterAll(async () => {
    abiertos.splice(0).forEach((s) => s.disconnect());
    juego.cerrar();
    await new Promise((listo) => server.close(listo));
    await cerrarCuentas();
    await mongo.stop();
    process.env = antes;
  });

  async function cliente(): Promise<Socket> {
    const s = conectar(url, { transports: ["websocket"], forceNew: true });
    abiertos.push(s);
    await new Promise<void>((ok) => s.on("connect", () => ok()));
    return s;
  }
  const pedir = (s: Socket, evento: string, datos: unknown): Promise<Respuesta> => new Promise((ok) => s.emit(evento, datos, ok));
  const siguiente = <T>(s: Socket, evento: string, cumple: (x: T) => boolean) =>
    new Promise<T>((ok) => {
      const f = (x: T) => { if (cumple(x)) { s.off(evento, f); ok(x); } };
      s.on(evento, f);
    });

  test("junta por jugador real lo del cliente y lo del servidor, y al terminar queda en las recientes", async () => {
    const ana = await cliente();
    const r = await pedir(ana, EVENTOS.crear, { nombre: "Ana", color: "rojo" });
    if (!r.ok) throw new Error(r.error);
    const beto = await cliente();
    await pedir(beto, EVENTOS.unirse, { nombre: "Beto", color: "azul", codigo: r.sala.codigo });
    await pedir(beto, EVENTOS.listo, { listo: true });
    const cuenta = siguiente<{ fase: string }>(ana, EVENTOS.partida, (p) => p.fase === "cuenta");
    expect(await pedir(ana, EVENTOS.empezar, {})).toEqual({ ok: true });
    await cuenta;

    // Ana en la compu (sana), Beto en un teléfono que no da los cuadros
    const telefono = { plataforma: "android", nativo: true, celular: true, ligero: true, dpr: 3, ancho: 800, alto: 360, ua: "S10+" };
    for (let i = 0; i < 3; i++) ana.emit(EVENTOS.controles, [i + 1, 0, 255, 0, 0]);
    await pedir(ana, EVENTOS.ping, { reporte: reporte() });
    await pedir(beto, EVENTOS.ping, { reporte: { ...reporte({ fps: 22, cuadroP95: 80 }), dispositivo: telefono } });
    await pedir(ana, EVENTOS.ping, { reporte: reporte() });
    juego.estado.muestrear();

    const { partidas, servidor } = await juego.estado.resumen();
    expect(servidor.tickHz).toBe(60);
    expect(partidas).toHaveLength(1);
    const p = partidas[0];
    expect(p).toMatchObject({ codigo: r.sala.codigo, fin: null, fase: "cuenta" });
    const porNombre = Object.fromEntries(p.jugadores.map((j) => [j.nombre, j]));
    expect(porNombre.Ana.banderas).toEqual([]);
    expect(porNombre.Beto.dispositivo).toMatchObject({ plataforma: "android", celular: true });
    expect(porNombre.Beto.banderas.map((b) => b.clave)).toContain("render");

    const detalle = (await juego.estado.partida(p.id))!;
    const anaDetalle = detalle.jugadores.find((j) => j.nombre === "Ana")!;
    expect(anaDetalle.muestras).toHaveLength(2);
    // Los controles de Ana llegaron en el primer ping; el contador se reinicia en cada uno
    expect(anaDetalle.muestras[0].servidor.controles).toBe(3);
    expect(anaDetalle.muestras[1].servidor.controles).toBe(0);
    expect(detalle.servidor.muestras.length).toBeGreaterThan(0);
    expect(await juego.estado.partida("HMO-0000-nada")).toBeNull();

    // Beto se va: ya no hay con quién jugar, la sala vuelve a la espera y la partida termina
    beto.disconnect();
    await new Promise((ok) => setTimeout(ok, 100));
    juego.estado.muestrear();
    const despues = (await juego.estado.resumen()).partidas;
    expect(despues).toHaveLength(1);
    expect(despues[0].id).toBe(p.id);
    expect(despues[0].fin).not.toBeNull();

    // Se guardó en la base: un colector nuevo (el servidor se reinició) la sigue teniendo, completa
    const rendimiento = new RendimientoServidor();
    const nuevo = new ColectorEstado({ salas: () => [], simulada: () => false, sockets: () => 0, rendimiento, tickHz: 60, estadoHz: 30 }, 20, 0);
    let guardada: Awaited<ReturnType<ColectorEstado["partida"]>> = null;
    for (let i = 0; i < 40 && !guardada; i++) {
      guardada = await nuevo.partida(p.id);
      if (!guardada) await new Promise((ok) => setTimeout(ok, 50));
    }
    expect(guardada).toMatchObject({ id: p.id, guardada: true, config: { tickHz: 60, estadoHz: 30 } });
    const jugadoresGuardados = (guardada as unknown as { jugadores: { nombre: string; muestras: unknown[] }[] }).jugadores;
    expect(jugadoresGuardados.find((j) => j.nombre === "Ana")!.muestras).toHaveLength(2);
    const lista = (await nuevo.resumen()).partidas;
    expect(lista.map((x) => x.id)).toContain(p.id);
    nuevo.cerrar();
    rendimiento.cerrar();
  });
});

describe("GET /api/juego/status", () => {
  let ctx: Awaited<ReturnType<typeof setupTestApp>>;
  const rendimiento = new RendimientoServidor();
  const colector = new ColectorEstado(
    { salas: () => [], simulada: () => false, sockets: () => 0, rendimiento, tickHz: 60, estadoHz: 30 },
    20,
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
    expect((await request(ctx.app).get("/api/juego/status")).status).toBe(401);
    expect((await request(ctx.app).get("/api/juego/status/partidas/HMO-1234-x")).status).toBe(401);
  });

  test("sin JUEGO_STATUS_URL: el servidor del juego de este proceso", async () => {
    const token = await login(ctx.app);
    registrarEstadoLocal(null);
    expect((await request(ctx.app).get("/api/juego/status").set("session", token)).status).toBe(503);

    registrarEstadoLocal(colector);
    const res = await request(ctx.app).get("/api/juego/status").set("session", token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ origen: "local", partidas: [], servidor: { tickHz: 60 } });
    expect((await request(ctx.app).get("/api/juego/status/partidas/HMO-1234-x").set("session", token)).status).toBe(404);
    expect((await request(ctx.app).get("/api/juego/status/partidas/no%20vale").set("session", token)).status).toBe(400);
  });

  test("con JUEGO_STATUS_URL: le pregunta al de la VM con la clave", async () => {
    const vm = http.createServer((req, res) => {
      const clave = req.headers["x-juego-admin"] === "clave-de-prueba";
      const datos =
        !clave ? null
        : req.url === "/admin/metricas" ? { servidor: { tickHz: 60 }, partidas: [] }
        : req.url === "/admin/metricas/partidas/HMO-1234-x" ? { id: "HMO-1234-x", jugadores: [] }
        : null;
      res.writeHead(datos ? 200 : 404, { "Content-Type": "application/json" });
      res.end(datos ? JSON.stringify(datos) : "");
    });
    await new Promise<void>((ok) => vm.listen(0, ok));
    process.env.JUEGO_STATUS_URL = `http://localhost:${(vm.address() as AddressInfo).port}/`;
    const token = await login(ctx.app);
    try {
      process.env.JUEGO_ADMIN_TOKEN = "otra";
      expect((await request(ctx.app).get("/api/juego/status").set("session", token)).status).toBe(502);

      process.env.JUEGO_ADMIN_TOKEN = "clave-de-prueba";
      const res = await request(ctx.app).get("/api/juego/status").set("session", token);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ origen: "remoto", servidor: { tickHz: 60 }, partidas: [] });
      const detalle = await request(ctx.app).get("/api/juego/status/partidas/HMO-1234-x").set("session", token);
      expect(detalle.status).toBe(200);
      expect(detalle.body).toMatchObject({ origen: "remoto", id: "HMO-1234-x" });
      expect((await request(ctx.app).get("/api/juego/status/partidas/HMO-9999-x").set("session", token)).status).toBe(404);
    } finally {
      await new Promise((ok) => vm.close(ok));
    }
  });
});
