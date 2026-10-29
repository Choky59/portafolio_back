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
  /** Radio de cada círculo de la caja de choque (medio ancho del carro); ver HITBOX */
  radio: 1.1,
  superficies: {
    asfalto: { agarre: 12, traccion: 1, velocidadMax: 1, rodamiento: 3 },
    tierra: { agarre: 4.5, traccion: 0.55, velocidadMax: 0.6, rodamiento: 9 },
  },
  efectos: {
    giroAturdido: 7,
    resbalonAgarre: 0.1,
    lentoVelocidad: 0.45,
    turboVelocidad: 1.45,
    turboAceleracion: 2.2,
  },
  choque: {
    radio: 1.25,
    rebote: 0.15,
    friccion: 0.35,
  },
  coletazo: {
    velocidadMinima: 7,
    giro: 6,
    duracion: 1.1,
    agarre: 0.15,
    frenadoGiro: 1.6,
  },
};

/** Sub-pasos por tick: a 30 Hz un carro a toda velocidad avanza ~1 m por tick; con 2 sub-pasos no atraviesa muros */
export const SUBPASOS = 2;

export const SIN_CONTROLES: Controles = { giro: 0, acel: 0, freno: 0, mano: false };

export function crearCarro(pista: Pista, s: number, lateral = 0): EstadoCarro {
  const p = puntoEnPista(pista, s, lateral);
  const proy = proyectar(pista, p.x, p.y);
  return {
    x: p.x,
    y: p.y,
    angulo: p.angulo,
    vx: 0,
    vy: 0,
    w: 0,
    derrape: 0,
    suelo: "asfalto",
    indice: proy.indice,
    aturdido: 0,
    resbalon: 0,
    lento: 0,
    turbo: 0,
    trompo: 0,
  };
}

export function copiarCarro(c: EstadoCarro): EstadoCarro {
  return { ...c };
}

/**
 * Avanza un carro un tick completo dentro de la pista: suelo, física y muros.
 * Es lo que corre igual en el servidor (autoritativo) y en el cliente (predicción).
 * Devuelve la fuerza del golpe más fuerte contra un muro en este tick (para el sonido).
 */
export function avanzarCarro(c: EstadoCarro, ctrl: Controles, p: ParametrosFisica, pista: Pista, dt: number): number {
  const h = dt / SUBPASOS;
  let golpe = 0;
  for (let i = 0; i < SUBPASOS; i++) {
    const proy = proyectar(pista, c.x, c.y, c.indice);
    c.indice = proy.indice;
    c.suelo = sueloEn(pista, c.x, c.y, proy.distancia);
    pasoCarro(c, ctrl, p, h);
    golpe = Math.max(golpe, colisionMuros(c, pista.muros, p));
  }
  // Los efectos de los items se descuentan por control aplicado: el reloj de cada carro
  c.aturdido = Math.max(0, c.aturdido - 1);
  c.resbalon = Math.max(0, c.resbalon - 1);
  c.lento = Math.max(0, c.lento - 1);
  c.turbo = Math.max(0, c.turbo - 1);
  c.trompo = Math.max(0, c.trompo - 1);
  return golpe;
}

