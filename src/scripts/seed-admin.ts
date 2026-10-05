/**
 * Creates the first ADMIN user.
 * Only runs when the profiles collection is empty, so it's safe to re-run.
 *
 *   npm run seed:admin
 *
 * Reads: MONGO_DB, MONGO_DB_NAME, SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD, SEED_ADMIN_EMAIL
 */
import "dotenv/config";
import * as MongoDB from "../middlewares/database/mongodb";
import * as AuthService from "../routes/auth/auth.service";
import { encryptPassword } from "../middlewares/auth/encryption";

async function main() {
  const required = ["MONGO_DB", "SEED_ADMIN_USERNAME", "SEED_ADMIN_PASSWORD", "SEED_ADMIN_EMAIL"];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const password = process.env.SEED_ADMIN_PASSWORD as string;
  if (password.length < 10) {
    console.error("SEED_ADMIN_PASSWORD must be at least 10 chars");
    process.exit(1);
  }

  await MongoDB.createConnections(process.env.MONGO_DB as string, process.env.MONGO_DB_NAME || "portafolio");
  await MongoDB.createIndexes();

  try {
    if ((await AuthService.countUsers()) > 0) {
      console.info("Users already exist, nothing to do.");
      return;
    }

    const now = new Date();
    const username = process.env.SEED_ADMIN_USERNAME as string;
    const created = await AuthService.createUser({
      username,
      email: process.env.SEED_ADMIN_EMAIL as string,
      displayName: username,
      password: await encryptPassword(password),
      role: "ADMIN",
      status: "ACTIVE",
      lastSession: null,
      createdAt: now,
      updatedAt: now,
    });

    if (created.status !== 200) {
      console.error("Failed to create admin user, status:", created.status);
      process.exitCode = 1;
      return;
    }

    console.info(`Admin '${username}' created. Remove SEED_ADMIN_PASSWORD from your .env.`);
  } finally {
    await MongoDB.closeConnections();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
