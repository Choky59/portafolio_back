export const SE_PUEDE_SALIR_SLUG = "se-puede-salir";

export type EstadoClave = "frio" | "ideal" | "calor" | "extremo";

export interface IEstado {
  clave: EstadoClave;
  etiqueta: string;
  emoji: string;
  color: string;
}

/**
 * < 20 → ¡ya, suéter! · 20–30 → increíble · 30–35 → se aguanta · > 35 → mejor ni asomarse
 */
export function estadoPorTemperatura(temperatura: number): IEstado {
  if (temperatura < 20) {
    return { clave: "frio", etiqueta: "¡Ya, suéter!", emoji: "🧥", color: "#8FA8D8" };
  }
  if (temperatura < 30) {
    return { clave: "ideal", etiqueta: "Increíble", emoji: "🍃", color: "#7FB7A4" };
  }
  if (temperatura <= 35) {
    return { clave: "calor", etiqueta: "Se aguanta", emoji: "😎", color: "#F4B33A" };
  }
  return { clave: "extremo", etiqueta: "Mejor ni asomarse", emoji: "🔥", color: "#E4572E" };
}

/** A sensor that hasn't reported in this long is shown as offline */
export const OFFLINE_AFTER_MS = 2 * 60 * 1000;

export const HISTORIAL_MAX_HORAS = 72;
export const HISTORIAL_BIN_MINUTOS = 10;

/** Telemetry readings are kept this long (TTL index) */
export const TELEMETRY_TTL_DAYS = 90;
