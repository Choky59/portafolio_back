import type { EstadoCarro } from "../compartido/tipos";
import { enAgua, enBarranco, proyectar, puntoEnPista, type Pista } from "../compartido/pista";
import { PARAMETROS_FISICA } from "../compartido/fisica";
import { mitadPuenteEn } from "../compartido/excavacion";
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

/**
 * MULTIJUGADOR: cada bot llega con su agresividad (la misma para cazar y para estorbar), al azar en
 * este rango, y la conserva toda su estancia en la sala (todas las rondas). Así, con la rotación de
 * bots, cada sala se siente distinta. Van en Difícil y también contra otros bots (parecen personas)
 */
export const AGRESION_MULTI = [0.2, 0.9] as const;

/** La personalidad de un bot del multijugador, con esa agresividad */
export const personalidadMulti = (agresion: number): Personalidad => ({ nombre: "multi", detras: agresion, delante: agresion, velocidad: 1, contraBots: true });

/** Ninguna personalidad de la campaña pasa de esto (ni sorteada ni con rencor) */
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

/**
 * DIFÍCIL (la copa ya ganada en 1º): los bots no frenan nunca y van siempre a fondo. Su tope de
 * velocidad se sortea cada ronda hasta DIFICIL_VELOCIDAD_MAX (el ganador, siempre el máximo).
 * Ahora es 1: el mismo tope que el tuyo (con más de 100 % no había forma de alcanzarlos); la
 * dificultad viene de que nunca frenan
 */
export const DIFICIL_VELOCIDAD_MAX = 1;

/**
 * Ronda nueva: a cada bot de la campaña, una personalidad distinta al azar (y se le olvida el
 * rencor). En Difícil, además, su motor de esta ronda (ver DIFICIL_VELOCIDAD_MAX)
 */
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
    if (m.dificil) {
      const extra = DIFICIL_VELOCIDAD_MAX - 1;
      m.personalidad.velocidad = m.personalidad.nombre === "ganador" ? DIFICIL_VELOCIDAD_MAX : 1 + extra * azar();
    }
  });
}

/** Vulnerable (para el oportunista): empujado, en trompo, aturdido o a menos de 3 m de la orilla */
function vulnerable(pista: Pista, c: EstadoCarro, s: number): boolean {
  return c.empujon > 0 || c.trompo > 0 || c.aturdido > 0 || Math.abs(lateralEnPista(pista, c, s)) > mitadPuenteEn(pista, s) - 3;
}

/** La física de los bots: la de todos, sin la ayuda para salir de un choque (esa es solo para personas) */
const FISICA_BOT = { ...PARAMETROS_FISICA, recobro: { ...PARAMETROS_FISICA.recobro, activo: false } };

/** La física con la que corre un bot: la de todos (sin la ayuda de recuperación), con su tope de velocidad */
export function fisicaDe(personalidad: Personalidad) {
  if (personalidad.velocidad === 1) return FISICA_BOT;
  return { ...FISICA_BOT, velocidadMax: PARAMETROS_FISICA.velocidadMax * personalidad.velocidad };
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
  /** No se mueve (columnas, cierres de obra, la tubería): cerca, se rodea por el lado en el que ya va el bot */
  fijo?: boolean;
}

/** Medio ancho del carro más un margen: lo que tiene que quedar libre a cada lado de un riesgo (m) */
const ESQUIVE_HOLGURA = 2.4;
/** Hasta dónde más allá de su meta revisa riesgos (m) */
const ESQUIVE_MAS_ALLA = 15;
/** A menos de esto (m) un riesgo se rodea por el lado en el que ya va el bot (ver esquivar) */
const ESQUIVE_CERCA = 25;
/** Los riesgos de frente que se toman en cuenta, del más cercano al más lejano */
const ESQUIVE_MAX = 4;

/**
 * ESQUIVAR: el bot iba a pasar por `lateral` en los próximos `distancia` m (más un poco). Si un
 * riesgo le queda encima, se pasa al lado libre más cercano (dentro del camino, y sin caer en
 * otro riesgo de esa zona); si su línea pisa agua o barranco, se recorre hacia el centro.
 * Devuelve el nuevo lateral y la distancia al primer riesgo que lo obligó a moverse (Infinity: nada).
 * `actual`: por dónde va el bot ahora. Un riesgo cercano que quede entre donde va y a donde
 * quiere ir también cuenta (lo cruzaría en el camino), y se rodea por el lado en el que ya va
 */
