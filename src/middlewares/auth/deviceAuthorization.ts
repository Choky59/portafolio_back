import { NextFunction, Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";
import { LAST_SEEN_THROTTLE_MS } from "../../constants/devices";
import { Database } from "../database/mongodb";
import { hashToken, safeEqualHex } from "./tokens";

/**
 * Device auth for ESP32 clients.
 *
 * Header: Authorization: Device <deviceId>:<deviceSecret>
 *
 * The secret is only known by the device (stored in NVS after claim),
 * the DB keeps its sha256. Must be used over HTTPS.
 * On success the device document is available at res.locals.device.
 */
export async function deviceAuthorization(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || "";
  const spaceIdx = authHeader.indexOf(" ");
  const scheme = spaceIdx > 0 ? authHeader.slice(0, spaceIdx).toLowerCase() : "";
  const credentials = spaceIdx > 0 ? authHeader.slice(spaceIdx + 1).trim() : "";

  const sepIdx = credentials.indexOf(":");
  const deviceId = sepIdx > 0 ? credentials.slice(0, sepIdx) : "";
  const secret = sepIdx > 0 ? credentials.slice(sepIdx + 1) : "";

  if (scheme !== "device" || !deviceId || !secret) {
    return sendErrorResponse(res, 401, {
      key: "UNAUTHORIZED",
      message: "Missing or invalid device credentials",
    });
  }

  const device = await Database.Devices.Devices().findOne({ deviceId });

  if (
    !device ||
    device.status !== "ACTIVE" ||
    !device.secretHash ||
    !safeEqualHex(hashToken(secret), device.secretHash)
  ) {
    return sendErrorResponse(res, 401, {
      key: "UNAUTHORIZED",
      message: "Missing or invalid device credentials",
    });
  }

  const now = new Date();
  const lastSeen = device.lastSeenAt?.getTime() ?? 0;
  if (now.getTime() - lastSeen > LAST_SEEN_THROTTLE_MS) {
    await Database.Devices.Devices().updateOne(
      { _id: device._id },
      { $set: { lastSeenAt: now, lastIp: req.ip ?? null } }
    );
    device.lastSeenAt = now;
    device.lastIp = req.ip ?? null;
  }

  res.locals.device = device;
  next();
}
