import { query } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";
import { ANALISIS_MAX_DIAS, HISTORIAL_MAX_HORAS } from "../../constants/sePuedeSalir";

export function historial() {
  return createValidation([
    query("horas")
      .optional()
      .isInt({ min: 1, max: HISTORIAL_MAX_HORAS })
      .withMessage(`'horas' must be an integer between 1 and ${HISTORIAL_MAX_HORAS}`),
  ]);
}

export function dia() {
  return createValidation([
    query("fecha")
      .exists()
      .withMessage("'fecha' is required")
      .bail()
      .isDate({ format: "YYYY-MM-DD", strictMode: true, delimiters: ["-"] })
      .withMessage("'fecha' must be a date like 2026-10-14"),
  ]);
}

export function analisis() {
  return createValidation([
    query("dias")
      .optional()
      .isInt({ min: 1, max: ANALISIS_MAX_DIAS })
      .withMessage(`'dias' must be an integer between 1 and ${ANALISIS_MAX_DIAS}`),
  ]);
}
