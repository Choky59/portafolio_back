/** Small bounded windows, shared by server timing and client RTT/confirmation metrics. */
export class VentanaMetricas {
  private muestras: number[] = [];
  private cabeza = 0;
  constructor(private readonly capacidad = 300) {}
  registrar(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    if (this.muestras.length < this.capacidad) this.muestras.push(ms);
    else { this.muestras[this.cabeza] = ms; this.cabeza = (this.cabeza + 1) % this.capacidad; }
  }
  resumen() {
    const orden = [...this.muestras].sort((a, b) => a - b);
    const percentil = (p: number) => orden.length ? orden[Math.max(0, Math.ceil(orden.length * p) - 1)] : 0;
    const red = (n: number) => Math.round(n * 100) / 100;
    return { n: orden.length, p50: red(percentil(0.5)), p95: red(percentil(0.95)), p99: red(percentil(0.99)), max: red(orden.at(-1) ?? 0) };
  }
}

/** A bounded catch-up turn. Remaining ticks are retained, never skipped. */
export function procesarTicks(actual: () => number, hasta: number, paso: () => void, ahora: () => number, maxPasos = 4, presupuestoMs = 4): number {
  const inicio = ahora();
  let pasos = 0;
  while (actual() < hasta && pasos < maxPasos) {
    if (pasos && ahora() - inicio >= presupuestoMs) break;
    paso(); pasos++;
  }
  return Math.max(0, hasta - actual());
}

/** Fixed steps can be pumped by a timer and by rendering without executing a tick twice. */
export class RelojPasosFijos {
  private acumulado = 0;
  constructor(private readonly tick: number, private ultimo: number) {}
  private transcurrido(ahora: number) { return Math.max(0, Math.min(0.25, (ahora - this.ultimo) / 1000)); }
  avanzar(ahora: number, paso: () => void, maxPasos = 4): number {
    if (ahora > this.ultimo) { this.acumulado += this.transcurrido(ahora); this.ultimo = ahora; }
    let n = 0;
    while (this.acumulado + 1e-10 >= this.tick && n < maxPasos) {
      this.acumulado = Math.max(0, this.acumulado - this.tick);
      paso(); n++;
    }
    return n;
  }
  fraccion(ahora: number): number { return Math.min(1, (this.acumulado + this.transcurrido(ahora)) / this.tick); }
  hastaSiguiente(ahora: number): number { return Math.max(0, this.tick - this.acumulado - this.transcurrido(ahora)) * 1000; }
  retraso(ahora: number): number { return Math.max(0, this.acumulado + this.transcurrido(ahora) - this.tick) * 1000; }
}
