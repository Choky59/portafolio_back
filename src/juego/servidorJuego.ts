import "dotenv/config";
import http from "http";
import { iniciarJuego } from "./servidor/socket";
import { claveAdminValida } from "./servidor/estado";

/**
 * Only the game server (Socket.IO on /juego), without the API or MongoDB: what runs on the VM
 * close to the players (deploy/juego). The full backend (src/server.ts) keeps running it too, so
 * the fronts can use either one (VITE_JUEGO_URL).
 *
 * Reads: PORT (default 3000), CORS_ORIGIN, and the JUEGO_* variables (see .env.example).
 */
const port = Number(process.env.PORT) || 3000;

// GET /salud answers 200: for the deploy to check that it's up
const server = http.createServer(async (req, res) => {
  if (req.url === "/salud") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  // GET /admin/metricas (every match) and /admin/metricas/partidas/<id> (one, in detail): for the
  // admin page; only the portfolio's API knows the key (JUEGO_ADMIN_TOKEN). Without it: 404, as if
  // it didn't exist
  const ruta = req.url?.split("?")[0] ?? "";
  if (req.method === "GET" && ruta.startsWith("/admin/metricas") && claveAdminValida(req.headers["x-juego-admin"])) {
    const id = ruta.match(/^\/admin\/metricas\/partidas\/([\w-]{1,64})$/)?.[1];
    const datos = ruta === "/admin/metricas" ? await juego.estado.resumen() : id ? await juego.estado.partida(id) : null;
    res.writeHead(datos ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(datos ? JSON.stringify(datos) : "");
    return;
  }
  res.writeHead(404);
  res.end();
});

const juego = iniciarJuego(server);

server.listen(port, () => {
  console.info(`[juego] listening on port ${port}`);
});

// The deploy stops the container with SIGTERM: close the rooms and the sockets cleanly
function cerrar() {
  juego.cerrar();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", cerrar);
process.on("SIGINT", cerrar);
