/**
 * Public, read-only views of the analyzed news (pulsoNotas) for the project page:
 * an overview, the list with filters, one note, the outlets and the people/institutions.
 *
 * Minors are never shown by name: their actor entries and quotes are replaced here,
 * in one place, before anything leaves the backend.
 */
import { Filter, ObjectId } from "mongodb";
import { Database } from "../../middlewares/database/mongodb";
import { INota } from "../../@types/collections/pulso/nota";
import { EMOCIONES, ESTADOS_CAPTURA } from "../../constants/pulso";
import { ZONA_HORARIA } from "../../constants/sePuedeSalir";

export const MENOR = "Menor de edad";
const CACHE_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ privacy */

/** A note as it can be shown publicly: no minors' names, no raw model answer */
export function publica(n: INota) {
  const menores = new Set(n.actores.filter((a) => a.esMenor).map((a) => a.nombre.toLowerCase()));
  const esMenor = (nombre: string | null) => !!nombre && menores.has(nombre.toLowerCase());
  const { analisis, ...resto } = n;
  return {
    ...resto,
    actores: n.actores.map((a) => (a.esMenor ? { ...a, nombre: MENOR, cargo: null } : a)),
    citas: n.citas.map((c) => ({
      ...c,
      quien: esMenor(c.quien) ? MENOR : c.quien,
      atribuidaA: esMenor(c.atribuidaA) ? MENOR : c.atribuidaA,
    })),
    analisis: { version: analisis.version, modelo: analisis.modelo, promptVersion: analisis.promptVersion ?? null },
  };
}

/**
 * What a note's card shows of its event: how many outlets told it, how they differ, the
 * other notes we have of it (each outlet's link, at its minute) and the coverage found online
 */
async function conEventos<T extends { _id?: ObjectId; evento?: INota["evento"] }>(notas: T[]) {
  const ids = [...new Set(notas.map((n) => n.evento?.eventoId).filter(Boolean).map(String))].map((x) => new ObjectId(x));
  const eventos = ids.length
    ? await Database.Pulso.Eventos()
        .find({ _id: { $in: ids } }, { projection: { titulo: 1, numMedios: 1, fuentes: 1, notas: 1, discrepancias: 1, detalleConsolidado: 1, coberturaWeb: 1 } })
        .toArray()
    : [];
  const deEventos = eventos.flatMap((e) => e.notas);
  const [hermanas, nombres] = await Promise.all([
    deEventos.length
      ? Database.Pulso.Notas()
          .find({ _id: { $in: deEventos } }, { projection: { titulo: 1, fuente: 1, enlace: 1, publicadoEn: 1, tiempo: 1, "evento.eventoId": 1 } })
          .sort({ publicadoEn: 1 })
          .toArray()
      : Promise.resolve([]),
    nombresDeFuentes(),
  ]);
  const de = new Map(eventos.map((e) => [String(e._id), e]));
  return notas.map((n) => {
    const e = n.evento ? de.get(String(n.evento.eventoId)) : undefined;
    return {
      ...n,
      eventoInfo: e
        ? {
            id: String(e._id),
            titulo: e.titulo,
            numMedios: e.numMedios,
            fuentes: e.fuentes,
            notas: e.notas.length,
            discrepancias: e.discrepancias,
            resumen: e.detalleConsolidado?.resumen ?? null,
            cobertura: hermanas
              .filter((h) => String(h.evento?.eventoId) === String(e._id) && String(h._id) !== String(n._id))
              .map((h) => ({ id: String(h._id), fuente: h.fuente, nombre: nombres[h.fuente]?.nombre ?? h.fuente, titulo: h.titulo, enlace: h.enlace, publicadoEn: h.publicadoEn, inicio: h.tiempo?.inicio ?? null })),
            coberturaWeb: e.coberturaWeb?.notas ?? [],
          }
        : null,
    };
  });
}

/* ------------------------------------------------------------------ filters */

export interface IFiltros {
  tema?: string;
  subtema?: string;
  emocion?: string;
  fuente?: string;
  ambito?: string;
  tipo?: string;
  actor?: string;
  q?: string;
  desde?: Date;
  hasta?: Date;
}