/** Un paso de física del carro (muta `c`) */
export function pasoCarro(c: EstadoCarro, ctrlJugador: Controles, p: ParametrosFisica, dt: number): void {
  const suelo = p.superficies[c.suelo];
  const e = p.efectos;
  // Efectos de items: aturdido ignora los controles; el turbo acelera solo.
  // Trompo (coletazo de otro carro): pedales sí, volante y freno de mano no
  const ctrl =
    c.aturdido > 0
      ? SIN_CONTROLES
      : c.turbo > 0
        ? { ...ctrlJugador, acel: 1, freno: 0 }
        : c.trompo > 0
          ? { ...ctrlJugador, giro: 0, mano: false }
          : ctrlJugador;

  // Ejes del carro: adelante (f) y derecha (r)
  const fx = Math.cos(c.angulo);
  const fy = Math.sin(c.angulo);
  const rx = -fy;
  const ry = fx;
  let vLong = c.vx * fx + c.vy * fy;
  let vLat = c.vx * rx + c.vy * ry;
  const vMax =
    p.velocidadMax * suelo.velocidadMax * (c.lento > 0 ? e.lentoVelocidad : 1) * (c.turbo > 0 ? e.turboVelocidad : 1);
  const aceleracion = p.aceleracion * (c.turbo > 0 ? e.turboAceleracion : 1);

  // 1. Motor y frenos (solo afectan la componente longitudinal)
  if (ctrl.acel > 0 && vLong < vMax) {
    vLong = Math.min(vMax, vLong + aceleracion * suelo.traccion * ctrl.acel * dt);
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
  const agarre =
    suelo.agarre *
    (ctrl.mano ? p.agarreMano : 1) *
    (c.resbalon > 0 ? e.resbalonAgarre : 1) *
    (c.trompo > 0 ? p.coletazo.agarre : 1);
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
  if (c.trompo > 0) {
    // Trompo: el giro que le metió el golpe se va apagando solo, el volante no hace nada
    c.w -= c.w * (1 - Math.exp(-p.coletazo.frenadoGiro * dt));
  } else {
    // Aturdido: el carro da trompos solo
    const objetivo = c.aturdido > 0 ? e.giroAturdido : ctrl.giro * p.giro * factor * sentido * (ctrl.mano ? p.giroMano : 1);
    c.w += (objetivo - c.w) * (1 - Math.exp(-p.respuestaGiro * dt));
  }
  c.angulo = normalizar(c.angulo + c.w * dt);

  c.vx = fx * vLong + rx * vLat;
  c.vy = fy * vLong + ry * vLat;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  c.derrape = Math.min(1, Math.abs(vLat) / 7);
}

/**
 * LA CAJA DE CHOQUE del carro: tres círculos de radio `p.radio` (medio ancho del carro) a lo
 * largo de él: trompa, centro y cola. Un solo círculo dejaba meter media trompa dentro de otro
 * carro; con tres, el contorno queda pegado a la carrocería de 4.4 × 2.2 m.
 */
export const HITBOX = [1.2, 0, -1.2];

/** Centros de los círculos de la caja de choque, en el mundo */
export function circulosCarro(c: EstadoCarro): { x: number; y: number; offset: number }[] {
  const fx = Math.cos(c.angulo);
  const fy = Math.sin(c.angulo);
  return HITBOX.map((offset) => ({ x: c.x + fx * offset, y: c.y + fy * offset, offset }));
}

/** Momento de inercia de una caja de 4.4 × 2.2 m de masa 1: qué tanto gira con un golpe en la punta */
const INERCIA = (4.4 * 4.4 + 2.2 * 2.2) / 12;

/** Choque contra muros: saca al carro del muro y rebota la velocidad normal. Devuelve la fuerza del golpe */
export function colisionMuros(c: EstadoCarro, muros: Segmento[], p: ParametrosFisica): number {
  let golpe = 0;
  for (const { offset } of circulosCarro(c)) {
    for (const [x1, y1, x2, y2] of muros) {
      // El círculo se recalcula: un empujón anterior pudo mover el carro
      const cx = c.x + Math.cos(c.angulo) * offset;
      const cy = c.y + Math.sin(c.angulo) * offset;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((cx - x1) * dx + (cy - y1) * dy) / (dx * dx + dy * dy || 1)));
      const px = x1 + dx * t;
      const py = y1 + dy * t;
      const d = Math.hypot(cx - px, cy - py);
      if (d >= p.radio || d === 0) continue;
      const nx = (cx - px) / d;
      const ny = (cy - py) / d;
      c.x += nx * (p.radio - d);
      c.y += ny * (p.radio - d);
      const vn = c.vx * nx + c.vy * ny;
      if (vn < 0) {
        c.vx -= (1 + p.rebote) * vn * nx;
        c.vy -= (1 + p.rebote) * vn * ny;
        c.vx *= 0.85;
        c.vy *= 0.85;
        golpe = Math.max(golpe, -vn);
      }
    }
  }
  return golpe;
}

