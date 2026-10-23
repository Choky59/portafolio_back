/**
 * Analysis jobs: nothing is analyzed unless the admin asks for it (the LLM costs money).
 *
 * - pendientes(): what a date range / outlets would analyze and its estimated cost.
 *   Already analyzed captures and the ones in another active job are left out, so
 *   nothing is analyzed (paid) twice.
 * - crear(): fixes that list in a job with a budget (USD) and queues it.
 * - ejecutar(): runs queued jobs one at a time inside the web process. Before each
 *   capture it checks: cancelled?, budget spent?, daily cap? A job interrupted by a
 *   restart is resumed on boot (each capture's progress is already saved). When every
 *   capture is done, the job's events are reconciled and consolidated (eventos.service).
 * - previewBorrado() / borrar(): removes analyses for good so a range can be analyzed
 *   again with the current prompt (transcripts and the spend log are kept).
 */
import { Filter, ObjectId } from "mongodb";
import { Database } from "../../../middlewares/database/mongodb";
import { ICaptura } from "../../../@types/collections/pulso/captura";
import { EstadoTrabajo, ITrabajo } from "../../../@types/collections/pulso/trabajo";
import { ESTADOS_CAPTURA, PULSO_MAX_INTENTOS, SEGMENTAR_DESDE_PALABRAS, SEGMENTAR_DESDE_SEG } from "../../../constants/pulso";
import * as Analisis from "./analisis.service";
import * as Consumo from "./consumo";
import * as Eventos from "./eventos.service";
import * as Cobertura from "./cobertura.service";
import { limpiarCache } from "../pulso.service";
import { ErrorProveedor, IProveedor, proveedorDelEntorno } from "./proveedor";
import os from "os";

export const POR = `backend@${os.hostname()}`;
const ACTIVOS: EstadoTrabajo[] = ["en_cola", "corriendo"];
const LISTOS = [ESTADOS_CAPTURA.TRANSCRITA, ESTADOS_CAPTURA.SEGMENTADA];

/* ------------------------------------------------------------------ cost estimate */

/**
 * Calibrated on a real run (Reporte 100, 3 h, 20.5k words: ~170k tokens in, ~60k out,
 * 23 notes): ~1.4 tokens per word, ~3.5k fixed tokens per call (instructions,
 * glossary and schema), ~1 note per 900 words, ~1.8k tokens out per call.
 *
 * v2 adds per note: ~600 tokens out for the emotions' explanations and the detail, and
 * the events: ~70% of notes have candidates (one call, ~3.7k in / 600 out), ~15% end up
 * consolidating an event (2k / 800) and ~30% are reconciled (1.5k / 300).
 */
const EVENTOS_POR_NOTA = { entrada: 0.7 * 3700 + 0.15 * 2000 + 0.3 * 1500, salida: 0.7 * 600 + 0.15 * 800 + 0.3 * 300 };

export function estimar(c: Pick<ICaptura, "texto" | "duracionSeg">) {
  const palabras = (c.texto ?? "").split(/\s+/).filter(Boolean).length;
  const larga = (c.duracionSeg ?? 0) > SEGMENTAR_DESDE_SEG || palabras > SEGMENTAR_DESDE_PALABRAS;
  const notas = larga ? Math.max(1, Math.round(palabras / 900)) : 1;
  const llamadas = notas + (larga ? 1 : 0);
  const entrada = Math.round(palabras * 1.4 * (larga ? 2 : 1) + llamadas * 3500 + notas * EVENTOS_POR_NOTA.entrada);
  const salida = Math.round(llamadas * 1800 + notas * (600 + EVENTOS_POR_NOTA.salida));
  return { palabras, notas, entrada, salida, usd: Consumo.costo({ entrada, salida }) };
}

/* ------------------------------------------------------------------ what a range would analyze */

export interface IRango {
  /** yyyy-mm-dd, Hermosillo */
  desde?: string | null;
  hasta?: string | null;
  fuentes?: string[];
}

const inicioDia = (d: string) => new Date(`${d}T00:00:00-07:00`);
const finDia = (d: string) => new Date(`${d}T23:59:59.999-07:00`);

function filtroRango(r: IRango): Filter<ICaptura> {
  const f: Filter<ICaptura> = {};
  if (r.desde || r.hasta) {
    const fecha = { ...(r.desde ? { $gte: inicioDia(r.desde) } : {}), ...(r.hasta ? { $lte: finDia(r.hasta) } : {}) };
    // Captures without a publication date count by when they were found
    f.$or = [{ publicadoEn: fecha }, { publicadoEn: null, creadoEn: fecha }] as any;
  }
  if (r.fuentes?.length) f.fuente = { $in: r.fuentes };
  return f;
}

