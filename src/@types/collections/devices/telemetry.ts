import { ObjectId } from "mongodb";

export interface ITelemetry {
  _id?: ObjectId;
  deviceId: string;
  /** Project slug the device was assigned to when it sent the reading */
  proyecto: string;
  /** °C */
  temperatura: number;
  /** % relative humidity, if the sensor supports it */
  humedad: number | null;
  /** Battery voltage (V) and estimated charge (%), if the device reports it */
  bateriaVoltaje: number | null;
  bateriaPorcentaje: number | null;
  medidoEn: Date;
}
