/**
 * Places of a note -> coordinates for the map, using a local copy of Hermosillo's
 * streets and colonies from OpenStreetMap (npm run pulso:mapa-base) so names are
 * matched loosely ("Bulevar Kino" finds "Bulevard Eusebio Kino") and crossings are
 * computed locally (two streets cross where they share a node).
 *
 * Each place of the event tries, most precise first: crossing -> known building or
 * landmark (pulsoLugaresConocidos by name/alias; new ones are looked up in Nominatim and
 * kept) -> other reference (Nominatim, cached) -> colony. A street alone isn't placed (a
 * pin somewhere along a whole boulevard would mislead). Security notes about people are
 * blurred to ~500 m.
 */
import { ObjectId } from "mongodb";
import { Database } from "../../../middlewares/database/mongodb";
import { ILugarNota } from "../../../@types/collections/pulso/nota";
import { CategoriaLugar, ILugarConocido } from "../../../@types/collections/pulso/mapa";
import { LUGARES_BASE } from "./lugares.base";

/** Hermosillo bounding box (west, south, east, north) */
export const BBOX = { oeste: -111.15, sur: 28.95, este: -110.8, norte: 29.25 };
const GENERICAS = new Set(["bulevar", "boulevard", "bulevard", "blvd", "bvd", "calle", "avenida", "av", "ave", "carretera", "privada", "cerrada", "periferico", "calzada", "callejon", "prolongacion", "circuito", "andador", "c"]);
const VACIAS = new Set(["de", "del", "la", "las", "el", "los", "y", "e"]);
/** Crimes against people: never show the exact spot */
const SENSIBLES = new Set(["homicidios", "robos", "violencia_familiar_y_de_genero", "desaparecidos", "narcotrafico_y_crimen_organizado"]);
const CERCA_M = 60;

export function normalizar(t: string): string {
  return t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ") // "(Unison)", "[Fraccionamiento]"
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinctive words of a street/colony name ("Bulevar Juan Navarrete" -> ["juan", "navarrete"]) */
export function palabrasDe(nombre: string): string[] {
  return normalizar(nombre).split(" ").filter((p) => p.length >= 2 && !GENERICAS.has(p) && !VACIAS.has(p));
}

function metros(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const x = (b[0] - a[0]) * rad * Math.cos(((a[1] + b[1]) / 2) * rad);
  const y = (b[1] - a[1]) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}

/** Streets whose name has all the query's words; failing that, its last (most distinctive) word */
export async function buscarCalles(nombre: string, limite = 80) {
  const palabras = palabrasDe(nombre);
  if (!palabras.length) return [];
  const calles = Database.Pulso.Calles();
  let encontradas = await calles.find({ palabras: { $all: palabras } }).limit(limite).toArray();
  if (!encontradas.length && palabras.length > 1) {
    const ultima = [...palabras].sort((a, b) => b.length - a.length)[0];
    encontradas = await calles.find({ palabras: ultima }).limit(limite).toArray();
  }
  return encontradas;
}

/** Where two streets cross: a shared node, or their closest points if under 60 m apart */
export async function cruce(c1: string, c2: string): Promise<[number, number] | null> {
  const [a, b] = await Promise.all([buscarCalles(c1), buscarCalles(c2)]);
  if (!a.length || !b.length) return null;
  const nodosA = new Map<number, [number, number]>();
  for (const calle of a) calle.nodos.forEach((id, i) => nodosA.set(id, calle.coords[i]));
  for (const calle of b) for (const id of calle.nodos) if (nodosA.has(id)) return nodosA.get(id)!;

  let mejor: { d: number; p: [number, number] } | null = null;
  for (const ca of a) for (const pa of ca.coords) for (const cb of b) for (const pb of cb.coords) {
    const d = metros(pa, pb);
    if (d < CERCA_M && (!mejor || d < mejor.d)) mejor = { d, p: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2] };
  }
  return mejor?.p ?? null;
}

export async function colonia(nombre: string): Promise<{ nombre: string; punto: [number, number] } | null> {
  const normal = normalizar(nombre).replace(/^(colonia|col|fraccionamiento|fracc|residencial)\s+/, "");
  if (!normal) return null;
  const colonias = Database.Pulso.Colonias();
  const c =
    (await colonias.findOne({ normal })) ??
    (await colonias.findOne({ normal: { $regex: `(^| )${normal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)` } }));
  return c ? { nombre: c.nombre, punto: c.punto.coordinates } : null;
}

/** The colony closest to a point (within 800 m), to group notes by colony */
export async function coloniaCercana(p: [number, number]): Promise<string | null> {
  const c = await Database.Pulso.Colonias().findOne({
    punto: { $near: { $geometry: { type: "Point", coordinates: p }, $maxDistance: 800 } },
  });
  return c?.nombre ?? null;
}

