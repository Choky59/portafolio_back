import { createHash, timingSafeEqual } from "node:crypto";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import type { Collection } from "mongodb";
import type { DispositivoCliente, EventoBrinco, ReporteCliente } from "../compartido/protocolo";
import { baseJuego } from "./cuentas";
import type { RendimientoServidor, Tiron, TironVecino, VentanaGc } from "./rendimiento";
import { contadoresRed, type Sala } from "./salas";

/**
 * EL ESTADO POR PARTIDA para la página de admin (/admin/status del portafolio): sirve para saber
 * por qué un jugador ve lag y otro no en la misma partida.
 *
 * - Una PARTIDA es una sala que simula el servidor desde que sale de la espera hasta que vuelve a
 *   ella (o se cierra).
 * - Por JUGADOR REAL (sin bots), una muestra en cada ping (~2 s). Junta lo que reporta su cliente
 *   (render, bajada, subida, predicción: ReporteCliente) con lo que el servidor ve de él: cómo le
 *   llegan los controles, los ticks sin control (hambre) y lo que se le acumula en el socket.
 * - Por partida, cada `cadaMs` (5 s), lo del servidor: su tick, la CPU y el event loop, para
 *   descartar que el servidor sea la causa.
 *
 * En memoria: las partidas en curso y las últimas `maxTerminadas`. Al terminar, cada partida se
 * guarda completa en la base del juego (juego_partidas_rendimiento, 30 días) para verla y bajarla
 * como JSON aunque el servidor se reinicie. Lleva nombres porque solo lo ve un admin.
 */

/** Lo que el colector necesita del servidor del juego (socket.ts) */
export interface FuenteEstado {
  salas(): Sala[];
  /** La sala la simula el servidor (tiene reloj): las locales corren en el navegador */
  simulada(codigo: string): boolean;
  sockets(): number;
  /** Canales rápidos (WebRTC) abiertos */
  canales?(): number;
  rendimiento: RendimientoServidor;
  tickHz: number;
  estadoHz: number;
}

/** Lo que el servidor ve de un jugador entre dos pings */
export interface LadoServidor {
  ventanaMs: number;
  controles: number;
  huecoP95: number;
  huecoMax: number;
  tirados: number;
  /** Ticks quieto: sin ningún control, ni real ni repetido */
  hambre: number;
  /** Ticks cubiertos repitiendo su último control, y controles reales que llegaron tarde a ellos */
  inventados?: number;
  cubiertos?: number;
  /** Controles que nunca llegaron (huecos en los `seq`) */
  perdidos?: number;
  colaMax: number;
  /** Paquetes esperando salir por su socket */
  buffer: number;
}

/** Un brinco con la hora en que pasó (ms, reloj del servidor) */
export type EventoConHora = Omit<EventoBrinco, "hace"> & { t: number };

export interface MuestraJugador {
  t: number;
  /** null: un cliente viejo, que no manda reporte */
  cliente: (Omit<ReporteCliente, "dispositivo" | "eventos"> & { eventos?: EventoConHora[] }) | null;
  servidor: LadoServidor;
}

/** Cuánto había en todo el servidor (todas las salas, no solo esta) */
export interface CargaServidor {
  salas: number;
  /** Salas con partida simulada por el servidor */
  jugando: number;
  humanos: number;
  bots: number;
  sockets: number;
  canales: number;
}

export interface MemoriaServidor {
  rssMb: number;
  heapMb: number;
  heapLimiteMb: number;
  externoMb: number;
}

/** Lo que gastó esta sala en la ventana (rendimiento.ts CostoSala, ya en ms y %) */
export interface CostoMuestra {
  cpuMs: { tick: number; controles: number; estado: number; avisos: number };
  /** De un núcleo: lo que esta sala le quitó a todas las demás */
  cpuPct: number;
  ticks: number;
  estados: number;
  /** Tamaño típico de un estado y lo que salió por segundo (por destino) */
  bytesEstado: number;
  kbPorS: number;
  continuaciones: number;
  pendientesMax: number;
  canalBufferMax: number;
}

export interface MuestraServidor {
  t: number;
  tickP50: number;
  tickP95: number;
  tickMax: number;
  pendientes: number;
  /** % de un núcleo de TODO el proceso */
  cpu: number;
  bucleP50?: number;
  bucleP95: number;
  bucleMax: number;
  // Desde la versión con la salud del servidor (las partidas guardadas antes no los traen)
  carga?: CargaServidor;
  memoria?: MemoriaServidor;
  gc?: VentanaGc;
  sala?: CostoMuestra;
}

/** Cómo estaba el servidor al empezar la partida */
export interface ServidorInicio {
  t: number;
  version: string | null;
  node: string;
  nucleos: number;
  memoriaTotalMb: number;
  memoriaLibreMb: number;
  cargaPromedio: number[];
  uptime: number;
  carga: CargaServidor;
}

/** Una llamada a la base de esta partida (boletos, premios): corre fuera del tick, pero en el mismo hilo */
export interface LlamadaBase {
  t: number;
  que: string;
  ms: number;
}

interface JugadorPartida {
  id: string;
  nombre: string;
  color: string;
  dispositivo: DispositivoCliente | null;
  muestras: MuestraJugador[];
  ultimoPing: number;
}

interface Partida {
  id: string;
  codigo: string;
  circuito: string;
  tipo: string;
  inicio: number;
  fin: number | null;
  sala: Sala;
  jugadores: Map<string, JugadorPartida>;
  servidor: MuestraServidor[];
  /** Lo que detuvo al servidor durante la partida (rendimiento.ts), y hasta cuándo se juntaron las pausas del GC */
  tirones: Tiron[];
  gcHasta: number;
  /** Los tirones de OTRAS salas durante esta partida (el servidor es uno: también la detuvieron) */
  vecinos: TironVecino[];
  vecinosHasta: number;
  servidorInicio: ServidorInicio;
  base: LlamadaBase[];
}

