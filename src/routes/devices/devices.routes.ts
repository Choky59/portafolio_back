// routes/devices/devices.routes.ts
import { Router } from "express";
import * as DevicesValidations from "./devices.validations";
import * as DevicesController from "./devices.controller";
import { requireAdmin, sessionValidation } from "../../middlewares/common/common.validations";
import { deviceAuthorization } from "../../middlewares/auth/deviceAuthorization";
import { claimRateLimit } from "../../middlewares/auth/rateLimit";

export const router = Router();

/* -------------------------------------------------------------------------- */
/*                         DEVICE (ESP32) ENDPOINTS                           */
/* -------------------------------------------------------------------------- */
// Declared before "/:deviceId" so they are not captured as ids.

router.post(
  "/claim",
  [claimRateLimit, ...DevicesValidations.claimDevice()],
  DevicesController.claimDevice
);

router.post(
  "/heartbeat",
  [deviceAuthorization, ...DevicesValidations.heartbeat()],
  DevicesController.heartbeat
);

/* -------------------------------------------------------------------------- */
/*                            ADMIN PANEL ENDPOINTS                           */
/* -------------------------------------------------------------------------- */

const admin = [sessionValidation, requireAdmin];

router.get("/types", admin, DevicesController.getDeviceTypes);

router.get("/", [...admin, ...DevicesValidations.listDevices()], DevicesController.getDevices);

router.post("/", [...admin, ...DevicesValidations.createDevice()], DevicesController.createDevice);

router.get("/:deviceId", [...admin, ...DevicesValidations.deviceId()], DevicesController.getDevice);

router.patch(
  "/:deviceId",
  [...admin, ...DevicesValidations.updateDevice()],
  DevicesController.updateDevice
);

router.post(
  "/:deviceId/claim-code",
  [...admin, ...DevicesValidations.deviceId()],
  DevicesController.regenerateClaimCode
);

router.post(
  "/:deviceId/revoke",
  [...admin, ...DevicesValidations.deviceId()],
  DevicesController.revokeDevice
);

router.delete(
  "/:deviceId",
  [...admin, ...DevicesValidations.deviceId()],
  DevicesController.deleteDevice
);
