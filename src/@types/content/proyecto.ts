/**
 * Project content:
 *   content/proyectos/<slug>.json                     the project
 *   content/proyectos/<slug>/videos/<video>.json      one file per video (optional folder)
 */

/** One block of a video's technical article */
export interface IBloqueArticulo {
  titulo: string;
  /** Paragraphs separated by a blank line */
  texto: string;
  puntos?: string[];
}

/**
 * A video of the project (Parte 1, Parte 2...). The source is an MP4 uploaded
 * to Storage (src) or YouTube (youtubeId); with neither it shows as "coming soon".
 */
export interface IVideoProyecto {
  slug: string;
  parte: number;
  titulo: string;
  resumen: string;
  /** e.g. "2:00" */
  duracion?: string;
  /** yyyy-mm-dd */
  fecha?: string;
  src?: string;
  youtubeId?: string;
  poster?: string;
  /** Reels are 9:16; false for 16:9 videos */
  vertical: boolean;
  temas: string[];
  articulo: IBloqueArticulo[];
}

export interface IEscena {
  titulo: string;
  /** MP4 URL on the storage/CDN */
  src: string;
  poster?: string;
}

export interface IModelo3D {
  /** .glb URL on the storage/CDN */
  src: string;
  poster?: string;
}

export interface IBloque {
  titulo: string;
  descripcion: string;
  imagen?: string;
}

export interface IMaterial {
  nombre: string;
  cantidad?: number;
  nota?: string;
  url?: string;
}

export interface ICodigo {
  titulo: string;
  lenguaje: string;
  url?: string;
  contenido?: string;
}

export interface IDescarga {
  titulo: string;
  url: string;
  tipo?: string;
}

export interface IProyecto {
  slug: string;
  numero: number;
  titulo: string;
  resumen: string;
  /** yyyy-mm-dd */
  fecha: string;
  tecnologias: string[];
  enVivo: boolean;

  /** Loaded from content/proyectos/<slug>/videos/, sorted by parte */
  videos: IVideoProyecto[];
  escenas: IEscena[];
  modelo3d: IModelo3D | null;

  problema: string;
  solucion: string;
  resultado: string;
  comoFunciona: IBloque[];
  materiales: IMaterial[];
  pasos: IBloque[];
  codigo: ICodigo[];
  descargas: IDescarga[];
  retos: IBloque[];
}

export type IProyectoResumen = Pick<
  IProyecto,
  "slug" | "numero" | "titulo" | "resumen" | "fecha" | "tecnologias" | "enVivo"
>;

export interface IProyectoVecino {
  slug: string;
  numero: number;
  titulo: string;
}
