import { Router } from "express";
import { requireAdmin, sessionValidation } from "../../middlewares/common/common.validations";
import * as JuegoController from "./juego.controller";

export const router = Router();

/* ADMIN only: the game server, every match and every real player (admin panel → Status) */
router.get("/status", [sessionValidation, requireAdmin], JuegoController.getStatus);
router.get("/status/partidas/:id", [sessionValidation, requireAdmin], JuegoController.getPartida);
