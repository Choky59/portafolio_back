/**
 * Ids from the catalogs for a freshly analyzed note:
 * - actors (pulsoActores): found by normalized name or alias; created by the AI when new.
 *   Minors are never put in the catalog.
 * - quotes: `atribuidaActorId` when the quote is attributed to one of the note's actors.
 * - tags (pulsoEtiquetas): an automatic vocabulary of normalized tags.
 * - source: the pulsoFuentes id.
 */
import { ObjectId } from "mongodb";
import { Database } from "../../../middlewares/database/mongodb";
import { ContenidoNota } from "./validar";

/** "Antonio 'Toño' Astiazarán Gutiérrez" -> "antonio tono astiazaran gutierrez" */
export function normalizarNombre(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The catalog id of an actor, creating it if it's new (never for minors) */
export async function resolverActor(a: { nombre: string; tipo: string; cargo: string | null; nivelGobierno: string | null; esMenor: boolean }): Promise<ObjectId | null> {
  if (a.esMenor) return null;
  const normal = normalizarNombre(a.nombre);
  if (!normal) return null;
  const actores = Database.Pulso.Actores();
  const existente = await actores.findOne({ $or: [{ normal }, { alias: normal }] });
  if (existente) return existente._id as ObjectId;
  const r = await actores.findOneAndUpdate(
    { normal },
    { $setOnInsert: { nombre: a.nombre, normal, alias: [normal], tipo: a.tipo, cargo: a.cargo, nivelGobierno: a.nivelGobierno, creadoPor: "ia", creadoEn: new Date() } },
    { upsert: true, returnDocument: "after" }
  );
  return (r?._id as ObjectId) ?? null;
}

/** Ids of the normalized tags, created as needed (with how many notes use them) */
export async function resolverEtiquetas(libres: string[]): Promise<ObjectId[]> {
  const ids: ObjectId[] = [];
  for (const nombre of libres) {
    const normal = normalizarNombre(nombre);
    if (!normal) continue;
    const r = await Database.Pulso.Etiquetas().findOneAndUpdate(
      { normal },
      { $setOnInsert: { normal, nombre, creadoEn: new Date() }, $inc: { usos: 1 } },
      { upsert: true, returnDocument: "after" }
    );
    if (r?._id && !ids.some((x) => x.equals(r._id as ObjectId))) ids.push(r._id as ObjectId);
  }
  return ids;
}

export async function resolverFuente(slug: string): Promise<ObjectId | null> {
  const f = await Database.Pulso.Fuentes().findOne({ slug }, { projection: { _id: 1 } });
  return (f?._id as ObjectId) ?? null;
}

/** The note's content with every catalog id filled in */
export async function conCatalogos(c: ContenidoNota): Promise<ContenidoNota> {
  const actores = [];
  for (const a of c.actores) actores.push({ ...a, actorId: await resolverActor(a) });
  const porNombre = new Map(actores.filter((a) => a.actorId).map((a) => [normalizarNombre(a.nombre), a.actorId]));
  const citas = c.citas.map((q) => ({
    ...q,
    atribuidaActorId: q.atribuidaA ? porNombre.get(normalizarNombre(q.atribuidaA)) ?? null : null,
  }));
  return {
    ...c,
    actores,
    citas,
    clasificacion: { ...c.clasificacion, etiquetas: await resolverEtiquetas(c.clasificacion.etiquetasLibres) },
  };
}
