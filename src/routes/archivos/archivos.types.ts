import { Categoria } from "../../constants/archivos";

export interface IArchivo {
  /** Object path in the bucket: proyectos/<slug>/<categoria>/<archivo> */
  path: string;
  nombre: string;
  slug: string;
  categoria: Categoria;
  contentType: string;
  tamano: number;
  subidoEn: string;
  /** Public download URL; null until the upload is confirmed */
  url: string | null;
  /** Slug of the project video this file plays in, if assigned */
  asignadoA: string | null;
}

export interface ISolicitudSubida {
  slug: string;
  nombre: string;
  contentType: string;
  tamano: number;
}

export interface ISubidaAutorizada {
  path: string;
  uploadUrl: string;
  /** Headers the browser must send with the PUT (they are part of the signature) */
  headers: Record<string, string>;
  expiresAt: Date;
}
