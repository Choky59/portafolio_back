import { Request, Response } from "express";
import { sendErrorResponse } from "../../constants/errorResponse";
import { estadoLocal } from "../../juego/servidor/estado";

/**
 * GET /juego/status  (ADMIN)
 * The game server's performance (rooms, tick cost, ping, CPU, memory) live and for the last hour.
 * With JUEGO_STATUS_URL it asks the game server on the VM (with JUEGO_ADMIN_TOKEN); without it,
 * the one that runs in this same process.
 */
export async function getStatus(_req: Request, res: Response): Promise<Response> {
  const url = process.env.JUEGO_STATUS_URL?.replace(/\/+$/, "");

  if (!url) {
    const local = estadoLocal();
    if (!local) {
      return sendErrorResponse(res, 503, { key: "GAME_SERVER_OFF", message: "The game server is not running in this process" });
    }
    return res.status(200).send({ origen: "local", ...local.resumen() });
  }

  try {
    const r = await fetch(`${url}/admin/metricas`, {
      headers: { "x-juego-admin": process.env.JUEGO_ADMIN_TOKEN ?? "" },
      signal: AbortSignal.timeout(4000),
    });
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
