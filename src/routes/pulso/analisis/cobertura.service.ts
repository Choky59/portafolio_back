/**
 * Coverage on the internet: after a job, Gemini (with Google Search) looks for other
 * outlets' articles about each relevant event the job touched, including outlets the
 * scraper doesn't follow. The links are kept on the event (pulsoEventos.coberturaWeb).
 *
 * The model can answer Google's temporary redirect links or, rarely, a wrong address:
 * every link is followed to its final URL and kept only if the page exists. Each search
 * is billed apart from the tokens (PULSO_PRECIO_BUSQUEDA), so only events worth it are
 * searched (relevant, an alert, or told by 2+ outlets), at most PULSO_BUSQUEDAS_POR_TRABAJO
 * per job, and each event once.
 */
import { ObjectId } from "mongodb";
import { Database } from "../../../middlewares/database/mongodb";
import { IEvento } from "../../../@types/collections/pulso/nota";
import { ESQUEMA_COBERTURA, INSTRUCCIONES_COBERTURA } from "./esquemas";
import type { Usar } from "./eventos.service";

export const BUSQUEDAS_POR_TRABAJO_DEFAULT = 40;
const RELEVANCIA_MINIMA = 0.5;
const MAX_LIGAS = 10;
const DIAS_MAXIMOS = 10;
const DIA = 86400000;

export const busquedasPorTrabajo = () => Number(process.env.PULSO_BUSQUEDAS_POR_TRABAJO) || BUSQUEDAS_POR_TRABAJO_DEFAULT;

/**
 * The page a link ends at, or null if it doesn't exist. Sites that block robots (401/403/429)
 * still count: the page is there, it just won't serve us.
 */
export async function urlFinal(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (PulsoHermosillo; portafolio)", Accept: "text/html" },
      signal: AbortSignal.timeout(15000),
    });
    res.body?.cancel().catch(() => {});
    const final = res.url || url;
    if (/(^|\.)(google|googleapis|vertexaisearch\.cloud\.google)\.com$/i.test(new URL(final).hostname)) return null;
    return res.ok || [401, 403, 429].includes(res.status) ? final : null;
  } catch {
    return null;
  }
}

/** Swappable in tests (no network) */
export const deps = { urlFinal };

const sinRastreo = (u: string) => {
  const x = new URL(u);
  for (const k of [...x.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) x.searchParams.delete(k);
  x.hash = "";
  return x.toString();
};
const clave = (u: string) => {
  const x = new URL(u);
  return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`;
};

/** Events of this job worth a search: relevant, an alert or several outlets; not searched yet */
export async function porBuscar(desde: Date, limite = busquedasPorTrabajo()): Promise<IEvento[]> {
  const eventos = await Database.Pulso.Eventos().find({ actualizadoEn: { $gte: desde }, busquedaWebEn: { $exists: false } }).toArray();
  if (!eventos.length) return [];
  const notas = await Database.Pulso.Notas()
    .find({ "evento.eventoId": { $in: eventos.map((e) => e._id as ObjectId) } }, { projection: { "evento.eventoId": 1, "clasificacion.relevancia": 1, "clasificacion.esAlerta": 1 } })
    .toArray();
  const peso = new Map<string, number>();
  for (const n of notas) {
    const k = String(n.evento!.eventoId);
    const v = (n.clasificacion?.relevancia ?? 0) + (n.clasificacion?.esAlerta ? 1 : 0);
    peso.set(k, Math.max(peso.get(k) ?? 0, v));
  }
  return eventos
    .filter((e) => (peso.get(String(e._id)) ?? 0) >= RELEVANCIA_MINIMA || e.numMedios >= 2)
    .sort((a, b) => b.numMedios - a.numMedios || (peso.get(String(b._id)) ?? 0) - (peso.get(String(a._id)) ?? 0))
    .slice(0, limite);
}

/** One event: search, check the links and keep them. Returns how many links were kept */
export async function buscarEvento(e: IEvento, usar: Usar): Promise<number> {
  const notas = await Database.Pulso.Notas()
    .find({ "evento.eventoId": e._id }, { projection: { titulo: 1, resumen: 1, resumenCorto: 1, enlace: 1, url: 1, fuente: 1, publicadoEn: 1, lugares: 1 } })
    .toArray();
  const lugar = notas.flatMap((n) => n.lugares.filter((l) => l.rol === "lugar_del_hecho").map((l) => l.mencion))[0] ?? null;
  const r = await usar({
    sistema: INSTRUCCIONES_COBERTURA,
    texto: JSON.stringify({
      titulo: e.titulo,
      fecha: e.ocurrio ?? e.primeraPublicacion?.toISOString().slice(0, 10) ?? null,
      ciudad: "Hermosillo, Sonora, México",
      lugar,
      resumen: e.detalleConsolidado?.resumen || notas[0]?.resumen || notas[0]?.resumenCorto || "",
      titulos_conocidos: notas.map((n) => n.titulo),
    }),
    esquema: ESQUEMA_COBERTURA,
    buscar: true,
  });

  // Our own notes are already listed from the database
  const nuestras = new Set(notas.flatMap((n) => [n.enlace, n.url]).filter(Boolean).map((u) => { try { return clave(u!); } catch { return ""; } }));
  const referencia = Date.parse(`${e.ocurrio ?? e.primeraPublicacion?.toISOString().slice(0, 10) ?? ""}T12:00:00Z`);
  const vistas = new Set<string>();
  const ligas: NonNullable<IEvento["coberturaWeb"]>["notas"] = [];
  for (const x of Array.isArray(r?.notas) ? r.notas : []) {
    if (ligas.length >= MAX_LIGAS) break;
    const fecha = /^\d{4}-\d{2}-\d{2}/.test(x?.fecha ?? "") ? String(x.fecha).slice(0, 10) : null;
    // Something from another week isn't this event
    if (fecha && Number.isFinite(referencia) && Math.abs(Date.parse(`${fecha}T12:00:00Z`) - referencia) > DIAS_MAXIMOS * DIA) continue;
    const final = await deps.urlFinal(String(x?.url ?? ""));
    if (!final) continue;
    const limpia = sinRastreo(final);
    const k = clave(limpia);
    if (vistas.has(k) || nuestras.has(k)) continue;
    vistas.add(k);
    ligas.push({
      medio: String(x.medio ?? "").trim() || new URL(limpia).hostname.replace(/^www\./, ""),
      titulo: String(x.titulo ?? "").trim(),
      url: limpia,
      dominio: new URL(limpia).hostname.replace(/^www\./, ""),
      fecha,
    });
  }
  await Database.Pulso.Eventos().updateOne({ _id: e._id }, { $set: { coberturaWeb: { en: new Date(), notas: ligas }, busquedaWebEn: new Date() } });
  return ligas.length;
}

/** Every event of the job worth it, one search each */
export async function buscarCobertura(desde: Date, usar: Usar): Promise<{ eventos: number; ligas: number }> {
  let eventos = 0;
  let ligas = 0;
  for (const e of await porBuscar(desde)) {
    ligas += await buscarEvento(e, usar);
    eventos++;
  }
  return { eventos, ligas };
}
