import { ObjectId } from "mongodb";
import request from "supertest";
import { Express } from "express";
import { setupTestApp } from "./helpers";
import { Database } from "../src/middlewares/database/mongodb";
import { ICaptura } from "../src/@types/collections/pulso/captura";
import { ANALISIS_VERSION, PULSO_MAX_INTENTOS } from "../src/constants/pulso";
import * as Analisis from "../src/routes/pulso/analisis/analisis.service";
import { ErrorProveedor, IProveedor } from "../src/routes/pulso/analisis/proveedor";
import { captura, limpiarPulso, procesar, proveedorFalso, respuestaNota, segs } from "./pulso.fixtures";
import { enlace, numerar, ordenarBloques, segmentosDe } from "../src/routes/pulso/analisis/segmentos";
import { normalizarEmociones, validarNota } from "../src/routes/pulso/analisis/validar";

let app: Express;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ app, teardown } = await setupTestApp());
});

afterAll(async () => {
  await teardown?.();
});

beforeEach(limpiarPulso);

/* ----------------------------------------------------------------- pure helpers */

describe("pulso: segmentos y validación", () => {
  it("numbers segments with their time and links to the minute", () => {
    expect(numerar(segs(3, 65), 1, 2)).toBe("[1] 0:01:05 frase 1\n[2] 0:02:10 frase 2");
    expect(enlace({ tipo: "youtube", clave: "youtube:XYZ" } as ICaptura, 93.7)).toBe("https://youtu.be/XYZ?t=93");
    expect(enlace({ tipo: "texto", clave: "x:y", url: "https://nota" } as ICaptura, null)).toBe("https://nota");
  });

  it("articles become paragraphs without times", () => {
    const s = segmentosDe({ texto: "Primer párrafo.\n\nSegundo párrafo." } as ICaptura);
    expect(s).toEqual([{ inicio: null, fin: null, texto: "Primer párrafo." }, { inicio: null, fin: null, texto: "Segundo párrafo." }]);
    expect(numerar(s)).toBe("[0] Primer párrafo.\n[1] Segundo párrafo.");
  });

  it("blocks end up contiguous, covering everything, with known classes", () => {
    const b = ordenarBloques(
      [
        { segmento_inicio: 30, segmento_fin: 99, clase: "nota", titulo_provisional: "b" },
        { segmento_inicio: 2, segmento_fin: 20, clase: "inventada", titulo_provisional: "a" },
        { segmento_inicio: 10, segmento_fin: 15, clase: "nota", titulo_provisional: "dentro" },
        { segmento_inicio: 18, segmento_fin: 29, clase: "musica", titulo_provisional: "c" },
      ],
      50
    );
    expect(b.map((x) => [x.segmentoInicio, x.segmentoFin, x.clase])).toEqual([[0, 20, "otro"], [21, 29, "musica"], [30, 49, "nota"]]);
    expect(ordenarBloques([], 5)).toEqual([{ segmentoInicio: 0, segmentoFin: 4, clase: "nota", tituloProvisional: "" }]);
  });

  it("the five emotions sum 1 (no neutral) and each one present keeps its explanation", () => {
    const e = normalizarEmociones({ alegria: { valor: 0.6, explicacion: "Reciben el apoyo." }, miedo: { valor: 0.2, explicacion: "Temen que no alcance." }, neutral: { valor: 5 } });
    expect(Object.keys(e)).toEqual(["alegria", "enojo", "tristeza", "miedo", "sorpresa"]);
    expect(e.alegria).toEqual({ valor: 0.75, explicacion: "Reciben el apoyo." });
    expect(e.enojo).toEqual({ valor: 0, explicacion: null });
    expect(Object.values(e).reduce((a, b) => a + b.valor, 0)).toBeCloseTo(1);
    // Nothing usable: split evenly, without explanations
    expect(normalizarEmociones({}).sorpresa).toEqual({ valor: 0.2, explicacion: null });
  });

  it("validates against the catalog, drops the outlet and timestamps the quotes", () => {
    const n = validarNota(respuestaNota(), { medio: "Telemax", segmentos: segs(10), desde: 0, hasta: 9 });
    expect(n.clasificacion).toMatchObject({ tema: "educacion", subtema: "becas_y_apoyos", etiquetas: [], etiquetasLibres: ["beca"] });
    expect(n.sentimiento).toMatchObject({ intensidad: 0.3, emociones: { alegria: { valor: 0.75 } } });
    expect(n.actores.map((a) => a.nombre)).toEqual(["Alejandra Limón"]);
    expect(n.citas[0]).toMatchObject({ segmento: 2, segundo: 10, rolHablante: "funcionario", atribuidaA: "Alejandra Limón" });
    expect(n.sentimiento.emocionDominante).toBe("alegria");
    expect(n.lugares[0]).toMatchObject({ calle1: "Bulevar Kino", calle2: "Calle Rosales", rol: "lugar_del_hecho" });

    const rara = validarNota(
      respuestaNota({
        clasificacion: { tema_subtema: "deportes/futbol", relevancia: 7 },
        citas: [{ texto: "fuera", segmento: 99 }],
        sentimiento: { polaridad: -5, emociones: {} },
      }),
      { medio: "Telemax", segmentos: segs(10), desde: 0, hasta: 9 }
    );
    expect(rara.clasificacion).toMatchObject({ tema: "otro", subtema: "otro", relevancia: 1 });
    expect(rara.citas).toEqual([]);
    expect(rara.sentimiento).toMatchObject({ polaridad: -1, emocionDominante: "alegria" });
    expect(rara.detalle).toBeNull();
  });
});

