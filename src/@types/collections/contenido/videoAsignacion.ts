import { ObjectId } from "mongodb";

/**
 * Which uploaded Storage file plays in which project video (Parte 1, Parte 2...).
 * Set from the admin file manager, so changing a video doesn't need a deploy.
 */
export interface IVideoAsignacion {
  _id?: ObjectId;
  /** Project slug */
  proyecto: string;
  /** Video slug (file name in content/proyectos/<proyecto>/videos/) */
  video: string;
  /** Object path in the bucket: proyectos/<proyecto>/videos/<archivo> */
  path: string;
  /** Public download URL (Firebase token), resolved when assigned */
  url: string;
  actualizadoEn: Date;
}
