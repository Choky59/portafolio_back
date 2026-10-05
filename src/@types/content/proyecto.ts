/**
 * Project content, read from content/proyectos/<slug>.json
 */

export interface IVideo {
  titulo: string;
  youtubeId: string;
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

  videos: IVideo[];
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