export function esquivar(pista: Pista, s: number, distancia: number, lateral: number, riesgos: Riesgo[], actual?: number): { lateral: number; hasta: number } {
  const L = pista.longitud;
  const enfrente = riesgos
    .map((r) => ({ r, d: (((r.s - s) % L) + L) % L }))
    .filter((o) => o.d > 1 && o.d < distancia + ESQUIVE_MAS_ALLA)
    .sort((a, b) => a.d - b.d)
    .slice(0, ESQUIVE_MAX);
  const borde = Math.max(pista.mitad, ...enfrente.map(o => mitadPuenteEn(pista, o.r.s))) - 1.5;
  const choca = (lat: number, o: (typeof enfrente)[number]) => Math.abs(lat - o.r.lateral) < o.r.radio + ESQUIVE_HOLGURA;
  // Cerca, ¿lo cruzaría para llegar de donde va a `lat`? (está de un lado y quiere ir al otro)
  // Solo lo fijo: lo que se mueve (la aplanadora que cruza) cambia de lado, ahí manda a donde iba
  const cerca = (o: (typeof enfrente)[number]) => actual !== undefined && !!o.r.fijo && o.d < ESQUIVE_CERCA;
  const cruza = (lat: number, o: (typeof enfrente)[number]) =>
    cerca(o) && Math.sign(actual! - o.r.lateral) !== Math.sign(lat - o.r.lateral) && Math.abs(actual! - o.r.lateral) < o.r.radio + ESQUIVE_HOLGURA + 5;
  let lat = lateral;
  let hasta = Infinity;
  for (const o of enfrente) {
    if (!choca(lat, o) && !cruza(lat, o)) continue;
    const libre = o.r.radio + ESQUIVE_HOLGURA;
    // Cerca, el lado más a la mano es el de donde va ahora; lejos, el de a donde quería ir
    const desde = cerca(o) ? actual! : lat;
    const opciones = [o.r.lateral - libre, o.r.lateral + libre]
      .filter((x) => Math.abs(x) <= borde)
      .sort((a, b) => Math.abs(a - desde) - Math.abs(b - desde));
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
  /** La copa en Difícil: nunca frena, siempre a fondo (ver DIFICIL_VELOCIDAD_MAX) */
  dificil: boolean;
  /** Rencoroso al que le pegaron: contra quién va y hasta qué tick */
  rencor: { id: string; hasta: number } | null;
  /**
   * MULTIJUGADOR (ver estiloMulti): su carril se mece un poco con el tiempo (`amplitud` m, con su
   * `frecuencia` y `fase`), y en la tierra no vuelve a la calle por el camino corto: sigue y corta
   * hacia un punto más adelante
   */
  estilo?: { amplitud: number; frecuencia: number; fase: number };
}

/**
 * Cómo maneja un bot del multijugador, para que no vayan todos por el centro: su carril (de 2 a
 * 5.5 m del centro, a un lado al azar, en un camino de 14) y cómo se mece en él
 */
export function estiloMulti(m: MenteBot, azar: () => number = Math.random): void {
  m.carril = (azar() < 0.5 ? -1 : 1) * (2 + azar() * 3.5);
  m.estilo = { amplitud: 0.6 + azar() * 1.2, frecuencia: 0.15 + azar() * 0.25, fase: azar() * Math.PI * 2 };
}

/** `nivel` 0 (las copas fáciles y la carrera libre) … 4: más rápidos y precisos */
export function crearMente(azar: () => number = Math.random, nivel = 0, personalidad: Personalidad = personalidadNormal(), campania = false, dificil = false): MenteBot {
  return {
    seq: 0,
    habilidad: Math.min(1.02, 0.82 + azar() * 0.12 + nivel * 0.035),
    personalidad,
    campania,
    dificil,
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

  let adelanto = 9 + v * 0.45;
  // Multijugador en la tierra: no regresa por el camino corto, sigue y corta hacia más adelante
  const lateral = m.estilo ? lateralEnPista(pista, carro, s) : 0;
  const enTierra = !!m.estilo && Math.abs(lateral) > pista.mitad + 0.5;
  if (enTierra) adelanto = Math.max(adelanto, 30 + v * 0.9);
  // El carril (±3 m en un camino de 14) crece con el ancho: en los de 3 o 4 carriles usan todo.
  // En multijugador se mece un poco con el tiempo; desde la tierra entra por su orilla
  const meneo = m.estilo ? Math.sin((tick / tickHz) * m.estilo.frecuencia * Math.PI * 2 + m.estilo.fase) * m.estilo.amplitud : 0;
  const suCarril = enTierra
    ? Math.sign(lateral) * pista.mitad * 0.55
    : (Math.max(-5.8, Math.min(5.8, m.carril + meneo)) * mitadPuenteEn(pista, s + adelanto)) / 7;
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
    const esquive = esquivar(pista, s, dMeta, latMeta, riesgos, lateralEnPista(pista, carro, s));
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
  // Con la prisa de la ronda (fisica.ts) su tope también sube, como el de todos
  const vObjetivo = PARAMETROS_FISICA.velocidadMax * (carro.prisa ?? 1) * yo.velocidad * (habilidad + (1 - habilidad) * empuje) * enCurva;

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
    // Difícil: siempre a fondo y sin freno, ni en las curvas
    acel: m.dificil || v < vObjetivo ? 1 : 0,
    // Estorbando a alguien no frena por la maniobra (solo por las curvas, como siempre)
    freno: !m.dificil && v > vObjetivo + 6 ? 1 : 0,
    mano: Math.abs(error) > 0.75 && v > 14,
    item,
  };
}
