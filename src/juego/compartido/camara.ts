import { proyectar, puntoEnPista, type Pista } from "./pista";

/**
 * Cámara de "dron" que sigue al carro desde atrás y desde arriba.
 *
 * Su rumbo NO es el del carro: es la dirección de la pista un poco más adelante de donde va.
 * Si siguiera al carro, cada derrape o trompo haría girar la cámara; siguiendo a la pista,
 * los carros siempre se ven "desde atrás" en el sentido de la carrera.
 *
 * Es código compartido porque en multijugador el servidor la calcula (sigue al líder) para
 * decidir quién se salió de la pantalla; el navegador solo la dibuja.
 */

export interface Camara {
  /** Punto del suelo al que sigue (metros) */
  x: number;
  y: number;
  /** Hacia dónde mira, en radianes, mismo convenio que el ángulo del carro */
  rumbo: number;
  iniciada: boolean;
}

export const PARAMETROS_CAMARA = {
  /** Qué tan adelante en la pista se toma la dirección: empieza a voltear antes de la curva */
  adelanto: 14,
  /** Distancia horizontal detrás del punto seguido */
  distancia: 20,
  altura: 13,
  /** El centro de la imagen queda este tanto delante del punto seguido */
  mira: 12,
  /** Campo de visión vertical (grados) */
  fov: 45,
  /** Qué tan rápido alcanza al punto y al rumbo (1/s) */
  suavizadoPosicion: 4,
  suavizadoRumbo: 2.5,
};

export type ParametrosCamara = typeof PARAMETROS_CAMARA;

export function crearCamara(): Camara {
  return { x: 0, y: 0, rumbo: 0, iniciada: false };
}

/** Mueve la cámara hacia el objetivo (un carro: x, y y su índice en la pista) */
export function seguir(
  cam: Camara,
  pista: Pista,
  objetivo: { x: number; y: number; indice: number },
  dt: number,
  p: ParametrosCamara = PARAMETROS_CAMARA,
): void {
  const proy = proyectar(pista, objetivo.x, objetivo.y, objetivo.indice);
  const rumbo = puntoEnPista(pista, proy.s + p.adelanto).angulo;

  if (!cam.iniciada) {
    cam.x = objetivo.x;
    cam.y = objetivo.y;
    cam.rumbo = rumbo;
    cam.iniciada = true;
    return;
  }

  // Suavizado exponencial: estable con cualquier dt
  const k = 1 - Math.exp(-p.suavizadoPosicion * dt);
  cam.x += (objetivo.x - cam.x) * k;
  cam.y += (objetivo.y - cam.y) * k;

  // El rumbo gira por el lado más corto
  let d = rumbo - cam.rumbo;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  cam.rumbo += d * (1 - Math.exp(-p.suavizadoRumbo * dt));
  if (cam.rumbo > Math.PI) cam.rumbo -= Math.PI * 2;
  if (cam.rumbo <= -Math.PI) cam.rumbo += Math.PI * 2;
}
