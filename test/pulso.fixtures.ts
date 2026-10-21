/** Shared helpers of the pulso tests: captures, a fake model, and one job run to the end */
import { Database } from "../src/middlewares/database/mongodb";
import { ICaptura } from "../src/@types/collections/pulso/captura";
import * as Trabajos from "../src/routes/pulso/analisis/trabajos.service";
import { IProveedor } from "../src/routes/pulso/analisis/proveedor";
import { ESQUEMA_COBERTURA, ESQUEMA_CONSOLIDAR, ESQUEMA_FUSION, ESQUEMA_RELACION } from "../src/routes/pulso/analisis/esquemas";

/** Empty pulso collections and one known source (Telemax) */
export async function limpiarPulso() {
  const P = Database.Pulso;
  for (const c of [P.Capturas(), P.Notas(), P.Consumo(), P.Trabajos(), P.Fuentes(), P.Eventos(), P.Actores(), P.Etiquetas(), P.LugaresConocidos(), P.Geocache()]) {
    await c.deleteMany({});
  }
  await Database.Pulso.Fuentes().insertOne({ slug: "telemax", nombre: "Telemax", tipo: "youtube", medio: "Gobierno de Sonora", activa: true });
}

export function segs(n: number, cada = 5) {
  return Array.from({ length: n }, (_, i) => ({ inicio: i * cada, fin: i * cada + cada, texto: `frase ${i}` }));
}

export async function captura(campos: Partial<ICaptura> = {}): Promise<ICaptura> {
  const ahora = new Date();
  const doc: ICaptura = {
    clave: "youtube:abc123",
    fuente: "telemax",
    tipo: "youtube",
    estado: "transcrita",
    historial: [],
    intentos: 0,
    error: null,
    url: "https://www.youtube.com/watch?v=abc123",
    titulo: "Nota de prueba",
    publicadoEn: new Date("2026-10-20T15:00:00Z"),
    duracionSeg: 120,
    texto: "x",
    segmentos: segs(10),
    reserva: null,
    creadoEn: ahora,
    actualizadoEn: ahora,
    ...campos,
  };
  const { insertedId } = await Database.Pulso.Capturas().insertOne(doc);
  return { ...doc, _id: insertedId };
}

/** A complete, valid answer for one note (the parts a test cares about can be overridden) */
export function respuestaNota(extra: any = {}) {
  return {
    titulo: "Inicia pago de beca",
    resumen_corto: "Corto.",
    resumen: "Largo.",
    puntos_clave: ["uno"],
    clasificacion: { tipo: "anuncio_oficial", ambito: "estatal", tema_subtema: "educacion/becas_y_apoyos", tema_secundario: null, etiquetas: ["Beca", "beca"], es_alerta: false, relevancia: 0.6 },
    lugares: [{ mencion: "bulevar Kino y Rosales", tipo: "cruce", calle_1: "Bulevar Kino", calle_2: "Calle Rosales", municipio: "Hermosillo", rol: "lugar_del_hecho" }],
    actores: [
      { nombre: "Telemax", tipo: "otro", rol: "mencionado", es_menor: false },
      { nombre: "Alejandra Limón", tipo: "funcionario", cargo: "Coordinadora", rol: "fuente_citada", es_menor: false, tono_hacia: 0.4 },
    ],
    afectados: [{ grupo: "estudiantes", cantidad: 100000, efecto: "beneficio" }],
    cifras: [{ valor: 1900, unidad: "MXN", que_mide: "monto" }],
    fechas: { ocurrio: "2026-10-20", ocurrio_franja: null, ocurrio_hora: null, proximos_eventos: [{ desde: "2026-10-26", hasta: "2026-11-06", que: "Registro" }] },
    detalle: null,
    sentimiento: {
      emociones: {
        alegria: { valor: 0.6, explicacion: "Las familias reciben el apoyo." },
        enojo: { valor: 0, explicacion: null },
        tristeza: { valor: 0, explicacion: null },
        miedo: { valor: 0, explicacion: null },
        sorpresa: { valor: 0.2, explicacion: "El pago se adelanta." },
      },
      polaridad: 0.5, intensidad: 0.3, tono_medio: "informativo",
      postura_gobierno: { municipal: null, estatal: null, federal: 0.4 }, polemica: 0.1, justificacion: "Beneficio.",
    },
    citas: [{ texto: "Ya se paga", quien: "Alejandra Limón", rol_hablante: "funcionario", atribuida_a: "Alejandra Limón", segmento: 2 }],
    confianza: 0.85,
    ...extra,
  };
}

/** One job over every pending capture (budget USD), run to the end; returns the finished job */
export async function procesar(p: IProveedor, presupuestoUSD = 10, rango: Trabajos.IRango & { buscarWeb?: boolean } = {}) {
  const t = await Trabajos.crear({ buscarWeb: false, ...rango, presupuestoUSD }, "test");
  await Trabajos.ejecutar(p);
  return t ? Database.Pulso.Trabajos().findOne({ _id: t._id }) : null;
}

export interface IEventosFalsos {
  relacion?: (p: any) => any;
  consolidar?: (p: any) => any;
  fusion?: (p: any) => any;
  cobertura?: (p: any) => any;
}

/**
 * A provider that answers from a list of functions (one per segmenting / note call) and
 * counts calls. The events' calls (relation, consolidate, merge) go to `eventos`, kept
 * apart in `llamadasEventos`; by default they find nothing related.
 */
export function proveedorFalso(respuestas: ((p: any) => any)[], uso = { entrada: 1000, salida: 200 }, eventos: IEventosFalsos = {}) {
  const llamadas: any[] = [];
  const llamadasEventos: any[] = [];
  const p: IProveedor & { llamadas: any[]; llamadasEventos: any[] } = {
    modelo: "falso",
    llamadas,
    llamadasEventos,
    async generar(params) {
      const deEventos =
        params.esquema === ESQUEMA_RELACION ? eventos.relacion ?? (() => ({ relaciones: [] }))
        : params.esquema === ESQUEMA_CONSOLIDAR ? eventos.consolidar ?? (() => ({ titulo: "Evento", resumen: "Resumen.", cifras: [], discrepancias: [] }))
        : params.esquema === ESQUEMA_FUSION ? eventos.fusion ?? (() => ({ decisiones: [] }))
        : params.esquema === ESQUEMA_COBERTURA ? eventos.cobertura ?? (() => ({ notas: [] }))
        : null;
      if (deEventos) {
        llamadasEventos.push(params);
        return { datos: deEventos(params), uso: params.buscar ? { ...uso, busquedas: 1 } : uso };
      }
      llamadas.push(params);
      const f = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
      return { datos: f(params), uso };
    },
  };
  return p;
}
