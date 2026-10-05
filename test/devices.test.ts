import request from "supertest";
import { Express } from "express";
import { expectNoSecrets, login, setupTestApp } from "./helpers";
import { Database } from "../src/middlewares/database/mongodb";

let app: Express;
let teardown: () => Promise<void>;
let token: string;

beforeAll(async () => {
  ({ app, teardown } = await setupTestApp());
  token = await login(app);
});

afterAll(async () => {
  await teardown?.();
});

async function createDevice(name = "Sensor sala") {
  const res = await request(app)
    .post("/api/devices")
    .set("session", token)
    .send({ name, type: "ESP32", description: "Temperatura" });
  expect(res.status).toBe(201);
  return res.body as { device: any; claimCode: string; expiresAt: string };
}

async function claim(claimCode: string) {
  return request(app)
    .post("/api/devices/claim")
    .send({ claimCode, hardwareId: "24:6F:28:AA:BB:CC", firmwareVersion: "1.0.0" });
}

function deviceAuth(deviceId: string, secret: string) {
  return `Device ${deviceId}:${secret}`;
}

describe("device management (admin panel)", () => {
  it("requires an admin session", async () => {
    expect((await request(app).get("/api/devices")).status).toBe(401);
    expect((await request(app).post("/api/devices").send({ name: "x", type: "ESP32" })).status).toBe(401);
  });

  it("lists device types", async () => {
    const res = await request(app).get("/api/devices/types").set("session", token);
    expect(res.status).toBe(200);
    expect(res.body.types).toContain("ESP32");
  });

  it("validates the device type", async () => {
    const res = await request(app)
      .post("/api/devices")
      .set("session", token)
      .send({ name: "x", type: "ARDUINO_UNO" });
    expect(res.status).toBe(400);
  });

  it("creates a PENDING device with a claim code and no secrets in the response", async () => {
    const body = await createDevice();
    expect(body.device.status).toBe("PENDING");
    expect(body.device.hasPendingClaim).toBe(true);
    expect(body.claimCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expectNoSecrets(body);

    const list = await request(app).get("/api/devices?type=ESP32").set("session", token);
    expect(list.status).toBe(200);
    expect(list.body.devices.length).toBeGreaterThanOrEqual(1);
    expectNoSecrets(list.body);
  });

  it("updates name/type/description", async () => {
    const { device } = await createDevice("Old name");
    const res = await request(app)
      .patch(`/api/devices/${device.deviceId}`)
      .set("session", token)
      .send({ name: "New name", type: "ESP32-S3" });
    expect(res.status).toBe(200);
    expect(res.body.device.name).toBe("New name");
    expect(res.body.device.type).toBe("ESP32-S3");
  });

  it("returns 404 for unknown devices and 400 for malformed ids", async () => {
    expect((await request(app).get("/api/devices/dev_aaaaaaaaaaaa").set("session", token)).status).toBe(404);
    expect((await request(app).get("/api/devices/whatever").set("session", token)).status).toBe(400);
  });
});

describe("claim + device authorization", () => {
  it("claims once, then authenticates heartbeats with the secret", async () => {
    const { device, claimCode } = await createDevice();

    // Code is accepted without the dash / lowercase
    const claimed = await claim(claimCode.replace("-", "").toLowerCase());
    expect(claimed.status).toBe(200);
    expect(claimed.body.deviceId).toBe(device.deviceId);
    const secret = claimed.body.deviceSecret as string;
    expect(secret.length).toBeGreaterThan(30);

    // Single use
    expect((await claim(claimCode)).status).toBe(401);

    // Stored only as hash
    const stored = await Database.Devices.Devices().findOne({ deviceId: device.deviceId });
    expect(stored?.status).toBe("ACTIVE");
    expect(stored?.secretHash).not.toBe(secret);
    expect(stored?.claimCodeHash).toBeNull();

    const hb = await request(app)
      .post("/api/devices/heartbeat")
      .set("Authorization", deviceAuth(device.deviceId, secret))
      .send({ firmwareVersion: "1.0.1" });
    expect(hb.status).toBe(200);
    expect(hb.body.ok).toBe(true);

    const detail = await request(app).get(`/api/devices/${device.deviceId}`).set("session", token);
    expect(detail.body.device.lastSeenAt).not.toBeNull();
    expect(detail.body.device.firmwareVersion).toBe("1.0.1");
    expect(detail.body.device.hardwareId).toBe("24:6F:28:AA:BB:CC");
    expectNoSecrets(detail.body);
  });

  it("rejects missing, malformed and wrong credentials", async () => {
    const { device, claimCode } = await createDevice();
    const { body } = await claim(claimCode);

    const noHeader = await request(app).post("/api/devices/heartbeat");
    const wrongScheme = await request(app)
      .post("/api/devices/heartbeat")
      .set("Authorization", `Bearer ${body.deviceSecret}`);
    const wrongSecret = await request(app)
      .post("/api/devices/heartbeat")
      .set("Authorization", deviceAuth(device.deviceId, "x".repeat(43)));
    const otherDevice = await request(app)
      .post("/api/devices/heartbeat")
      .set("Authorization", deviceAuth("dev_aaaaaaaaaaaa", body.deviceSecret));

    expect(noHeader.status).toBe(401);
    expect(wrongScheme.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    expect(otherDevice.status).toBe(401);
  });

  it("rejects expired claim codes", async () => {
    const { device, claimCode } = await createDevice();
    await Database.Devices.Devices().updateOne(
      { deviceId: device.deviceId },
      { $set: { claimCodeExpiresAt: new Date(Date.now() - 1000) } }
    );
    expect((await claim(claimCode)).status).toBe(401);
  });

  it("revoked devices can't authenticate; re-pairing rotates the secret", async () => {
    const { device, claimCode } = await createDevice();
    const oldSecret = (await claim(claimCode)).body.deviceSecret;

    const revoked = await request(app)
      .post(`/api/devices/${device.deviceId}/revoke`)
      .set("session", token);
    expect(revoked.status).toBe(200);
    expect(revoked.body.device.status).toBe("REVOKED");

    const hb = await request(app)
      .post("/api/devices/heartbeat")
      .set("Authorization", deviceAuth(device.deviceId, oldSecret));
    expect(hb.status).toBe(401);

    // Re-pair
    const code = await request(app)
      .post(`/api/devices/${device.deviceId}/claim-code`)
      .set("session", token);
    expect(code.status).toBe(200);
    const newSecret = (await claim(code.body.claimCode)).body.deviceSecret;
    expect(newSecret).not.toBe(oldSecret);

    const ok = await request(app)
      .post("/api/devices/heartbeat")
      .set("Authorization", deviceAuth(device.deviceId, newSecret));
    expect(ok.status).toBe(200);
  });

  it("deleted devices can't authenticate", async () => {
    const { device, claimCode } = await createDevice();
    const secret = (await claim(claimCode)).body.deviceSecret;

    const del = await request(app).delete(`/api/devices/${device.deviceId}`).set("session", token);
    expect(del.status).toBe(200);

    const hb = await request(app)
      .post("/api/devices/heartbeat")
      .set("Authorization", deviceAuth(device.deviceId, secret));
    expect(hb.status).toBe(401);
  });

  it("rate limits failed claim attempts", async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) {
      last = (await claim("ZZZZ-ZZZZ")).status;
    }
    expect(last).toBe(429);
  });
});
