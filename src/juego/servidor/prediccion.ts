import type { EstadoCarro, Item } from "../compartido/tipos";
import { direccionPista, proyectar, type Pista } from "../compartido/pista";
import { PARAMETROS_FISICA, chocarCarros, copiarCarro } from "../compartido/fisica";
import { MECANICAS, aplicarEfecto, lugarDeLanzamiento, type Conductor, type Entidad, type MundoItems } from "./items";

/**
 * LA PREDICCIÓN DE LOS ITEMS en el navegador (se copia a crash_game/src/juego/simulacion con
 * `npm run juego:sync`).
 *
 * Igual que con el manejo: al apretar el botón, el navegador no espera al servidor. Corre la MISMA
 * mecánica (MECANICAS[...].usar) contra un mundo de prueba que solo anota lo que pasaría:
 *  - lo que le pasa al carro propio (el turbo, el escudo, el casco…) se le aplica a la predicción
 *    con aplicarEfecto, lo mismo que hace Sala.golpear; así no hay corrección cuando llega la
 *    confirmación;
 *  - lo que se suelta (un bache, el burro, un charco…) sale como entidad PROVISIONAL, que se
 *    dibuja de inmediato hasta que llega la del servidor.
 * A los demás no les pasa nada aquí: eso solo lo decide el servidor.
 */

export interface ContextoPrediccion {
  pista: Pista;
  items: Item[];
  tickHz: number;
  /** El carro propio: lo que le haga el item se le aplica a este carro */
  yo: Conductor;
  /** Los demás como se ven (copias: lo que les pase aquí no cuenta) */
  otros: Conductor[];
}

/** Una entidad provisional (lo que soltó el carro propio, antes de que llegue la del servidor) */
export type EntidadProvisional = Entidad;

/** Metros a lo largo de la pista, relativos al carro propio (para saber quién va adelante) */
function recorridos(ctx: ContextoPrediccion): (id: string) => number {
  const s = (c: Conductor) => proyectar(ctx.pista, c.carro.x, c.carro.y, c.carro.indice).s;
  const mio = s(ctx.yo);
  const L = ctx.pista.longitud || 1;
  const tabla = new Map<string, number>([[ctx.yo.id, 0]]);
  for (const o of ctx.otros) {
    let d = (s(o) - mio) % L;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    tabla.set(o.id, d);
  }
  return (id) => tabla.get(id) ?? -Infinity;
}

let siguienteProvisional = -1;

/** Dónde algo tocó el suelo en la simulación de prueba (el meteorito al caer, el andamio al llegar al piso) */
export interface ImpactoPredicho {
  x: number;
  y: number;
}

function mundoDePrueba(ctx: ContextoPrediccion, soltadas: Entidad[] | null, efectosPropios: boolean, impactos?: ImpactoPredicho[]): MundoItems {
  const recorrido = recorridos(ctx);
  return {
    tickHz: ctx.tickHz,
    pista: ctx.pista,
    items: ctx.items,
    conductores: () => [ctx.yo, ...ctx.otros],
    recorrido,
    avance: () => 0,
    soltar(e) {
      if (!soltadas) return;
      soltadas.push({ ...e, id: siguienteProvisional--, edad: 0, tocados: new Set(), vidaMax: e.vida, golpes: 0, nacio: 0, etapa: 0 });
    },
    golpear(victima, _item, efecto) {
      if (efectosPropios && victima.id === ctx.yo.id) aplicarEfecto(victima.carro, efecto, ctx.tickHz);
    },
    // Lo que en el servidor es el aviso "impacto" (Sala.aplastar y m.avisar): aquí solo se anota
    aplastar(x, y) {
      impactos?.push({ x, y });
    },
    existe: () => false,
    avisar(evento) {
      if (evento?.tipo === "impacto" && typeof evento.x === "number" && typeof evento.y === "number") impactos?.push({ x: evento.x, y: evento.y });
    },
    azar: Math.random,
    ignorarChoque() {},
    seVe: () => true,
  };
}

/**
 * El carro propio usa el item `indice` (justo después de su paso de física, como en
 * Sala.aplicarUno). Cambia `ctx.yo.carro` como lo cambiaría el servidor y devuelve lo que
 * soltaría. `conSoltadas: false` para la reconciliación (solo importa el carro)
 */
export function predecirUso(ctx: ContextoPrediccion, indice: number, conSoltadas = true): EntidadProvisional[] {
  const item = ctx.items[indice];
  const mecanica = item && MECANICAS[item.mecanica];
  if (!mecanica) return [];
  const soltadas: Entidad[] = [];
  try {
    mecanica.usar(mundoDePrueba(ctx, conSoltadas ? soltadas : null, true), ctx.yo, indice, item);
  } catch {
    // Una mecánica que pide algo que el mundo de prueba no tiene: solo se queda lo que alcanzó
  }
  return soltadas;
}

/**
 * Un tick de una entidad provisional, con su misma mecánica (el burro avanza, el cono sigue al
 * carro, lo del piso se queda). No le pega a nadie: es solo lo que se dibuja. false: se acabó.
 * `impactos`: ahí se anota lo que en el servidor sería el aviso "impacto" en este tick (el meteorito
 * al caer, el andamio al llegar al piso), para que el navegador explote ya y no espere al servidor
 */
