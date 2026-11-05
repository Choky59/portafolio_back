import http from "http";
import type { AddressInfo } from "net";
import { readFileSync } from "fs";
import path from "path";
import { io, type Socket } from "socket.io-client";
import { CadenciaEstado, EmisorEscenario, ReceptorEscenario, estadoEscenario, colchonRed, type EstadoEscenarioRed } from "../src/juego/compartido/red";
import { EVENTOS, desempacarCarro, empacarCarro, empacarControles, sanearControles, type Instantanea, type Respuesta } from "../src/juego/compartido/protocolo";
import { prepararPista } from "../src/juego/compartido/pista";
import { restaurarEscenario } from "../src/juego/compartido/escenario";
import { avanzarCarro, copiarCarro, crearCarro, PARAMETROS_FISICA } from "../src/juego/compartido/fisica";
import type { Circuito } from "../src/juego/compartido/tipos";
import { iniciarJuego } from "../src/juego/servidor/socket";

const circuito = (id = "obra-negra"): Circuito => JSON.parse(readFileSync(path.join(__dirname, "../content/juego/circuitos", `${id}.json`), "utf8"));
const ctrl = { seq: 120, giro: 0.5, acel: 1, freno: 0, mano: false, item: false };

describe("controles compactos", () => {
  test("reduce el ejemplo de 67 a 16 bytes y conserva botones y extremos exactos", () => {
    expect(Buffer.byteLength(JSON.stringify(ctrl))).toBe(67);
    expect(Buffer.byteLength(JSON.stringify(empacarControles(ctrl)))).toBe(16);
    for (const giro of [-1, 0, 1]) for (const mano of [false, true]) for (const item of [false, true]) {
      const datos = { ...ctrl, giro, mano, item };
      expect(sanearControles(empacarControles(datos))).toEqual(datos);
    }
  });
  test("cuantiza los mandos analógicos con un error pequeño y acotado", () => {
    for (let i = 0; i <= 100; i++) {
      const datos = { ...ctrl, giro: i / 50 - 1, acel: i / 100, freno: 1 - i / 100 };
      const recibido = sanearControles(empacarControles(datos))!;
      expect(Math.abs(recibido.giro - datos.giro)).toBeLessThanOrEqual(1 / 254 + 1e-10);
      expect(Math.abs(recibido.acel - datos.acel)).toBeLessThanOrEqual(1 / 510 + 1e-10);
      expect(Math.abs(recibido.freno - datos.freno)).toBeLessThanOrEqual(1 / 510 + 1e-10);
    }
  });
  test.each([[1], [1, 0, 255, 0, 0, 0], [-1, 0, 0, 0, 0], [1, 128, 0, 0, 0], [1, 0, 256, 0, 0], [1, 0, 0, -1, 0], [1, 0, 0, 0, 4], [1, 0.5, 0, 0, 0], [NaN, 0, 0, 0, 0], [Infinity, 0, 0, 0, 0]])("rechaza el paquete inválido %j", (...datos) => {
    expect(sanearControles(datos)).toBeNull();
  });
  test("sigue aceptando clientes con el objeto JSON anterior", () => {
    expect(sanearControles(ctrl)).toEqual(ctrl);
  });
});

describe("carros en la instantánea", () => {
  test("la recuperación de un choque viaja (el teléfono la predice igual) y una instantánea vieja la deja en 0", () => {
    const c = { ...crearCarro(prepararPista(circuito()), 0), empujon: 0.4, recobro: 0.55 };
    const r = empacarCarro("a", c, 7, true, -1);
    expect(desempacarCarro(r).estado).toMatchObject({ empujon: 0.4, recobro: 0.55 });
    expect(desempacarCarro(r.slice(0, 31) as typeof r).estado.recobro).toBe(0);
  });
});

describe("cadencia de publicaciones", () => {
  test("60 pasos físicos publican 30 estados sin agrupar controles", () => {
    const cadencia = new CadenciaEstado(30);
    let estados = 0;
    for (let tick = 1; tick <= 60; tick++) if (cadencia.toca(tick * 1000 / 60)) estados++;
    expect(estados).toBe(30);
  });
  test("una pausa no genera una ráfaga de estados viejos", () => {
    const cadencia = new CadenciaEstado(30);
    expect(cadencia.toca(1000)).toBe(true);
    expect(cadencia.toca(1000)).toBe(false);
    expect(cadencia.toca(1001)).toBe(false);
    expect(cadencia.toca(1034)).toBe(true);
  });
  test("la interpolación cubre el intervalo de red de 30 Hz aunque la física siga a 60", () => {
    const ajuste = { min: 0.025, max: 0.25, margen: 0.25 };
    const a60 = colchonRed(ajuste, 1 / 60, 1, 0);
    const a30 = colchonRed(ajuste, 1 / 60, 2, 0);
    expect(a30).toBeGreaterThan(a60);
    expect(a30 / 60).toBeGreaterThan(1 / 30);
    expect(colchonRed(ajuste, 1 / 60, 2, 100) / 60).toBeLessThanOrEqual(ajuste.max);
  });
});