const escapar = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function filtro(f: IFiltros): Filter<INota> {
  const m: Filter<INota> = {};
  if (f.tema) m["clasificacion.tema"] = f.tema;
  if (f.subtema) m["clasificacion.subtema"] = f.subtema;
  if (f.emocion) m["sentimiento.emocionDominante"] = f.emocion as any;
  if (f.fuente) m.fuente = f.fuente;
  if (f.ambito) m["clasificacion.ambito"] = f.ambito;
  if (f.tipo) m["clasificacion.tipo"] = f.tipo;
  // A person by name, never a minor
  if (f.actor) m.actores = { $elemMatch: { nombre: { $regex: `^${escapar(f.actor)}$`, $options: "i" }, esMenor: false } } as any;
  if (f.q) {
    const r = { $regex: escapar(f.q), $options: "i" };
    m.$or = [{ titulo: r }, { resumen: r }, { "clasificacion.etiquetasLibres": r }] as any;
  }
  if (f.desde || f.hasta) m.publicadoEn = { ...(f.desde ? { $gte: f.desde } : {}), ...(f.hasta ? { $lte: f.hasta } : {}) };
  return m;
}

/* ------------------------------------------------------------------ list / one */

export async function listarNotas(f: IFiltros, pagina: number, porPagina: number) {
  const m = filtro(f);
  const [total, notas] = await Promise.all([
    Database.Pulso.Notas().countDocuments(m),
    Database.Pulso.Notas()
      .find(m, { projection: { "analisis.crudo": 0 } })
      .sort({ publicadoEn: -1, capturaId: 1, bloque: 1 })
      .skip((pagina - 1) * porPagina)
      .limit(porPagina)
      .toArray(),
  ]);
  return { total, pagina, porPagina, notas: await conEventos(notas.map(publica)) };
}

export async function obtenerNota(id: string) {
  if (!ObjectId.isValid(id)) return null;
  const n = await Database.Pulso.Notas().findOne({ _id: new ObjectId(id) }, { projection: { "analisis.crudo": 0 } });
  return n ? (await conEventos([publica(n)]))[0] : null;
}

/* ------------------------------------------------------------------ aggregates */

const promedioEmociones = Object.fromEntries(EMOCIONES.map((e) => [e, { $avg: `$sentimiento.emociones.${e}.valor` }]));
const conteoEmociones = { $push: "$sentimiento.emocionDominante" };
const contar = (lista: string[]) => lista.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
const r2 = (n: number | null) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const redondearEmociones = (e: Record<string, number>) => Object.fromEntries(EMOCIONES.map((k) => [k, r2(e[k] ?? 0)]));

/** Small cache: the overview changes only when new notes are analyzed */
const cache = new Map<string, { en: number; datos: Promise<unknown> }>();
function cacheado<T>(clave: string, calcular: () => Promise<T>): Promise<T> {
  const g = cache.get(clave);
  if (g && Date.now() - g.en < CACHE_MS) return g.datos as Promise<T>;
  const datos = calcular();
  cache.set(clave, { en: Date.now(), datos });
  datos.catch(() => cache.delete(clave));
  return datos;
}
export const limpiarCache = () => cache.clear();

async function nombresDeFuentes(): Promise<Record<string, { nombre: string; medio: string }>> {
  const fuentes = await Database.Pulso.Fuentes().find({}, { projection: { slug: 1, nombre: 1, medio: 1 } }).toArray();
  return Object.fromEntries(fuentes.map((f) => [f.slug, { nombre: f.nombre, medio: f.medio }]));
}

