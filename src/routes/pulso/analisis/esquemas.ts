/**
 * What we ask the model and the exact JSON it must answer (Gemini responseSchema:
 * an OpenAPI subset). Enums come from the catalog in constants/pulso.ts, so the model
 * can't invent categories. Field names are snake_case here (what the model sees);
 * validar.ts maps them to the camelCase stored in pulsoNotas.
 *
 * Versioned: change PROMPT_VERSION (and ANALISIS_VERSION if the fields change) when
 * these instructions change.
 */
import {
  AMBITOS, CLASES_BLOQUE, EFECTOS, EMOCIONES, FRANJAS, NIVELES_GOBIERNO, PARES_TEMA, RELACIONES,
  ROLES_ACTOR, ROLES_HABLANTE, TEMAS, TIPOS_ACTOR, TIPOS_LUGAR, TIPOS_NOTA, TONOS_MEDIO,
} from "../../../constants/pulso";
import { GLOSARIO } from "./glosario";

const texto = { type: "string" };
const numero = { type: "number" };
const entero = { type: "integer" };
const textoONulo = { type: "string", nullable: true };
const numeroONulo = { type: "number", nullable: true };
const enteroONulo = { type: "integer", nullable: true };
const siNoONulo = { type: "boolean", nullable: true };
const tono = { type: "number", nullable: true, description: "-1 crítico, 0 neutral, 1 favorable; null si no aplica" };
const lista = (items: object) => ({ type: "array", items });
const opciones = (valores: readonly string[], extra: object = {}) => ({ type: "string", enum: [...valores], ...extra });
const objeto = (properties: Record<string, object>, required: string[] = Object.keys(properties), extra: object = {}) => ({
  type: "object", properties, required, ...extra,
});
const cifra = objeto({ valor: numero, unidad: texto, que_mide: texto });

export const ESQUEMA_SEGMENTAR = objeto({
  bloques: lista(objeto({
    segmento_inicio: entero,
    segmento_fin: entero,
    clase: opciones(CLASES_BLOQUE),
    titulo_provisional: texto,
  })),
});

/** One section per kind of detail; the model fills only the one of the note's subtopic */
const DETALLE = objeto(
  {
    accidente_vial: objeto({
      modalidad: opciones(["choque_alcance", "choque_lateral", "choque_frontal", "volcadura", "atropello", "derrape", "multiple", "otro"], { nullable: true }),
      vehiculos: enteroONulo,
      heridos: enteroONulo,
      fallecidos: enteroONulo,
      gravedad: opciones(["leve", "leve_moderada", "grave"], { nullable: true }),
      involucra_transporte_publico: siNoONulo,
      involucra_peaton_ciclista: siNoONulo,
    }, [], { nullable: true }),
    delito: objeto({
      modalidad: opciones(["homicidio", "robo_vivienda", "robo_vehiculo", "robo_comercio", "robo_transeunte", "asalto", "otro"], { nullable: true }),
      victimas: enteroONulo,
      fallecidos: enteroONulo,
      detenidos: enteroONulo,
      arma: opciones(["fuego", "blanca", "ninguna", "otra"], { nullable: true }),
      con_violencia: siNoONulo,
    }, [], { nullable: true }),
    falla_servicio: objeto({
      servicio: opciones(["agua", "energia"], { nullable: true }),
      tipo: opciones(["corte", "baja_presion", "tandeo", "apagon", "variacion", "fuga", "otro"], { nullable: true }),
      colonias_afectadas: enteroONulo,
      duracion_horas: numeroONulo,
      causa: textoONulo,
      programado: siNoONulo,
    }, [], { nullable: true }),
    transporte: objeto({
      ruta: textoONulo,
      incidente: opciones(["incendio", "choque", "falla", "retraso", "cambio_ruta", "tarifa", "clima_unidad", "otro"], { nullable: true }),
      afectados: enteroONulo,
    }, [], { nullable: true }),
    clima: objeto({
      fenomeno: opciones(["calor", "lluvia", "viento", "frio", "tormenta", "otro"], { nullable: true }),
      temperatura_max: numeroONulo,
      alerta: siNoONulo,
    }, [], { nullable: true }),
  },
  [],
  { nullable: true }
);

