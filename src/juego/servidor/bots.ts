import type { EstadoCarro } from "../compartido/tipos";
import { enAgua, enBarranco, proyectar, puntoEnPista, type Pista } from "../compartido/pista";
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

/**
 * AGRESIVIDAD por omisión (0 … 1), contra las personas: estos bots no van contra otros bots.
 * Cada bot la lleva en su PERSONALIDAD (ver PERSONALIDADES, las de la campaña).
 *  - detras: si una persona va delante (hasta CAZA_M), la CAZA: apunta a donde va a estar (su
 *    posición + su velocidad, hasta ANTICIPO_S) y se atreve a más velocidad. Pegado a ella, eso
 *    es echársele encima de lado.
 *  - delante: si una persona va detrás (hasta ESTORBA_M), SIN FRENAR: lejos la BLOQUEA (se pasa a
 *    su carril); a menos de CERRON_M se le CIERRA (corta hacia su lado y se pasa CERRON_DE_MAS),
 *    cruzándose de lado frente a su trompa. Con la ventaja del que embiste (fisica.ts) el empujón
 *    se lo lleva la persona.
 * Se ajustan en el laboratorio del juego (/?testing), que usa la misma idea.
 */
export const AGRESIVIDAD = { detras: 0.2, delante: 0.2 };

export interface Personalidad {
  nombre: string;
  /** Agresividad si el otro va delante (lo caza) y si va detrás (lo estorba), 0 … AGRESIVIDAD_MAX */
  detras: number;
  delante: number;
  /** Tope de velocidad respecto al de todos (1.05: 5 % más). Va en su física (ver fisicaDe) */
  velocidad: number;
  /** ¿También va contra otros bots? (si no, solo contra personas) */
  contraBots: boolean;
  /** Oportunista: solo ataca a quien está vulnerable (ver vulnerable) */
  soloVulnerables?: boolean;
  /** Rencoroso: limpio hasta que le pegan; entonces va contra ESE carro con esta agresividad, tantos segundos */
  rencor?: { detras: number; delante: number; segundos: number };
}

/** Ninguna personalidad pasa de esto (ni sorteada ni con rencor) */
export const AGRESIVIDAD_MAX = 0.7;

/** La de los bots fuera de la campaña: AGRESIVIDAD contra las personas */
export const personalidadNormal = (): Personalidad => ({ nombre: "normal", ...AGRESIVIDAD, velocidad: 1, contraBots: false });

type Rango = [number, number];

/** Un molde de personalidad: sus agresividades son rangos, y en cada ronda se sortea un valor */
export interface Molde {
  nombre: string;
  detras: Rango;
  delante: Rango;
  velocidad: number;
  soloVulnerables?: boolean;
  rencor?: { detras: Rango; delante: Rango; segundos: number };
}

/**
 * LAS PERSONALIDADES DE LA CAMPAÑA. En cada ronda, cada bot toma una distinta al azar (rotarPersonalidades),
 * con sus agresividades sorteadas dentro del rango: nunca juegan igual dos rondas seguidas.
 * Se pelean con cualquiera (tú u otro bot), pero sin perder de vista que el chiste es ganar: solo
 * atacan a quien traen cerca y nunca frenan por atacar.
 *  - ganador: solo le interesa ganar. Más motor (105 %) y maneja a su máximo; casi no ataca.
 *  - cerrador: se te cierra cuando va delante; caza poco.
 *  - cazador: te caza cuando va detrás; se cierra poco.
 *  - rencoroso: limpio, hasta que alguien le pega; entonces va contra ese, fuerte, unos segundos.
 *  - oportunista: solo ataca a quien ya está vulnerable (empujado, en trompo, aturdido o en la
 *    orilla de la pista): remata.
 */
export const MOLDES: Molde[] = [
  { nombre: "ganador", detras: [0, 0.1], delante: [0, 0.1], velocidad: 1.05 },
  { nombre: "cerrador", detras: [0.15, 0.35], delante: [0.4, 0.7], velocidad: 1 },
  { nombre: "cazador", detras: [0.4, 0.7], delante: [0.15, 0.35], velocidad: 1 },
  { nombre: "rencoroso", detras: [0, 0.1], delante: [0, 0.1], velocidad: 1, rencor: { detras: [0.5, 0.7], delante: [0.4, 0.7], segundos: 8 } },
  { nombre: "oportunista", detras: [0.4, 0.7], delante: [0.4, 0.7], velocidad: 1, soloVulnerables: true },
];

