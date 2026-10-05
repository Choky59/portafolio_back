/**
 * FILE: mongodb.users.indexes.ts
 *
 * MongoDB index definitions for the Users domain.
 * SAFE to run multiple times.
 */

import { Database } from "./mongodb";

export async function indexesUsers(): Promise<void> {
  /* ============================
   * USER PROFILES
   * ============================ */

  await Database.Users.Profiles().createIndex(
    { username: 1 },
    { name: "profiles_username_unique", unique: true }
  );

  /* ============================
   * SESSIONS
   * ============================ */

  await Database.Users.Sessions().createIndex(
    { tokenHash: 1 },
    { name: "sessions_tokenHash_unique", unique: true }
  );

  await Database.Users.Sessions().createIndex(
    { userId: 1 },
    { name: "sessions_userId" }
  );

  /**
   * TTL index: Mongo removes sessions once `expiration` is reached.
   * sessionValidation still checks expiration because the TTL monitor runs every ~60s.
   */
  await Database.Users.Sessions().createIndex(
    { expiration: 1 },
    { name: "sessions_expiration_ttl", expireAfterSeconds: 0 }
  );

  console.log("[DB] Users indexes ensured");
}
