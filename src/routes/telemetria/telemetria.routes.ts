import { Router } from "express";
import { deviceAuthorization } from "../../middlewares/auth/deviceAuthorization";
import * as TelemetriaController from "./telemetria.controller";
import * as TelemetriaValidations from "./telemetria.validations";

export const router = Router();

/* Device (ESP32) only */
router.post(
  "/",
  [deviceAuthorization, ...TelemetriaValidations.createReading()],
  TelemetriaController.createReading
);