/* ------------------------------------------------------------------ Nominatim (landmarks), cached */

let ultimaConsulta = 0;
export async function nominatim(consulta: string): Promise<[number, number] | null> {
  const guardado = await Database.Pulso.Geocache().findOne({ consulta });
  if (guardado) return guardado.resultado ? [guardado.resultado.lon, guardado.resultado.lat] : null;

  // Usage policy: at most 1 request per second, identified
  const espera = 1100 - (Date.now() - ultimaConsulta);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaConsulta = Date.now();
  const params = new URLSearchParams({
    q: consulta, format: "jsonv2", limit: "1", countrycodes: "mx", bounded: "1",
    viewbox: `${BBOX.oeste},${BBOX.norte},${BBOX.este},${BBOX.sur}`,
  });
  let resultado: { lon: number; lat: number } | null = null;
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "User-Agent": "PulsoHermosillo/1.0 (portafolio de proyectos)" },
      signal: AbortSignal.timeout(20000),
    });
    const j = (res.ok ? await res.json() : []) as any[];
    if (j[0]) resultado = { lon: Number(j[0].lon), lat: Number(j[0].lat) };
  } catch {
    return null; // network problem: don't cache, try another time
  }
  await Database.Pulso.Geocache().updateOne({ consulta }, { $set: { consulta, resultado, fuente: "nominatim", en: new Date() } }, { upsert: true });
  return resultado ? [resultado.lon, resultado.lat] : null;
}

/* ------------------------------------------------------------------ known buildings and landmarks */

const dentro = ([lon, lat]: [number, number]) => lon >= BBOX.oeste && lon <= BBOX.este && lat >= BBOX.sur && lat <= BBOX.norte;
/** Words that alone don't name one place */
const GENERICOS = new Set(["hospital", "escuela", "plaza", "parque", "edificio", "oficinas", "palacio", "centro", "instalaciones", "sede", "clinica", "juzgado", "tribunal"]);

/** The ways a building's name can be written: "el Poder Judicial del Estado de Sonora" -> ["poder judicial del estado de sonora", "poder judicial del estado", "poder judicial"] */
export function variantesNombre(t: string | null | undefined): string[] {
  let n = normalizar(t ?? "").replace(/^(el|la|los|las) /, "");
  const salida = new Set<string>();
  for (;;) {
    if (n.length >= 3 && !GENERICOS.has(n)) salida.add(n);
    const corto = n.replace(/ (de|del|en) (la ciudad de |el estado de |estado de )?(hermosillo|sonora|estado)$/, "").replace(/ (hermosillo|sonora)$/, "");
    if (corto === n) break;
    n = corto;
  }
  return [...salida];
}

function categoriaDe(normal: string): CategoriaLugar {
  if (/hospital|clinica|imss|issste|cruz roja|centro de salud/.test(normal)) return "hospital";
  if (/escuela|primaria|secundaria|preparatoria|universidad|tecnologico|unison|cbtis|conalep|colegio|kinder|jardin de ninos/.test(normal)) return "escuela";
  if (/^plaza /.test(normal)) return "plaza";
  if (/parque/.test(normal)) return "parque";
  if (/palacio|congreso|tribunal|judicial|fiscalia|secretaria|ayuntamiento|gobierno|juzgado|comandancia|cereso|cabildo|instituto (sonorense|municipal|nacional)|delegacion/.test(normal)) return "sede_gobierno";
  return "otro";
}

export async function buscarConocido(textos: (string | null | undefined)[]): Promise<ILugarConocido | null> {
  const variantes = [...new Set(textos.flatMap(variantesNombre))];
  if (!variantes.length) return null;
  const encontrados = await Database.Pulso.LugaresConocidos().find({ $or: [{ normal: { $in: variantes } }, { alias: { $in: variantes } }] }).toArray();
  // The longest (most specific) name said wins: "Fiscalía General de la República" over "Fiscalía"
  for (const v of variantes.sort((a, b) => b.length - a.length)) {
    const e = encontrados.find((x) => x.normal === v || x.alias.includes(v));
    if (e) return e;
  }
  return null;
}

async function coloniaIdCercana(p: [number, number]): Promise<ObjectId | null> {
  const c = await Database.Pulso.Colonias().findOne({ punto: { $near: { $geometry: { type: "Point", coordinates: p }, $maxDistance: 800 } } }, { projection: { _id: 1 } });
  return (c?._id as ObjectId) ?? null;
}