/** Los tirones que se guardan por partida (los más largos), los de otras salas y las llamadas a la base */
const MAX_TIRONES_PARTIDA = 60;
const MAX_VECINOS_PARTIDA = 100;
const MAX_BASE_PARTIDA = 60;
/** Banderas de la salud del servidor */
const CPU_ALTA_PCT = 70;
const GC_ALTO_MS_POR_S = 20;
const HEAP_ALTO = 0.8;
const CANAL_LLENO_BYTES = 64 * 1024;
const BASE_LENTA_MS = 500;
/** La versión del servidor (el commit, lo pone el deploy) */
const VERSION = process.env.JUEGO_VERSION || null;
/** Un tirón de más de esto (ms) se nota en todos los navegadores: bandera */
const TIRON_GRANDE_MS = 40;

export interface Bandera {
  clave: "render" | "bajada" | "subida" | "rtt" | "prediccion" | "brincos" | "servidor" | "sinDatos";
  nivel: "malo" | "ojo";
  texto: string;
}

const red = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const mb = (bytes: number) => red(bytes / 1048576, 1);

/** Deja los `max` más largos, en orden de tiempo */
function recortar<T extends { t: number; ms: number }>(lista: T[], max: number): void {
  if (lista.length <= max) return;
  lista.sort((a, b) => b.ms - a.ms);
  lista.length = max;
  lista.sort((a, b) => a.t - b.t);
}

function memoria_(): MemoriaServidor {
  const m = process.memoryUsage();
  return { rssMb: mb(m.rss), heapMb: mb(m.heapUsed), heapLimiteMb: mb(getHeapStatistics().heap_size_limit), externoMb: mb(m.external) };
}

function percentil(valores: number[], p: number): number {
  if (!valores.length) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.max(0, Math.ceil(orden.length * p) - 1)];
}
const mediana = (valores: number[]) => percentil(valores, 0.5);

function tipoDe(s: Sala): string {
  if (s.local) return "local";
  if (s.copa) return "copa";
  if (s.tutorial) return "tutorial";
  if (s.multi) return s.multi.privada ? "privada" : "multi";
  if (s.pantalla) return "pantalla";
  return "sala";
}

/** Una muestra por ping de ~2 s: 900 son 30 min */
const MAX_MUESTRAS_JUGADOR = 900;
/** Cada 5 s: 360 son 30 min */
const MAX_MUESTRAS_SERVIDOR = 360;
/** El "arranque" de una ronda para comparar: sus primeros 5 s de carrera */
const ARRANQUE_MS = 5000;
/** "Ahora": las muestras de los últimos 30 s */
const VENTANA_AHORA_MS = 30000;

/**
 * Los números de un jugador sobre unas muestras: medianas de lo que cada reporte ya trae como
 * percentil, y sumas para lo que se cuenta (cuadros largos, correcciones, hambre…)
 */
/** Las ventanas con el canal rápido abierto y su ruta conocida (relevo o directo) */
const conRuta = <T extends { canalRapido?: boolean; canalRelevo?: boolean | null }>(cli: T[]) =>
  cli.filter((c) => c.canalRapido && typeof c.canalRelevo === "boolean");

/** La mediana de los que no son 0 (una ventana sin carros cerca trae 0); 0 si todos lo son, null sin ventanas */
function medianaPositiva(xs: number[], n: number): number | null {
  const positivos = xs.filter((x) => x > 0);
  return positivos.length ? red(mediana(positivos)) : n ? 0 : null;
}

