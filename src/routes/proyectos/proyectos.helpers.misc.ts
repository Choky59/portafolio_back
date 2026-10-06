import { IBloqueArticulo, IProyecto, IVideoProyecto } from "../../@types/content/proyecto";

export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const YOUTUBE_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isArray = (v: unknown): v is any[] => Array.isArray(v);

function isHttpsUrl(v: unknown): boolean {
  if (!isString(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** Optional array fields default to [] so the JSON can stay short */
const ARRAY_FIELDS = [
  "escenas",
  "comoFunciona",
  "materiales",
  "pasos",
  "codigo",
  "descargas",
  "retos",
] as const;

/**
 * Validates and normalizes a project JSON.
 * Returns the list of problems so the server can refuse to boot with a clear message.
 */
export function validateProyecto(
  raw: any,
  expectedSlug: string
): { proyecto?: IProyecto; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { errors: ["must be a JSON object"] };
  }

  if (raw.slug !== expectedSlug) errors.push(`'slug' must be "${expectedSlug}" (same as file name)`);
  if (!SLUG_REGEX.test(expectedSlug)) errors.push("file name must be a slug: lowercase, numbers and '-'");
  if (!Number.isInteger(raw.numero) || raw.numero < 1) errors.push("'numero' must be an integer >= 1");
  if (!isString(raw.titulo)) errors.push("'titulo' is required");
  if (!isString(raw.resumen)) errors.push("'resumen' is required");
  if (!isString(raw.fecha) || !DATE_REGEX.test(raw.fecha)) errors.push("'fecha' must be yyyy-mm-dd");
  if (!isArray(raw.tecnologias) || !raw.tecnologias.every(isString))
    errors.push("'tecnologias' must be an array of strings");

  for (const field of ARRAY_FIELDS) {
    if (raw[field] !== undefined && !isArray(raw[field])) errors.push(`'${field}' must be an array`);
  }

  if (raw.videos !== undefined) {
    errors.push(`'videos' no longer goes here: one file per video in content/proyectos/${expectedSlug}/videos/<video>.json`);
  }

  (raw.escenas ?? []).forEach((e: any, i: number) => {
    if (!isString(e?.titulo)) errors.push(`escenas[${i}].titulo is required`);
    if (!isHttpsUrl(e?.src)) errors.push(`escenas[${i}].src must be an https URL`);
    if (e?.poster !== undefined && !isHttpsUrl(e.poster)) errors.push(`escenas[${i}].poster must be an https URL`);
  });

  if (raw.modelo3d != null) {
    if (!isHttpsUrl(raw.modelo3d.src)) errors.push("modelo3d.src must be an https URL");
    if (raw.modelo3d.poster !== undefined && !isHttpsUrl(raw.modelo3d.poster))
      errors.push("modelo3d.poster must be an https URL");
  }

  if (errors.length) return { errors };

  const proyecto: IProyecto = {
    slug: raw.slug,
    numero: raw.numero,
    titulo: raw.titulo,
    resumen: raw.resumen,
    fecha: raw.fecha,
    tecnologias: raw.tecnologias,
    enVivo: raw.enVivo === true,
    videos: [], // filled by the service from the videos/ folder
    escenas: raw.escenas ?? [],
    modelo3d: raw.modelo3d ?? null,
    problema: raw.problema ?? "",
    solucion: raw.solucion ?? "",
    resultado: raw.resultado ?? "",
    comoFunciona: raw.comoFunciona ?? [],
    materiales: raw.materiales ?? [],
    pasos: raw.pasos ?? [],
    codigo: raw.codigo ?? [],
    descargas: raw.descargas ?? [],
    retos: raw.retos ?? [],
  };

  return { proyecto, errors };
}

/**
 * Validates and normalizes one video file (content/proyectos/<slug>/videos/<video>.json).
 * src and youtubeId are optional: without them the page shows "coming soon".
 */
export function validateVideo(
  raw: any,
  expectedSlug: string
): { video?: IVideoProyecto; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { errors: ["must be a JSON object"] };
  }

  if (raw.slug !== expectedSlug) errors.push(`'slug' must be "${expectedSlug}" (same as file name)`);
  if (!SLUG_REGEX.test(expectedSlug)) errors.push("file name must be a slug: lowercase, numbers and '-'");
  if (!Number.isInteger(raw.parte) || raw.parte < 1) errors.push("'parte' must be an integer >= 1");
  if (!isString(raw.titulo)) errors.push("'titulo' is required");
  if (!isString(raw.resumen)) errors.push("'resumen' is required");
  if (raw.duracion !== undefined && !isString(raw.duracion)) errors.push("'duracion' must be a string like \"2:00\"");
  if (raw.fecha !== undefined && (!isString(raw.fecha) || !DATE_REGEX.test(raw.fecha))) errors.push("'fecha' must be yyyy-mm-dd");
  if (raw.src !== undefined && !isHttpsUrl(raw.src)) errors.push("'src' must be an https URL");
  if (raw.youtubeId !== undefined && !YOUTUBE_ID_REGEX.test(raw.youtubeId)) errors.push("'youtubeId' is not a valid YouTube id");
  if (raw.src !== undefined && raw.youtubeId !== undefined) errors.push("use 'src' or 'youtubeId', not both");
  if (raw.poster !== undefined && !isHttpsUrl(raw.poster)) errors.push("'poster' must be an https URL");
  if (raw.vertical !== undefined && typeof raw.vertical !== "boolean") errors.push("'vertical' must be true or false");
  if (raw.temas !== undefined && (!isArray(raw.temas) || !raw.temas.every(isString)))
    errors.push("'temas' must be an array of strings");

  if (raw.articulo !== undefined && !isArray(raw.articulo)) {
    errors.push("'articulo' must be an array of { titulo, texto, puntos? }");
  }
  (isArray(raw.articulo) ? raw.articulo : []).forEach((b: any, i: number) => {
    if (!isString(b?.titulo)) errors.push(`articulo[${i}].titulo is required`);
    if (!isString(b?.texto)) errors.push(`articulo[${i}].texto is required`);
    if (b?.puntos !== undefined && (!isArray(b.puntos) || !b.puntos.every(isString)))
      errors.push(`articulo[${i}].puntos must be an array of strings`);
  });

  if (errors.length) return { errors };

  const articulo: IBloqueArticulo[] = (raw.articulo ?? []).map((b: any) => ({
    titulo: b.titulo,
    texto: b.texto,
    ...(b.puntos ? { puntos: b.puntos } : {}),
  }));

  const video: IVideoProyecto = {
    slug: raw.slug,
    parte: raw.parte,
    titulo: raw.titulo,
    resumen: raw.resumen,
    ...(raw.duracion ? { duracion: raw.duracion } : {}),
    ...(raw.fecha ? { fecha: raw.fecha } : {}),
    ...(raw.src ? { src: raw.src } : {}),
    ...(raw.youtubeId ? { youtubeId: raw.youtubeId } : {}),
    ...(raw.poster ? { poster: raw.poster } : {}),
    vertical: raw.vertical !== false,
    temas: raw.temas ?? [],
    articulo,
  };

  return { video, errors };
}
