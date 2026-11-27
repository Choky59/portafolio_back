import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { VentanaMetricas } from "../compartido/metricas";
import type { Sala } from "./salas";

/**
 * Un TIRÓN DEL SERVIDOR: algo que lo detuvo lo suficiente para que se note en los navegadores.
 * - tick: un paso de la simulación de más de TICK_LENTO_MS (con cuánto tardó cada parte)
 * - controles: una ráfaga de controles de un jugador aplicada de golpe (se aplican al llegar, fuera del tick)
 * - estado: armar y mandar la instantánea a todos
 * - gc: una pausa del recolector de basura de Node (detiene todo el proceso)
 */
export interface Tiron {
  t: number;
  tipo: "tick" | "controles" | "estado" | "gc";
  ms: number;
  detalle?: Record<string, number | string>;
}

/** Un tirón de OTRA sala: como el servidor es uno, también detuvo a las demás */
export interface TironVecino extends Tiron {
  sala: string;
  circuito: string;
}

/**
 * Lo que gastó una sala entre dos muestras del Status (5 s): ms de CPU de cada parte, los estados
 * que mandó y cuánto pesaron, y las veces que no alcanzó a ponerse al corriente en un turno
 */
export interface CostoSala {
  tickMs: number;
  controlesMs: number;
  estadoMs: number;
  /** Eventos, cambios de fase, premios y cambio de pista (avisarPartida), fuera de paso() */
  avisosMs: number;
  ticks: number;
  estados: number;
  /** Bytes de los estados medidos (los que salieron como texto: canal rápido o muestreo) */
  bytes: number;
  medidos: number;
  /** Turnos en que quedaron ticks atrasados (siguió con setImmediate) y lo más atrasado */
  continuaciones: number;
  pendientesMax: number;
  /** Lo más que se juntó sin salir en un canal rápido de la sala (bytes) */
  canalBufferMax: number;
}

/** Las pausas del recolector de basura entre dos muestras: TODAS, no solo las largas */
export interface VentanaGc {
  n: number;
  ms: number;
  maxMs: number;
}

export const TICK_LENTO_MS = 15;
export const CONTROLES_LENTOS_MS = 5;
export const ESTADO_LENTO_MS = 5;
export const GC_LENTO_MS = 10;
/** Por sala, los últimos tirones (se los lleva el Status cada 5 s) */
const MAX_TIRONES = 50;
/** De todo el servidor, los últimos tirones que se notan (de ahí salen los vecinos de cada partida) */
const MAX_RECIENTES = 300;

const r2 = (n: number) => Math.round(n * 100) / 100;
const costoVacio = (): CostoSala => ({
  tickMs: 0, controlesMs: 0, estadoMs: 0, avisosMs: 0, ticks: 0, estados: 0, bytes: 0, medidos: 0, continuaciones: 0, pendientesMax: 0, canalBufferMax: 0,
});

