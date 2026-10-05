import { param } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";
import { SLUG_REGEX } from "./proyectos.helpers.misc";

export function getProyecto() {
  return createValidation([
    param("slug", "field 'slug' is required on request")
      .isLength({ max: 80 })
      .matches(SLUG_REGEX)
      .withMessage("'slug' is not valid"),
  ]);
}
