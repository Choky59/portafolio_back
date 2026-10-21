/**
 * The analysis of one capture: TRANSCRITA -> SEGMENTADA -> ANALIZADA.
 *
 * 1. Split: a long show (or a long article) is split by the model into blocks; a short
 *    one is a single block. The blocks are saved on the capture (state SEGMENTADA), so
 *    a restart doesn't pay for the split again.
 * 2. Analyze: each news block (not ads, music, greetings, headline recaps) becomes a note
 *    in pulsoNotas, a few in parallel. Notes already analyzed with the current
 *    ANALISIS_VERSION are skipped, so a crash halfway resumes where it stopped.
 * 3. Link: each new "nota" is linked to an event (the same happening across outlets,
 *    eventos.service.ts), one at a time and in order, after the parallel analysis.
 * 4. Done: notes of blocks that no longer exist are removed and the capture is ANALIZADA,
 *    with how many news blocks it had and how many were analyzed (bloquesEsperados /
 *    bloquesProcesados), so few notes in a period can be told apart from a failure.
 *
 * Nothing is analyzed on its own: the admin starts a job (trabajos.service.ts) with a
 * fixed list of captures, and only those are taken. Captures are taken with the same
 * lease as the scraper (`reserva`), so two runners never analyze the same one. Errors
 * that aren't the capture's fault (no credit, provider down) free it without counting
 * a failed try. Each saved note gets its places geocoded for the map (geo.service.ts).
 */
import { ObjectId } from "mongodb";
import { Database } from "../../../middlewares/database/mongodb";
import { IBloque, ICaptura } from "../../../@types/collections/pulso/captura";
import { INota } from "../../../@types/collections/pulso/nota";
import {
  ANALISIS_PARALELO, ANALISIS_VERSION, CLASES_NOTICIA, ESTADOS_CAPTURA, PROMPT_VERSION, PULSO_MAX_INTENTOS, RUBRICA_VERSION,
  PULSO_RESERVA_MS, SEGMENTAR_DESDE_PALABRAS, SEGMENTAR_DESDE_SEG,
} from "../../../constants/pulso";
import { ESQUEMA_NOTA, ESQUEMA_SEGMENTAR, instruccionesNota, instruccionesSegmentar } from "./esquemas";
import { ErrorProveedor, IProveedor, IUso } from "./proveedor";
import * as Geo from "../mapa/geo.service";
import { enlace, ISegmentoNumerado, numerar, ordenarBloques, segmentosDe } from "./segmentos";
import { validarNota } from "./validar";
import { tiempoLocal } from "./tiempo";
import { conCatalogos, resolverFuente } from "./catalogos.service";
import * as Eventos from "./eventos.service";
import * as Consumo from "./consumo";

export interface IResultado {
  clave: string;
  notas: number;
  bloques: number;
  /** Tokens this capture used (also logged in pulsoConsumo) */
  uso: IUso;
  costoUSD: number;
}

/**
 * Claims the oldest capture ready for analysis (transcribed, or split and halfway)
 * among `ids` (a job's list). `excluir`: captures that already failed in this run.
 */
export async function tomar(por: string, ids: ObjectId[], excluir: ObjectId[] = []): Promise<ICaptura | null> {
  const ahora = new Date();
  return Database.Pulso.Capturas().findOneAndUpdate(
    {
      _id: { $in: ids, ...(excluir.length ? { $nin: excluir } : {}) },
      estado: { $in: [ESTADOS_CAPTURA.TRANSCRITA, ESTADOS_CAPTURA.SEGMENTADA] },
      intentos: { $lt: PULSO_MAX_INTENTOS },
      $or: [{ reserva: null }, { "reserva.hasta": { $lt: ahora } }],
    },
    { $set: { reserva: { por, hasta: new Date(ahora.getTime() + PULSO_RESERVA_MS) } } },
    // In publication order: a note's earlier coverage is already analyzed when it's linked to an event
    { sort: { publicadoEn: 1, creadoEn: 1 }, returnDocument: "after" }
  );
}