export class RendimientoServidor {
  private bucle = monitorEventLoopDelay({ resolution: 10 });
  private salas = new WeakMap<Sala, { ticks: VentanaMetricas; pendientes: number; tirones: Tiron[]; costo: CostoSala }>();
  /** Las pausas del recolector de basura (son de todo el proceso, no de una sala) */
  private gc: Tiron[] = [];
  private gcVentana: VentanaGc = { n: 0, ms: 0, maxMs: 0 };
  /** Los tirones de TODAS las salas que se notan (TICK_LENTO_MS o más), con su sala */
  private recientes: TironVecino[] = [];
  private observadorGc: PerformanceObserver | null = null;
  constructor() {
    this.bucle.enable();
    try {
      this.observadorGc = new PerformanceObserver((lista) => {
        for (const e of lista.getEntries()) {
          this.gcVentana.n++;
          this.gcVentana.ms += e.duration;
          this.gcVentana.maxMs = Math.max(this.gcVentana.maxMs, e.duration);
          if (e.duration < GC_LENTO_MS) continue;
          this.gc.push({ t: Date.now(), tipo: "gc", ms: r2(e.duration) });
          if (this.gc.length > MAX_TIRONES) this.gc.shift();
        }
      });
      this.observadorGc.observe({ entryTypes: ["gc"] });
    } catch {
      this.observadorGc = null;
    }
  }
  private sala(sala: Sala) {
    let datos = this.salas.get(sala);
    if (!datos) this.salas.set(sala, (datos = { ticks: new VentanaMetricas(600), pendientes: 0, tirones: [], costo: costoVacio() }));
    return datos;
  }
  private anotar(sala: Sala, tiron: Tiron): void {
    const lista = this.sala(sala).tirones;
    lista.push(tiron);
    if (lista.length > MAX_TIRONES) lista.shift();
    if (tiron.ms < TICK_LENTO_MS) return;
    this.recientes.push({ ...tiron, sala: sala.codigo, circuito: sala.circuito.id });
    if (this.recientes.length > MAX_RECIENTES) this.recientes.shift();
  }
  registrarTick(sala: Sala, ms: number): void {
    const datos = this.sala(sala);
    datos.ticks.registrar(ms);
    datos.costo.tickMs += ms;
    datos.costo.ticks++;
    if (ms < TICK_LENTO_MS) return;
    const detalle: Record<string, number> = {};
    for (const [k, v] of Object.entries(sala.perfilPaso ?? {})) detalle[k] = r2(v);
    this.anotar(sala, { t: Date.now(), tipo: "tick", ms: r2(ms), detalle });
  }
  /** Una ráfaga de controles de `jugador` aplicada de golpe (`aplicados` pasos de física) */
  registrarControles(sala: Sala, ms: number, jugador: string, recibidos: number, aplicados: number): void {
    this.sala(sala).costo.controlesMs += ms;
    if (ms < CONTROLES_LENTOS_MS) return;
    this.anotar(sala, { t: Date.now(), tipo: "controles", ms: r2(ms), detalle: { jugador, recibidos, aplicados, entidades: sala.entidades.length } });
  }
  /** Armar y mandar la instantánea (`bytes` del texto, 0 si no se midió; a `destinos` jugadores) */
  registrarEstado(sala: Sala, ms: number, bytes: number, destinos: number): void {
    const c = this.sala(sala).costo;
    c.estadoMs += ms;
    c.estados++;
    if (bytes > 0) {
      c.bytes += bytes;
      c.medidos++;
    }
    if (ms < ESTADO_LENTO_MS) return;
    this.anotar(sala, { t: Date.now(), tipo: "estado", ms: r2(ms), detalle: { bytes, destinos, entidades: sala.entidades.length } });
  }
  /** avisarPartida: eventos, fases, premios, cambio de pista */
  registrarAvisos(sala: Sala, ms: number): void {
    this.sala(sala).costo.avisosMs += ms;
  }
  /** Lo que esperaba salir en el canal rápido de alguien de la sala al mandarle un estado (bytes) */
  registrarCanalBuffer(sala: Sala, bytes: number): void {
    const c = this.sala(sala).costo;
    c.canalBufferMax = Math.max(c.canalBufferMax, bytes);
  }
  /** Los tirones de la sala desde la última vez (y se olvidan) */
  tomarTirones(sala: Sala): Tiron[] {
    const datos = this.sala(sala);
    const lista = datos.tirones;
    datos.tirones = [];
    return lista;
  }
  /** Lo que gastó la sala desde la última vez (y se reinicia) */
  tomarCosto(sala: Sala): CostoSala {
    const datos = this.sala(sala);
    const costo = datos.costo;
    datos.costo = costoVacio();
    return costo;
  }
  /** El GC de todo el proceso desde la última vez (y se reinicia): lo toma el Status una vez por muestra */
  tomarGc(): VentanaGc {
    const v = this.gcVentana;
    this.gcVentana = { n: 0, ms: 0, maxMs: 0 };
    return { n: v.n, ms: r2(v.ms), maxMs: r2(v.maxMs) };
  }
  /** Las pausas del recolector de basura desde `desde` (ms de Date.now()) */
  gcDesde(desde: number): Tiron[] {
    return this.gc.filter((g) => g.t >= desde);
  }
  /** Los tirones de las demás salas (no `codigo`) desde `desde` (ms de Date.now()) */
  vecinosDesde(desde: number, codigo: string): TironVecino[] {
    return this.recientes.filter((t) => t.t >= desde && t.sala !== codigo);
  }
  pendientes(sala: Sala, ticks: number): void {
    const datos = this.sala(sala);
    datos.pendientes = ticks;
    if (ticks > 0) {
      datos.costo.continuaciones++;
      datos.costo.pendientesMax = Math.max(datos.costo.pendientesMax, ticks);
    }
  }
  resumen(sala: Sala | null) {
    const datos = sala ? this.sala(sala) : null;
    return {
      bucleP95: Math.round(this.bucle.percentile(95) / 1e4) / 100,
      bucleMax: Math.round(this.bucle.max / 1e4) / 100,
      tick: datos?.ticks.resumen() ?? null,
      pendientes: datos?.pendientes ?? 0,
      cola: sala ? [...sala.jugadores.values()].reduce((suma, j) => suma + j.cola.length, 0) : 0,
    };
  }
  cerrar(): void {
    this.bucle.disable();
    this.observadorGc?.disconnect();
  }
}