async function enTrabajosActivos(): Promise<ObjectId[]> {
  const activos = await Database.Pulso.Trabajos().find({ estado: { $in: ACTIVOS } }, { projection: { capturas: 1 } }).toArray();
  return activos.flatMap((t) => t.capturas);
}

export async function pendientes(r: IRango) {
  const base = filtroRango(r);
  const ocupadas = await enTrabajosActivos();
  const [lista, porEstado] = await Promise.all([
    Database.Pulso.Capturas()
      .find(
        { ...base, estado: { $in: LISTOS }, intentos: { $lt: PULSO_MAX_INTENTOS }, ...(ocupadas.length ? { _id: { $nin: ocupadas } } : {}) },
        { projection: { titulo: 1, fuente: 1, publicadoEn: 1, duracionSeg: 1, estado: 1, texto: 1, clave: 1 } }
      )
      .sort({ publicadoEn: -1 })
      .limit(2000)
      .toArray(),
    Database.Pulso.Capturas().aggregate<{ _id: string; n: number }>([{ $match: base }, { $group: { _id: "$estado", n: { $sum: 1 } } }]).toArray(),
  ]);
  const fuentes = await Database.Pulso.Fuentes().find({}, { projection: { slug: 1, nombre: 1 } }).sort({ nombre: 1 }).toArray();
  const nombre = Object.fromEntries(fuentes.map((f) => [f.slug, f.nombre]));
  const capturas = lista.map((c) => {
    const e = estimar(c);
    return {
      _id: c._id,
      clave: c.clave,
      titulo: c.titulo ?? null,
      fuente: c.fuente,
      nombreFuente: nombre[c.fuente] ?? c.fuente,
      publicadoEn: c.publicadoEn ?? null,
      duracionSeg: c.duracionSeg ?? null,
      estado: c.estado,
      palabras: e.palabras,
      notasEstimadas: e.notas,
      usdEstimado: Math.round(e.usd * 1000) / 1000,
    };
  });
  const estados = Object.fromEntries(porEstado.map((e) => [e._id, e.n]));
  return {
    capturas,
    /** Every source of the scraper, for the outlets filter */
    fuentes: fuentes.map((f) => ({ slug: f.slug, nombre: f.nombre })),
    resumen: {
      pendientes: capturas.length,
      enOtroTrabajo: ocupadas.length,
      yaAnalizadas: (estados[ESTADOS_CAPTURA.ANALIZADA] ?? 0) + (estados[ESTADOS_CAPTURA.INDEXADA] ?? 0),
      sinTranscripcion: (estados[ESTADOS_CAPTURA.DESCUBIERTA] ?? 0) + (estados[ESTADOS_CAPTURA.DESCARGADA] ?? 0),
      conError: estados[ESTADOS_CAPTURA.ERROR] ?? 0,
      notasEstimadas: capturas.reduce((s, c) => s + c.notasEstimadas, 0),
      usdEstimado: Math.round(capturas.reduce((s, c) => s + c.usdEstimado, 0) * 100) / 100,
      // Optional internet search for each relevant event's coverage (the admin picks whether)
      busquedas: estimarBusquedas(capturas.reduce((s, c) => s + c.notasEstimadas, 0)),
      presupuestoMax: Consumo.presupuestoMaximo(),
    },
  };
}

/* ------------------------------------------------------------------ jobs */

/** Searches a job would make (one per relevant event, capped) and their cost: a search plus a short answer */
export function estimarBusquedas(notas: number) {
  const busquedas = Math.min(Cobertura.busquedasPorTrabajo(), Math.ceil(notas * 0.5));
  return { busquedas, usd: busquedas * Consumo.costo({ entrada: 600, salida: 1500, busquedas: 1 }) };
}

export async function crear(r: IRango & { ids?: string[]; presupuestoUSD: number; buscarWeb?: boolean }, por: string): Promise<ITrabajo | null> {
  const { capturas } = await pendientes(r);
  const elegidas = r.ids?.length ? capturas.filter((c) => r.ids!.includes(String(c._id))) : capturas;
  if (!elegidas.length) return null;
  const trabajo: ITrabajo = {
    creadoEn: new Date(),
    creadoPor: por,
    filtros: { desde: r.desde ?? null, hasta: r.hasta ?? null, fuentes: r.fuentes ?? [] },
    capturas: elegidas.map((c) => c._id as ObjectId),
    presupuestoUSD: r.presupuestoUSD,
    estimadoUSD:
      Math.round(
        (elegidas.reduce((s, c) => s + c.usdEstimado, 0) + (r.buscarWeb !== false ? estimarBusquedas(elegidas.reduce((s, c) => s + c.notasEstimadas, 0)).usd : 0)) * 100
      ) / 100,
    buscarWeb: r.buscarWeb !== false,
    estado: "en_cola",
    cancelar: false,
    progreso: { hechas: 0, notas: 0, errores: 0, entrada: 0, salida: 0, costoUSD: 0 },
    motivo: null,
    ultimoError: null,
    iniciadoEn: null,
    terminadoEn: null,
  };
  const { insertedId } = await Database.Pulso.Trabajos().insertOne(trabajo);
  return { ...trabajo, _id: insertedId };
}

