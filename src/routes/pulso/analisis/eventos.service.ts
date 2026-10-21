/**
 * The same happening told by several outlets counts once: notes are grouped into events
 * (pulsoEventos).
 *
 * A. Candidates (code, no AI): notes of another capture, close in time (±3 days around
 *    when it happened, or ±5 days around publication if that's unknown) that share
 *    something: topic, a place under 1 km, colony or an actor. At most 10, closest first.
 * B. The model decides each candidate's relation: same event, follow-up, related, unrelated.
 *    Skipped (no cost) when there are no candidates.
 * C. Same event / follow-up at ≥ 0.7 confidence: the note joins that event; otherwise a
 *    new event. Every non-"distinto" relation is kept on the note.
 * D. After each job: events with 2+ notes get their title, consolidated detail and
 *    discrepancies written once (consolidar), and events touched by the job are checked
 *    against nearby events and merged when they're the same (reconciliar).
 *
 * Jobs analyze captures in publication order and link notes one at a time, so a note's
 * earlier coverage is already there when it's linked.
 */
import { ObjectId } from "mongodb";
import { Database } from "../../../middlewares/database/mongodb";
import { IEvento, INota } from "../../../@types/collections/pulso/nota";
import {
  CERCA_EVENTO_M, CONFIANZA_EVENTO, CONFIANZA_FUSION, MAX_CANDIDATAS, RELACIONES, VENTANA_OCURRIO_DIAS, VENTANA_PUBLICADO_DIAS,
} from "../../../constants/pulso";
import { ESQUEMA_CONSOLIDAR, ESQUEMA_FUSION, ESQUEMA_RELACION, INSTRUCCIONES_CONSOLIDAR, INSTRUCCIONES_FUSION, INSTRUCCIONES_RELACION } from "./esquemas";
import { IProveedor } from "./proveedor";

/** Calls the model (and logs its cost): the analysis service passes its own */
export type Usar = (params: Parameters<IProveedor["generar"]>[0]) => Promise<any>;

const DIA = 86400000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const rango = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};

function metros(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}

const puntos = (n: Pick<INota, "lugares">) => n.lugares.filter((l) => l.geo).map((l) => l.geo!.coordinates);
const colonias = (n: Pick<INota, "lugares">) => n.lugares.map((l) => l.coloniaId).filter(Boolean).map(String);
const actores = (n: Pick<INota, "actores">) => n.actores.map((a) => a.actorId).filter(Boolean).map(String);
const conocidos = (n: Pick<INota, "lugares">) => n.lugares.map((l) => l.lugarConocidoId).filter(Boolean).map(String);
const sumarDias = (ymd: string, d: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + d * DIA).toISOString().slice(0, 10);

function distanciaMinima(a: [number, number][], b: [number, number][]): number | null {
  let min: number | null = null;
  for (const p of a) for (const q of b) {
    const d = metros(p, q);
    if (min === null || d < min) min = d;
  }
  return min;
}

/* ------------------------------------------------------------------ A. candidates */

export async function candidatas(nota: INota): Promise<INota[]> {
  const ventana: any[] = [];
  if (nota.fechas.ocurrio) {
    ventana.push({ "fechas.ocurrio": { $gte: sumarDias(nota.fechas.ocurrio, -VENTANA_OCURRIO_DIAS), $lte: sumarDias(nota.fechas.ocurrio, VENTANA_OCURRIO_DIAS) } });
  }
  if (nota.publicadoEn) {
    const t = nota.publicadoEn.getTime();
    const pub = { $gte: new Date(t - VENTANA_PUBLICADO_DIAS * DIA), $lte: new Date(t + VENTANA_PUBLICADO_DIAS * DIA) };
    // Without a date of the event (either side), publication decides
    ventana.push(nota.fechas.ocurrio ? { "fechas.ocurrio": null, publicadoEn: pub } : { publicadoEn: pub });
  }
  if (!ventana.length) return [];

  const posibles = await Database.Pulso.Notas()
    .find(
      { _id: { $ne: nota._id }, clave: { $ne: nota.clave }, clase: "nota", "evento.eventoId": { $exists: true }, $or: ventana },
      { projection: { "analisis.crudo": 0 } }
    )
    .limit(300)
    .toArray();

  const misPuntos = puntos(nota);
  const misColonias = new Set(colonias(nota));
  const misActores = new Set(actores(nota));
  const misConocidos = new Set(conocidos(nota));
  const dia = (n: INota) => Date.parse(`${n.fechas.ocurrio ?? n.publicadoEn?.toISOString().slice(0, 10) ?? "1970-01-01"}T12:00:00Z`);
  const miDia = dia(nota);

  return posibles
    .map((c) => {
      const d = distanciaMinima(misPuntos, puntos(c));
      const comparte =
        c.clasificacion.tema === nota.clasificacion.tema ||
        (d !== null && d < CERCA_EVENTO_M) ||
        colonias(c).some((x) => misColonias.has(x)) ||
        actores(c).some((x) => misActores.has(x)) ||
        conocidos(c).some((x) => misConocidos.has(x));
      return { c, comparte, d: d ?? 50000, dias: Math.abs(dia(c) - miDia) / DIA };
    })
    .filter((x) => x.comparte)
    .sort((a, b) => a.d / 1000 + a.dias - (b.d / 1000 + b.dias))
    .slice(0, MAX_CANDIDATAS)
    .map((x) => x.c);
}

