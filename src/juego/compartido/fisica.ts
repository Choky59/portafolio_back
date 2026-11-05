import type { Controles, EstadoCarro, ParametrosFisica } from "./tipos";
import { proyectar, puntoEnPista, rampaEn, sobreRampa, sueloEn, type Pista, type Segmento } from "./pista";
import { cercanos, contactoObjeto, type ImpactoEscenario } from "./escenario";

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
  velocidadMax: 37.5,
  /** De reversa se llega tan rápido como de frente */
  reversaMax: 37.5,
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
  gravedad: 25,
  aterrizaje: 0.9,
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
    /* El que está por quedar fuera de la imagen (solo personas, ver REZAGO): bastante más motor para recuperarse */
    rezagoVelocidad: 1.25,
    rezagoAceleracion: 1.35,
    enredadoGiro: 0.4,
    ponchadoVelocidad: 0.68,
    ponchadoJalon: 0.55,
    cementoVelocidad: 0.22,
    // En cuanto pisas cemento: la tierra deja 0.6 (quita 40 %), y el cemento quita un 10 % más que ella (0.56)
    cementoTope: 0.56,
    cementoFrenado: 6,
    cementoLleno: 120,
    pesadoMasa: 3,
  },
  choque: {
    radio: 1.25,
    rebote: 0.15,
    // Con un solo punto de contacto (cápsulas) hace falta más que con los nueve pares de círculos
    friccion: 0.7,
    empujon: {
      duracion: 0.7,
      agarre: 0.2,
      volante: 0.12,
      umbral: 1.5,
      pleno: 8,
      ventaja: 1.5,
    },
  },
  coletazo: {
    velocidadMinima: 7,
    giro: 6,
    duracion: 1.1,
    agarre: 0.15,
    frenadoGiro: 1.6,
  },
  // Salir de un choque sin sobregirar: casi 1 s con el volante a la mitad (subiendo) y el giro del golpe apagándose solo
  recobro: {
    activo: true,
    duracion: 0.9,
    volante: 0.5,
    estabilizar: 6,
  },
};

/** Sub-pasos por tick: a 30 Hz un carro a toda velocidad avanza ~1 m por tick; con 2 sub-pasos no atraviesa muros */
export const SUBPASOS = 2;

export const SIN_CONTROLES: Controles = { giro: 0, acel: 0, freno: 0, mano: false };

