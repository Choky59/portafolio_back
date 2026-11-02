import "dotenv/config";
import http from "http";
import { iniciarJuego } from "./servidor/socket";

/**
 * Only the game server (Socket.IO on /juego), without the API or MongoDB: what runs on the VM
 * close to the players (deploy/juego). The full backend (src/server.ts) keeps running it too, so
 * the fronts can use either one (VITE_JUEGO_URL).
 *
 * Reads: PORT (default 3000), CORS_ORIGIN, and the JUEGO_* variables (see .env.example).
 */
const port = Number(process.env.PORT) || 3000;

// GET /salud answers 200: for the deploy to check that it's up
const server = http.createServer((req, res) => {
  if (req.url === "/salud") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
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
