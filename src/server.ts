import "dotenv/config";
import http from "http";
import * as Enviroment from "./startup/enviroment.config";
import * as MongoDB from "./middlewares/database/mongodb";
import { createApp } from "./app";
import { loadProyectos } from "./routes/proyectos/proyectos.service";
import * as PulsoTrabajos from "./routes/pulso/analisis/trabajos.service";
import { iniciarJuego } from "./juego/servidor/socket";
import { registrarEstadoLocal } from "./juego/servidor/estado";

const port = process.env.PORT || 3000;
const uri = process.env.MONGO_DB as string;
const dbName = process.env.MONGO_DB_NAME || "portafolio";

Enviroment.checkEnviromentVariables();

const app = createApp();
const server = http.createServer(app);

startServer();

async function startServer() {
  try {
    loadProyectos();
  } catch (err: any) {
    console.error(err?.message ?? err);
    process.exit(1);
  }

  await MongoDB.createConnections(uri, dbName);
  await MongoDB.createIndexes();

  // Proyecto #3: the multiplayer game (Socket.IO on /juego, same server and port)
  // Its performance is read by GET /api/juego/status when JUEGO_STATUS_URL is not set
  registrarEstadoLocal(iniciarJuego(server).estado);

  server.listen(port, () => {
    console.info("listening on port: " + port);
  });

  // News analysis only runs as jobs started from the admin panel; resume one cut by a restart
  PulsoTrabajos.ejecutar().catch((err) => console.error("[pulso] trabajos:", err?.message ?? err));
}
