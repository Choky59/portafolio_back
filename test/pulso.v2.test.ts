import request from "supertest";
import { Express } from "express";
import { ObjectId } from "mongodb";
import { login, setupTestApp } from "./helpers";
import { Database } from "../src/middlewares/database/mongodb";
import * as Trabajos from "../src/routes/pulso/analisis/trabajos.service";
import * as PulsoService from "../src/routes/pulso/pulso.service";
import { semanaISO, tiempoLocal } from "../src/routes/pulso/analisis/tiempo";
import * as Cobertura from "../src/routes/pulso/analisis/cobertura.service";
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
  await Database.Pulso.Fuentes().insertOne({ slug: "expreso", nombre: "Expreso", tipo: "youtube", medio: "Expreso", activa: true });
  PulsoService.limpiarCache();
});

/** The crash of the prompt's example, as told by one outlet */
function choque(extra: any = {}) {
  return respuestaNota({
    titulo: "Choque en Navarrete y Sahuaripa",
    clasificacion: { tipo: "hecho", ambito: "local", tema_subtema: "movilidad/accidentes_viales", tema_secundario: null, etiquetas: ["choque"], es_alerta: false, relevancia: 0.5 },
    lugares: [{ mencion: "Navarrete y Sahuaripa", tipo: "cruce", calle_1: "Navarrete", calle_2: "Sahuaripa", municipio: "Hermosillo", rol: "lugar_del_hecho" }],
    actores: [
      { nombre: "Cruz Roja", tipo: "organizacion_civil", rol: "mencionado", es_menor: false },
      { nombre: "Tránsito Municipal", tipo: "institucion_gobierno", nivel_gobierno: "municipal", rol: "fuente_citada", es_menor: false },
    ],
    fechas: { ocurrio: "2026-10-16", ocurrio_franja: "madrugada", ocurrio_hora: 4, proximos_eventos: [] },
    detalle: {
      accidente_vial: { modalidad: "choque", vehiculos: 2, heridos: 1, fallecidos: 0, gravedad: "leve_moderada", involucra_transporte_publico: false, involucra_peaton_ciclista: false },
      delito: null,
    },
    citas: [{ texto: "Uno de los conductores no respetó el alto", quien: "Alan Rubio", rol_hablante: "reportero", atribuida_a: "Tránsito Municipal", segmento: 1 }],
    ...extra,
  });
}

/** Answers the relation call: every candidate gets `relacion` */
const todasComo = (relacion: string, confianza = 0.9) => (p: any) => ({
  relaciones: JSON.parse(p.texto).candidatas.map((c: any) => ({ nota_id: c.nota_id, relacion, confianza, justificacion: "Mismo cruce y hora.", discrepancias: ["Un medio dice 1 herido, otro 2"] })),
});

/* ----------------------------------------------------------------- local time */

describe("pulso v2: tiempo local", () => {
  it("publication hour and weekday in Hermosillo, ISO week and month", () => {
    // 12:30 UTC = 05:30 in Hermosillo (UTC-7)
    const t = tiempoLocal(new Date("2026-10-16T12:30:00Z"), { ocurrio: "2026-10-16", ocurrioFranja: "madrugada", ocurrioHora: 4 });
    expect(t).toEqual({
      publicadoFecha: "2026-10-16", publicadoHora: 5, publicadoDiaSemana: "viernes",
      ocurrioFecha: "2026-10-16", ocurrioDiaSemana: "viernes", ocurrioFranja: "madrugada", ocurrioHora: 4,
      rezagoDias: 0, semanaISO: "2026-W42", mes: "2026-10",
    });
    // Late at night UTC is still the day before locally
    expect(tiempoLocal(new Date("2026-10-17T03:00:00Z"), { ocurrio: "2026-10-15", ocurrioFranja: null, ocurrioHora: null })).toMatchObject({ publicadoFecha: "2026-10-16", publicadoHora: 20, rezagoDias: 1 });
    expect(tiempoLocal(null, { ocurrio: null, ocurrioFranja: null, ocurrioHora: null })).toMatchObject({ publicadoHora: null, semanaISO: null, mes: null });
  });

  it("ISO weeks at the edges of the year", () => {
    expect(semanaISO("2026-01-01")).toBe("2026-W01");
    expect(semanaISO("2027-01-01")).toBe("2026-W53");
    expect(semanaISO("2025-12-29")).toBe("2026-W01");
  });
});