export function resumirJugador(muestras: MuestraJugador[], estadoHz: number) {
  const cli = muestras.map((m) => m.cliente).filter((c): c is NonNullable<MuestraJugador["cliente"]> => !!c);
  const seg = (xs: { ventanaMs: number }[]) => xs.reduce((n, x) => n + x.ventanaMs, 0) / 1000;
  const suma = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
  const sCli = seg(cli);
  const sSrv = seg(muestras.map((m) => m.servidor));
  const cuadros = suma(cli, (c) => c.cuadros);
  const eventos = cli.flatMap((c) => c.eventos ?? []);
  return {
    muestras: muestras.length,
    conCliente: cli.length,
    fps: cli.length ? red(mediana(cli.map((c) => c.fps)), 1) : null,
    fpsMin: cli.length ? red(Math.min(...cli.map((c) => c.fps)), 1) : null,
    cuadroP95: cli.length ? red(mediana(cli.map((c) => c.cuadroP95)), 1) : null,
    cuadroMax: cli.length ? red(Math.max(...cli.map((c) => c.cuadroMax)), 1) : null,
    cuadrosLargosPct: cuadros ? red((suma(cli, (c) => c.cuadrosLargos) / cuadros) * 100, 1) : null,
    nivelCalidad: cli.at(-1)?.nivelCalidad ?? null,
    perfil: cli.at(-1)?.perfil ?? null,
    oculto: cli.some((c) => c.oculto),
    estadosPct: sCli ? red((suma(cli, (c) => c.estados) / (sCli * estadoHz)) * 100, 1) : null,
    huecoP95: cli.length ? red(mediana(cli.map((c) => c.huecoP95)), 1) : null,
    huecoMax: cli.length ? red(Math.max(...cli.map((c) => c.huecoMax)), 1) : null,
    atraso: cli.length ? red(mediana(cli.map((c) => c.atraso))) : null,
    colchonOtros: cli.length ? red(mediana(cli.map((c) => c.colchonOtros))) : null,
    deLargoPorS: sCli ? red(suma(cli, (c) => c.deLargo) / sCli) : null,
    camaraDeLargoPct: cuadros ? red((suma(cli, (c) => c.camaraDeLargo ?? 0) / cuadros) * 100, 1) : null,
    camaraQuietaMsPorMin: sCli ? Math.round((suma(cli, (c) => c.camaraQuietaMs ?? 0) / sCli) * 60) : null,
    camaraLentaMsPorMin: sCli ? Math.round((suma(cli, (c) => c.camaraLentaMs ?? 0) / sCli) * 60) : null,
    // El canal rápido: en qué % de los reportes estaba abierto, y qué % de los estados llegó por él
    canalRapidoPct: cli.length ? red((cli.filter((c) => c.canalRapido).length / cli.length) * 100, 1) : null,
    // De las ventanas con el canal abierto y la ruta conocida: en qué % iba por el relevo TURN
    canalRelevoPct: conRuta(cli).length ? red((conRuta(cli).filter((c) => c.canalRelevo === true).length / conRuta(cli).length) * 100, 1) : null,
    estadosPorCanalPct: suma(cli, (c) => c.estados) ? red((suma(cli, (c) => c.estadosCanal ?? 0) / suma(cli, (c) => c.estados)) * 100, 1) : null,
    envioP95: cli.length ? red(mediana(cli.map((c) => c.envioP95)), 1) : null,
    confirmacionP95: cli.length ? red(mediana(cli.map((c) => c.confirmacionP95)), 1) : null,
    rttP50: cli.length ? red(mediana(cli.map((c) => c.rttP50)), 1) : null,
    rttP95: cli.length ? red(mediana(cli.map((c) => c.rttP95)), 1) : null,
    rttP99: cli.length ? red(Math.max(...cli.map((c) => c.rttP99)), 1) : null,
    correccionesPorS: sCli ? red(suma(cli, (c) => c.correcciones) / sCli) : null,
    // Solo las ventanas con carros cerca (sin nadie cerca el reporte trae 0 y la mediana saldría 0)
    errorChoqueP95: cli.some((c) => c.errorChoqueP95 > 0) ? red(mediana(cli.filter((c) => c.errorChoqueP95 > 0).map((c) => c.errorChoqueP95))) : cli.length ? 0 : null,
    errorChoqueMax: cli.length ? red(Math.max(...cli.map((c) => c.errorChoqueP95))) : null,
    // La predicción de los choques según la red (confianzaChoque): igual, solo las ventanas que lo traen
    incertidumbreP95: medianaPositiva(cli.map((c) => c.incertidumbreP95 ?? 0), cli.length),
    errorChoqueBuenaP95: medianaPositiva(cli.map((c) => c.errorChoqueBuenaP95 ?? 0), cli.length),
    errorChoqueMalaP95: medianaPositiva(cli.map((c) => c.errorChoqueMalaP95 ?? 0), cli.length),
    choquesSuavizadosPct: suma(cli, (c) => c.choquesPredichos ?? 0)
      ? red((suma(cli, (c) => c.choquesSuavizados ?? 0) / suma(cli, (c) => c.choquesPredichos ?? 0)) * 100, 1)
      : null,
    controlesPorS: sSrv ? red(suma(muestras, (m) => m.servidor.controles) / sSrv, 1) : null,
    controlesHuecoP95: muestras.length ? red(mediana(muestras.map((m) => m.servidor.huecoP95)), 1) : null,
    controlesHuecoMax: muestras.length ? red(Math.max(...muestras.map((m) => m.servidor.huecoMax)), 1) : null,
    hambrePorS: sSrv ? red(suma(muestras, (m) => m.servidor.hambre) / sSrv) : null,
    inventadosPorS: sSrv ? red(suma(muestras, (m) => m.servidor.inventados ?? 0) / sSrv) : null,
    cubiertosPorS: sSrv ? red(suma(muestras, (m) => m.servidor.cubiertos ?? 0) / sSrv) : null,
    tirados: suma(muestras, (m) => m.servidor.tirados),
    perdidos: suma(muestras, (m) => m.servidor.perdidos ?? 0),
    bufferMax: muestras.length ? Math.max(...muestras.map((m) => m.servidor.buffer)) : null,
    // Brincos (los reportes de antes no los traen: cuentan como 0)
    correccionP95: cli.length ? red(mediana(cli.map((c) => c.correccionP95 ?? 0))) : null,
    correccionMax: cli.length ? red(Math.max(...cli.map((c) => c.correccionMax ?? 0))) : null,
    correccionesDurasPorMin: sCli ? red((suma(cli, (c) => c.correccionesDuras ?? 0) / sCli) * 60, 1) : null,
    // Segundos que el carro se detuvo esperando al servidor (1 s sin confirmación), por minuto
    congeladoSPorMin: sCli ? red((suma(cli, (c) => c.congeladoMs ?? 0) / 1000 / sCli) * 60, 2) : null,
    brincosOtrosPorMin: sCli ? red((suma(cli, (c) => c.brincosOtros ?? 0) / sCli) * 60, 1) : null,
    brincoOtrosMax: cli.length ? red(Math.max(...cli.map((c) => c.brincoOtrosMax ?? 0))) : null,
    cuadrosMuyLargosPorMin: sCli ? red((eventos.filter((e) => e.tipo === "cuadro-largo").length / sCli) * 60, 1) : null,
    /** El hueco de estados típico cuando otro carro brinca: si es alto, el brinco viene de la bajada */
    huecoEnBrincosOtros: red(mediana(eventos.filter((e) => e.tipo === "otro").map((e) => e.hueco)), 1),
    ultimosBrincos: eventos.slice(-30),
  };
}

export type ResumenJugador = ReturnType<typeof resumirJugador>;

/**
 * El arranque de cada ronda (las ventanas que tocan sus primeros ARRANQUE_MS de carrera) contra el
 * resto de la carrera: ahí se ve si el lag es de la salida (todos pegados en la parrilla)
 */