/* ----------------------------------------------------------------- the pipeline */

describe("pulso: análisis de capturas", () => {
  it("a short capture is one note; the capture ends ANALIZADA and the cost is logged", async () => {
    await captura();
    const p = proveedorFalso([() => respuestaNota()]);
    const t = await procesar(p);

    expect(t!.motivo).toMatch(/^sin capturas pendientes/);
    expect(t).toMatchObject({ estado: "terminado", progreso: { hechas: 1, notas: 1, errores: 0, entrada: 1000, salida: 200 } });
    expect(t!.progreso.costoUSD).toBeGreaterThan(0);
    expect(p.llamadas).toHaveLength(1); // no split for a short one
    const c = await Database.Pulso.Capturas().findOne({});
    expect(c).toMatchObject({ estado: "analizada", reserva: null });
    expect(c!.historial.map((h) => h.estado)).toEqual(["segmentada", "analizada"]);

    const nota = await Database.Pulso.Notas().findOne({});
    expect(nota).toMatchObject({
      bloque: 0,
      enlace: "https://youtu.be/abc123?t=0",
      tiempo: { inicio: 0, fin: 50, segmentoInicio: 0, segmentoFin: 9 },
      clasificacion: { tema: "educacion" },
      analisis: { version: ANALISIS_VERSION, modelo: "falso" },
    });
    const consumo = await Database.Pulso.Consumo().findOne({});
    expect(consumo).toMatchObject({ modelo: "falso", llamadas: 1, entrada: 1000, salida: 200 });
    expect(consumo!.costoUSD).toBeGreaterThan(0);
  });

  it("a long show is split once; only news blocks become notes, each at its minute", async () => {
    await captura({ duracionSeg: 3 * 3600, segmentos: segs(100) });
    const p = proveedorFalso([
      () => ({
        bloques: [
          { segmento_inicio: 0, segmento_fin: 9, clase: "saludos", titulo_provisional: "" },
          { segmento_inicio: 10, segmento_fin: 39, clase: "nota", titulo_provisional: "Choque" },
          { segmento_inicio: 40, segmento_fin: 59, clase: "titulares", titulo_provisional: "" },
          { segmento_inicio: 60, segmento_fin: 99, clase: "entrevista", titulo_provisional: "Alcalde" },
        ],
      }),
      () => respuestaNota(),
    ]);
    const t = await procesar(p);
    expect(t!.progreso).toMatchObject({ hechas: 1, notas: 2 });
    expect((await Database.Pulso.Capturas().findOne({}))!.bloques).toHaveLength(4);
    expect(p.llamadas[0].pensar).toBe("medium"); // the split
    expect(p.llamadas).toHaveLength(3);
    // Each note only sees its own segments
    expect(p.llamadas[1].texto.startsWith("[10] ") || p.llamadas[2].texto.startsWith("[10] ")).toBe(true);

    const notas = await Database.Pulso.Notas().find({}).sort({ bloque: 1 }).toArray();
    expect(notas.map((n) => [n.bloque, n.clase, n.enlace])).toEqual([
      [1, "nota", "https://youtu.be/abc123?t=50"],
      [3, "entrevista", "https://youtu.be/abc123?t=300"],
    ]);
  });

  it("a failure halfway resumes later without splitting or re-analyzing what's done", async () => {
    await captura({ duracionSeg: 3600, segmentos: segs(40) });
    const corte = () => ({
      bloques: [
        { segmento_inicio: 0, segmento_fin: 19, clase: "nota", titulo_provisional: "a" },
        { segmento_inicio: 20, segmento_fin: 39, clase: "nota", titulo_provisional: "b" },
      ],
    });
    // 1st run: split ok, first note ok, second note answers garbage that breaks the save
    let n = 0;
    const malo = proveedorFalso([corte, () => respuestaNota(), () => { n++; throw new Error("respuesta rota"); }]);
    const primero = await procesar(malo);
    expect(primero!.progreso).toMatchObject({ hechas: 0, errores: 1 });
    let c = await Database.Pulso.Capturas().findOne({});
    expect(c).toMatchObject({ estado: "segmentada", intentos: 1, reserva: null });
    expect(c!.error).toMatch(/respuesta rota/);
    expect(await Database.Pulso.Notas().countDocuments()).toBe(1);

    // 2nd run: only the missing note
    const bueno = proveedorFalso([() => respuestaNota()]);
    await procesar(bueno);
    expect(bueno.llamadas).toHaveLength(1);
    c = await Database.Pulso.Capturas().findOne({});
    expect(c!.estado).toBe("analizada");
    expect(await Database.Pulso.Notas().countDocuments()).toBe(2);
  });

  it("no credit / bad key frees the capture without counting a try and stops the worker", async () => {
    await captura();
    const sinSaldo: IProveedor = { modelo: "falso", generar: async () => { throw new ErrorProveedor("Gemini 402", true); } };
    const t = await procesar(sinSaldo);
    expect(t).toMatchObject({ estado: "detenido" });
    expect(t!.motivo).toMatch(/proveedor/);
    const c = await Database.Pulso.Capturas().findOne({});
    // Already split into its single block (no model call for that), freed, no try counted
    expect(c).toMatchObject({ estado: "segmentada", intentos: 0, reserva: null });
  });

  it("after the max tries a capture stays in ERROR", async () => {
    await captura();
    const roto = proveedorFalso([() => { throw new Error("siempre falla"); }]);
    // One try per pass (it isn't retried in the same pass)
    await procesar(roto);
    expect((await Database.Pulso.Capturas().findOne({}))!.intentos).toBe(1);
    for (let i = 0; i < PULSO_MAX_INTENTOS; i++) await procesar(roto);
    const c = await Database.Pulso.Capturas().findOne({});
    expect(c).toMatchObject({ estado: "error", intentos: PULSO_MAX_INTENTOS });
    expect(roto.llamadas).toHaveLength(PULSO_MAX_INTENTOS);
  });

  it("the daily cap stops the worker before calling the model", async () => {
    await captura();
    process.env.PULSO_TOKENS_DIA = "500";
    try {
      await Database.Pulso.Consumo().insertOne({ fecha: (await import("../src/routes/pulso/analisis/consumo")).hoy(), modelo: "falso", llamadas: 1, entrada: 400, salida: 200, costoUSD: 0 });
      const p = proveedorFalso([() => respuestaNota()]);
      const t = await procesar(p);
      expect(t).toMatchObject({ estado: "detenido", motivo: "tope diario de tokens" });
      expect(p.llamadas).toHaveLength(0);
    } finally {
      delete process.env.PULSO_TOKENS_DIA;
    }
  });

  it("a capture someone is working on isn't taken twice; an expired lease is", async () => {
    const c = await captura();
    const ids = [c._id as ObjectId];
    expect(await Analisis.tomar("uno", ids)).not.toBeNull();
    expect(await Analisis.tomar("dos", ids)).toBeNull();
    await Database.Pulso.Capturas().updateOne({ _id: c._id as ObjectId }, { $set: { "reserva.hasta": new Date(Date.now() - 1000) } });
    expect((await Analisis.tomar("dos", ids))?.reserva?.por).toBe("dos");
    expect(await Analisis.tomar("tres", [new ObjectId()])).toBeNull(); // not in the job's list
  });

  it("other states are left alone", async () => {
    await captura({ estado: "descargada" });
    await captura({ clave: "youtube:otra", estado: "analizada" });
    const p = proveedorFalso([() => respuestaNota()]);
    expect(await procesar(p)).toBeNull(); // nothing to put in a job
    expect(p.llamadas).toHaveLength(0);
  });
});