/* ----------------------------------------------------------------- events across outlets */

describe("pulso v2: eventos entre medios", () => {
  it("two outlets telling the same crash share one event (numMedios 2), in publication order", async () => {
    // Expreso's capture was found first but published later: the job still goes by publication
    await captura({ clave: "youtube:expreso", fuente: "expreso", publicadoEn: new Date("2026-10-16T18:00:00Z") });
    await captura({ clave: "youtube:telemax", publicadoEn: new Date("2026-10-16T12:30:00Z") });
    const p = proveedorFalso([() => choque()], undefined, { relacion: todasComo("mismo_evento") });
    const t = await procesar(p);
    expect(t).toMatchObject({ estado: "terminado", progreso: { hechas: 2, notas: 2, errores: 0 } });
    expect(t!.motivo).toContain("1 consolidados");

    const telemax = await Database.Pulso.Notas().findOne({ clave: "youtube:telemax" });
    const expreso = await Database.Pulso.Notas().findOne({ clave: "youtube:expreso" });
    expect(telemax!.evento).toMatchObject({ justificacion: "primera nota de este suceso" });
    expect(String(expreso!.evento!.eventoId)).toBe(String(telemax!.evento!.eventoId));
    expect(expreso!.relaciones).toEqual([expect.objectContaining({ notaId: telemax!._id, tipo: "mismo_evento", confianza: 0.9 })]);
    // Only the later one needed the model (the first had no candidates)
    const relacion = p.llamadasEventos.filter((x) => x.texto.includes("nota_nueva"));
    expect(relacion).toHaveLength(1);
    expect(JSON.parse(relacion[0].texto).nota_nueva.medio).toBe("Expreso");

    const evento = await Database.Pulso.Eventos().findOne({ _id: telemax!.evento!.eventoId });
    expect(evento).toMatchObject({ numMedios: 2, fuentes: expect.arrayContaining(["telemax", "expreso"]), pendienteConsolidar: false, titulo: "Evento" });
    expect(evento!.notas).toHaveLength(2);
    expect(evento!.primeraPublicacion).toEqual(new Date("2026-10-16T12:30:00Z"));

    // The prompt's acceptance checks on the note itself
    expect(telemax!.tiempoLocal).toMatchObject({ publicadoHora: 5, ocurrioDiaSemana: "viernes", ocurrioFranja: "madrugada" });
    expect(telemax!.actores.find((a) => a.nombre === "Cruz Roja")).toMatchObject({ tipo: "organizacion_civil" });
    const transito = telemax!.actores.find((a) => a.nombre === "Tránsito Municipal")!;
    expect(transito.actorId).toBeInstanceOf(ObjectId);
    expect(telemax!.citas[0]).toMatchObject({ quien: "Alan Rubio", rolHablante: "reportero", atribuidaA: "Tránsito Municipal", atribuidaActorId: transito.actorId });
    expect(telemax!.detalle).toMatchObject({ tipo: "accidente_vial", vehiculos: 2, heridos: 1, gravedad: "leve_moderada" });
    expect(telemax!.analisis).toMatchObject({ version: 2, promptVersion: expect.any(String), rubricaVersion: 1 });
    expect(telemax!.fuenteId).toBeInstanceOf(ObjectId);
    // Same actor in both outlets: one catalog entry
    expect(await Database.Pulso.Actores().countDocuments({ normal: "transito municipal" })).toBe(1);
    expect(await Database.Pulso.Etiquetas().findOne({ normal: "choque" })).toMatchObject({ usos: 2 });

    const c = await Database.Pulso.Capturas().findOne({ clave: "youtube:telemax" });
    expect(c).toMatchObject({ bloquesEsperados: 1, bloquesProcesados: 1 });

    // Public API: the card knows how many outlets told it
    const res = await request(app).get("/api/pulso/notas");
    expect(res.body.notas[0].eventoInfo).toMatchObject({ numMedios: 2, notas: 2, discrepancias: [] });
    const resumen = await request(app).get("/api/pulso/resumen");
    expect(resumen.body.totales).toMatchObject({ notas: 2, eventos: 1, multimedio: 1 });
  });

  it("a follow-up joins the event and points to the earlier note", async () => {
    await captura({ clave: "youtube:a", publicadoEn: new Date("2026-10-16T12:30:00Z") });
    await captura({ clave: "youtube:b", fuente: "expreso", publicadoEn: new Date("2026-10-17T15:00:00Z") });
    await procesar(proveedorFalso([() => choque()], undefined, { relacion: todasComo("seguimiento", 0.8) }));
    const a = await Database.Pulso.Notas().findOne({ clave: "youtube:a" });
    const b = await Database.Pulso.Notas().findOne({ clave: "youtube:b" });
    expect(b!.seguimientoDe).toEqual(a!._id);
    expect(String(b!.evento!.eventoId)).toBe(String(a!.evento!.eventoId));
  });

  it("unrelated or unsure: separate events, and 'distinto' isn't kept as a relation", async () => {
    await captura({ clave: "youtube:a", publicadoEn: new Date("2026-10-16T12:30:00Z") });
    await captura({ clave: "youtube:b", fuente: "expreso", publicadoEn: new Date("2026-10-16T15:00:00Z") });
    await procesar(proveedorFalso([() => choque()], undefined, { relacion: todasComo("distinto") }));
    expect(await Database.Pulso.Eventos().countDocuments()).toBe(2);
    expect((await Database.Pulso.Notas().findOne({ clave: "youtube:b" }))!.relaciones).toEqual([]);

    await limpiarPulso();
    await Database.Pulso.Fuentes().insertOne({ slug: "expreso", nombre: "Expreso", tipo: "youtube", medio: "Expreso", activa: true });
    await captura({ clave: "youtube:a", publicadoEn: new Date("2026-10-16T12:30:00Z") });
    await captura({ clave: "youtube:b", fuente: "expreso", publicadoEn: new Date("2026-10-16T15:00:00Z") });
    await procesar(proveedorFalso([() => choque()], undefined, { relacion: todasComo("mismo_evento", 0.5) }));
    expect(await Database.Pulso.Eventos().countDocuments()).toBe(2); // under 0.7: not joined
  });

  it("candidates need to be close in time: a week apart is never compared", async () => {
    await captura({ clave: "youtube:a", publicadoEn: new Date("2026-10-01T12:30:00Z") });
    await captura({ clave: "youtube:b", fuente: "expreso", publicadoEn: new Date("2026-10-09T15:00:00Z") });
    const otraFecha = choque({ fechas: { ocurrio: "2026-10-09", ocurrio_franja: null, ocurrio_hora: null, proximos_eventos: [] } });
    const p = proveedorFalso([() => choque({ fechas: { ocurrio: "2026-10-01", ocurrio_franja: null, ocurrio_hora: null, proximos_eventos: [] } }), () => otraFecha], undefined, { relacion: todasComo("mismo_evento") });
    await procesar(p);
    expect(p.llamadasEventos.filter((x) => x.texto.includes("nota_nueva"))).toHaveLength(0);
    expect(await Database.Pulso.Eventos().countDocuments()).toBe(2);
  });

  it("at the end of a job, events that turn out to be the same are merged", async () => {
    await captura({ clave: "youtube:a", publicadoEn: new Date("2026-10-16T12:30:00Z") });
    await captura({ clave: "youtube:b", fuente: "expreso", publicadoEn: new Date("2026-10-16T15:00:00Z") });
    const p = proveedorFalso([() => choque()], undefined, {
      relacion: todasComo("relacionado", 0.6),
      fusion: (x: any) => ({ decisiones: JSON.parse(x.texto).candidatos.map((c: any) => ({ evento_id: c.evento_id, mismo_evento: true, confianza: 0.9, justificacion: "Mismo choque." })) }),
    });
    const t = await procesar(p);
    expect(t!.motivo).toContain("1 fusionados");
    const eventos = await Database.Pulso.Eventos().find({}).toArray();
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ numMedios: 2, titulo: "Evento" });
    expect(await Database.Pulso.Notas().countDocuments({ "evento.eventoId": eventos[0]._id })).toBe(2);
    // "relacionado" is kept on the note even though it didn't decide the event
    expect((await Database.Pulso.Notas().findOne({ clave: "youtube:b" }))!.relaciones![0]).toMatchObject({ tipo: "relacionado" });
  });

  it("interviews and opinion aren't events", async () => {
    await captura({ clave: "youtube:a", duracionSeg: 3 * 3600, segmentos: Array.from({ length: 60 }, (_, i) => ({ inicio: i * 5, fin: i * 5 + 5, texto: `f ${i}` })) });
    await procesar(proveedorFalso([
      () => ({ bloques: [{ segmento_inicio: 0, segmento_fin: 29, clase: "entrevista", titulo_provisional: "Entrevista" }, { segmento_inicio: 30, segmento_fin: 59, clase: "nota", titulo_provisional: "Choque" }] }),
      () => choque(),
    ]));
    const notas = await Database.Pulso.Notas().find({}).sort({ bloque: 1 }).toArray();
    expect(notas.map((n) => [n.clase, !!n.evento])).toEqual([["entrevista", false], ["nota", true]]);
  });
});

