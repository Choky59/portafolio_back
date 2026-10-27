import { Router } from "express";
import * as PulsoController from "./pulso.controller";
import * as PulsoValidations from "./pulso.validations";
import { requireAdmin, sessionValidation } from "../../middlewares/common/common.validations";

export const router = Router();

/* Public, read-only (El pulso de Hermosillo, Proyecto #2) */
router.get("/resumen", PulsoController.getResumen);
router.get("/notas", PulsoValidations.notas(), PulsoController.getNotas);
router.get("/notas/:id", PulsoController.getNota);
router.get("/medios", PulsoController.getMedios);
router.get("/actores", PulsoValidations.actores(), PulsoController.getActores);
router.get("/fuentes", PulsoController.getFuentes);
router.get("/mapa", PulsoValidations.notas(), PulsoController.getMapa);
router.get("/mapa/colonias", PulsoValidations.notas(), PulsoController.getMapaColonias);
router.get("/multitud", PulsoValidations.multitud(), PulsoController.getMultitud);

/* ADMIN only: the analysis costs money, so it only runs as jobs started here */
const admin = [sessionValidation, requireAdmin];
router.get("/admin/pendientes", [...admin, ...PulsoValidations.pendientes()], PulsoController.getPendientes);
router.get("/admin/trabajos", admin, PulsoController.getTrabajos);
router.post("/admin/trabajos", [...admin, ...PulsoValidations.crearTrabajo()], PulsoController.postTrabajo);
router.post("/admin/trabajos/:id/cancelar", admin, PulsoController.postCancelar);
router.get("/admin/borrado", [...admin, ...PulsoValidations.pendientes()], PulsoController.getBorrado);
router.post("/admin/borrado", [...admin, ...PulsoValidations.borrado()], PulsoController.postBorrado);