/* ----------------------------------------------------------------- public API */

describe("pulso: API pública", () => {
  const PulsoService = require("../src/routes/pulso/pulso.service");

  /** Analyzes a short capture with the given answer, so the note is stored exactly as in production */
  async function notaCon(clave: string, extra: any = {}, campos: Partial<ICaptura> = {}) {
    await captura({ clave, ...campos });
    await procesar(proveedorFalso([() => respuestaNota(extra)]));
  }

  beforeEach(() => PulsoService.limpiarCache());

  it("lists notes newest first, with filters, and never the raw model answer", async () => {
    await notaCon("youtube:a", {}, { publicadoEn: new Date("2026-10-19T15:00:00Z") });
    await notaCon("youtube:b", {
      titulo: "Corte de agua en Villa de Seris",
      clasificacion: { tipo: "hecho", ambito: "local", tema_subtema: "servicios_publicos/agua", etiquetas: ["agua"], es_alerta: true, relevancia: 0.8 },
      sentimiento: { ...respuestaNota().sentimiento, emociones: { enojo: { valor: 0.8, explicacion: "Sin agua dos días." }, tristeza: { valor: 0.2, explicacion: "Familias afectadas." } } },
    }, { publicadoEn: new Date("2026-10-20T15:00:00Z") });

    const todas = await request(app).get("/api/pulso/notas");
    expect(todas.status).toBe(200);
    expect(todas.body).toMatchObject({ total: 2, pagina: 1 });
    expect(todas.body.notas.map((n: any) => n.titulo)).toEqual(["Corte de agua en Villa de Seris", "Inicia pago de beca"]);
    expect(JSON.stringify(todas.body)).not.toContain("crudo");

    const enojo = await request(app).get("/api/pulso/notas?emocion=enojo&tema=servicios_publicos");
    expect(enojo.body.notas.map((n: any) => n.clave)).toEqual(["youtube:b"]);
    expect((await request(app).get("/api/pulso/notas?q=villa de seris")).body.total).toBe(1);
    expect((await request(app).get("/api/pulso/notas?desde=2026-10-20&hasta=2026-10-20")).body.total).toBe(1);
    expect((await request(app).get("/api/pulso/notas?actor=alejandra limón")).body.total).toBe(2);
  });

  it("never shows a minor's name, not even as the speaker of a quote or as an actor filter", async () => {
    await notaCon("youtube:m", {
      actores: [{ nombre: "Brandon Pérez", tipo: "persona", rol: "afectado", es_menor: true }],
      citas: [{ texto: "Me duele", quien: "Brandon Pérez", segmento: 1 }],
    });
    const res = await request(app).get("/api/pulso/notas");
    expect(JSON.stringify(res.body)).not.toContain("Brandon");
    expect(res.body.notas[0].actores[0].nombre).toBe("Menor de edad");
    expect(res.body.notas[0].citas[0].quien).toBe("Menor de edad");

    const una = await request(app).get(`/api/pulso/notas/${res.body.notas[0]._id}`);
    expect(JSON.stringify(una.body)).not.toContain("Brandon");
    expect((await request(app).get("/api/pulso/notas?actor=brandon pérez")).body.total).toBe(0);
    expect((await request(app).get("/api/pulso/actores")).body.actores.map((a: any) => a.nombre)).not.toContain("Brandon Pérez");
  });

  it("overview: totals, topics, emotions and notes per day (Hermosillo time)", async () => {
    await notaCon("youtube:a", {}, { publicadoEn: new Date("2026-10-21T03:00:00Z"), duracionSeg: 3600 }); // 20 Oct 20:00 local
    const res = await request(app).get("/api/pulso/resumen");
    expect(res.status).toBe(200);
    expect(res.body.totales).toMatchObject({ notas: 1, capturas: 1, horasAnalizadas: 1 });
    expect(res.body.temas).toEqual([{ tema: "educacion", notas: 1, eventos: 1, emociones: { alegria: 1 }, subtemas: { becas_y_apoyos: 1 } }]);
    expect(res.body.dias).toEqual([{ fecha: "2026-10-20", notas: 1, emociones: { alegria: 1 } }]);
    expect(res.body.emociones.promedio.alegria).toBe(0.75);
  });

  it("outlets: tone toward each level of government ignores the notes that don't talk about it", async () => {
    const postura = (federal: number | null) => ({ sentimiento: { ...respuestaNota().sentimiento, postura_gobierno: { municipal: null, estatal: null, federal } } });
    await notaCon("youtube:a", postura(0.8));
    await notaCon("youtube:b", postura(-0.2));
    await notaCon("youtube:c", postura(null));
    const res = await request(app).get("/api/pulso/medios");
    expect(res.body.medios).toHaveLength(1);
    expect(res.body.medios[0]).toMatchObject({ fuente: "telemax", nombre: "Telemax", notas: 3 });
    expect(res.body.medios[0].postura.federal).toEqual({ promedio: 0.3, notas: 2 });
    expect(res.body.medios[0].postura.municipal).toEqual({ promedio: null, notas: 0 });
  });

  it("actors: most mentioned with their average tone (the outlet isn't one)", async () => {
    await notaCon("youtube:a");
    await notaCon("youtube:b");
    const res = await request(app).get("/api/pulso/actores");
    expect(res.body.actores).toEqual([
      expect.objectContaining({ nombre: "Alejandra Limón", menciones: 2, tono: 0.4, medios: 1 }),
    ]);
  });

  it("rejects bad filters and unknown notes", async () => {
    expect((await request(app).get("/api/pulso/notas?emocion=felicidad")).status).toBe(400);
    expect((await request(app).get("/api/pulso/notas?porPagina=500")).status).toBe(400);
    expect((await request(app).get("/api/pulso/notas/no-es-un-id")).status).toBe(404);
    expect((await request(app).get(`/api/pulso/notas/${new ObjectId()}`)).status).toBe(404);
  });
});
