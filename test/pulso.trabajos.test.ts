import request from "supertest";
import { Express } from "express";
import { login, setupTestApp } from "./helpers";
import { Database } from "../src/middlewares/database/mongodb";
import * as Trabajos from "../src/routes/pulso/analisis/trabajos.service";
import * as PulsoService from "../src/routes/pulso/pulso.service";
import { captura, limpiarPulso, procesar, proveedorFalso, respuestaNota } from "./pulso.fixtures";

let app: Express;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ app, teardown } = await setupTestApp());
});

afterAll(async () => {
  await teardown?.();
});

beforeEach(async () => {
  await limpiarPulso();
  PulsoService.limpiarCache();
});

/* ----------------------------------------------------------------- analysis jobs (admin) */

describe("pulso: trabajos de análisis", () => {
  it("estimates a range and leaves out what's analyzed or already in a job", async () => {
    await captura({ clave: "youtube:a", publicadoEn: new Date("2026-10-19T18:00:00Z"), texto: "palabra ".repeat(300) });
    await captura({ clave: "youtube:b", publicadoEn: new Date("2026-10-20T18:00:00Z") });
    await captura({ clave: "youtube:c", publicadoEn: new Date("2026-10-20T18:00:00Z"), estado: "analizada" });
    await captura({ clave: "youtube:d", publicadoEn: new Date("2026-10-20T18:00:00Z"), estado: "descargada" });

    const todo = await Trabajos.pendientes({});
    expect(todo.resumen).toMatchObject({ pendientes: 2, yaAnalizadas: 1, sinTranscripcion: 1 });
    expect(todo.resumen.usdEstimado).toBeGreaterThan(0);
    expect(todo.capturas.find((c) => c.clave === "youtube:a")).toMatchObject({ palabras: 300, notasEstimadas: 1, nombreFuente: "Telemax" });

    const dia = await Trabajos.pendientes({ desde: "2026-10-20", hasta: "2026-10-20" });
    expect(dia.capturas.map((c) => c.clave)).toEqual(["youtube:b"]);
    expect((await Trabajos.pendientes({ fuentes: ["otra"] })).resumen.pendientes).toBe(0);

    // Already in a job: not offered again (no double analysis)
    await Trabajos.crear({ desde: "2026-10-20", hasta: "2026-10-20", presupuestoUSD: 1 }, "test");
    expect((await Trabajos.pendientes({})).capturas.map((c) => c.clave)).toEqual(["youtube:a"]);
  });

  it("the estimate is in the range of a real 3 h show (Reporte 100)", () => {
    const e = Trabajos.estimar({ texto: "palabra ".repeat(20500), duracionSeg: 3 * 3600 });
    expect(e.notas).toBe(23);
    expect(e.entrada).toBeGreaterThan(120000);
    expect(e.entrada).toBeLessThan(260000); // v2: + the events calls
    expect(e.salida).toBeGreaterThan(30000);
  });

  it("stops at its budget; the rest stays pending for another job", async () => {
    await captura({ clave: "youtube:a" });
    await captura({ clave: "youtube:b" });
    // Each call costs ~USD 0.4 with this usage: the budget is gone after the first capture
    const caro = proveedorFalso([() => respuestaNota()], { entrada: 400000, salida: 20000 });
    const t = await procesar(caro, 0.1);
    expect(t).toMatchObject({ estado: "detenido", motivo: "presupuesto alcanzado", progreso: { hechas: 1 } });
    expect((await Trabajos.pendientes({})).resumen.pendientes).toBe(1);
  });

  it("a cancelled job doesn't analyze anything else", async () => {
    await captura();
    const t = await Trabajos.crear({ presupuestoUSD: 1 }, "test");
    expect(await Trabajos.cancelar(String(t!._id))).toBe(true);
    const p = proveedorFalso([() => respuestaNota()]);
    await Trabajos.ejecutar(p);
    expect(await Database.Pulso.Trabajos().findOne({ _id: t!._id })).toMatchObject({ estado: "cancelado" });
    expect(p.llamadas).toHaveLength(0);
    expect((await Database.Pulso.Capturas().findOne({}))!.estado).toBe("transcrita");
  });

  it("an analyzed capture is never analyzed again", async () => {
    await captura();
    await procesar(proveedorFalso([() => respuestaNota()]));
    expect(await Trabajos.crear({ presupuestoUSD: 1 }, "test")).toBeNull();
  });

  it("the admin endpoints need an admin session and a budget", async () => {
    await captura();
    expect((await request(app).get("/api/pulso/admin/pendientes")).status).toBe(401);
    expect((await request(app).post("/api/pulso/admin/trabajos").send({ presupuestoUSD: 1 })).status).toBe(401);

    const token = await login(app);
    const pend = await request(app).get("/api/pulso/admin/pendientes?desde=2026-10-01").set("session", token);
    expect(pend.status).toBe(200);
    expect(pend.body.resumen.pendientes).toBe(1);

    expect((await request(app).post("/api/pulso/admin/trabajos").set("session", token).send({})).status).toBe(400);
    // Up to PULSO_PRESUPUESTO_MAX (500 by default): a month can cost more than 50
    const grande = await request(app).post("/api/pulso/admin/trabajos").set("session", token).send({ presupuestoUSD: 600 });
    expect(grande.status).toBe(400);
    expect(JSON.stringify(grande.body)).toContain("0.01 to 500");
    const sinLlave = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect((await request(app).post("/api/pulso/admin/trabajos").set("session", token).send({ presupuestoUSD: 1 })).status).toBe(503);
    process.env.GEMINI_API_KEY = "llave-de-prueba"; // never called: nothing matches the range below
    const nada = await request(app).post("/api/pulso/admin/trabajos").set("session", token).send({ presupuestoUSD: 1, desde: "2020-01-01", hasta: "2020-01-02" });
    expect(nada.status).toBe(409);
    if (sinLlave === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = sinLlave;

    const lista = await request(app).get("/api/pulso/admin/trabajos").set("session", token);
    expect(lista.status).toBe(200);
    expect(lista.body.consumo).toMatchObject({ hoyUSD: 0, mesUSD: 0 });
  });
});

/* ----------------------------------------------------------------- map and crowd */

describe("pulso: mapa y multitud", () => {
  beforeEach(async () => {
    await Database.Pulso.Calles().deleteMany({});
    await Database.Pulso.Colonias().deleteMany({});
    // Two streets that cross at node 2, and two colonies (no network: all local)
    await Database.Pulso.Calles().insertMany([
      { osmId: 1, nombre: "Bulevard Eusebio Kino", normal: "bulevard eusebio kino", palabras: ["eusebio", "kino"], nodos: [1, 2, 3], coords: [[-110.95, 29.09], [-110.94, 29.095], [-110.93, 29.1]] },
      { osmId: 2, nombre: "Calle Rosales", normal: "calle rosales", palabras: ["rosales"], nodos: [4, 2, 5], coords: [[-110.94, 29.08], [-110.94, 29.095], [-110.94, 29.11]] },
    ]);
    await Database.Pulso.Colonias().insertMany([
      { nombre: "Pitic", normal: "pitic", punto: { type: "Point", coordinates: [-110.941, 29.096] } },
      { nombre: "Villa de Seris", normal: "villa de seris", punto: { type: "Point", coordinates: [-110.96, 29.05] } },
    ]);
  });

  async function notaCon(clave: string, extra: any = {}) {
    await captura({ clave });
    await procesar(proveedorFalso([() => respuestaNota(extra)]));
  }

  it("a crossing is placed where the two streets share a node, and grouped by colony", async () => {
    await notaCon("youtube:a");
    const n = await Database.Pulso.Notas().findOne({});
    expect(n!.lugares[0]).toMatchObject({ precision: "cruce", coloniaMapa: "Pitic", geo: { type: "Point", coordinates: [-110.94, 29.095] } });

    const mapa = await request(app).get("/api/pulso/mapa");
    expect(mapa.body.features).toHaveLength(1);
    expect(mapa.body.features[0]).toMatchObject({
      geometry: { coordinates: [-110.94, 29.095] },
      properties: { titulo: "Inicia pago de beca", precision: "cruce", emocion: "alegria", colonia: "Pitic" },
    });
    const colonias = await request(app).get("/api/pulso/mapa/colonias");
    expect(colonias.body.colonias).toEqual([expect.objectContaining({ colonia: "Pitic", notas: 1, emociones: { alegria: 1 } })]);
  });

  it("a colony alone goes to its center; a street alone, or another city, isn't placed", async () => {
    await notaCon("youtube:a", {
      lugares: [
        { mencion: "en Villa de Seris", tipo: "colonia", colonia: "Villa de Seris", municipio: "Hermosillo", rol: "lugar_del_hecho" },
        { mencion: "sobre el bulevar Kino", tipo: "calle", calle_1: "Bulevar Kino", municipio: "Hermosillo", rol: "lugar_del_hecho" },
        { mencion: "en Guaymas", tipo: "colonia", colonia: "Centro", municipio: "Guaymas", rol: "lugar_del_hecho" },
      ],
    });
    const [colonia, calle, guaymas] = (await Database.Pulso.Notas().findOne({}))!.lugares;
    expect(colonia).toMatchObject({ precision: "colonia", geo: { coordinates: [-110.96, 29.05] } });
    expect(calle.geo).toBeUndefined();
    expect(guaymas.geo).toBeUndefined();
  });

  it("crimes against people are blurred to a ~500 m grid, not the exact spot", async () => {
    await notaCon("youtube:a", { clasificacion: { tipo: "hecho", ambito: "local", tema_subtema: "seguridad/homicidios", etiquetas: [], es_alerta: false, relevancia: 0.7 } });
    const l = (await Database.Pulso.Notas().findOne({}))!.lugares[0];
    expect(l.precision).toBe("aproximada");
    expect(l.geo!.coordinates.every((v) => Math.abs(v * 200 - Math.round(v * 200)) < 1e-9)).toBe(true);
  });

  it("the crowd gets the latest notes in its shape", async () => {
    await Database.Pulso.Fuentes().updateOne({ slug: "telemax" }, { $set: { formato: "tv" } });
    await notaCon("youtube:a");
    const res = await request(app).get("/api/pulso/multitud");
    expect(res.body.noticias[0]).toMatchObject({
      titulo: "Inicia pago de beca",
      fuente: { tipo: "tv", nombre: "Telemax" },
      tema: "educacion",
      relevancia: 0.6,
      emociones: expect.objectContaining({ alegria: 0.75 }),
      enlace: "https://youtu.be/a?t=0",
    });
  });

  it("the crowd's next page skips the newest notes", async () => {
    await notaCon("youtube:a");
    await notaCon("youtube:b");
    const todas = (await request(app).get("/api/pulso/multitud")).body.noticias;
    const res = await request(app).get("/api/pulso/multitud?limite=1&saltar=1");
    expect(todas).toHaveLength(2);
    expect(res.body.noticias.map((n: { id: string }) => n.id)).toEqual([todas[1].id]);
    expect((await request(app).get("/api/pulso/multitud?saltar=-1")).status).toBe(400);
  });
});
