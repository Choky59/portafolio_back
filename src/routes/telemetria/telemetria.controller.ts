import { Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";
import { sendSuccessResponse } from "../../constants/successResponse";
import { IDevice } from "../../@types/collections/devices/device";
import * as TelemetriaService from "./telemetria.service";

/**
 * POST /telemetria  (deviceAuthorization)
 * The reading is stored under the project the device is assigned to.
 */
export async function createReading(req: Request, res: Response): Promise<Response> {
  const device = res.locals.device as IDevice;
  const { temperatura, humedad } = req.body as { temperatura: number; humedad?: number | null };

  if (!device.proyecto) {
    return sendErrorResponse(res, 409, {
      key: "DEVICE_WITHOUT_PROYECTO",
      message: "Device is not assigned to a project yet",
      deviceId: device.deviceId,
    });
  }

  const ok = await TelemetriaService.insertReading({
    deviceId: device.deviceId,
    proyecto: device.proyecto,
    temperatura,
    humedad: humedad ?? null,
    medidoEn: new Date(),
  });

  if (!ok) return sendErrorResponse(res, 501);

  return sendSuccessResponse(res, 201, { ok: true });
}
