/**
 * The model's answer (snake_case, mostly trusted thanks to the response schema) turned
 * into a stored note (camelCase), checked once more: values clamped to their range,
 * categories checked against the catalog, the five emotions normalized to sum 1 (each
 * one > 0 keeps its explanation), the outlet removed from the actors, only the detail
 * section of the note's subtopic kept, and each quote's segment turned into its second.
 *
 * Catalog ids (actors, tags, colonies, source) are filled afterwards (catalogos.service.ts).
 */
import { INota } from "../../../@types/collections/pulso/nota";
import {
  AMBITOS, DETALLE_POR_SUBTEMA, EFECTOS, EMOCIONES, Emocion, FRANJAS, NIVELES_GOBIERNO, ROLES_ACTOR,
  ROLES_HABLANTE, TEMAS, TIPOS_ACTOR, TIPOS_LUGAR, TIPOS_NOTA, TONOS_MEDIO,
} from "../../../constants/pulso";
import { ISegmentoNumerado } from "./segmentos";

export type ContenidoNota = Omit<
  INota,
  "_id" | "capturaId" | "clave" | "fuente" | "fuenteId" | "bloque" | "clase" | "url" | "enlace" | "publicadoEn" | "tiempo"
  | "tiempoLocal" | "analisis" | "creadoEn" | "evento" | "seguimientoDe" | "relaciones"
>;

const rango = (v: unknown, min: number, max: number, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const tonoONulo = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : rango(v, -1, 1));
const de = <T extends string>(valores: readonly T[], v: unknown, def: T): T => ((valores as readonly string[]).includes(v as string) ? (v as T) : def);
const deONulo = (valores: readonly string[], v: unknown) => ((valores as readonly string[]).includes(v as string) ? (v as string) : null);
const textoONulo = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const enteroONulo = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
const numeroONulo = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const siNoONulo = (v: unknown) => (typeof v === "boolean" ? v : null);
const lista = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const sinAcentos = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** The outlet itself showing up as an actor ("Telemax" in a Telemax note); short names need an exact match */
function esElMedio(nombre: string, medio: string): boolean {
  if (nombre === medio) return true;
  return nombre.length >= 5 && (medio.includes(nombre) || nombre.includes(medio));
}

/**
 * The five emotions as { valor, explicacion } summing 1. If the model gave nothing
 * usable they're split evenly (and flagged by a null explanation).
 */
export function normalizarEmociones(crudas: any): Record<Emocion, { valor: number; explicacion: string | null }> {
  const valores = Object.fromEntries(EMOCIONES.map((e) => [e, rango(crudas?.[e]?.valor ?? crudas?.[e], 0, 1)])) as Record<Emocion, number>;
  const suma = EMOCIONES.reduce((s, e) => s + valores[e], 0);
  const normal = (e: Emocion) => (suma > 0 ? Math.round((valores[e] / suma) * 1000) / 1000 : Math.round(1000 / EMOCIONES.length) / 1000);
  return Object.fromEntries(
    EMOCIONES.map((e) => {
      const valor = normal(e);
      return [e, { valor, explicacion: valor > 0 ? textoONulo(crudas?.[e]?.explicacion) : null }];
    })
  ) as Record<Emocion, { valor: number; explicacion: string | null }>;
}

/** The detail section of the note's subtopic, camelCase, with its kind; null if none */
export function validarDetalle(crudo: any, subtema: string): Record<string, unknown> | null {
  const tipo = DETALLE_POR_SUBTEMA[subtema];
  const s = tipo ? crudo?.[tipo] : null;
  if (!tipo || !s || typeof s !== "object") return null;
  switch (tipo) {
    case "accidente_vial":
      return {
        tipo,
        modalidad: textoONulo(s.modalidad),
        vehiculos: enteroONulo(s.vehiculos),
        heridos: enteroONulo(s.heridos),
        fallecidos: enteroONulo(s.fallecidos),
        gravedad: deONulo(["leve", "leve_moderada", "grave"], s.gravedad),
        involucraTransportePublico: siNoONulo(s.involucra_transporte_publico),
        involucraPeatonCiclista: siNoONulo(s.involucra_peaton_ciclista),
      };
    case "delito":
      return {
        tipo,
        modalidad: textoONulo(s.modalidad),
        victimas: enteroONulo(s.victimas),
        fallecidos: enteroONulo(s.fallecidos),
        detenidos: enteroONulo(s.detenidos),
        arma: textoONulo(s.arma),
        conViolencia: siNoONulo(s.con_violencia),
      };
    case "falla_servicio":
      return {
        tipo,
        servicio: deONulo(["agua", "energia"], s.servicio),
        falla: textoONulo(s.tipo),
        coloniasAfectadas: enteroONulo(s.colonias_afectadas),
        duracionHoras: numeroONulo(s.duracion_horas),
        causa: textoONulo(s.causa),
        programado: siNoONulo(s.programado),
      };
    case "transporte":
      return { tipo, ruta: textoONulo(s.ruta), incidente: textoONulo(s.incidente), afectados: enteroONulo(s.afectados) };
    case "clima":
      return { tipo, fenomeno: textoONulo(s.fenomeno), temperaturaMax: numeroONulo(s.temperatura_max), alerta: siNoONulo(s.alerta) };
    default:
      return null;
  }
}

