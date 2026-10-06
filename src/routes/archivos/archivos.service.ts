// routes/archivos/archivos.service.ts
import { randomUUID } from "crypto";
import { PREFIJO_PROYECTOS, SUBIDA_TTL_MS, TAMANO_MAXIMO, TIPOS_PERMITIDOS } from "../../constants/archivos";
import { getBucket, urlPublica } from "../../middlewares/storage/firebaseStorage";
import { construirPath, parsePath } from "./archivos.helpers.misc";
import { IArchivo, ISolicitudSubida, ISubidaAutorizada } from "./archivos.types";

function aArchivo(meta: any): IArchivo | null {
  const partes = parsePath(meta?.name);
  if (!partes) return null;

  const token = meta.metadata?.firebaseStorageDownloadTokens?.split(",")[0];
  return {
    path: meta.name,
    nombre: meta.metadata?.nombreOriginal || partes.archivo,
    slug: partes.slug,
    categoria: partes.categoria,
    contentType: meta.contentType ?? "application/octet-stream",
    tamano: Number(meta.size ?? 0),
    subidoEn: meta.timeCreated,
    url: token ? urlPublica(meta.name, token) : null,
  };
}

/**
 * Signed V4 URL so the browser uploads straight to Storage (no Heroku 30 s limit).
 * Content-Type and the size range are part of the signature: the upload fails
 * if the browser sends anything else.
 */
export async function autorizarSubida(solicitud: ISolicitudSubida): Promise<ISubidaAutorizada> {
  const objectPath = construirPath(solicitud.slug, solicitud.contentType, solicitud.nombre);
  const maximo = TAMANO_MAXIMO[TIPOS_PERMITIDOS[solicitud.contentType].categoria];
  const expiresAt = new Date(Date.now() + SUBIDA_TTL_MS);
  const headers = {
    "Content-Type": solicitud.contentType,
    "x-goog-content-length-range": `0,${maximo}`,
  };

  const [uploadUrl] = await getBucket()
    .file(objectPath)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType: solicitud.contentType,
      extensionHeaders: { "x-goog-content-length-range": headers["x-goog-content-length-range"] },
    });

  return { path: objectPath, uploadUrl, headers, expiresAt };
}

/**
 * After the browser's PUT: gives the object a Firebase download token (its public URL)
 * and remembers the original file name. Returns null if nothing was uploaded.
 */
export async function confirmarSubida(objectPath: string, nombreOriginal?: string): Promise<IArchivo | null> {
  const file = getBucket().file(objectPath);
  const [existe] = await file.exists();
  if (!existe) return null;

  const [meta] = await file.getMetadata();
  const token = (meta.metadata?.firebaseStorageDownloadTokens as string | undefined) || randomUUID();

  const [actualizado] = await file.setMetadata({
    metadata: {
      firebaseStorageDownloadTokens: token,
      ...(nombreOriginal ? { nombreOriginal } : {}),
    },
  });

  return aArchivo(actualizado);
}

export async function listarArchivos(slug: string): Promise<IArchivo[]> {
  const [files] = await getBucket().getFiles({ prefix: `${PREFIJO_PROYECTOS}/${slug}/` });
  return files
    .map((f) => aArchivo(f.metadata))
    .filter((a): a is IArchivo => a !== null)
    .sort((a, b) => b.subidoEn.localeCompare(a.subidoEn));
}

export async function borrarArchivo(objectPath: string): Promise<boolean> {
  const file = getBucket().file(objectPath);
  const [existe] = await file.exists();
  if (!existe) return false;
  await file.delete();
  return true;
}
