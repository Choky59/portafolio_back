import type { EstadoCarro } from "../compartido/tipos";
import { enBarranco, proyectar, type Pista } from "../compartido/pista";
import { enVista, type Camara, PARAMETROS_CAMARA_PARTIDA } from "../compartido/camara";

/**
 * Reglas de la partida: quién va adelante y quién explota.
 *
 * LA REGLA DE ELIMINACIÓN. Hay una sola cámara para todos, que sigue al que va adelante.
 * Un carro explota y queda fuera de la ronda si:
 *   - su centro cae dentro de un barranco del mapa, o
 *   - se queda fuera de la imagen de esa cámara más de FUERA_MAX segundos seguidos.
 * La "imagen" es la proyección real de la cámara 3D (compartido/camara.ts → enVista), la misma
 * que dibuja el navegador, con aspecto fijo de 16:9: todos ven exactamente lo mismo, así que
 * nadie pierde por tener una pantalla más chica. Antes de eso la cámara se aleja hasta el doble
 * para que quepan los de atrás (ajustarZoom), y aun fuera hay tolerancia de espacio
 * (MARGEN_VISTA) y de tiempo (fueraMax) para intentar alcanzar.
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

export type MotivoEliminacion = "barranco" | "atras";

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
  if (enBarranco(pista, carro.x, carro.y)) return { fuera: 0, motivo: "barranco" };
  if (ticksCarrera < DURACION.gracia * tickHz) return { fuera: 0, motivo: null };
  if (enVista(camara, carro.x, carro.y, altura, PARAMETROS_CAMARA_PARTIDA, MARGEN_VISTA)) return { fuera: 0, motivo: null };
  const total = fuera + 1;
  return { fuera: total, motivo: total > DURACION.fueraMax * tickHz ? "atras" : null };
}