/** Arcade steering: less authority on the ramp, and gentle course correction after takeoff. */
export const CONTROL_SALTO = { giroRampa: 0.65, giroAire: 0.35, respuestaAire: 0.65 };

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
    rezago: 0,
    enredado: 0,
    ponchado: 0,
    escudo: 0,
    pesado: 0,
    viento: 0,
    vientoX: 0,
    vientoY: 0,
    cemento: 0,
    z: 0,
    vz: 0,
    rampa: -1,
    empujon: 0,
    recobro: 0,
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
export function avanzarCarro(c: EstadoCarro, ctrl: Controles, p: ParametrosFisica, pista: Pista, dt: number, alImpacto?: (impacto: ImpactoEscenario) => void): number {
  const h = dt / SUBPASOS;
  let golpe = 0;
  const impactos = alImpacto ? new Map<string, ImpactoEscenario>() : null;
  for (let i = 0; i < SUBPASOS; i++) {
    const proy = proyectar(pista, c.x, c.y, c.indice);
    c.indice = proy.indice;
    if (enElAire(c)) {
      golpe = Math.max(golpe, pasoAire(c, ctrl, p, h));
    } else {
      // Detect the ramp before applying controls, including the very first step on its foot.
      const enRampa = c.rampa >= 0 || rampaEn(pista, c.x, c.y) !== null;
      c.suelo = enRampa ? "asfalto" : sueloEn(pista, c.x, c.y, proy.distancia);
      pasoCarro(c, ctrl, p, h, enRampa ? CONTROL_SALTO.giroRampa : 1);
      subirRampa(c, pista);
    }
    const contraMuro = colisionMuros(c, pista.muros, p);
    if (contraMuro > 3 && impactos && pista.circuito.terreno === "obra") impactos.set("estructura", { objeto: "estructura", x: c.x, y: c.y, fuerza: contraMuro });
    golpe = Math.max(golpe, contraMuro, colisionEscenario(c, pista, p, impactos));
  }
  // Los efectos de los items se descuentan por control aplicado: el reloj de cada carro
  c.aturdido = Math.max(0, c.aturdido - 1);
  c.resbalon = Math.max(0, c.resbalon - 1);
  c.lento = Math.max(0, c.lento - 1);
  c.turbo = Math.max(0, c.turbo - 1);
  c.trompo = Math.max(0, c.trompo - 1);
  c.rezago = Math.max(0, c.rezago - 1);
  c.enredado = Math.max(0, c.enredado - 1);
  c.ponchado = Math.max(0, c.ponchado - 1);
  c.escudo = Math.max(0, c.escudo - 1);
  c.pesado = Math.max(0, c.pesado - 1);
  c.viento = Math.max(0, c.viento - 1);
  c.cemento = Math.max(0, c.cemento - 1);
  // El empujón va en segundos (no en controles): se acaba igual a cualquier tickHz
  c.empujon = Math.max(0, c.empujon - dt);
  // La recuperación (s) empieza cuando se acaba el golpe: mientras dura el empujón o el trompo se
  // queda llena. Solo con la ayuda activa (personas): en los bots se queda en 0
  if (!p.recobro?.activo) c.recobro = 0;
  else if (c.empujon > 0 || c.trompo > 0) c.recobro = p.recobro.duracion;
  else c.recobro = Math.max(0, (c.recobro ?? 0) - dt);
  if (alImpacto && impactos) for (const impacto of impactos.values()) alImpacto(impacto);
  return golpe;
}

/** Three-circle vehicle hitbox against anchored props and lightweight movable bodies. */
export function colisionEscenario(c: EstadoCarro, pista: Pista, p: ParametrosFisica, impactos?: Map<string, ImpactoEscenario> | null): number {
  let golpe = 0;
  const e = pista.escenario;
  for (const o of cercanos(e, c.x, c.y, p.radio + HITBOX[0] + 1)) {
    const cuerpo = e.moviles.get(o.id);
    const alto = cuerpo?.tumbado ? 0.7 : o.alto;
    if (c.z > o.base + alto || c.z + 1.8 < o.base) continue;
    for (const offset of HITBOX) {
      const cx = c.x + Math.cos(c.angulo) * offset, cy = c.y + Math.sin(c.angulo) * offset;
      const contacto = contactoObjeto(o, cx, cy, p.radio, cuerpo);
      if (!contacto) continue;
      const { nx, ny, profundidad } = contacto;
      const masaCarro = c.pesado > 0 ? p.efectos.pesadoMasa : 1;
      const inversa = cuerpo ? masaCarro / o.masa : 0;
      const reparto = 1 / (1 + inversa);
      c.x += nx * profundidad * reparto; c.y += ny * profundidad * reparto;
      if (cuerpo) { cuerpo.x -= nx * profundidad * (1 - reparto); cuerpo.y -= ny * profundidad * (1 - reparto); }
      const vn = (c.vx - (cuerpo?.vx ?? 0)) * nx + (c.vy - (cuerpo?.vy ?? 0)) * ny;
      if (vn >= 0) continue;
      const impulso = -(1 + (cuerpo ? 0.15 : p.rebote)) * vn * reparto;
      c.vx += impulso * nx; c.vy += impulso * ny;
      if (cuerpo) {
        cuerpo.vx -= impulso * nx * inversa; cuerpo.vy -= impulso * ny * inversa;
        cuerpo.w += Math.max(-8, Math.min(8, -offset * impulso * 0.25));
        if (-vn > 3) cuerpo.tumbado = true;
      } else { c.vx *= 0.85; c.vy *= 0.85; }
      golpe = Math.max(golpe, -vn);
      if (-vn > 3 && impactos && -vn > (impactos.get(o.id)?.fuerza ?? 0)) impactos.set(o.id, { objeto: o.id, x: cx - nx * p.radio, y: cy - ny * p.radio, fuerza: -vn });
    }
  }
  return golpe;
}

