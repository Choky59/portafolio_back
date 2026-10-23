/**
 * Tokens and cost of the analysis, per day (Hermosillo) and model, in pulsoConsumo,
 * plus the daily cap so a bug or a huge backlog can't run up the bill.
 */
import { Database } from "../../../middlewares/database/mongodb";
import { PULSO_PRECIO_BUSQUEDA_DEFAULT, PULSO_PRECIO_DEFAULT, PULSO_PRESUPUESTO_MAX_DEFAULT, PULSO_TOKENS_DIA_DEFAULT } from "../../../constants/pulso";
import { ZONA_HORARIA } from "../../../constants/sePuedeSalir";
import { IUso } from "./proveedor";

export function hoy(fecha = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA }).format(fecha);
}

export function precio(): { entrada: number; salida: number; busqueda: number } {
  return {
    entrada: Number(process.env.PULSO_PRECIO_ENTRADA) || PULSO_PRECIO_DEFAULT.entrada,
    salida: Number(process.env.PULSO_PRECIO_SALIDA) || PULSO_PRECIO_DEFAULT.salida,
    busqueda: Number(process.env.PULSO_PRECIO_BUSQUEDA) || PULSO_PRECIO_BUSQUEDA_DEFAULT,
  };
}

export function costo(uso: IUso): number {
  const p = precio();
  return (uso.entrada / 1e6) * p.entrada + (uso.salida / 1e6) * p.salida + (uso.busquedas ?? 0) * p.busqueda;
}

export async function registrar(modelo: string, uso: IUso): Promise<void> {
  await Database.Pulso.Consumo().updateOne(
    { fecha: hoy(), modelo },
    { $inc: { llamadas: 1, entrada: uso.entrada, salida: uso.salida, busquedas: uso.busquedas ?? 0, costoUSD: costo(uso) } },
    { upsert: true }
  );
}

/** Tokens (in + out) used today across models */
export async function tokensHoy(): Promise<number> {
  const filas = await Database.Pulso.Consumo().find({ fecha: hoy() }).toArray();
  return filas.reduce((s, f) => s + f.entrada + f.salida, 0);
}

export function topeDiario(): number {
  return Number(process.env.PULSO_TOKENS_DIA) || PULSO_TOKENS_DIA_DEFAULT;
}

export function presupuestoMaximo(): number {
  return Number(process.env.PULSO_PRESUPUESTO_MAX) || PULSO_PRESUPUESTO_MAX_DEFAULT;
}

/**
 * Today's token cap for a job: the daily cap (a safety net against bugs), or the tokens
 * its approved budget pays for if that's more (the budget is the admin's explicit limit).
 * Priced as the analysis uses them: about 3 tokens in for each one out.
 */
export function topeDelTrabajo(presupuestoUSD: number): number {
  const p = precio();
  const porMillon = 0.75 * p.entrada + 0.25 * p.salida;
  return Math.max(topeDiario(), Math.round((presupuestoUSD / porMillon) * 1e6));
}