/* ------------------------------------------------------------------ B. the model decides */

/** What the model sees of a note (no transcript: title, summary, when, where, figures, who, outlet) */
function ficha(n: INota, nombreFuente: string) {
  return {
    nota_id: String(n._id),
    medio: nombreFuente,
    titulo: n.titulo,
    resumen: n.resumen || n.resumenCorto,
    ocurrio: n.fechas.ocurrio ?? null,
    publicado: n.publicadoEn?.toISOString() ?? null,
    lugares: n.lugares.filter((l) => l.rol === "lugar_del_hecho").map((l) => [l.calle1, l.calle2, l.lugarReferencia, l.colonia].filter(Boolean).join(", ") || l.mencion),
    cifras: n.cifras.map((c) => `${c.valor} ${c.unidad} (${c.queMide})`),
    actores: n.actores.filter((a) => !a.esMenor).map((a) => a.nombre),
  };
}

async function nombres(): Promise<Record<string, string>> {
  const f = await Database.Pulso.Fuentes().find({}, { projection: { slug: 1, nombre: 1 } }).toArray();
  return Object.fromEntries(f.map((x) => [x.slug, x.nombre]));
}

export async function decidir(nota: INota, cand: INota[], usar: Usar) {
  const medio = await nombres();
  const r = await usar({
    sistema: INSTRUCCIONES_RELACION,
    texto: JSON.stringify({ nota_nueva: ficha(nota, medio[nota.fuente] ?? nota.fuente), candidatas: cand.map((c) => ficha(c, medio[c.fuente] ?? c.fuente)) }),
    esquema: ESQUEMA_RELACION,
  });
  const porId = new Map(cand.map((c) => [String(c._id), c]));
  return (Array.isArray(r?.relaciones) ? r.relaciones : [])
    .filter((x: any) => porId.has(String(x?.nota_id)) && (RELACIONES as readonly string[]).includes(x?.relacion))
    .map((x: any) => ({
      candidata: porId.get(String(x.nota_id))!,
      tipo: x.relacion as string,
      confianza: r2(rango(x.confianza, 0, 1)),
      justificacion: String(x.justificacion ?? "").trim(),
      discrepancias: (Array.isArray(x.discrepancias) ? x.discrepancias : []).map(String).filter(Boolean).slice(0, 10),
    }));
}

/* ------------------------------------------------------------------ C. assign the event */

