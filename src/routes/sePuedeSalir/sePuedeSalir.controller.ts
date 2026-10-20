import { Request, Response } from "express";
import { sendSuccessResponse } from "../../constants/successResponse";
import {
  ANALISIS_MAX_DIAS,
  HISTORIAL_BIN_MINUTOS,
  OFFLINE_AFTER_MS,
  SE_PUEDE_SALIR_SLUG,
  estadoPorTemperatura,
} from "../../constants/sePuedeSalir";
import { BATERIA_BAJA_PCT } from "../../constants/devices";
import { ITelemetry } from "../../@types/collections/devices/telemetry";
import * as TelemetriaService from "../telemetria/telemetria.service";
import * as SePuedeSalirService from "./sePuedeSalir.service";

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
      bateria: null,
    });
  }

  return sendSuccessResponse(res, 200, {
    temperatura: last.temperatura,
    humedad: last.humedad,
    estado: estadoPorTemperatura(last.temperatura),
    medidoEn: last.medidoEn,
    enLinea: Date.now() - last.medidoEn.getTime() <= OFFLINE_AFTER_MS,
    bateria: bateriaDe(last),
  });
}

/** Battery of the reading; readings from before battery support (or old firmware) have none */
function bateriaDe(lectura: ITelemetry) {
  if (lectura.bateriaPorcentaje == null || lectura.bateriaVoltaje == null) return null;
  return {
    voltaje: lectura.bateriaVoltaje,
    porcentaje: lectura.bateriaPorcentaje,
    baja: lectura.bateriaPorcentaje < BATERIA_BAJA_PCT,
  };
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

/**
 * GET /se-puede-salir/dia?fecha=2026-10-14  (public)
 * Readings of one calendar day (06:00 → 05:59 local), averaged every 10 minutes.
 */
export async function getDia(req: Request, res: Response): Promise<Response> {
  const dia = await SePuedeSalirService.obtenerDia(req.query.fecha as string);
  return sendSuccessResponse(res, 200, dia);
}

/**
 * GET /se-puede-salir/analisis?dias=90  (public)
 * Calendar (min / max / average per day and per morning, afternoon and night),
 * typical day by hour, time in each state, records and battery.
 */
export async function getAnalisis(req: Request, res: Response): Promise<Response> {
  const dias = req.query.dias ? parseInt(req.query.dias as string) : ANALISIS_MAX_DIAS;
  const analisis = await SePuedeSalirService.obtenerAnalisis(dias);
  return sendSuccessResponse(res, 200, analisis);
}