/**
 * Arriba de esta altura (m) un carro pasa por encima de lo que está suelto en el piso: estorbos,
 * andamios y trampas no lo tocan (el gancho de grúa, un salto de rampa). Lo usan la Sala y la
 * predicción del navegador
 */
export const ALTURA_LIBRE = 1.5;

/** En el aire: ni en una rampa ni en el suelo */
export function enElAire(c: EstadoCarro): boolean {
  return c.rampa < 0 && c.z > 0;
}

/**
 * LAS RAMPAS. En el suelo, si el carro queda sobre una rampa su altura es la de la rampa en ese
 * punto. Al salirse de ella: por la orilla de arriba y hacia adelante, sale volando con la
 * velocidad vertical que le da la pendiente (más rápido = más alto y más lejos); por un lado o
 * por atrás, simplemente baja.
 */
function subirRampa(c: EstadoCarro, pista: Pista): void {
  const sobre = rampaEn(pista, c.x, c.y);
  if (sobre) {
    const r = pista.circuito.rampas![sobre.indice];
    c.rampa = sobre.indice;
    c.z = sobre.t * r.alto;
    return;
  }
  if (c.rampa < 0) return;
  const r = pista.circuito.rampas![c.rampa];
  c.rampa = -1;
  const v = c.vx * Math.cos(r.angulo) + c.vy * Math.sin(r.angulo);
  if (sobreRampa(r, c.x, c.y).avance > r.largo && v > 0) {
    c.z = r.alto;
    c.vz = (v * r.alto) / r.largo;
  } else {
    c.z = 0;
    c.vz = 0;
  }
}

/**
 * En el aire se conserva la rapidez horizontal, pero el volante permite corregir el rumbo con
 * menos fuerza que en el suelo. La corrección gira también la trayectoria, no solo el modelo.
 * No hay motor ni freno de mano; la gravedad y la pérdida de velocidad al aterrizar se conservan.
 * Devuelve la fuerza del aterrizaje (para el sonido), o 0.
 */
function pasoAire(c: EstadoCarro, ctrl: Controles, p: ParametrosFisica, dt: number): number {
  if (c.aturdido > 0 || c.trompo > 0) {
    // A stun/spin still disables the wheel, just as it does on the ground.
    c.w *= Math.exp(-0.8 * dt);
    c.angulo = normalizar(c.angulo + c.w * dt);
  } else {
    const v = Math.hypot(c.vx, c.vy);
    const vLong = c.vx * Math.cos(c.angulo) + c.vy * Math.sin(c.angulo);
    const factor = Math.min(1, v / p.velocidadGiroPleno) * (1 - p.subviraje * Math.min(1, v / p.velocidadMax));
    const volante = ctrl.giro * (c.enredado > 0 ? p.efectos.enredadoGiro : 1);
    const objetivo = volante * p.giro * factor * CONTROL_SALTO.giroAire * (vLong >= 0 ? 1 : -1);
    c.w += (objetivo - c.w) * (1 - Math.exp(-p.respuestaGiro * CONTROL_SALTO.respuestaAire * dt));
    const giro = c.w * dt;
    const cos = Math.cos(giro), sin = Math.sin(giro);
    const vx = c.vx;
    c.vx = vx * cos - c.vy * sin;
    c.vy = vx * sin + c.vy * cos;
    c.angulo = normalizar(c.angulo + giro);
  }
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  c.vz -= p.gravedad * dt;
  c.z += c.vz * dt;
  c.derrape = 0;
  if (c.z > 0) return 0;
  const golpe = -c.vz;
  c.z = 0;
  c.vz = 0;
  c.vx *= p.aterrizaje;
  c.vy *= p.aterrizaje;
  return golpe;
}

