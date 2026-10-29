import { proyectar, puntoEnPista, type Pista } from "./pista";

/**
 * Cámara de "dron" que sigue a un carro desde atrás y desde arriba.
 *
 * Su rumbo NO es el del carro: es la dirección de la pista un poco más adelante de donde va.
 * Si siguiera al carro, cada derrape o trompo haría girar la cámara; siguiendo a la pista,
 * los carros siempre se ven "desde atrás" en el sentido de la carrera.
 *
 * Es código compartido porque en la partida el servidor la calcula (sigue al líder) y con ella
 * decide quién se salió de la pantalla (enVista); el navegador la dibuja con la misma pose.
 */

export interface Camara {
  /** Punto del suelo al que sigue (metros) */
  x: number;
  y: number;
  /** Altura del suelo en ese punto (el mapa tiene lomas) */
  h: number;
  /** Hacia dónde mira, en radianes, mismo convenio que el ángulo del carro */
  rumbo: number;
  /** 1 = distancia normal; hasta ZOOM_MAX cuando alguien se queda atrás */
  zoom: number;
  iniciada: boolean;
}

/** La cámara compartida se aleja hasta 2.1 veces para que quepan los de atrás */
export const ZOOM_MAX = 2.1;

/** Manejo libre (laboratorio y sala de espera): cerca del propio carro */
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

/**
 * Partida: una sola cámara para todos, que sigue al líder. Más alta y más lejos para que quepan
 * los de atrás, y mirando más adelante para que el líder quede en la parte de arriba: lo que
 * queda abajo de la imagen es lo que se está quedando atrás.
 */
export const PARAMETROS_CAMARA_PARTIDA = {
  ...PARAMETROS_CAMARA,
  adelanto: 18,
  distancia: 30,
  altura: 26,
  mira: 6,
  fov: 50,
  suavizadoPosicion: 3,
  suavizadoRumbo: 2,
};

export type ParametrosCamara = typeof PARAMETROS_CAMARA;

/** La imagen siempre es 16:9, en cualquier pantalla: así todos ven exactamente lo mismo */
export const ASPECTO = 16 / 9;

export function crearCamara(): Camara {
  return { x: 0, y: 0, h: 0, rumbo: 0, zoom: 1, iniciada: false };
}

/** Mueve la cámara hacia el objetivo (un carro: x, y, su índice en la pista y la altura del suelo) */
export function seguir(
  cam: Camara,
  pista: Pista,
  objetivo: { x: number; y: number; indice: number; altura?: number },
  dt: number,
  p: ParametrosCamara = PARAMETROS_CAMARA,
): void {
  const proy = proyectar(pista, objetivo.x, objetivo.y, objetivo.indice);
  const rumbo = puntoEnPista(pista, proy.s + p.adelanto).angulo;
  const h = objetivo.altura ?? 0;

  if (!cam.iniciada) {
    cam.x = objetivo.x;
    cam.y = objetivo.y;
    cam.h = h;
    cam.rumbo = rumbo;
    cam.iniciada = true;
    return;
  }

  // Suavizado exponencial: estable con cualquier dt
  const k = 1 - Math.exp(-p.suavizadoPosicion * dt);
  cam.x += (objetivo.x - cam.x) * k;
  cam.y += (objetivo.y - cam.y) * k;
  cam.h += (h - cam.h) * k;

  // El rumbo gira por el lado más corto
  let d = rumbo - cam.rumbo;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  cam.rumbo += d * (1 - Math.exp(-p.suavizadoRumbo * dt));
  if (cam.rumbo > Math.PI) cam.rumbo -= Math.PI * 2;
  if (cam.rumbo <= -Math.PI) cam.rumbo += Math.PI * 2;
}

type Vec3 = [number, number, number];

/**
 * Dónde está el dron y a qué punto mira, en coordenadas del mundo 3D
 * (x → x, altura → y, y del plano → z). El render usa exactamente esto.
 */
export function poseCamara(cam: Camara, p: ParametrosCamara = PARAMETROS_CAMARA): { posicion: Vec3; mira: Vec3 } {
  const dx = Math.cos(cam.rumbo);
  const dz = Math.sin(cam.rumbo);
  // Al alejarse (zoom > 1) el dron sube más de lo que retrocede y mira un poco hacia atrás:
  // así lo que gana de imagen queda detrás del líder, que es donde vienen los rezagados
  const zoom = cam.zoom ?? 1;
  const distancia = p.distancia * zoom;
  const altura = p.altura * zoom ** 1.4;
  const mira = p.mira - (zoom - 1) * 18;
  return {
    posicion: [cam.x - dx * distancia, cam.h + altura, cam.y - dz * distancia],
    mira: [cam.x + dx * mira, cam.h, cam.y + dz * mira],
  };
}

/** Qué tan adentro del cuadro queremos a todos al elegir el zoom (fracción del borde) */
const HOLGURA_ZOOM = 0.12;

/**
 * Aleja la cámara lo necesario para que quepan todos los carros vivos (hasta ZOOM_MAX).
 * Se aleja rápido cuando alguien se está quedando y se acerca despacio cuando se reagrupan,
 * para que la imagen no "respire" a cada rato. Si ni con el máximo cabe alguien, ese se
 * queda fuera de la imagen y la regla de eliminación decide.
 */
export function ajustarZoom(
  cam: Camara,
  carros: { x: number; y: number; altura: number }[],
  dt: number,
  p: ParametrosCamara = PARAMETROS_CAMARA_PARTIDA,
): void {
  let objetivo = ZOOM_MAX;
  const prueba = { ...cam };
  for (let z = 1; z <= ZOOM_MAX + 1e-9; z += 0.05) {
    prueba.zoom = z;
    if (carros.every((c) => enVista(prueba, c.x, c.y, c.altura, p, -HOLGURA_ZOOM))) {
      objetivo = z;
      break;
    }
  }
  const rapidez = objetivo > cam.zoom ? 2.5 : 0.7;
  cam.zoom += (objetivo - cam.zoom) * (1 - Math.exp(-rapidez * dt));
}

/**
 * ¿Se ve el punto (x, y) del suelo, a la altura `altura`, en la imagen de la cámara?
 * Es la misma proyección en perspectiva que hace Three.js con PerspectiveCamera.lookAt:
 * se lleva el punto a los ejes de la cámara (adelante, derecha, arriba) y se divide entre la
 * distancia. Dentro de la imagen, ambas coordenadas quedan entre -1 y 1; `margen` agranda
 * (positivo) o achica (negativo) ese marco.
 */
export function enVista(
  cam: Camara,
  x: number,
  y: number,
  altura = 0,
  p: ParametrosCamara = PARAMETROS_CAMARA_PARTIDA,
  margen = 0,
): boolean {
  const { posicion: o, mira } = poseCamara(cam, p);
  const f = normalizar([mira[0] - o[0], mira[1] - o[1], mira[2] - o[2]]);
  const r = normalizar(cruz(f, [0, 1, 0]));
  const u = cruz(r, f);
  const q: Vec3 = [x - o[0], altura - o[1], y - o[2]];
  const profundidad = punto(q, f);
  if (profundidad < 0.5) return false; // detrás de la cámara
  const mitadAlto = Math.tan(((p.fov / 2) * Math.PI) / 180);
  const sx = punto(q, r) / (profundidad * mitadAlto * ASPECTO);
  const sy = punto(q, u) / (profundidad * mitadAlto);
  return Math.abs(sx) <= 1 + margen && Math.abs(sy) <= 1 + margen;
}

const punto = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cruz = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalizar(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
