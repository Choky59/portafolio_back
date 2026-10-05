import { IProyecto } from "../../@types/content/proyecto";

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
  "videos",
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

  (raw.videos ?? []).forEach((v: any, i: number) => {
    if (!isString(v?.titulo)) errors.push(`videos[${i}].titulo is required`);
    if (!YOUTUBE_ID_REGEX.test(v?.youtubeId ?? "")) errors.push(`videos[${i}].youtubeId is not a valid YouTube id`);
  });

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
    videos: raw.videos ?? [],
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
