import type { Progreso } from "../compartido/protocolo";
import { DURACION } from "./reglas";
import type { Sala } from "./salas";

/**
 * CÓMO SE ARMA UNA SALA de un jugador (copa de la campaña o tutorial). Es código puro: lo usa el
 * servidor (el multijugador y el laboratorio) y el navegador, que corre estas salas en local
 * (crash_game/src/juego/red/conexionLocal.js, con una copia hecha por `npm run juego:sync`).
 */

/** Una copa de content/juego/copas.json (lo que hace falta para armarla) */
export interface CopaDatos {
  id: string;
  pistas: string[];
  meta?: number;
  nivelBots?: number;
}

/** Las copas que se pueden jugar tienen exactamente 3 pistas */
export const PISTAS_POR_COPA = 3;

/**
 * ¿Puede jugar esta copa (y su Difícil) con este progreso? Devuelve la copa o un error. La
 * anterior tiene que estar en el podio; la Difícil, ganada en 1º en Normal
 */
export function copaAbierta(copas: readonly CopaDatos[], pedida: unknown, dificil: boolean, progreso: Progreso): { copa: CopaDatos } | { error: string } {
  const indice = copas.findIndex((c) => c.id === pedida);
  const copa = copas[indice];
  if (!copa || copa.pistas.length !== PISTAS_POR_COPA) return { error: "Esa copa no existe" };
  const anterior = copas[indice - 1];
  if (anterior && !((progreso[anterior.id]?.mejorLugar ?? 9) <= 3)) return { error: "Queda en el podio de la copa anterior para abrir esta" };
  if (dificil && progreso[copa.id]?.mejorLugar !== 1) return { error: "Gana esta copa en 1er lugar en Normal para abrir la Difícil" };
  return { copa };
}

/**
 * Convierte una sala recién creada (con su dueño ya adentro) en la de una copa: sus victorias, la
 * pista `inicio` y sus 3 bots con personalidades (en Difícil, sin freno). `premiada`: el servidor
 * no tiene que pagarla (la de prueba, o la que se juega en local: esa se cobra con su sesión)
 */
export function armarCopa(
  sala: Sala,
  copa: CopaDatos,
  { dueno, uid = "", dificil = false, inicio = 0, premiada = false }: { dueno: string; uid?: string; dificil?: boolean; inicio?: number; premiada?: boolean },
): void {
  sala.meta = copa.meta ?? 3;
  sala.copa = { id: copa.id, dificil, pistas: copa.pistas, indice: inicio, puntos: {}, dueno, uid, contada: false, final: null, premiada };
  for (let i = 0; i < 3; i++) sala.agregarBot(copa.nivelBots ?? 0, true, dificil);
}

/**
 * Lo menos que puede durar una copa completa, en segundos: cada pista se gana con `meta`
 * victorias y cada ronda tiene al menos su cuenta, la gracia del arranque y el festejo. Con esto
 * el servidor rechaza un resultado que llega antes de que la copa se pudiera haber jugado
 */
export function duracionMinimaCopa(copa: Pick<CopaDatos, "meta" | "pistas">): number {
  const ronda = DURACION.cuenta + DURACION.gracia + DURACION.rondaFin;
  return copa.pistas.length * (copa.meta ?? 3) * ronda;
}
