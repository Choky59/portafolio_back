export const SE_PUEDE_SALIR_SLUG = "se-puede-salir";

export type EstadoClave = "frio" | "ideal" | "calor" | "extremo";

export interface IEstado {
  clave: EstadoClave;
  etiqueta: string;
  emoji: string;
  color: string;
}

/**
 * State thresholds (°C), shared by the live dashboard and the analysis aggregation:
 *   t < frio → frio · t < ideal → ideal · t <= calor → calor · otherwise → extremo
 */
export const UMBRALES = { frio: 20, ideal: 30, calor: 35 } as const;

export const ESTADOS: Record<EstadoClave, IEstado> = {
  frio: { clave: "frio", etiqueta: "¡Ya, suéter!", emoji: "🧥", color: "#8FA8D8" },
  ideal: { clave: "ideal", etiqueta: "Increíble", emoji: "🍃", color: "#7FB7A4" },
  calor: { clave: "calor", etiqueta: "Se aguanta", emoji: "😎", color: "#F4B33A" },
  extremo: { clave: "extremo", etiqueta: "Mejor ni asomarse", emoji: "🔥", color: "#E4572E" },
};

/**
 * < 20 → ¡ya, suéter! · 20–30 → increíble · 30–35 → se aguanta · > 35 → mejor ni asomarse
 */
export function estadoPorTemperatura(temperatura: number): IEstado {
  if (temperatura < UMBRALES.frio) return ESTADOS.frio;
  if (temperatura < UMBRALES.ideal) return ESTADOS.ideal;
  if (temperatura <= UMBRALES.calor) return ESTADOS.calor;
  return ESTADOS.extremo;
}

/** A sensor that hasn't reported in this long is shown as offline */
export const OFFLINE_AFTER_MS = 2 * 60 * 1000;

export const HISTORIAL_MAX_HORAS = 72;
export const HISTORIAL_BIN_MINUTOS = 10;

/** Telemetry readings are kept this long (TTL index) */
export const TELEMETRY_TTL_DAYS = 90;

/* ---------------------------------- Analysis ---------------------------------- */

export const ZONA_HORARIA = "America/Hermosillo";

/** Analysis covers at most what the TTL keeps */
export const ANALISIS_MAX_DIAS = TELEMETRY_TTL_DAYS;

/** A "day" runs 06:00 → 05:59 next day, so a night crossing midnight stays in one day */
export const INICIO_JORNADA_HORA = 6;

/** Local-hour ranges [desde, hasta) of each part of the day; noche wraps midnight */
export const FRANJAS = {
  manana: { desde: 6, hasta: 12 },
  tarde: { desde: 12, hasta: 19 },
  noche: { desde: 19, hasta: 6 },
} as const;

export type Franja = keyof typeof FRANJAS;

/** The analysis is recomputed at most this often */
export const ANALISIS_CACHE_MS = 5 * 60 * 1000;