export function resumirPorTramo(muestras: MuestraJugador[], estadoHz: number) {
  const enArranque = (m: MuestraJugador) => {
    const ms = m.cliente?.msDesdeArranque;
    return typeof ms === "number" && ms - (m.cliente?.ventanaMs ?? 0) < ARRANQUE_MS;
  };
  const enCarrera = (m: MuestraJugador) => typeof m.cliente?.msDesdeArranque === "number";
  return {
    arranque: resumirJugador(muestras.filter(enArranque), estadoHz),
    resto: resumirJugador(muestras.filter((m) => enCarrera(m) && !enArranque(m)), estadoHz),
  };
}

/** De qué lado viene el lag de un jugador, en palabras, con los números que lo muestran */
export function diagnosticar(r: ResumenJugador, estadoHz: number, tickHz: number): Bandera[] {
  const b: Bandera[] = [];
  const esperado = 1000 / estadoHz;
  if (!r.muestras) return b;
  if (!r.conCliente) {
    b.push({ clave: "sinDatos", nivel: "ojo", texto: "Versión vieja del juego: solo hay lo que mide el servidor" });
  } else {
    if (r.fps !== null && r.fps < 45) {
      b.push({ clave: "render", nivel: r.fps < 30 ? "malo" : "ojo", texto: `Render lento: ${r.fps} fps (mediana), cuadro p95 ${r.cuadroP95} ms` });
    } else if ((r.cuadrosLargosPct ?? 0) > 2) {
      b.push({ clave: "render", nivel: (r.cuadrosLargosPct ?? 0) > 8 ? "malo" : "ojo", texto: `Tirones de render: ${r.cuadrosLargosPct} % de cuadros de más de 50 ms (máx. ${r.cuadroMax} ms)` });
    }
    if ((r.estadosPct ?? 100) < 90 || (r.huecoP95 ?? 0) > esperado * 2) {
      const malo = (r.estadosPct ?? 100) < 75 || (r.huecoP95 ?? 0) > esperado * 4;
      b.push({
        clave: "bajada",
        nivel: malo ? "malo" : "ojo",
        texto: `Los estados le llegan irregulares: recibe ${r.estadosPct} % de los que se mandan, hueco p95 ${r.huecoP95} ms (esperado ${red(esperado, 1)} ms, máx. ${r.huecoMax} ms)${r.camaraDeLargoPct ? `; la cámara pasó ${r.camaraDeLargoPct} % de los cuadros sin estado nuevo y estuvo quieta ${r.camaraQuietaMsPorMin} ms/min` : ""}`,
      });
    }
    if ((r.rttP95 ?? 0) > 150) {
      b.push({ clave: "rtt", nivel: (r.rttP95 ?? 0) > 300 ? "malo" : "ojo", texto: `Ping alto: p95 ${r.rttP95} ms (p50 ${r.rttP50} ms, p99 ${r.rttP99} ms)` });
    }
    if ((r.correccionesPorS ?? 0) > 2 || (r.errorChoqueP95 ?? 0) > 1) {
      b.push({
        clave: "prediccion",
        nivel: (r.correccionesPorS ?? 0) > 6 ? "malo" : "ojo",
        texto: `El servidor le corrige el carro seguido: ${r.correccionesPorS} correcciones/s, error de choque p95 ${r.errorChoqueP95} m${r.incertidumbreP95 ? ` (adivina ${r.incertidumbreP95} ms adelante; red buena ${r.errorChoqueBuenaP95} m, mala ${r.errorChoqueMalaP95} m${r.choquesSuavizadosPct != null ? `, ${r.choquesSuavizadosPct} % de los golpes suavizados` : ""})` : ""}`,
      });
    }
  }
  const durasMin = r.correccionesDurasPorMin ?? 0;
  const otrosMin = r.brincosOtrosPorMin ?? 0;
  const cuadrosMin = r.cuadrosMuyLargosPorMin ?? 0;
  if (durasMin + otrosMin + cuadrosMin > 1) {
    const causa =
      otrosMin >= durasMin && otrosMin >= cuadrosMin
        ? `otros carros saltan ${otrosMin}/min (hasta ${r.brincoOtrosMax} m)${(r.huecoEnBrincosOtros ?? 0) > esperado * 2 ? `, después de huecos de ${r.huecoEnBrincosOtros} ms sin estados: viene de la bajada` : ""}`
        : durasMin >= cuadrosMin
          ? `su carro se brinca ${durasMin}/min por correcciones duras (hasta ${r.correccionMax} m): la predicción se aleja del servidor`
          : `${cuadrosMin} cuadros/min de más de 100 ms: viene del render`;
    b.push({ clave: "brincos", nivel: durasMin + otrosMin + cuadrosMin > 6 ? "malo" : "ojo", texto: `Brincos: ${causa}` });
  }
  const pasoMs = 1000 / tickHz;
  if ((r.controlesHuecoP95 ?? 0) > Math.max(50, pasoMs * 3) || (r.hambrePorS ?? 0) > 1) {
    const cubiertos = (r.inventadosPorS ?? 0) > 0 ? `, ${r.inventadosPorS} ticks/s cubiertos repitiendo su control` : "";
    b.push({
      clave: "subida",
      nivel: (r.hambrePorS ?? 0) > 5 || (r.controlesHuecoP95 ?? 0) > 100 ? "malo" : "ojo",
      texto: `Sus controles suben a ráfagas: hueco p95 ${r.controlesHuecoP95} ms (máx. ${r.controlesHuecoMax} ms)${cubiertos}, ${r.hambrePorS} ticks/s quieto en el servidor`,
    });
  }
  return b;
}