/** Totals, topics, emotions, outlets and notes per day */
export function resumen() {
  return cacheado("resumen", async () => {
    const [r] = await Database.Pulso.Notas().aggregate<any>([
      {
        $facet: {
          total: [{ $group: { _id: null, notas: { $sum: 1 }, desde: { $min: "$publicadoEn" }, hasta: { $max: "$publicadoEn" }, alertas: { $sum: { $cond: ["$clasificacion.esAlerta", 1, 0] } }, eventos: { $addToSet: "$evento.eventoId" }, intensidad: { $avg: "$sentimiento.intensidad" } } }],
          temas: [
            { $group: { _id: "$clasificacion.tema", n: { $sum: 1 }, emociones: conteoEmociones, subtemas: { $push: "$clasificacion.subtema" }, eventos: { $addToSet: "$evento.eventoId" } } },
            { $sort: { n: -1 } },
          ],
          emociones: [{ $group: { _id: null, ...promedioEmociones, dominantes: conteoEmociones } }],
          ambitos: [{ $group: { _id: "$clasificacion.ambito", n: { $sum: 1 } } }],
          tipos: [{ $group: { _id: "$clasificacion.tipo", n: { $sum: 1 } } }],
          tonos: [{ $group: { _id: "$sentimiento.tonoMedio", n: { $sum: 1 } } }],
          dias: [
            { $match: { publicadoEn: { $ne: null } } },
            { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$publicadoEn", timezone: ZONA_HORARIA } }, n: { $sum: 1 }, emociones: conteoEmociones } },
            { $sort: { _id: 1 } },
          ],
          etiquetas: [{ $unwind: "$clasificacion.etiquetasLibres" }, { $group: { _id: "$clasificacion.etiquetasLibres", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }],
        },
      },
    ]).toArray();

    const [horas] = await Database.Pulso.Capturas()
      .aggregate<{ seg: number; capturas: number }>([
        { $match: { estado: { $in: [ESTADOS_CAPTURA.ANALIZADA, ESTADOS_CAPTURA.INDEXADA] } } },
        { $group: { _id: null, seg: { $sum: { $ifNull: ["$duracionSeg", 0] } }, capturas: { $sum: 1 } } },
      ])
      .toArray();
    const t = r.total[0];
    const e = r.emociones[0];
    return {
      totales: {
        notas: t?.notas ?? 0,
        capturas: horas?.capturas ?? 0,
        horasAnalizadas: Math.round(((horas?.seg ?? 0) / 3600) * 10) / 10,
        alertas: t?.alertas ?? 0,
        // The same happening told by several outlets counts once
        eventos: (t?.eventos ?? []).filter(Boolean).length,
        multimedio: await Database.Pulso.Eventos().countDocuments({ numMedios: { $gte: 2 } }),
        intensidad: r2(t?.intensidad ?? null),
        desde: t?.desde ?? null,
        hasta: t?.hasta ?? null,
      },
      emociones: e ? { promedio: redondearEmociones(e), dominantes: contar(e.dominantes) } : null,
      temas: r.temas.map((x: any) => ({ tema: x._id, notas: x.n, eventos: x.eventos.filter(Boolean).length, emociones: contar(x.emociones), subtemas: contar(x.subtemas) })),
      ambitos: Object.fromEntries(r.ambitos.map((x: any) => [x._id, x.n])),
      tipos: Object.fromEntries(r.tipos.map((x: any) => [x._id, x.n])),
      tonos: Object.fromEntries(r.tonos.map((x: any) => [x._id, x.n])),
      dias: r.dias.map((x: any) => ({ fecha: x._id, notas: x.n, emociones: contar(x.emociones) })),
      etiquetas: r.etiquetas.map((x: any) => ({ etiqueta: x._id, notas: x.n })),
    };
  });
}

/** Per outlet: how much, about what, how it feels, and its tone toward each level of government */
export function medios() {
  return cacheado("medios", async () => {
    const filas = await Database.Pulso.Notas().aggregate<any>([
      {
        $group: {
          _id: "$fuente",
          notas: { $sum: 1 },
          temas: { $push: "$clasificacion.tema" },
          emociones: conteoEmociones,
          tonos: { $push: "$sentimiento.tonoMedio" },
          municipal: { $avg: "$sentimiento.posturaGobierno.municipal" },
          estatal: { $avg: "$sentimiento.posturaGobierno.estatal" },
          federal: { $avg: "$sentimiento.posturaGobierno.federal" },
          conMunicipal: { $sum: { $cond: [{ $ne: ["$sentimiento.posturaGobierno.municipal", null] }, 1, 0] } },
          conEstatal: { $sum: { $cond: [{ $ne: ["$sentimiento.posturaGobierno.estatal", null] }, 1, 0] } },
          conFederal: { $sum: { $cond: [{ $ne: ["$sentimiento.posturaGobierno.federal", null] }, 1, 0] } },
          polaridad: { $avg: "$sentimiento.polaridad" },
        },
      },
      { $sort: { notas: -1 } },
    ]).toArray();
    const nombres = await nombresDeFuentes();
    return filas.map((f) => ({
      fuente: f._id,
      nombre: nombres[f._id]?.nombre ?? f._id,
      medio: nombres[f._id]?.medio ?? null,
      notas: f.notas,
      temas: contar(f.temas),
      emociones: contar(f.emociones),
      tonos: contar(f.tonos),
      polaridad: r2(f.polaridad),
      // $avg ignores nulls: notes that don't talk about that level don't count
      postura: {
        municipal: { promedio: r2(f.municipal), notas: f.conMunicipal },
        estatal: { promedio: r2(f.estatal), notas: f.conEstatal },
        federal: { promedio: r2(f.federal), notas: f.conFederal },
      },
    }));
  });
}

/** People and institutions most mentioned (never minors), with the average tone toward them */
export function actores(limite = 30) {
  return cacheado(`actores:${limite}`, async () => {
    const filas = await Database.Pulso.Notas().aggregate<any>([
      { $unwind: "$actores" },
      { $match: { "actores.esMenor": false } },
      {
        $group: {
          _id: { $toLower: "$actores.nombre" },
          nombre: { $first: "$actores.nombre" },
          tipo: { $first: "$actores.tipo" },
          cargo: { $max: "$actores.cargo" },
          nivelGobierno: { $max: "$actores.nivelGobierno" },
          menciones: { $sum: 1 },
          tono: { $avg: "$actores.tonoHacia" },
          roles: { $push: "$actores.rol" },
          temas: { $push: "$clasificacion.tema" },
          fuentes: { $addToSet: "$fuente" },
        },
      },
      { $sort: { menciones: -1, nombre: 1 } },
      { $limit: limite },
    ]).toArray();
    return filas.map((a) => ({
      nombre: a.nombre,
      tipo: a.tipo,
      cargo: a.cargo,
      nivelGobierno: a.nivelGobierno,
      menciones: a.menciones,
      tono: r2(a.tono),
      roles: contar(a.roles),
      temas: contar(a.temas),
      medios: a.fuentes.length,
    }));
  });
}

/** Names of the sources for the filters */
export async function fuentes() {
  const conNotas = await Database.Pulso.Notas().distinct("fuente");
  const nombres = await nombresDeFuentes();
  return conNotas.map((slug) => ({ slug, nombre: nombres[slug]?.nombre ?? slug })).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

/* ------------------------------------------------------------------ map */

/** One feature per place of the event that's on the map (GeoJSON), with its note's data */
export async function mapa(f: IFiltros) {
  const filas = await Database.Pulso.Notas().aggregate<any>([
    { $match: { ...filtro(f), "lugares.geo": { $exists: true } } },
    { $unwind: "$lugares" },
    { $match: { "lugares.geo": { $exists: true }, "lugares.rol": "lugar_del_hecho" } },
    { $sort: { publicadoEn: -1 } },
    { $limit: 3000 },
    {
      $project: {
        _id: 0, notaId: "$_id", titulo: 1, resumenCorto: 1, fuente: 1, publicadoEn: 1, enlace: 1,
        tema: "$clasificacion.tema", subtema: "$clasificacion.subtema", relevancia: "$clasificacion.relevancia",
        emocion: "$sentimiento.emocionDominante", polaridad: "$sentimiento.polaridad",
        mencion: "$lugares.mencion", precision: "$lugares.precision", colonia: "$lugares.coloniaMapa", geo: "$lugares.geo",
      },
    },
  ]).toArray();
  return {
    type: "FeatureCollection",
    features: filas.map(({ geo, ...props }) => ({ type: "Feature", geometry: geo, properties: props })),
  };
}

/** Notes per colony: how many, their emotions and average polarity, at the colony's center */
export async function mapaColonias(f: IFiltros) {
  const filas = await Database.Pulso.Notas().aggregate<any>([
    { $match: { ...filtro(f), "lugares.coloniaMapa": { $type: "string" } } },
    { $unwind: "$lugares" },
    // A protest at the Congress isn't news about the Congress's colony
    { $match: { "lugares.coloniaMapa": { $type: "string" }, "lugares.rol": "lugar_del_hecho", "lugares.esSedeInstitucional": { $ne: true } } },
    // A note with two places in the same colony counts once there
    {
      $group: {
        _id: { colonia: "$lugares.coloniaMapa", nota: "$_id" },
        emocion: { $first: "$sentimiento.emocionDominante" },
        polaridad: { $first: "$sentimiento.polaridad" },
        lon: { $avg: { $arrayElemAt: ["$lugares.geo.coordinates", 0] } },
        lat: { $avg: { $arrayElemAt: ["$lugares.geo.coordinates", 1] } },
      },
    },
    {
      $group: {
        _id: "$_id.colonia", notas: { $sum: 1 }, emociones: { $push: "$emocion" }, polaridad: { $avg: "$polaridad" },
        lon: { $avg: "$lon" }, lat: { $avg: "$lat" },
      },
    },
    { $sort: { notas: -1 } },
  ]).toArray();
  // The colony's center from the catalog; colonies OSM doesn't have use the middle of their notes' places
  const centros = await Database.Pulso.Colonias().find({ nombre: { $in: filas.map((x) => x._id) } }).toArray();
  const punto = Object.fromEntries(centros.map((c) => [c.nombre, c.punto]));
  return filas
    .map((x) => ({
      colonia: x._id,
      notas: x.notas,
      emociones: contar(x.emociones),
      polaridad: r2(x.polaridad),
      punto: punto[x._id] ?? (x.lon !== null && x.lat !== null ? { type: "Point", coordinates: [x.lon, x.lat] } : null),
    }))
    .filter((x) => x.punto);
}

/* ------------------------------------------------------------------ the crowd */

/**
 * The latest analyzed notes in the shape the crowd visualization uses (emotion mix,
 * relevance, outlet kind), so it shows the real city instead of the examples.
 */
/** Latest notes in the crowd's shape; `saltar` skips the newest ones ("cargar más" brings older ones) */
export async function multitud(limite = 40, saltar = 0) {
  const notas = await Database.Pulso.Notas()
    .find({}, { projection: { "analisis.crudo": 0 } })
    .sort({ publicadoEn: -1, "clasificacion.relevancia": -1, _id: -1 })
    .skip(saltar)
    .limit(limite)
    .toArray();
  const fuentes = await Database.Pulso.Fuentes().find({}).toArray();
  const de = Object.fromEntries(fuentes.map((f) => [f.slug, f]));
  return notas.map(publica).map((n) => ({
    id: String(n._id),
    titulo: n.titulo,
    resumen: n.resumenCorto,
    fuente: { tipo: de[n.fuente]?.formato ?? "web", nombre: de[n.fuente]?.nombre ?? n.fuente },
    fecha: n.publicadoEn,
    tema: n.clasificacion.tema,
    etiquetas: n.clasificacion.etiquetasLibres,
    actores: n.actores.map((a) => ({ nombre: a.nombre, tipo: a.tipo, rol: a.rol })),
    lugares: n.lugares.filter((l) => l.rol === "lugar_del_hecho").map((l) => l.mencion),
    emociones: Object.fromEntries(EMOCIONES.map((e) => [e, n.sentimiento.emociones[e]?.valor ?? 0])),
    emocionDominante: n.sentimiento.emocionDominante,
    polaridad: n.sentimiento.polaridad,
    intensidad: n.sentimiento.intensidad,
    relevancia: n.clasificacion.relevancia,
    enlace: n.enlace,
  }));
}
