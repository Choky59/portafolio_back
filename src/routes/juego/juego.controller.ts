import { Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";
import { estadoLocal, type ColectorEstado } from "../../juego/servidor/estado";

/**
 * Asks the game server: with JUEGO_STATUS_URL, the one on the VM (GET /admin/metricas…, with
 * JUEGO_ADMIN_TOKEN); without it, the one running in this same process. `local` reads the same
 * thing from the in-process collector (null: not found).
 */
async function preguntar(res: Response, ruta: string, local: (c: ColectorEstado) => Promise<object | null>): Promise<Response> {
  const url = process.env.JUEGO_STATUS_URL?.replace(/\/+$/, "");

  if (!url) {
    const colector = estadoLocal();
    if (!colector) {
      return sendErrorResponse(res, 503, { key: "GAME_SERVER_OFF", message: "The game server is not running in this process" });
    }
    const datos = await local(colector);
    if (!datos) return sendErrorResponse(res, 404, { key: "MATCH_NOT_FOUND", message: "That match is no longer in memory" });
    return res.status(200).send({ origen: "local", ...datos });
  }

  try {
    const r = await fetch(`${url}/admin/metricas${ruta}`, {
      headers: { "x-juego-admin": process.env.JUEGO_ADMIN_TOKEN ?? "" },
      signal: AbortSignal.timeout(4000),
    });
    if (r.status === 404 && ruta) {
      return sendErrorResponse(res, 404, { key: "MATCH_NOT_FOUND", message: "That match is no longer in memory (or the key was rejected)" });
    }
    if (!r.ok) {
      return sendErrorResponse(res, 502, {
        key: "GAME_SERVER_ERROR",
        message: r.status === 404 ? "The game server rejected the key (check JUEGO_ADMIN_TOKEN on both sides)" : `The game server answered ${r.status}`,
      });
    }
    return res.status(200).send({ origen: "remoto", ...((await r.json()) as object) });
  } catch (err: any) {
    return sendErrorResponse(res, 502, {
      key: "GAME_SERVER_UNREACHABLE",
      message: `Could not reach the game server: ${err?.name === "TimeoutError" ? "timeout" : err?.message ?? err}`,
    });
  }
}

/**
 * GET /juego/status  (ADMIN)
 * The game server and every match (live and recent), with each real player's diagnosis.
 */
export function getStatus(_req: Request, res: Response): Promise<Response> {
  return preguntar(res, "", (c) => c.resumen());
}

/**
 * GET /juego/status/partidas/:id  (ADMIN)
 * One match in detail: every real player's timeline (client report + what the server sees).
 */
export function getPartida(req: Request, res: Response): Promise<Response> {
  const id = String(req.params.id ?? "");
  if (!/^[\w-]{1,64}$/.test(id)) return Promise.resolve(sendErrorResponse(res, 400, { key: "INVALID_ID", message: "Invalid match id" }));
  return preguntar(res, `/partidas/${id}`, (c) => c.partida(id));
}
