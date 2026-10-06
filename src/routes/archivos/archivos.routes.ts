// routes/archivos/archivos.routes.ts
import { Router } from "express";
import * as ArchivosController from "./archivos.controller";
import * as ArchivosValidations from "./archivos.validations";
import { requireAdmin, sessionValidation } from "../../middlewares/common/common.validations";

export const router = Router();

/* ADMIN only: project files in Firebase Storage */
const admin = [sessionValidation, requireAdmin];

router.get("/", [...admin, ...ArchivosValidations.listar()], ArchivosController.listar);

router.post("/subidas", [...admin, ...ArchivosValidations.autorizarSubida()], ArchivosController.autorizarSubida);

router.post("/confirmar", [...admin, ...ArchivosValidations.confirmar()], ArchivosController.confirmar);

router.delete("/", [...admin, ...ArchivosValidations.borrar()], ArchivosController.borrar);

/* Which uploaded file plays in each project video (Parte 1, Parte 2...) */
router.put("/asignacion", [...admin, ...ArchivosValidations.asignar()], ArchivosController.asignar);

router.delete(
  "/asignacion",
  [...admin, ...ArchivosValidations.quitarAsignacion()],
  ArchivosController.quitarAsignacion
);
