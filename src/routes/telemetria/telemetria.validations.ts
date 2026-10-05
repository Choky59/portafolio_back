import { body } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";

export function createReading() {
  return createValidation([
    body("temperatura", "field 'temperatura' is required on request")
      .isFloat({ min: -40, max: 85 })
      .withMessage("'temperatura' must be a number between -40 and 85 (°C)")
      .toFloat(),

    body("humedad")
      .optional({ values: "null" })
      .isFloat({ min: 0, max: 100 })
      .withMessage("'humedad' must be a number between 0 and 100 (%)")
      .toFloat(),
  ]);
}