/** A building the catalog doesn't have yet: looked up in Nominatim by each of its names, kept if it's in the city */
async function aprenderConocido(textos: (string | null | undefined)[]): Promise<ILugarConocido | null> {
  const nombres = [...new Set(textos.map((t) => (t ?? "").trim()).filter((t) => variantesNombre(t).length))];
  for (const nombre of nombres) {
    const p = await nominatim(`${nombre}, Hermosillo, Sonora`);
    if (!p || !dentro(p)) continue;
    const normal = variantesNombre(nombre)[0];
    const alias = [...new Set(nombres.flatMap(variantesNombre))];
    const r = await Database.Pulso.LugaresConocidos().findOneAndUpdate(
      { normal },
      {
        $setOnInsert: {
          nombre, normal, categoria: categoriaDe(normal), actorId: null, fuenteGeo: "nominatim", creadoPor: "ia", creadoEn: new Date(),
          sedes: [{ nombre, normal, geo: { type: "Point", coordinates: p }, coloniaId: await coloniaIdCercana(p), principal: true }],
        },
        $addToSet: { alias: { $each: alias } },
      },
      { upsert: true, returnDocument: "after" }
    );
    return r;
  }
  return null;
}

/** Which of its buildings: the one the note names, else the main one (less sure) */
function elegirSede(lugar: ILugarConocido, textos: (string | null | undefined)[]) {
  if (lugar.sedes.length === 1) return { sede: lugar.sedes[0], confianza: 0.75 };
  const dicho = textos.map((t) => normalizar(t ?? "")).join(" | ");
  const nombrada = lugar.sedes.find((s) => s.normal && dicho.includes(s.normal));
  if (nombrada) return { sede: nombrada, confianza: 0.75 };
  return { sede: lugar.sedes.find((s) => s.principal) ?? lugar.sedes[0], confianza: 0.6 };
}

/**
 * Builds / refreshes the catalog from the base list (npm run pulso:mapa -- --lugares). A sede
 * Nominatim can't find, or finds outside the city, is skipped and reported.
 */
export async function sembrarLugares(): Promise<{ guardados: number; faltan: string[] }> {
  const faltan: string[] = [];
  let guardados = 0;
  for (const base of LUGARES_BASE) {
    const sedes: ILugarConocido["sedes"] = [];
    for (const s of base.sedes) {
      const p = await nominatim(s.consulta);
      if (!p || !dentro(p)) {
        faltan.push(`${base.nombre} (${s.nombre})`);
        continue;
      }
      sedes.push({ nombre: s.nombre, normal: normalizar(s.nombre), geo: { type: "Point", coordinates: p }, coloniaId: await coloniaIdCercana(p), principal: !!s.principal });
    }
    if (!sedes.length) continue;
    if (!sedes.some((s) => s.principal)) sedes[0].principal = true;
    const normal = variantesNombre(base.nombre)[0];
    const alias = [...new Set([base.nombre, ...base.alias].flatMap(variantesNombre))];
    // Learned entries under one of these names are replaced by the curated one
    await Database.Pulso.LugaresConocidos().deleteMany({ creadoPor: "ia", $or: [{ normal: { $in: alias } }, { alias: { $in: alias } }] });
    await Database.Pulso.LugaresConocidos().updateOne(
      { normal },
      {
        $set: { nombre: base.nombre, alias, categoria: base.categoria, sedes, fuenteGeo: "nominatim", creadoPor: "base" },
        $setOnInsert: { normal, actorId: null, creadoEn: new Date() },
      },
      { upsert: true }
    );
    guardados++;
  }
  return { guardados, faltan };
}

/* ------------------------------------------------------------------ one place, all places */

const esHermosillo = (l: ILugarNota) => normalizar(l.municipio ?? "") === "hermosillo";
const SIN_PUNTO = ["municipio", "estado", "pais"];

export interface IUbicacion {
  p: [number, number];
  precision: string;
  geocodificador: string;
  confianza?: number;
  conocido?: ILugarConocido;
}

/** Coordinates and precision for one place of the event (or null) */
export async function ubicar(l: ILugarNota): Promise<IUbicacion | null> {
  if (l.rol !== "lugar_del_hecho" || !esHermosillo(l) || SIN_PUNTO.includes(l.tipo)) return null;
  if (l.calle1 && l.calle2) {
    const p = await cruce(l.calle1, l.calle2);
    if (p) return { p, precision: "cruce", geocodificador: "cruce_osm" };
  }
  // A building or landmark: by the names it goes by
  if ((l.tipo === "edificio" || l.tipo === "zona") && !(l.calle1 && l.calle2)) {
    const textos = [l.lugarReferencia, l.mencion];
    const conocido = (await buscarConocido(textos)) ?? (l.tipo === "edificio" || l.lugarReferencia ? await aprenderConocido(textos) : null);
    if (conocido) {
      const { sede, confianza } = elegirSede(conocido, textos);
      return { p: sede.geo.coordinates, precision: "lugar", geocodificador: "lugar_conocido", confianza, conocido };
    }
  }
  if (l.lugarReferencia && l.tipo !== "edificio") {
    const p = await nominatim(`${l.lugarReferencia}, Hermosillo, Sonora`);
    if (p) return { p, precision: "lugar", geocodificador: "nominatim" };
  }
  if (l.colonia) {
    const c = await colonia(l.colonia);
    if (c) return { p: c.punto, precision: "colonia", geocodificador: "colonia_osm" };
    const p = await nominatim(`${l.colonia}, Hermosillo, Sonora`);
    if (p) return { p, precision: "colonia", geocodificador: "nominatim" };
  }
  return null;
}

