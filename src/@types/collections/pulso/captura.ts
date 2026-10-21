import { ObjectId } from "mongodb";
import { EstadoCaptura } from "../../../constants/pulso";

/** One line of a transcript, in seconds from the start of the video/recording */
export interface ISegmento {
  inicio: number;
  fin: number;
  texto: string;
}

/** A part of a capture as split by the analysis (segment indexes, inclusive) */
export interface IBloque {
  segmentoInicio: number;
  segmentoFin: number;
  clase: string;
  tituloProvisional: string;
}

/**
 * Raw unit written by the news scrapper (pulsoCapturas): an article, a recorded
 * show or a YouTube video. Field names are the scraper's (see its scrapper/db.py).
 */
export interface ICaptura {
  _id?: ObjectId;
  clave: string;
  fuente: string;
  tipo: "texto" | "radio" | "youtube";
  estado: EstadoCaptura;
  historial: { estado: string; en: Date; detalle?: string }[];
  intentos: number;
  error: string | null;
  url?: string | null;
  titulo?: string | null;
  publicadoEn?: Date | null;
  duracionSeg?: number | null;
  texto?: string | null;
  segmentos?: ISegmento[] | null;
  reserva: { por: string; hasta: Date } | null;
  esperaHasta?: Date | null;
  /** Set by the backend analysis */
  bloques?: IBloque[];
  /** News blocks it had, notes analyzed, and failed tries (a quiet day vs. a failure) */
  bloquesEsperados?: number;
  bloquesProcesados?: number;
  errores?: number;
  creadoEn: Date;
  actualizadoEn: Date;
}

/** pulsoFuentes, also written by the scraper (from its fuentes.yaml) */
export interface IFuentePulso {
  _id?: ObjectId;
  slug: string;
  nombre: string;
  tipo: string;
  medio: string;
  activa: boolean;
  /** What kind of outlet it is (for the crowd's source icons): radio | tv | periodico | web */
  formato?: string;
}
