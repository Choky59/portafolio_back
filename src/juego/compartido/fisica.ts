import type { Controles, EstadoCarro, ParametrosFisica } from "./tipos";
import { proyectar, puntoEnPista, sueloEn, type Pista, type Segmento } from "./pista";

/**
 * Física arcade del carro, en funciones puras sobre objetos planos.
 *
 * Por qué no planck.js (Box2D): aquí no hace falta un motor de cuerpos rígidos. El "sentir" del
 * carro sale de una sola idea, separar la velocidad en dos componentes:
 *   - longitudinal (hacia donde apunta el carro): la controlan el motor y los frenos;
 *   - lateral (de lado): la llanta la mata con su agarre.
 * Si el agarre es alto el carro va "en rieles"; si es bajo (freno de mano, tierra) la velocidad
 * lateral sobrevive unos instantes y el carro derrapa. Con eso basta para el estilo arcade y
 * cada perilla del panel de física es un número que se entiende.
 * Además, la predicción del cliente re-simula entradas desde un estado viejo: con objetos planos
 * es copiar y repetir; con un mundo de Box2D habría que guardar y restaurar todo el mundo.
 *
 * Unidades: metros, segundos y radianes. El eje y crece hacia abajo (como en el canvas), así que
 * girar a la derecha es aumentar el ángulo.
 */

export const PARAMETROS_FISICA: ParametrosFisica = {
  aceleracion: 35,
  velocidadMax: 50,
  reversaMax: 9,
  frenado: 38,
  giro: 3.1,
  velocidadGiroPleno: 9,
  respuestaGiro: 14,
  subviraje: 0.35,
  agarreMano: 0.53,
  giroMano: 1.35,
  frenoMano: 7,
  recuperacion: 0.35,
  rebote: 0.35,
  radio: 1.3,
  superficies: {
    asfalto: { agarre: 12, traccion: 1, velocidadMax: 1, rodamiento: 3 },
    tierra: { agarre: 4.5, traccion: 0.55, velocidadMax: 0.6, rodamiento: 9 },
  },
};

/** Sub-pasos por tick: a 30 Hz un carro a toda velocidad avanza ~1 m por tick; con 2 sub-pasos no atraviesa muros */
export const SUBPASOS = 2;

export const SIN_CONTROLES: Controles = { giro: 0, acel: 0, freno: 0, mano: false };

export function crearCarro(pista: Pista, s: number, lateral = 0): EstadoCarro {
  const p = puntoEnPista(pista, s, lateral);
  const proy = proyectar(pista, p.x, p.y);
  return { x: p.x, y: p.y, angulo: p.angulo, vx: 0, vy: 0, w: 0, derrape: 0, suelo: "asfalto", indice: proy.indice };
}

export function copiarCarro(c: EstadoCarro): EstadoCarro {
  return { ...c };
}

/**
 * Avanza un carro un tick completo dentro de la pista: suelo, física y muros.
 * Es lo que corre igual en el servidor (autoritativo) y en el cliente (predicción).
 */
export function avanzarCarro(c: EstadoCarro, ctrl: Controles, p: ParametrosFisica, pista: Pista, dt: number): void {
  const h = dt / SUBPASOS;
  for (let i = 0; i < SUBPASOS; i++) {
    const proy = proyectar(pista, c.x, c.y, c.indice);
    c.indice = proy.indice;
    c.suelo = sueloEn(pista, c.x, c.y, proy.distancia);
    pasoCarro(c, ctrl, p, h);
    colisionMuros(c, pista.muros, p);
  }
}

