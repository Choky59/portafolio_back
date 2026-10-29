import type { EstadoCarro } from "../compartido/tipos";
import { proyectar, puntoEnPista, type Pista } from "../compartido/pista";
import { PARAMETROS_FISICA } from "../compartido/fisica";
import type { ControlesRed } from "../compartido/protocolo";

/**
 * Bots: jugadores que maneja el servidor, para jugar solo o completar una sala.
 * No tienen nada especial: cada tick "piensan" un control y lo mandan como cualquier jugador,
 * así que pasan por la misma física, las mismas reglas y los mismos items.
 *
 * El piloto: apunta a un punto de la pista un poco adelante (más lejos mientras más rápido va),
 * frena antes de las curvas cerradas, se echa de reversa si se atora y usa sus items después
 * de un rato. `habilidad` < 1 los hace un poco más lentos que su máximo, para que se les pueda ganar.
 */

export const NOMBRES_BOT = ["Chuy", "Lupita", "El Güero", "Doña Mary"];

export interface MenteBot {
  seq: number;
  /** Fracción de la velocidad máxima a la que se atreve en recta */
  habilidad: number;
  /** Por qué lado de la pista va (m a la derecha de la línea central) */
  carril: number;
  /** Ticks seguidos casi detenido */
  atascado: number;
  /** Ticks que le quedan de reversa para desatorarse */
  reversa: number;
  /** Tick en que va a usar su item (0: aún no decide) */
  itemEn: number;
}

export function crearMente(azar: () => number = Math.random): MenteBot {
  return {
    seq: 0,
    habilidad: 0.82 + azar() * 0.12,
    carril: (azar() - 0.5) * 6,
    atascado: 0,
    reversa: 0,
    itemEn: 0,
  };
}

function diferencia(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** El control de este tick */
export function pensar(
  m: MenteBot,
  carro: EstadoCarro,
  pista: Pista,
  tick: number,
  tickHz: number,
  tieneItem: boolean,
  azar: () => number = Math.random,
  /** false en la cuenta regresiva, la pausa o eliminado: el carro no se mueve aunque quiera */
  puedeMoverse = true,
): ControlesRed {
  m.seq++;
  const v = Math.hypot(carro.vx, carro.vy);
  const s = proyectar(pista, carro.x, carro.y, carro.indice).s;

  // Atorado contra algo: unos segundos de reversa con el volante al revés. Solo cuenta si el
  // carro puede moverse: congelado en la parrilla no está atorado (si no, arranca de reversa)
  if (!puedeMoverse) m.reversa = 0;
  m.atascado = puedeMoverse && v < 2 ? m.atascado + 1 : 0;
  if (m.atascado > 1.5 * tickHz) {
    m.atascado = 0;
    m.reversa = Math.round(0.9 * tickHz);
  }

  const adelanto = 9 + v * 0.45;
  const meta = puntoEnPista(pista, s + adelanto, m.carril);
  const error = diferencia(Math.atan2(meta.y - carro.y, meta.x - carro.x), carro.angulo);

  if (m.reversa > 0) {
    m.reversa--;
    return { seq: m.seq, giro: error > 0 ? -1 : 1, acel: 0, freno: 1, mano: false, item: false };
  }

  // Qué tan cerrada viene la curva: cuánto cambia la dirección de la pista más adelante
  const curva = Math.abs(diferencia(puntoEnPista(pista, s + adelanto + 25).angulo, puntoEnPista(pista, s + adelanto).angulo));
  const vObjetivo = PARAMETROS_FISICA.velocidadMax * m.habilidad * (curva > 0.9 ? 0.45 : curva > 0.5 ? 0.62 : curva > 0.25 ? 0.82 : 1);

  // Items: los usa un rato después de agarrarlos
  let item = false;
  if (tieneItem && m.itemEn === 0) m.itemEn = tick + Math.round((1 + azar() * 3) * tickHz);
  if (tieneItem && m.itemEn > 0 && tick >= m.itemEn) {
    item = true;
    m.itemEn = 0;
  }
  if (!tieneItem) m.itemEn = 0;

  return {
    seq: m.seq,
    giro: Math.max(-1, Math.min(1, error * 2.4)),
    acel: v < vObjetivo ? 1 : 0,
    freno: v > vObjetivo + 6 ? 1 : 0,
    mano: Math.abs(error) > 0.75 && v > 14,
    item,
  };
}
