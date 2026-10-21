import { ObjectId } from "mongodb";
import { Emocion } from "../../../constants/pulso";

export interface ILugarNota {
  mencion: string;
  tipo: string;
  calle1: string | null;
  calle2: string | null;
  colonia: string | null;
  lugarReferencia: string | null;
  municipio: string | null;
  /** lugar_del_hecho (goes to the map) | mencionado | contexto (the city when there's a more precise place) */
  rol: string;
  /** The model fixed the name against the transcript ("Zaguaripa" -> "Sahuaripa") */
  correccionTranscripcion: boolean;
  /** Filled by geocoding: GeoJSON point, precision and how sure we are */
  geo?: { type: "Point"; coordinates: [number, number] } | null;
  /** cruce | lugar | colonia | aproximada (blurred on purpose) */
  precision?: string | null;
  /** Colony the place falls in, to group the map by colony */
  coloniaMapa?: string | null;
  coloniaId?: ObjectId | null;
  /** Not available yet (needs INEGI polygons) */
  ageb?: string | null;
  sector?: string | null;
  /** cruce_osm | lugar_conocido | nominatim | colonia_osm */
  geocodificador?: string | null;
  confianzaGeo?: number | null;
  /** The known building / landmark it is (pulsoLugaresConocidos) */
  lugarConocidoId?: ObjectId | null;
  /** A government building: kept out of the by-colony analysis (a protest at the Congress isn't about its colony) */
  esSedeInstitucional?: boolean;
  /** The note's actor this place belongs to ("Poder Judicial" the building and the institution) */
  actorId?: ObjectId | null;
}

export interface IActorNota {
  nombre: string;
  tipo: string;
  cargo: string | null;
  institucion: string | null;
  nivelGobierno: string | null;
  rol: string;
  /** Minors' names are never shown publicly (and never go to the actors catalog) */
  esMenor: boolean;
  /** -1 critical .. 1 favorable; null if it doesn't apply */
  tonoHacia: number | null;
  actorId: ObjectId | null;
}

export interface ICitaNota {
  texto: string;
  quien: string | null;
  /** Who is speaking: reportero | funcionario | testigo | ciudadano | experto | otro */
  rolHablante: string;
  /** Whose information it really is ("según Tránsito Municipal" -> "Tránsito Municipal") */
  atribuidaA: string | null;
  atribuidaActorId: ObjectId | null;
  segmento: number;
  segundo: number | null;
}

export interface IEmocionNota {
  valor: number;
  /** Why, with concrete facts of the note; null when valor is 0 */
  explicacion: string | null;
}

/** Local (Hermosillo) time of publication and of the event, computed in code */
export interface ITiempoLocal {
  publicadoFecha: string | null;
  publicadoHora: number | null;
  publicadoDiaSemana: string | null;
  ocurrioFecha: string | null;
  ocurrioDiaSemana: string | null;
  ocurrioFranja: string | null;
  ocurrioHora: number | null;
  /** Days between the event and its publication */
  rezagoDias: number | null;
  /** Of the event if known, else of the publication */
  semanaISO: string | null;
  mes: string | null;
}

export interface IRelacionNota {
  notaId: ObjectId;
  tipo: string;
  confianza: number;
  justificacion: string;
  discrepancias: string[];
}

/**
 * One news item (pulsoNotas): a block of a capture, analyzed. Its time range points
 * to the exact minute of the video/recording.
 */
export interface INota {
  _id?: ObjectId;
  capturaId: ObjectId;
  clave: string;
  fuente: string;
  fuenteId: ObjectId | null;
  /** Index of the block in the capture */
  bloque: number;
  clase: string;
  url: string | null;
  /** Link to the minute (YouTube ?t=) or the article */
  enlace: string | null;
  publicadoEn: Date | null;
  tiempo: { inicio: number; fin: number; segmentoInicio: number; segmentoFin: number } | null;
  tiempoLocal: ITiempoLocal;