/** Una personalidad de `molde`, con sus agresividades sorteadas (nunca más de AGRESIVIDAD_MAX) */
export function sortearPersonalidad(molde: Molde, azar: () => number = Math.random): Personalidad {
  const sortear = ([min, max]: Rango) => Math.min(AGRESIVIDAD_MAX, min + (max - min) * azar());
  return {
    nombre: molde.nombre,
    detras: sortear(molde.detras),
    delante: sortear(molde.delante),
    velocidad: molde.velocidad,
    contraBots: true,
    ...(molde.soloVulnerables ? { soloVulnerables: true } : {}),
    ...(molde.rencor ? { rencor: { detras: sortear(molde.rencor.detras), delante: sortear(molde.rencor.delante), segundos: molde.rencor.segundos } } : {}),
  };
}

/** Ronda nueva: a cada bot de la campaña, una personalidad distinta al azar (y se le olvida el rencor) */
export function rotarPersonalidades(mentes: MenteBot[], azar: () => number = Math.random): void {
  const moldes = [...MOLDES];
  // Fisher-Yates con el azar de la sala
  for (let i = moldes.length - 1; i > 0; i--) {
    const k = Math.floor(azar() * (i + 1));
    [moldes[i], moldes[k]] = [moldes[k], moldes[i]];
  }
  mentes.forEach((m, i) => {
    m.personalidad = sortearPersonalidad(moldes[i % moldes.length], azar);
    m.rencor = null;
  });
}

/** Vulnerable (para el oportunista): empujado, en trompo, aturdido o a menos de 3 m de la orilla */
function vulnerable(pista: Pista, c: EstadoCarro, s: number): boolean {
  return c.empujon > 0 || c.trompo > 0 || c.aturdido > 0 || Math.abs(lateralEnPista(pista, c, s)) > pista.mitad - 3;
}

/** La física con la que corre un bot: la de todos, con su tope de velocidad */
export function fisicaDe(personalidad: Personalidad) {
  if (personalidad.velocidad === 1) return PARAMETROS_FISICA;
  return { ...PARAMETROS_FISICA, velocidadMax: PARAMETROS_FISICA.velocidadMax * personalidad.velocidad };
}
const CAZA_M = 70;
/** Desde este peligro de salirse de la imagen ya no ataca a nadie: solo corre */
export const PELIGRO_SIN_ATAQUE = 0.8;
const ANTICIPO_S = 0.6;
const ESTORBA_M = 50;
const CERRON_M = 10;
const CERRON_DE_MAS = 2;

/** Qué tan a un lado del centro de la pista va un carro (m; el mismo signo que `lateral` en puntoEnPista) */
export function lateralEnPista(pista: Pista, c: { x: number; y: number }, s: number): number {
  const centro = puntoEnPista(pista, s, 0);
  return (c.x - centro.x) * -Math.sin(centro.angulo) + (c.y - centro.y) * Math.cos(centro.angulo);
}

/**
 * Algo en la pista que conviene no pisar (lo arma la Sala cada tick, ver Sala.riesgos): dónde
 * está, qué tan grande es, y dónde queda en la pista (`s` y `lateral`, para no proyectarlo en
 * cada bot)
 */
export interface Riesgo {
  x: number;
  y: number;
  radio: number;
  s: number;
  lateral: number;
}

/** Medio ancho del carro más un margen: lo que tiene que quedar libre a cada lado de un riesgo (m) */
const ESQUIVE_HOLGURA = 2.4;
/** Hasta dónde más allá de su meta revisa riesgos (m) */
const ESQUIVE_MAS_ALLA = 15;
/** Los riesgos de frente que se toman en cuenta, del más cercano al más lejano */
const ESQUIVE_MAX = 4;

/**
 * ESQUIVAR: el bot iba a pasar por `lateral` en los próximos `distancia` m (más un poco). Si un
 * riesgo le queda encima, se pasa al lado libre más cercano (dentro del camino, y sin caer en
 * otro riesgo de esa zona); si su línea pisa agua o barranco, se recorre hacia el centro.
 * Devuelve el nuevo lateral y la distancia al primer riesgo que lo obligó a moverse (Infinity: nada).
 */
