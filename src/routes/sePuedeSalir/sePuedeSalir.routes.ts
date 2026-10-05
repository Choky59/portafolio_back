import { Router } from "express";
import * as SePuedeSalirController from "./sePuedeSalir.controller";
import * as SePuedeSalirValidations from "./sePuedeSalir.validations";

export const router = Router();

/* Public (live dashboard of Proyecto #1) */
router.get("/estado", SePuedeSalirController.getEstado);
router.get("/historial", SePuedeSalirValidations.historial(), SePuedeSalirController.getHistorial);
