// routes/archivos/archivos.controller.ts
import { Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";
import { sendSuccessResponse } from "../../constants/successResponse";
import { StorageNotConfiguredError } from "../../middlewares/storage/firebaseStorage";
import * as ArchivosService from "./archivos.service";
import { ISolicitudSubida } from "./archivos.types";
import { parsePath } from "./archivos.helpers.misc";

/** Storage missing credentials -> 503 instead of a generic 500 */
async function conStorage(res: Response, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) {
      return sendErrorResponse(res, 503, {
        key: "STORAGE_NOT_CONFIGURED",
        message: "Firebase Storage is not configured on the server",
      });
    }
    throw err;
  }
}

/** GET /archivos?slug= */
export async function listar(req: Request, res: Response): Promise<Response> {
  return conStorage(res, async () => {
    const archivos = await ArchivosService.listarArchivos(req.query.slug as string);
    return sendSuccessResponse(res, 200, { archivos });
  });
}

/** POST /archivos/subidas */
export async function autorizarSubida(req: Request, res: Response): Promise<Response> {
  return conStorage(res, async () => {
    const subida = await ArchivosService.autorizarSubida(req.body as ISolicitudSubida);
    return sendSuccessResponse(res, 201, subida);
  });
}

/** POST /archivos/confirmar */
export async function confirmar(req: Request, res: Response): Promise<Response> {
  return conStorage(res, async () => {
    const { path, nombre } = req.body as { path: string; nombre?: string };
    const archivo = await ArchivosService.confirmarSubida(path, nombre);

    if (!archivo) {
      return sendErrorResponse(res, 404, {
        key: "ARCHIVO_NOT_FOUND",
        message: "The file was not uploaded (or the upload failed)",
        path,
      });
    }
    return sendSuccessResponse(res, 200, { archivo });
  });
}

/** PUT /archivos/asignacion { path, video } */
export async function asignar(req: Request, res: Response): Promise<Response> {
  return conStorage(res, async () => {
    const { path, video } = req.body as { path: string; video: string };
    const proyecto = parsePath(path)!.slug;
    const archivo = await ArchivosService.asignarVideo(path, proyecto, video);

    if (!archivo) {
      return sendErrorResponse(res, 404, { key: "ARCHIVO_NOT_FOUND", message: "File not found in Storage", path });
    }
    return sendSuccessResponse(res, 200, { archivo });
  });
}

/** DELETE /archivos/asignacion?slug=&video= */
export async function quitarAsignacion(req: Request, res: Response): Promise<Response> {
  const quitado = await ArchivosService.quitarAsignacion(req.query.slug as string, req.query.video as string);
  if (!quitado) {
    return sendErrorResponse(res, 404, { key: "ASIGNACION_NOT_FOUND", message: "That video has no file assigned" });
  }
  return sendSuccessResponse(res, 200, { message: "Assignment removed" });
}

/** DELETE /archivos?path= */
export async function borrar(req: Request, res: Response): Promise<Response> {
  return conStorage(res, async () => {
    const path = req.query.path as string;
    const borrado = await ArchivosService.borrarArchivo(path);

    if (!borrado) {
      return sendErrorResponse(res, 404, { key: "ARCHIVO_NOT_FOUND", message: "File not found", path });
    }
    return sendSuccessResponse(res, 200, { message: "File deleted", path });
  });
}