export const ESQUEMA_NOTA = objeto({
  titulo: texto,
  resumen_corto: texto,
  resumen: texto,
  puntos_clave: lista(texto),
  clasificacion: objeto({
    tipo: opciones(TIPOS_NOTA),
    ambito: opciones(AMBITOS),
    tema_subtema: opciones(PARES_TEMA, { description: "tema/subtema del catálogo" }),
    tema_secundario: opciones(Object.keys(TEMAS), { nullable: true }),
    etiquetas: lista(texto),
    es_alerta: { type: "boolean" },
    relevancia: numero,
  }, ["tipo", "ambito", "tema_subtema", "etiquetas", "es_alerta", "relevancia"]),
  detalle: DETALLE,
  lugares: lista(objeto({
    mencion: texto,
    tipo: opciones(TIPOS_LUGAR),
    calle_1: textoONulo,
    calle_2: textoONulo,
    colonia: textoONulo,
    lugar_referencia: textoONulo,
    municipio: textoONulo,
    rol: opciones(["lugar_del_hecho", "mencionado"]),
    correccion_transcripcion: { type: "boolean" },
  }, ["mencion", "tipo", "rol", "correccion_transcripcion"])),
  actores: lista(objeto({
    nombre: texto,
    tipo: opciones(TIPOS_ACTOR),
    cargo: textoONulo,
    institucion: textoONulo,
    nivel_gobierno: opciones(NIVELES_GOBIERNO, { nullable: true }),
    rol: opciones(ROLES_ACTOR),
    es_menor: { type: "boolean" },
    tono_hacia: tono,
  }, ["nombre", "tipo", "rol", "es_menor"])),
  afectados: lista(objeto({ grupo: texto, cantidad: numeroONulo, efecto: opciones(EFECTOS) }, ["grupo", "efecto"])),
  cifras: lista(cifra),
  fechas: objeto({
    ocurrio: { type: "string", nullable: true, description: "yyyy-mm-dd si se sabe" },
    ocurrio_franja: opciones(FRANJAS, { nullable: true }),
    ocurrio_hora: { type: "integer", nullable: true, description: "0 a 23 si la nota la dice" },
    proximos_eventos: lista(objeto({ desde: textoONulo, hasta: textoONulo, que: texto }, ["que"])),
  }, ["proximos_eventos"]),
  sentimiento: objeto({
    emociones: objeto(Object.fromEntries(EMOCIONES.map((e) => [e, objeto({ valor: numero, explicacion: textoONulo }, ["valor"])]))),
    intensidad: numero,
    polaridad: numero,
    tono_medio: opciones(TONOS_MEDIO),
    postura_gobierno: objeto({ municipal: tono, estatal: tono, federal: tono }, []),
    polemica: numero,
    justificacion: texto,
  }),
  citas: lista(objeto({
    texto,
    quien: textoONulo,
    rol_hablante: opciones(ROLES_HABLANTE),
    atribuida_a: textoONulo,
    segmento: entero,
  }, ["texto", "rol_hablante", "segmento"])),
  confianza: numero,
});

/* ---------------------------------- the same event across outlets ---------------------------------- */

export const ESQUEMA_RELACION = objeto({
  relaciones: lista(objeto({
    nota_id: texto,
    relacion: opciones(RELACIONES),
    confianza: numero,
    justificacion: texto,
    discrepancias: lista(texto),
  })),
});

export const ESQUEMA_CONSOLIDAR = objeto({
  titulo: texto,
  resumen: texto,
  cifras: lista(cifra),
  discrepancias: lista(texto),
});