async function avanzar(_id: ObjectId, estado: string, detalle: string, campos: Partial<ICaptura> = {}) {
  const en = new Date();
  await Database.Pulso.Capturas().updateOne(
    { _id },
    {
      $set: { ...campos, estado: estado as ICaptura["estado"], error: null, actualizadoEn: en },
      $push: { historial: { estado, en, detalle } },
    }
  );
}

async function soltar(_id: ObjectId) {
  await Database.Pulso.Capturas().updateOne({ _id }, { $set: { reserva: null } });
}

async function fallar(_id: ObjectId, error: string) {
  const en = new Date();
  const doc = await Database.Pulso.Capturas().findOneAndUpdate(
    { _id },
    { $inc: { intentos: 1, errores: 1 }, $set: { error: error.slice(0, 2000), reserva: null, actualizadoEn: en } },
    { returnDocument: "after" }
  );
  if (doc && doc.intentos >= PULSO_MAX_INTENTOS) {
    await Database.Pulso.Capturas().updateOne(
      { _id },
      { $set: { estado: ESTADOS_CAPTURA.ERROR }, $push: { historial: { estado: ESTADOS_CAPTURA.ERROR, en, detalle: error.slice(0, 500) } } }
    );
  }
}

/** Long enough to be several news items */
function esLarga(captura: ICaptura, segmentos: ISegmentoNumerado[]): boolean {
  const palabras = segmentos.reduce((n, s) => n + s.texto.split(/\s+/).length, 0);
  return (captura.duracionSeg ?? 0) > SEGMENTAR_DESDE_SEG || palabras > SEGMENTAR_DESDE_PALABRAS;
}

/** Runs `tarea` over `items` with at most `n` at once */
async function enParalelo<T>(items: T[], n: number, tarea: (item: T) => Promise<void>): Promise<void> {
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (siguiente < items.length) await tarea(items[siguiente++]);
  });
  await Promise.all(trabajadores);
}

/**
 * Analyzes one claimed capture. Throws ErrorProveedor with `ajeno` when the worker should
 * pause (the capture is freed, not failed); any other error is counted on the capture.
 */