/** Un paso de física del carro (muta `c`) */
export function pasoCarro(c: EstadoCarro, ctrlJugador: Controles, p: ParametrosFisica, dt: number, factorGiro = 1): void {
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
  // El que va al borde de la imagen de la cámara compartida (rezago) trae un poco más de motor
  // Cemento: en cuanto lo pisas, a lo más cementoTope; y entre más trae, más lento (hasta
  // cementoVelocidad con la carga llena)
  const cemento = Math.min(1, c.cemento / e.cementoLleno);
  const conCemento = c.cemento > 0 ? Math.min(e.cementoTope, 1 - (1 - e.cementoVelocidad) * cemento) : 1;
  const vMax =
    p.velocidadMax *
    suelo.velocidadMax *
    (c.lento > 0 ? e.lentoVelocidad : 1) *
    (c.turbo > 0 ? e.turboVelocidad : 1) *
    (c.rezago > 0 ? e.rezagoVelocidad : 1) *
    (c.ponchado > 0 ? e.ponchadoVelocidad : 1) *
    conCemento;
  const aceleracion = p.aceleracion * (c.turbo > 0 ? e.turboAceleracion : 1) * (c.rezago > 0 ? e.rezagoAceleracion : 1);
  // La reversa acelera y topa igual que el frente, con el mismo suelo y efectos
  const vMaxReversa = (p.reversaMax * vMax) / p.velocidadMax;

  // 1. Motor y frenos (solo afectan la componente longitudinal)
  if (ctrl.acel > 0 && vLong < vMax) {
    vLong = Math.min(vMax, vLong + aceleracion * suelo.traccion * ctrl.acel * dt);
  }
  if (ctrl.freno > 0) {
    if (vLong > 0.5) vLong = Math.max(0, vLong - p.frenado * ctrl.freno * dt);
    else vLong = Math.max(-vMaxReversa, vLong - aceleracion * suelo.traccion * ctrl.freno * dt);
  }
  if (ctrl.mano) vLong = haciaCero(vLong, p.frenoMano * dt);
  if (ctrl.acel === 0 && ctrl.freno === 0) vLong = haciaCero(vLong, suelo.rodamiento * dt);
  // Entrar a la tierra a toda velocidad frena rápido, pero no en seco; al cemento, más rápido
  if (vLong > vMax) vLong -= (vLong - vMax) * (1 - Math.exp(-(c.cemento > 0 ? e.cementoFrenado : 2.5) * dt));

  // Qué tanto queda del empujón de un choque: 1 justo después del golpe, baja a 0 cuando se acaba
  const empujado = Math.min(1, (c.empujon ?? 0) / p.choque.empujon.duracion);

  // 2. Agarre lateral: el corazón del derrape. La llanta quita una fracción de la velocidad
  // lateral en cada paso (decaimiento exponencial, estable con cualquier dt).
  const agarre =
    suelo.agarre *
    (ctrl.mano ? p.agarreMano : 1) *
    (c.resbalon > 0 ? e.resbalonAgarre : 1) *
    (c.trompo > 0 ? p.coletazo.agarre : 1) *
    (1 - (1 - p.choque.empujon.agarre) * empujado);
  const perdida = vLat * (1 - Math.exp(-agarre * dt));
  vLat -= perdida;
  // Parte de lo que "se come" la llanta regresa como empuje hacia adelante: al soltar el freno
  // de mano el carro sale disparado del derrape en vez de quedarse frenado. Lo de lado que dejó
  // un golpe no: si no, empujar a alguien de lado lo aceleraba
  if (vLong > 0 && !ctrl.mano && empujado === 0) vLong = Math.min(vMax, vLong + Math.abs(perdida) * p.recuperacion);

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
    // Aturdido: el carro da trompos solo. Enredado: el volante responde menos. Ponchado: se jala
    // hacia la derecha (el lado de la llanta ponchada), con el carro en movimiento
    const volante = ctrl.giro * (c.enredado > 0 ? e.enredadoGiro : 1) + (c.ponchado > 0 ? e.ponchadoJalon / p.giro : 0);
    // Recuperación de un choque (solo personas): el volante con tope, que sube hasta 1 al acabarse,
    // y una respuesta extra que apaga el giro del golpe. Entra conforme se acaba el empujón: en el
    // golpe mismo el choque sí te mueve
    const r = p.recobro;
    const recobro = r?.activo && c.aturdido <= 0 && (c.recobro ?? 0) > 0 ? Math.min(1, c.recobro / r.duracion) : 0;
    const tope = recobro > 0 ? r.volante + (1 - r.volante) * (1 - recobro) : 1;
    const objetivo = c.aturdido > 0 ? e.giroAturdido : volante * tope * p.giro * factor * sentido * (ctrl.mano ? p.giroMano : 1) * factorGiro;
    // Empujado: el volante responde menos, así que el giro que metió el golpe dura (y se puede contravolantear)
    const respuesta =
      p.respuestaGiro * (1 - (1 - p.choque.empujon.volante) * empujado) + (recobro > 0 ? r.estabilizar * (1 - empujado) : 0);
    c.w += (objetivo - c.w) * (1 - Math.exp(-respuesta * dt));
  }
  c.angulo = normalizar(c.angulo + c.w * dt);

  c.vx = fx * vLong + rx * vLat;
  c.vy = fy * vLong + ry * vLat;
  c.x += c.vx * dt;
  c.y += c.vy * dt;
  // Tormenta de arena: el viento lo arrastra de lado (m/s), aparte de lo que agarren las llantas
  if (c.viento > 0) {
    c.x += c.vientoX * dt;
    c.y += c.vientoY * dt;
  }
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
  // Volando, pasa por encima
  if (c.z > 1) return 0;
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

