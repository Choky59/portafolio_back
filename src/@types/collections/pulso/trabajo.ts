import { ObjectId } from "mongodb";

export type EstadoTrabajo = "en_cola" | "corriendo" | "terminado" | "cancelado" | "detenido";

/**
 * An analysis run started by the admin (pulsoTrabajos): a fixed list of captures, a
 * budget, and its progress. Nothing is analyzed unless it's in a job.
 */
export interface ITrabajo {
  _id?: ObjectId;
  creadoEn: Date;
  creadoPor: string;
  /** What was asked (for the record) */
  filtros: { desde: string | null; hasta: string | null; fuentes: string[] };
  /** Captures to analyze, fixed when the job is created (already analyzed ones are left out) */
  capturas: ObjectId[];
  /** Stop once the job has spent this much (USD) */
  presupuestoUSD: number;
  /** What it was expected to cost when created */
  estimadoUSD: number;
  /** Also search the internet for other outlets' coverage of its events (billed per search) */
  buscarWeb?: boolean;
  estado: EstadoTrabajo;
  /** Set by the admin to stop it; the runner checks it before each capture */
  cancelar: boolean;
  progreso: { hechas: number; notas: number; errores: number; entrada: number; salida: number; costoUSD: number };
  /** Why it stopped (budget, daily cap, provider, cancelled...) */
  motivo: string | null;
  ultimoError: string | null;
  iniciadoEn: Date | null;
  terminadoEn: Date | null;
}
