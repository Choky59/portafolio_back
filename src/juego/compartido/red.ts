import { empacarEscenario, type ObjetoRed } from "./escenario";
import type { Pista } from "./pista";

/** Interpolation is measured in simulation ticks, but must cover a network snapshot interval. */
export function colchonRed({ min, max, margen }: { min: number; max: number; margen: number }, tick: number, pasosPorEstado: number, atraso: number): number {
  return Math.min(max / tick, Math.max(min / tick, pasosPorEstado + atraso + margen));
}

export interface EstadoEscenarioRed {
  k: number;
  circuito: string;
  completo: boolean;
  o: ObjetoRed[];
}

export function estadoEscenario(pista: Pista, k: number): EstadoEscenarioRed {
  return { k, circuito: pista.circuito.id, completo: true, o: empacarEscenario(pista) };
}

/** Limits publication frequency without slowing physics or sending a burst after a stall. */
export class CadenciaEstado {
  private siguiente: number;
  private readonly intervalo: number;
  constructor(hz: number) {
    this.intervalo = 1000 / hz;
    this.siguiente = this.intervalo;
  }
  toca(ms: number): boolean {
    if (ms + 1e-6 < this.siguiente) return false;
    this.siguiente = (Math.floor((ms + 1e-6) / this.intervalo) + 1) * this.intervalo;
    return true;
  }
}

/** Active bodies are volatile; final poses and resets travel on the reliable event channel. */
export class EmisorEscenario {
  private pista: Pista | null = null;
  private anterior = new Map<string, ObjetoRed>();
  preparar(pista: Pista, k: number) {
    const todos = empacarEscenario(pista);
    const actuales = new Map(todos.map(o => [o[0], o]));
    const reinicio = this.pista !== pista || [...this.anterior.keys()].some(id => !actuales.has(id));
    const finales = todos.filter(o => !o[4] && !o[5] && !o[6] &&
      (!this.anterior.has(o[0]) || o.some((valor, i) => valor !== this.anterior.get(o[0])![i])));
    const cambio: EstadoEscenarioRed | null = reinicio || finales.length
      ? { k, circuito: pista.circuito.id, completo: reinicio, o: reinicio ? todos : finales }
      : null;
    this.pista = pista;
    this.anterior = actuales;
    return { todos, activos: todos.filter(o => !!(o[4] || o[5] || o[6])), cambio };
  }
}

/** Independent of predicted physics, so replay cannot corrupt the authoritative baseline. */
export class ReceptorEscenario {
  private objetos = new Map<string, ObjetoRed>();
  private circuito: string | null = null;
  private ultimo = -1;
  reiniciar(): void {
    this.objetos.clear();
    this.circuito = null;
    this.ultimo = -1;
  }
  recibir(estado: EstadoEscenarioRed): boolean {
    if (estado.k < this.ultimo || (!estado.completo && estado.circuito !== this.circuito)) return false;
    if (estado.completo) this.objetos.clear();
    this.circuito = estado.circuito;
    this.ultimo = estado.k;
    for (const o of estado.o) this.objetos.set(o[0], [...o]);
    return true;
  }
  activos(k: number, objetos: ObjetoRed[] = []): void {
    if (this.circuito === null || k < this.ultimo) return;
    this.ultimo = k;
    for (const o of objetos) this.objetos.set(o[0], [...o]);
  }
  estado(circuito: string): ObjetoRed[] | null {
    return this.circuito === circuito ? [...this.objetos.values()].map(o => [...o]) : null;
  }
}
