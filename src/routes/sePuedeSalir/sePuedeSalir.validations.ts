import { query } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";
import { HISTORIAL_MAX_HORAS } from "../../constants/sePuedeSalir";

export function historial() {
  return createValidation([
    query("horas")
      .optional()
      .isInt({ min: 1, max: HISTORIAL_MAX_HORAS })
      .withMessage(`'horas' must be an integer between 1 and ${HISTORIAL_MAX_HORAS}`),
  ]);
}