/** El punto del segmento [a, b] más cercano a (x, y), como fracción 0…1 */
function fraccionEnSegmento(ax: number, ay: number, bx: number, by: number, x: number, y: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const largo2 = dx * dx + dy * dy;
  return largo2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / largo2));
}

/**
 * LA CÁPSULA de un carro contra la de otro: cada carro es el segmento de la cola a la trompa
 * (HITBOX) engordado `radio`. Devuelve los dos puntos más cercanos entre los segmentos y la
 * normal de `a` hacia `b`, o null si no se tocan. Con tres círculos la normal salía de centro a
 * centro de círculo (en diagonal cuando un carro le pega al costado del otro) y el golpe empujaba
 * para adelante o para atrás; con la cápsula sale perpendicular a la carrocería.
 */
export function contactoCarros(a: EstadoCarro, b: EstadoCarro, radio: number) {
  const largo = HITBOX[0];
  const fax = Math.cos(a.angulo) * largo;
  const fay = Math.sin(a.angulo) * largo;
  const fbx = Math.cos(b.angulo) * largo;
  const fby = Math.sin(b.angulo) * largo;
  // Segmentos: a1→a2 y b1→b2 (de la cola a la trompa)
  const a1x = a.x - fax, a1y = a.y - fay, a2x = a.x + fax, a2y = a.y + fay;
  const b1x = b.x - fbx, b1y = b.y - fby, b2x = b.x + fbx, b2y = b.y + fby;
  // Lo más cercano entre dos segmentos: probar cada extremo contra el otro segmento basta cuando
  // no se cruzan; si se cruzan (uno atravesó al otro) se usan los centros
  let mejor = { d: Infinity, pax: 0, pay: 0, pbx: 0, pby: 0 };
  const probar = (pax: number, pay: number, pbx: number, pby: number) => {
    const d = Math.hypot(pbx - pax, pby - pay);
    if (d < mejor.d) mejor = { d, pax, pay, pbx, pby };
  };
  for (const [x, y] of [[a1x, a1y], [a2x, a2y]]) {
    const t = fraccionEnSegmento(b1x, b1y, b2x, b2y, x, y);
    probar(x, y, b1x + (b2x - b1x) * t, b1y + (b2y - b1y) * t);
  }
  for (const [x, y] of [[b1x, b1y], [b2x, b2y]]) {
    const t = fraccionEnSegmento(a1x, a1y, a2x, a2y, x, y);
    probar(a1x + (a2x - a1x) * t, a1y + (a2y - a1y) * t, x, y);
  }
  const minimo = radio * 2;
  if (mejor.d >= minimo) return null;
  let nx = mejor.pbx - mejor.pax;
  let ny = mejor.pby - mejor.pay;
  let d = mejor.d;
  if (d < 1e-6) {
    // Los segmentos se cruzan (uno atravesó al otro): se separan por el eje en que se enciman
    // menos, entre los de cada carro (a lo largo y de lado) y la línea entre los centros
    const dcx = b.x - a.x;
    const dcy = b.y - a.y;
    const dc = Math.hypot(dcx, dcy);
    const ejes = [
      [Math.cos(a.angulo), Math.sin(a.angulo)], [-Math.sin(a.angulo), Math.cos(a.angulo)],
      [Math.cos(b.angulo), Math.sin(b.angulo)], [-Math.sin(b.angulo), Math.cos(b.angulo)],
      ...(dc > 1e-6 ? [[dcx / dc, dcy / dc]] : []),
    ];
    const extension = (c: EstadoCarro, ex: number, ey: number) => largo * Math.abs(Math.cos(c.angulo) * ex + Math.sin(c.angulo) * ey) + radio;
    let eje = { nx: 1, ny: 0, encimado: Infinity };
    for (const [ex, ey] of ejes) {
      const sobre = dcx * ex + dcy * ey;
      const encimado = extension(a, ex, ey) + extension(b, ex, ey) - Math.abs(sobre);
      const signo = sobre < 0 ? -1 : 1;
      if (encimado < eje.encimado) eje = { nx: ex * signo, ny: ey * signo, encimado };
    }
    return { ...eje, pax: a.x, pay: a.y, pbx: b.x, pby: b.y };
  }
  return { nx: nx / d, ny: ny / d, encimado: minimo - d, pax: mejor.pax, pay: mejor.pay, pbx: mejor.pbx, pby: mejor.pby };
}