/** Rebuilds an event's outlets / counts from its notes; an event left without notes is removed */
export async function recalcular(eventoId: ObjectId) {
  const notas = await Database.Pulso.Notas().find({ "evento.eventoId": eventoId }, { projection: { fuente: 1, fuenteId: 1, publicadoEn: 1 } }).toArray();
  if (!notas.length) {
    await Database.Pulso.Eventos().deleteOne({ _id: eventoId });
    return;
  }
  const fuentes = [...new Set(notas.map((n) => n.fuente))];
  const fuenteIds = [...new Map(notas.filter((n) => n.fuenteId).map((n) => [String(n.fuenteId), n.fuenteId as ObjectId])).values()];
  const fechas = notas.map((n) => n.publicadoEn).filter(Boolean) as Date[];
  await Database.Pulso.Eventos().updateOne(
    { _id: eventoId },
    {
      $set: {
        notas: notas.map((n) => n._id as ObjectId),
        fuentes,
        fuenteIds,
        numMedios: fuentes.length,
        primeraPublicacion: fechas.length ? new Date(Math.min(...fechas.map((d) => d.getTime()))) : null,
        pendienteConsolidar: notas.length >= 2,
        // A single note is its own summary
        ...(notas.length < 2 ? { detalleConsolidado: null, discrepancias: [] } : {}),
        actualizadoEn: new Date(),
      },
    }
  );
}

async function crearEvento(nota: INota): Promise<ObjectId> {
  const lugar = nota.lugares.find((l) => l.geo && l.rol === "lugar_del_hecho");
  const ahora = new Date();
  const evento: IEvento = {
    titulo: nota.titulo,
    tema: nota.clasificacion.tema,
    subtema: nota.clasificacion.subtema,
    ocurrio: nota.fechas.ocurrio ?? null,
    geo: lugar?.geo ?? null,
    coloniaId: nota.lugares.find((l) => l.coloniaId)?.coloniaId ?? null,
    notas: [],
    fuentes: [],
    fuenteIds: [],
    numMedios: 0,
    detalleConsolidado: null,
    discrepancias: [],
    primeraPublicacion: null,
    pendienteConsolidar: false,
    creadoEn: ahora,
    actualizadoEn: ahora,
  };
  if (!evento.geo) delete (evento as any).geo; // 2dsphere: no geo field rather than null
  const { insertedId } = await Database.Pulso.Eventos().insertOne(evento);
  return insertedId;
}

/** Links one note to an event (steps A–C). Only notes (not interviews or opinion) are events */
export async function vincular(nota: INota, usar: Usar): Promise<ObjectId | null> {
  if (nota.clase !== "nota" || nota.evento?.eventoId) return nota.evento?.eventoId ?? null;
  const cand = await candidatas(nota);
  const relaciones = cand.length ? await decidir(nota, cand, usar) : [];
  const mejor = relaciones
    .filter((r: any) => (r.tipo === "mismo_evento" || r.tipo === "seguimiento") && r.confianza >= CONFIANZA_EVENTO)
    .sort((a: any, b: any) => b.confianza - a.confianza)[0];

  const eventoId: ObjectId = mejor ? (mejor.candidata.evento!.eventoId as ObjectId) : await crearEvento(nota);
  await Database.Pulso.Notas().updateOne(
    { _id: nota._id },
    {
      $set: {
        evento: { eventoId, confianza: mejor ? mejor.confianza : 1, justificacion: mejor ? mejor.justificacion : "primera nota de este suceso" },
        seguimientoDe: mejor?.tipo === "seguimiento" ? (mejor.candidata._id as ObjectId) : null,
        relaciones: relaciones
          .filter((r: any) => r.tipo !== "distinto")
          .map((r: any) => ({ notaId: r.candidata._id as ObjectId, tipo: r.tipo, confianza: r.confianza, justificacion: r.justificacion, discrepancias: r.discrepancias })),
      },
    }
  );
  await recalcular(eventoId);
  return eventoId;
}

/* ------------------------------------------------------------------ D. after a job */