export class ColectorEstado {
  private readonly activas = new Map<string, Partida>();
  private readonly terminadas: Partida[] = [];
  private readonly bucle = monitorEventLoopDelay({ resolution: 10 });
  private cpuAntes = process.cpuUsage();
  private relojAntes = performance.now();
  private ultimaGlobal = { cpu: 0, bucleP50: 0, bucleP95: 0, bucleMax: 0 };
  private readonly reloj: NodeJS.Timeout | null;

  constructor(
    private readonly fuente: FuenteEstado,
    private readonly maxTerminadas = 20,
    cadaMs = 5000,
  ) {
    this.bucle.enable();
    this.reloj = cadaMs > 0 ? setInterval(() => this.muestrear(), cadaMs) : null;
    this.reloj?.unref();
  }

  private idDe(s: Sala) {
    return `${s.codigo}-${Date.now().toString(36)}`;
  }

  /** La partida en curso de la sala, abriéndola si acaba de empezar (null si no hay) */
  private partidaDe(s: Sala): Partida | null {
    const actual = this.activas.get(s.codigo);
    const jugando = s.fase !== "espera" && this.fuente.simulada(s.codigo);
    if (actual && (actual.sala !== s || !jugando)) this.cerrarPartida(actual);
    if (!jugando) return null;
    if (actual && actual.sala === s) return actual;
    const nueva: Partida = {
      id: this.idDe(s),
      codigo: s.codigo,
      circuito: s.circuito.id,
      tipo: tipoDe(s),
      inicio: Date.now(),
      fin: null,
      sala: s,
      jugadores: new Map(),
      servidor: [],
      tirones: [],
      gcHasta: Date.now(),
      vecinos: [],
      vecinosHasta: Date.now() - 1,
      servidorInicio: this.inicio(),
      base: [],
    };
    this.activas.set(s.codigo, nueva);
    return nueva;
  }

  /** Cuánto había en todo el servidor */
  private carga(salas = this.fuente.salas()): CargaServidor {
    let jugando = 0;
    let humanos = 0;
    let bots = 0;
    for (const s of salas) {
      if (s.fase !== "espera" && this.fuente.simulada(s.codigo)) jugando++;
      for (const j of s.jugadores.values()) {
        if (j.mente) bots++;
        else humanos++;
      }
    }
    return { salas: salas.length, jugando, humanos, bots, sockets: this.fuente.sockets(), canales: this.fuente.canales?.() ?? 0 };
  }

  private inicio(): ServidorInicio {
    return {
      t: Date.now(),
      version: VERSION,
      node: process.version,
      nucleos: availableParallelism(),
      memoriaTotalMb: mb(totalmem()),
      memoriaLibreMb: mb(freemem()),
      cargaPromedio: loadavg().map((x) => red(x)),
      uptime: Math.round(process.uptime()),
      carga: this.carga(),
    };
  }

  /** Una llamada a la base de la partida de `sala` (boletos, premios) y cuánto tardó (socket.ts medirBase) */
  registrarBase(sala: Sala, que: string, ms: number): void {
    const p = this.activas.get(sala.codigo);
    if (!p || p.sala !== sala) return;
    p.base.push({ t: Date.now(), que, ms: red(ms) });
    recortar(p.base, MAX_BASE_PARTIDA);
  }

  private cerrarPartida(p: Partida) {
    p.fin = Date.now();
    this.activas.delete(p.codigo);
    // Sin ninguna muestra (una partida que no llegó a nada) no vale la pena guardarla
    if (![...p.jugadores.values()].some((j) => j.muestras.length) && !p.servidor.length) return;
    this.terminadas.unshift(p);
    this.terminadas.splice(this.maxTerminadas);
    void this.guardar(p);
  }

  /** La partida terminada, completa, en la base del juego (sin base: solo queda en memoria) */
  private async guardar(p: Partida) {
    try {
      const col = await coleccionPartidas();
      if (!col) return;
      await col.replaceOne(
        { _id: p.id },
        { lista: this.itemDeLista(p), detalle: this.detalle(p), expira: new Date(Date.now() + DIAS_GUARDADA * 86400000) },
        { upsert: true },
      );
    } catch (e) {
      console.error("[juego] no se pudo guardar el rendimiento de la partida:", (e as Error).message);
    }
  }

  /**
   * El ping de un jugador (~2 s): su reporte (null en un cliente viejo) y lo que el servidor vio
   * de él desde el anterior. `buffer`: los paquetes que esperan salir por su socket
   */
  reporte(sala: Sala | null, idJugador: string, reporte: ReporteCliente | null, buffer = 0): void {
    if (!sala) return;
    const p = this.partidaDe(sala);
    const j = sala.jugadores.get(idJugador);
    if (!j || j.mente) return;
    // En la espera no hay partida: lo que mandó hasta aquí no cuenta para la siguiente
    if (!p) {
      j.red = { ...contadoresRed(), ultimo: j.red?.ultimo ?? 0 };
      return;
    }
    let jp = p.jugadores.get(idJugador);
    const ahora = Date.now();
    if (!jp) p.jugadores.set(idJugador, (jp = { id: idJugador, nombre: j.nombre, color: j.color, dispositivo: null, muestras: [], ultimoPing: ahora }));
    const ventanaMs = Math.max(1, ahora - jp.ultimoPing);
    jp.ultimoPing = ahora;
    jp.nombre = j.nombre;
    jp.color = j.color;
    const { dispositivo, eventos, ...cliente } = reporte ?? ({} as Partial<ReporteCliente>);
    if (dispositivo) jp.dispositivo = dispositivo;
    const r = j.red ?? contadoresRed();
    jp.muestras.push({
      t: ahora,
      cliente: reporte
        ? { ...(cliente as Omit<ReporteCliente, "dispositivo" | "eventos">), eventos: (eventos ?? []).map(({ hace, ...e }) => ({ ...e, t: ahora - hace })) }
        : null,
      servidor: {
        ventanaMs,
        controles: r.recibidos,
        huecoP95: red(percentil(r.huecos, 0.95), 1),
        huecoMax: red(Math.max(0, ...r.huecos), 1),
        tirados: r.tirados,
        hambre: r.hambre,
        inventados: r.inventados,
        cubiertos: r.cubiertos,
        perdidos: r.perdidos,
        colaMax: r.colaMax,
        buffer,
      },
    });
    if (jp.muestras.length > MAX_MUESTRAS_JUGADOR) jp.muestras.splice(0, jp.muestras.length - MAX_MUESTRAS_JUGADOR);
    // Se reinician (el último control sigue, para medir el hueco del siguiente)
    j.red = { ...contadoresRed(), ultimo: r.ultimo };
  }

