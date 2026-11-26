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

export const TICK_LENTO_MS = 15;
export const CONTROLES_LENTOS_MS = 5;
export const ESTADO_LENTO_MS = 5;
export const GC_LENTO_MS = 10;
/** Por sala, los últimos tirones (se los lleva el Status cada 5 s) */
const MAX_TIRONES = 50;

const r2 = (n: number) => Math.round(n * 100) / 100;

export class RendimientoServidor {
  private bucle = monitorEventLoopDelay({ resolution: 10 });
  private salas = new WeakMap<Sala, { ticks: VentanaMetricas; pendientes: number; tirones: Tiron[] }>();
  /** Las pausas del recolector de basura (son de todo el proceso, no de una sala) */
  private gc: Tiron[] = [];
  private observadorGc: PerformanceObserver | null = null;
  constructor() {
    this.bucle.enable();
    try {
      this.observadorGc = new PerformanceObserver((lista) => {
        for (const e of lista.getEntries()) {
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
    if (!datos) this.salas.set(sala, (datos = { ticks: new VentanaMetricas(600), pendientes: 0, tirones: [] }));
    return datos;
  }
  private anotar(sala: Sala, tiron: Tiron): void {
    const lista = this.sala(sala).tirones;
    lista.push(tiron);
    if (lista.length > MAX_TIRONES) lista.shift();
  }
  registrarTick(sala: Sala, ms: number): void {
    this.sala(sala).ticks.registrar(ms);
    if (ms < TICK_LENTO_MS) return;
    const detalle: Record<string, number> = {};
    for (const [k, v] of Object.entries(sala.perfilPaso ?? {})) detalle[k] = r2(v);
    this.anotar(sala, { t: Date.now(), tipo: "tick", ms: r2(ms), detalle });
  }
  /** Una ráfaga de controles de `jugador` aplicada de golpe (`aplicados` pasos de física) */
  registrarControles(sala: Sala, ms: number, jugador: string, recibidos: number, aplicados: number): void {
    if (ms < CONTROLES_LENTOS_MS) return;
    this.anotar(sala, { t: Date.now(), tipo: "controles", ms: r2(ms), detalle: { jugador, recibidos, aplicados, entidades: sala.entidades.length } });
  }
  /** Armar y mandar la instantánea (`bytes` del texto completo, a `destinos` jugadores) */
  registrarEstado(sala: Sala, ms: number, bytes: number, destinos: number): void {
    if (ms < ESTADO_LENTO_MS) return;
    this.anotar(sala, { t: Date.now(), tipo: "estado", ms: r2(ms), detalle: { bytes, destinos, entidades: sala.entidades.length } });
  }
  /** Los tirones de la sala desde la última vez (y se olvidan) */
  tomarTirones(sala: Sala): Tiron[] {
    const datos = this.sala(sala);
    const lista = datos.tirones;
    datos.tirones = [];
    return lista;
  }
  /** Las pausas del recolector de basura desde `desde` (ms de Date.now()) */
  gcDesde(desde: number): Tiron[] {
    return this.gc.filter((g) => g.t >= desde);
  }
  pendientes(sala: Sala, ticks: number): void { this.sala(sala).pendientes = ticks; }
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