describe("estado fiable de objetos", () => {
  test("publica una posición final una sola vez, aunque se omitan todos los estados rápidos", () => {
    const pista = prepararPista(circuito());
    const emisor = new EmisorEscenario(), receptor = new ReceptorEscenario();
    receptor.recibir(emisor.preparar(pista, 0).cambio!);
    const objeto = [...pista.escenario.moviles.values()][0];
    objeto.x += 3; objeto.vx = 4; objeto.tumbado = true;
    expect(emisor.preparar(pista, 2).activos).toHaveLength(1);
    objeto.vx = 0;
    const final = emisor.preparar(pista, 4);
    expect(final.activos).toEqual([]);
    expect(final.cambio?.o).toHaveLength(1);
    receptor.recibir(final.cambio!);
    expect(receptor.estado(pista.circuito.id)![0][1]).toBeCloseTo(objeto.x, 2);
    for (let k = 6; k < 120; k += 2) {
      const estado = emisor.preparar(pista, k);
      expect(estado.activos).toEqual([]);
      expect(estado.cambio).toBeNull();
    }
    const nuevo = new ReceptorEscenario();
    nuevo.recibir(estadoEscenario(pista, 120));
    expect(nuevo.estado(pista.circuito.id)).toEqual(receptor.estado(pista.circuito.id));
    restaurarEscenario(pista);
    receptor.recibir(emisor.preparar(pista, 122).cambio!);
    expect(receptor.estado(pista.circuito.id)).toEqual([]);
  });
  test("la predicción no puede modificar la referencia del servidor y se ignoran estados viejos", () => {
    const receptor = new ReceptorEscenario();
    const o: EstadoEscenarioRed["o"][number] = ["barril:0", 10, 20, 0, 0, 0, 0, true];
    receptor.recibir({ k: 10, circuito: "obra-negra", completo: true, o: [o] });
    receptor.estado("obra-negra")![0][1] = 999;
    o[1] = 999;
    receptor.activos(8, [["barril:0", 99, 20, 0, 1, 0, 0, true]]);
    expect(receptor.estado("obra-negra")![0][1]).toBe(10);
    expect(receptor.recibir({ k: 9, circuito: "obra-negra", completo: true, o: [] })).toBe(false);
    expect(receptor.estado("gruas")).toBeNull();
  });
});