  /** Cada `cadaMs`: abre y cierra partidas y guarda lo del servidor en cada una (pública para las pruebas) */
  muestrear(): void {
    const ahora = performance.now();
    const cpu = process.cpuUsage(this.cpuAntes);
    const transcurrido = Math.max(1, ahora - this.relojAntes);
    this.cpuAntes = process.cpuUsage();
    this.relojAntes = ahora;
    this.ultimaGlobal = {
      // user + system en µs contra el tiempo real en ms: % de un núcleo
      cpu: red(((cpu.user + cpu.system) / 1000 / transcurrido) * 100, 1),
      bucleP50: red(this.bucle.percentile(50) / 1e6),
      bucleP95: red(this.bucle.percentile(95) / 1e6),
      bucleMax: red(this.bucle.max / 1e6),
    };
    this.bucle.reset();

    const salas = this.fuente.salas();
    const vivas = new Set(salas);
    for (const p of [...this.activas.values()]) if (!vivas.has(p.sala)) this.cerrarPartida(p);
    // Lo de todo el servidor, una vez por muestra (el GC se toma una vez: es del proceso)
    const carga = this.carga(salas);
    const mem = memoria_();
    const gc = this.fuente.rendimiento.tomarGc();
    for (const s of salas) {
      // El costo se toma de todas las salas (también de las que esperan), para que no se junte
      const c = this.fuente.rendimiento.tomarCosto(s);
      const p = this.partidaDe(s);
      if (!p) continue;
      const r = this.fuente.rendimiento.resumen(s);
      const cpuSala = c.tickMs + c.controlesMs + c.estadoMs + c.avisosMs;
      const bytesEstado = c.medidos ? Math.round(c.bytes / c.medidos) : 0;
      p.servidor.push({
        t: Date.now(),
        tickP50: r.tick?.p50 ?? 0,
        tickP95: r.tick?.p95 ?? 0,
        tickMax: r.tick?.max ?? 0,
        pendientes: r.pendientes,
        ...this.ultimaGlobal,
        carga,
        memoria: mem,
        gc,
        sala: {
          cpuMs: { tick: red(c.tickMs, 1), controles: red(c.controlesMs, 1), estado: red(c.estadoMs, 1), avisos: red(c.avisosMs, 1) },
          cpuPct: red((cpuSala / transcurrido) * 100, 1),
          ticks: c.ticks,
          estados: c.estados,
          bytesEstado,
          kbPorS: red((bytesEstado * c.estados) / 1024 / (transcurrido / 1000), 1),
          continuaciones: c.continuaciones,
          pendientesMax: c.pendientesMax,
          canalBufferMax: c.canalBufferMax,
        },
      });
      p.vecinos.push(...this.fuente.rendimiento.vecinosDesde(p.vecinosHasta, p.codigo));
      p.vecinosHasta = Date.now();
      recortar(p.vecinos, MAX_VECINOS_PARTIDA);
      // Los tirones de esta sala y las pausas del GC (de todo el proceso) desde la muestra anterior
      const ahoraMs = Date.now();
      p.tirones.push(...this.fuente.rendimiento.tomarTirones(s), ...this.fuente.rendimiento.gcDesde(p.gcHasta));
      p.gcHasta = ahoraMs;
      recortar(p.tirones, MAX_TIRONES_PARTIDA);
      if (p.servidor.length > MAX_MUESTRAS_SERVIDOR) p.servidor.splice(0, p.servidor.length - MAX_MUESTRAS_SERVIDOR);
    }
  }

  private servidor() {
    const memoria = process.memoryUsage();
    return {
      t: Date.now(),
      uptime: Math.round(process.uptime()),
      node: process.version,
      tickHz: this.fuente.tickHz,
      estadoHz: this.fuente.estadoHz,
      sockets: this.fuente.sockets(),
      salas: this.fuente.salas().length,
      rssMb: mb(memoria.rss),
      heapMb: mb(memoria.heapUsed),
      ...this.ultimaGlobal,
      version: VERSION,
      nucleos: availableParallelism(),
      carga: this.carga(),
      memoria: memoria_(),
    };
  }

  private resumenJugador(jp: JugadorPartida, partida: Partida) {
    const { estadoHz, tickHz } = this.fuente;
    const total = resumirJugador(jp.muestras, estadoHz);
    const porTramo = resumirPorTramo(jp.muestras, estadoHz);
    const desde = Date.now() - VENTANA_AHORA_MS;
    const ahora = partida.fin === null ? resumirJugador(jp.muestras.filter((m) => m.t >= desde), estadoHz) : null;
    return {
      id: jp.id,
      nombre: jp.nombre,
      color: jp.color,
      dispositivo: jp.dispositivo,
      sigue: partida.fin === null && partida.sala.jugadores.has(jp.id),
      total,
      ahora,
      porTramo,
      banderas: diagnosticar(total, estadoHz, tickHz),
      banderasAhora: ahora ? diagnosticar(ahora, estadoHz, tickHz) : [],
    };
  }