/* ----------------------------------------------------------------- deleting analyses */

describe("pulso v2: borrar análisis", () => {
  async function dosDias() {
    await captura({ clave: "youtube:a", publicadoEn: new Date("2026-10-16T12:30:00Z") });
    await captura({ clave: "youtube:b", fuente: "expreso", publicadoEn: new Date("2026-10-17T15:00:00Z") });
    await captura({ clave: "youtube:sin", estado: "descargada", texto: null, segmentos: null });
    await procesar(proveedorFalso([() => choque()], undefined, { relacion: todasComo("seguimiento") }));
  }

  it("admin only, needs BORRAR, and a preview that touches nothing", async () => {
    await dosDias();
    expect((await request(app).get("/api/pulso/admin/borrado")).status).toBe(401);
    const token = await login(app);
    const prev = await request(app).get("/api/pulso/admin/borrado").set("session", token);
    expect(prev.status).toBe(200);
    expect(prev.body).toMatchObject({ todo: true, capturas: 2, notas: 2, eventosAfectados: 1, eventosQueSeBorran: 1, trabajoActivo: false });
    expect(await Database.Pulso.Notas().countDocuments()).toBe(2);

    expect((await request(app).post("/api/pulso/admin/borrado").set("session", token).send({})).status).toBe(400);
    expect((await request(app).post("/api/pulso/admin/borrado").set("session", token).send({ confirmacion: "borrar" })).status).toBe(400);
  });

  it("everything: notes, events and AI catalogs go; transcripts, spend and job history stay", async () => {
    await dosDias();
    const gasto = await Database.Pulso.Consumo().find({}).toArray();
    const token = await login(app);
    const res = await request(app).post("/api/pulso/admin/borrado").set("session", token).send({ confirmacion: "BORRAR" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ capturas: 2, notas: 2, eventos: 1 });

    expect(await Database.Pulso.Notas().countDocuments()).toBe(0);
    expect(await Database.Pulso.Eventos().countDocuments()).toBe(0);
    expect(await Database.Pulso.Actores().countDocuments({ creadoPor: "ia" })).toBe(0);
    expect(await Database.Pulso.Etiquetas().countDocuments()).toBe(0);
    expect(await Database.Pulso.Consumo().find({}).toArray()).toEqual(gasto);
    expect(await Database.Pulso.Trabajos().countDocuments()).toBe(1);

    const c = await Database.Pulso.Capturas().findOne({ clave: "youtube:a" });
    expect(c).toMatchObject({ estado: "transcrita", intentos: 0, error: null, reserva: null, texto: "x" });
    expect(c!.bloques).toBeUndefined();
    expect(c!.historial.at(-1)).toMatchObject({ estado: "transcrita", detalle: "análisis borrado por admin" });
    expect(await Database.Pulso.Capturas().findOne({ clave: "youtube:sin" })).toMatchObject({ estado: "descargada" });

    // They're pending again: one job analyzes them with the current prompt
    expect((await Trabajos.pendientes({})).resumen.pendientes).toBe(2);
  });

  it("a range: only those notes; the event keeps the other outlet and loses the dangling links", async () => {
    await dosDias();
    const a = await Database.Pulso.Notas().findOne({ clave: "youtube:a" });
    const r = await Trabajos.borrar({ desde: "2026-10-16", hasta: "2026-10-16" }, "test");
    expect(r).toEqual({ capturas: 1, notas: 1, eventos: 0 });
    const b = await Database.Pulso.Notas().findOne({ clave: "youtube:b" });
    expect(b!.seguimientoDe).toBeNull();
    expect(b!.relaciones).toEqual([]);
    const e = await Database.Pulso.Eventos().findOne({ _id: b!.evento!.eventoId });
    expect(e).toMatchObject({ numMedios: 1, fuentes: ["expreso"], detalleConsolidado: null });
    expect(e!.notas.map(String)).not.toContain(String(a!._id));
    expect(await Database.Pulso.Etiquetas().findOne({ normal: "choque" })).toMatchObject({ usos: 1 });
    expect(await Database.Pulso.Capturas().findOne({ clave: "youtube:a" })).toMatchObject({ estado: "transcrita" });
  });

  it("also deletes v1 notes (tags as plain text, no event)", async () => {
    const c = await captura({ clave: "youtube:v1", estado: "analizada", publicadoEn: new Date("2026-10-10T15:00:00Z") });
    await Database.Pulso.Notas().insertOne({
      capturaId: c._id, clave: "youtube:v1", fuente: "telemax", bloque: 0, clase: "nota", titulo: "Vieja", publicadoEn: c.publicadoEn,
      clasificacion: { tema: "educacion", subtema: "becas_y_apoyos", etiquetas: ["beca", "sep"] },
      analisis: { version: 1, modelo: "falso" },
    } as any);
    expect(await Trabajos.borrar({ desde: "2026-10-10", hasta: "2026-10-10" }, "test")).toEqual({ capturas: 1, notas: 1, eventos: 0 });
    expect(await Database.Pulso.Capturas().findOne({ clave: "youtube:v1" })).toMatchObject({ estado: "transcrita" });
  });

  it("refused while a job is active (409)", async () => {
    await dosDias();
    await captura({ clave: "youtube:nueva", publicadoEn: new Date("2026-10-18T15:00:00Z") });
    await Trabajos.crear({ presupuestoUSD: 1 }, "test"); // queued, not run
    const token = await login(app);
    const res = await request(app).post("/api/pulso/admin/borrado").set("session", token).send({ confirmacion: "BORRAR" });
    expect(res.status).toBe(409);
    expect(await Database.Pulso.Notas().countDocuments()).toBe(2);
  });
});

