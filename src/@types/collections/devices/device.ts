import { ObjectId } from "mongodb";
import { DeviceStatus, DeviceType } from "../../../constants/devices";

export interface IDevice {
  _id?: ObjectId;

  /** Public identifier, sent by the device on every request */
  deviceId: string;

  name: string;
  type: DeviceType;
  description: string | null;
  status: DeviceStatus;

  /** Project slug this device reports for (e.g. "se-puede-salir") */
  proyecto: string | null;

  /** sha256 of the device secret. The raw secret is only returned on claim. */
  secretHash: string | null;

  /** sha256 of the one-time pairing code */
  claimCodeHash: string | null;
  claimCodeExpiresAt: Date | null;

  /** Reported by the device on claim (MAC / chip id) */
  hardwareId: string | null;
  firmwareVersion: string | null;

  lastSeenAt: Date | null;
  lastIp: string | null;

  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
  claimedAt: Date | null;
  revokedAt: Date | null;
}