export async function cancelar(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const _id = new ObjectId(id);
  const r = await Database.Pulso.Trabajos().updateOne({ _id, estado: { $in: ACTIVOS } }, { $set: { cancelar: true } });
  // A queued job that hasn't started stops right away
  await Database.Pulso.Trabajos().updateOne({ _id, estado: "en_cola" }, { $set: { estado: "cancelado", motivo: "cancelado", terminadoEn: new Date() } });
  return r.matchedCount > 0;
}

/** Recent jobs (without the capture list) and today's / this month's spend */
export async function listar() {
  const trabajos = await Database.Pulso.Trabajos().find({}, { projection: { capturas: 0 } }).sort({ creadoEn: -1 }).limit(20).toArray();
  const conteos = await Database.Pulso.Trabajos()
    .aggregate<{ _id: ObjectId; n: number }>([{ $sort: { creadoEn: -1 } }, { $limit: 20 }, { $project: { n: { $size: "$capturas" } } }])
    .toArray();
  const total = Object.fromEntries(conteos.map((c) => [String(c._id), c.n]));
  const hoy = Consumo.hoy();
  const consumo = await Database.Pulso.Consumo().find({ fecha: { $gte: `${hoy.slice(0, 7)}-01` } }).toArray();
  const suma = (filas: typeof consumo) => Math.round(filas.reduce((s, f) => s + f.costoUSD, 0) * 1000) / 1000;
  return {
    trabajos: trabajos.map((t) => ({ ...t, totalCapturas: total[String(t._id)] ?? 0 })),
    consumo: { hoyUSD: suma(consumo.filter((f) => f.fecha === hoy)), mesUSD: suma(consumo), tokensHoy: await Consumo.tokensHoy(), topeDiario: Consumo.topeDiario() },
  };
}

/* ------------------------------------------------------------------ runner */

let corriendo: Promise<void> | null = null;

async function terminar(_id: ObjectId, estado: EstadoTrabajo, motivo: string, ultimoError: string | null = null) {
  await Database.Pulso.Trabajos().updateOne({ _id }, { $set: { estado, motivo, terminadoEn: new Date(), ...(ultimoError ? { ultimoError } : {}) } });
}

class SinPresupuesto extends Error {}

/** Wraps the provider so every call also adds to the job's progress (even if the capture fails later) */
function contando(proveedor: IProveedor, _id: ObjectId): IProveedor {
  return {
    modelo: proveedor.modelo,
    async generar(params) {
      const r = await proveedor.generar(params);
      await Database.Pulso.Trabajos().updateOne(
        { _id },
        { $inc: { "progreso.entrada": r.uso.entrada, "progreso.salida": r.uso.salida, "progreso.costoUSD": Consumo.costo(r.uso) } }
      );
      return r;
    },
  };
}

async function correr(trabajo: ITrabajo, proveedor: IProveedor) {
  const _id = trabajo._id as ObjectId;
  await Database.Pulso.Trabajos().updateOne({ _id }, { $set: { estado: "corriendo", iniciadoEn: trabajo.iniciadoEn ?? new Date() } });
  const p = contando(proveedor, _id);
  const fallidas: ObjectId[] = [];
  for (;;) {
    const actual = await Database.Pulso.Trabajos().findOne({ _id });
    if (!actual || actual.cancelar) return terminar(_id, "cancelado", "cancelado por el admin");
    if (actual.progreso.costoUSD >= actual.presupuestoUSD) return terminar(_id, "detenido", "presupuesto alcanzado");
    if ((await Consumo.tokensHoy()) >= Consumo.topeDelTrabajo(actual.presupuestoUSD)) return terminar(_id, "detenido", "tope diario de tokens");

    const captura = await Analisis.tomar(POR, actual.capturas, fallidas);
    if (!captura) return cerrarEventos(actual, p);
    try {
      const r = await Analisis.analizar(captura, p);
      await Database.Pulso.Trabajos().updateOne({ _id }, { $inc: { "progreso.hechas": 1, "progreso.notas": r.notas } });
    } catch (err: any) {
      const mensaje = `${captura.clave}: ${err?.message ?? err}`;
      if (err instanceof ErrorProveedor && err.ajeno) return terminar(_id, "detenido", "el proveedor no respondió (saldo, llave o servicio)", mensaje);
      fallidas.push(captura._id as ObjectId);
      await Database.Pulso.Trabajos().updateOne({ _id }, { $inc: { "progreso.errores": 1 }, $set: { ultimoError: mensaje } });
    }
  }
}

