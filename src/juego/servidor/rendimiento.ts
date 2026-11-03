import { monitorEventLoopDelay } from "node:perf_hooks";
import { VentanaMetricas } from "../compartido/metricas";
import type { Sala } from "./salas";

export class RendimientoServidor {
  private bucle = monitorEventLoopDelay({ resolution: 10 });
  private salas = new WeakMap<Sala, { ticks: VentanaMetricas; pendientes: number }>();
  constructor() { this.bucle.enable(); }
  private sala(sala: Sala) {
    let datos = this.salas.get(sala);
    if (!datos) this.salas.set(sala, (datos = { ticks: new VentanaMetricas(600), pendientes: 0 }));
    return datos;
  }
  registrarTick(sala: Sala, ms: number): void { this.sala(sala).ticks.registrar(ms); }
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
  cerrar(): void { this.bucle.disable(); }
}
