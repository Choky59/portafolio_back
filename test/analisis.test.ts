import request from "supertest";
import { Express } from "express";
import { setupTestApp } from "./helpers";
import { Database } from "../src/middlewares/database/mongodb";
import { limpiarCacheAnalisis } from "../src/routes/sePuedeSalir/sePuedeSalir.service";
import { estadoPorTemperatura } from "../src/constants/sePuedeSalir";

let app: Express;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ app, teardown } = await setupTestApp());
});

afterAll(async () => {
  await teardown?.();
});

beforeEach(async () => {
  await Database.Devices.Telemetry().deleteMany({});
  limpiarCacheAnalisis();
});

/** Hermosillo is UTC−7 all year (no DST) */
function local(fecha: string, hora: number, minuto = 0): Date {
  const [y, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hora + 7, minuto));
}

/** yyyy-mm-dd in Hermosillo, `diasAtras` days ago */
function fechaLocal(diasAtras: number): string {
  const t = new Date(Date.now() - diasAtras * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Hermosillo" }).format(t);
}

async function lectura(medidoEn: Date, temperatura: number, bateria?: { voltaje: number; porcentaje: number }) {
  await Database.Devices.Telemetry().insertOne({
    deviceId: "dev_test00000000",
    proyecto: "se-puede-salir",
    temperatura,
    humedad: 40,
    bateriaVoltaje: bateria?.voltaje ?? null,
    bateriaPorcentaje: bateria?.porcentaje ?? null,
    medidoEn,
  });
}

const analisis = async (qs = "") => request(app).get(`/api/se-puede-salir/analisis${qs}`);

describe("GET /api/se-puede-salir/analisis", () => {
  const D = fechaLocal(3);
  const D1 = fechaLocal(2);

  beforeEach(async () => {
    await lectura(local(D, 7), 18, { voltaje: 4.1, porcentaje: 90 }); // mañana
    await lectura(local(D, 10), 22, { voltaje: 4.08, porcentaje: 86 }); // mañana
    await lectura(local(D, 13), 30); // tarde (no battery)
    await lectura(local(D, 15), 35); // tarde, edge of "se aguanta"
    await lectura(local(D, 20), 25); // noche
    await lectura(local(D1, 1), 20); // 01:00 next day -> still the night of D
    await lectura(local(D1, 6), 35.1); // 06:00 -> morning of D+1, "mejor ni asomarse"
  });

  it("groups by day (06:00 → 05:59) and by morning, afternoon and night", async () => {
    const res = await analisis();
    expect(res.status).toBe(200);
    expect(res.body.totalLecturas).toBe(7);
    expect(res.body.dias.map((d: any) => d.fecha)).toEqual([D, D1]);

    const [dia, siguiente] = res.body.dias;
    expect(dia).toMatchObject({ lecturas: 6, min: 18, max: 35, promedio: 25, estado: "ideal" });
    expect(dia.franjas.manana).toEqual({ min: 18, max: 22, promedio: 20, lecturas: 2 });
    expect(dia.franjas.tarde).toEqual({ min: 30, max: 35, promedio: 32.5, lecturas: 2 });
    // 20:00 and 01:00 of the next calendar day are the same night
    expect(dia.franjas.noche).toEqual({ min: 20, max: 25, promedio: 22.5, lecturas: 2 });

    expect(siguiente.franjas.manana).toEqual({ min: 35.1, max: 35.1, promedio: 35.1, lecturas: 1 });
    expect(siguiente.franjas.tarde).toBeNull();
    expect(siguiente.franjas.noche).toBeNull();
  });

  it("builds the typical day by local hour", async () => {
    const { body } = await analisis();
    const porHora = Object.fromEntries(body.diaTipico.map((h: any) => [h.hora, h]));
    expect(Object.keys(porHora).map(Number).sort((a, b) => a - b)).toEqual([1, 6, 7, 10, 13, 15, 20]);
    expect(porHora[1]).toMatchObject({ promedio: 20, min: 20, max: 20 });
  });

  it("time in each state uses the same thresholds as the live dashboard", async () => {
    const { body } = await analisis();
    const porClave = Object.fromEntries(body.estados.map((e: any) => [e.clave, e.lecturas]));
    expect(porClave).toEqual({ frio: 1, ideal: 3, calor: 2, extremo: 1 });
    expect(body.estados.map((e: any) => e.clave)).toEqual(["frio", "ideal", "calor", "extremo"]);

    const suma = body.estados.reduce((s: number, e: any) => s + e.porcentaje, 0);
    expect(Math.abs(suma - 100)).toBeLessThanOrEqual(0.2);

    // Same edges as estadoPorTemperatura
    expect(estadoPorTemperatura(20).clave).toBe("ideal");
    expect(estadoPorTemperatura(35).clave).toBe("calor");
    expect(estadoPorTemperatura(35.1).clave).toBe("extremo");
  });

  it("returns records", async () => {
    const { body } = await analisis();
    expect(body.records.maxima).toMatchObject({ temperatura: 35.1 });
    expect(new Date(body.records.maxima.medidoEn).getTime()).toBe(local(D1, 6).getTime());
    expect(body.records.minima).toMatchObject({ temperatura: 18 });
    expect(body.records.diaMasCaliente).toEqual({ fecha: D1, promedio: 35.1 });
    expect(body.records.diaMasFresco).toEqual({ fecha: D, promedio: 25 });
  });

  it("battery only uses readings that carry it, averaged by hour", async () => {
    const { body } = await analisis();
    expect(body.bateria).toHaveLength(2);
    expect(body.bateria.map((b: any) => b.porcentaje)).toEqual([90, 86]);
  });

  it("respects the days window", async () => {
    await lectura(local(fechaLocal(20), 12), 40);
    limpiarCacheAnalisis();
    const corto = await analisis("?dias=10");
    expect(corto.body.totalLecturas).toBe(7);
    const largo = await analisis("?dias=30");
    expect(largo.body.totalLecturas).toBe(8);
  });
});

describe("GET /api/se-puede-salir/analisis without data", () => {
  it("answers empty lists, not an error", async () => {
    const res = await analisis();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalLecturas: 0, dias: [], diaTipico: [], bateria: [], desde: null });
    expect(res.body.records).toEqual({ maxima: null, minima: null, diaMasCaliente: null, diaMasFresco: null });
    expect(res.body.estados.every((e: any) => e.porcentaje === 0)).toBe(true);
  });

  it.each(["0", "91", "abc"])("rejects dias=%s", async (dias) => {
    expect((await analisis(`?dias=${dias}`)).status).toBe(400);
  });
});