/* ----------------------------------------------------------------- known places */

describe("pulso v2: lugares conocidos", () => {
  const TRIBUNAL: [number, number] = [-110.958, 29.0732];
  const FEDERAL: [number, number] = [-110.9683, 29.0899];

  async function catalogo() {
    const sede = (nombre: string, p: [number, number], principal = true) => ({ nombre, normal: nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(), geo: { type: "Point" as const, coordinates: p }, coloniaId: null, principal });
    await Database.Pulso.LugaresConocidos().insertMany([
      { nombre: "Poder Judicial del Estado de Sonora", normal: "poder judicial", alias: ["poder judicial", "poder judicial del estado", "supremo tribunal de justicia"], categoria: "sede_gobierno", actorId: null, sedes: [sede("Supremo Tribunal de Justicia", TRIBUNAL)], fuenteGeo: "nominatim", creadoPor: "base", creadoEn: new Date() },
      { nombre: "Poder Judicial de la Federación", normal: "poder judicial de la federacion", alias: ["poder judicial de la federacion"], categoria: "sede_gobierno", actorId: null, sedes: [sede("Poder Judicial de la Federación", FEDERAL)], fuenteGeo: "nominatim", creadoPor: "base", creadoEn: new Date() },
      { nombre: "Cruz Roja Mexicana Hermosillo", normal: "cruz roja mexicana hermosillo", alias: ["cruz roja"], categoria: "hospital", actorId: null, sedes: [sede("Delegación Hermosillo", [-110.9704, 29.0905]), sede("Delegación Estatal", [-111.0071, 29.078], false)], fuenteGeo: "nominatim", creadoPor: "base", creadoEn: new Date() },
    ] as any);
  }

  /** The jubilados' protest of the real note: "HERMOSILLO" + "Poder Judicial" with its official name */
  const protesta = (lugares: any[]) =>
    respuestaNota({
      clasificacion: { tipo: "denuncia_ciudadana", ambito: "local", tema_subtema: "justicia/procesos_judiciales", etiquetas: [], es_alerta: false, relevancia: 0.4 },
      lugares,
      actores: [{ nombre: "Poder Judicial", tipo: "institucion_gobierno", institucion: "Poder Judicial del Estado de Sonora", nivel_gobierno: "estatal", rol: "mencionado", es_menor: false }],
    });
  const ciudad = { mencion: "HERMOSILLO", tipo: "municipio", municipio: "Hermosillo", rol: "lugar_del_hecho" };
  const poderJudicial = { mencion: "Poder Judicial", tipo: "edificio", lugar_referencia: "Poder Judicial del Estado de Sonora", municipio: "Hermosillo", rol: "lugar_del_hecho" };

  it("a building named by its official name lands on its seat (not the federal one); the city becomes context", async () => {
    await catalogo();
    await captura();
    await procesar(proveedorFalso([() => protesta([ciudad, poderJudicial])]));
    const n = await Database.Pulso.Notas().findOne({});
    const [hmo, pj] = n!.lugares;
    expect(hmo).toMatchObject({ rol: "contexto" });
    expect(hmo.geo).toBeUndefined();
    expect(pj).toMatchObject({ geo: { coordinates: TRIBUNAL }, precision: "lugar", geocodificador: "lugar_conocido", confianzaGeo: 0.75, esSedeInstitucional: true });
    const catalogado = await Database.Pulso.LugaresConocidos().findOne({ normal: "poder judicial" });
    expect(pj.lugarConocidoId).toEqual(catalogado!._id);
    // The building is the note's actor, and the catalog learns it
    const actor = n!.actores.find((a) => a.nombre === "Poder Judicial")!;
    expect(pj.actorId).toEqual(actor.actorId);
    expect((await Database.Pulso.LugaresConocidos().findOne({ _id: catalogado!._id }))!.actorId).toEqual(actor.actorId);
    // Nothing was asked to Nominatim
    expect(await Database.Pulso.Geocache().countDocuments()).toBe(0);
  });

  it("the most specific name wins, and several seats without one named use the main one (0.6)", async () => {
    await catalogo();
    await captura();
    await procesar(proveedorFalso([() => protesta([
      { mencion: "juzgados del Poder Judicial de la Federación", tipo: "edificio", lugar_referencia: "Poder Judicial de la Federación", municipio: "Hermosillo", rol: "lugar_del_hecho" },
      { mencion: "la Cruz Roja", tipo: "edificio", municipio: "Hermosillo", rol: "lugar_del_hecho" },
      { mencion: "Cruz Roja delegación estatal", tipo: "edificio", lugar_referencia: "Cruz Roja", municipio: "Hermosillo", rol: "lugar_del_hecho" },
    ])]));
    const [federal, cruz, estatal] = (await Database.Pulso.Notas().findOne({}))!.lugares;
    expect(federal.geo!.coordinates).toEqual(FEDERAL);
    expect(cruz).toMatchObject({ geo: { coordinates: [-110.9704, 29.0905] }, confianzaGeo: 0.6, esSedeInstitucional: false });
    expect(estatal).toMatchObject({ geo: { coordinates: [-111.0071, 29.078] }, confianzaGeo: 0.75 });
  });

  it("a building not in the catalog is looked up once and learned (inside the city only)", async () => {
    await Database.Pulso.Geocache().insertMany([
      { consulta: "Hospital Chávez, Hermosillo, Sonora", resultado: { lon: -110.95, lat: 29.08 }, fuente: "nominatim", en: new Date() },
      { consulta: "Torre Lejana, Hermosillo, Sonora", resultado: { lon: -100, lat: 20 }, fuente: "nominatim", en: new Date() },
      { consulta: "la torre, Hermosillo, Sonora", resultado: null, fuente: "nominatim", en: new Date() },
    ]);
    await captura();
    await procesar(proveedorFalso([() => protesta([
      { mencion: "el Chávez", tipo: "edificio", lugar_referencia: "Hospital Chávez", municipio: "Hermosillo", rol: "lugar_del_hecho" },
      { mencion: "la torre", tipo: "edificio", lugar_referencia: "Torre Lejana", municipio: "Hermosillo", rol: "lugar_del_hecho" },
    ])]));
    const [chavez, torre] = (await Database.Pulso.Notas().findOne({}))!.lugares;
    expect(chavez).toMatchObject({ geo: { coordinates: [-110.95, 29.08] }, geocodificador: "lugar_conocido" });
    expect(torre.geo).toBeUndefined();
    const aprendido = await Database.Pulso.LugaresConocidos().findOne({ normal: "hospital chavez" });
    expect(aprendido).toMatchObject({ categoria: "hospital", creadoPor: "ia", alias: expect.arrayContaining(["chavez", "hospital chavez"]) });
    expect(chavez.lugarConocidoId).toEqual(aprendido!._id);
    expect(await Database.Pulso.LugaresConocidos().countDocuments()).toBe(1);
  });

  it("government buildings stay out of the by-colony map; sharing one makes notes event candidates", async () => {
    await catalogo();
    await Database.Pulso.Colonias().insertOne({ nombre: "Centro", normal: "centro", punto: { type: "Point", coordinates: [-110.9585, 29.0735] } });
    await captura({ clave: "youtube:a", publicadoEn: new Date("2026-10-20T15:00:00Z") });
    await captura({ clave: "youtube:b", fuente: "expreso", publicadoEn: new Date("2026-10-20T18:00:00Z") });
    const otroTema = { tipo: "hecho", ambito: "local", tema_subtema: "politica/protestas_y_movimientos", etiquetas: [], es_alerta: false, relevancia: 0.4 };
    const p = proveedorFalso([() => protesta([ciudad, poderJudicial]), () => ({ ...protesta([poderJudicial]), clasificacion: otroTema, actores: [] })], undefined, { relacion: todasComo("mismo_evento") });
    await procesar(p);
    expect(p.llamadasEventos.filter((x) => x.texto.includes("nota_nueva"))).toHaveLength(1); // different topic and actors, same building
    const n = await Database.Pulso.Notas().findOne({ clave: "youtube:a" });
    expect(n!.lugares[1]).toMatchObject({ coloniaMapa: "Centro", esSedeInstitucional: true });
    expect((await request(app).get("/api/pulso/mapa/colonias")).body.colonias).toEqual([]);
    expect((await request(app).get("/api/pulso/mapa")).body.features).toHaveLength(2);
    await Database.Pulso.Colonias().deleteMany({});
  });
});