/**
 * Choque entre dos carros. Pesan lo mismo, salvo con el casco (`pesado`): ese pesa pesadoMasa y se
 * mueve poco, mientras el otro sale aventado. Las cápsulas encimadas se separan y, si se están
 * acercando, reciben un impulso en el punto de contacto: como el golpe no es en el centro, además
 * de empujar hace girar (pegarle en la trompa a alguien lo voltea).
 * El rebote es bajo y hay fricción entre carrocerías: el golpe empuja y "arrastra" al otro en
 * vez de botarlo, que es lo que sirve para sacar a alguien de la pista.
 * Devuelve la fuerza del golpe (velocidad de acercamiento en el punto de contacto).
 */
export function colisionCarros(a: EstadoCarro, b: EstadoCarro, p: ParametrosFisica): number {
  return resolverChoque(a, b, p).golpe;
}

/** Hacia dónde va la pista donde chocan (vector unitario): ver parteDeA */
export type DireccionPista = { x: number; y: number };

/**
 * Qué parte del acercamiento puso `a` (0 … 1): su velocidad hacia `b` contra la de `b` hacia
 * `a`, sobre la normal del choque. 1: `a` embistió a uno que ni se movía hacia él; 0.5: los dos
 * se fueron encima igual (o ninguno).
 * Con `via` (la dirección de la pista) primero se le quita a cada uno lo que avanza a lo largo
 * de la pista: en una carrera los dos van a 25 m/s para adelante, y en un golpe en la esquina
 * (normal un poco inclinada) ese avance contaba como que el otro te embistió. Lo que cuenta es
 * quién se le echó encima a quién de lado.
 */
