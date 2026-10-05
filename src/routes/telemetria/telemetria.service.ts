// routes/telemetria/telemetria.service.ts
import { ITelemetry } from "../../@types/collections/devices/telemetry";
import { Database } from "../../middlewares/database/mongodb";

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

  const rows = await Database.Devices.Telemetry()
    .aggregate<{ _id: Date; temperatura: number; humedad: number | null }>([
      { $match: { proyecto, medidoEn: { $gte: desde } } },
      {
        $group: {
          _id: { $dateTrunc: { date: "$medidoEn", unit: "minute", binSize: binMinutos } },
          temperatura: { $avg: "$temperatura" },
          humedad: { $avg: "$humedad" },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  return rows.map((r) => ({
    medidoEn: r._id,
    temperatura: Math.round(r.temperatura * 10) / 10,
    humedad: r.humedad == null ? null : Math.round(r.humedad),
  }));
}