/* ----------------------------------------------------------------- coverage online */

describe("pulso v2: cobertura en internet", () => {
  const original = Cobertura.deps.urlFinal;
  // No network: where each link "ends"
  const destinos: Record<string, string | null> = {
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA": "https://www.proyectopuente.com.mx/choque-navarrete?utm_source=x",
    "https://elsoldehermosillo.com.mx/choque": "https://elsoldehermosillo.com.mx/choque",
    "https://inventada.mx/no-existe": null,
    "https://www.proyectopuente.com.mx/choque-navarrete": "https://www.proyectopuente.com.mx/choque-navarrete",
  };
  beforeEach(() => {
    Cobertura.deps.urlFinal = async (u) => (u in destinos ? destinos[u] : u);
  });
  afterAll(() => {
    Cobertura.deps.urlFinal = original;
  });

  const resultados = () => ({
    notas: [
      { medio: "Proyecto Puente", titulo: "Choque en Navarrete", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA", fecha: "2026-10-16" },
      { medio: "El Sol de Hermosillo", titulo: "Choque", url: "https://elsoldehermosillo.com.mx/choque", fecha: "2026-10-17" },
      { medio: "Inventada", titulo: "No existe", url: "https://inventada.mx/no-existe", fecha: "2026-10-16" },
      { medio: "Proyecto Puente", titulo: "Repetida", url: "https://www.proyectopuente.com.mx/choque-navarrete", fecha: "2026-10-16" },
      { medio: "Otro", titulo: "Otro choque, otro mes", url: "https://otro.mx/choque-septiembre", fecha: "2026-09-02" },
      { medio: "Telemax", titulo: "La nuestra", url: "https://www.youtube.com/watch?v=abc123", fecha: "2026-10-16" },
    ],
  });

  it("relevant events are searched once; links are followed, checked and deduplicated; the search is billed", async () => {
    await captura({ clave: "youtube:abc123", publicadoEn: new Date("2026-10-16T12:30:00Z") });
    await captura({ clave: "youtube:expreso", fuente: "expreso", url: "https://www.youtube.com/watch?v=xyz789", publicadoEn: new Date("2026-10-16T18:00:00Z") });
    const p = proveedorFalso([() => choque()], undefined, { relacion: todasComo("mismo_evento"), cobertura: resultados });
    const t = await procesar(p, 10, { buscarWeb: true });
    expect(t!.motivo).toContain("internet: 1 buscados, 2 ligas");
    expect(t!.buscarWeb).toBe(true);

    const busqueda = p.llamadasEventos.find((x) => x.buscar);
    expect(JSON.parse(busqueda.texto)).toMatchObject({ titulo: "Evento", ciudad: "Hermosillo, Sonora, México" });
    const e = await Database.Pulso.Eventos().findOne({});
    expect(e!.coberturaWeb!.notas).toEqual([
      { medio: "Proyecto Puente", titulo: "Choque en Navarrete", url: "https://www.proyectopuente.com.mx/choque-navarrete", dominio: "proyectopuente.com.mx", fecha: "2026-10-16" },
      { medio: "El Sol de Hermosillo", titulo: "Choque", url: "https://elsoldehermosillo.com.mx/choque", dominio: "elsoldehermosillo.com.mx", fecha: "2026-10-17" },
    ]);
    expect((await Database.Pulso.Consumo().findOne({}))!.busquedas).toBe(1);

    // Public API: the other outlet's note with its link, and the coverage online
    const res = await request(app).get("/api/pulso/notas");
    const telemax = res.body.notas.find((n: any) => n.clave === "youtube:abc123");
    expect(telemax.eventoInfo.cobertura).toEqual([expect.objectContaining({ fuente: "expreso", nombre: "Expreso", inicio: 0 })]);
    expect(telemax.eventoInfo.coberturaWeb).toHaveLength(2);

    // Another job doesn't search it again
    await captura({ clave: "youtube:tercera", publicadoEn: new Date("2026-10-17T15:00:00Z"), estado: "transcrita" });
    const p2 = proveedorFalso([() => choque()], undefined, { relacion: todasComo("mismo_evento"), cobertura: resultados });
    await procesar(p2, 10, { buscarWeb: true });
    expect(p2.llamadasEventos.filter((x) => x.buscar)).toHaveLength(0);
  });

  it("minor events aren't searched, and a job can skip the search", async () => {
    await captura({ clave: "youtube:menor" });
    const poco = choque({ clasificacion: { tipo: "hecho", ambito: "local", tema_subtema: "movilidad/accidentes_viales", etiquetas: [], es_alerta: false, relevancia: 0.2 } });
    const p = proveedorFalso([() => poco], undefined, { cobertura: resultados });
    await procesar(p, 10, { buscarWeb: true });
    expect(p.llamadasEventos.filter((x) => x.buscar)).toHaveLength(0);

    await limpiarPulso();
    await captura({ clave: "youtube:sin" });
    const p2 = proveedorFalso([() => choque()], undefined, { cobertura: resultados });
    const t = await procesar(p2); // buscarWeb: false
    expect(p2.llamadasEventos.filter((x) => x.buscar)).toHaveLength(0);
    expect(t!.motivo).not.toContain("internet");
  });

  it("the preview tells the searches' estimated cost", async () => {
    await captura({ clave: "youtube:a" });
    const r = await Trabajos.pendientes({});
    expect(r.resumen.busquedas.busquedas).toBe(1);
    expect(r.resumen.busquedas.usd).toBeGreaterThan(0.014);
  });
});