export function esquivar(pista: Pista, s: number, distancia: number, lateral: number, riesgos: Riesgo[]): { lateral: number; hasta: number } {
  const L = pista.longitud;
  const borde = pista.mitad - 1.5;
  const enfrente = riesgos
    .map((r) => ({ r, d: (((r.s - s) % L) + L) % L }))
    .filter((o) => o.d > 1 && o.d < distancia + ESQUIVE_MAS_ALLA)
    .sort((a, b) => a.d - b.d)
    .slice(0, ESQUIVE_MAX);
  const choca = (lat: number, o: (typeof enfrente)[number]) => Math.abs(lat - o.r.lateral) < o.r.radio + ESQUIVE_HOLGURA;
  let lat = lateral;
  let hasta = Infinity;
  for (const o of enfrente) {
    if (!choca(lat, o)) continue;
    const libre = o.r.radio + ESQUIVE_HOLGURA;
    const opciones = [o.r.lateral - libre, o.r.lateral + libre]
      .filter((x) => Math.abs(x) <= borde)
      .sort((a, b) => Math.abs(a - lat) - Math.abs(b - lat));
    // No cabe por ningún lado (un charco de lado a lado): mejor por donde ya iba
    if (!opciones.length) continue;
    // De preferencia el lado que no cae en otro riesgo de la misma zona
    lat = opciones.find((x) => !enfrente.some((q) => q !== o && Math.abs(q.d - o.d) < 12 && choca(x, q))) ?? opciones[0];
    hasta = Math.min(hasta, o.d);
  }
  // Agua y barrancos: eliminan. Si la línea los pisa, hacia el centro hasta que no
  for (let d = 4; d <= distancia + 10; d += 4) {
    for (let intento = 0; intento < 6; intento++) {
      const p = puntoEnPista(pista, s + d, lat);
      if (!enAgua(pista, p.x, p.y) && !enBarranco(pista, p.x, p.y)) break;
      lat -= Math.sign(lat || 1) * 1.5;
      hasta = Math.min(hasta, d);
    }
  }
  return { lateral: lat, hasta };
}

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
  /** Cómo maneja: agresividad, motor y contra quién (ver MOLDES) */
  personalidad: Personalidad;
  /** De la campaña: su personalidad cambia cada ronda (rotarPersonalidades) */
  campania: boolean;
  /** Rencoroso al que le pegaron: contra quién va y hasta qué tick */
  rencor: { id: string; hasta: number } | null;
}