  titulo: string;
  resumenCorto: string;
  resumen: string;
  puntosClave: string[];
  clasificacion: {
    tipo: string;
    ambito: string;
    tema: string;
    subtema: string;
    temaSecundario: string | null;
    /** Ids of pulsoEtiquetas (normalized vocabulary) */
    etiquetas: ObjectId[];
    /** The tags as the model wrote them */
    etiquetasLibres: string[];
    esAlerta: boolean;
    relevancia: number;
  };
  /** Structured facts for some subtopics (see DETALLE_POR_SUBTEMA); null otherwise */
  detalle: Record<string, unknown> | null;
  lugares: ILugarNota[];
  actores: IActorNota[];
  afectados: { grupo: string; cantidad: number | null; efecto: string }[];
  cifras: { valor: number; unidad: string; queMide: string }[];
  fechas: { ocurrio: string | null; ocurrioFranja: string | null; ocurrioHora: number | null; proximosEventos: { desde: string | null; hasta: string | null; que: string }[] };
  sentimiento: {
    emociones: Record<Emocion, IEmocionNota>;
    emocionDominante: Emocion;
    /** How strongly the public reacts (0..1); the mix above says how */
    intensidad: number;
    polaridad: number;
    tonoMedio: string;
    posturaGobierno: { municipal: number | null; estatal: number | null; federal: number | null };
    polemica: number;
    justificacion: string;
  };
  citas: ICitaNota[];
  confianza: number;

  /** The same happening across outlets (pulsoEventos); set after the note is analyzed */
  evento?: { eventoId: ObjectId; confianza: number; justificacion: string } | null;
  seguimientoDe?: ObjectId | null;
  relaciones?: IRelacionNota[];

  analisis: { version: number; promptVersion: string; rubricaVersion: number; modelo: string; en: Date; crudo: unknown };
  creadoEn: Date;
}

/** pulsoConsumo: tokens and cost per day and model */
export interface IConsumo {
  _id?: ObjectId;
  /** yyyy-mm-dd (Hermosillo) */
  fecha: string;
  modelo: string;
  llamadas: number;
  entrada: number;
  salida: number;
  /** Web searches (billed apart from the tokens) */
  busquedas?: number;
  costoUSD: number;
}

/** pulsoEventos: one happening, told by one or more notes of possibly several outlets */
export interface IEvento {
  _id?: ObjectId;
  titulo: string;
  tema: string;
  subtema: string;
  ocurrio: string | null;
  geo: { type: "Point"; coordinates: [number, number] } | null;
  coloniaId: ObjectId | null;
  notas: ObjectId[];
  /** Source slugs and ids that told it */
  fuentes: string[];
  fuenteIds: ObjectId[];
  numMedios: number;
  detalleConsolidado: { resumen: string; cifras: { valor: number; unidad: string; queMide: string }[] } | null;
  discrepancias: string[];
  primeraPublicacion: Date | null;
  /** Its summary must be written again (a note joined) */
  pendienteConsolidar: boolean;
  /** Other outlets' articles about it found on the internet (Gemini + Google Search), links checked */
  coberturaWeb?: { en: Date; notas: { medio: string; titulo: string; url: string; dominio: string; fecha: string | null }[] } | null;
  /** When it was searched (each event once) */
  busquedaWebEn?: Date;
  creadoEn: Date;
  actualizadoEn: Date;
}

/** pulsoActores: people and institutions, with the names they appear under */
export interface IActorCatalogo {
  _id?: ObjectId;
  nombre: string;
  normal: string;
  alias: string[];
  tipo: string;
  cargo: string | null;
  nivelGobierno: string | null;
  creadoPor: "ia" | "admin";
  creadoEn: Date;
}

/** pulsoEtiquetas: tags normalized into a vocabulary (built automatically for now) */
export interface IEtiqueta {
  _id?: ObjectId;
  normal: string;
  nombre: string;
  usos: number;
  creadoEn: Date;
}
