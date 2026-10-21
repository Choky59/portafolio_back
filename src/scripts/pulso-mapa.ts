/**
 * FILE: pulso-mapa.ts
 *
 * Map of El pulso de Hermosillo:
 *   1. Downloads Hermosillo's named streets and colonies from OpenStreetMap (Overpass)
 *      into pulsoCalles / pulsoColonias. Only when they're empty, or with --base.
 *   2. Builds the catalog of known buildings and landmarks (pulsoLugaresConocidos) from
 *      lugares.base.ts. Only when it's empty, or with --lugares.
 *   3. Places the analyzed notes' places on the map (geo + colony). Only notes not
 *      placed yet, or all with --todas. New notes are placed when they're analyzed.
 *
 *   npm run pulso:mapa                 base if missing + place pending notes
 *   npm run pulso:mapa -- --base       download the streets and colonies again
 *   npm run pulso:mapa -- --lugares    rebuild the known places from the base list
 *   npm run pulso:mapa -- --todas      place every note again
 *
 * Reads: MONGO_DB, MONGO_DB_NAME. Map data © OpenStreetMap contributors (ODbL).
 */
import "dotenv/config";
import * as MongoDB from "../middlewares/database/mongodb";
import { Database } from "../middlewares/database/mongodb";
import { ICalle, IColonia } from "../@types/collections/pulso/mapa";
import { BBOX, normalizar, palabrasDe, sembrarLugares, ubicarLugares } from "../routes/pulso/mapa/geo.service";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const caja = `${BBOX.sur},${BBOX.oeste},${BBOX.norte},${BBOX.este}`;

async function overpass(q: string): Promise<any[]> {
  for (let intento = 0; intento < 4; intento++) {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": "PulsoHermosillo/1.0 (portafolio)" },
      body: new URLSearchParams({ data: q }),
      signal: AbortSignal.timeout(300000),
    }).catch((e) => ({ ok: false, status: 0, statusText: String(e) }) as any);
    if (res.ok) return (await res.json()).elements;
    console.warn(`Overpass ${res.status}, reintentando…`);
    await new Promise((r) => setTimeout(r, 15000 * (intento + 1)));
  }
  throw new Error("Overpass no respondió");
}

async function descargarBase() {
  console.info("Descargando calles de Hermosillo (OpenStreetMap)…");
  const elementos = await overpass(`[out:json][timeout:240];way["highway"]["name"](${caja});out body;>;out skel qt;`);
  const nodos = new Map<number, [number, number]>();
  for (const e of elementos) if (e.type === "node") nodos.set(e.id, [e.lon, e.lat]);
  const calles: ICalle[] = elementos
    .filter((e) => e.type === "way" && e.tags?.name)
    .map((w) => ({
      osmId: w.id,
      nombre: w.tags.name,
      normal: normalizar(w.tags.name),
      palabras: palabrasDe(w.tags.name),
      nodos: w.nodes.filter((id: number) => nodos.has(id)),
      coords: w.nodes.filter((id: number) => nodos.has(id)).map((id: number) => nodos.get(id)!),
    }))
    .filter((c) => c.palabras.length && c.nodos.length);

  console.info("Descargando colonias y fraccionamientos…");
  const lugares = await overpass(
    `[out:json][timeout:180];(node["place"~"suburb|neighbourhood|quarter"](${caja});way["place"~"suburb|neighbourhood|quarter"](${caja});way["landuse"="residential"]["name"](${caja}););out center tags;`
  );
  const vistas = new Set<string>();
  const colonias: IColonia[] = [];
  for (const e of lugares) {
    const nombre = e.tags?.name;
    const lon = e.lon ?? e.center?.lon;
    const lat = e.lat ?? e.center?.lat;
    if (!nombre || lon === undefined) continue;
    const normal = normalizar(nombre).replace(/^(colonia|col|fraccionamiento|fracc|residencial)\s+/, "");
    if (vistas.has(normal)) continue;
    vistas.add(normal);
    colonias.push({ nombre, normal, punto: { type: "Point", coordinates: [lon, lat] } });
  }

  await Database.Pulso.Calles().deleteMany({});
  await Database.Pulso.Colonias().deleteMany({});
  if (calles.length) await Database.Pulso.Calles().insertMany(calles);
  if (colonias.length) await Database.Pulso.Colonias().insertMany(colonias);
  console.info(`${calles.length} tramos de calle y ${colonias.length} colonias guardadas`);
}