/** "colonia Villa Satélite" -> "Villa Satélite" (as said in the news, without the prefix) */
function nombreColonia(t: string): string {
  return t.replace(/^\s*(colonia|col\.?|fraccionamiento|fracc\.?|residencial)\s+/i, "").trim();
}

/** ~500 m grid: enough for the map, not enough to point at a home */
const difuminar = ([lon, lat]: [number, number]): [number, number] => [Math.round(lon * 200) / 200, Math.round(lat * 200) / 200];

/** How sure we are of a placed point, by how it was found */
const CONFIANZA_GEO: Record<string, number> = { cruce: 0.9, lugar: 0.75, colonia: 0.5, aproximada: 0.4 };

/**
 * The note's places with `geo`, `precision`, `coloniaMapa`/`coloniaId`, the geocoder and
 * its confidence where they could be placed. AGEB and sector need INEGI polygons: null for now.
 */
export async function ubicarLugares(
  lugares: ILugarNota[],
  clasificacion: { tema: string; subtema: string },
  actores: { nombre: string; institucion?: string | null; actorId?: ObjectId | null }[] = []
): Promise<ILugarNota[]> {
  const sensible = clasificacion.tema === "seguridad" && SENSIBLES.has(clasificacion.subtema);
  // The city is only context when the note says where exactly
  const hayPrecisa = lugares.some((l) => l.rol === "lugar_del_hecho" && !SIN_PUNTO.includes(l.tipo));
  const salida: ILugarNota[] = [];
  for (const original of lugares) {
    const l = hayPrecisa && original.rol === "lugar_del_hecho" && SIN_PUNTO.includes(original.tipo) ? { ...original, rol: "contexto" } : original;
    const u = await ubicar(l);
    if (!u) {
      salida.push({ ...l, coloniaId: null, ageb: null, sector: null, geocodificador: null, confianzaGeo: null, lugarConocidoId: null, esSedeInstitucional: false, actorId: null });
      continue;
    }
    const actorId = u.conocido ? await actorDelLugar(u.conocido, l, actores) : null;
    const exacta = ["cruce", "lugar", "direccion"].includes(u.precision);
    const p = sensible && exacta ? difuminar(u.p) : u.p;
    const precision = sensible && exacta ? "aproximada" : u.precision;
    // The catalog's name; else the one the news gave (OSM lacks many colonies); else the nearest
    const coloniaMapa = (l.colonia && ((await colonia(l.colonia))?.nombre ?? nombreColonia(l.colonia))) || (await coloniaCercana(u.p));
    const enCatalogo = coloniaMapa ? await Database.Pulso.Colonias().findOne({ nombre: coloniaMapa }, { projection: { _id: 1 } }) : null;
    salida.push({
      ...l,
      geo: { type: "Point", coordinates: p },
      precision,
      coloniaMapa,
      coloniaId: (enCatalogo?._id as any) ?? null,
      ageb: null,
      sector: null,
      geocodificador: u.geocodificador,
      confianzaGeo: precision === "aproximada" ? CONFIANZA_GEO.aproximada : u.confianza ?? CONFIANZA_GEO[precision] ?? 0.5,
      lugarConocidoId: (u.conocido?._id as ObjectId) ?? null,
      esSedeInstitucional: u.conocido?.categoria === "sede_gobierno",
      actorId,
    });
  }
  return salida;
}

/** The note's actor that is this building's institution (and the catalog learns it) */
async function actorDelLugar(lugar: ILugarConocido, l: ILugarNota, actores: { nombre: string; institucion?: string | null; actorId?: ObjectId | null }[]) {
  const conActor = actores.filter((a) => a.actorId);
  if (lugar.actorId) {
    const mismo = conActor.find((a) => String(a.actorId) === String(lugar.actorId));
    if (mismo) return mismo.actorId!;
  }
  const nombres = new Set([lugar.normal, ...lugar.alias, ...variantesNombre(l.mencion), ...variantesNombre(l.lugarReferencia)]);
  const a = conActor.find((x) => [...variantesNombre(x.nombre), ...variantesNombre(x.institucion)].some((v) => nombres.has(v)));
  if (!a) return null;
  if (!lugar.actorId) await Database.Pulso.LugaresConocidos().updateOne({ _id: lugar._id, actorId: null }, { $set: { actorId: a.actorId! } });
  return a.actorId!;
}