/** Events with 2+ notes waiting for their consolidated title / detail / discrepancies */
export async function consolidar(usar: Usar, limite = 200): Promise<number> {
  const pendientes = await Database.Pulso.Eventos().find({ pendienteConsolidar: true }).limit(limite).toArray();
  const medio = await nombres();
  let hechos = 0;
  for (const e of pendientes) {
    const notas = await Database.Pulso.Notas().find({ _id: { $in: e.notas } }, { projection: { "analisis.crudo": 0 } }).sort({ publicadoEn: 1 }).toArray();
    if (notas.length < 2) {
      await Database.Pulso.Eventos().updateOne({ _id: e._id }, { $set: { pendienteConsolidar: false } });
      continue;
    }
    const r = await usar({ sistema: INSTRUCCIONES_CONSOLIDAR, texto: JSON.stringify(notas.map((n) => ficha(n, medio[n.fuente] ?? n.fuente))), esquema: ESQUEMA_CONSOLIDAR });
    await Database.Pulso.Eventos().updateOne(
      { _id: e._id },
      {
        $set: {
          titulo: String(r?.titulo ?? e.titulo).trim() || e.titulo,
          detalleConsolidado: {
            resumen: String(r?.resumen ?? "").trim(),
            cifras: (Array.isArray(r?.cifras) ? r.cifras : []).filter((c: any) => Number.isFinite(Number(c?.valor))).map((c: any) => ({ valor: Number(c.valor), unidad: String(c.unidad ?? ""), queMide: String(c.que_mide ?? "") })),
          },
          discrepancias: (Array.isArray(r?.discrepancias) ? r.discrepancias : []).map(String).filter(Boolean).slice(0, 20),
          pendienteConsolidar: false,
          actualizadoEn: new Date(),
        },
      }
    );
    hechos++;
  }
  return hechos;
}

/** Moves every note of `otro` into `queda` and removes `otro` */
export async function fusionar(queda: ObjectId, otro: ObjectId): Promise<void> {
  await Database.Pulso.Notas().updateMany({ "evento.eventoId": otro }, { $set: { "evento.eventoId": queda } });
  await Database.Pulso.Eventos().deleteOne({ _id: otro });
  await recalcular(queda);
}

/**
 * Events updated since `desde` (the job's start) compared with nearby events (same rules
 * as the notes); the model decides and same-event pairs are merged.
 */
export async function reconciliar(desde: Date, usar: Usar): Promise<number> {
  const tocados = await Database.Pulso.Eventos().find({ actualizadoEn: { $gte: desde } }).toArray();
  let fusiones = 0;
  const borrados = new Set<string>();
  for (const e of tocados) {
    if (borrados.has(String(e._id))) continue;
    const referencia = e.ocurrio ?? e.primeraPublicacion?.toISOString().slice(0, 10) ?? null;
    if (!referencia) continue;
    const cerca = await Database.Pulso.Eventos()
      .find({
        _id: { $ne: e._id },
        $or: [
          { ocurrio: { $gte: sumarDias(referencia, -VENTANA_OCURRIO_DIAS), $lte: sumarDias(referencia, VENTANA_OCURRIO_DIAS) } },
          { ocurrio: null, primeraPublicacion: { $gte: new Date(Date.parse(`${referencia}T00:00:00Z`) - VENTANA_PUBLICADO_DIAS * DIA), $lte: new Date(Date.parse(`${referencia}T23:59:59Z`) + VENTANA_PUBLICADO_DIAS * DIA) } },
        ],
      })
      .limit(100)
      .toArray();
    const cand = cerca
      .filter((x) => !borrados.has(String(x._id)))
      // Same subtopic, and not clearly apart on the map (the notes were already compared one by one)
      .filter((x) => x.subtema === e.subtema)
      .filter((x) => !(x.geo && e.geo) || metros(x.geo.coordinates, e.geo.coordinates) < 3 * CERCA_EVENTO_M)
      .filter((x) => !(x.coloniaId && e.coloniaId) || String(x.coloniaId) === String(e.coloniaId) || (x.geo && e.geo))
      .slice(0, 5);
    if (!cand.length) continue;
    const resumen = (x: IEvento) => ({ evento_id: String(x._id), titulo: x.titulo, ocurrio: x.ocurrio, resumen: x.detalleConsolidado?.resumen ?? null, medios: x.fuentes, tema: x.tema });
    const r = await usar({ sistema: INSTRUCCIONES_FUSION, texto: JSON.stringify({ evento: resumen(e), candidatos: cand.map(resumen) }), esquema: ESQUEMA_FUSION });
    for (const d of Array.isArray(r?.decisiones) ? r.decisiones : []) {
      const otro = cand.find((x) => String(x._id) === String(d?.evento_id));
      if (!otro || d?.mismo_evento !== true || rango(d.confianza, 0, 1) < CONFIANZA_FUSION) continue;
      await fusionar(e._id as ObjectId, otro._id as ObjectId);
      borrados.add(String(otro._id));
      fusiones++;
    }
  }
  return fusiones;
}
