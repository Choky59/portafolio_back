// routes/telemetria/telemetria.service.ts
import { ITelemetry } from "../../@types/collections/devices/telemetry";
import { Database } from "../../middlewares/database/mongodb";
import {
  EstadoClave,
  FRANJAS,
  Franja,
  INICIO_JORNADA_HORA,
  UMBRALES,
  ZONA_HORARIA,
} from "../../constants/sePuedeSalir";

export async function insertReading(reading: ITelemetry): Promise<boolean> {
  const result = await Database.Devices.Telemetry().insertOne(reading);
  return result.acknowledged === true;
}

export async function findLastReading(proyecto: string): Promise<ITelemetry | null> {
  return await Database.Devices.Telemetry().findOne(
    { proyecto },
    { sort: { medidoEn: -1 } }
  );
}

export interface IPuntoHistorial {
  medidoEn: Date;
  temperatura: number;
  /** Lowest / highest single reading in the bucket (a short spike shows here, not in the average) */
  min: number;
  max: number;
  humedad: number | null;
}

/**
 * Average readings in fixed time buckets (e.g. every 10 min) for the last N hours.
 */
export async function findHistorial(
  proyecto: string,
  horas: number,
  binMinutos: number
): Promise<IPuntoHistorial[]> {
  const desde = new Date(Date.now() - horas * 60 * 60 * 1000);
  return findSerie(proyecto, desde, new Date(), binMinutos);
}

/**
 * Average readings in fixed time buckets inside [desde, hasta).
 */
export async function findSerie(
  proyecto: string,
  desde: Date,
  hasta: Date,
  binMinutos: number
): Promise<IPuntoHistorial[]> {
  const rows = await Database.Devices.Telemetry()
    .aggregate<{ _id: Date; temperatura: number; min: number; max: number; humedad: number | null }>([
      { $match: { proyecto, medidoEn: { $gte: desde, $lt: hasta } } },
      {
        $group: {
          _id: { $dateTrunc: { date: "$medidoEn", unit: "minute", binSize: binMinutos } },
          temperatura: { $avg: "$temperatura" },
          min: { $min: "$temperatura" },
          max: { $max: "$temperatura" },
          humedad: { $avg: "$humedad" },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return rows.map((r) => ({
    medidoEn: r._id,
    temperatura: Math.round(r.temperatura * 10) / 10,
    min: Math.round(r.min * 10) / 10,
    max: Math.round(r.max * 10) / 10,
    humedad: r.humedad == null ? null : Math.round(r.humedad),
  }));
}

/* -------------------------------------------------------------------------- */
/*                                  Analysis                                  */
/* -------------------------------------------------------------------------- */

interface IGrupoTemperatura {
  min: number;
  max: number;
  promedio: number;
  lecturas: number;
}

export interface IAnalisisCrudo {
  rango: { desde: Date; hasta: Date; total: number }[];
  dias: ({ _id: string } & IGrupoTemperatura)[];
  franjas: ({ _id: { jornada: string; franja: Franja } } & IGrupoTemperatura)[];
  diaTipico: ({ _id: number } & IGrupoTemperatura)[];
  estados: { _id: EstadoClave; lecturas: number }[];
  maxima: { temperatura: number; medidoEn: Date }[];
  minima: { temperatura: number; medidoEn: Date }[];
  bateria: { _id: Date; porcentaje: number; voltaje: number | null }[];
}

const temperaturas = {
  min: { $min: "$temperatura" },
  max: { $max: "$temperatura" },
  promedio: { $avg: "$temperatura" },
  lecturas: { $sum: 1 },
};

/** Local hour inside [desde, hasta), for franjas that may wrap midnight */
function enRango(hora: string, desde: number, hasta: number) {
  return desde < hasta
    ? { $and: [{ $gte: [hora, desde] }, { $lt: [hora, hasta] }] }
    : { $or: [{ $gte: [hora, desde] }, { $lt: [hora, hasta] }] };
}

/**
 * One pass over the last `dias` days of readings (index { proyecto, medidoEn }).
 * - jornada: local date of (medidoEn − 6 h), so a day runs 06:00 → 05:59 and the
 *   night that crosses midnight belongs to the day it started.
 * - franja / estado use the shared constants, same as the live dashboard.
 */
export async function analizarLecturas(proyecto: string, dias: number): Promise<IAnalisisCrudo> {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  const [crudo] = await Database.Devices.Telemetry()
    .aggregate<IAnalisisCrudo>(
      [
        { $match: { proyecto, medidoEn: { $gte: desde } } },
        {
          $addFields: {
            _hora: { $hour: { date: "$medidoEn", timezone: ZONA_HORARIA } },
            _jornada: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: { $dateSubtract: { startDate: "$medidoEn", unit: "hour", amount: INICIO_JORNADA_HORA } },
                timezone: ZONA_HORARIA,
              },
            },
          },
        },
        {
          $addFields: {
            _franja: {
              $switch: {
                branches: (Object.keys(FRANJAS) as Franja[]).map((f) => ({
                  case: enRango("$_hora", FRANJAS[f].desde, FRANJAS[f].hasta),
                  then: f,
                })),
                default: "noche",
              },
            },
            _estado: {
              $switch: {
                branches: [
                  { case: { $lt: ["$temperatura", UMBRALES.frio] }, then: "frio" },
                  { case: { $lt: ["$temperatura", UMBRALES.ideal] }, then: "ideal" },
                  { case: { $lte: ["$temperatura", UMBRALES.calor] }, then: "calor" },
                ],
                default: "extremo",
              },
            },
          },
        },
        {
          $facet: {
            rango: [{ $group: { _id: null, desde: { $min: "$medidoEn" }, hasta: { $max: "$medidoEn" }, total: { $sum: 1 } } }],
            dias: [{ $group: { _id: "$_jornada", ...temperaturas } }, { $sort: { _id: 1 } }],
            franjas: [{ $group: { _id: { jornada: "$_jornada", franja: "$_franja" }, ...temperaturas } }],
            diaTipico: [{ $group: { _id: "$_hora", ...temperaturas } }, { $sort: { _id: 1 } }],
            estados: [{ $group: { _id: "$_estado", lecturas: { $sum: 1 } } }],
            maxima: [{ $sort: { temperatura: -1, medidoEn: 1 } }, { $limit: 1 }, { $project: { _id: 0, temperatura: 1, medidoEn: 1 } }],
            minima: [{ $sort: { temperatura: 1, medidoEn: 1 } }, { $limit: 1 }, { $project: { _id: 0, temperatura: 1, medidoEn: 1 } }],
            bateria: [
              { $match: { bateriaPorcentaje: { $type: "number" } } },
              {
                $group: {
                  _id: { $dateTrunc: { date: "$medidoEn", unit: "hour" } },
                  porcentaje: { $avg: "$bateriaPorcentaje" },
                  voltaje: { $avg: "$bateriaVoltaje" },
                },
              },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ],
      { allowDiskUse: true }
    )
    .toArray();

  return crudo;
}
