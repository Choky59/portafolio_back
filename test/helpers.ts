import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import * as MongoDB from "../src/middlewares/database/mongodb";
import { createApp } from "../src/app";
import { encryptPassword } from "../src/middlewares/auth/encryption";
import * as AuthService from "../src/routes/auth/auth.service";
import { loadProyectos } from "../src/routes/proyectos/proyectos.service";

export const ADMIN = {
  username: "admin",
  password: "super-secret-pass",
  email: "admin@example.com",
};

export async function setupTestApp() {
  // mongod can take ~20s to boot on Windows (antivirus scan)
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120000 } });
  await MongoDB.createConnections(mongo.getUri(), "portafolio_test");
  await MongoDB.createIndexes();
  loadProyectos();

  const now = new Date();
  await AuthService.createUser({
    username: ADMIN.username,
    email: ADMIN.email,
    displayName: "Admin",
    password: await encryptPassword(ADMIN.password),
    role: "ADMIN",
    status: "ACTIVE",
    lastSession: null,
    createdAt: now,
    updatedAt: now,
  });

  const app = createApp();

  async function teardown() {
    await MongoDB.closeConnections();
    await mongo.stop();
  }

  return { app, teardown };
}

export async function login(
  app: Parameters<typeof request>[0],
  username = ADMIN.username,
  password = ADMIN.password
): Promise<string> {
  const res = await request(app).post("/api/session").send({ username, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.session.token;
}

/** Fails if any secret material leaks in a response body */
export function expectNoSecrets(body: unknown) {
  const json = JSON.stringify(body);
  expect(json).not.toMatch(/"password"/);
  expect(json).not.toMatch(/"secretHash"/);
  expect(json).not.toMatch(/"tokenHash"/);
  expect(json).not.toMatch(/"claimCodeHash"/);
}
