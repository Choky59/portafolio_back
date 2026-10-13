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

    // Optional: older firmware doesn't send it
    body("bateria")
      .optional({ values: "null" })
      .isObject()
      .withMessage("'bateria' must be { voltaje, porcentaje }"),

    body("bateria.voltaje")
      .if(body("bateria").exists({ values: "null" }))
      .isFloat({ min: 2.5, max: 4.5 })
      .withMessage("'bateria.voltaje' must be a number between 2.5 and 4.5 (V)")
      .toFloat(),

    body("bateria.porcentaje")
      .if(body("bateria").exists({ values: "null" }))
      .isInt({ min: 0, max: 100 })
      .withMessage("'bateria.porcentaje' must be an integer between 0 and 100")
      .toInt(),
  ]);
}
