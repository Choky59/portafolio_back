import { Router } from 'express'
import { sessionValidation } from '../../middlewares/common/common.validations';
import { loginRateLimit } from '../../middlewares/auth/rateLimit';
import * as SessionController from './session.controller';
import * as SessionValidations from './session.validations';

export const router = Router();

router.get("/", [sessionValidation], SessionController.getActiveSessions)
router.post("/", [loginRateLimit, ...SessionValidations.authenticate()], SessionController.authenticate)
router.delete("/", [sessionValidation, ...SessionValidations.endSession()], SessionController.endSession)
