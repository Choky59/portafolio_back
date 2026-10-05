// routes/proyectos/proyectos.service.ts
import { readdirSync, readFileSync } from "fs";
import path from "path";
import {
  IProyecto,
  IProyectoResumen,
  IProyectoVecino,
} from "../../@types/content/proyecto";
import { validateProyecto } from "./proyectos.helpers.misc";

/** Same path from src/ (ts-jest) and build/ (node): <root>/content/proyectos */
const DEFAULT_DIR = path.resolve(__dirname, "../../../content/proyectos");

let proyectos: IProyecto[] = [];

/**
 * Reads and validates every content/proyectos/*.json once (at boot).
 * Throws with every problem found so a bad JSON never reaches production silently.
 */
export function loadProyectos(dir = process.env.PROYECTOS_DIR || DEFAULT_DIR): IProyecto[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const loaded: IProyecto[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const slug = path.basename(file, ".json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch (err: any) {
      problems.push(`${file}: invalid JSON (${err?.message ?? err})`);
      continue;
    }

    const { proyecto, errors } = validateProyecto(raw, slug);
    if (!proyecto) {
      problems.push(...errors.map((e) => `${file}: ${e}`));
      continue;
    }
    loaded.push(proyecto);
  }

  const numeros = new Set<number>();
  for (const p of loaded) {
    if (numeros.has(p.numero)) problems.push(`numero ${p.numero} is used by more than one project`);
    numeros.add(p.numero);
  }

  if (problems.length) {
    throw new Error(`Invalid project content:\n  - ${problems.join("\n  - ")}`);
  }

  proyectos = loaded.sort((a, b) => a.numero - b.numero);
  console.info(`[Content] ${proyectos.length} proyectos loaded`);
  return proyectos;
}

export function listProyectos(): IProyectoResumen[] {
  return proyectos.map(({ slug, numero, titulo, resumen, fecha, tecnologias, enVivo }) => ({
    slug,
    numero,
    titulo,
    resumen,
    fecha,
    tecnologias,
    enVivo,
  }));
}

function vecino(p: IProyecto | undefined): IProyectoVecino | null {
  return p ? { slug: p.slug, numero: p.numero, titulo: p.titulo } : null;
}

export function findProyecto(slug: string): {
  proyecto: IProyecto;
  anterior: IProyectoVecino | null;
  siguiente: IProyectoVecino | null;
} | null {
  const idx = proyectos.findIndex((p) => p.slug === slug);
  if (idx < 0) return null;

  return {
    proyecto: proyectos[idx],
    anterior: vecino(proyectos[idx - 1]),
    siguiente: vecino(proyectos[idx + 1]),
  };
}

export function proyectoExists(slug: string): boolean {
  return proyectos.some((p) => p.slug === slug);
}