function parteDeA(a: EstadoCarro, b: EstadoCarro, nx: number, ny: number, via?: DireccionPista): number {
  const sinAvance = (c: EstadoCarro) => {
    if (!via) return { x: c.vx, y: c.vy };
    const avance = c.vx * via.x + c.vy * via.y;
    return { x: c.vx - via.x * avance, y: c.vy - via.y * avance };
  };
  const va = sinAvance(a);
  const vb = sinAvance(b);
  const deA = Math.max(0, va.x * nx + va.y * ny);
  const deB = Math.max(0, -(vb.x * nx + vb.y * ny));
  return deA + deB > 1e-6 ? deA / (deA + deB) : 0.5;
}

function resolverChoque(a: EstadoCarro, b: EstadoCarro, p: ParametrosFisica, via?: DireccionPista): { golpe: number; parteA: number } {
  const { radio, rebote, friccion } = p.choque;
  const nada = { golpe: 0, parteA: 0.5 };
  // Lejos: ni revisar
  if (Math.hypot(b.x - a.x, b.y - a.y) > 2 * (HITBOX[0] + radio)) return nada;
  const contacto = contactoCarros(a, b, radio);
  if (!contacto) return nada;
  const { nx, ny, encimado } = contacto;
  // Inversas de las masas: el pesado (casco) casi no se mueve, y el que embiste pesa más en este choque
  const parteA = parteDeA(a, b, nx, ny, via);
  const ventaja = p.choque.empujon.ventaja;
  const ia = (a.pesado > 0 ? 1 / p.efectos.pesadoMasa : 1) / (1 + ventaja * parteA);
  const ib = (b.pesado > 0 ? 1 / p.efectos.pesadoMasa : 1) / (1 + ventaja * (1 - parteA));
  a.x -= nx * encimado * (ia / (ia + ib));
  a.y -= ny * encimado * (ia / (ia + ib));
  b.x += nx * encimado * (ib / (ia + ib));
  b.y += ny * encimado * (ib / (ia + ib));
  // El punto de contacto: en la superficie de `a` (ya separados, ahí se tocan los dos), respecto
  // al centro de cada carro, y su velocidad (v + ω × r)
  const cx = contacto.pax - nx * encimado * (ia / (ia + ib)) + nx * radio;
  const cy = contacto.pay - ny * encimado * (ia / (ia + ib)) + ny * radio;
  const rax = cx - a.x;
  const ray = cy - a.y;
  const rbx = cx - b.x;
  const rby = cy - b.y;
  const vax = a.vx - a.w * ray;
  const vay = a.vy + a.w * rax;
  const vbx = b.vx - b.w * rby;
  const vby = b.vy + b.w * rbx;
  const vn = (vbx - vax) * nx + (vby - vay) * ny;
  if (vn >= 0) return nada;

  const ra = rax * ny - ray * nx;
  const rb = rbx * ny - rby * nx;
  const j = (-(1 + rebote) * vn) / (ia + ib + (ra * ra * ia + rb * rb * ib) / INERCIA);
  a.vx -= j * nx * ia;
  a.vy -= j * ny * ia;
  b.vx += j * nx * ib;
  b.vy += j * ny * ib;
  a.w -= (ra * j * ia) / INERCIA;
  b.w += (rb * j * ib) / INERCIA;

  // Fricción: frena el deslizamiento de lado entre las carrocerías (tope de Coulomb: μ·j)
  const tx = -ny;
  const ty = nx;
  const vt = (vbx - vax) * tx + (vby - vay) * ty;
  const ta = rax * ty - ray * tx;
  const tb = rbx * ty - rby * tx;
  const jt = Math.max(-friccion * j, Math.min(friccion * j, -vt / (ia + ib + (ta * ta * ia + tb * tb * ib) / INERCIA)));
  a.vx -= jt * tx * ia;
  a.vy -= jt * ty * ia;
  b.vx += jt * tx * ib;
  b.vy += jt * ty * ib;
  a.w -= (ta * jt * ia) / INERCIA;
  b.w += (tb * jt * ib) / INERCIA;

  return { golpe: -vn, parteA };
}

