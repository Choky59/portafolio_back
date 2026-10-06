import * as AuthRouter from "./auth/auth.routes";
import * as SessionRouter from "./session/session.routes";
import * as DevicesRouter from "./devices/devices.routes";
import * as ProyectosRouter from "./proyectos/proyectos.routes";
import * as TelemetriaRouter from "./telemetria/telemetria.routes";
import * as SePuedeSalirRouter from "./sePuedeSalir/sePuedeSalir.routes";
import * as ArchivosRouter from "./archivos/archivos.routes";

import { Router } from "express";

export const router = Router();

router.use("/auth", AuthRouter.router);
router.use("/session", SessionRouter.router);
router.use("/devices", DevicesRouter.router);
router.use("/proyectos", ProyectosRouter.router);
router.use("/telemetria", TelemetriaRouter.router);
router.use("/se-puede-salir", SePuedeSalirRouter.router);
router.use("/archivos", ArchivosRouter.router);
