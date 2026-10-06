/**
 * FILE: mongodb.contenido.indexes.ts
 *
 * MongoDB index definitions for project content stored in the DB
 * (video ↔ Storage file assignments). SAFE to run multiple times.
 */

import { Database } from "./mongodb";

export async function indexesContenido(): Promise<void> {
  /** One file per project video */
  await Database.Contenido.VideoAsignaciones().createIndex(
    { proyecto: 1, video: 1 },
    { name: "videoAsignaciones_proyecto_video_unique", unique: true }
  );

  /** Lookup when a file is deleted from the manager */
  await Database.Contenido.VideoAsignaciones().createIndex(
    { path: 1 },
    { name: "videoAsignaciones_path" }
  );

  console.log("[DB] Contenido indexes ensured");
}
