// routes/archivos/archivos.validations.ts
import { body, query } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";
import { TAMANO_MAXIMO, TIPOS_PERMITIDOS } from "../../constants/archivos";
import { findProyecto, proyectoExists } from "../proyectos/proyectos.service";
import { parsePath } from "./archivos.helpers.misc";

const TIPOS = Object.keys(TIPOS_PERMITIDOS);
const MB = 1024 * 1024;

function slugExistente(campo: ReturnType<typeof body> | ReturnType<typeof query>) {
  return campo
    .isString()
    .custom((slug: string) => proyectoExists(slug))
    .withMessage("'slug' must be an existing project");
}

function pathValido(campo: ReturnType<typeof body> | ReturnType<typeof query>) {
  return campo
    .custom((path: unknown) => parsePath(path) !== null)
    .withMessage("'path' must be proyectos/<slug>/<categoria>/<archivo>");
}

export function listar() {
  return createValidation([slugExistente(query("slug", "query 'slug' is required"))]);
}

export function autorizarSubida() {
  return createValidation([
    slugExistente(body("slug", "field 'slug' is required")),

    body("nombre", "field 'nombre' is required")
      .isString()
      .withMessage("'nombre' must be a string")
      .trim()
      .isLength({ min: 1, max: 200 })
      .withMessage("'nombre' must be 1-200 chars"),

    body("contentType", "field 'contentType' is required")
      .isIn(TIPOS)
      .withMessage("file type not allowed: use mp4, webm, mov, zip, jpg, png, webp or glb"),

    body("tamano", "field 'tamano' is required")
      .isInt({ min: 1 })
      .withMessage("'tamano' must be a positive integer (bytes)")
      .toInt()
      .custom((tamano: number, { req }) => {
        const tipo = TIPOS_PERMITIDOS[req.body?.contentType];
        if (!tipo) return true; // reported by the contentType check
        const maximo = TAMANO_MAXIMO[tipo.categoria];
        if (tamano > maximo) {
          throw new Error(`file too large: max ${Math.round(maximo / MB)} MB for ${tipo.categoria}`);
        }
        return true;
      }),
  ]);
}

export function confirmar() {
  return createValidation([
    pathValido(body("path", "field 'path' is required")),
    body("nombre")
      .optional()
      .isString()
      .trim()
      .isLength({ max: 200 })
      .withMessage("'nombre' must be <= 200 chars"),
  ]);
}

export function borrar() {
  return createValidation([pathValido(query("path", "query 'path' is required"))]);
}

function videoExiste(proyecto: string | undefined, video: unknown): boolean {
  if (!proyecto || typeof video !== "string") return false;
  return !!findProyecto(proyecto)?.proyecto.videos.some((v) => v.slug === video);
}

/** PUT /archivos/asignacion { path, video }: the file must be a video of the same project */
export function asignar() {
  return createValidation([
    body("path", "field 'path' is required")
      .custom((path: unknown) => parsePath(path)?.categoria === "videos")
      .withMessage("'path' must be a video: proyectos/<slug>/videos/<archivo>"),

    body("video", "field 'video' is required")
      .isString()
      .custom((video: string, { req }) => videoExiste(parsePath(req.body?.path)?.slug, video))
      .withMessage("'video' must be an existing video of the same project"),
  ]);
}

/** DELETE /archivos/asignacion?slug=&video= */
export function quitarAsignacion() {
  return createValidation([
    slugExistente(query("slug", "query 'slug' is required")),
    query("video", "query 'video' is required")
      .isString()
      .custom((video: string, { req }) => videoExiste(req.query?.slug as string, video))
      .withMessage("'video' must be an existing video of the project"),
  ]);
}