/**
 * After the last capture: merges events of this job that turned out to be the same, then
 * writes the summary of every event with 2+ notes. Every call checks the budget first;
 * whatever is left pending is picked up by the next job.
 */
async function cerrarEventos(trabajo: ITrabajo, proveedor: IProveedor) {
  const _id = trabajo._id as ObjectId;
  const usar: Eventos.Usar = async (params) => {
    const t = await Database.Pulso.Trabajos().findOne({ _id }, { projection: { progreso: 1, presupuestoUSD: 1 } });
    if (!t || t.progreso.costoUSD >= t.presupuestoUSD) throw new SinPresupuesto();
    const r = await proveedor.generar(params);
    await Consumo.registrar(proveedor.modelo, r.uso);
    return r.datos;
  };
  try {
    const fusiones = await Eventos.reconciliar(trabajo.iniciadoEn ?? trabajo.creadoEn, usar);
    const consolidados = await Eventos.consolidar(usar);
    const web = trabajo.buscarWeb === false ? null : await Cobertura.buscarCobertura(trabajo.iniciadoEn ?? trabajo.creadoEn, usar);
    limpiarCache();
    return terminar(
      _id,
      "terminado",
      `sin capturas pendientes; eventos: ${fusiones} fusionados, ${consolidados} consolidados${web ? `; internet: ${web.eventos} buscados, ${web.ligas} ligas` : ""}`
    );
  } catch (err: any) {
    limpiarCache();
    if (err instanceof SinPresupuesto) return terminar(_id, "detenido", "presupuesto alcanzado (faltó consolidar eventos)");
    const mensaje = `eventos: ${err?.message ?? err}`;
    if (err instanceof ErrorProveedor && err.ajeno) return terminar(_id, "detenido", "el proveedor no respondió (saldo, llave o servicio)", mensaje);
    return terminar(_id, "terminado", "sin capturas pendientes; falló la fase de eventos", mensaje);
  }
}

/* ------------------------------------------------------------------ deleting analyses */

const ANALIZADAS = [ESTADOS_CAPTURA.SEGMENTADA, ESTADOS_CAPTURA.ANALIZADA, ESTADOS_CAPTURA.INDEXADA];
const esTodo = (r: IRango) => !r.desde && !r.hasta && !r.fuentes?.length;

/** Captures whose analysis would be removed: analyzed, or failed in the analysis (they have a transcript) */
function filtroBorrado(r: IRango): Filter<ICaptura> {
  return {
    ...filtroRango(r),
    $and: [{ $or: [{ estado: { $in: ANALIZADAS } }, { estado: ESTADOS_CAPTURA.ERROR, $or: [{ texto: { $type: "string" } }, { segmentos: { $type: "array" } }] }] }],
  } as any;
}

async function alcanceBorrado(r: IRango) {
  const capturas = await Database.Pulso.Capturas().find(filtroBorrado(r), { projection: { _id: 1 } }).toArray();
  const ids = capturas.map((c) => c._id as ObjectId);
  // "Todo" also takes notes whose capture is gone or was re-transcribed
  const filtroNotas = esTodo(r) ? {} : { capturaId: { $in: ids } };
  const notas = await Database.Pulso.Notas().find(filtroNotas, { projection: { _id: 1, "evento.eventoId": 1, "clasificacion.etiquetas": 1 } }).toArray();
  return { capturas: ids, filtroNotas, notas };
}

const idsDeEventos = (notas: { evento?: { eventoId: ObjectId } | null }[]) =>
  [...new Set(notas.map((n) => n.evento?.eventoId).filter(Boolean).map(String))].map((x) => new ObjectId(x));

export async function hayTrabajoActivo(): Promise<boolean> {
  return (await Database.Pulso.Trabajos().countDocuments({ estado: { $in: ACTIVOS } })) > 0;
}

