// routes/devices/devices.validations.ts
import { body, param, query } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";
import { DEVICE_STATUSES, DEVICE_TYPES } from "../../constants/devices";
import { proyectoExists } from "../proyectos/proyectos.service";

const DEVICE_ID_REGEX = /^dev_[a-z0-9]{12}$/;

/** null / "" unassigns the device */
function proyectoBody() {
  return body("proyecto")
    .optional({ values: "null" })
    .custom((v: unknown) => v === "" || (typeof v === "string" && proyectoExists(v)))
    .withMessage("'proyecto' must be an existing project slug");
}

function deviceIdParam() {
  return param("deviceId", "field 'deviceId' is required on request")
    .matches(DEVICE_ID_REGEX)
    .withMessage("'deviceId' is not valid");
}

export function listDevices() {
  return createValidation([
    query("type")
      .optional()
      .isIn([...DEVICE_TYPES])
      .withMessage(`'type' must be one of ${DEVICE_TYPES.join(" | ")}`),
    query("status")
      .optional()
      .isIn([...DEVICE_STATUSES])
      .withMessage(`'status' must be one of ${DEVICE_STATUSES.join(" | ")}`),
    query("proyecto")
      .optional()
      .isString()
      .isLength({ max: 80 })
      .withMessage("'proyecto' is not valid"),
  ]);
}

export function deviceId() {
  return createValidation([deviceIdParam()]);
}

export function createDevice() {
  return createValidation([
    body("name", "field 'name' is required on request")
      .isString()
      .withMessage("'name' must be a string")
      .trim()
      .isLength({ min: 1, max: 80 })
      .withMessage("'name' must be 1-80 chars"),

    body("type", "field 'type' is required on request")
      .isIn([...DEVICE_TYPES])
      .withMessage(`'type' must be one of ${DEVICE_TYPES.join(" | ")}`),

    body("description")
      .optional({ values: "null" })
      .isString()
      .withMessage("'description' must be a string")
      .trim()
      .isLength({ max: 500 })
      .withMessage("'description' must be <= 500 chars"),

    proyectoBody(),
  ]);
}

export function updateDevice() {
  return createValidation([
    deviceIdParam(),

    body("name")
      .optional()
      .isString()
      .withMessage("'name' must be a string")
      .trim()
      .isLength({ min: 1, max: 80 })
      .withMessage("'name' must be 1-80 chars"),

    body("type")
      .optional()
      .isIn([...DEVICE_TYPES])
      .withMessage(`'type' must be one of ${DEVICE_TYPES.join(" | ")}`),

    body("description")
      .optional({ values: "null" })
      .isString()
      .withMessage("'description' must be a string")
      .trim()
      .isLength({ max: 500 })
      .withMessage("'description' must be <= 500 chars"),

    proyectoBody(),
  ]);
}

export function claimDevice() {
  return createValidation([
    body("claimCode", "field 'claimCode' is required on request")
      .isString()
      .withMessage("'claimCode' must be a string")
      .isLength({ min: 8, max: 12 })
      .withMessage("'claimCode' is not valid"),

    body("hardwareId")
      .optional()
      .isString()
      .withMessage("'hardwareId' must be a string")
      .trim()
      .isLength({ max: 64 })
      .withMessage("'hardwareId' must be <= 64 chars"),

    body("firmwareVersion")
      .optional()
      .isString()
      .withMessage("'firmwareVersion' must be a string")
      .trim()
      .isLength({ max: 32 })
      .withMessage("'firmwareVersion' must be <= 32 chars"),
  ]);
}

export function heartbeat() {
  return createValidation([
    body("firmwareVersion")
      .optional()
      .isString()
      .withMessage("'firmwareVersion' must be a string")
      .trim()
      .isLength({ max: 32 })
      .withMessage("'firmwareVersion' must be <= 32 chars"),
  ]);
}