/**
 * EL EMPUJÓN: qué tanto desvió el golpe a un carro (velocidad de lado, respecto a hacia donde
 * apunta, más el giro que le metió) decide cuánto dura su empujón. Un roce no hace nada; un
 * golpe fuerte de lado o en una punta lo deja casi sin agarre y girando, y sale de su línea.
 */
function empujar(c: EstadoCarro, antes: { vx: number; vy: number; w: number }, p: ParametrosFisica, parte: number): void {
  const e = p.choque.empujon;
  const lateral = Math.abs(-(c.vx - antes.vx) * Math.sin(c.angulo) + (c.vy - antes.vy) * Math.cos(c.angulo));
  // El giro cuenta como la velocidad de la punta del carro (2.2 m del centro)
  const desvio = lateral + Math.abs(c.w - antes.w) * 2.2;
  if (desvio <= e.umbral) return;
  const fuerza = Math.min(1, (desvio - e.umbral) / e.pleno);
  // Lo sufre el que no embistió: con todo el acercamiento tuyo, a ti no te descontrola
  c.empujon = Math.max(c.empujon ?? 0, e.duracion * fuerza * (1 - parte));
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
  via?: DireccionPista,
): { fuerza: number; descontrolados: EstadoCarro[] } {
  const descontrolados: EstadoCarro[] = [];
  // Uno volando sobre el otro: no se tocan
  if (Math.abs(a.z - b.z) > 1.2) return { fuerza: 0, descontrolados };
  // Los coletazos se revisan con las velocidades de llegada (en copias), pero su giro se suma
  // después del choque: si no, el impulso del golpe se lo comía
  const a0 = copiarCarro(a);
  const b0 = copiarCarro(b);
  // Con el casco (`pesado`) nadie te descontrola de un coletazo
  if (b.pesado <= 0 && coletazo(a0, b0, p, pasosPorSegundo)) descontrolados.push(b);
  if (a.pesado <= 0 && coletazo(b0, a0, p, pasosPorSegundo)) descontrolados.push(a);
  const antesA = { vx: a.vx, vy: a.vy, w: a.w };
  const antesB = { vx: b.vx, vy: b.vy, w: b.w };
  const { golpe: fuerza, parteA } = resolverChoque(a, b, p, via);
  if (fuerza > 0) {
    // Con el casco el empujón no te toca a ti: se lo lleva completo el otro
    const casco = (c: EstadoCarro) => c.pesado > 0
    const parteDeA = casco(a) && !casco(b) ? 1 : casco(b) && !casco(a) ? 0 : parteA
    if (!casco(a)) empujar(a, antesA, p, parteDeA);
    if (!casco(b)) empujar(b, antesB, p, 1 - parteDeA);
  }
  // Al descontrolado, el giro lo decide el coletazo (para el lado que barre la cola), no el impulso
  if (descontrolados.includes(a)) a.w = a0.w;
  if (descontrolados.includes(b)) b.w = b0.w;
  a.trompo = a0.trompo;
  b.trompo = b0.trompo;
  return { fuerza, descontrolados };
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
