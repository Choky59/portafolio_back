// routes/devices/devices.service.ts
import { Filter } from "mongodb";
import { IDevice } from "../../@types/collections/devices/device";
import { Database } from "../../middlewares/database/mongodb";
import { IDeviceFilter, IDevicePatch, IDeviceResponse } from "./devices.types";

export async function createDevice(device: IDevice): Promise<IDeviceResponse> {
  try {
    const result = await Database.Devices.Devices().insertOne(device);
    return {
      status: 200,
      data: { device: { ...device, _id: result.insertedId } },
    };
  } catch (err: any) {
    // Duplicate deviceId / claimCodeHash (extremely unlikely random collision)
    return { status: err?.code === 11000 ? 409 : 501, data: { device: null } };
  }
}

export async function findByDeviceId(deviceId: string): Promise<IDeviceResponse> {
  const device = await Database.Devices.Devices().findOne({ deviceId });
  if (device) {
    return { status: 200, data: { device } };
  }
  return { status: 404, data: { device: null } };
}

export async function listDevices(filter: IDeviceFilter): Promise<IDevice[]> {
  const query: Filter<IDevice> = {};
  if (filter.type) query.type = filter.type;
  if (filter.status) query.status = filter.status;

  return await Database.Devices.Devices().find(query).sort({ createdAt: -1 }).toArray();
}

export async function updateDevice(
  deviceId: string,
  patch: IDevicePatch
): Promise<IDeviceResponse> {
  const $set: Partial<IDevice> = { updatedAt: new Date() };
  if (typeof patch.name === "string") $set.name = patch.name;
  if (typeof patch.type === "string") $set.type = patch.type;
  if (patch.description !== undefined) $set.description = patch.description;

  const device = await Database.Devices.Devices().findOneAndUpdate(
    { deviceId },
    { $set },
    { returnDocument: "after" }
  );

  if (!device) return { status: 404, data: { device: null } };
  return { status: 200, data: { device } };
}

/**
 * Stores a new pairing code. The current secret (if any) keeps working
 * until the code is claimed, so an ACTIVE device isn't cut off while re-pairing.
 */
export async function setClaimCode(
  deviceId: string,
  claimCodeHash: string,
  claimCodeExpiresAt: Date
): Promise<IDeviceResponse> {
  const device = await Database.Devices.Devices().findOneAndUpdate(
    { deviceId },
    { $set: { claimCodeHash, claimCodeExpiresAt, updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!device) return { status: 404, data: { device: null } };
  return { status: 200, data: { device } };
}

/**
 * Atomically consumes a valid pairing code and installs the new secret.
 * Single use: the code is cleared in the same update.
 */
export async function claimDevice(args: {
  claimCodeHash: string;
  secretHash: string;
  hardwareId: string | null;
  firmwareVersion: string | null;
}): Promise<IDeviceResponse> {
  const now = new Date();

  const device = await Database.Devices.Devices().findOneAndUpdate(
    {
      claimCodeHash: args.claimCodeHash,
      claimCodeExpiresAt: { $gt: now },
    },
    {
      $set: {
        status: "ACTIVE",
        secretHash: args.secretHash,
        claimCodeHash: null,
        claimCodeExpiresAt: null,
        hardwareId: args.hardwareId,
        firmwareVersion: args.firmwareVersion,
        claimedAt: now,
        revokedAt: null,
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  if (!device) return { status: 404, data: { device: null } };
  return { status: 200, data: { device } };
}

export async function revokeDevice(deviceId: string): Promise<IDeviceResponse> {
  const now = new Date();

  const device = await Database.Devices.Devices().findOneAndUpdate(
    { deviceId },
    {
      $set: {
        status: "REVOKED",
        secretHash: null,
        claimCodeHash: null,
        claimCodeExpiresAt: null,
        revokedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  if (!device) return { status: 404, data: { device: null } };
  return { status: 200, data: { device } };
}

export async function deleteDevice(deviceId: string): Promise<boolean> {
  const result = await Database.Devices.Devices().deleteOne({ deviceId });
  return result.deletedCount === 1;
}

export async function updateFirmwareVersion(deviceId: string, firmwareVersion: string) {
  await Database.Devices.Devices().updateOne(
    { deviceId, firmwareVersion: { $ne: firmwareVersion } },
    { $set: { firmwareVersion, updatedAt: new Date() } }
  );
}
