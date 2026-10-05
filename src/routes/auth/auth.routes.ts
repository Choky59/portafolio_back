// routes/auth/auth.routes.ts
import { Router } from "express";
import * as AuthValidations from "./auth.validations";
import * as AuthController from "./auth.controller";
import { requireAdmin, sessionValidation } from "../../middlewares/common/common.validations";

export const router = Router();

/* -------------------------------------------------------------------------- */
/*                               SCOPED (ME)                                  */
/* -------------------------------------------------------------------------- */

router.get("/me", [sessionValidation], AuthController.getMe);

router.patch(
  "/me/password",
  [sessionValidation, ...AuthValidations.changePassword()],
  AuthController.changePassword
);

/* -------------------------------------------------------------------------- */
/*                                ADMIN ONLY                                  */
/* -------------------------------------------------------------------------- */

router.get("/users", [sessionValidation, requireAdmin], AuthController.getUsers);

router.post(
  "/users",
  [sessionValidation, requireAdmin, ...AuthValidations.createUser()],
  AuthController.createUser
);

router.patch(
  "/users/:userId",
  [sessionValidation, requireAdmin, ...AuthValidations.updateUser()],
  AuthController.updateUser
);