/** `nivel` 0 (las copas fáciles y la carrera libre) … 4: más rápidos y precisos */
export function crearMente(azar: () => number = Math.random, nivel = 0, personalidad: Personalidad = personalidadNormal(), campania = false): MenteBot {
  return {
    seq: 0,
    habilidad: Math.min(1.02, 0.82 + azar() * 0.12 + nivel * 0.035),
    personalidad,
    campania,
    rencor: null,
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
  /** Los demás carros vivos, si son bots y su id: contra quién va su agresividad (ver Personalidad) */
  presas: (EstadoCarro | { carro: EstadoCarro; bot: boolean; id?: string })[] = [],
  /**
   * Qué tan cerca está de salirse de la imagen (0 … 1, ver Sala.peligroFuera). Lo primero es no
   * quedar fuera: con peligro ataca menos (nada desde PELIGRO_SIN_ATAQUE) y corre a su máximo
   */
  peligro = 0,
  /** Lo que hay que esquivar en la pista (ver esquivar): va antes que atacar */
  riesgos: Riesgo[] = [],
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
  // El carril (±3 m en un camino de 14) crece con el ancho: en los de 3 o 4 carriles usan todo
  const suCarril = (m.carril * pista.mitad) / 7;
  let meta: { x: number; y: number } = puntoEnPista(pista, s + adelanto, suCarril);

  // La persona más cercana por la pista: positivo si va delante del bot
  let presa: EstadoCarro | null = null;
  let ventaja = Infinity;
  const personalidad = m.personalidad;
  // Rencoroso con rencor vigente: solo ve a quien le pegó, con su agresividad de rencor
  const rencor = m.rencor && personalidad.rencor && tick < m.rencor.hasta ? m.rencor : null;
  const yo = rencor && personalidad.rencor ? { ...personalidad, ...personalidad.rencor } : personalidad;
  for (const presaO of presas) {
    const { carro: p, bot, id } = "carro" in presaO ? presaO : { carro: presaO, bot: false, id: undefined };
    if (p === carro) continue;
    if (rencor ? id !== rencor.id : bot && !yo.contraBots) continue;
    const L = pista.longitud;
    const sP = proyectar(pista, p.x, p.y, p.indice).s;
    if (!rencor && yo.soloVulnerables && !vulnerable(pista, p, sP)) continue;
    const d = ((((sP - s) % L) + L * 1.5) % L) - L / 2;
    if (Math.abs(d) < Math.abs(ventaja)) {
      ventaja = d;
      presa = p;
    }
  }
  // Cerca de salirse de la imagen pelear no vale la pena: quedarse en ella es lo primero
  const calma = peligro >= PELIGRO_SIN_ATAQUE ? 0 : (1 - peligro) ** 2;
  const caza = presa && puedeMoverse && ventaja > -2 && ventaja < CAZA_M ? yo.detras * calma : 0;
  const atras = -ventaja;
  const estorba = presa && puedeMoverse && atras >= 2 && atras < ESTORBA_M ? yo.delante * calma : 0;
  if (presa && caza > 0) {
    const t = Math.min(ANTICIPO_S, Math.hypot(presa.x - carro.x, presa.y - carro.y) / Math.max(10, v));
    const x = presa.x + presa.vx * t;
    const y = presa.y + presa.vy * t;
    meta = { x: meta.x + (x - meta.x) * caza, y: meta.y + (y - meta.y) * caza };
  } else if (presa && estorba > 0) {
    const suLado = lateralEnPista(pista, presa, s - atras);
    const miLado = lateralEnPista(pista, carro, s);
    const cerron = atras < CERRON_M;
    const objetivo = cerron ? suLado + Math.sign(suLado - miLado || 1) * CERRON_DE_MAS : suLado;
    meta = puntoEnPista(pista, s + (cerron ? 8 : adelanto), suCarril + (objetivo - suCarril) * estorba);
  }
  // Esquivar va antes que atacar: si la línea hacia la meta pisa un riesgo, se pasa junto a él
  if (riesgos.length || pista.circuito.agua?.length || pista.circuito.barrancos?.length) {
    const L = pista.longitud;
    const sMeta = proyectar(pista, meta.x, meta.y, carro.indice).s;
    const dMeta = (((sMeta - s) % L) + L) % L;
    const latMeta = lateralEnPista(pista, meta, sMeta);
    const esquive = esquivar(pista, s, dMeta, latMeta, riesgos);
    if (esquive.lateral !== latMeta) meta = puntoEnPista(pista, s + Math.max(6, Math.min(dMeta, esquive.hasta)), esquive.lateral);
  }
  const error = diferencia(Math.atan2(meta.y - carro.y, meta.x - carro.x), carro.angulo);

  if (m.reversa > 0) {
    m.reversa--;
    return { seq: m.seq, giro: error > 0 ? -1 : 1, acel: 0, freno: 1, mano: false, item: false };
  }

  // Qué tan cerrada viene la curva: cuánto cambia la dirección de la pista más adelante
  const curva = Math.abs(diferencia(puntoEnPista(pista, s + adelanto + 25).angulo, puntoEnPista(pista, s + adelanto).angulo));
  const enCurva = curva > 0.9 ? 0.45 : curva > 0.5 ? 0.62 : curva > 0.25 ? 0.82 : 1;
  // Cazando se atreve a más, hasta el máximo según la agresividad (las curvas se siguen respetando)
  // El que solo quiere ganar (más motor) va siempre a su máximo
  const habilidad = yo.velocidad > 1 ? Math.max(1, m.habilidad) : m.habilidad;
  // Cazando, o en peligro de salirse de la imagen, se atreve a más (hasta su máximo)
  const empuje = Math.max(caza, peligro);
  const vObjetivo = PARAMETROS_FISICA.velocidadMax * yo.velocidad * (habilidad + (1 - habilidad) * empuje) * enCurva;

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
    // Estorbando a alguien no frena por la maniobra (solo por las curvas, como siempre)
    freno: v > vObjetivo + 6 ? 1 : 0,
    mano: Math.abs(error) > 0.75 && v > 14,
    item,
  };
}
