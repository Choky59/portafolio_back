import { CATEGORIAS, Categoria, PREFIJO_PROYECTOS, TIPOS_PERMITIDOS } from "../../constants/archivos";

const EXTENSIONES = Array.from(new Set(Object.values(TIPOS_PERMITIDOS).map((t) => t.extension)));

/**
 * The only object paths the manager accepts:
 *   proyectos/<slug>/<categoria>/<AAAAMMDD-HHmmss>-<nombre>.<ext>
 * Anything else (other prefixes, "..", odd characters) is rejected.
 */
const PATH_REGEX = new RegExp(
  `^${PREFIJO_PROYECTOS}/([a-z0-9]+(?:-[a-z0-9]+)*)/(${CATEGORIAS.join("|")})/` +
    `(\\d{8}-\\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*\\.(?:${EXTENSIONES.join("|")}))$`
);

export function parsePath(objectPath: unknown): { slug: string; categoria: Categoria; archivo: string } | null {
  if (typeof objectPath !== "string" || objectPath.length > 300) return null;
  const match = PATH_REGEX.exec(objectPath);
  if (!match) return null;
  return { slug: match[1], categoria: match[2] as Categoria, archivo: match[3] };
}

/** "Parte 1 – Señal Final!.MP4" -> "parte-1-senal-final" */
export function nombreSeguro(nombreOriginal: string): string {
  const sinExtension = nombreOriginal.replace(/\.[^.]*$/, "");
  const limpio = sinExtension
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return limpio || "archivo";
}

function sello(fecha: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${fecha.getUTCFullYear()}${p(fecha.getUTCMonth() + 1)}${p(fecha.getUTCDate())}-` +
    `${p(fecha.getUTCHours())}${p(fecha.getUTCMinutes())}${p(fecha.getUTCSeconds())}`
  );
}

export function construirPath(
  slug: string,
  contentType: string,
  nombreOriginal: string,
  fecha = new Date()
): string {
  const tipo = TIPOS_PERMITIDOS[contentType];
  return `${PREFIJO_PROYECTOS}/${slug}/${tipo.categoria}/${sello(fecha)}-${nombreSeguro(nombreOriginal)}.${tipo.extension}`;
}
