/**
 * FILE: mongodb.pulso.indexes.ts
 *
 * MongoDB index definitions for "El pulso de Hermosillo".
 * SAFE to run multiple times. The scraper creates the same capture indexes
 * (same names are not required: createIndex is a no-op for an equivalent index).
 */

import { Database } from "./mongodb";

export async function indexesPulso(): Promise<void> {
  const capturas = Database.Pulso.Capturas();
  await capturas.createIndex({ clave: 1 }, { unique: true });
  await capturas.createIndex({ estado: 1, tipo: 1 });

  const notas = Database.Pulso.Notas();
  // One note per block of a capture: re-analyzing replaces it instead of duplicating
  await notas.createIndex({ capturaId: 1, bloque: 1 }, { name: "pulsoNotas_bloque_unique", unique: true });
  await notas.createIndex({ publicadoEn: -1 }, { name: "pulsoNotas_publicadoEn" });
  await notas.createIndex({ "clasificacion.tema": 1, "clasificacion.subtema": 1, publicadoEn: -1 }, { name: "pulsoNotas_tema" });
  await notas.createIndex({ fuente: 1, publicadoEn: -1 }, { name: "pulsoNotas_fuente" });
  await notas.createIndex({ "sentimiento.emocionDominante": 1, publicadoEn: -1 }, { name: "pulsoNotas_emocion" });
  await notas.createIndex({ "analisis.version": 1 }, { name: "pulsoNotas_version" });
  // Map queries (geo is filled by geocoding; notes without it are skipped by the sparse 2dsphere)
  await notas.createIndex({ "lugares.geo": "2dsphere" }, { name: "pulsoNotas_geo", sparse: true });
  await notas.createIndex({ "evento.eventoId": 1 }, { name: "pulsoNotas_evento" });
  await notas.createIndex({ "tiempoLocal.semanaISO": 1 }, { name: "pulsoNotas_semana" });
  await notas.createIndex({ "tiempoLocal.mes": 1 }, { name: "pulsoNotas_mes" });
  await notas.createIndex({ "lugares.coloniaId": 1 }, { name: "pulsoNotas_colonia" });
  await notas.createIndex({ "actores.actorId": 1 }, { name: "pulsoNotas_actor" });
  await notas.createIndex({ fuenteId: 1 }, { name: "pulsoNotas_fuenteId" });
  await notas.createIndex({ "fechas.ocurrio": 1 }, { name: "pulsoNotas_ocurrio" });

  await Database.Pulso.Eventos().createIndex({ ocurrio: 1 }, { name: "pulsoEventos_ocurrio" });
  await Database.Pulso.Eventos().createIndex({ actualizadoEn: -1 }, { name: "pulsoEventos_actualizado" });
  await Database.Pulso.Eventos().createIndex({ pendienteConsolidar: 1 }, { name: "pulsoEventos_pendiente" });
  await Database.Pulso.Eventos().createIndex({ geo: "2dsphere" }, { name: "pulsoEventos_geo", sparse: true });
  await Database.Pulso.Actores().createIndex({ normal: 1 }, { name: "pulsoActores_normal" });
  await Database.Pulso.Actores().createIndex({ alias: 1 }, { name: "pulsoActores_alias" });
  await Database.Pulso.Etiquetas().createIndex({ normal: 1 }, { name: "pulsoEtiquetas_normal", unique: true });

  await Database.Pulso.Consumo().createIndex({ fecha: 1, modelo: 1 }, { name: "pulsoConsumo_dia", unique: true });
  await Database.Pulso.Trabajos().createIndex({ creadoEn: -1 }, { name: "pulsoTrabajos_creadoEn" });
  await Database.Pulso.Trabajos().createIndex({ estado: 1 }, { name: "pulsoTrabajos_estado" });
  await capturas.createIndex({ publicadoEn: -1 }, { name: "pulsoCapturas_publicadoEn" });

  // Map base: street lookup by its words, colonies by normalized name
  await Database.Pulso.Calles().createIndex({ palabras: 1 }, { name: "pulsoCalles_palabras" });
  await Database.Pulso.Colonias().createIndex({ normal: 1 }, { name: "pulsoColonias_normal" });
  await Database.Pulso.Colonias().createIndex({ punto: "2dsphere" }, { name: "pulsoColonias_punto" });
  await Database.Pulso.Geocache().createIndex({ consulta: 1 }, { name: "pulsoGeocache_consulta", unique: true });
  await Database.Pulso.LugaresConocidos().createIndex({ normal: 1 }, { name: "pulsoLugaresConocidos_normal", unique: true });
  await Database.Pulso.LugaresConocidos().createIndex({ alias: 1 }, { name: "pulsoLugaresConocidos_alias" });
  await Database.Pulso.Notas().createIndex({ "lugares.lugarConocidoId": 1 }, { name: "pulsoNotas_lugarConocido", sparse: true });
  console.log("[DB] Pulso indexes ensured");
}
