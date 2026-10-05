import { Router } from "express";
import * as ProyectosController from "./proyectos.controller";
import * as ProyectosValidations from "./proyectos.validations";

export const router = Router();

/* Public */
router.get("/", ProyectosController.getProyectos);
router.get("/:slug", ProyectosValidations.getProyecto(), ProyectosController.getProyecto);
