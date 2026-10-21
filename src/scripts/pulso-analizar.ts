/**
 * FILE: pulso-analizar.ts
 *
 * Starts an analysis job from the command line (the same as the admin panel's
 * "Análisis" tab) and waits for it. Shows the estimate first; nothing already
 * analyzed is analyzed again.
 *
 *   npm run pulso:analizar -- --desde 2026-10-14 --hasta 2026-10-20 --presupuesto 1
 *   npm run pulso:analizar -- --desde 2026-10-20 --fuente telemax --solo-estimar
 *
 * Reads: MONGO_DB, MONGO_DB_NAME, GEMINI_API_KEY, PULSO_MODELO, PULSO_TOKENS_DIA
 */
import "dotenv/config";
import * as MongoDB from "../middlewares/database/mongodb";
import { Database } from "../middlewares/database/mongodb";
import * as Trabajos from "../routes/pulso/analisis/trabajos.service";

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!process.env.MONGO_DB) throw new Error("MONGO_DB is missing");
  await MongoDB.createConnections(process.env.MONGO_DB, process.env.MONGO_DB_NAME || "portafolio");
  await MongoDB.createIndexes();

  const rango = { desde: arg("desde") ?? null, hasta: arg("hasta") ?? null, fuentes: arg("fuente") ? [arg("fuente")!] : [] };
  const { resumen } = await Trabajos.pendientes(rango);
  console.info(`Pendientes: ${resumen.pendientes} capturas (~${resumen.notasEstimadas} notas), ~USD ${resumen.usdEstimado}. Ya analizadas: ${resumen.yaAnalizadas}.`);
  if (process.argv.includes("--solo-estimar") || !resumen.pendientes) return MongoDB.closeConnections();

  const presupuesto = Number(arg("presupuesto"));
  if (!(presupuesto > 0)) throw new Error("--presupuesto USD is required (e.g. --presupuesto 1)");
  const t = await Trabajos.crear({ ...rango, presupuestoUSD: presupuesto }, "cli");
  console.info(`Trabajo ${t?._id} en marcha…`);
  await Trabajos.ejecutar();
  const fin = await Database.Pulso.Trabajos().findOne({ _id: t!._id });
  console.info(`${fin?.estado} (${fin?.motivo}): ${fin?.progreso.hechas} capturas, ${fin?.progreso.notas} notas, USD ${fin?.progreso.costoUSD.toFixed(3)}`);
  await MongoDB.closeConnections();
}

main().catch(async (err) => {
  console.error(err?.message ?? err);
  await MongoDB.closeConnections();
  process.exit(1);
});
