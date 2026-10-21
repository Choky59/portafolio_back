/**
 * Hermosillo's institutional buildings and landmarks that the news names most, with the
 * names they're called by. Each sede's point comes from OpenStreetMap (Nominatim) with
 * `consulta` when the catalog is built (npm run pulso:mapa -- --lugares), checked to be
 * inside the city. Aliases matter most where a plain search lands on the wrong building
 * ("Poder Judicial" finds the federal one; "Fiscalía", the federal FGR).
 */
import { CategoriaLugar } from "../../../@types/collections/pulso/mapa";

export interface ILugarBase {
  nombre: string;
  alias: string[];
  categoria: CategoriaLugar;
  sedes: { nombre: string; consulta: string; principal?: boolean }[];
}

export const LUGARES_BASE: ILugarBase[] = [
  {
    nombre: "Poder Judicial del Estado de Sonora",
    alias: ["Poder Judicial", "Poder Judicial del Estado", "Supremo Tribunal de Justicia", "Supremo Tribunal de Justicia del Estado de Sonora", "STJ", "Tribunal Superior de Justicia"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Supremo Tribunal de Justicia", consulta: "Supremo Tribunal de Justicia del Estado, Hermosillo", principal: true }],
  },
  {
    nombre: "Poder Judicial de la Federación",
    alias: ["Poder Judicial Federal", "Juzgado Federal", "Juzgados Federales"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Poder Judicial de la Federación", consulta: "Poder Judicial de la Federación, Hermosillo", principal: true }],
  },
  {
    nombre: "Palacio de Gobierno del Estado de Sonora",
    alias: ["Palacio de Gobierno", "Gobierno del Estado"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Palacio de Gobierno", consulta: "Palacio de Gobierno, Hermosillo", principal: true }],
  },
  {
    nombre: "Palacio Municipal de Hermosillo",
    alias: ["Palacio Municipal", "Ayuntamiento de Hermosillo", "Ayuntamiento", "Presidencia Municipal"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Palacio Municipal", consulta: "Palacio Municipal, Hermosillo", principal: true }],
  },
  {
    nombre: "Congreso del Estado de Sonora",
    alias: ["Congreso del Estado", "Congreso de Sonora", "Congreso local", "Congreso"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Congreso del Estado", consulta: "Congreso del Estado de Sonora, Hermosillo", principal: true }],
  },
  {
    nombre: "Fiscalía General de Justicia del Estado de Sonora",
    alias: ["Fiscalía General de Justicia del Estado", "Fiscalía del Estado", "Fiscalía de Sonora", "Fiscalía", "FGJE", "FGJES"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Fiscalía General de Justicia del Estado", consulta: "Fiscalía General de Justicia del Estado de Sonora, Hermosillo", principal: true }],
  },
  {
    nombre: "Fiscalía General de la República",
    alias: ["FGR", "Fiscalía General de la República en Sonora", "PGR"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Fiscalía General de la República", consulta: "Fiscalia General de la Republica, Hermosillo", principal: true }],
  },
  {
    nombre: "Centro de Gobierno",
    alias: ["Centro de Gobierno del Estado"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Centro de Gobierno", consulta: "Centro de Gobierno, Hermosillo", principal: true }],
  },
  {
    nombre: "Centro de Readaptación Social de Hermosillo",
    alias: ["CERESO", "CERESO Hermosillo", "CERESO 1", "Centro de Readaptación Social"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "CERESO", consulta: "Centro de Readaptación Social, Hermosillo", principal: true }],
  },
  {
    nombre: "Hospital Infantil del Estado de Sonora",
    alias: ["Hospital Infantil", "HIES"],
    categoria: "hospital",
    sedes: [{ nombre: "Hospital Infantil del Estado de Sonora", consulta: "Hospital Infantil del Estado de Sonora, Hermosillo", principal: true }],
  },
  {
    nombre: "Hospital General de Especialidades",
    alias: ["Hospital General de Especialidades del Estado de Sonora", "HGE"],
    categoria: "hospital",
    sedes: [{ nombre: "Hospital General de Especialidades", consulta: "Hospital General de Especialidades, Hermosillo", principal: true }],
  },
  {
    nombre: "Cruz Roja Mexicana Hermosillo",
    alias: ["Cruz Roja", "Cruz Roja Mexicana", "Cruz Roja Hermosillo"],
    categoria: "hospital",
    sedes: [
      { nombre: "Delegación Hermosillo", consulta: "Cruz Roja Mexicana Delegación Hermosillo", principal: true },
      { nombre: "Delegación Estatal", consulta: "Cruz Roja Mexicana Delegación Estatal Sonora, Hermosillo" },
    ],
  },
  {
    nombre: "Universidad de Sonora",
    alias: ["Unison", "UNISON", "Universidad de Sonora campus Hermosillo"],
    categoria: "escuela",
    sedes: [{ nombre: "Campus Hermosillo", consulta: "Universidad de Sonora, Hermosillo", principal: true }],
  },
  {
    nombre: "Instituto Tecnológico de Hermosillo",
    alias: ["Tec de Hermosillo", "ITH", "Tecnológico de Hermosillo"],
    categoria: "escuela",
    sedes: [{ nombre: "Instituto Tecnológico de Hermosillo", consulta: "Instituto Tecnológico de Hermosillo", principal: true }],
  },
  {
    nombre: "Plaza Zaragoza",
    alias: ["Plaza Zaragoza de Hermosillo"],
    categoria: "plaza",
    sedes: [{ nombre: "Plaza Zaragoza", consulta: "Plaza Zaragoza, Hermosillo", principal: true }],
  },
  {
    nombre: "Plaza Bicentenario",
    alias: ["Plaza del Bicentenario"],
    categoria: "plaza",
    sedes: [{ nombre: "Plaza Bicentenario", consulta: "Plaza Bicentenario, Hermosillo", principal: true }],
  },
  {
    nombre: "Catedral Metropolitana de Hermosillo",
    alias: ["Catedral", "Catedral de Hermosillo", "Catedral Metropolitana", "Plaza Catedral"],
    categoria: "otro",
    sedes: [{ nombre: "Catedral", consulta: "Catedral Metropolitana de Nuestra Señora de la Asunción, Hermosillo", principal: true }],
  },
  {
    nombre: "Parque Madero",
    alias: ["Parque Francisco I. Madero"],
    categoria: "parque",
    sedes: [{ nombre: "Parque Madero", consulta: "Parque Madero, Hermosillo", principal: true }],
  },
  {
    nombre: "Cerro de la Campana",
    alias: [],
    categoria: "otro",
    sedes: [{ nombre: "Cerro de la Campana", consulta: "Cerro de la Campana, Hermosillo", principal: true }],
  },
  {
    nombre: "Aeropuerto Internacional de Hermosillo",
    alias: ["Aeropuerto de Hermosillo", "Aeropuerto Internacional General Ignacio Pesqueira García", "Aeropuerto"],
    categoria: "otro",
    sedes: [{ nombre: "Aeropuerto", consulta: "Aeropuerto Internacional de Hermosillo", principal: true }],
  },
  {
    nombre: "Central de Autobuses de Hermosillo",
    alias: ["Central de Autobuses", "Central camionera"],
    categoria: "otro",
    sedes: [{ nombre: "Central de Autobuses", consulta: "Central de Autobuses, Hermosillo", principal: true }],
  },
  {
    nombre: "Agua de Hermosillo",
    alias: ["Oficinas de Agua de Hermosillo"],
    categoria: "sede_gobierno",
    sedes: [{ nombre: "Agua de Hermosillo", consulta: "Agua de Hermosillo", principal: true }],
  },
  {
    nombre: "Estadio Héctor Espino",
    alias: ["Héctor Espino"],
    categoria: "otro",
    sedes: [{ nombre: "Estadio Héctor Espino", consulta: "Estadio Héctor Espino, Hermosillo", principal: true }],
  },
];