  private servidorDePartida(p: Partida) {
    const presupuesto = 1000 / this.fuente.tickHz;
    const tickP95 = red(mediana(p.servidor.map((m) => m.tickP95)));
    const tickMax = red(Math.max(0, ...p.servidor.map((m) => m.tickMax)));
    const banderas: Bandera[] = [];
    if (tickP95 > presupuesto / 2 || Math.max(0, ...p.servidor.map((m) => m.pendientes)) > 0) {
      banderas.push({ clave: "servidor", nivel: tickP95 > presupuesto ? "malo" : "ojo", texto: `El servidor va justo: tick p95 ${tickP95} ms de ${red(presupuesto, 1)} ms (máx. ${tickMax} ms)` });
    }
    const tirones = p.tirones ?? [];
    const grandes = tirones.filter((t) => t.ms >= TIRON_GRANDE_MS);
    if (grandes.length) {
      const peor = grandes.reduce((a, b) => (b.ms > a.ms ? b : a));
      banderas.push({ clave: "servidor", nivel: "ojo", texto: `El servidor se detuvo ${grandes.length} vez/veces más de ${TIRON_GRANDE_MS} ms (el peor: ${peor.ms} ms, ${peor.tipo})` });
    }
    // La salud del servidor (las partidas guardadas antes no traen estos datos)
    const vecinos = p.vecinos ?? [];
    const vecinosGrandes = vecinos.filter((t) => t.ms >= TIRON_GRANDE_MS);
    if (vecinosGrandes.length) {
      const peor = vecinosGrandes.reduce((a, b) => (b.ms > a.ms ? b : a));
      banderas.push({
        clave: "servidor",
        nivel: "ojo",
        texto: `Otras salas detuvieron el servidor ${vecinosGrandes.length} vez/veces más de ${TIRON_GRANDE_MS} ms (el peor: ${peor.ms} ms, ${peor.tipo} de la sala ${peor.sala} en ${peor.circuito})`,
      });
    }
    const conSalud = p.servidor.filter((m) => m.carga);
    const cpuMax = red(Math.max(0, ...p.servidor.map((m) => m.cpu)), 1);
    if (cpuMax > CPU_ALTA_PCT) {
      const enPico = p.servidor.find((m) => m.cpu === cpuMax);
      banderas.push({
        clave: "servidor",
        nivel: cpuMax > 90 ? "malo" : "ojo",
        texto: `El servidor iba cerca del límite: CPU hasta ${cpuMax} % de un núcleo${enPico?.carga ? ` (${enPico.carga.jugando} salas jugando, ${enPico.carga.humanos} personas y ${enPico.carga.bots} bots)` : ""}`,
      });
    }
    const segundos = conSalud.length * 5;
    const gcMs = conSalud.reduce((n, m) => n + (m.gc?.ms ?? 0), 0);
    const gcMsPorS = segundos ? red(gcMs / segundos, 1) : 0;
    const gcMaxMs = red(Math.max(0, ...conSalud.map((m) => m.gc?.maxMs ?? 0)));
    if (gcMsPorS > GC_ALTO_MS_POR_S) {
      banderas.push({ clave: "servidor", nivel: "ojo", texto: `GC frecuente: ${gcMsPorS} ms/s recolectando basura (la pausa más larga: ${gcMaxMs} ms)` });
    }
    const heapMaxMb = red(Math.max(0, ...conSalud.map((m) => m.memoria?.heapMb ?? 0)), 1);
    const heapLimiteMb = conSalud.at(-1)?.memoria?.heapLimiteMb ?? 0;
    if (heapLimiteMb && heapMaxMb / heapLimiteMb > HEAP_ALTO) {
      banderas.push({ clave: "servidor", nivel: "malo", texto: `Memoria alta: heap hasta ${heapMaxMb} MB de ${heapLimiteMb} MB` });
    }
    const canalBufferMax = Math.max(0, ...conSalud.map((m) => m.sala?.canalBufferMax ?? 0));
    if (canalBufferMax > CANAL_LLENO_BYTES) {
      banderas.push({ clave: "servidor", nivel: "ojo", texto: `El estado no salía a tiempo por el canal rápido: hasta ${red(canalBufferMax / 1024, 1)} KB esperando` });
    }
    const base = p.base ?? [];
    const baseLentas = base.filter((b) => b.ms > BASE_LENTA_MS);
    if (baseLentas.length) {
      const peor = baseLentas.reduce((a, b) => (b.ms > a.ms ? b : a));
      banderas.push({ clave: "servidor", nivel: "ojo", texto: `La base tardó en ${baseLentas.length} llamada(s) de la partida (la peor: ${peor.que}, ${peor.ms} ms)` });
    }
    const salud = {
      cpuMax,
      cpuSalaMediana: red(mediana(conSalud.map((m) => m.sala?.cpuPct ?? 0)), 1),
      cpuSalaMax: red(Math.max(0, ...conSalud.map((m) => m.sala?.cpuPct ?? 0)), 1),
      bytesEstado: Math.round(mediana(conSalud.map((m) => m.sala?.bytesEstado ?? 0).filter((b) => b > 0))),
      kbPorSMax: red(Math.max(0, ...conSalud.map((m) => m.sala?.kbPorS ?? 0)), 1),
      canalBufferMax,
      gcMsPorS,
      gcMaxMs,
      heapMaxMb,
      heapLimiteMb,
      salasMax: Math.max(0, ...conSalud.map((m) => m.carga?.salas ?? 0)),
      jugandoMax: Math.max(0, ...conSalud.map((m) => m.carga?.jugando ?? 0)),
      personasMax: Math.max(0, ...conSalud.map((m) => m.carga?.humanos ?? 0)),
      botsMax: Math.max(0, ...conSalud.map((m) => m.carga?.bots ?? 0)),
      bucleP95Max: red(Math.max(0, ...p.servidor.map((m) => m.bucleP95))),
    };
    return { tickP95, tickMax, banderas, tirones, vecinos, base, inicio: p.servidorInicio ?? null, salud };
  }