export function validarNota(crudo: any, ctx: { medio: string; segmentos: ISegmentoNumerado[]; desde: number; hasta: number }): ContenidoNota {
  const c = crudo?.clasificacion ?? {};
  const [temaCrudo, subtemaCrudo] = String(c.tema_subtema ?? "").split("/");
  const tema = TEMAS[temaCrudo] ? temaCrudo : "otro";
  const subtema = TEMAS[tema].includes(subtemaCrudo) ? subtemaCrudo : TEMAS[tema][0];
  const s = crudo?.sentimiento ?? {};
  const emociones = normalizarEmociones(s.emociones);
  const dominante = EMOCIONES.reduce((a, b) => (emociones[b].valor > emociones[a].valor ? b : a));
  const medio = sinAcentos(ctx.medio);
  const f = crudo?.fechas ?? {};

  return {
    titulo: String(crudo?.titulo ?? "").trim() || "Sin título",
    resumenCorto: String(crudo?.resumen_corto ?? "").trim(),
    resumen: String(crudo?.resumen ?? "").trim(),
    puntosClave: lista(crudo?.puntos_clave).map(String).filter(Boolean).slice(0, 10),
    clasificacion: {
      tipo: de(TIPOS_NOTA, c.tipo, "otro"),
      ambito: de(AMBITOS, c.ambito, "local"),
      tema,
      subtema,
      temaSecundario: TEMAS[c.tema_secundario] && c.tema_secundario !== tema ? c.tema_secundario : null,
      etiquetas: [], // ids, filled by the tags catalog
      etiquetasLibres: [...new Set(lista(c.etiquetas).map((e) => String(e).toLowerCase().trim()).filter(Boolean))].slice(0, 12),
      esAlerta: c.es_alerta === true,
      relevancia: rango(c.relevancia, 0, 1, 0.5),
    },
    detalle: validarDetalle(crudo?.detalle, subtema),
    lugares: lista(crudo?.lugares).map((l) => ({
      mencion: String(l?.mencion ?? "").trim(),
      tipo: de(TIPOS_LUGAR, l?.tipo, "zona"),
      calle1: textoONulo(l?.calle_1),
      calle2: textoONulo(l?.calle_2),
      colonia: textoONulo(l?.colonia),
      lugarReferencia: textoONulo(l?.lugar_referencia),
      municipio: textoONulo(l?.municipio),
      rol: l?.rol === "lugar_del_hecho" ? "lugar_del_hecho" : "mencionado",
      correccionTranscripcion: l?.correccion_transcripcion === true,
    })).filter((l) => l.mencion),
    actores: lista(crudo?.actores)
      .filter((a) => a?.nombre && !esElMedio(sinAcentos(String(a.nombre)), medio))
      .map((a) => ({
        nombre: String(a.nombre).trim(),
        tipo: de(TIPOS_ACTOR, a.tipo, "otro"),
        cargo: textoONulo(a.cargo),
        institucion: textoONulo(a.institucion),
        nivelGobierno: (NIVELES_GOBIERNO as readonly string[]).includes(a.nivel_gobierno) ? a.nivel_gobierno : null,
        rol: de(ROLES_ACTOR, a.rol, "mencionado"),
        esMenor: a.es_menor === true,
        tonoHacia: tonoONulo(a.tono_hacia),
        actorId: null, // filled by the actors catalog
      })),
    afectados: lista(crudo?.afectados).filter((a) => a?.grupo).map((a) => ({
      grupo: String(a.grupo).trim(),
      cantidad: numeroONulo(a.cantidad),
      efecto: de(EFECTOS, a.efecto, "mixto"),
    })),
    cifras: lista(crudo?.cifras).filter((x) => Number.isFinite(Number(x?.valor))).map((x) => ({
      valor: Number(x.valor),
      unidad: String(x.unidad ?? "").trim(),
      queMide: String(x.que_mide ?? "").trim(),
    })),
    fechas: {
      ocurrio: /^\d{4}-\d{2}-\d{2}$/.test(f.ocurrio ?? "") ? f.ocurrio : null,
      ocurrioFranja: deONulo(FRANJAS, f.ocurrio_franja),
      ocurrioHora: Number.isInteger(f.ocurrio_hora) && f.ocurrio_hora >= 0 && f.ocurrio_hora <= 23 ? f.ocurrio_hora : null,
      proximosEventos: lista(f.proximos_eventos).filter((e) => e?.que).map((e) => ({
        desde: textoONulo(e.desde),
        hasta: textoONulo(e.hasta),
        que: String(e.que).trim(),
      })),
    },
    sentimiento: {
      emociones,
      emocionDominante: dominante,
      intensidad: rango(s.intensidad, 0, 1, 0.3),
      polaridad: rango(s.polaridad, -1, 1),
      tonoMedio: de(TONOS_MEDIO, s.tono_medio, "informativo"),
      posturaGobierno: {
        municipal: tonoONulo(s.postura_gobierno?.municipal),
        estatal: tonoONulo(s.postura_gobierno?.estatal),
        federal: tonoONulo(s.postura_gobierno?.federal),
      },
      polemica: rango(s.polemica, 0, 1),
      justificacion: String(s.justificacion ?? "").trim(),
    },
    // Only quotes inside this note's segments; their second comes from the transcript
    citas: lista(crudo?.citas)
      .filter((q) => q?.texto && Number.isInteger(q.segmento) && q.segmento >= ctx.desde && q.segmento <= ctx.hasta)
      .map((q) => ({
        texto: String(q.texto).trim(),
        quien: textoONulo(q.quien),
        rolHablante: de(ROLES_HABLANTE, q.rol_hablante, "otro"),
        atribuidaA: textoONulo(q.atribuida_a),
        atribuidaActorId: null, // filled by the actors catalog
        segmento: q.segmento,
        segundo: ctx.segmentos[q.segmento]?.inicio ?? null,
      })),
    confianza: rango(crudo?.confianza, 0, 1, 0.5),
  };
}