/** How much a deletion would remove (nothing is touched) */
export async function previewBorrado(r: IRango) {
  const { capturas, notas } = await alcanceBorrado(r);
  const eventos = idsDeEventos(notas);
  const borrar = new Set(notas.map((n) => String(n._id)));
  const afectados = eventos.length ? await Database.Pulso.Eventos().find({ _id: { $in: eventos } }, { projection: { notas: 1 } }).toArray() : [];
  const vacios = afectados.filter((e) => e.notas.every((id) => borrar.has(String(id)))).length;
  return {
    todo: esTodo(r),
    capturas: capturas.length,
    notas: notas.length,
    eventosAfectados: afectados.length,
    eventosQueSeBorran: esTodo(r) ? await Database.Pulso.Eventos().countDocuments() : vacios,
    trabajoActivo: await hayTrabajoActivo(),
  };
}

/**
 * Removes the analyses of a range for good: its notes are deleted and its captures go back
 * to "transcrita" (transcripts untouched) so a new job analyzes them again. Events left
 * without notes and relations to deleted notes are removed too. "Todo" also empties the
 * events and the AI-made actors and tags. The spend log and the jobs' history are kept.
 * Returns null (nothing done) while a job is active.
 */
export async function borrar(r: IRango, por: string) {
  if (await hayTrabajoActivo()) return null;
  const { capturas, filtroNotas, notas } = await alcanceBorrado(r);
  const ids = notas.map((n) => n._id as ObjectId);
  const eventos = idsDeEventos(notas);

  const { deletedCount } = await Database.Pulso.Notas().deleteMany(filtroNotas);
  let eventosBorrados = 0;
  if (esTodo(r)) {
    eventosBorrados = (await Database.Pulso.Eventos().deleteMany({})).deletedCount;
    await Database.Pulso.Actores().deleteMany({ creadoPor: "ia" });
    await Database.Pulso.LugaresConocidos().updateMany({}, { $set: { actorId: null } });
    await Database.Pulso.Etiquetas().deleteMany({});
  } else {
    if (ids.length) {
      await Database.Pulso.Notas().updateMany({ "relaciones.notaId": { $in: ids } }, { $pull: { relaciones: { notaId: { $in: ids } } } } as any);
      await Database.Pulso.Notas().updateMany({ seguimientoDe: { $in: ids } }, { $set: { seguimientoDe: null } });
    }
    const antes = await Database.Pulso.Eventos().countDocuments();
    for (const e of eventos) await Eventos.recalcular(e);
    eventosBorrados = antes - (await Database.Pulso.Eventos().countDocuments());
    // Tags: one use less per deleted note; unused ones go
    const usos = new Map<string, number>();
    // v1 notes kept their tags as plain text, not catalog ids: those don't count
    for (const n of notas) {
      for (const t of n.clasificacion?.etiquetas ?? []) if (t instanceof ObjectId) usos.set(String(t), (usos.get(String(t)) ?? 0) + 1);
    }
    if (usos.size) {
      await Database.Pulso.Etiquetas().bulkWrite([...usos].map(([id, n]) => ({ updateOne: { filter: { _id: new ObjectId(id) }, update: { $inc: { usos: -n } } } })));
      await Database.Pulso.Etiquetas().deleteMany({ usos: { $lte: 0 } });
    }
  }

  const ahora = new Date();
  if (capturas.length) {
    await Database.Pulso.Capturas().updateMany(
      { _id: { $in: capturas } },
      {
        $set: { estado: ESTADOS_CAPTURA.TRANSCRITA, intentos: 0, errores: 0, error: null, reserva: null, esperaHasta: null, actualizadoEn: ahora },
        $unset: { bloques: "", bloquesEsperados: "", bloquesProcesados: "" },
        $push: { historial: { estado: ESTADOS_CAPTURA.TRANSCRITA, en: ahora, detalle: `análisis borrado por ${por}` } },
      } as any
    );
  }
  limpiarCache();
  return { capturas: capturas.length, notas: deletedCount, eventos: eventosBorrados };
}

/**
 * Runs queued jobs, oldest first, one at a time. Calling it while it runs just returns
 * the same run (so "start" can be called after every new job).
 */
export function ejecutar(proveedor: IProveedor | null = proveedorDelEntorno()): Promise<void> {
  if (corriendo) return corriendo;
  if (!proveedor) return Promise.resolve();
  corriendo = (async () => {
    try {
      for (;;) {
        const t = await Database.Pulso.Trabajos().findOne({ estado: { $in: ACTIVOS } }, { sort: { creadoEn: 1 } });
        if (!t) break;
        await correr(t, proveedor).catch((err) => terminar(t._id as ObjectId, "detenido", "error inesperado", String(err?.message ?? err)));
      }
    } finally {
      corriendo = null;
    }
  })();
  return corriendo;
}