  private cabecera(p: Partida) {
    return { id: p.id, codigo: p.codigo, circuito: p.circuito, tipo: p.tipo, inicio: p.inicio, fin: p.fin, fase: p.fin === null ? p.sala.fase : null };
  }

  /** Una partida en la lista (sin líneas de tiempo) */
  private itemDeLista(p: Partida) {
    return {
      ...this.cabecera(p),
      servidor: this.servidorDePartida(p),
      bots: p.fin === null ? [...p.sala.jugadores.values()].filter((j) => j.mente).length : null,
      jugadores: [...p.jugadores.values()].map((jp) => {
        const { total, ahora, porTramo: _tramos, ...resto } = this.resumenJugador(jp, p);
        return { ...resto, fps: (ahora ?? total).fps, rttP95: (ahora ?? total).rttP95 };
      }),
    };
  }

  /** Todo de una partida: lo que se guarda en la base y lo que se baja como JSON */
  detalle(p: Partida) {
    return {
      ...this.cabecera(p),
      config: { tickHz: this.fuente.tickHz, estadoHz: this.fuente.estadoHz, repetirControl: p.sala.repetirControl, proyectar: p.sala.proyectar },
      servidor: { ...this.servidorDePartida(p), muestras: p.servidor },
      jugadores: [...p.jugadores.values()].map((jp) => ({ ...this.resumenJugador(jp, p), muestras: jp.muestras })),
    };
  }

  /**
   * GET /admin/metricas: el servidor y cada partida (en curso, recientes en memoria y las guardadas
   * en la base), con el diagnóstico de cada jugador
   */
  async resumen() {
    const enMemoria = [...this.activas.values(), ...this.terminadas].map((p) => this.itemDeLista(p));
    const ids = new Set(enMemoria.map((p) => p.id));
    // Las de la base traen la misma forma (se guardaron con itemDeLista)
    const guardadas = ((await leerGuardadas()) as unknown as typeof enMemoria).filter((p) => !ids.has(p.id));
    const terminadas = [...enMemoria.filter((p) => p.fin !== null), ...guardadas].sort((a, b) => b.inicio - a.inicio).slice(0, MAX_LISTA);
    return { servidor: this.servidor(), partidas: [...enMemoria.filter((p) => p.fin === null), ...terminadas] };
  }

  /** GET /admin/metricas/partidas/<id>: todo de una partida (en memoria o en la base; null si no está) */
  async partida(id: string) {
    const p = [...this.activas.values(), ...this.terminadas].find((x) => x.id === id);
    if (p) return { servidorActual: this.servidor(), ...this.detalle(p), guardada: false };
    // Se guardó con detalle(): misma forma
    const guardada = (await leerGuardada(id)) as ReturnType<ColectorEstado["detalle"]> | null;
    return guardada ? { servidorActual: this.servidor(), ...guardada, guardada: true } : null;
  }

  cerrar(): void {
    if (this.reloj) clearInterval(this.reloj);
    this.bucle.disable();
  }
}

/* ------------------------- Las partidas guardadas ------------------------- */

/** Cuántos días se guarda una partida (índice TTL) y cuántas terminadas se listan */
const DIAS_GUARDADA = 30;
const MAX_LISTA = 50;

interface DocPartida {
  _id: string;
  lista: { id: string; inicio: number; fin: number | null } & Record<string, unknown>;
  detalle: Record<string, unknown>;
  expira: Date;
}

let indices: Promise<void> | null = null;
async function coleccionPartidas(): Promise<Collection<DocPartida> | null> {
  const col = (await baseJuego())?.collection<DocPartida>("juego_partidas_rendimiento") ?? null;
  if (col) {
    indices ??= Promise.all([
      col.createIndex({ expira: 1 }, { expireAfterSeconds: 0 }),
      col.createIndex({ "lista.inicio": -1 }),
    ]).then(() => undefined, (e) => {
      indices = null;
      console.error("[juego] índices de juego_partidas_rendimiento:", (e as Error).message);
    });
    await indices;
  }
  return col;
}

async function leerGuardadas() {
  try {
    const col = await coleccionPartidas();
    if (!col) return [];
    const docs = await col.find({}, { projection: { lista: 1 } }).sort({ "lista.inicio": -1 }).limit(MAX_LISTA).toArray();
    return docs.map((d) => ({ ...d.lista, guardada: true }));
  } catch (e) {
    console.error("[juego] no se pudieron leer las partidas guardadas:", (e as Error).message);
    return [];
  }
}

async function leerGuardada(id: string) {
  try {
    const col = await coleccionPartidas();
    const doc = col && (await col.findOne({ _id: id }, { projection: { detalle: 1 } }));
    return doc ? doc.detalle : null;
  } catch (e) {
    console.error("[juego] no se pudo leer la partida guardada:", (e as Error).message);
    return null;
  }
}

/**
 * El servidor del juego de este proceso (el backend completo también lo corre): la ruta del API
 * lo lee cuando no hay JUEGO_STATUS_URL
 */
let local: ColectorEstado | null = null;
export const registrarEstadoLocal = (c: ColectorEstado | null) => void (local = c);
export const estadoLocal = () => local;

/** La clave del header x-juego-admin contra JUEGO_ADMIN_TOKEN (sin la variable, nunca) */
export function claveAdminValida(clave: unknown): boolean {
  const esperada = process.env.JUEGO_ADMIN_TOKEN;
  if (!esperada || typeof clave !== "string" || !clave) return false;
  const h = (t: string) => createHash("sha256").update(t, "utf8").digest();
  return timingSafeEqual(h(clave), h(esperada));
}