describe("sockets con protocolo ligero y legado", () => {
  let server: http.Server;
  let juego: ReturnType<typeof iniciarJuego>;
  let url: string;
  const sockets: Socket[] = [];
  const configuracion = { tick: process.env.JUEGO_TICK_HZ, estado: process.env.JUEGO_ESTADO_HZ };
  beforeAll(done => {
    process.env.JUEGO_TICK_HZ = "60";
    process.env.JUEGO_ESTADO_HZ = "30";
    server = http.createServer(); juego = iniciarJuego(server);
    server.listen(0, () => { url = `http://localhost:${(server.address() as AddressInfo).port}/juego`; done(); });
  });
  afterEach(() => sockets.splice(0).forEach(s => s.disconnect()));
  afterAll(done => {
    if (configuracion.tick === undefined) delete process.env.JUEGO_TICK_HZ; else process.env.JUEGO_TICK_HZ = configuracion.tick;
    if (configuracion.estado === undefined) delete process.env.JUEGO_ESTADO_HZ; else process.env.JUEGO_ESTADO_HZ = configuracion.estado;
    juego.cerrar(); server.close(() => done());
  });
  const esperar = (ms: number) => new Promise(ok => setTimeout(ok, ms));
  async function cliente() {
    const s = io(url, { transports: ["websocket"], forceNew: true }); sockets.push(s);
    await new Promise<void>(ok => s.once("connect", ok)); return s;
  }
  function pedir(s: Socket, evento: string, datos: unknown): Promise<Respuesta> {
    return new Promise(ok => s.emit(evento, datos, ok));
  }
  function siguiente<T>(s: Socket, evento: string, cumple: (dato: T) => boolean): Promise<T> {
    return new Promise((ok, mal) => {
      const timeout = setTimeout(() => { s.off(evento, leer); mal(new Error(`No llegó ${evento}`)); }, 4000);
      function leer(dato: T) { if (!cumple(dato)) return; clearTimeout(timeout); s.off(evento, leer); ok(dato); }
      s.on(evento, leer);
    });
  }
  test("el servidor aplica el control cuantizado exactamente como la predicción", async () => {
    const s = await cliente();
    const r = await pedir(s, EVENTOS.crear, { nombre: "Ana", color: "rojo", protocolo: 2 });
    if (!r.ok) throw new Error(r.error);
    expect(r.sala.estadoHz).toBe(30);
    expect(r.sala.tickHz).toBe(60);
    const sala = juego.gestor.buscar(r.sala.codigo)!;
    const predicho = copiarCarro(sala.jugadores.get(s.id!)!.carro);
    const listo = siguiente<Instantanea>(s, EVENTOS.estado, inst => inst.c.some(c => c[0] === s.id && c[10] === 12));
    for (let seq = 1; seq <= 12; seq++) {
      const paquete = empacarControles({ ...ctrl, seq });
      avanzarCarro(predicho, sanearControles(paquete)!, PARAMETROS_FISICA, sala.pista, 1 / 60);
      s.emit(EVENTOS.controles, paquete);
    }
    const inst = await listo;
    expect(inst.od).toBe(true);
    expect(sala.jugadores.get(s.id!)!.carro).toEqual(predicho);
  });
  test("el ping normal sigue vacío y el diagnóstico incluye tiempo de tick y colas", async () => {
    const s = await cliente();
    await pedir(s, EVENTOS.crear, { nombre: "Ana", color: "rojo", protocolo: 2 });
    const normal = await new Promise<unknown[]>(ok => s.emit(EVENTOS.ping, (...args: unknown[]) => ok(args)));
    expect(normal).toEqual([]);
    const detalle = await new Promise<{ servidor: { bucleP95: number; cola: number; pendientes: number; tick: { p95: number } } }>(ok => s.emit(EVENTOS.ping, { metricas: true }, ok));
    expect(Number.isFinite(detalle.servidor.bucleP95)).toBe(true);
    expect(detalle.servidor.cola).toBeGreaterThanOrEqual(0);
    expect(detalle.servidor.pendientes).toBeGreaterThanOrEqual(0);
    expect(detalle.servidor.tick.p95).toBeGreaterThanOrEqual(0);
  });
  test("no repite objetos quietos, recupera sus posiciones al entrar y admite clientes antiguos", async () => {
    const s = await cliente();
    const r = await pedir(s, EVENTOS.crear, { nombre: "Ana", color: "rojo", circuito: "obra-negra", protocolo: 2 });
    if (!r.ok) throw new Error(r.error);
    const sala = juego.gestor.buscar(r.sala.codigo)!;
    const objeto = [...sala.pista.escenario.moviles.values()][0];
    const receptor = new ReceptorEscenario(); receptor.recibir(r.obra!);
    const actualizacion = siguiente<EstadoEscenarioRed>(s, EVENTOS.escenario, e => e.o.some(o => o[0] === objeto.id));
    objeto.x += 3; objeto.tumbado = true;
    receptor.recibir(await actualizacion);
    const recibidas: Instantanea[] = [];
    s.on(EVENTOS.estado, inst => recibidas.push(inst));
    await esperar(220);
    expect(recibidas.length).toBeGreaterThanOrEqual(3);
    expect(recibidas.length).toBeLessThanOrEqual(10);
    expect(recibidas.every(inst => inst.od && !inst.o?.some(o => o[0] === objeto.id))).toBe(true);
    const nuevo = await cliente();
    const entrada = await pedir(nuevo, EVENTOS.unirse, { codigo: r.sala.codigo, nombre: "Beto", color: "azul", protocolo: 2 });
    if (!entrada.ok) throw new Error(entrada.error);
    expect(entrada.obra?.o).toEqual(receptor.estado("obra-negra"));
    const legado = await cliente();
    await pedir(legado, EVENTOS.unirse, { codigo: r.sala.codigo, nombre: "Caro", color: "verde" });
    const foto = await siguiente<Instantanea>(legado, EVENTOS.estado, inst => !!inst.o?.some(o => o[0] === objeto.id));
    expect(foto.od).toBeUndefined();
    const reset = siguiente<EstadoEscenarioRed>(s, EVENTOS.escenario, e => e.completo && !e.o.length);
    restaurarEscenario(sala.pista);
    receptor.recibir(await reset);
    expect(receptor.estado("obra-negra")).toEqual([]);
  });
});
