/**
 * Local (Hermosillo) time fields of a note, computed in code so weekly / monthly /
 * by-hour analysis is a plain query. Hermosillo is UTC−7 all year (no daylight saving).
 * Only the time-of-day bucket and hour of the event come from the model.
 */
import { ITiempoLocal } from "../../../@types/collections/pulso/nota";
import { DIAS_SEMANA } from "../../../constants/pulso";
import { ZONA_HORARIA } from "../../../constants/sePuedeSalir";

const partes = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONA_HORARIA, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

/** yyyy-mm-dd and hour (0-23) of an instant, in Hermosillo */
function local(fecha: Date): { dia: string; hora: number } {
  const p = Object.fromEntries(partes.formatToParts(fecha).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}

/** Day of the week of a yyyy-mm-dd (a calendar date: no time zone involved) */
const diaSemana = (ymd: string) => DIAS_SEMANA[new Date(`${ymd}T12:00:00Z`).getUTCDay()];

/** ISO-8601 week of a yyyy-mm-dd, e.g. "2026-W42" (weeks start on Monday) */
export function semanaISO(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  // The week's Thursday decides its year; its day of the year, the week number
  const jueves = new Date(d);
  jueves.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const anio = jueves.getUTCFullYear();
  const diaDelAnio = Math.round((jueves.getTime() - Date.UTC(anio, 0, 1, 12)) / 86400000);
  const semana = Math.floor(diaDelAnio / 7) + 1;
  return `${anio}-W${String(semana).padStart(2, "0")}`;
}

export function tiempoLocal(
  publicadoEn: Date | null | undefined,
  fechas: { ocurrio: string | null; ocurrioFranja: string | null; ocurrioHora: number | null }
): ITiempoLocal {
  const pub = publicadoEn ? local(publicadoEn) : null;
  const ocurrio = fechas.ocurrio;
  const referencia = ocurrio ?? pub?.dia ?? null;
  const rezago = ocurrio && pub ? Math.round((Date.parse(`${pub.dia}T12:00:00Z`) - Date.parse(`${ocurrio}T12:00:00Z`)) / 86400000) : null;
  return {
    publicadoFecha: pub?.dia ?? null,
    publicadoHora: pub?.hora ?? null,
    publicadoDiaSemana: pub ? diaSemana(pub.dia) : null,
    ocurrioFecha: ocurrio,
    ocurrioDiaSemana: ocurrio ? diaSemana(ocurrio) : null,
    ocurrioFranja: fechas.ocurrioFranja,
    ocurrioHora: fechas.ocurrioHora,
    rezagoDias: rezago,
    semanaISO: referencia ? semanaISO(referencia) : null,
    mes: referencia ? referencia.slice(0, 7) : null,
  };
}