export const ESQUEMA_FUSION = objeto({
  decisiones: lista(objeto({ evento_id: texto, mismo_evento: { type: "boolean" }, confianza: numero, justificacion: texto })),
});

/* ---------------------------------- instructions ---------------------------------- */

const RUBRICA = `Rúbrica (escalas fijas):
- relevancia: 0.1 = afecta a pocas personas, sin consecuencias; 0.4 = incidente local con lesionados o molestia para una
  zona; 0.7 = afecta a una parte grande de la ciudad o tiene víctimas fatales; 1.0 = afecta a toda la ciudad o es una emergencia.
- intensidad: 0.1 = el público apenas reaccionaría; 0.5 = la gente lo comentaría ese día; 0.9 = conmoción generalizada.
- polemica: 0 = sin desacuerdo; 0.5 = hay posturas encontradas; 1.0 = fuerte división pública o política.`;

export function instruccionesSegmentar(medio: string): string {
  return `Eres editor de noticias de Hermosillo, Sonora. Recibes la transcripción de un programa
(${medio}), dividida en segmentos numerados [n] con su tiempo. Divide TODO el programa en bloques contiguos y sin huecos:
cada bloque es una sola noticia o tema (clase nota/entrevista/opinion/debate) o algo que no es noticia
(publicidad, musica, saludos, otro). Usa "titulares" para los resúmenes o repasos de varias noticias seguidas
(los conductores repiten los titulares varias veces; no son una noticia). Un cambio de tema = un bloque nuevo.
Si una entrevista toca varios temas distintos, divídela por tema. segmento_inicio y segmento_fin son números de
segmento (inclusivos).

Glosario (para reconocer nombres mal transcritos):
${GLOSARIO}`;
}

export function instruccionesNota(medio: string, fecha: string): string {
  return `Eres analista de noticias de Hermosillo, Sonora. Analiza UNA noticia publicada por ${medio}
(fecha de publicación ${fecha}). El texto viene en segmentos numerados [n].

Reglas:
- Usa solo lo que dice el texto; no inventes datos. Si la nota no menciona un dato, usa null (nunca 0 ni un valor inventado).
  Corrige nombres mal transcritos con el glosario.
- El medio que publica (${medio}) NO es un actor de la noticia.
- tema_subtema: el par "tema/subtema" del catálogo que mejor describe la nota.
- detalle: llena SOLO la sección que corresponde al subtema (accidentes_viales -> accidente_vial; homicidios o robos ->
  delito; agua o energia -> falla_servicio; transporte_urbano -> transporte; calor_y_clima -> clima). Las demás en null;
  si el subtema no tiene sección, todo detalle en null.
- lugares: "mencion" es como lo dice el texto; calle_1, calle_2, colonia, lugar_referencia y municipio van con el nombre
  CORRECTO y completo (corrige la transcripción: "Bolivar Aquino" -> "Bulevar Kino"), sin paréntesis ni siglas;
  correccion_transcripcion = true si corregiste el nombre respecto a la mención. municipio siempre (Hermosillo si es
  en la ciudad). rol "lugar_del_hecho" solo donde ocurrió lo que se cuenta.
- actores: es_menor = true si es menor de edad. Cruz Roja, asociaciones, sindicatos y colectivos son
  organizacion_civil, no institucion_gobierno. tono_hacia: cómo trata la noticia a ese actor (-1 a 1).
- fechas: ocurrio (yyyy-mm-dd), ocurrio_franja (madrugada 0-5 h, mañana 6-11 h, tarde 12-18 h, noche 19-23 h) y
  ocurrio_hora solo si la nota los dice o se deducen claramente ("la madrugada del lunes"); si no, null.
- sentimiento.emociones: la MEZCLA de reacciones del público de Hermosillo, sin "neutral". Los cinco "valor" suman 1.
  Toda emoción con valor > 0 lleva "explicacion": una o dos frases con hechos concretos de ESTA nota (por ejemplo:
  "Miedo porque el cruce de Navarrete y Sahuaripa tiene mucho tráfico diario y cualquier conductor de la zona se
  siente expuesto"). Prohibidas las explicaciones genéricas ("las noticias de accidentes generan miedo"). Valor 0 ->
  explicacion null.
- sentimiento.intensidad: qué tan fuerte reacciona el público en general; una nota poco impactante tiene intensidad
  baja pero igual tiene una mezcla de emociones. justificacion: 2 o 3 frases sobre la combinación y la intensidad.
- tono_medio: cómo la cuenta el medio. postura_gobierno: tono hacia cada nivel (null si la nota no habla de él).
- polaridad -1..1, confianza 0..1 en tu análisis.
- citas: frases textuales importantes con el número de segmento donde se dicen. rol_hablante: quién habla
  (reportero, funcionario, testigo, ciudadano, experto, otro). atribuida_a: de quién es realmente la información
  (si el reportero dice "de acuerdo con Tránsito Municipal…", atribuida_a = "Tránsito Municipal"); null si es propia.

${RUBRICA}

Glosario:
${GLOSARIO}`;
}

