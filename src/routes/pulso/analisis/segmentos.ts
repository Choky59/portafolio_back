/**
 * Turning a capture into what the model reads (numbered segments with their time)
 * and the model's blocks back into clean, contiguous ranges.
 */
import { IBloque, ICaptura, ISegmento } from "../../../@types/collections/pulso/captura";
import { CLASES_BLOQUE } from "../../../constants/pulso";

/** A segment the model can cite by number; `inicio` is null for article paragraphs */
export interface ISegmentoNumerado {
  inicio: number | null;
  fin: number | null;
  texto: string;
}

export function hms(segundos: number): string {
  const s = Math.floor(segundos);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Transcript segments, or the article's paragraphs (no times) when it's text */
export function segmentosDe(captura: ICaptura): ISegmentoNumerado[] {
  if (captura.segmentos?.length) return captura.segmentos.map((s: ISegmento) => ({ inicio: s.inicio, fin: s.fin, texto: s.texto }));
  return (captura.texto ?? "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((texto) => ({ inicio: null, fin: null, texto }));
}

/** "[n] h:mm:ss texto" lines for segments desde..hasta (inclusive) */
export function numerar(segmentos: ISegmentoNumerado[], desde = 0, hasta = segmentos.length - 1): string {
  const lineas: string[] = [];
  for (let i = desde; i <= hasta; i++) {
    const s = segmentos[i];
    lineas.push(s.inicio === null ? `[${i}] ${s.texto}` : `[${i}] ${hms(s.inicio)} ${s.texto}`);
  }
  return lineas.join("\n");
}

/**
 * The model's blocks as contiguous ranges covering every segment: sorted, clamped to
 * the transcript, overlaps trimmed and gaps given to the previous block. Unknown
 * classes become "otro". (The model usually gets this right; this makes it certain.)
 */
export function ordenarBloques(crudos: any[], total: number): IBloque[] {
  if (total === 0) return [];
  const bloques = (Array.isArray(crudos) ? crudos : [])
    .map((b) => ({
      segmentoInicio: Math.max(0, Math.min(total - 1, Math.trunc(Number(b?.segmento_inicio)))),
      segmentoFin: Math.max(0, Math.min(total - 1, Math.trunc(Number(b?.segmento_fin)))),
      clase: (CLASES_BLOQUE as readonly string[]).includes(b?.clase) ? b.clase : "otro",
      tituloProvisional: String(b?.titulo_provisional ?? "").slice(0, 300),
    }))
    .filter((b) => Number.isFinite(b.segmentoInicio) && Number.isFinite(b.segmentoFin) && b.segmentoFin >= b.segmentoInicio)
    .sort((a, b) => a.segmentoInicio - b.segmentoInicio);

  const limpios: IBloque[] = [];
  for (const b of bloques) {
    const anterior = limpios[limpios.length - 1];
    const inicio = anterior ? anterior.segmentoFin + 1 : 0; // no gaps, no overlaps
    if (b.segmentoFin < inicio) continue; // fully inside the previous block
    limpios.push({ ...b, segmentoInicio: inicio });
  }
  if (!limpios.length) return [{ segmentoInicio: 0, segmentoFin: total - 1, clase: "nota", tituloProvisional: "" }];
  limpios[limpios.length - 1].segmentoFin = total - 1; // until the end
  return limpios;
}

/** YouTube link at a second (or the plain URL for articles) */
export function enlace(captura: ICaptura, segundo: number | null): string | null {
  if (captura.tipo === "youtube" && captura.clave.startsWith("youtube:")) {
    const id = captura.clave.slice("youtube:".length);
    return segundo === null ? `https://youtu.be/${id}` : `https://youtu.be/${id}?t=${Math.floor(segundo)}`;
  }
  return captura.url ?? null;
}