export function avanzarProvisional(ctx: ContextoPrediccion, e: EntidadProvisional, impactos?: ImpactoPredicho[]): boolean {
  const item = ctx.items[e.item];
  const actualizar = item && MECANICAS[item.mecanica]?.actualizar;
  try {
    if (actualizar) return actualizar(mundoDePrueba(ctx, null, false, impactos), e, item);
  } catch {
    // Sin poder simularla, se queda quieta hasta que llegue la del servidor
  }
  e.edad++;
  return --e.vida > 0;
}

/**
 * LO QUE TIRA EL ESPECTADOR (el meteorito, el andamio), predicho: al tocar la pista el navegador no
 * espera al servidor. Sale como entidad provisional en el mismo lugar en que la pone
 * Sala.lanzarMeteorito (lugarDeLanzamiento) y con la misma vida, así que cae al mismo ritmo; se
 * dibuja hasta que llega la del servidor. Si el servidor no la acepta, el navegador la quita.
 * null: ese item no existe
 */
export function predecirLanzamiento(pista: Pista, items: Item[], tickHz: number, indice: number, x: number, y: number): EntidadProvisional | null {
  const item = items[indice];
  if (!item) return null;
  const lugar = lugarDeLanzamiento(pista, item, x, y, Math.random);
  const vida = Math.round((item.vida ?? 1.25) * tickHz);
  return {
    id: siguienteProvisional--,
    item: indice,
    dueno: "",
    ...lugar,
    vx: 0,
    vy: 0,
    vida,
    vidaMax: vida,
    edad: 0,
    objetivo: null,
    tocados: new Set(),
    golpes: 0,
    nacio: 0,
    etapa: 0,
  };
}

/**
 * QUÉ TANTO CREERLE A UN CHOQUE PREDICHO. Lo que se ve del otro carro es una adivinanza de dónde
 * está: su último estado conocido (de hace su colchón + el ping) llevado al presente con su
 * velocidad. Esa `incertidumbre` (s) es cuánto tiempo se adivina. Con poca (red buena) el golpe
 * se predice completo; con mucha (una red que entrega a paquetes, ~0.3 s) el otro pudo haber
 * doblado y estar a metros de ahí: el golpe se predice más suave y el resto lo decide el servidor
 * (llega en la confirmación). Así no se rebota contra un carro que ya no estaba, ni se ve que lo
 * atraviesas y luego te regresa el golpe de golpe.
 */
export const CHOQUE_CONFIABLE_S = 0.15;
export const CHOQUE_DUDOSO_S = 0.3;
/** Lo menos que se predice de un golpe (con la incertidumbre de CHOQUE_DUDOSO_S o más) */
export const CONFIANZA_MINIMA = 0.3;

/** 1 hasta CHOQUE_CONFIABLE_S; baja en línea recta hasta CONFIANZA_MINIMA en CHOQUE_DUDOSO_S */
export function confianzaChoque(incertidumbreS: number): number {
  if (!(incertidumbreS > CHOQUE_CONFIABLE_S)) return 1;
  const t = Math.min(1, (incertidumbreS - CHOQUE_CONFIABLE_S) / (CHOQUE_DUDOSO_S - CHOQUE_CONFIABLE_S));
  return 1 - t * (1 - CONFIANZA_MINIMA);
}

/** Lo que un choque le cambia al carro (resolverChoque y empujar): eso es lo que se suaviza */
const CAMPOS_CHOQUE = ["x", "y", "vx", "vy", "w", "empujon"] as const;

/**
 * LOS CHOQUES CON LOS DEMÁS en la predicción del carro propio: los mismos que hace
 * Sala.aplicarUno justo después de avanzar (chocarCarros contra cada uno, en ese orden), pero
 * contra los demás como se ven en pantalla (copias: a ellos no les pasa nada aquí). Así el carro
 * rebota al tocarlos, sin esperar al servidor; si el otro en realidad estaba en otro lado, la
 * reconciliación lo corrige. `confianzas` (una por otro, de confianzaChoque; sin ella, 1): con
 * menos de 1 se aplica solo esa parte del golpe. Devuelve la fuerza del golpe contra cada uno
 * (0: no se tocaron), completa aunque se haya suavizado
 */
export function chocarPredicho(pista: Pista, tickHz: number, carro: EstadoCarro, otros: EstadoCarro[], confianzas?: number[]): number[] {
  return otros.map((otro, i) => {
    const c = confianzas?.[i] ?? 1;
    const antes = c < 1 ? copiarCarro(carro) : null;
    const { fuerza } = chocarCarros(carro, copiarCarro(otro), PARAMETROS_FISICA, tickHz, direccionPista(pista, carro.indice));
    if (antes && fuerza > 0) {
      const mezcla = carro as unknown as Record<string, number>;
      const previo = antes as unknown as Record<string, number>;
      for (const k of CAMPOS_CHOQUE) mezcla[k] = (previo[k] ?? 0) + ((mezcla[k] ?? 0) - (previo[k] ?? 0)) * c;
    }
    return fuerza;
  });
}