export const INSTRUCCIONES_RELACION = `Eres editor de noticias de Hermosillo, Sonora. Recibes una NOTA NUEVA y notas
CANDIDATAS de otros medios o programas. Para cada candidata decide su relación con la nota nueva:
- mismo_evento: el mismo suceso, en el mismo lugar y momento, aunque difieran detalles o cifras.
- seguimiento: un desarrollo posterior del mismo suceso (estado de salud de heridos, detenidos, consecuencias).
- relacionado: un suceso distinto pero conectado (otro choque en el mismo cruce, el mismo problema en otra colonia).
- distinto: sin relación.
Los errores de transcripción son comunes ("Zaguaripa" = "Sahuaripa", "Vallegrande" = "Valle Grande", "Bolivar Aquino" =
"bulevar Kino") y no bastan para descartar una coincidencia. confianza 0..1. justificacion: una frase. discrepancias:
diferencias concretas entre las dos versiones (por ejemplo "Un medio reporta 3 lesionados y otro 2"); lista vacía si no
hay. Responde una entrada por candidata, con su nota_id exacto.`;

export const INSTRUCCIONES_CONSOLIDAR = `Eres editor de noticias de Hermosillo, Sonora. Recibes varias notas de distintos
medios que cuentan el MISMO suceso. Escribe un titulo neutral del suceso, un resumen de 2 o 3 frases con lo que coinciden
las versiones, las cifras en que coinciden (o la más reciente si es un seguimiento) y las discrepancias concretas entre
versiones. No inventes datos.`;

export const INSTRUCCIONES_FUSION = `Eres editor de noticias de Hermosillo, Sonora. Recibes un EVENTO y eventos CANDIDATOS
(cada uno resume notas de uno o más medios). Para cada candidato decide si es el MISMO suceso (mismo lugar y momento)
que el evento, aunque difieran detalles o haya errores de transcripción. Responde una decisión por candidato, con su
evento_id exacto, confianza 0..1 y una frase de justificación.`;

export const ESQUEMA_COBERTURA = objeto({
  notas: lista(objeto({ medio: texto, titulo: texto, url: texto, fecha: textoONulo })),
});
export const INSTRUCCIONES_COBERTURA = `Eres documentalista de noticias de Hermosillo, Sonora. Busca en internet notas periodísticas de
distintos medios (locales, estatales o nacionales) que cuenten EXACTAMENTE el suceso descrito: mismo hecho, lugar y fechas
cercanas. No incluyas notas de otro suceso parecido, portadas, secciones, buscadores ni redes sociales. Para cada nota da el
nombre del medio, su titular, la URL de la nota y su fecha (yyyy-mm-dd, null si no se ve). Máximo 10, una por medio de
preferencia. Si no encuentras ninguna, responde una lista vacía: no inventes direcciones.`;
