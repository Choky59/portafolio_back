// routes/auth/auth.validations.ts
import { body, param } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";

const USERNAME_REGEX = /^[a-zA-Z0-9._-]{3,40}$/;

export function createUser() {
  return createValidation([
    body("username", "field 'username' is required on request")
      .isString()
      .withMessage("'username' must be a string")
      .trim()
      .matches(USERNAME_REGEX)
      .withMessage("'username' must be 3-40 chars: letters, numbers, '.', '_' or '-'"),

    body("email", "field 'email' is required on request")
      .isString()
      .withMessage("'email' must be a string")
      .trim()
      .isEmail()
      .withMessage("'email' must be a valid email"),

    body("displayName", "field 'displayName' is required on request")
      .isString()
      .withMessage("'displayName' must be a string")
      .trim()
      .isLength({ min: 1, max: 120 })
      .withMessage("'displayName' must be 1-120 chars"),

    body("password", "field 'password' is required on request")
      .isString()
      .withMessage("'password' must be a string")
      .isLength({ min: 10, max: 128 })
      .withMessage("'password' must be 10-128 chars"),
  ]);
}

/**
 * PATCH /auth/users/:userId
 * Validates payload shape only.
 */
export function updateUser() {
  return createValidation([
    param("userId", "field 'userId' is required on request")
      .isMongoId()
      .withMessage("'userId' must be a valid id"),

    body("email")
      .optional()
      .isString()
      .withMessage("'email' must be a string")
      .trim()
      .isEmail()
      .withMessage("'email' must be a valid email"),

    body("displayName")
      .optional()
      .isString()
      .withMessage("'displayName' must be a string")
      .trim()
      .isLength({ min: 1, max: 120 })
      .withMessage("'displayName' must be 1-120 chars"),

    body("status")
      .optional()
      .isIn(["ACTIVE", "INACTIVE"])
      .withMessage("'status' must be one of ACTIVE | INACTIVE"),
  ]);
}

export function changePassword() {
  return createValidation([
    body("currentPassword", "field 'currentPassword' is required on request")
      .isString()
      .withMessage("'currentPassword' must be a string")
      .notEmpty(),

    body("newPassword", "field 'newPassword' is required on request")
      .isString()
      .withMessage("'newPassword' must be a string")
      .isLength({ min: 10, max: 128 })
      .withMessage("'newPassword' must be 10-128 chars"),
  ]);
}
