import { body } from "express-validator";
import { createValidation } from "../../middlewares/common/common.validations";

export function authenticate() {
    return createValidation(
        [
            body('username', "field 'username' is required on request").isString().withMessage("'username' must be a string").trim().notEmpty(),
            body('password', "field 'password' is required on request").isString().withMessage("'password' must be a string").notEmpty(),
            body('expiration').optional().isInt({ min: 0, max: 3 }).withMessage("'expiration' must be 0 (1h), 1 (24h), 2 (7d) or 3 (30d)").toInt()
        ]
    )
}

export function endSession() {
    return createValidation(
        [
            body('closeAll').optional().isBoolean().withMessage("'closeAll' must be a boolean").toBoolean(),
        ]
    )
}