/** Un paso de física del carro (muta `c`) */
export function pasoCarro(c: EstadoCarro, ctrl: Controles, p: ParametrosFisica, dt: number): void {
  const suelo = p.superficies[c.suelo];

  // Ejes del carro: adelante (f) y derecha (r)
  const fx = Math.cos(c.angulo);
  const fy = Math.sin(c.angulo);
  const rx = -fy;
  const ry = fx;
  let vLong = c.vx * fx + c.vy * fy;
  let vLat = c.vx * rx + c.vy * ry;
  const vMax = p.velocidadMax * suelo.velocidadMax;

  // 1. Motor y frenos (solo afectan la componente longitudinal)
  if (ctrl.acel > 0 && vLong < vMax) {
    vLong = Math.min(vMax, vLong + p.aceleracion * suelo.traccion * ctrl.acel * dt);
  }
  if (ctrl.freno > 0) {
    if (vLong > 0.5) vLong = Math.max(0, vLong - p.frenado * ctrl.freno * dt);
    else vLong = Math.max(-p.reversaMax, vLong - p.aceleracion * 0.5 * ctrl.freno * dt);
  }
  if (ctrl.mano) vLong = haciaCero(vLong, p.frenoMano * dt);
  if (ctrl.acel === 0 && ctrl.freno === 0) vLong = haciaCero(vLong, suelo.rodamiento * dt);
  // Entrar a la tierra a toda velocidad frena rápido, pero no en seco
  if (vLong > vMax) vLong -= (vLong - vMax) * (1 - Math.exp(-2.5 * dt));

  // 2. Agarre lateral: el corazón del derrape. La llanta quita una fracción de la velocidad
  // lateral en cada paso (decaimiento exponencial, estable con cualquier dt).
  const agarre = suelo.agarre * (ctrl.mano ? p.agarreMano : 1);
  const perdida = vLat * (1 - Math.exp(-agarre * dt));
  vLat -= perdida;
  // Parte de lo que "se come" la llanta regresa como empuje hacia adelante: al soltar el freno
  // de mano el carro sale disparado del derrape en vez de quedarse frenado.
  if (vLong > 0 && !ctrl.mano) vLong = Math.min(vMax, vLong + Math.abs(perdida) * p.recuperacion);

  // 3. Volante. El giro depende de la velocidad: detenido no gira y a toda velocidad gira menos
  // (subviraje). Al rotar el carro NO se rota su velocidad: eso deja velocidad lateral que el
  // agarre irá matando en los siguientes pasos. Así nace el derrape al girar fuerte.
  const rapidez = Math.abs(vLong);
  const factor = Math.min(1, rapidez / p.velocidadGiroPleno) * (1 - p.subviraje * Math.min(1, rapidez / p.velocidadMax));
  const sentido = vLong >= 0 ? 1 : -1;
  const objetivo = ctrl.giro * p.giro * factor * sentido * (ctrl.mano ? p.giroMano : 1);
  c.w += (objetivo - c.w) * (1 - Math.exp(-p.respuestaGiro * dt));
  c.angulo = normalizar(c.angulo + c.w * dt);

  c.vx = fx * vLong + rx * vLat;
  c.vy = fy * vLong + ry * vLat;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  c.derrape = Math.min(1, Math.abs(vLat) / 7);
}

/** Choque contra muros: saca al carro del muro y rebota la velocidad normal. Devuelve la fuerza del golpe */
export function colisionMuros(c: EstadoCarro, muros: Segmento[], p: ParametrosFisica): number {
  let golpe = 0;
  for (const [x1, y1, x2, y2] of muros) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((c.x - x1) * dx + (c.y - y1) * dy) / (dx * dx + dy * dy || 1)));
    const px = x1 + dx * t;
    const py = y1 + dy * t;
    const d = Math.hypot(c.x - px, c.y - py);
    if (d >= p.radio || d === 0) continue;
    const nx = (c.x - px) / d;
    const ny = (c.y - py) / d;
    c.x = px + nx * p.radio;
    c.y = py + ny * p.radio;
    const vn = c.vx * nx + c.vy * ny;
    if (vn < 0) {
      c.vx -= (1 + p.rebote) * vn * nx;
      c.vy -= (1 + p.rebote) * vn * ny;
      c.vx *= 0.85;
      c.vy *= 0.85;
      golpe = Math.max(golpe, -vn);
    }
  }
  return golpe;
}

/** Choque entre dos carros de la misma masa (círculos). Devuelve la fuerza del golpe */
export function colisionCarros(a: EstadoCarro, b: EstadoCarro, p: ParametrosFisica): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const minimo = p.radio * 2;
  if (d >= minimo || d === 0) return 0;
  const nx = dx / d;
  const ny = dy / d;
  const empuje = (minimo - d) / 2;
  a.x -= nx * empuje;
  a.y -= ny * empuje;
  b.x += nx * empuje;
  b.y += ny * empuje;
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn >= 0) return 0;
  const j = (-(1 + p.rebote) * vn) / 2;
  a.vx -= j * nx;
  a.vy -= j * ny;
  b.vx += j * nx;
  b.vy += j * ny;
  return -vn;
}

/** Rapidez en m/s */
export function rapidez(c: EstadoCarro): number {
  return Math.hypot(c.vx, c.vy);
}

function haciaCero(v: number, cantidad: number): number {
  return v > 0 ? Math.max(0, v - cantidad) : Math.min(0, v + cantidad);
}

function normalizar(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}
