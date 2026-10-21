import { body, query } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";
import { AMBITOS, EMOCIONES, TEMAS, TIPOS_NOTA } from "../../constants/pulso";

const SUBTEMAS = [...new Set(Object.values(TEMAS).flat())];
const opcional = (campo: string, valores: readonly string[]) =>
  query(campo).optional().isIn(valores as string[]).withMessage(`'${campo}' must be one of: ${valores.join(", ")}`);

export function notas() {
  return createValidation([
    opcional("tema", Object.keys(TEMAS)),
    opcional("subtema", SUBTEMAS),
    opcional("emocion", EMOCIONES),
    opcional("ambito", AMBITOS),
    opcional("tipo", TIPOS_NOTA),
    query("fuente").optional().isSlug().withMessage("'fuente' must be a source slug"),
    query("actor").optional().isString().isLength({ min: 2, max: 120 }).withMessage("'actor' must be 2 to 120 characters"),
    query("q").optional().isString().isLength({ min: 2, max: 100 }).withMessage("'q' must be 2 to 100 characters"),
    query(["desde", "hasta"]).optional().isISO8601().withMessage("dates must be yyyy-mm-dd"),
    query("pagina").optional().isInt({ min: 1, max: 1000 }).withMessage("'pagina' must be 1 to 1000"),
    query("porPagina").optional().isInt({ min: 1, max: 50 }).withMessage("'porPagina' must be 1 to 50"),
  ]);
}

export function actores() {
  return createValidation([query("limite").optional().isInt({ min: 1, max: 100 }).withMessage("'limite' must be 1 to 100")]);
}

const fecha = (campo: string) => query(campo).optional().isISO8601({ strict: true }).withMessage(`'${campo}' must be yyyy-mm-dd`);

export function pendientes() {
  return createValidation([
    fecha("desde"),
    fecha("hasta"),
    query("fuentes").optional().matches(/^[a-z0-9-]+(,[a-z0-9-]+)*$/).withMessage("'fuentes' must be slugs separated by commas"),
  ]);
}

export function borrado() {
  return createValidation([
    body(["desde", "hasta"]).optional({ values: "null" }).isISO8601({ strict: true }).withMessage("dates must be yyyy-mm-dd"),
    body("fuentes").optional().isArray({ max: 50 }).withMessage("'fuentes' must be a list"),
    body("fuentes.*").isSlug().withMessage("each source must be a slug"),
    // Typed by the admin: a deletion can't happen by accident
    body("confirmacion").equals("BORRAR").withMessage("'confirmacion' must be BORRAR"),
  ]);
}

export function crearTrabajo() {
  return createValidation([
    body(["desde", "hasta"]).optional({ values: "null" }).isISO8601({ strict: true }).withMessage("dates must be yyyy-mm-dd"),
    body("fuentes").optional().isArray({ max: 50 }).withMessage("'fuentes' must be a list"),
    body("fuentes.*").isSlug().withMessage("each source must be a slug"),
    body("ids").optional().isArray({ max: 2000 }).withMessage("'ids' must be a list"),
    body("ids.*").isMongoId().withMessage("each id must be a capture id"),
    body("buscarWeb").optional().isBoolean().withMessage("'buscarWeb' must be true or false"),
    // Required on purpose: every run has an explicit spending limit
    body("presupuestoUSD").isFloat({ min: 0.01, max: 50 }).withMessage("'presupuestoUSD' must be 0.01 to 50"),
  ]);
}