/**
 * Choque contra algo redondo y fijo en el piso (un poste, un asador): como un muro, pero con
 * forma de círculo. Lo usan igual el servidor y la predicción del navegador, así que pegarle a
 * un poste no produce correcciones. Devuelve la fuerza del golpe.
 */
export function colisionFija(c: EstadoCarro, x: number, y: number, radio: number, p: ParametrosFisica): number {
  const minimo = p.radio + radio;
  if (Math.hypot(c.x - x, c.y - y) > HITBOX[0] + minimo) return 0;
  let golpe = 0;
  for (const offset of HITBOX) {
    const cx = c.x + Math.cos(c.angulo) * offset;
    const cy = c.y + Math.sin(c.angulo) * offset;
    const d = Math.hypot(cx - x, cy - y);
    if (d >= minimo || d === 0) continue;
    const nx = (cx - x) / d;
    const ny = (cy - y) / d;
    c.x += nx * (minimo - d);
    c.y += ny * (minimo - d);
    const vn = c.vx * nx + c.vy * ny;
    if (vn < 0) {
      c.vx -= (1 + p.rebote) * vn * nx;
      c.vy -= (1 + p.rebote) * vn * ny;
      c.vx *= 0.8;
      c.vy *= 0.8;
      golpe = Math.max(golpe, -vn);
    }
  }
  return golpe;
}

/**
 * Choque entre dos carros de la misma masa. Cada par de círculos que se encima se separa y,
 * si se están acercando, recibe un impulso en el punto de contacto: como el golpe no es en el
 * centro, además de empujar hace girar (pegarle en la trompa a alguien lo voltea).
 * El rebote es bajo y hay fricción entre carrocerías: el golpe empuja y "arrastra" al otro en
 * vez de botarlo, que es lo que sirve para sacar a alguien de la pista.
 * Devuelve la fuerza del golpe (velocidad de acercamiento en el punto de contacto).
 */
export function colisionCarros(a: EstadoCarro, b: EstadoCarro, p: ParametrosFisica): number {
  const { radio, rebote, friccion } = p.choque;
  // Lejos: ni revisar los nueve pares
  if (Math.hypot(b.x - a.x, b.y - a.y) > 2 * (HITBOX[0] + radio)) return 0;
  let golpe = 0;
  for (const oa of HITBOX) {
    for (const ob of HITBOX) {
      const ax = a.x + Math.cos(a.angulo) * oa;
      const ay = a.y + Math.sin(a.angulo) * oa;
      const bx = b.x + Math.cos(b.angulo) * ob;
      const by = b.y + Math.sin(b.angulo) * ob;
      const d = Math.hypot(bx - ax, by - ay);
      const minimo = radio * 2;
      if (d >= minimo || d === 0) continue;
      const nx = (bx - ax) / d;
      const ny = (by - ay) / d;
      const empuje = (minimo - d) / 2;
      a.x -= nx * empuje;
      a.y -= ny * empuje;
      b.x += nx * empuje;
      b.y += ny * empuje;

      // Punto de contacto respecto al centro de cada carro, y su velocidad (v + ω × r)
      const rax = ax + nx * radio - a.x;
      const ray = ay + ny * radio - a.y;
      const rbx = bx - nx * radio - b.x;
      const rby = by - ny * radio - b.y;
      const vax = a.vx - a.w * ray;
      const vay = a.vy + a.w * rax;
      const vbx = b.vx - b.w * rby;
      const vby = b.vy + b.w * rbx;
      const vn = (vbx - vax) * nx + (vby - vay) * ny;
      if (vn >= 0) continue;

      const ra = rax * ny - ray * nx;
      const rb = rbx * ny - rby * nx;
      const j = (-(1 + rebote) * vn) / (2 + (ra * ra + rb * rb) / INERCIA);
      a.vx -= j * nx;
      a.vy -= j * ny;
      b.vx += j * nx;
      b.vy += j * ny;
      a.w -= (ra * j) / INERCIA;
      b.w += (rb * j) / INERCIA;

      // Fricción: frena el deslizamiento de lado entre las carrocerías (tope de Coulomb: μ·j)
      const tx = -ny;
      const ty = nx;
      const vt = (vbx - vax) * tx + (vby - vay) * ty;
      const jt = Math.max(-friccion * j, Math.min(friccion * j, -vt / 2));
      a.vx -= jt * tx;
      a.vy -= jt * ty;
      b.vx += jt * tx;
      b.vy += jt * ty;

      golpe = Math.max(golpe, -vn);
    }
  }
  return golpe;
}

