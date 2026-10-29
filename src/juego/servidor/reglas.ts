import type { EstadoCarro } from "../compartido/tipos";
import { enAgua, enBarranco, proyectar, type Pista } from "../compartido/pista";
import { enVista, type Camara, PARAMETROS_CAMARA_PARTIDA } from "../compartido/camara";

/**
 * Reglas de la partida: quién va adelante y quién explota.
 *
 * LA REGLA DE ELIMINACIÓN. Hay una sola cámara para todos, que sigue al que va adelante.
 * Un carro explota y queda fuera de la ronda si:
 *   - su centro cae dentro de un barranco o al agua (el mar de San Carlos), o
 *   - se queda fuera de la imagen de esa cámara más de FUERA_MAX segundos seguidos.
 * La "imagen" es la proyección real de la cámara 3D (compartido/camara.ts → enVista), la misma
 * que dibuja el navegador, con aspecto fijo de 16:9: todos ven exactamente lo mismo, así que
 * nadie pierde por tener una pantalla más chica. Antes de eso la cámara se aleja hasta 2.1 veces
 * para que quepan los de atrás (ajustarZoom), y aun fuera hay tolerancia de espacio
 * (MARGEN_VISTA) y de tiempo (fueraMax) para intentar alcanzar.
 * Además, el que va pegado al borde de la imagen trae un poco más de motor (alBorde → rezago).
 * Y los que ya explotaron pueden tirar meteoritos desde el cielo (METEORITO).
 */

/** Segundos de cada fase */
export const DURACION = {
  cuenta: 3,
  rondaFin: 2.5,
  /** Al arrancar, nadie explota por quedar fuera de la imagen durante este tiempo */
  gracia: 1.5,
  /** Fuera de la imagen más de esto: explota. Da chance de un último recobro */
  fueraMax: 0.6,
};

/**
 * Tolerancia: el centro del carro puede salirse este tanto del marco (fracción del cuadro)
 * antes de contar como "fuera". Junto con el zoom de la cámara, solo explota quien de plano se quedó.
 */
export const MARGEN_VISTA = 0.15;

/**
 * EL REZAGADO: un carro (que no sea el líder) que ya va en el último 10% del cuadro, o fuera, es
 * que la cámara ya no se puede alejar más para esperarlo (ajustarZoom mantiene a todos más
 * adentro mientras puede). Mientras siga ahí trae más velocidad y aceleración
 * (PARAMETROS_FISICA.efectos.rezago*), y le dura `REZAGO` segundos después de salir de esa franja.
 */
export const BORDE_VISTA = -0.1;
export const REZAGO = 0.5;

/** ¿El carro va pegado al borde de la imagen de la cámara compartida (o ya fuera)? */
export function alBorde(carro: EstadoCarro, altura: number, camara: Camara): boolean {
  return !enVista(camara, carro.x, carro.y, altura, PARAMETROS_CAMARA_PARTIDA, BORDE_VISTA);
}

/**
 * Meteoritos de los espectadores: quien ya explotó (y si en la sala hay más de `minJugadores`)
 * marca un punto de la imagen; a los `caida` segundos cae ahí. El carro que esté dentro de su
 * radio (items.json) explota y queda un bache ya pisado. Uno a la vez por espectador, con
 * `recarga` segundos entre uno y otro.
 */
export const METEORITO = { minJugadores: 3, recarga: 4 };

/** Seguimiento de la posición en la carrera: vueltas completas y metros desde la meta */
export interface Progreso {
  vueltas: number;
  s: number;
}

/** Actualiza vueltas y s; cruzar la meta hacia adelante suma una vuelta, hacia atrás la resta */
export function actualizarProgreso(p: Progreso, carro: EstadoCarro, pista: Pista): void {
  const s = proyectar(pista, carro.x, carro.y, carro.indice).s;
  const ds = s - p.s;
  if (ds < -pista.longitud / 2) p.vueltas++;
  else if (ds > pista.longitud / 2) p.vueltas--;
  p.s = s;
}

/** Metros recorridos en total: con esto se decide quién es el líder */
export function distanciaRecorrida(p: Progreso, pista: Pista): number {
  return p.vueltas * pista.longitud + p.s;
}

export type MotivoEliminacion = "barranco" | "agua" | "atras" | "meteorito";

/**
 * Revisa a un carro vivo en un tick de carrera. `fuera` cuenta los ticks seguidos fuera de la
 * imagen y se devuelve actualizado junto con el motivo de eliminación, si lo hay.
 */
export function revisarEliminacion(
  carro: EstadoCarro,
  altura: number,
  fuera: number,
  camara: Camara,
  pista: Pista,
  ticksCarrera: number,
  tickHz: number,
): { fuera: number; motivo: MotivoEliminacion | null } {
  // Volando (de una rampa) pasa por encima del barranco o del agua: cuenta donde aterrice
  const volando = carro.z > 0.3;
  if (!volando && enBarranco(pista, carro.x, carro.y)) return { fuera: 0, motivo: "barranco" };
  if (!volando && enAgua(pista, carro.x, carro.y)) return { fuera: 0, motivo: "agua" };
  if (ticksCarrera < DURACION.gracia * tickHz) return { fuera: 0, motivo: null };
  if (enVista(camara, carro.x, carro.y, altura, PARAMETROS_CAMARA_PARTIDA, MARGEN_VISTA)) return { fuera: 0, motivo: null };
  const total = fuera + 1;
  return { fuera: total, motivo: total > DURACION.fueraMax * tickHz ? "atras" : null };
}