async function ubicarNotas(todas: boolean) {
  const filtro = todas ? {} : { "lugares.rol": "lugar_del_hecho", "lugares.geo": { $exists: false } };
  const notas = await Database.Pulso.Notas().find(filtro, { projection: { lugares: 1, clasificacion: 1, actores: 1 } }).toArray();
  // Why a place of the event can't go on the map (only places in Hermosillo with a street, building or colony can)
  const motivos = { ubicados: 0, otraCiudad: 0, soloCiudad: 0, sinCoincidencia: 0 };
  for (const n of notas) {
    // Back to what the model said (a city marked as context goes back to being a place of the event)
    const dichos = n.lugares.map(({ geo, precision, coloniaMapa, ...l }) => ({ ...l, rol: l.rol === "contexto" ? "lugar_del_hecho" : l.rol }));
    const lugares = await ubicarLugares(dichos, n.clasificacion, n.actores ?? []);
    for (const l of lugares.filter((x) => x.rol === "lugar_del_hecho")) {
      if (l.geo) motivos.ubicados++;
      else if (normalizar(l.municipio ?? "") !== "hermosillo") motivos.otraCiudad++;
      else if (["municipio", "estado", "pais"].includes(l.tipo) || !(l.calle1 || l.colonia || l.lugarReferencia)) motivos.soloCiudad++;
      else motivos.sinCoincidencia++;
    }
    await Database.Pulso.Notas().updateOne({ _id: n._id }, { $set: { lugares } });
  }
  const enMapa = await Database.Pulso.Notas().aggregate<{ n: number }>([
    { $unwind: "$lugares" }, { $match: { "lugares.geo": { $exists: true } } }, { $count: "n" },
  ]).toArray();
  console.info(`${notas.length} notas revisadas${todas ? "" : " (solo las que aún no tenían lugares en el mapa)"}:`);
  console.info(`  ${motivos.ubicados} lugares nuevos ubicados`);
  console.info(`  ${motivos.otraCiudad} fuera de Hermosillo, ${motivos.soloCiudad} sin un punto concreto ("Hermosillo", "Sonora"),`);
  console.info(`  ${motivos.sinCoincidencia} sin coincidencia en el mapa (p. ej. un cruce que OpenStreetMap no tiene)`);
  console.info(`En total hay ${enMapa[0]?.n ?? 0} lugares en el mapa.`);
}

async function main() {
  if (!process.env.MONGO_DB) throw new Error("MONGO_DB is missing");
  await MongoDB.createConnections(process.env.MONGO_DB, process.env.MONGO_DB_NAME || "portafolio");
  await MongoDB.createIndexes();
  const args = process.argv.slice(2);
  if (args.includes("--base") || !(await Database.Pulso.Calles().estimatedDocumentCount())) await descargarBase();
  if (args.includes("--lugares") || !(await Database.Pulso.LugaresConocidos().countDocuments({ creadoPor: "base" }))) {
    console.info("Armando el catálogo de lugares conocidos (OpenStreetMap)…");
    const { guardados, faltan } = await sembrarLugares();
    console.info(`  ${guardados} lugares guardados${faltan.length ? `; no se encontraron: ${faltan.join(", ")}` : ""}`);
  }
  await ubicarNotas(args.includes("--todas"));
  await MongoDB.closeConnections();
}

main().catch(async (err) => {
  console.error(err?.message ?? err);
  await MongoDB.closeConnections();
  process.exit(1);
});
