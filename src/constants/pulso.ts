/**
 * "El pulso de Hermosillo": news analysis.
 *
 * The news scrapper (separate repo) writes captures to pulsoCapturas up to TRANSCRITA.
 * From there the backend splits each one into news items, analyzes them with an LLM
 * and stores them in pulsoNotas. These names and states are a contract with the scraper
 * (news scrapper/scrapper/estados.py).
 */

export const ESTADOS_CAPTURA = {
  DESCUBIERTA: "descubierta",
  DESCARGADA: "descargada",
  TRANSCRITA: "transcrita",
  SEGMENTADA: "segmentada",
  ANALIZADA: "analizada",
  INDEXADA: "indexada",
  ERROR: "error",
  DESCARTADA: "descartada",
} as const;
export type EstadoCaptura = (typeof ESTADOS_CAPTURA)[keyof typeof ESTADOS_CAPTURA];

/** After this many failed tries a capture stays in ERROR (same as the scraper) */
export const PULSO_MAX_INTENTOS = 3;
/** A worker holds a capture this long; if it dies, someone else can take it */
export const PULSO_RESERVA_MS = 30 * 60 * 1000;

/**
 * Bump when the instructions, the schema or the catalog change: notes analyzed with an
 * older version can be re-analyzed without downloading anything again.
 */
export const ANALISIS_VERSION = 2;
/** Date of the instructions' text and version of the scoring rubric (both stored on each note) */
export const PROMPT_VERSION = "2026-10-21";
export const RUBRICA_VERSION = 1;

/** Longer than this (or more words) gets split into news items; shorter is one item */
export const SEGMENTAR_DESDE_SEG = 8 * 60;
export const SEGMENTAR_DESDE_PALABRAS = 1200;

/** Notes of one capture analyzed in parallel */
export const ANALISIS_PARALELO = 4;

export const CLASES_BLOQUE = ["nota", "entrevista", "opinion", "debate", "titulares", "publicidad", "musica", "saludos", "otro"] as const;
/** Blocks that are news (the rest is ads, music, greetings, headline recaps) */
export const CLASES_NOTICIA = ["nota", "entrevista", "opinion", "debate"] as const;

/**
 * The public's reaction mix (sums 1). No "neutral": how strong the reaction is goes in
 * sentimiento.intensidad instead (the crowd shows the rest of the people not reacting).
 */
export const EMOCIONES = ["alegria", "enojo", "tristeza", "miedo", "sorpresa"] as const;
export type Emocion = (typeof EMOCIONES)[number];

/** Topics and subtopics: a fixed catalog so filters and totals add up */
export const TEMAS: Record<string, string[]> = {
  servicios_publicos: ["agua", "energia", "recoleccion_basura", "alumbrado", "drenaje", "internet_telefonia"],
  movilidad: ["transporte_urbano", "vialidades_y_baches", "accidentes_viales", "transito_y_multas", "obras_viales", "ciclismo_y_peatones"],
  seguridad: ["homicidios", "robos", "violencia_familiar_y_de_genero", "desaparecidos", "narcotrafico_y_crimen_organizado", "operativos_y_detenciones", "policia"],
  justicia: ["procesos_judiciales", "fiscalia", "derechos_humanos", "corrupcion"],
  salud: ["hospitales_y_servicio", "enfermedades_y_vacunas", "salud_mental", "medicamentos_y_abasto", "prevencion"],
  educacion: ["escuelas_y_calendario", "becas_y_apoyos", "universidades", "docentes_y_sindicatos", "infraestructura_escolar"],
  gobierno: ["anuncios_y_programas", "presupuesto_y_finanzas", "cabildo_y_congreso", "nombramientos", "transparencia", "tramites"],
  politica: ["partidos", "elecciones_y_candidatos", "protestas_y_movimientos", "encuestas_y_aprobacion"],
  economia: ["empleo", "empresas_e_inversion", "precios_y_costo_de_vida", "mineria", "agro_y_ganaderia", "comercio"],
  medio_ambiente_y_clima: ["calor_y_clima", "lluvias_e_inundaciones", "contaminacion_y_basura", "agua_y_sequia", "areas_verdes", "fauna"],
  desarrollo_urbano: ["vivienda", "obra_publica", "uso_de_suelo", "colonias_irregulares", "espacios_publicos"],
  sociedad_y_cultura: ["eventos_y_cultura", "deportes", "comunidad_y_tradiciones", "migracion", "grupos_vulnerables", "curiosidades"],
  otro: ["otro"],
};
/** "tema/subtema" pairs: the LLM picks one, so the pair is always valid */
export const PARES_TEMA = Object.entries(TEMAS).flatMap(([t, subs]) => subs.map((s) => `${t}/${s}`));

