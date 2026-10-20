// routes/sePuedeSalir/sePuedeSalir.service.ts
import {
  ANALISIS_CACHE_MS,
  ESTADOS,
  EstadoClave,
  FRANJAS,
  Franja,
  HISTORIAL_BIN_MINUTOS,
  INICIO_JORNADA_HORA,
  SE_PUEDE_SALIR_SLUG,
  ZONA_HORARIA,
  estadoPorTemperatura,
} from "../../constants/sePuedeSalir";
import * as TelemetriaService from "../telemetria/telemetria.service";

const r1 = (n: number) => Math.round(n * 10) / 10;

export interface IResumenTemperatura {
  min: number;
  max: number;
  promedio: number;
  lecturas: number;
}

export interface IDiaAnalisis extends IResumenTemperatura {
  /** yyyy-mm-dd: the day that starts at 06:00 local time */
  fecha: string;
  /** State of the day's average (calendar color) */
  estado: EstadoClave;
  franjas: Record<Franja, IResumenTemperatura | null>;
}

export interface IAnalisis {
  desde: Date | null;
  hasta: Date | null;
  zonaHoraria: string;
  totalLecturas: number;
  franjas: typeof FRANJAS;
  dias: IDiaAnalisis[];
  diaTipico: ({ hora: number } & Omit<IResumenTemperatura, "lecturas">)[];
  estados: (typeof ESTADOS[EstadoClave] & { lecturas: number; porcentaje: number })[];
  records: {
    maxima: { temperatura: number; medidoEn: Date } | null;
    minima: { temperatura: number; medidoEn: Date } | null;
    diaMasCaliente: { fecha: string; promedio: number } | null;
    diaMasFresco: { fecha: string; promedio: number } | null;
  };
  bateria: { hora: Date; porcentaje: number; voltaje: number | null }[];
}

function resumen(g: IResumenTemperatura): IResumenTemperatura {
  return { min: r1(g.min), max: r1(g.max), promedio: r1(g.promedio), lecturas: g.lecturas };
}

/** Turns the raw aggregation into the API shape (rounded, ordered, with records) */
async function calcularAnalisis(dias: number): Promise<IAnalisis> {
  const crudo = await TelemetriaService.analizarLecturas(SE_PUEDE_SALIR_SLUG, dias);
  const rango = crudo.rango[0] ?? null;

  // Franjas indexed by day, so each day carries its three parts
  const franjasPorDia = new Map<string, Partial<Record<Franja, IResumenTemperatura>>>();
  for (const f of crudo.franjas) {
    const dia = franjasPorDia.get(f._id.jornada) ?? {};
    dia[f._id.franja] = resumen(f);
    franjasPorDia.set(f._id.jornada, dia);
  }

  const listaDias: IDiaAnalisis[] = crudo.dias.map((d) => {
    const partes = franjasPorDia.get(d._id) ?? {};
    return {
      fecha: d._id,
      ...resumen(d),
      estado: estadoPorTemperatura(d.promedio).clave,
      franjas: { manana: partes.manana ?? null, tarde: partes.tarde ?? null, noche: partes.noche ?? null },
    };
  });

  const total = rango?.total ?? 0;
  const lecturasPorEstado = new Map(crudo.estados.map((e) => [e._id, e.lecturas]));
  const estados = (Object.keys(ESTADOS) as EstadoClave[]).map((clave) => {
    const lecturas = lecturasPorEstado.get(clave) ?? 0;
    return { ...ESTADOS[clave], lecturas, porcentaje: total ? r1((lecturas / total) * 100) : 0 };
  });

  const porPromedio = [...listaDias].sort((a, b) => b.promedio - a.promedio);
  const extremoDia = (d: IDiaAnalisis | undefined) => (d ? { fecha: d.fecha, promedio: d.promedio } : null);
  const extremoLectura = (l: { temperatura: number; medidoEn: Date } | undefined) =>
    l ? { temperatura: r1(l.temperatura), medidoEn: l.medidoEn } : null;

  return {
    desde: rango?.desde ?? null,
    hasta: rango?.hasta ?? null,
    zonaHoraria: ZONA_HORARIA,
    totalLecturas: total,
    franjas: FRANJAS,
    dias: listaDias,
    diaTipico: crudo.diaTipico.map((h) => ({ hora: h._id, min: r1(h.min), max: r1(h.max), promedio: r1(h.promedio) })),
    estados,
    records: {
      maxima: extremoLectura(crudo.maxima[0]),
      minima: extremoLectura(crudo.minima[0]),
      diaMasCaliente: extremoDia(porPromedio[0]),
      diaMasFresco: extremoDia(porPromedio[porPromedio.length - 1]),
    },
    bateria: crudo.bateria.map((b) => ({
      hora: b._id,
      porcentaje: Math.round(b.porcentaje),
      voltaje: b.voltaje == null ? null : Math.round(b.voltaje * 100) / 100,
    })),
  };
}

/* The data changes every 30 s but the analysis doesn't need to: recompute at most every 5 min */
const cache = new Map<number, { en: number; datos: Promise<IAnalisis> }>();

export function obtenerAnalisis(dias: number): Promise<IAnalisis> {
  const guardado = cache.get(dias);
  if (guardado && Date.now() - guardado.en < ANALISIS_CACHE_MS) return guardado.datos;

  const datos = calcularAnalisis(dias);
  cache.set(dias, { en: Date.now(), datos });
  // A failed computation must not stay cached
  datos.catch(() => cache.delete(dias));
  return datos;
}

/** Tests insert readings and need a fresh computation */
export function limpiarCacheAnalisis() {
  cache.clear();
}

/* ------------------------------ One day's chart ------------------------------ */

/** Minutes the zone is ahead of UTC at that instant (Hermosillo: −420) */
function desfaseMinutos(instante: number): number {
  const nombre = new Intl.DateTimeFormat("en-US", { timeZone: ZONA_HORARIA, timeZoneName: "longOffset" })
    .formatToParts(instante)
    .find((p) => p.type === "timeZoneName")?.value; // "GMT-07:00" (or "GMT" at UTC)
  const m = nombre?.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** [06:00 local of `fecha`, 06:00 local of the next day): the same "day" as the calendar */
export function rangoJornada(fecha: string): { desde: Date; hasta: Date } {
  const [y, m, d] = fecha.split("-").map(Number);
  const local = (dia: number) => {
    const comoUtc = Date.UTC(y, m - 1, dia, INICIO_JORNADA_HORA);
    return new Date(comoUtc - desfaseMinutos(comoUtc) * 60000);
  };
  return { desde: local(d), hasta: local(d + 1) };
}

/** Readings of one calendar day, averaged every 10 min */
export async function obtenerDia(fecha: string) {
  const { desde, hasta } = rangoJornada(fecha);
  const puntos = await TelemetriaService.findSerie(SE_PUEDE_SALIR_SLUG, desde, hasta, HISTORIAL_BIN_MINUTOS);
  return { fecha, desde, hasta, intervaloMinutos: HISTORIAL_BIN_MINUTOS, puntos };
}
