import { rateLimit } from "express-rate-limit";
import { Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";

function limitHandler(_req: Request, res: Response) {
  sendErrorResponse(res, 429, {
    key: "TOO_MANY_REQUESTS",
    message: "Too many attempts, try again later",
  });
}

/** Login: 10 failed attempts / 15 min per IP */
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: limitHandler,
});

/** Device claim: 5 failed attempts / 15 min per IP (pairing codes are short) */
export const claimRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: limitHandler,
});