export const TIPOS_NOTA = ["hecho", "anuncio_oficial", "denuncia_ciudadana", "entrevista", "opinion", "debate", "boletin", "otro"] as const;
export const AMBITOS = ["local", "estatal", "nacional", "internacional"] as const;
export const TONOS_MEDIO = ["informativo", "critico", "favorable", "alarmista", "sensacionalista", "humano"] as const;
export const TIPOS_LUGAR = ["direccion", "cruce", "calle", "colonia", "edificio", "zona", "municipio", "estado", "pais"] as const;
export const TIPOS_ACTOR = ["persona", "funcionario", "institucion_gobierno", "empresa", "partido", "organizacion_civil", "otro"] as const;
export const ROLES_ACTOR = ["protagonista", "fuente_citada", "afectado", "responsable", "mencionado"] as const;
export const NIVELES_GOBIERNO = ["municipal", "estatal", "federal"] as const;
export const EFECTOS = ["beneficio", "perjuicio", "riesgo", "mixto"] as const;
export const ROLES_HABLANTE = ["reportero", "funcionario", "testigo", "ciudadano", "experto", "otro"] as const;
export const FRANJAS = ["madrugada", "mañana", "tarde", "noche"] as const;
export const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;

/* ---------------------------------- the same event across outlets ---------------------------------- */

export const RELACIONES = ["mismo_evento", "seguimiento", "relacionado", "distinto"] as const;
/** A note joins an existing event (same event or follow-up) at this confidence or more */
export const CONFIANZA_EVENTO = 0.7;
/** Two events are merged at this confidence or more */
export const CONFIANZA_FUSION = 0.75;
export const MAX_CANDIDATAS = 10;
/** Candidate window: ±3 days around when it happened, ±5 around publication if that's unknown */
export const VENTANA_OCURRIO_DIAS = 3;
export const VENTANA_PUBLICADO_DIAS = 5;
export const CERCA_EVENTO_M = 1000;

/** Subtopics with a structured `detalle` (kind of detail for each) */
export const DETALLE_POR_SUBTEMA: Record<string, string> = {
  accidentes_viales: "accidente_vial",
  homicidios: "delito",
  robos: "delito",
  agua: "falla_servicio",
  energia: "falla_servicio",
  transporte_urbano: "transporte",
  calor_y_clima: "clima",
};

/* ---------------------------------- LLM and costs ---------------------------------- */

export const PULSO_MODELO_DEFAULT = "gemini-3.8-flash";
/** USD per million tokens (input / output). Override with PULSO_PRECIO_ENTRADA / PULSO_PRECIO_SALIDA */
export const PULSO_PRECIO_DEFAULT = { entrada: 0.75, salida: 3.75 };
/** USD per web search (Grounding with Google Search), apart from the tokens; set PULSO_PRECIO_BUSQUEDA to your plan's */
export const PULSO_PRECIO_BUSQUEDA_DEFAULT = 0.014;
/** Tokens (input + output) per day at most; past this the worker waits for the next day */
export const PULSO_TOKENS_DIA_DEFAULT = 3_000_000;
/** How often the worker looks for new transcribed captures */
export const PULSO_INTERVALO_MS = 60 * 1000;
