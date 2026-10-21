import { Request, Response } from "express";
import { sendSuccessResponse } from "../../constants/successResponse";
import { sendErrorResponse } from "../../constants/errorResponse";
import * as PulsoService from "./pulso.service";
import * as Trabajos from "./analisis/trabajos.service";
import { proveedorDelEntorno } from "./analisis/proveedor";

const texto = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** yyyy-mm-dd in Hermosillo (UTC-7) to the start / end of that day */
const dia = (v: unknown, fin = false) => (typeof v === "string" && v ? new Date(`${v.slice(0, 10)}T${fin ? "23:59:59.999" : "00:00:00"}-07:00`) : undefined);

/** GET /pulso/resumen  (public) */
export async function getResumen(_req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, await PulsoService.resumen());
}

/** GET /pulso/notas?tema&subtema&emocion&fuente&ambito&tipo&actor&q&desde&hasta&pagina&porPagina  (public) */
export async function getNotas(req: Request, res: Response): Promise<Response> {
  const q = req.query;
  const filtros: PulsoService.IFiltros = {
    tema: texto(q.tema),
    subtema: texto(q.subtema),
    emocion: texto(q.emocion),
    fuente: texto(q.fuente),
    ambito: texto(q.ambito),
    tipo: texto(q.tipo),
    actor: texto(q.actor),
    q: texto(q.q),
    desde: dia(q.desde),
    hasta: dia(q.hasta, true),
  };
  const pagina = Number(q.pagina) || 1;
  const porPagina = Number(q.porPagina) || 20;
  return sendSuccessResponse(res, 200, await PulsoService.listarNotas(filtros, pagina, porPagina));
}

/** GET /pulso/notas/:id  (public) */
export async function getNota(req: Request, res: Response): Promise<Response> {
  const nota = await PulsoService.obtenerNota(String(req.params.id));
  if (!nota) return sendErrorResponse(res, 404, { key: "NOTA_NOT_FOUND", message: "No such note" });
  return sendSuccessResponse(res, 200, { nota });
}

/** GET /pulso/medios  (public) */
export async function getMedios(_req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, { medios: await PulsoService.medios() });
}

/** GET /pulso/actores?limite=30  (public) */
export async function getActores(req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, { actores: await PulsoService.actores(Number(req.query.limite) || 30) });
}

/** GET /pulso/fuentes  (public): sources that have notes, for the filters */
export async function getFuentes(_req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, { fuentes: await PulsoService.fuentes() });
}

/* ------------------------------------------------------------------ map and crowd (public) */

function filtrosDe(q: Request["query"]): PulsoService.IFiltros {
  return {
    tema: texto(q.tema), subtema: texto(q.subtema), emocion: texto(q.emocion), fuente: texto(q.fuente),
    ambito: texto(q.ambito), tipo: texto(q.tipo), actor: texto(q.actor), q: texto(q.q),
    desde: dia(q.desde), hasta: dia(q.hasta, true),
  };
}

/** GET /pulso/mapa?filtros  (public): GeoJSON of the places of the news */
export async function getMapa(req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, await PulsoService.mapa(filtrosDe(req.query)));
}

/** GET /pulso/mapa/colonias?filtros  (public): notes and feeling per colony */
export async function getMapaColonias(req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, { colonias: await PulsoService.mapaColonias(filtrosDe(req.query)) });
}

/** GET /pulso/multitud?limite=40  (public): latest notes in the crowd visualization's shape */
export async function getMultitud(req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, { noticias: await PulsoService.multitud(Number(req.query.limite) || 40) });
}

/* ------------------------------------------------------------------ analysis jobs (ADMIN) */

function rangoDe(q: Request["query"]): Trabajos.IRango {
  const fuentes = typeof q.fuentes === "string" && q.fuentes ? q.fuentes.split(",").filter(Boolean) : [];
  return { desde: texto(q.desde) ?? null, hasta: texto(q.hasta) ?? null, fuentes };
}

/** GET /pulso/admin/pendientes?desde&hasta&fuentes=a,b */
export async function getPendientes(req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, await Trabajos.pendientes(rangoDe(req.query)));
}

/** GET /pulso/admin/borrado?desde&hasta&fuentes=a,b : what a deletion would remove */
export async function getBorrado(req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, await Trabajos.previewBorrado(rangoDe(req.query)));
}

/** POST /pulso/admin/borrado { desde, hasta, fuentes, confirmacion: "BORRAR" } */
export async function postBorrado(req: Request, res: Response): Promise<Response> {
  const b = req.body ?? {};
  const r = await Trabajos.borrar({ desde: b.desde ?? null, hasta: b.hasta ?? null, fuentes: b.fuentes ?? [] }, res.locals.user?.username ?? "admin");
  if (!r) return sendErrorResponse(res, 409, { key: "TRABAJO_ACTIVO", message: "A job is running; cancel it or wait before deleting" });
  return sendSuccessResponse(res, 200, r);
}

/** POST /pulso/admin/trabajos { desde, hasta, fuentes, ids?, presupuestoUSD } */
export async function postTrabajo(req: Request, res: Response): Promise<Response> {
  // Without a model there's nothing to run the job with: say so instead of leaving it queued forever
  if (!proveedorDelEntorno()) {
    return sendErrorResponse(res, 503, { key: "ANALISIS_NOT_CONFIGURED", message: "GEMINI_API_KEY is not set on the server" });
  }
  const b = req.body ?? {};
  const trabajo = await Trabajos.crear(
    { desde: b.desde ?? null, hasta: b.hasta ?? null, fuentes: b.fuentes ?? [], ids: b.ids, presupuestoUSD: Number(b.presupuestoUSD), buscarWeb: b.buscarWeb !== false },
    res.locals.user?.username ?? "admin"
  );
  if (!trabajo) {
    return sendErrorResponse(res, 409, { key: "NADA_QUE_ANALIZAR", message: "No pending captures in that range (already analyzed or in another job)" });
  }
  // Runs in the background; the panel follows its progress
  Trabajos.ejecutar().catch((err) => console.error("[pulso] trabajos:", err?.message ?? err));
  const { capturas, ...resto } = trabajo;
  return sendSuccessResponse(res, 201, { trabajo: { ...resto, totalCapturas: capturas.length } });
}

/** GET /pulso/admin/trabajos */
export async function getTrabajos(_req: Request, res: Response): Promise<Response> {
  return sendSuccessResponse(res, 200, await Trabajos.listar());
}

/** POST /pulso/admin/trabajos/:id/cancelar */
export async function postCancelar(req: Request, res: Response): Promise<Response> {
  const ok = await Trabajos.cancelar(String(req.params.id));
  if (!ok) return sendErrorResponse(res, 404, { key: "TRABAJO_NOT_FOUND", message: "No active job with that id" });
  return sendSuccessResponse(res, 200, { cancelado: true });
}
