/**
 * FILE: mongodb.devices.indexes.ts
 *
 * MongoDB index definitions for the Devices domain.
 * SAFE to run multiple times.
 */

import { Database } from "./mongodb";
import { TELEMETRY_TTL_DAYS } from "../../constants/sePuedeSalir";

export async function indexesDevices(): Promise<void> {
  await Database.Devices.Devices().createIndex(
    { deviceId: 1 },
    { name: "devices_deviceId_unique", unique: true }
  );

  /**
   * Partial (not sparse) because cleared codes are stored as null,
   * and a sparse unique index would still collide on multiple nulls.
   */
  await Database.Devices.Devices().createIndex(
    { claimCodeHash: 1 },
    {
      name: "devices_claimCodeHash_unique",
      unique: true,
      partialFilterExpression: { claimCodeHash: { $type: "string" } },
    }
  );

  await Database.Devices.Devices().createIndex(
    { status: 1, type: 1 },
    { name: "devices_status_type" }
  );

  /* ============================
   * TELEMETRY
   * ============================ */

  await Database.Devices.Telemetry().createIndex(
    { proyecto: 1, medidoEn: -1 },
    { name: "telemetry_proyecto_medidoEn" }
  );

  await Database.Devices.Telemetry().createIndex(
    { medidoEn: 1 },
    { name: "telemetry_medidoEn_ttl", expireAfterSeconds: TELEMETRY_TTL_DAYS * 24 * 60 * 60 }
  );

  console.log("[DB] Devices indexes ensured");
}
