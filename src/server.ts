import "dotenv/config";
import http from "http";
import * as Enviroment from "./startup/enviroment.config";
import * as MongoDB from "./middlewares/database/mongodb";
import { createApp } from "./app";
import { loadProyectos } from "./routes/proyectos/proyectos.service";

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

  server.listen(port, () => {
    console.info("listening on port: " + port);
  });
}
