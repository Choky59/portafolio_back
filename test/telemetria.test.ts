import request from "supertest";
import { Express } from "express";
import { login, setupTestApp } from "./helpers";
import { Database } from "../src/middlewares/database/mongodb";
import { estadoPorTemperatura } from "../src/constants/sePuedeSalir";

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

/** Creates + claims a device, optionally assigned to a project */
async function activeDevice(proyecto?: string) {
  const created = await request(app)
    .post("/api/devices")
    .set("session", token)
    .send({ name: "Sensor", type: "ESP32", ...(proyecto ? { proyecto } : {}) });
  expect(created.status).toBe(201);

  const claimed = await request(app)
    .post("/api/devices/claim")
    .send({ claimCode: created.body.claimCode });
  expect(claimed.status).toBe(200);

  return {
    deviceId: claimed.body.deviceId as string,
    auth: `Device ${claimed.body.deviceId}:${claimed.body.deviceSecret}`,
  };
}

describe("estadoPorTemperatura", () => {
  it.each([
    [10, "frio"],
    [19.9, "frio"],
    [20, "ideal"],
    [29.9, "ideal"],
    [30, "calor"],
    [35, "calor"],
    [35.1, "extremo"],
    [46, "extremo"],
  ])("%s °C → %s", (t, clave) => {
    expect(estadoPorTemperatura(t).clave).toBe(clave);
  });
});

describe("device proyecto assignment", () => {
  it("rejects unknown projects", async () => {
    const res = await request(app)
      .post("/api/devices")
      .set("session", token)
      .send({ name: "x", type: "ESP32", proyecto: "no-existe" });
    expect(res.status).toBe(400);
  });

  it("assigns and unassigns via PATCH", async () => {
    const { deviceId } = await activeDevice();
    const set = await request(app)
      .patch(`/api/devices/${deviceId}`)
      .set("session", token)
      .send({ proyecto: "se-puede-salir" });
    expect(set.body.device.proyecto).toBe("se-puede-salir");

    const unset = await request(app)
      .patch(`/api/devices/${deviceId}`)
      .set("session", token)
      .send({ proyecto: null });
    expect(unset.body.device.proyecto).toBeNull();
  });
});

describe("POST /api/telemetria", () => {
  it("requires device credentials", async () => {
    const res = await request(app).post("/api/telemetria").send({ temperatura: 30 });
    expect(res.status).toBe(401);
  });

  it("rejects an admin session (only devices can write)", async () => {
    const res = await request(app)
      .post("/api/telemetria")
      .set("session", token)
      .send({ temperatura: 30 });
    expect(res.status).toBe(401);
  });

  it("409 when the device has no project", async () => {
    const { auth } = await activeDevice();
    const res = await request(app).post("/api/telemetria").set("Authorization", auth).send({ temperatura: 30 });
    expect(res.status).toBe(409);
  });

  it("validates the temperature range", async () => {
    const { auth } = await activeDevice("se-puede-salir");
    const res = await request(app).post("/api/telemetria").set("Authorization", auth).send({ temperatura: 500 });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/se-puede-salir", () => {
  it("estado is empty before the first reading", async () => {
    await Database.Devices.Telemetry().deleteMany({});
    const res = await request(app).get("/api/se-puede-salir/estado");
    expect(res.status).toBe(200);
    expect(res.body.temperatura).toBeNull();
    expect(res.body.enLinea).toBe(false);
  });

  it("reflects the latest reading and builds the history", async () => {
    const { auth } = await activeDevice("se-puede-salir");

    for (const temperatura of [33, 41.5]) {
      const res = await request(app)
        .post("/api/telemetria")
        .set("Authorization", auth)
        .send({ temperatura, humedad: 12 });
      expect(res.status).toBe(201);
    }

    const estado = await request(app).get("/api/se-puede-salir/estado");
    expect(estado.body.temperatura).toBe(41.5);
    expect(estado.body.estado.clave).toBe("extremo");
    expect(estado.body.enLinea).toBe(true);

    const historial = await request(app).get("/api/se-puede-salir/historial?horas=24");
    expect(historial.status).toBe(200);
    expect(historial.body.puntos.length).toBeGreaterThanOrEqual(1);
    expect(historial.body.puntos[0]).toHaveProperty("temperatura");
  });

  it("marks the sensor offline when the last reading is old", async () => {
    await Database.Devices.Telemetry().updateMany(
      {},
      { $set: { medidoEn: new Date(Date.now() - 10 * 60 * 1000) } }
    );
    const res = await request(app).get("/api/se-puede-salir/estado");
    expect(res.body.enLinea).toBe(false);
  });

  it("validates historial hours", async () => {
    expect((await request(app).get("/api/se-puede-salir/historial?horas=500")).status).toBe(400);
  });
});
