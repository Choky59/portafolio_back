import { ObjectId } from "mongodb";

/** A named street of Hermosillo from OpenStreetMap (pulsoCalles), one per OSM way */
export interface ICalle {
  _id?: ObjectId;
  osmId: number;
  nombre: string;
  /** Normalized name without accents or generic words ("Bulevard Eusebio Kino" -> "eusebio kino") */
  normal: string;
  /** Distinctive words of the name, for lookup */
  palabras: string[];
  /** OSM node ids and their [lon, lat], in order (two streets cross where they share a node) */
  nodos: number[];
  coords: [number, number][];
}

/** A colony (neighbourhood) of Hermosillo from OpenStreetMap (pulsoColonias) */
export interface IColonia {
  _id?: ObjectId;
  nombre: string;
  normal: string;
  punto: { type: "Point"; coordinates: [number, number] };
}

export type CategoriaLugar = "sede_gobierno" | "hospital" | "escuela" | "plaza" | "parque" | "otro";

/**
 * pulsoLugaresConocidos: buildings and landmarks by name and aliases ("Poder Judicial" ->
 * Supremo Tribunal de Justicia), so a note naming them lands on the right spot. Some come
 * from the base list (npm run pulso:mapa -- --lugares), the rest are learned from notes.
 */
export interface ILugarConocido {
  _id?: ObjectId;
  nombre: string;
  /** Normalized name and aliases (no accents, lowercase) */
  normal: string;
  alias: string[];
  categoria: CategoriaLugar;
  /** The institution it houses, when it's in the actors catalog */
  actorId: ObjectId | null;
  sedes: { nombre: string; normal: string; geo: { type: "Point"; coordinates: [number, number] }; coloniaId: ObjectId | null; principal: boolean }[];
  fuenteGeo: "nominatim" | "manual";
  creadoPor: "base" | "ia" | "admin";
  creadoEn: Date;
}

/** Geocoding results already looked up (also misses, so they aren't asked again) */
export interface IGeocache {
  _id?: ObjectId;
  consulta: string;
  resultado: { lon: number; lat: number } | null;
  fuente: string;
  en: Date;
}