/**
 * COLETAZO: si la parte de atrás de `atacante` llega con fuerza contra `victima`, la víctima
 * pierde el control (trompo). Se mide la velocidad del punto de la cola, que es la del carro
 * más la de su giro (v + ω × r): un carro derrapando barre con la cola aunque vaya despacio,
 * y uno que solo retrocede despacio no descontrola a nadie.
 * Hay que revisarlo ANTES de resolver el choque, con las velocidades de llegada.
 * Devuelve true si hubo coletazo.
 */
export function coletazo(atacante: EstadoCarro, victima: EstadoCarro, p: ParametrosFisica, pasosPorSegundo: number): boolean {
  // ¿El círculo de la cola del atacante toca algún círculo de la víctima?
  const cola = circulosCarro(atacante).at(-1)!;
  let contacto: { x: number; y: number } | null = null;
  let menor = p.choque.radio * 2;
  for (const c of circulosCarro(victima)) {
    const d = Math.hypot(c.x - cola.x, c.y - cola.y);
    if (d < menor && d > 0) {
      menor = d;
      contacto = c;
    }
  }
  if (!contacto) return false;
  const nx = (contacto.x - cola.x) / menor;
  const ny = (contacto.y - cola.y) / menor;
  const fx = Math.cos(atacante.angulo);
  const fy = Math.sin(atacante.angulo);
  // El otro tiene que estar del lado de la cola: en un choque de trompa contra un carro largo,
  // la cola también llega a rozarlo, y eso no es un coletazo
  if ((contacto.x - atacante.x) * fx + (contacto.y - atacante.y) * fy > -0.2 * Math.hypot(contacto.x - atacante.x, contacto.y - atacante.y)) {
    return false;
  }

  // Velocidad de la cola: v + ω × r, con r del centro a la cola
  const rx = cola.x - atacante.x;
  const ry = cola.y - atacante.y;
  const colaVx = atacante.vx - atacante.w * ry;
  const colaVy = atacante.vy + atacante.w * rx;
  const llegada = (colaVx - victima.vx) * nx + (colaVy - victima.vy) * ny;
  const c = p.coletazo;
  // La cola misma tiene que ir hacia el otro: que te alcancen por detrás no es un coletazo tuyo
  const propia = colaVx * nx + colaVy * ny;
  if (llegada < c.velocidadMinima || propia < c.velocidadMinima * 0.6) return false;

  // Fuerza de 0.4 (apenas pasando el mínimo) a 1 (el doble del mínimo o más)
  const fuerza = 0.4 + 0.6 * Math.min(1, (llegada - c.velocidadMinima) / c.velocidadMinima);
  // Gira para el mismo lado que barre la cola (si el atacante no giraba, según de qué lado le pegó)
  const sentido = Math.abs(atacante.w) > 0.2 ? Math.sign(atacante.w) : Math.sign(fx * ny - fy * nx) || 1;
  victima.w += sentido * c.giro * fuerza;
  victima.trompo = Math.max(victima.trompo, Math.round(c.duracion * fuerza * pasosPorSegundo));
  return true;
}

/**
 * Choque entre dos carros: primero se revisan los coletazos (con las velocidades de llegada),
 * luego se separan y rebotan. Devuelve la fuerza del golpe y a quién descontroló.
 */
export function chocarCarros(
  a: EstadoCarro,
  b: EstadoCarro,
  p: ParametrosFisica,
  pasosPorSegundo: number,
): { fuerza: number; descontrolados: EstadoCarro[] } {
  const descontrolados: EstadoCarro[] = [];
  if (coletazo(a, b, p, pasosPorSegundo)) descontrolados.push(b);
  if (coletazo(b, a, p, pasosPorSegundo)) descontrolados.push(a);
  return { fuerza: colisionCarros(a, b, p), descontrolados };
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
