export const CATEGORIAS = ["videos", "descargas", "imagenes", "modelos"] as const;
export type Categoria = (typeof CATEGORIAS)[number];

const MB = 1024 * 1024;

interface ITipoPermitido {
  categoria: Categoria;
  extension: string;
}

/** Content types the file manager accepts, and where each one goes */
export const TIPOS_PERMITIDOS: Record<string, ITipoPermitido> = {
  "video/mp4": { categoria: "videos", extension: "mp4" },
  "video/webm": { categoria: "videos", extension: "webm" },
  "video/quicktime": { categoria: "videos", extension: "mov" },
  "application/zip": { categoria: "descargas", extension: "zip" },
  "application/x-zip-compressed": { categoria: "descargas", extension: "zip" },
  "image/jpeg": { categoria: "imagenes", extension: "jpg" },
  "image/png": { categoria: "imagenes", extension: "png" },
  "image/webp": { categoria: "imagenes", extension: "webp" },
  "model/gltf-binary": { categoria: "modelos", extension: "glb" },
};

export const TAMANO_MAXIMO: Record<Categoria, number> = {
  videos: 1024 * MB,
  descargas: 200 * MB,
  imagenes: 20 * MB,
  modelos: 100 * MB,
};

/** How long a signed upload URL stays valid */
export const SUBIDA_TTL_MS = 15 * 60 * 1000;

/** Everything the manager touches lives under this prefix */
export const PREFIJO_PROYECTOS = "proyectos";