export async function analizar(captura: ICaptura, proveedor: IProveedor): Promise<IResultado> {
  const _id = captura._id as ObjectId;
  try {
    const segmentos = segmentosDe(captura);
    if (!segmentos.length) throw new Error("la captura no tiene texto");
    const fuente = await Database.Pulso.Fuentes().findOne({ slug: captura.fuente });
    const medio = fuente?.nombre ?? captura.fuente;
    const fuenteId = await resolverFuente(captura.fuente);
    const uso: IUso = { entrada: 0, salida: 0 };
    const usar = async (params: Parameters<IProveedor["generar"]>[0]) => {
      const r = await proveedor.generar(params);
      uso.entrada += r.uso.entrada;
      uso.salida += r.uso.salida;
      await Consumo.registrar(proveedor.modelo, r.uso);
      return r.datos as any;
    };

    // 1. Split (once: the blocks are kept on the capture)
    let bloques: IBloque[] = captura.bloques ?? [];
    if (!bloques.length) {
      if (esLarga(captura, segmentos)) {
        const r = await usar({ sistema: instruccionesSegmentar(medio), texto: numerar(segmentos), esquema: ESQUEMA_SEGMENTAR, pensar: "medium" });
        bloques = ordenarBloques(r?.bloques, segmentos.length);
      } else {
        bloques = [{ segmentoInicio: 0, segmentoFin: segmentos.length - 1, clase: "nota", tituloProvisional: captura.titulo ?? "" }];
      }
      const noticias = bloques.filter((b) => (CLASES_NOTICIA as readonly string[]).includes(b.clase)).length;
      await avanzar(_id, ESTADOS_CAPTURA.SEGMENTADA, `${bloques.length} bloques, ${noticias} noticias`, { bloques, bloquesEsperados: noticias });
    }

    // 2. Analyze the news blocks not done yet with this version
    const hechas = new Set(
      (await Database.Pulso.Notas().find({ capturaId: _id, "analisis.version": ANALISIS_VERSION }, { projection: { bloque: 1 } }).toArray()).map((n) => n.bloque)
    );
    const pendientes = bloques
      .map((b, indice) => ({ b, indice }))
      .filter(({ b, indice }) => (CLASES_NOTICIA as readonly string[]).includes(b.clase) && !hechas.has(indice));
    const fecha = captura.publicadoEn ? Consumo.hoy(captura.publicadoEn) : "desconocida";

    await enParalelo(pendientes, ANALISIS_PARALELO, async ({ b, indice }) => {
      const crudo = await usar({
        sistema: instruccionesNota(medio, fecha),
        texto: numerar(segmentos, b.segmentoInicio, b.segmentoFin),
        esquema: ESQUEMA_NOTA,
      });
      const contenido = await conCatalogos(validarNota(crudo, { medio, segmentos, desde: b.segmentoInicio, hasta: b.segmentoFin }));
      // Places on the map; a geocoding problem never fails the analysis
      contenido.lugares = await Geo.ubicarLugares(contenido.lugares, contenido.clasificacion, contenido.actores).catch(() => contenido.lugares);
      const inicio = segmentos[b.segmentoInicio].inicio;
      const nota: Omit<INota, "_id"> = {
        capturaId: _id,
        clave: captura.clave,
        fuente: captura.fuente,
        fuenteId,
        bloque: indice,
        clase: b.clase,
        url: captura.url ?? null,
        enlace: enlace(captura, inicio),
        publicadoEn: captura.publicadoEn ?? null,
        tiempo: inicio === null ? null : {
          inicio,
          fin: segmentos[b.segmentoFin].fin ?? inicio,
          segmentoInicio: b.segmentoInicio,
          segmentoFin: b.segmentoFin,
        },
        tiempoLocal: tiempoLocal(captura.publicadoEn, contenido.fechas),
        ...contenido,
        analisis: { version: ANALISIS_VERSION, promptVersion: PROMPT_VERSION, rubricaVersion: RUBRICA_VERSION, modelo: proveedor.modelo, en: new Date(), crudo },
        creadoEn: new Date(),
      };
      await Database.Pulso.Notas().replaceOne({ capturaId: _id, bloque: indice }, nota, { upsert: true });
    });

    // 3. Link the notes to events, in order (resumable: notes already linked are skipped)
    const indices = bloques.map((_, i) => i).filter((i) => (CLASES_NOTICIA as readonly string[]).includes(bloques[i].clase));
    await Database.Pulso.Notas().deleteMany({ capturaId: _id, bloque: { $nin: indices } });
    const sinEvento = await Database.Pulso.Notas()
      .find({ capturaId: _id, clase: "nota", "evento.eventoId": { $exists: false } }, { projection: { "analisis.crudo": 0 } })
      .sort({ bloque: 1 })
      .toArray();
    for (const nota of sinEvento) await Eventos.vincular(nota, usar);

    // 4. Done
    const procesados = await Database.Pulso.Notas().countDocuments({ capturaId: _id });
    await avanzar(_id, ESTADOS_CAPTURA.ANALIZADA, `${indices.length} notas`, { reserva: null, bloquesEsperados: indices.length, bloquesProcesados: procesados });
    return { clave: captura.clave, notas: indices.length, bloques: bloques.length, uso, costoUSD: Consumo.costo(uso) };
  } catch (err: any) {
    if (err instanceof ErrorProveedor && err.ajeno) {
      await soltar(_id);
      throw err;
    }
    await fallar(_id, `${err?.name ?? "Error"}: ${err?.message ?? err}`);
    throw err;
  }
}
