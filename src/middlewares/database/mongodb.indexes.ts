/**
 * FILE: mongodb.indexes.ts
 *
 * MongoDB global index bootstrapper.
 * SAFE to run multiple times.
 *
 * Delegates per-domain index creation to dedicated modules.
 */

import { indexesUsers } from "./mongodb.users.indexes";
import { indexesDevices } from "./mongodb.devices.indexes";

export async function createIndexes(): Promise<void> {
  console.info("Creating collection indexes");

  await indexesUsers();
  await indexesDevices();
  console.log("[DB] All indexes ensured");
}
