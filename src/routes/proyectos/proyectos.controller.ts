import { Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";
import { sendSuccessResponse } from "../../constants/successResponse";
import * as ProyectosService from "./proyectos.service";

export async function getProyectos(_req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, { proyectos: ProyectosService.listProyectos() });
}

export async function getProyecto(req: Request, res: Response): Promise<Response> {
  const slug = req.params.slug as string;
  const found = ProyectosService.findProyecto(slug);

  if (!found) {
    return sendErrorResponse(res, 404, {
      key: "PROYECTO_NOT_FOUND",
      message: "Proyecto not found",
      slug,
    });
  }

  return sendSuccessResponse(res, 200, {
    ...found,
    proyecto: await ProyectosService.conVideosAsignados(found.proyecto),
  });
}
