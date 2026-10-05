// routes/devices/devices.controller.ts
import { Request, Response } from "express";

import { sendErrorResponse } from "../../constants/errorResponse";
import { sendSuccessResponse } from "../../constants/successResponse";
import { CLAIM_CODE_TTL_MS, DEVICE_TYPES } from "../../constants/devices";

import { IProfile } from "../../@types/collections/users/profile";
import { IDevice } from "../../@types/collections/devices/device";

import {
  formatClaimCode,
  generateClaimCode,
  generateDeviceId,
  generateToken,
  hashToken,
  normalizeClaimCode,
} from "../../middlewares/auth/tokens";

import * as DevicesService from "./devices.service";
import { IDeviceClaim, IDeviceCreate, IDeviceFilter, IDevicePatch } from "./devices.types";
import { sanitizeDevice } from "./devices.helpers.misc";

function newClaimCode() {
  const claimCode = generateClaimCode();
  return {
    claimCode,
    claimCodeHash: hashToken(claimCode),
    expiresAt: new Date(Date.now() + CLAIM_CODE_TTL_MS),
  };
}

function deviceNotFound(res: Response, deviceId: string): Response {
  return sendErrorResponse(res, 404, {
    key: "DEVICE_NOT_FOUND",
    message: "Device not found",
    deviceId,
  });
}

/* -------------------------------------------------------------------------- */
/*                                ADMIN PANEL                                 */
/* -------------------------------------------------------------------------- */

export async function getDeviceTypes(_req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, { types: DEVICE_TYPES });
}

export async function getDevices(req: Request, res: Response): Promise<Response> {
  const filter: IDeviceFilter = {
    type: req.query.type as IDeviceFilter["type"],
    status: req.query.status as IDeviceFilter["status"],
  };

  const devices = await DevicesService.listDevices(filter);
  return sendSuccessResponse(res, 200, { devices: devices.map(sanitizeDevice) });
}

export async function getDevice(req: Request, res: Response): Promise<Response> {
  const deviceId = req.params.deviceId as string;
  const found = await DevicesService.findByDeviceId(deviceId);
  if (!found.data.device) return deviceNotFound(res, deviceId);

  return sendSuccessResponse(res, 200, { device: sanitizeDevice(found.data.device) });
}

/**
 * POST /devices
 * Creates a PENDING device and returns its one-time pairing code.
 */
export async function createDevice(req: Request, res: Response): Promise<Response> {
  const user = res.locals.user as IProfile;
  const { name, type, description } = req.body as IDeviceCreate;
  const { claimCode, claimCodeHash, expiresAt } = newClaimCode();

  const now = new Date();
  const device: IDevice = {
    deviceId: generateDeviceId(),
    name,
    type,
    description: description ?? null,
    status: "PENDING",
    secretHash: null,
    claimCodeHash,
    claimCodeExpiresAt: expiresAt,
    hardwareId: null,
    firmwareVersion: null,
    lastSeenAt: null,
    lastIp: null,
    createdBy: user._id!,
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    revokedAt: null,
  };

  const created = await DevicesService.createDevice(device);
  if (created.status !== 200 || !created.data.device) {
    return sendErrorResponse(res, created.status, {
      key: "DEVICE_CREATE_FAILED",
      message: "Failed to create device",
    });
  }

  return sendSuccessResponse(res, 201, {
    device: sanitizeDevice(created.data.device),
    claimCode: formatClaimCode(claimCode),
    expiresAt,
  });
}

export async function updateDevice(req: Request, res: Response): Promise<Response> {
  const deviceId = req.params.deviceId as string;
  const body = req.body as IDevicePatch;

  const patch: IDevicePatch = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.type === "string") patch.type = body.type;
  if (body.description !== undefined) patch.description = body.description || null;

  const updated = await DevicesService.updateDevice(deviceId, patch);
  if (!updated.data.device) return deviceNotFound(res, deviceId);

  return sendSuccessResponse(res, 200, { device: sanitizeDevice(updated.data.device) });
}

/**
 * POST /devices/:deviceId/claim-code
 * New pairing code (first pairing that expired, re-pairing, or secret rotation).
 */
export async function regenerateClaimCode(req: Request, res: Response): Promise<Response> {
  const deviceId = req.params.deviceId as string;
  const { claimCode, claimCodeHash, expiresAt } = newClaimCode();

  const updated = await DevicesService.setClaimCode(deviceId, claimCodeHash, expiresAt);
  if (!updated.data.device) return deviceNotFound(res, deviceId);

  return sendSuccessResponse(res, 200, {
    device: sanitizeDevice(updated.data.device),
    claimCode: formatClaimCode(claimCode),
    expiresAt,
  });
}

export async function revokeDevice(req: Request, res: Response): Promise<Response> {
  const deviceId = req.params.deviceId as string;

  const revoked = await DevicesService.revokeDevice(deviceId);
  if (!revoked.data.device) return deviceNotFound(res, deviceId);

  return sendSuccessResponse(res, 200, { device: sanitizeDevice(revoked.data.device) });
}

export async function deleteDevice(req: Request, res: Response): Promise<Response> {
  const deviceId = req.params.deviceId as string;

  const deleted = await DevicesService.deleteDevice(deviceId);
  if (!deleted) return deviceNotFound(res, deviceId);

  return sendSuccessResponse(res, 200, { message: "Device deleted", deviceId });
}

/* -------------------------------------------------------------------------- */
/*                                  DEVICE                                    */
/* -------------------------------------------------------------------------- */

/**
 * POST /devices/claim  (public, rate limited)
 * The ESP32 exchanges its pairing code for its permanent secret.
 * The secret is returned only once; the device must store it in NVS.
 */
export async function claimDevice(req: Request, res: Response): Promise<Response> {
  const { claimCode, hardwareId, firmwareVersion } = req.body as IDeviceClaim;

  const deviceSecret = generateToken();

  const claimed = await DevicesService.claimDevice({
    claimCodeHash: hashToken(normalizeClaimCode(claimCode)),
    secretHash: hashToken(deviceSecret),
    hardwareId: hardwareId || null,
    firmwareVersion: firmwareVersion || null,
  });

  if (!claimed.data.device) {
    return sendErrorResponse(res, 401, {
      key: "INVALID_CLAIM_CODE",
      message: "Claim code is invalid or expired",
    });
  }

  return sendSuccessResponse(res, 200, {
    deviceId: claimed.data.device.deviceId,
    deviceSecret,
  });
}

/**
 * POST /devices/heartbeat  (deviceAuthorization)
 */
export async function heartbeat(req: Request, res: Response): Promise<Response> {
  const device = res.locals.device as IDevice;
  const firmwareVersion = (req.body as { firmwareVersion?: string })?.firmwareVersion;

  if (firmwareVersion) {
    await DevicesService.updateFirmwareVersion(device.deviceId, firmwareVersion);
  }

  return sendSuccessResponse(res, 200, {
    ok: true,
    deviceId: device.deviceId,
    serverTime: new Date(),
  });
}
