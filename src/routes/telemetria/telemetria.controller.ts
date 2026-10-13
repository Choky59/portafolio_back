import { Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";
import { sendSuccessResponse } from "../../constants/successResponse";
import { IDevice } from "../../@types/collections/devices/device";
import * as TelemetriaService from "./telemetria.service";
import * as DevicesService from "../devices/devices.service";

interface ILecturaBody {
  temperatura: number;
  humedad?: number | null;
  bateria?: { voltaje: number; porcentaje: number } | null;
}

/**
 * POST /telemetria  (deviceAuthorization)
 * The reading is stored under the project the device is assigned to.
 * If it includes the battery level, it's also kept on the device for the admin panel.
 */
export async function createReading(req: Request, res: Response): Promise<Response> {
  const device = res.locals.device as IDevice;
  const { temperatura, humedad, bateria } = req.body as ILecturaBody;

  if (!device.proyecto) {
    return sendErrorResponse(res, 409, {
      key: "DEVICE_WITHOUT_PROYECTO",
      message: "Device is not assigned to a project yet",
      deviceId: device.deviceId,
    });
  }

  const medidoEn = new Date();
  const ok = await TelemetriaService.insertReading({
    deviceId: device.deviceId,
    proyecto: device.proyecto,
    temperatura,
    humedad: humedad ?? null,
    bateriaVoltaje: bateria?.voltaje ?? null,
    bateriaPorcentaje: bateria?.porcentaje ?? null,
    medidoEn,
  });

  if (!ok) return sendErrorResponse(res, 501);

  if (bateria) {
    await DevicesService.actualizarBateria(device.deviceId, {
      voltaje: bateria.voltaje,
      porcentaje: bateria.porcentaje,
      medidaEn: medidoEn,
    });
  }

  return sendSuccessResponse(res, 201, { ok: true });
}
