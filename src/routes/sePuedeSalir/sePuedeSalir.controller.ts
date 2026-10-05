import { Request, Response } from "express";
import { sendSuccessResponse } from "../../constants/successResponse";
import {
  HISTORIAL_BIN_MINUTOS,
  OFFLINE_AFTER_MS,
  SE_PUEDE_SALIR_SLUG,
  estadoPorTemperatura,
} from "../../constants/sePuedeSalir";
import * as TelemetriaService from "../telemetria/telemetria.service";

/**
 * GET /se-puede-salir/estado  (public)
 * temperatura/estado are null until the first reading arrives.
 */
export async function getEstado(_req: Request, res: Response): Promise<Response> {
  const last = await TelemetriaService.findLastReading(SE_PUEDE_SALIR_SLUG);

  if (!last) {
    return sendSuccessResponse(res, 200, {
      temperatura: null,
      humedad: null,
      estado: null,
      medidoEn: null,
      enLinea: false,
    });
  }

  return sendSuccessResponse(res, 200, {
    temperatura: last.temperatura,
    humedad: last.humedad,
    estado: estadoPorTemperatura(last.temperatura),
    medidoEn: last.medidoEn,
    enLinea: Date.now() - last.medidoEn.getTime() <= OFFLINE_AFTER_MS,
  });
}

/**
 * GET /se-puede-salir/historial?horas=24  (public)
 */
export async function getHistorial(req: Request, res: Response): Promise<Response> {
  const horas = req.query.horas ? parseInt(req.query.horas as string) : 24;

  const puntos = await TelemetriaService.findHistorial(
    SE_PUEDE_SALIR_SLUG,
    horas,
    HISTORIAL_BIN_MINUTOS
  );

  return sendSuccessResponse(res, 200, {
    horas,
    intervaloMinutos: HISTORIAL_BIN_MINUTOS,
    puntos,
  });
}
