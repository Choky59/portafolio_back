// routes/proyectos/proyectos.service.ts
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import {
  IProyecto,
  IProyectoResumen,
  IProyectoVecino,
  IVideoProyecto,
} from "../../@types/content/proyecto";
import { validateProyecto, validateVideo } from "./proyectos.helpers.misc";
import { Database } from "../../middlewares/database/mongodb";

/** Same path from src/ (ts-jest) and build/ (node): <root>/content/proyectos */
const DEFAULT_DIR = path.resolve(__dirname, "../../../content/proyectos");

let proyectos: IProyecto[] = [];

function readJson(filePath: string, label: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err: any) {
    problems.push(`${label}: invalid JSON (${err?.message ?? err})`);
    return undefined;
  }
}

/** content/proyectos/<slug>/videos/*.json, validated and sorted by parte */
function loadVideos(dir: string, slug: string, problems: string[]): IVideoProyecto[] {
  const videosDir = path.join(dir, slug, "videos");
  if (!existsSync(videosDir)) return [];

  const videos: IVideoProyecto[] = [];
  for (const file of readdirSync(videosDir).filter((f) => f.endsWith(".json"))) {
    const label = `${slug}/videos/${file}`;
    const raw = readJson(path.join(videosDir, file), label, problems);
    if (raw === undefined) continue;

    const { video, errors } = validateVideo(raw, path.basename(file, ".json"));
    if (!video) {
      problems.push(...errors.map((e) => `${label}: ${e}`));
      continue;
    }
    videos.push(video);
  }

  const partes = new Set<number>();
  for (const v of videos) {
    if (partes.has(v.parte)) problems.push(`${slug}/videos: parte ${v.parte} is used by more than one video`);
    partes.add(v.parte);
  }

  return videos.sort((a, b) => a.parte - b.parte);
}

/**
 * Reads and validates every content/proyectos/*.json (and their videos/ folders) once, at boot.
 * Throws with every problem found so a bad JSON never reaches production silently.
 */
export function loadProyectos(dir = process.env.PROYECTOS_DIR || DEFAULT_DIR): IProyecto[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const loaded: IProyecto[] = [];
  const problems: string[] = [];

  for (const file of files) {
    const slug = path.basename(file, ".json");
    const raw = readJson(path.join(dir, file), file, problems);
    if (raw === undefined) continue;

    const { proyecto, errors } = validateProyecto(raw, slug);
    if (!proyecto) {
      problems.push(...errors.map((e) => `${file}: ${e}`));
      continue;
    }
    proyecto.videos = loadVideos(dir, slug, problems);
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

/**
 * Copy of the project where each video plays the Storage file assigned to it
 * from the admin panel (videoAsignaciones). An assignment wins over the JSON's
 * src/youtubeId; videos without one keep what the JSON says.
 * Never mutates the content loaded at boot.
 */
export async function conVideosAsignados(proyecto: IProyecto): Promise<IProyecto> {
  if (!proyecto.videos.length) return proyecto;

  const asignaciones = await Database.Contenido.VideoAsignaciones()
    .find({ proyecto: proyecto.slug })
    .toArray();
  if (!asignaciones.length) return proyecto;

  const urlPorVideo = new Map(asignaciones.map((a) => [a.video, a.url]));
  return {
    ...proyecto,
    videos: proyecto.videos.map((v) => {
      const url = urlPorVideo.get(v.slug);
      if (!url) return v;
      const { youtubeId, ...resto } = v;
      return { ...resto, src: url };
    }),
  };
}

export function proyectoExists(slug: string): boolean {
  return proyectos.some((p) => p.slug === slug);
}