describe("GET /api/se-puede-salir/dia", () => {
  const dia = async (qs = "") => request(app).get(`/api/se-puede-salir/dia${qs}`);

  it("returns the 06:00 → 05:59 day, averaged every 10 minutes", async () => {
    await lectura(local("2026-10-14", 5, 59), 10); // still the night of the 13th
    await lectura(local("2026-10-14", 6, 0), 20);
    await lectura(local("2026-10-14", 6, 5), 22); // same 10-min bucket as 06:00
    await lectura(local("2026-10-14", 14, 0), 30);
    await lectura(local("2026-10-15", 5, 50), 18); // night of the 14th
    await lectura(local("2026-10-15", 6, 0), 40); // already the 15th

    const res = await dia("?fecha=2026-10-14");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fecha: "2026-10-14", intervaloMinutos: 10 });
    expect(new Date(res.body.desde).toISOString()).toBe(local("2026-10-14", 6).toISOString());
    expect(new Date(res.body.hasta).toISOString()).toBe(local("2026-10-15", 6).toISOString());
    expect(res.body.puntos.map((p: any) => p.temperatura)).toEqual([21, 30, 18]);
    expect(res.body.puntos[0]).toMatchObject({ min: 20, max: 22 });
  });

  it("works across the end of a month", async () => {
    await lectura(local("2026-11-01", 2), 15);
    const res = await dia("?fecha=2026-10-31");
    expect(res.body.puntos).toHaveLength(1);
  });

  it("answers an empty list for a day without data", async () => {
    const res = await dia("?fecha=2026-01-01");
    expect(res.status).toBe(200);
    expect(res.body.puntos).toEqual([]);
  });

  it.each(["", "?fecha=2026-13-01", "?fecha=14-10-2026", "?fecha=hoy"])("rejects %s", async (qs) => {
    expect((await dia(qs)).status).toBe(400);
  });
});
