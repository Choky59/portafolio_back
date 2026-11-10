import { MecanicasExcavacion } from "./excavacion";
import { riesgosExcavacion } from "../compartido/excavacion";
import { actualizarEscenario, empacarEscenario, restaurarEscenario } from "../compartido/escenario";
import type { Circuito, EstadoCarro, Item } from "../compartido/tipos";
import { alturaEn, cajasDelCircuito, carriles, centroDeCarril, enAgua, enCierre, medidasTuberia, murosDeEntidad, rampasDeEntidad, prepararPista, proyectar, puntoEnPista, direccionPista, type Pista, type Segmento } from "../compartido/pista";
import { ALTURA_LIBRE, PARAMETROS_FISICA, avanzarCarro, enElAire, prisaDeRonda, chocarCarros, circulosCarro, colisionFija, colisionMuros, crearCarro } from "../compartido/fisica";
import { PARAMETROS_CAMARA_PARTIDA, ajustarZoom, crearCamara, enVista, seguir, type Camara } from "../compartido/camara";
import {
  CATEGORIAS,
  COLORES,
  FASES,
  FASES_CON_MANEJO,
  LISTO_BOTS,
  MAX_JUGADORES,
  PREPARACION_MS,
  RESULTADOS_MULTI_S,
  VEHICULOS,
  VEHICULOS_DE_PAGA,
  LIMITE_STICKERS,
  PUNTOS_POR_LUGAR,
  STICKERS,
  STICKERS_GRATIS,
  VICTORIAS,
  empacarCarro,
  red3,
  red4,
  type ControlesRed,
  type DatosJugador,
  type EstadoPartida,
  type EstadoSala,
  type Evento,
  type Fase,
  type Instantanea,
  type SalaAbierta,
  type Vehiculo,
} from "../compartido/protocolo";
import {
  DURACION,
  METEORITO,
  REZAGO,
  actualizarProgreso,
  alBorde,
  BORDE_VISTA,
  distanciaRecorrida,
  revisarEliminacion,
  type MotivoEliminacion,
  type Progreso,
} from "./reglas";
import { MECANICAS, TRAMO, TRAMO_CLAVOS, esEstorbo, etapaDebida, sacarItem, type Conductor, type Efecto, type Entidad, type MundoItems } from "./items";
import { MOLDES, NOMBRES_BOT, crearMente, fisicaDe, lateralEnPista, pensar, rotarPersonalidades, sortearPersonalidad, type MenteBot, type Riesgo } from "./bots";

/**
 * Las cajas de items se recogen a esta distancia y tardan esto en volver a salir. Las filas son de
 * 3 cajas separadas 4.2 m: con este radio cubren todo el ancho del camino, sin huecos.
 * Las que flotan después de una rampa solo se agarran volando: la altura del carro tiene que
 * quedar a menos de ALTO_CAJA de la de la caja.
 */
const RADIO_CAJA = 3.4;
const ALTO_CAJA = 2;
const CAJA_APAGADA = 8;

/**
 * Una caja: en su lugar del circuito (cajasDelCircuito) y de un color al azar (CATEGORIAS) que
 * cambia cada vez que vuelve a salir: solo da items de esa categoría
 */
interface Caja {
  x: number;
  y: number;
  /** Altura sobre el suelo: 0 en el camino; las de las rampas flotan */
  z: number;
  /** Índice en CATEGORIAS */
  categoria: number;
  /** Apagada hasta este tick */
  hasta: number;
}

/**
 * Las salas viven solo en memoria: se crean con un código corto (HMO-4821) y se borran
 * cuando se queda vacía la última persona.
 */

/**
 * Cada control se aplica EN CUANTO LLEGA, no en el siguiente tick. Así el servidor aplica
 * exactamente los mismos controles, en el mismo orden y con el mismo paso, que la predicción
 * del navegador: con la física determinista el resultado es idéntico y el carro no "se devuelve".
 * (Esperar al tick tiraba controles cuando llegaban en ráfaga y repetía el último cuando no
 * llegaba ninguno; cada vez la predicción fallaba.)
 *
 * Para que nadie vaya más rápido mandando controles de más, cada jugador tiene un balde de
 * créditos: cada tick suma CREDITO_POR_TICK (un poco más de 1, por si su reloj corre un pelo
 * más rápido que el del servidor) y cada control aplicado gasta 1. Sin crédito, el control espera.
 */
const CREDITO_POR_TICK = 1.05;
/**
 * Peligro de salirse de la imagen para los bots (Sala.peligroFuera): en la orilla (el 40 % de
 * afuera de la imagen, margen -0.4) y en el borde (donde ya les dan rezago)
 */
const PELIGRO = { zona: 0.4, margenZona: -0.4, borde: 0.8 };
/**
 * Lo que los bots esquivan (por la `mecanica` del item): lo que pega, frena, resbala, poncha o
 * explota. Lo que no tiene radio (el andamio, que va de lado a lado) cuenta con RADIO_RIESGO
 */
const MECANICAS_RIESGO = new Set([
  "mina", "mancha", "obstaculo", "estorbo", "crece", "alfombra", "fragua", "barrera", "cruce", "meteorito", "rodante", "misil", "persona",
  "escombro",
]);
const RADIO_RIESGO = 2;
/** Lo más que se junta en el balde, en segundos de controles (a cualquier tickHz) */
const MAX_CREDITOS_S = 0.2;
/** Controles en espera (en segundos). Más que esto es un cliente atorado: se tiran los viejos */
const MAX_COLA_S = 0.33;
const MIN_JUGADORES_PARTIDA = 2;
/** Qué tan a un lado del centro (m) queda (x, y), que está en `s` de la pista */
function lateralDe(pista: Pista, x: number, y: number, s: number): number {
  const c = puntoEnPista(pista, s, 0);
  return (x - c.x) * -Math.sin(c.angulo) + (y - c.y) * Math.cos(c.angulo);
}

/** El dueño de las trampas que pone el laboratorio (no es nadie: le afectan a todos) */
const DUENO_TRAMPA = "laboratorio";

/**
 * UNA COPA DE LA CAMPAÑA que lleva esta sala: el servidor decide su resultado (las monedas
 * dependen de él). Las pistas van en orden; al terminar cada partida se suman los puntos de copa
 * por lugar (PUNTOS_POR_LUGAR) y, en la última, queda el lugar final del dueño en `final`, que el
 * socket premia una vez (monedero.ts)
 */
export interface CopaEnSala {
  id: string;
  dificil: boolean;
  pistas: string[];
  indice: number;
  puntos: Record<string, number>;
  /** El dueño: su id en la sala y su cuenta */
  dueno: string;
  uid: string;
  /** Ya se contó la partida de la pista actual */
  contada: boolean;
  final: { lugar: number; puntos: number } | null;
  premiada: boolean;
}
/** Suma a `puntos` los puntos de copa de una pista, por lugar (`lugares`: ids, del 1º al último) */
export function sumarPista(puntos: Record<string, number>, lugares: readonly string[]): void {
  lugares.forEach((id, lugar) => (puntos[id] = (puntos[id] ?? 0) + (PUNTOS_POR_LUGAR[lugar] ?? 0)));
}

/** El lugar final de `yo` por puntos de copa; empatados, el que quedó mejor en la última pista (`ultimos`) */
export function finalDeCopa(puntos: Record<string, number>, ultimos: readonly string[], yo: string): { lugar: number; puntos: number } {
  const final = ultimos
    .map((id, orden) => ({ id, orden }))
    .sort((a, b) => (puntos[b.id] ?? 0) - (puntos[a.id] ?? 0) || a.orden - b.orden)
    .map((j) => j.id);
  return { lugar: final.indexOf(yo) + 1, puntos: puntos[yo] ?? 0 };
}

/**
 * El resultado de una copa completa a partir de los lugares de cada pista (ids, del 1º al
 * último): lo mismo que cuenta la sala (contarCopa). El servidor lo usa con lo que informa el
 * navegador cuando la copa se jugó en local
 */
export function resultadoCopa(pistas: readonly (readonly string[])[], yo: string): { lugar: number; puntos: number } {
  const puntos: Record<string, number> = {};
  for (const lugares of pistas) sumarPista(puntos, lugares);
  return finalDeCopa(puntos, pistas.at(-1) ?? [], yo);
}

/**
 * EL TUTORIAL (la primera vez que alguien juega): tres lecciones, una por ronda, en una sala con
 * dos bots tranquilos.
 *   1 Manejar: solo tú en la pista (los bots no corren). Termina a los `segundos`; si te caes, se repite.
 *   2 Chocar: los bots corren contigo, sin atacarte y sin items: échateles encima y sácalos de la
 *     imagen. Un choque tuyo los manda MUY lejos (`golpe`), para que la lección no se alargue.
 *   3 Items: siempre traes un item de ataque (vuelve un momento después de usarlo).
 * Siempre sales en primer lugar. Cada lección dura a lo más sus `segundos` (gana el que va
 * adelante). La cuenta es más larga, para leer qué toca. Al terminar la tercera, la partida pasa a resultados con la persona como ganadora
 */
export const TUTORIAL = {
  lecciones: 3,
  circuito: "hermosillo",
  bots: 2,
  segundos: [16, 40, 40],
  cuentaExtra: 3,
  /** El item que se lanza en la lección 3, y cuánto tarda en volver después de usarlo (s) */
  item: "burro",
  recargaItem: 1.2,
  /**
   * Cuando chocas a un bot: lo que lo mueve el choque se multiplica por `multiplica` (y es al menos
   * `minimo` m/s, a lo más `maximo`), y queda sin agarre (empujado) `empujonS` segundos: se desvía muchísimo
   */
  golpe: { multiplica: 3.5, minimo: 9, maximo: 20, empujonS: 1.2 },
  /**
   * Lección 2: tu tope de velocidad es el de los bots (`igual`, su habilidad). Si les sacas más de
   * `desde` metros, baja solo hasta `minimo` (a los `hasta` metros), para que te alcancen y los
   * puedas chocar. Cambia poco a poco (`cambio` por segundo). Va en la `prisa` de tu carro, que el
   * navegador ya predice: no hay correcciones
   */
  ritmo: { igual: 0.84, desde: 18, hasta: 40, minimo: 0.55, cambio: 0.6 },
  /**
   * RUBBER BANDING (lecciones 2 y 3): si te quedas atrás del bot de adelante más de `desde` metros,
   * tú vas más rápido (hasta `impulso` veces el tope de la ronda) y los bots más lento (hasta
   * `botsMinimo`), al máximo a los `hasta` metros. Cambia rápido (`cambio` por segundo) para que no
   * te saquen ventaja. Lo tuyo va en tu `prisa` (el navegador lo predice); lo de los bots, en la suya
   */
  alcance: { desde: 3, hasta: 22, impulso: 1.25, botsMinimo: 0.6, cambio: 1.5 },
} as const;
/** Los bots del tutorial: no atacan y van un poco por debajo de su máximo, para alcanzarlos */
const PERSONALIDAD_TUTORIAL = { nombre: "tutorial", detras: 0, delante: 0, velocidad: 1, contraBots: false };
const HABILIDAD_TUTORIAL = TUTORIAL.ritmo.igual;

/** Metros entre un lugar de la parrilla y el siguiente */
const SEPARACION_PARRILLA = 5;
/** Qué tan alto es el techo de un carro (m): caerle encima dentro de esto lo aplasta */
const ALTO_TECHO = 1.5;
/** Al empezar una ronda, las cajas a esta distancia de la parrilla se apagan un rato (nadie arranca con item) */
const CAJAS_LEJOS_DE_PARRILLA = 25;
/** Al empezar una ronda, lo que persiste a esta distancia de la parrilla se quita (nadie sale encima de un poste) */
const PERSISTENTES_LEJOS_DE_PARRILLA = 20;
/** Cuántas cosas permanentes (postes, baches, charcos, asadores) puede haber a la vez */
const MAX_PERSISTENTES = 30;
/**
 * Un bache cambia de etapa (señalización, tablas) solo cuando nadie lo ve: en la partida, fuera
 * de la imagen de la cámara compartida con este margen de sobra; en la sala de espera (cada quien
 * con su cámara), sin ningún carro a menos de esta distancia (m)
 */
const MARGEN_SIN_VER = 0.3;
const LEJOS_SIN_VER = 90;
/**
 * Personaje de la calle: sale cada CALLE_CADA segundos (al azar entre los dos), a lo más
 * CALLE_MAX a la vez, en medio del camino entre CALLE_ADELANTE metros delante del que va adelante
 */
const CALLE_CADA = [12, 12];
const CALLE_MAX = 3;
const CALLE_ADELANTE = [120, 200];

interface Jugador {
  id: string;
  nombre: string;
  color: string;
  vehiculo: Vehiculo;
  /** Su barra de stickers del festejo (la de su cuenta; los bots usan todos) */
  stickers: string[];
  /** Lugar en la parrilla de salida (0 … 3) */
  lugar: number;
  carro: EstadoCarro;
  cola: ControlesRed[];
  creditos: number;
  ultimoSeq: number;
  vivo: boolean;
  /** Ticks seguidos fuera de la imagen de la cámara */
  fuera: number;
  progreso: Progreso;
  puntos: number;
  /** Índice del item que trae (-1: ninguno) */
  item: number;
  /** Cómo venía la tecla del item en el control anterior: se usa al apretarla, no al mantenerla */
  itemPrevio: boolean;
  /** El item del turbo en curso, para empujar con él */
  turboItem: number;
  /** Si es bot, su piloto; null para personas */
  mente: MenteBot | null;
  /**
   * Quien maneja el carro en el fin de ronda (persona o bot): el que quedó en pie sigue solo,
   * como bot, mientras la cámara del festejo lo sigue. Se crea al terminar la ronda
   */
  piloto: MenteBot | null;
  /** Desde qué tick puede tirar otro meteorito (de espectador) */
  meteoritoListo: number;
  /** Listo para la siguiente partida (sala de espera y resultados) */
  listo: boolean;
  /** Multijugador: en qué tick dice "listo" este bot (null: ya lo dijo, o no toca) */
  listoEn: number | null;
}

export class Sala implements MundoItems {
  readonly jugadores = new Map<string, Jugador>();
  /** El mapa: se puede cambiar entre partidas (cambiarCircuito) */
  circuito: Circuito;
  pista: Pista;
  private excavacion: MecanicasExcavacion;
  tick = 0;
  estadoHz: number;

  /** Lo que anda suelto en la pista (burros, baches, coyotas…) */
  entidades: Entidad[] = [];
  private siguienteEntidad = 1;
  /** Las cajas de items: dónde están ahora, de qué color y hasta cuándo están apagadas */
  cajas: Caja[];
  /** Quién explotó en esta ronda, en orden */
  private caidos: string[] = [];
  /** Orden de la parrilla para la siguiente ronda (el primero sale hasta adelante) */
  private ordenSalida: string[] = [];
  /** Lo más que ha avanzado el que va adelante (m): el reloj de vueltas de los baches */
  private avanceMax = 0;
  /** Desde qué tick puede salir el siguiente personaje de la calle */
  private proximaCalle: number;

  fase: Fase = "espera";
  /** Ticks que le quedan a la fase actual (cuenta y ronda-fin) */
  private restante = 0;
  /** Ticks desde que arrancó la carrera actual */
  private ticksCarrera = 0;
  /** En qué tick de la carrera sale el siguiente cierre de obra (circuito.obras) */
  private obraEn = 0;
  /** En qué tick de la carrera se revisa otra vez la tubería (circuito.tuberia), y si el primero ya llegó a ella */
  private tuberiaEn = 0;
  private tuberiaAlcanzada = false;
  /** Los puntos que esquivan los bots de cada cierre de obra (por id de entidad: no se mueven) */
  private riesgosObra = new Map<number, Riesgo[]>();
  ronda = 0;
  ganadorRonda: string | null = null;
  /** Los stickers del festejo: cuántos puso el ganador y en qué tick el último */
  private stickers = { puestos: 0, ultimo: -Infinity };
  /** Si ganó un bot: en qué tick pone su sticker (null: ya lo puso o no toca) */
  private stickerBotEn: number | null = null;
  ganador: string | null = null;
  readonly camara: Camara = crearCamara();

  /** Reportes ya registrados en esta sala ("quien>reportado"), para no repetirlos */
  readonly reportes = new Set<string>();

  /** Lo que pasó desde la última vez que se leyó (lo manda el socket) */
  eventos: Evento[] = [];
  /** La fase, la ronda o los puntos cambiaron: hay que avisar */
  cambioPartida = false;

  constructor(
    readonly codigo: string,
    circuito: Circuito,
    readonly tickHz: number,
    /** Victorias para ganar la partida: el anfitrión la cambia entre partidas (cambiarMeta) */
    public meta = 5,
    readonly items: Item[] = [],
    readonly azar: () => number = Math.random,
  ) {
    this.estadoHz = Math.min(30, tickHz);
    this.circuito = circuito;
    this.pista = prepararPista(circuito);
    this.excavacion = new MecanicasExcavacion(this.pista);
    this.cajas = this.cajasNuevas();
    this.proximaCalle = this.ticks(CALLE_CADA[0]);
  }

  private cajasNuevas(): Caja[] {
    const cajas = cajasDelCircuito(this.circuito).map(([x, y, z]) => ({ x, y, z, categoria: 0, hasta: 0 }));
    cajas.forEach((caja) => this.pintarCaja(caja));
    return cajas;
  }

  /** Modo local: el id de la pantalla (la anfitriona, sin carro), o null */
  pantalla: string | null = null;

  /** La copa de la campaña que se corre en esta sala, o null (ver CopaEnSala) */
  copa: CopaEnSala | null = null;

  /**
   * SALA MULTIJUGADOR (o null): se llena con bots que llegan con el tiempo, cada partida cuesta un
   * boleto y paga por lugar (eso lo hace el socket). `privada`: solo se entra con el código.
   * `partidas`: las que ya empezaron. `pagada`: la partida que acaba de terminar ya se premió
   */
  multi: { privada: boolean; partidas: number; pagada: boolean } | null = null;

  /** La preparación antes de la partida multijugador: en qué tick termina (null: no hay) */
  private preparacionHasta: number | null = null;

  /** Va corriendo la preparación (vehículo y stickers) antes de la partida */
  get preparando(): boolean {
    return this.preparacionHasta !== null;
  }

  /**
   * Empieza la preparación de una partida multijugador: dos pasos de PREPARACION_MS (vehículo y
   * stickers) en la sala de espera; al terminar, la partida (iniciarPartida). Devuelve un error o null
   */
  empezarPreparacion(): string | null {
    if (!this.entrePartidas) return "La partida ya empezó";
    if (this.preparando) return null;
    if (this.jugadores.size < MIN_JUGADORES_PARTIDA) return `Se necesitan al menos ${MIN_JUGADORES_PARTIDA} jugadores`;
    if (this.fase === "resultados") this.volverAEspera();
    this.preparacionHasta = this.tick + this.ticks((2 * PREPARACION_MS) / 1000);
    if (this.multi) {
      this.multi.partidas++;
      this.multi.pagada = false;
    }
    for (const j of this.jugadores.values()) {
      j.listo = false;
      j.listoEn = null;
    }
    this.cambioPartida = true;
    return null;
  }

  /** Todos terminaron de escoger (vehículo y stickers): la partida empieza ya, sin esperar el reloj */
  adelantarPreparacion(): void {
    if (this.preparando) this.preparacionHasta = this.tick;
  }

  private cancelarPreparacion(): void {
    if (!this.preparando) return;
    this.preparacionHasta = null;
    this.cambioPartida = true;
  }

  /**
   * Una persona quiere entrar y no hay lugar: si la sala está llena por los bots (y en la sala de
   * espera, sin preparación), se va el último bot que llegó. Devuelve si hay lugar
   */
  hacerLugar(): boolean {
    if (this.jugadores.size < MAX_JUGADORES) return true;
    if (this.fase !== "espera" || this.preparando) return false;
    const bot = [...this.jugadores.values()].filter((j) => j.mente).at(-1);
    if (!bot) return false;
    this.quitar(bot.id);
    return true;
  }

  /**
   * Los lugares finales de la partida (ids, del 1º al último): el ganador primero, luego por
   * puntos; empatados, el orden de la sala
   */
  lugaresFinales(): string[] {
    return [...this.jugadores.values()]
      .sort((a, b) => a.lugar - b.lugar)
      .map((j, orden) => ({ id: j.id, orden, puntos: j.puntos }))
      .sort((a, b) => Number(b.id === this.ganador) - Number(a.id === this.ganador) || b.puntos - a.puntos || a.orden - b.orden)
      .map((j) => j.id);
  }

  /** El tutorial (ver TUTORIAL): la lección que va, y cuándo vuelve el item de la lección 3 (tick) */
  tutorial: { leccion: number; itemEn: number | null; ritmo: number; ritmoBots: number } | null = null;

  /** Convierte la sala en la del tutorial: sus bots tranquilos y la lección 1 */
  prepararTutorial(): void {
    this.tutorial = { leccion: 1, itemEn: null, ritmo: 1, ritmoBots: 1 };
    this.meta = TUTORIAL.lecciones;
    for (let i = 0; i < TUTORIAL.bots; i++) {
      if (this.agregarBot(0)) break;
    }
    for (const j of this.jugadores.values()) {
      if (!j.mente) continue;
      j.mente.personalidad = { ...PERSONALIDAD_TUTORIAL };
      j.mente.habilidad = HABILIDAD_TUTORIAL;
    }
  }

  /** Pares de jugadores ("a|b", ordenados) que no chocan entre sí hasta ese tick (el imán al alcanzar) */
  private readonly sinChoque = new Map<string, number>();

  ignorarChoque(a: string, b: string, segundos: number): void {
    this.sinChoque.set([a, b].sort().join("|"), this.tick + Math.round(segundos * this.tickHz));
  }

  /**
   * Laboratorio (JUEGO_PRUEBAS): una trampa (índice) que se pone adelante de la salida en cada
   * ronda, a esos metros, para probarla en carne propia (ver ponerTrampasPrueba)
   */
  trampaPrueba: { item: number; metros: number[] } | null = null;

  /** Laboratorio (JUEGO_PRUEBAS): jugador → índice del item que tiene siempre (lo recupera al usarlo) */
  readonly itemsFijos = new Map<string, number>();

  /**
   * Terminó la partida de una sala de copa: los lugares (por puntos de la partida; empatados, en
   * el orden de la sala, igual que el navegador) suman puntos de copa. En la última pista, el
   * lugar final del dueño (por puntos de copa; empatados, el que quedó mejor en esta pista)
   */
  private contarCopa(): void {
    const c = this.copa;
    if (!c || c.contada) return;
    c.contada = true;
    const lugares = [...this.jugadores.values()]
      .sort((a, b) => a.lugar - b.lugar)
      .map((j, orden) => ({ id: j.id, orden, puntos: j.puntos }))
      .sort((a, b) => b.puntos - a.puntos || a.orden - b.orden)
      .map((j) => j.id);
    sumarPista(c.puntos, lugares);
    if (c.indice < c.pistas.length - 1) return;
    c.final = finalDeCopa(c.puntos, lugares, c.dueno);
  }

  /** Sin personas ni pantalla (los bots solos no mantienen viva una sala) */
  get vacia(): boolean {
    return !this.pantalla && ![...this.jugadores.values()].some((j) => !j.mente);
  }

  private get dt(): number {
    return 1 / this.tickHz;
  }

  private ticks(segundos: number): number {
    return Math.round(segundos * this.tickHz);
  }

  private get maxCreditos(): number {
    return this.ticks(MAX_CREDITOS_S);
  }

  private get maxCola(): number {
    return this.ticks(MAX_COLA_S);
  }

  /* ----------------------------- Jugadores ----------------------------- */

  /**
   * Agrega un bot con el primer nombre y color libres. Devuelve un error o null.
   * `personalidades` (la campaña): sale con una personalidad, que cambia cada ronda (ver MOLDES).
   * `dificil` (la copa en Difícil): nunca frena (ver DIFICIL_VELOCIDAD_MAX)
   */
  agregarBot(nivel = 0, personalidades = false, dificil = false, conVehiculo?: Vehiculo, conNombre?: string): string | null {
    const usados = new Set([...this.jugadores.values()].map((j) => j.nombre));
    const nombre = conNombre && !usados.has(conNombre) ? conNombre : (NOMBRES_BOT.find((n) => !usados.has(n)) ?? "Bot");
    let n = 1;
    while (this.jugadores.has(`bot-${n}`)) n++;
    const colores = new Set([...this.jugadores.values()].map((j) => j.color));
    // En multijugador el bot escoge como una persona: un color libre al azar
    const libres = COLORES.filter((c) => !colores.has(c.id));
    const color = (this.multi ? libres[Math.floor(this.azar() * libres.length)] : libres[0])?.id ?? COLORES[0].id;
    // Los bots lucen los vehículos de paga (los de premio no: esos se ganan): uno distinto cada uno
    const vehiculo = conVehiculo ?? VEHICULOS_DE_PAGA[(n - 1) % VEHICULOS_DE_PAGA.length];
    const error = this.agregar(`bot-${n}`, { nombre, color, vehiculo });
    const personalidad = personalidades ? sortearPersonalidad(MOLDES[(n - 1) % MOLDES.length], this.azar) : undefined;
    if (!error) {
      const bot = this.jugadores.get(`bot-${n}`)!;
      bot.mente = crearMente(this.azar, nivel, personalidad, personalidades, dificil);
      if (this.multi) this.programarListo(bot);
    }
    return error;
  }

  quitarBots(): void {
    for (const j of [...this.jugadores.values()]) if (j.mente) this.quitar(j.id);
  }

  /** Agrega un jugador; si su color ya está tomado le toca el primero libre. Devuelve un error o null */
  agregar(id: string, datos: DatosJugador): string | null {
    if (this.jugadores.size >= MAX_JUGADORES) return `La sala ya tiene ${MAX_JUGADORES} jugadores`;
    const usados = new Set([...this.jugadores.values()].map((j) => j.color));
    const color = usados.has(datos.color) ? COLORES.find((c) => !usados.has(c.id))!.id : datos.color;
    const lugares = new Set([...this.jugadores.values()].map((j) => j.lugar));
    const lugar = [0, 1, 2, 3].find((l) => !lugares.has(l))!;
    const carro = this.carroEnParrilla(lugar, 0);
    this.jugadores.set(id, {
      id,
      nombre: datos.nombre,
      color,
      vehiculo: datos.vehiculo ?? VEHICULOS[0],
      stickers: datos.stickers ?? [...STICKERS_GRATIS],
      lugar,
      carro,
      cola: [],
      creditos: 2,
      ultimoSeq: -1,
      // A media partida se entra como espectador: se juega desde la siguiente ronda
      vivo: this.fase === "espera",
      fuera: 0,
      progreso: { vueltas: 0, s: proyectar(this.pista, carro.x, carro.y).s },
      puntos: 0,
      item: -1,
      itemPrevio: false,
      turboItem: -1,
      mente: null,
      piloto: null,
      meteoritoListo: 0,
      listo: false,
      listoEn: null,
    });
    this.cambioPartida = true;
    return null;
  }

  quitar(id: string): void {
    if (!this.jugadores.delete(id)) return;
    this.cambioPartida = true;
    // Sin gente suficiente no hay partida: todos de vuelta a la sala de espera
    if (this.jugadores.size < MIN_JUGADORES_PARTIDA) this.cancelarPreparacion();
    if (this.fase !== "espera" && this.jugadores.size < MIN_JUGADORES_PARTIDA) this.volverAEspera();
    else if (this.fase === "carrera") this.revisarFinDeRonda();
  }

  /** Entre partidas: en la sala de espera o viendo los resultados */
  get entrePartidas(): boolean {
    return this.fase === "espera" || this.fase === "resultados";
  }

  /**
   * Una persona dice que está lista (o se arrepiente): todos lo ven, y el anfitrión empieza
   * cuando lo están. Devuelve un error o null
   */
  marcarListo(id: string, listo: boolean): string | null {
    const j = this.jugadores.get(id);
    if (!j) return "No estás en esta sala";
    if (!this.entrePartidas) return "La partida ya empezó";
    j.listo = listo;
    return null;
  }

  /** El anfitrión cambia las victorias para ganar, entre partidas. Devuelve un error o null */
  cambiarMeta(id: string, meta: unknown): string | null {
    if (id !== this.anfitrion) return "Solo quien creó la sala puede cambiar las victorias";
    // La copa trae sus victorias
    if (this.copa) return meta === this.meta ? null : "La copa ya tiene sus victorias";
    if (!this.entrePartidas) return "Las victorias se cambian entre partidas";
    if (!VICTORIAS.includes(meta as (typeof VICTORIAS)[number])) return "Ese número de victorias no se puede";
    this.meta = meta as number;
    this.cambioPartida = true;
    return null;
  }

  /**
   * ¿Puede el anfitrión sacar a `id`? (sacarlo de verdad le toca al socket, que también tiene que
   * avisarle y sacar su conexión del cuarto). Devuelve un error o null
   */
  puedeExpulsar(quien: string, id: string): string | null {
    if (quien !== this.anfitrion) return "Solo quien creó la sala puede sacar jugadores";
    if (id === quien) return "No te puedes sacar a ti";
    if (!this.jugadores.has(id)) return "Ese jugador ya no está";
    return null;
  }

  /** Cambia su color, si nadie más lo trae. Devuelve un error o null */
  cambiarColor(id: string, color: unknown): string | null {
    const j = this.jugadores.get(id);
    if (!j) return "No estás en esta sala";
    if (!this.entrePartidas) return "El color se cambia entre partidas";
    if (!COLORES.some((c) => c.id === color)) return "Ese color no existe";
    const otro = [...this.jugadores.values()].find((o) => o !== j && o.color === color);
    // Si lo trae un bot, se lo cambia por el tuyo: las personas escogen, los bots se acomodan.
    // En multijugador no: el bot parece persona y su color es suyo
    if (otro?.mente && !this.multi) otro.color = j.color;
    else if (otro) return `Ese color ya lo trae ${otro.nombre}`;
    j.color = color as string;
    return null;
  }

  /**
   * Cambia su vehículo entre partidas (la preparación de la copa). Que sea suyo lo revisa el
   * socket con su cuenta antes de llamar aquí. Devuelve un error o null
   */
  cambiarVehiculo(id: string, vehiculo: Vehiculo): string | null {
    const j = this.jugadores.get(id);
    if (!j) return "No estás en esta sala";
    if (!this.entrePartidas) return "El vehículo se cambia entre partidas";
    j.vehiculo = vehiculo;
    return null;
  }

  /** Su barra de stickers nueva (ya guardada y revisada con su cuenta): la que vale en el festejo */
  ponerBarra(id: string, stickers: string[]): void {
    const j = this.jugadores.get(id);
    if (j) j.stickers = [...stickers];
  }

  /**
   * El anfitrión cambia el mapa entre partidas: pista, cajas y todo lo suelto de nuevo, y todos a la
   * sala de espera en la parrilla del mapa nuevo. A nadie le queda el "listo": que vean el mapa.
   * Devuelve un error o null
   */
  cambiarCircuito(id: string, circuito: Circuito): string | null {
    if (id !== this.anfitrion) return "Solo quien creó la sala puede cambiar el mapa";
    if (!this.entrePartidas) return "El mapa se cambia entre partidas";
    if (circuito.id === this.circuito.id) return null;
    if (this.preparando) return "La partida ya va a empezar";
    // En una copa, solo a la pista que sigue y con la actual ya terminada
    if (this.copa) {
      if (!this.copa.contada || circuito.id !== this.copa.pistas[this.copa.indice + 1]) return "En la copa las pistas van en orden";
      this.copa.indice++;
      this.copa.contada = false;
    }
    this.circuito = circuito;
    this.pista = prepararPista(circuito);
    this.excavacion = new MecanicasExcavacion(this.pista);
    this.fijosEnCamino = null;
    this.cajas = this.cajasNuevas();
    for (const j of this.jugadores.values()) {
      j.carro = this.carroEnParrilla(j.lugar, 0);
      j.progreso = { vueltas: 0, s: proyectar(this.pista, j.carro.x, j.carro.y).s };
      j.cola = [];
      j.listo = false;
    }
    this.camara.iniciada = false;
    this.camara.zoom = 1;
    this.volverAEspera();
    return null;
  }

  /** Quien manda en la sala: la pantalla en modo local; si no, la primera persona (en multijugador, también un bot) */
  get anfitrion(): string {
    if (this.pantalla) return this.pantalla;
    // Multijugador: el primero que llegó, aunque sea un bot (los bots parecen personas)
    const candidatos = [...this.jugadores.values()].filter((j) => this.multi || !j.mente);
    return candidatos.sort((a, b) => a.lugar - b.lugar)[0]?.id ?? "";
  }

  /**
   * Parrilla intercalada detrás del punto `s` de la pista: el primero hasta adelante a la
   * izquierda, el segundo a la derecha y un poco más atrás, el tercero a la izquierda más atrás…
   */
  /**
   * Los tramos de la pista donde no se arma la parrilla: las rampas que están en el camino (el
   * salto del puente: despegue, hueco y llegada), juntas cuando quedan cerca (s de inicio y fin)
   */
  private tramosSinParrilla(): [number, number][] {
    const tramos = (this.circuito.rampas ?? [])
      .filter((r) => proyectar(this.pista, r.x, r.y).distancia < this.pista.mitad)
      .map((r): [number, number] => {
        // De punta a punta de la rampa, sin importar hacia dónde sube
        const a = proyectar(this.pista, r.x, r.y).s;
        const b = proyectar(this.pista, r.x + Math.cos(r.angulo) * r.largo, r.y + Math.sin(r.angulo) * r.largo).s;
        return [Math.min(a, b), Math.max(a, b)];
      })
      .sort((x, y) => x[0] - y[0]);
    const ex = this.circuito.excavacion;
    if (ex) {
      tramos.push([ex.pala.placaS - 5, ex.pala.s + 8], [ex.puente.s - ex.puente.largo / 2 - 5, ex.puente.s + ex.puente.largo / 2 + 5]);
      tramos.sort((a, b) => a[0] - b[0]);
    }
    const juntos: [number, number][] = [];
    for (const t of tramos) {
      const ultimo = juntos[juntos.length - 1];
      if (ultimo && t[0] - ultimo[1] < 15) ultimo[1] = Math.max(ultimo[1], t[1]);
      else juntos.push([...t]);
    }
    return juntos;
  }

  /**
   * Dónde se arma la parrilla detrás de `s`: si algún lugar quedaría encima de una rampa del
   * camino (o justo después), se recorre toda hacia atrás hasta antes de su pie
   */
  private salidaLibre(s: number): number {
    const L = this.pista.longitud;
    const atras = 6 + 3 * SEPARACION_PARRILLA + 4;
    for (let intento = 0; intento < 4; intento++) {
      const tramo = this.tramosSinParrilla().find(([a, b]) => {
        // ¿El tramo de la parrilla [s - atras, s] se cruza con [a - 3, b + 8]? (en una pista circular)
        const fin = (((s - (a - 3)) % L) + L) % L;
        return fin < b + 8 - (a - 3) + atras;
      });
      if (!tramo) return s;
      s = tramo[0] - 3.5;
    }
    return s;
  }

  private carroEnParrilla(posicion: number, s: number): EstadoCarro {
    const lado = posicion % 2 ? 1 : -1;
    return crearCarro(this.pista, s - 6 - posicion * SEPARACION_PARRILLA, lado * this.pista.mitad * 0.45);
  }

  /* ------------------------------ Controles ----------------------------- */

  recibirControles(id: string, ctrl: ControlesRed): void {
    const j = this.jugadores.get(id);
    if (!j || ctrl.seq <= j.ultimoSeq || ctrl.seq <= (j.cola.at(-1)?.seq ?? -1)) return;
    j.cola.push(ctrl);
    if (j.cola.length > this.maxCola) j.cola.splice(0, j.cola.length - this.maxCola);
    this.aplicar(j);
  }

  /**
   * Aplica los controles en espera mientras haya crédito, cada uno con el paso fijo. En las
   * fases sin manejo (cuenta, pausa) o si el carro ya explotó, el control se consume sin mover
   * nada: el navegador sabe la fase y tampoco predice.
   */
  private aplicar(j: Jugador): void {
    const mueve = FASES_CON_MANEJO.includes(this.fase) && j.vivo;
    while (j.creditos >= 1 && j.cola.length) {
      const ctrl = j.cola.shift()!;
      if (mueve) {
        // Un bot puede traer más motor (su personalidad); las personas, la de todos (la que predice el navegador)
        const fisica = j.mente ? fisicaDe(j.mente.personalidad) : PARAMETROS_FISICA;
        avanzarCarro(j.carro, ctrl, fisica, this.pista, this.dt, (impacto) => this.eventos.push({ tipo: "obra", id: j.id, ...impacto }));
        // Postes y asadores: en el mismo orden que la predicción del navegador (justo después de avanzar)
        this.chocarConLoSuelto(j.carro);
        // Choques en cada paso, no solo una vez por tick: si llegan varios controles juntos
        // (la red los agrupa), el carro avanzaría varios metros de golpe y atravesaría a otro
        for (const otro of this.jugadores.values()) if (otro !== j && otro.vivo) this.chocar(j, otro);
        // El item se usa al apretar la tecla, en el mismo control en que se apretó
        if (ctrl.item && !j.itemPrevio && j.item >= 0) this.usarItem(j);
      }
      j.itemPrevio = ctrl.item;
      j.ultimoSeq = ctrl.seq;
      j.creditos -= 1;
    }
  }

  /* -------------------------------- Items -------------------------------- */

  private usarItem(j: Jugador): void {
    const indice = j.item;
    const item = this.items[indice];
    j.item = -1;
    if (!item) return;
    if (item.mecanica === "turbo") j.turboItem = indice;
    MECANICAS[item.mecanica].usar(this, j, indice, item);
    this.eventos.push({ tipo: "usar", id: j.id, item: indice, x: j.carro.x, y: j.carro.y });
  }

  conductores(): Conductor[] {
    return [...this.jugadores.values()].filter((j) => j.vivo);
  }

  recorrido(id: string): number {
    const j = this.jugadores.get(id);
    return j ? distanciaRecorrida(j.progreso, this.pista) : 0;
  }

  avance(): number {
    return this.avanceMax;
  }

  /** Partida nueva o de vuelta a la espera: las vueltas se cuentan desde donde va el líder ahora */
  private reiniciarAvance(): void {
    const lider = this.lider();
    this.avanceMax = lider ? distanciaRecorrida(lider.progreso, this.pista) : 0;
  }

  soltar(e: Omit<Entidad, "id" | "edad" | "tocados" | "vidaMax" | "golpes" | "nacio" | "etapa">): void {
    const nueva: Entidad = {
      ...e,
      id: this.siguienteEntidad++,
      edad: 0,
      tocados: new Set(),
      vidaMax: e.vida,
      golpes: 0,
      nacio: this.avanceMax,
      etapa: 0,
    };
    this.entidades.push(nueva);
    if (this.items[e.item]?.dejaAlSoltar) this.dejar(nueva);
    // Lo que persiste tiene tope: al pasarse, se va lo más viejo (la pista no se vuelve un tiradero)
    // La gente de la carne asada no cuenta: se va con su asador
    const persistentes = this.entidades.filter((x) => !Number.isFinite(x.vida) && this.items[x.item]?.mecanica !== "persona");
    if (persistentes.length > MAX_PERSISTENTES) {
      const viejo = persistentes[0];
      this.entidades = this.entidades.filter((x) => x !== viejo);
    }
  }

  /**
   * Un espectador tira lo de la pista (circuito.espectador: el meteorito del desierto, el aceite
   * de la construcción; sin eso, el meteorito) a (x, y): tiene que estar en la carrera ya
   * eliminado, en una sala de más de 2, sin otro suyo todavía en la pista, ya recargado, y el
   * punto tiene que verse en la cámara compartida (en tierra). Devuelve un error o null.
   */
  /** `libre`: sin revisar que el punto se vea en la pantalla (los bots del multijugador) */
  lanzarMeteorito(id: string, x: number, y: number, libre = false): string | null {
    const j = this.jugadores.get(id);
    const indice = this.items.findIndex((i) => i.id === (this.circuito.espectador ?? "meteorito"));
    const item = this.items[indice];
    if (!j || !item) return "En esta pista no se tira nada";
    const nombre = item.nombre.toLowerCase();
    if (this.fase !== "carrera") return `El ${nombre} se tira durante la carrera`;
    if (j.vivo) return `Solo quien ya explotó puede tirar ${nombre}`;
    if (this.jugadores.size < METEORITO.minJugadores) return `Se necesitan al menos ${METEORITO.minJugadores} jugadores`;
    // Listo al acabar la recarga; solo espera si el anterior sigue cayendo (etapa 0). El andamio ya
    // en el piso dura más que la recarga: no debe bloquear el siguiente
    if (this.tick < j.meteoritoListo || this.entidades.some((e) => e.dueno === id && e.item === indice && e.etapa === 0)) {
      return `Tu ${nombre} todavía no está listo`;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "Punto inválido";
    if ((!libre && !enVista(this.camara, x, y, alturaEn(this.pista, x, y), PARAMETROS_CAMARA_PARTIDA, 0)) || enAgua(this.pista, x, y)) {
      return "Apunta a algo que se vea en la pantalla";
    }
    // El andamio (construcción) cae atravesado en el carril al que apuntó, tapando solo ese carril
    let lugar = { x, y, angulo: this.azar() * Math.PI * 2 };
    if (item.mecanica === "barrera") {
      const s = proyectar(this.pista, x, y).s;
      const p = puntoEnPista(this.pista, s, centroDeCarril(this.pista, lateralDe(this.pista, x, y, s), s));
      lugar = { x: p.x, y: p.y, angulo: p.angulo + Math.PI / 2 };
    }
    this.soltar({
      item: indice,
      dueno: id,
      ...lugar,
      vx: 0,
      vy: 0,
      vida: this.ticks(item.vida ?? 1.25),
      objetivo: null,
    });
    j.meteoritoListo = this.tick + this.ticks(METEORITO.recarga);
    if (item.mecanica === "meteorito") this.eventos.push({ tipo: "meteorito", id, x, y });
    else this.eventos.push({ tipo: "usar", id, item: indice, x, y });
    return null;
  }

  /**
   * MULTIJUGADOR: los bots que ya explotaron tiran lo de la pista (meteoritos, aceite o andamios)
   * como cualquier espectador. El 70 % de las veces van contra el que lleva más rondas ganadas; si
   * no, contra uno al azar. Apuntan a donde va a estar cuando caiga, con algo de error, y cada uno
   * se toma su tiempo (como una persona) entre tiro y tiro
   */
  private meteoritosDeBots(): void {
    if (!this.multi || this.jugadores.size < METEORITO.minJugadores) return;
    const item = this.items.find((i) => i.id === (this.circuito.espectador ?? "meteorito"));
    if (!item) return;
    const vivos = [...this.jugadores.values()].filter((j) => j.vivo);
    if (!vivos.length) return;
    for (const bot of this.jugadores.values()) {
      if (!bot.mente || bot.vivo || this.tick < bot.meteoritoListo) continue;
      const max = Math.max(...vivos.map((j) => j.puntos));
      const punteros = vivos.filter((j) => j.puntos === max);
      const lista = this.azar() < 0.7 ? punteros : vivos;
      const blanco = lista[Math.floor(this.azar() * lista.length)].carro;
      // Lo que tarda en caer: si se tira encima del carro, cae cuando ya pasó
      const caida = item.mecanica === "meteorito" ? (item.vida ?? 1.25) : item.mecanica === "barrera" ? (item.duracion ?? 1.5) : 0.3;
      let x: number;
      let y: number;
      if (this.azar() < 0.8) {
        // 8 de cada 10: adelante en la pista, en su carril, donde va a ir pasando cuando caiga. El
        // meteorito aplasta al caer (justo ahí, unos metros de más o de menos); el andamio se
        // queda tirado: mejor un poco más allá, que se le atraviese
        const s0 = proyectar(this.pista, blanco.x, blanco.y, blanco.indice).s;
        const extra = item.mecanica === "meteorito" ? (this.azar() - 0.35) * 6 : 6 + this.azar() * 14;
        const s = s0 + Math.hypot(blanco.vx, blanco.vy) * caida + extra;
        const p = puntoEnPista(this.pista, s, lateralDe(this.pista, blanco.x, blanco.y, s0) + (this.azar() - 0.5) * 2);
        x = p.x;
        y = p.y;
      } else {
        // Las demás: a donde lo lleva su velocidad, con más error
        x = blanco.x + blanco.vx * caida + (this.azar() - 0.5) * 6;
        y = blanco.y + blanco.vy * caida + (this.azar() - 0.5) * 6;
      }
      // Los bots tiran aunque ese punto no se vea en la pantalla
      if (this.lanzarMeteorito(bot.id, x, y, true)) {
        bot.meteoritoListo = this.tick + this.ticks(0.5);
        continue;
      }
      bot.meteoritoListo += this.ticks(this.azar() * 2.5);
    }
  }

  /** Cayó un meteorito: explota quien tenga alguna parte de su carro dentro del radio */
  aplastar(x: number, y: number, radio: number): void {
    this.eventos.push({ tipo: "impacto", x, y });
    for (const j of this.jugadores.values()) {
      if (!j.vivo) continue;
      const debajo = circulosCarro(j.carro).some((c) => Math.hypot(c.x - x, c.y - y) < radio + PARAMETROS_FISICA.radio);
      // Con el escudo (agua fresca) o el casco el meteorito rebota
      if (debajo && (j.carro.escudo > 0 || j.carro.pesado > 0)) this.eventos.push({ tipo: "escudo", id: j.id, x: j.carro.x, y: j.carro.y });
      else if (debajo) this.eliminar(j, "meteorito");
    }
  }

  /** Suelta, donde está `e`, lo que su item deja (`deja`) */
  private dejar(e: Entidad): void {
    const padre = this.items[e.item];
    const indice = this.items.findIndex((i) => i.id === padre.deja);
    const item = this.items[indice];
    if (!item) return;
    this.soltar({
      item: indice,
      dueno: e.dueno,
      x: e.x,
      y: e.y,
      angulo: e.angulo,
      vx: 0,
      vy: 0,
      vida: item.persiste ? Infinity : Math.round((item.vida ?? 10) * this.tickHz),
      objetivo: null,
    });
    // El bache de un meteorito ya cuenta como pisado: solo desvía
    if (padre.dejaGastado) this.entidades[this.entidades.length - 1].golpes = 1;
  }

  /**
   * Lo que ya le toca otra etapa (bache, charco, asador) la toma cuando nadie lo ve: así no se ve
   * el cambio. Al asador, en su etapa intermedia, le llega la gente.
   */
  private taparBaches(): void {
    for (const e of [...this.entidades]) {
      const item = this.items[e.item];
      if (!item?.tapar) continue;
      const debida = etapaDebida(this, e, item);
      if (debida <= e.etapa || this.seVe(e.x, e.y)) continue;
      if (e.etapa === 0 && debida === 1 && item.llegan) this.llegaGente(e, item.llegan);
      e.etapa = debida;
    }
  }

  /**
   * De vez en cuando, un personaje de la calle en medio del camino, adelante del líder y donde
   * nadie lo ve (si justo ahí se ve, lo intenta en el siguiente tick)
   */
  private ponerCalle(): void {
    if (this.circuito.calle === false) return;
    const indice = this.items.findIndex((i) => i.mecanica === "calle");
    const item = this.items[indice];
    const lider = this.lider();
    if (!item || !lider || this.tick < this.proximaCalle) return;
    if (this.entidades.filter((e) => e.item === indice).length >= CALLE_MAX) return;
    const [cerca, lejos] = CALLE_ADELANTE;
    const s = lider.progreso.s + cerca + this.azar() * (lejos - cerca);
    const p = puntoEnPista(this.pista, s, (this.azar() * 2 - 1) * this.pista.mitad * 0.4);
    if (this.seVe(p.x, p.y)) return;
    this.soltar({
      item: indice,
      dueno: "",
      x: p.x,
      y: p.y,
      angulo: p.angulo + Math.PI,
      vx: 0,
      vy: 0,
      vida: this.ticks(item.vida ?? 45),
      objetivo: null,
    });
    const [poco, mucho] = CALLE_CADA;
    this.proximaCalle = this.tick + this.ticks(poco + this.azar() * (mucho - poco));
  }

  /**
   * Los peligros del ambiente de la pista (circuito.ambiente): cada uno es una entidad que va y
   * viene cruzando el camino. Si falta (sala nueva, partida nueva que limpió todo), se pone
   */
  private ponerAmbiente(): void {
    (this.circuito.ambiente ?? []).forEach((a, k) => {
      const indice = this.items.findIndex((i) => i.id === a.item);
      if (indice < 0 || this.entidades.some((e) => e.objetivo === `ambiente-${k}`)) return;
      const p = puntoEnPista(this.pista, a.s, a.desde);
      this.soltar({ item: indice, dueno: "", x: p.x, y: p.y, angulo: p.angulo, vx: 0, vy: 0, vida: Infinity, objetivo: `ambiente-${k}` });
      this.entidades[this.entidades.length - 1].casa = { x: a.desde, y: a.hasta, mira: a.velocidad, asador: a.pausa ?? 0.8 };
    });
  }

  existe(id: number): boolean {
    return this.entidades.some((e) => e.id === id);
  }

  avisar(evento: Evento): void {
    this.eventos.push(evento);
  }

  /** Llega la gente a la carne asada: en círculo alrededor del asador, mirándolo */
  private llegaGente(asador: Entidad, llegan: { item: string; min: number; max: number }): void {
    const indice = this.items.findIndex((i) => i.id === llegan.item);
    if (indice < 0) return;
    const n = llegan.min + Math.floor(this.azar() * (llegan.max - llegan.min + 1));
    const giro = this.azar() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = giro + (i / n) * Math.PI * 2 + (this.azar() - 0.5) * 0.4;
      const d = 2 + this.azar() * 0.8;
      const x = asador.x + Math.cos(a) * d;
      const y = asador.y + Math.sin(a) * d;
      const mira = a + Math.PI;
      this.soltar({ item: indice, dueno: asador.dueno, x, y, angulo: mira, vx: 0, vy: 0, vida: Infinity, objetivo: null });
      this.entidades[this.entidades.length - 1].casa = { x, y, mira, asador: asador.id };
    }
  }

  /** ¿Alguien puede estar viendo el punto (x, y)? */
  seVe(x: number, y: number): boolean {
    if (this.fase === "espera") {
      return [...this.jugadores.values()].some((j) => Math.hypot(j.carro.x - x, j.carro.y - y) < LEJOS_SIN_VER);
    }
    return enVista(this.camara, x, y, alturaEn(this.pista, x, y), PARAMETROS_CAMARA_PARTIDA, MARGEN_SIN_VER);
  }

  /** Lo sólido que está en el piso: postes, asadores, el cactus ya crecido, la aplanadora */
  private estorbos(): Entidad[] {
    return this.entidades.filter((e) => esEstorbo(this.items[e.item], e.etapa));
  }

  /** Los andamios caídos (tubos de lado a lado del carril) y los cierres de obra: sólidos, como un muro */
  private barreras(): Segmento[] {
    return this.entidades.flatMap((e) => murosDeEntidad(this.pista, this.items[e.item], e));
  }

  /** Lo sólido que no es la pista: estorbos (redondos) y andamios (tubos), en ese orden */
  private chocarConLoSuelto(c: EstadoCarro): void {
    // Colgado del gancho (o en un salto alto) pasa por encima
    if (c.z > ALTURA_LIBRE) return;
    for (const e of this.estorbos()) colisionFija(c, e.x, e.y, this.items[e.item].radio ?? 0.5, PARAMETROS_FISICA);
    const barreras = this.barreras();
    if (barreras.length) colisionMuros(c, barreras, PARAMETROS_FISICA);
  }

  /** ¿Este item puede salir de las cajas en esta pista? (los de su copa; sin copa, los libres) */
  private permitido = (i: Item): boolean => (this.circuito.items ? this.circuito.items.includes(i.id) : !i.copa);

  /** Aplica el efecto de un item a un carro (las duraciones no se suman: se toma la mayor) */
  golpear(victima: Conductor, item: number, efecto: Efecto, silencioso = false): void {
    const c = victima.carro;
    const t = (s?: number) => (s ? Math.round(s * this.tickHz) : 0);
    // Agua fresca: fuera todo lo malo
    if (efecto.limpiar) {
      c.aturdido = c.resbalon = c.lento = c.trompo = c.enredado = c.ponchado = c.viento = c.cemento = c.empujon = 0;
    }
    c.escudo = Math.max(c.escudo, t(efecto.escudo));
    c.pesado = Math.max(c.pesado, t(efecto.pesado));
    // Con el escudo puesto, lo malo rebota
    const malo =
      efecto.aturdido || efecto.resbalon || efecto.lento || efecto.empujon || efecto.frenar !== undefined || efecto.sacudida ||
      efecto.desvio || efecto.enredado || efecto.ponchado || efecto.viento || efecto.cemento;
    // El casco (`pesado`) también te protege, sin la burbuja
    if (malo && (c.escudo > 0 || c.pesado > 0)) {
      if (!silencioso) this.eventos.push({ tipo: "escudo", id: victima.id, x: c.x, y: c.y });
      return;
    }
    // En el aire (el gancho de grúa, un salto alto) lo del piso no lo alcanza
    if (malo && c.z > ALTURA_LIBRE) return;
    c.enredado = Math.max(c.enredado, t(efecto.enredado));
    c.ponchado = Math.max(c.ponchado, t(efecto.ponchado));
    if (efecto.cemento) c.cemento = Math.min(PARAMETROS_FISICA.efectos.cementoLleno * 1.5, c.cemento + efecto.cemento);
    if (efecto.viento) {
      c.viento = Math.max(c.viento, t(efecto.viento.segundos));
      c.vientoX = efecto.viento.x;
      c.vientoY = efecto.viento.y;
    }
    c.aturdido = Math.max(c.aturdido, t(efecto.aturdido));
    c.resbalon = Math.max(c.resbalon, t(efecto.resbalon));
    c.lento = Math.max(c.lento, t(efecto.lento));
    c.turbo = Math.max(c.turbo, t(efecto.turbo));
    if (efecto.empujon) {
      c.vx += efecto.empujon[0];
      c.vy += efecto.empujon[1];
    }
    if (efecto.frenar !== undefined) {
      c.vx *= efecto.frenar;
      c.vy *= efecto.frenar;
    }
    if (efecto.sacudida) c.w += efecto.sacudida;
    if (efecto.desvio) {
      // Lo voltea con todo y su velocidad: sigue igual de rápido, pero hacia otro lado
      const cos = Math.cos(efecto.desvio);
      const sin = Math.sin(efecto.desvio);
      [c.vx, c.vy] = [c.vx * cos - c.vy * sin, c.vx * sin + c.vy * cos];
      c.angulo += efecto.desvio;
    }
    if (!silencioso) this.eventos.push({ tipo: "golpe", id: victima.id, item, x: c.x, y: c.y });
  }

  /** Le da a la caja un color al azar (de las categorías que tienen items que salen de cajas) */
  private pintarCaja(caja: Caja): void {
    const conItems = CATEGORIAS.map((_, k) => k).filter((k) =>
      this.items.some((item) => item.categoria === CATEGORIAS[k].id && item.probabilidad > 0 && this.permitido(item)),
    );
    caja.categoria = conItems.length ? conItems[Math.floor(this.azar() * conItems.length) % conItems.length] : 0;
  }

  /** Recoger cajas, mover lo suelto y empujar con el turbo */
  private pasoItems(vivos: Jugador[]): void {
    if (!this.items.length) return;
    for (const caja of this.cajas) {
      if (caja.hasta > this.tick) continue;
      const quien = vivos.find(
        (j) =>
          j.item < 0 &&
          Math.hypot(j.carro.x - caja.x, j.carro.y - caja.y) < RADIO_CAJA &&
          Math.abs(j.carro.z - caja.z) < ALTO_CAJA,
      );
      if (!quien) continue;
      quien.item = sacarItem(this.items, this.azar, CATEGORIAS[caja.categoria]?.id, this.permitido);
      caja.hasta = this.tick + Math.round(CAJA_APAGADA * this.tickHz);
      // Cuando vuelva a salir será de otro color
      this.pintarCaja(caja);
      this.eventos.push({ tipo: "item", id: quien.id, item: quien.item });
    }

    this.taparBaches();
    this.ponerCalle();
    this.ponerAmbiente();
    this.ponerObras();
    this.ponerTuberia();
    this.ponerEscombros();
    this.ponerRampasMovibles();
    const dejados: Entidad[] = [];
    // Lo que una entidad suelte mientras se actualiza (los clavos de la bolsa) se agrega al final
    const antes = this.entidades;
    const cuantos = antes.length;
    this.entidades = antes.slice(0, cuantos).filter((e) => {
      const item = this.items[e.item];
      const actualizar = MECANICAS[item.mecanica].actualizar;
      const { limites } = this.circuito;
      const dentro = e.x > limites.x && e.y > limites.y && e.x < limites.x + limites.ancho && e.y < limites.y + limites.alto;
      const sigue = dentro && (actualizar ? actualizar(this, e, item) : false);
      // Al acabarse solo (no por pegarle a alguien), deja otra cosa: el meteorito deja un bache
      // (lo que se deja al soltar, como el asador del humo, ya se dejó en soltar())
      if (!sigue && dentro && e.vida <= 0 && item.deja && !item.dejaAlSoltar) dejados.push(e);
      return sigue;
    });
    this.entidades.push(...antes.slice(cuantos));
    for (const e of dejados) this.dejar(e);

    for (const j of vivos) {
      if (j.carro.turbo <= 0 || j.turboItem < 0) continue;
      const item = this.items[j.turboItem];
      MECANICAS[item.mecanica].mientras?.(this, j, j.turboItem, item, this.tick);
    }
  }

  /**
   * Ronda nueva o sala de espera: cajas encendidas y nadie trae item. Entre rondas lo que persiste
   * (postes, baches, charcos, asadores) se queda, salvo lo que haya quedado sobre la parrilla o
   * sea `soloRonda` (los cráteres de los meteoritos); lo demás (burros, topes, coyotas…) se quita.
   * `todo` también quita lo que persiste.
   */
  private limpiarItems(todo: boolean): void {
    this.entidades = this.entidades.filter(
      (e) =>
        !todo &&
        !Number.isFinite(e.vida) &&
        !this.items[e.item]?.soloRonda &&
        [...this.jugadores.values()].every((j) => Math.hypot(j.carro.x - e.x, j.carro.y - e.y) > PERSISTENTES_LEJOS_DE_PARRILLA),
    );
    for (const caja of this.cajas) {
      caja.hasta = 0;
      this.pintarCaja(caja);
    }
    this.ponerRampasMovibles();
    for (const j of this.jugadores.values()) {
      j.item = -1;
      j.turboItem = -1;
    }
  }

  /* ------------------------------ Partida ------------------------------ */

  /** El anfitrión empieza (o repite desde resultados). Devuelve un error o null */
  empezar(id: string): string | null {
    if (id !== this.anfitrion) return "Solo quien creó la sala puede empezar";
    if (!this.entrePartidas) return "La partida ya empezó";
    // Cada pista de la copa se corre una vez: después, la siguiente
    if (this.copa?.contada) return this.copa.final ? "La copa ya terminó" : "Sigue con la siguiente pista";
    if (this.jugadores.size < MIN_JUGADORES_PARTIDA) return `Se necesitan al menos ${MIN_JUGADORES_PARTIDA} jugadores`;
    this.iniciarPartida();
    return null;
  }

  private iniciarPartida(): void {
    this.preparacionHasta = null;
    for (const j of this.jugadores.values()) {
      j.puntos = 0;
      // Para la siguiente, cada quien vuelve a decir que está listo
      j.listo = false;
    }
    this.ronda = 0;
    this.ganador = null;
    // La primera ronda sale en el orden en que entraron a la sala
    this.ordenSalida = [...this.jugadores.values()].sort((a, b) => a.lugar - b.lugar).map((j) => j.id);
    // Partida nueva, pista limpia: lo que persistía de la partida anterior se va
    this.limpiarItems(true);
    restaurarEscenario(this.pista);
    this.nuevaRonda(0, 0);
    this.reiniciarAvance();
  }

  /**
   * Todos a la parrilla detrás de `s` (la meta, o donde iba el ganador) y cuenta regresiva.
   * Salir adelante es ventaja, así que el orden es el de `ordenSalida`: el ganador de la ronda
   * anterior hasta atrás y el primero que explotó hasta adelante. Quien entró después de que se
   * armó ese orden sale todavía más adelante (llega sin puntos).
   */
  private nuevaRonda(s: number, vueltas: number): void {
    this.excavacion.reiniciar();
    // Nadie arranca encima del salto del puente (ni en su hueco)
    s = this.salidaLibre(s);
    this.ronda++;
    this.ganadorRonda = null;
    // La campaña: cada ronda, cada bot con otra personalidad (y otros valores)
    const deCampania = [...this.jugadores.values()].map((j) => j.mente).filter((m): m is MenteBot => !!m?.campania);
    if (deCampania.length) rotarPersonalidades(deCampania, this.azar);
    // El tutorial: siempre sales en primer lugar
    if (this.tutorial) {
      const todos = [...this.jugadores.values()];
      this.ordenSalida = [...todos.filter((j) => !j.mente), ...todos.filter((j) => j.mente)].map((j) => j.id);
    }
    const conocidos = this.ordenSalida.filter((id) => this.jugadores.has(id));
    const nuevos = [...this.jugadores.keys()].filter((id) => !conocidos.includes(id));
    [...nuevos, ...conocidos].forEach((id, posicion) => {
      const j = this.jugadores.get(id)!;
      j.carro = this.carroEnParrilla(posicion, s);
      j.vivo = true;
      j.fuera = 0;
      j.cola = [];
      j.piloto = null;
      j.progreso = { vueltas, s: proyectar(this.pista, j.carro.x, j.carro.y).s };
      // Si la parrilla quedó del otro lado de la meta, ajusta la vuelta
      if (j.progreso.s - s > this.pista.longitud / 2) j.progreso.vueltas--;
    });
    this.caidos = [];
    this.limpiarItems(false);
    this.ponerTrampasPrueba(s);
    // Nadie arranca con item: las cajas que quedaron sobre la parrilla se apagan hasta un rato después del arranque
    const hasta = this.tick + this.ticks(DURACION.cuenta + 4);
    for (const caja of this.cajas) {
      const cerca = [...this.jugadores.values()].some((j) => Math.hypot(j.carro.x - caja.x, j.carro.y - caja.y) < CAJAS_LEJOS_DE_PARRILLA);
      if (cerca) caja.hasta = hasta;
    }
    if (this.tutorial) {
      // Lección 1: los bots no corren (no se dibujan ni chocan)
      if (this.tutorial.leccion === 1) for (const j of this.jugadores.values()) if (j.mente) j.vivo = false;
      // Antes de la lección de items, las cajas no salen
      if (this.tutorial.leccion < 3) for (const caja of this.cajas) caja.hasta = Number.MAX_SAFE_INTEGER;
      this.tutorial.itemEn = null;
    }
    this.camara.iniciada = false;
    this.camara.zoom = 1;
    this.seguirLider(0);
    this.cambiarFase("cuenta", DURACION.cuenta + (this.tutorial ? TUTORIAL.cuentaExtra : 0));
  }

  /** Multijugador: el bot dice "listo" en un rato (LISTO_BOTS), como una persona */
  private programarListo(bot: Jugador): void {
    bot.listo = false;
    bot.listoEn = this.tick + this.ticks(LISTO_BOTS[0] + this.azar() * (LISTO_BOTS[1] - LISTO_BOTS[0]));
  }

  /** Cambió quién está listo (un bot ya lo dijo): el socket manda la sala otra vez */
  cambioJugadores = false;

  private volverAEspera(): void {
    // Multijugador: de vuelta en la sala de espera nadie está listo; los bots lo dicen en un rato
    if (this.multi) {
      for (const j of this.jugadores.values()) {
        if (j.mente) this.programarListo(j);
        else j.listo = false;
      }
      this.cambioJugadores = true;
    }
    this.excavacion.reiniciar();
    for (const j of this.jugadores.values()) {
      if (!j.vivo) j.carro = this.carroEnParrilla(j.lugar, 0);
      j.vivo = true;
      j.fuera = 0;
    }
    this.limpiarItems(true);
    this.reiniciarAvance();
    this.caidos = [];
    this.ganadorRonda = null;
    this.cambiarFase("espera", 0);
  }

  private cambiarFase(fase: Fase, segundos: number): void {
    this.fase = fase;
    this.restante = this.ticks(segundos);
    this.cambioPartida = true;
  }

  private eliminar(j: Jugador, motivo: MotivoEliminacion): void {
    j.vivo = false;
    // Multijugador: el bot que explota se toma un rato antes de su primer tiro (meteoritosDeBots)
    if (j.mente && this.multi) j.meteoritoListo = Math.max(j.meteoritoListo, this.tick + this.ticks(1 + this.azar() * 2));
    j.cola = [];
    this.caidos.push(j.id);
    this.eventos.push({ tipo: "explosion", id: j.id, x: j.carro.x, y: j.carro.y, ...(j.carro.z < -0.5 ? { z: Math.round(j.carro.z * 10) / 10 } : {}), motivo });
  }

  /** La ronda termina cuando queda uno (o ninguno, si cayeron al mismo tiempo) */
  private revisarFinDeRonda(): void {
    const vivos = [...this.jugadores.values()].filter((j) => j.vivo);
    const t = this.tutorial;
    // El tutorial: cada lección termina también por tiempo (gana el que va adelante); la 1, que se
    // corre solo, termina por tiempo o si te caes
    const porTiempo = !!t && this.fase === "carrera" && this.ticksCarrera >= this.ticks(TUTORIAL.segundos[t.leccion - 1] ?? 40);
    if (t?.leccion === 1 ? vivos.length > 0 && !porTiempo : vivos.length > 1 && !porTiempo) return;
    const ganador = vivos.length > 1 ? this.lider() : (vivos[0] ?? null);
    if (ganador) ganador.puntos++;
    this.ganadorRonda = ganador?.id ?? null;
    // Orden de la siguiente salida: al revés de como terminaron. Primero los que vieron la ronda
    // de espectadores, luego los que cayeron (el primero en caer, más adelante) y el ganador al final
    const espectadores = [...this.jugadores.values()].filter((j) => !j.vivo && !this.caidos.includes(j.id)).map((j) => j.id);
    this.ordenSalida = [...espectadores, ...this.caidos, ...vivos.map((j) => j.id)];
    this.eventos.push({ tipo: "punto", id: this.ganadorRonda });
    this.stickers = { puestos: 0, ultimo: -Infinity };
    // Un bot que gana también festeja: un sticker al azar, al ratito de acercarse la cámara
    this.stickerBotEn = ganador?.mente ? this.tick + this.ticks(1 + this.azar() * 0.8) : null;
    this.cambiarFase("ronda-fin", DURACION.rondaFin);
  }

  /**
   * El ganador de la ronda pone un sticker encima de su carro, en el festejo (ronda-fin). Hasta
   * LIMITE_STICKERS.porFestejo, uno cada LIMITE_STICKERS.cada segundos. Devuelve un error o null
   */
  ponerSticker(id: string, sticker: unknown): string | null {
    if (this.fase !== "ronda-fin") return "Los stickers son para festejar una ronda";
    if (id !== this.ganadorRonda) return "Solo el ganador de la ronda pone stickers";
    if (typeof sticker !== "string" || !(STICKERS as readonly string[]).includes(sticker)) return "Ese sticker no existe";
    const j = this.jugadores.get(id);
    if (j && !j.mente && !j.stickers.includes(sticker)) return "Ese sticker no está en tu barra";
    if (this.stickers.puestos >= LIMITE_STICKERS.porFestejo) return "Ya pusiste muchos stickers";
    if (this.tick - this.stickers.ultimo < this.ticks(LIMITE_STICKERS.cada)) return "Más despacio";
    this.stickers = { puestos: this.stickers.puestos + 1, ultimo: this.tick };
    this.eventos.push({ tipo: "sticker", id, sticker });
    return null;
  }

  /**
   * Qué tan cerca va `j` de salirse de la imagen de la cámara compartida (0 … 1), para que los
   * bots dejen de pelear cuando les cuesta la ronda: 0 cómodo; PELIGRO.zona en la orilla de la
   * imagen; PELIGRO.borde donde ya le dan rezago (alBorde); 1 fuera (contando para explotar)
   */
  private peligroFuera(j: Jugador): number {
    if (this.fase !== "carrera" || !j.vivo) return 0;
    const { x, y } = j.carro;
    const h = alturaEn(this.pista, x, y);
    if (j.fuera > 0 || !enVista(this.camara, x, y, h, PARAMETROS_CAMARA_PARTIDA, 0)) return 1;
    if (!enVista(this.camara, x, y, h, PARAMETROS_CAMARA_PARTIDA, BORDE_VISTA)) return PELIGRO.borde;
    if (!enVista(this.camara, x, y, h, PARAMETROS_CAMARA_PARTIDA, PELIGRO.margenZona)) return PELIGRO.zona;
    return 0;
  }

  /** Lo que hay en la pista que los bots esquivan (ver MECANICAS_RIESGO), ya ubicado en la pista */
  private riesgos(): Riesgo[] {
    const riesgos: Riesgo[] = riesgosExcavacion(this.pista, this.excavacion.estado, this.tick / this.tickHz);
    const vivas = new Set<number>();
    for (const e of this.entidades) {
      const item = this.items[e.item];
      // El brazo de la excavadora: su cucharón, cuando entra al camino (se mueve: no es fijo)
      if (item?.mecanica === "brazo") {
        const alcance = item.alcance ?? 11;
        const x = e.x + Math.cos(e.angulo) * alcance;
        const y = e.y + Math.sin(e.angulo) * alcance;
        const p = proyectar(this.pista, x, y);
        if (p.distancia < this.pista.mitad + 2) riesgos.push({ x, y, radio: (item.radio ?? 2) + 0.8, s: p.s, lateral: lateralEnPista(this.pista, { x, y }, p.s) });
        continue;
      }
      // Un cierre de obra es largo: se esquiva como una fila de riesgos a lo largo, del ancho de lo
      // que tapa; de la tubería, el centro tapado (se pasa por las rampas)
      if (item?.mecanica === "cierre" || item?.mecanica === "tuberia") {
        vivas.add(e.id);
        riesgos.push(...this.riesgosDeObra(e, item));
        continue;
      }
      // El campo del imán (en el piso) también se esquiva; el imán pegado a un carro no
      const esCampo = item?.mecanica === "iman" && e.etapa === 1;
      if (!item || (!MECANICAS_RIESGO.has(item.mecanica) && !esCampo)) continue;
      // La bolsa de clavos va con su dueño: se esquivan solo los montoncitos que deja
      if (item.mecanica === "alfombra" && e.etapa !== 1) continue;
      const s = proyectar(this.pista, e.x, e.y).s;
      riesgos.push({ x: e.x, y: e.y, radio: (esCampo ? item.radioCampo : item.radio) ?? RADIO_RIESGO, s, lateral: lateralEnPista(this.pista, e, s) });
    }
    for (const id of this.riesgosObra.keys()) if (!vivas.has(id)) this.riesgosObra.delete(id);
    riesgos.push(...this.riesgosFijos());
    return riesgos;
  }

  /**
   * Lo sólido de la escenografía que se mete al camino (las columnas bajo el rascacielos): no se
   * mueve, así que se calcula una vez. Lo que está en la orilla sin meterse (las barreras de la S)
   * no cuenta: llenaría la lista de lo que ven los bots y les taparía lo de verdad (un cierre)
   */
  private fijosEnCamino: Riesgo[] | null = null;
  private riesgosFijos(): Riesgo[] {
    if (!this.fijosEnCamino) {
      this.fijosEnCamino = [];
      // Lo cerrado frente a la tubería de Grúas ("bloque"): un riesgo ancho a todo su largo, y desde
      // unos metros antes, para que el bot se forme con una rampa a tiempo
      for (const b of this.circuito.piezas ?? []) {
        if (b.tipo !== "bloque") continue;
        const media = (b.fondo ?? 4) / 2;
        const largo = b.ancho ?? 4;
        const p0 = proyectar(this.pista, b.x, b.y);
        if (p0.distancia - media > this.pista.mitad) continue;
        const lateral = lateralEnPista(this.pista, b, p0.s);
        for (let a = -largo / 2 - 12; a <= largo / 2; a += 3) {
          const q = puntoEnPista(this.pista, p0.s + a, lateral);
          this.fijosEnCamino.push({ x: q.x, y: q.y, radio: media + 0.3, s: ((p0.s + a) % this.pista.longitud + this.pista.longitud) % this.pista.longitud, lateral, fijo: true });
        }
      }
      for (const o of this.pista.escenario.objetos) {
        if (o.masa || o.tipo === "bloque") continue;
        // Lo que se mete: medio lado corto de la caja (o el radio)
        const mete = o.ancho !== undefined ? Math.min(o.ancho, o.fondo ?? o.ancho) / 2 : o.radio;
        const p = proyectar(this.pista, o.x, o.y);
        if (p.distancia - mete > this.pista.mitad || mete > 3) continue;
        // Con margen: rozar una columna cuesta caro
        this.fijosEnCamino.push({ x: o.x, y: o.y, radio: mete + 0.9, s: p.s, lateral: lateralEnPista(this.pista, o, p.s), fijo: true });
      }
      // Una fila de columnas se esquiva entera: puntos cada 2.5 m entre una y la siguiente, y unos
      // metros antes de la primera. Así el bot elige su lado desde antes y no regresa a su línea
      // entre columna y columna (las del rascacielos están en curva: se cerraba contra la siguiente)
      const L = this.pista.longitud;
      const orden = [...this.fijosEnCamino].sort((a, b) => a.s - b.s);
      const extra: Riesgo[] = [];
      const punto = (s: number, lateral: number, radio: number): Riesgo => {
        const q = puntoEnPista(this.pista, s, lateral);
        return { x: q.x, y: q.y, radio, s: ((s % L) + L) % L, lateral, fijo: true };
      };
      orden.forEach((r, i) => {
        const antes = orden.find((o) => o !== r && Math.abs(o.lateral - r.lateral) < 1.5 && r.s - o.s > 0 && r.s - o.s < 12);
        if (!antes) for (const d of [3, 6, 9, 12]) extra.push(punto(r.s - d, r.lateral, r.radio));
        const siguiente = orden.slice(i + 1).find((o) => Math.abs(o.lateral - r.lateral) < 1.5 && o.s - r.s < 12);
        if (siguiente) for (let s = r.s + 2.5; s < siguiente.s - 1; s += 2.5) extra.push(punto(s, r.lateral + ((siguiente.lateral - r.lateral) * (s - r.s)) / (siguiente.s - r.s), r.radio));
      });
      this.fijosEnCamino.push(...extra);
    }
    return this.fijosEnCamino;
  }

  /**
   * ESCOMBROS DE LA DEMOLICIÓN (circuito.escombros): en la carrera, en cada lugar, cada `cada` s
   * (empezando a los `desfase` s) cae un escombro al camino. Siempre en los mismos lugares: se
   * aprende dónde caen
   */
  private ponerEscombros(): void {
    const lugares = this.circuito.escombros;
    if (!lugares?.length || this.fase !== "carrera") return;
    const indice = this.items.findIndex((i) => i.mecanica === "escombro");
    if (indice < 0) return;
    const item = this.items[indice];
    for (const l of lugares) {
      const desde = this.ticks(l.desfase ?? 0);
      if (this.ticksCarrera < desde || (this.ticksCarrera - desde) % Math.max(1, this.ticks(l.cada)) !== 0) continue;
      const p = puntoEnPista(this.pista, l.s, l.lateral);
      this.soltar({ item: indice, dueno: "", x: p.x, y: p.y, angulo: p.angulo + this.azar() * Math.PI, vx: 0, vy: 0, vida: this.ticks((item.aviso ?? 0) + (item.duracion ?? 0.8) + (item.vida ?? 6)), objetivo: null });
    }
  }

  /** Los riesgos de un cierre de obra: cada 5 m a lo largo, con el radio de medio ancho de lo tapado */
  private riesgosDeObra(e: Entidad, item: Item): Riesgo[] {
    let lista = this.riesgosObra.get(e.id);
    if (!lista && item.mecanica === "tuberia") {
      const m = medidasTuberia(this.pista, item);
      lista = [];
      for (let a = m.pie; a <= m.tubo + m.diametro && m.centro > 0.5; a += 4) {
        const x = e.x + Math.cos(e.angulo) * a;
        const y = e.y + Math.sin(e.angulo) * a;
        const s = proyectar(this.pista, x, y).s;
        lista.push({ x, y, radio: m.centro, s, lateral: lateralEnPista(this.pista, { x, y }, s), fijo: true });
      }
      this.riesgosObra.set(e.id, lista);
    }
    if (!lista) {
      const { n, ancho } = carriles(this.pista);
      const radio = (Math.min(n - 1, item.carrilesCierre ?? 1) * ancho - 0.8) / 2;
      const largo = item.largo ?? 20;
      lista = [];
      for (let a = -largo / 2; a <= largo / 2 + 0.01; a += 5) {
        const x = e.x + Math.cos(e.angulo) * a;
        const y = e.y + Math.sin(e.angulo) * a;
        const s = proyectar(this.pista, x, y).s;
        lista.push({ x, y, radio, s, lateral: lateralEnPista(this.pista, { x, y }, s), fijo: true });
      }
      this.riesgosObra.set(e.id, lista);
    }
    return lista;
  }

  /** Las rampas de las tuberías ya montadas: la física las usa como las del circuito */
  private ponerRampasMovibles(): void {
    this.pista.rampasMovibles = this.entidades.flatMap((e) => rampasDeEntidad(this.pista, this.items[e.item], e));
  }

  /**
   * OBRAS EN LA CALLE (circuito.obras): durante la carrera, cada `cada` s se cierra un tramo del
   * camino adelante del que va primero (lo bastante lejos para ver el aviso), fuera de las curvas
   * cerradas (es una fila de tramos rectos que siguen el camino), sin encimarse con otro cierre, con las cajas del camino ni con los peligros del ambiente. Tapa
   * carriles al azar, pero siempre deja al menos uno libre
   */
  private ponerObras(): void {
    const o = this.circuito.obras;
    if (!o || this.fase !== "carrera" || this.ticksCarrera < this.obraEn) return;
    // Si no hay dónde ponerlo, se vuelve a intentar en un segundo (el que va adelante ya avanzó)
    this.obraEn = this.ticksCarrera + this.ticks(1);
    const activas = this.entidades.filter((e) => this.items[e.item]?.mecanica === "cierre");
    // Los tramos de un mismo cierre salen juntos (ids seguidos): se cuentan como uno
    const cierres = activas.filter((e) => !activas.some((a) => a.id === e.id - 1 && a.item === e.item)).length;
    if (cierres >= o.maximo) return;
    const lider = this.lider();
    const opciones = o.items.map((id) => this.items.findIndex((i) => i.id === id && i.mecanica === "cierre")).filter((i) => i >= 0);
    if (!lider || !opciones.length) return;
    const indice = opciones[Math.floor(this.azar() * opciones.length)];
    const item = this.items[indice];
    // Tramos seguidos, un poco encimados para que no queden huecos en las curvas
    const tramos = Math.max(1, item.tramos ?? 1);
    const paso = (item.largo ?? 10) - 0.5;
    const largo = paso * (tramos - 1) + (item.largo ?? 10);
    const { n, ancho } = carriles(this.pista);
    const tapa = Math.max(1, Math.min(n - 1, item.carrilesCierre ?? 1));
    if (n < 2) return;
    const sTramo = (s: number, t: number) => s - largo / 2 + (item.largo ?? 10) / 2 + t * paso;
    const sLider = proyectar(this.pista, lider.carro.x, lider.carro.y, lider.carro.indice).s;
    const [cerca, max] = o.adelante;
    for (let intento = 0; intento < 12; intento++) {
      const s = sLider + cerca + this.azar() * (max - cerca);
      // Cada tramo es recto: en una curva cerrada no (se saldría de su carril)
      if (Array.from({ length: tramos }, (_, t) => this.giroEn(sTramo(s, t), paso)).some((g) => g > 0.2)) continue;
      if (!this.libreParaObra(s, largo)) continue;
      const k = Math.floor(this.azar() * (n - tapa + 1));
      const lateral = -this.pista.mitad + ancho * (k + tapa / 2);
      for (let t = 0; t < tramos; t++) {
        const p = puntoEnPista(this.pista, sTramo(s, t), lateral);
        const centro = puntoEnPista(this.pista, sTramo(s, t));
        this.soltar({ item: indice, dueno: "", x: p.x, y: p.y, angulo: centro.angulo, vx: 0, vy: 0, vida: this.ticks((item.aviso ?? 3) + (item.vida ?? 25)), objetivo: null });
      }
      this.obraEn = this.ticksCarrera + this.ticks(o.cada);
      return;
    }
  }

  /** Cuánto cambia la dirección del camino en `largo` m alrededor de `s` (rad): 0 en una recta */
  private giroEn(s: number, largo: number): number {
    const a = puntoEnPista(this.pista, s + largo / 2).angulo - puntoEnPista(this.pista, s - largo / 2).angulo;
    return Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
  }

  /**
   * ¿Cabe una obra de `largo` m centrada en `s` sin encimarse con otra obra (cierre o tubería), con
   * las cajas del camino ni con los peligros del ambiente?
   */
  private libreParaObra(s: number, largo: number): boolean {
    const L = this.pista.longitud;
    const lejos = (a: number, b: number) => {
      const d = (((a - b) % L) + L) % L;
      return Math.min(d, L - d);
    };
    const ocupado = [
      ...this.entidades
        .filter((e) => ["cierre", "tuberia"].includes(this.items[e.item]?.mecanica))
        .map((e) => ({ s: proyectar(this.pista, e.x, e.y).s, libre: (this.items[e.item].largo ?? 10) / 2 + 25 })),
      ...this.cajas.filter((c) => proyectar(this.pista, c.x, c.y).distancia < this.pista.mitad + 2).map((c) => ({ s: proyectar(this.pista, c.x, c.y).s, libre: 12 })),
      ...(this.circuito.ambiente ?? []).map((a) => ({ s: a.s, libre: 30 })),
      // Las rampas en el camino (el salto del puente: también donde se aterriza), las columnas y
      // los lugares donde caen escombros
      ...(this.circuito.rampas ?? [])
        .filter((r) => proyectar(this.pista, r.x, r.y).distancia < this.pista.mitad)
        .map((r) => ({ s: proyectar(this.pista, r.x, r.y).s + r.largo, libre: 40 })),
      ...(this.circuito.piezas ?? []).filter((p) => p.tipo === "columna").map((p) => ({ s: proyectar(this.pista, p.x, p.y).s, libre: 12 })),
      ...(this.circuito.escombros ?? []).map((l) => ({ s: l.s, libre: 12 })),
    ];
    return !ocupado.some((u) => lejos(u.s, s) < largo / 2 + u.libre);
  }

  /** ¿La cámara de la partida ve algo de esta tubería (contando lo que sale del camino)? */
  private tuberiaSeVe(item: Item, e: { x: number; y: number; angulo: number }): boolean {
    const m = medidasTuberia(this.pista, item);
    const c = Math.cos(e.angulo);
    const s = Math.sin(e.angulo);
    const fin = m.tubo + m.diametro + 3;
    for (const a of [m.pie, (m.pie + fin) / 2, fin]) {
      for (const b of [-this.pista.mitad - 12, -this.pista.mitad / 2, 0, this.pista.mitad / 2, this.pista.mitad + 12]) {
        if (this.seVe(e.x + a * c - b * s, e.y + a * s + b * c)) return true;
      }
    }
    return false;
  }

  /**
   * LA TUBERÍA (circuito.tuberia): en la carrera siempre hay una montada en algún lugar de la pista,
   * adelante del que va primero y donde la cámara no la ve (aparece ya montada, sin aviso). Cuando ya
   * quedó atrás del primero (todos los que siguen vivos la pasaron: el que se queda atrás de la
   * imagen explota) y la cámara ya no la ve, se quita sin que se note y se monta otra más adelante.
   */
  private ponerTuberia(): void {
    const t = this.circuito.tuberia;
    if (!t || this.fase !== "carrera" || this.ticksCarrera < this.tuberiaEn) return;
    this.tuberiaEn = this.ticksCarrera + this.ticks(0.5);
    const indice = this.items.findIndex((i) => i.id === t.item && i.mecanica === "tuberia");
    const lider = this.lider();
    if (indice < 0 || !lider) return;
    const item = this.items[indice];
    const L = this.pista.longitud;
    const sLider = proyectar(this.pista, lider.carro.x, lider.carro.y, lider.carro.indice).s;
    const adelante = (s: number) => (((s - sLider) % L) + L) % L;
    const actual = this.entidades.find((e) => e.item === indice);
    if (actual) {
      // ¿Ya la pasaron todos y no se ve? Se quita (y abajo se monta la siguiente). Pasada: el primero
      // llegó cerca de ella y ahora la tiene atrás
      const d = adelante(proyectar(this.pista, actual.x, actual.y).s);
      if (d < 80) this.tuberiaAlcanzada = true;
      if (!this.tuberiaAlcanzada || d < L / 2 || this.tuberiaSeVe(item, actual)) return;
      this.entidades = this.entidades.filter((e) => e !== actual);
      this.riesgosObra.delete(actual.id);
    }
    const largo = item.largo ?? 9;
    const vivos = [...this.jugadores.values()].filter((j) => j.vivo);
    const [cerca, max] = t.adelante;
    for (let intento = 0; intento < 20; intento++) {
      const s = sLider + cerca + this.azar() * (max - cerca);
      // Atravesada y con rampas rectas: solo en una recta
      if (this.giroEn(s, largo + 6) > 0.08) continue;
      if (!this.libreParaObra(s, largo)) continue;
      const centro = puntoEnPista(this.pista, s);
      const e = { x: centro.x, y: centro.y, angulo: centro.angulo };
      if (this.tuberiaSeVe(item, e)) continue;
      // Nadie encima (un carro que se quedó lejos de la cámara... ya habría explotado, pero por si acaso)
      if (vivos.some((j) => circulosCarro(j.carro).some((p) => enCierre(this.pista, item, e, p.x, p.y, 3)))) continue;
      this.soltar({ item: indice, dueno: "", ...e, vx: 0, vy: 0, vida: Infinity, objetivo: null });
      this.tuberiaAlcanzada = false;
      // Ya montada: nadie la vio llegar
      this.entidades[this.entidades.length - 1].etapa = 1;
      this.ponerRampasMovibles();
      return;
    }
  }

  private lider(): Jugador | null {
    let mejor: Jugador | null = null;
    for (const j of this.jugadores.values()) {
      if (!j.vivo) continue;
      if (!mejor || distanciaRecorrida(j.progreso, this.pista) > distanciaRecorrida(mejor.progreso, this.pista)) mejor = j;
    }
    return mejor;
  }

  private seguirLider(dt: number): void {
    const lider = this.lider();
    if (!lider) return;
    const { x, y, indice } = lider.carro;
    seguir(this.camara, this.pista, { x, y, indice, altura: alturaEn(this.pista, x, y) }, dt, PARAMETROS_CAMARA_PARTIDA);
    // Se aleja para que quepan los que vienen atrás
    const vivos = [...this.jugadores.values()].filter((j) => j.vivo);
    ajustarZoom(
      this.camara,
      vivos.map((j) => ({ x: j.carro.x, y: j.carro.y, altura: alturaEn(this.pista, j.carro.x, j.carro.y) })),
      dt,
    );
  }

  /* -------------------------------- Tick -------------------------------- */

  /**
   * Un tick del mundo: recarga créditos (y aplica lo que esperaba por ellos), choques, reglas.
   * Un jugador que no manda controles (pestaña en segundo plano, conexión atorada) no se
   * simula: su tiempo solo avanza con sus propios controles. En la carrera eso significa que
   * se queda atrás y explota, que es lo justo.
   */
  paso(): void {
    this.tick++;
    // Laboratorio: el item fijo vuelve en cuanto se usa (también al empezar cada ronda)
    for (const [id, indice] of this.itemsFijos) {
      const j = this.jugadores.get(id);
      if (j?.vivo && j.item < 0) j.item = indice;
    }
    this.itemTutorial();
    // La prisa de la ronda: la velocidad máxima va subiendo mientras dura la carrera (de 135 a
    // 190 km/h a los 35 s); en la espera y la cuenta vuelve a 1, y en el festejo se queda como iba
    const prisa = this.fase === "carrera" || this.fase === "ronda-fin" ? prisaDeRonda(this.ticksCarrera / this.tickHz) : 1;
    for (const j of this.jugadores.values()) j.carro.prisa = prisa;
    this.ritmoTutorial(prisa);
    // Los bots "mandan" su control de este tick, como cualquier jugador. Su agresividad va contra los
    // demás (las personas; en la campaña, también los otros bots)
    const riesgos = this.riesgos();
    const carrosVivos = [...this.jugadores.values()].filter((j) => j.vivo).map((j) => ({ carro: j.carro, bot: !!j.mente, id: j.id }));
    for (const j of this.jugadores.values()) {
      if (!j.mente) continue;
      const mueve = FASES_CON_MANEJO.includes(this.fase) && j.vivo;
      this.recibirControles(j.id, pensar(j.mente, j.carro, this.pista, this.tick, this.tickHz, j.item >= 0, this.azar, mueve, carrosVivos, this.peligroFuera(j), riesgos));
    }
    for (const j of this.jugadores.values()) {
      j.creditos = Math.min(this.maxCreditos, j.creditos + CREDITO_POR_TICK);
      this.aplicar(j);
    }
    if (this.fase === "ronda-fin") this.pasoFestejo();
    actualizarEscenario(this.pista, this.dt);
    // Choques entre carros vivos, después de mover a todos (con coletazos)
    const vivos = [...this.jugadores.values()].filter((j) => j.vivo);
    for (let a = 0; a < vivos.length; a++) {
      for (let b = a + 1; b < vivos.length; b++) this.chocar(vivos[a], vivos[b]);
    }
    this.aplastarCarros(vivos);
    if (this.fase === "carrera" && this.circuito.excavacion) {
      const p = this.circuito.excavacion.pala;
      const centro = puntoEnPista(this.pista, p.s);
      for (const j of this.excavacion.actualizar(this.tick / this.tickHz, vivos)) {
        if (j.carro.escudo > 0 || j.carro.pesado > 0) {
          this.eventos.push({ tipo: "escudo", id: j.id, x: j.carro.x, y: j.carro.y });
          continue;
        }
        const jugador = this.jugadores.get(j.id)!;
        this.golpear(jugador, -1, { empujon: [-Math.sin(centro.angulo) * p.empuje, Math.cos(centro.angulo) * p.empuje] }, true);
        j.carro.empujon = Math.max(j.carro.empujon, p.deslizamiento);
        this.eventos.push({ tipo: "obra", id: j.id, objeto: "pala-excavacion", x: j.carro.x, y: j.carro.y, fuerza: p.empuje });
      }
    }
    if (FASES_CON_MANEJO.includes(this.fase)) {
      for (const j of vivos) actualizarProgreso(j.progreso, j.carro, this.pista);
      const lider = this.lider();
      if (lider) this.avanceMax = Math.max(this.avanceMax, distanciaRecorrida(lider.progreso, this.pista));
      this.pasoItems(vivos);
    }

    // Modo local: la pantalla no tiene carro propio que seguir; en la espera también sigue al de adelante
    if (this.pantalla && this.fase === "espera") this.seguirLider(this.dt);

    // Multijugador: los bots dicen "listo" cuando les toca
    if (this.multi && this.fase === "espera") {
      for (const j of this.jugadores.values()) {
        if (j.listoEn === null || this.tick < j.listoEn) continue;
        j.listoEn = null;
        j.listo = true;
        this.cambioJugadores = true;
      }
    }
    // Multijugador: se acabó la pantalla de victoria, todos a la sala de espera
    if (this.multi && this.fase === "resultados" && this.restante > 0 && --this.restante <= 0) this.volverAEspera();

    // Multijugador: terminó la preparación, empieza la partida
    if (this.preparacionHasta !== null && this.tick >= this.preparacionHasta) {
      if (this.entrePartidas && this.jugadores.size >= MIN_JUGADORES_PARTIDA) this.iniciarPartida();
      else this.cancelarPreparacion();
    }

    switch (this.fase) {
      case "cuenta":
        if (--this.restante <= 0) {
          this.ticksCarrera = 0;
          this.obraEn = this.ticks(this.circuito.obras?.primera ?? 0);
          this.tuberiaEn = 0;
          this.cambiarFase("carrera", 0);
        }
        break;
      case "carrera":
        this.meteoritosDeBots();
        this.pasoCarrera(vivos);
        break;
      case "ronda-fin":
        if (--this.restante > 0) break;
        if (this.tutorial) {
          this.siguienteLeccion();
          break;
        }
        if (this.ganadorRonda && this.jugadores.get(this.ganadorRonda)!.puntos >= this.meta) {
          this.ganador = this.ganadorRonda;
          // Multijugador: la pantalla de victoria un rato y luego todos a la sala de espera
          this.cambiarFase("resultados", this.multi ? RESULTADOS_MULTI_S : 0);
          this.contarCopa();
        } else {
          // Todos reaparecen juntos donde iba el ganador (o el líder, si nadie ganó)
          const base = this.jugadores.get(this.ganadorRonda ?? "") ?? this.lider() ?? [...this.jugadores.values()][0];
          this.nuevaRonda(base.progreso.s, base.progreso.vueltas);
        }
        break;
    }
  }

  /**
   * El tutorial, al terminar una lección: la siguiente (la 1 se repite si te caíste antes de
   * tiempo) o, después de la última, los resultados con la persona como ganadora
   */
  private siguienteLeccion(): void {
    const t = this.tutorial!;
    const persona = [...this.jugadores.values()].find((j) => !j.mente);
    const repetir = t.leccion === 1 && !this.ganadorRonda;
    if (!repetir) t.leccion++;
    this.cambioPartida = true;
    if (t.leccion > TUTORIAL.lecciones) {
      this.ganador = persona?.id ?? null;
      this.cambiarFase("resultados", 0);
      return;
    }
    const base = this.jugadores.get(this.ganadorRonda ?? "") ?? this.lider() ?? persona ?? [...this.jugadores.values()][0];
    this.nuevaRonda(base.progreso.s, base.progreso.vueltas);
  }

  /** Lección 2 del tutorial: tu tope, el de los bots; y si te les vas, más bajo (ver TUTORIAL.ritmo) */
  private ritmoTutorial(prisa: number): void {
    const t = this.tutorial;
    if (!t || (t.leccion !== 2 && t.leccion !== 3)) return;
    const r = TUTORIAL.ritmo;
    const a = TUTORIAL.alcance;
    const persona = [...this.jugadores.values()].find((j) => !j.mente);
    if (!persona) return;
    const bots = [...this.jugadores.values()].filter((j) => j.mente && j.vivo);
    const ventaja = bots.length && persona.vivo ? this.recorrido(persona.id) - Math.max(...bots.map((b) => this.recorrido(b.id))) : 0;
    const entre = (x: number, desde: number, hasta: number) => Math.min(1, Math.max(0, (x - desde) / (hasta - desde)));
    // Lo normal: en la 2, el tope de los bots (y más bajo si te les vas); en la 3, el de siempre
    const lejos = t.leccion === 2 ? entre(ventaja, r.desde, r.hasta) : 0;
    const base = t.leccion === 2 ? r.igual - (r.igual - r.minimo) * lejos : 1;
    // Atrás: tú más rápido y ellos más lento
    const atras = entre(-ventaja, a.desde, a.hasta);
    const objetivo = base + (a.impulso - base) * atras;
    const objetivoBots = 1 - (1 - a.botsMinimo) * atras;
    // En la cuenta queda de una vez; luego cambia poco a poco (alcanzar, más rápido que frenar)
    const enCuenta = this.fase === "cuenta";
    const paso = enCuenta ? Infinity : (objetivo > t.ritmo ? a.cambio : r.cambio) * this.dt;
    t.ritmo += Math.max(-paso, Math.min(paso, objetivo - t.ritmo));
    const pasoBots = enCuenta ? Infinity : a.cambio * this.dt;
    t.ritmoBots += Math.max(-pasoBots, Math.min(pasoBots, objetivoBots - t.ritmoBots));
    persona.carro.prisa = prisa * t.ritmo;
    for (const b of bots) b.carro.prisa = prisa * t.ritmoBots;
  }

  /** Lección 3 del tutorial: la persona siempre trae el item; vuelve un momento después de usarlo */
  private itemTutorial(): void {
    const t = this.tutorial;
    if (!t || t.leccion !== 3 || !(this.fase === "cuenta" || this.fase === "carrera")) return;
    const indice = this.items.findIndex((i) => i.id === TUTORIAL.item);
    if (indice < 0) return;
    for (const j of this.jugadores.values()) {
      if (j.mente || !j.vivo || j.item >= 0) continue;
      if (t.itemEn === null) t.itemEn = this.tick + (this.fase === "cuenta" ? 0 : this.ticks(TUTORIAL.recargaItem));
      if (this.tick < t.itemEn) continue;
      j.item = indice;
      t.itemEn = null;
      this.eventos.push({ tipo: "item", id: j.id, item: indice });
    }
  }

  /**
   * Fin de ronda: los controles de las personas se ignoran (no hay manejo) y el que quedó en pie
   * sigue manejando solo, como un bot, sin usar items. Así no se congela de golpe y la cámara del
   * festejo lo sigue. Su progreso avanza: la siguiente ronda sale de donde llegó
   */
  private pasoFestejo(): void {
    if (this.stickerBotEn !== null && this.tick >= this.stickerBotEn && this.ganadorRonda) {
      this.stickerBotEn = null;
      this.eventos.push({ tipo: "sticker", id: this.ganadorRonda, sticker: STICKERS[Math.floor(this.azar() * STICKERS.length)] });
    }
    for (const j of this.jugadores.values()) {
      if (!j.vivo) continue;
      j.piloto ??= crearMente(this.azar);
      const ctrl = pensar(j.piloto, j.carro, this.pista, this.tick, this.tickHz, false, this.azar, true);
      avanzarCarro(j.carro, ctrl, PARAMETROS_FISICA, this.pista, this.dt, (impacto) => this.eventos.push({ tipo: "obra", id: j.id, ...impacto }));
      this.chocarConLoSuelto(j.carro);
      actualizarProgreso(j.progreso, j.carro, this.pista);
    }
  }

  /**
   * Laboratorio: la trampa de prueba, adelante de la salida (`s`, la parrilla va detrás), a cada
   * uno de sus metros. La suelta un "fantasma" parado ahí con la mecánica de siempre (así queda
   * igual que en una carrera); las que caen lejos de quien las suelta se recorren
   */
  private ponerTrampasPrueba(s: number): void {
    const prueba = this.trampaPrueba;
    const item = prueba && this.items[prueba.item];
    if (!prueba || !item) return;
    // Las de la ronda anterior se quitan
    this.entidades = this.entidades.filter((e) => e.dueno !== DUENO_TRAMPA);
    for (const metros of prueba.metros) {
      if (item.mecanica === "alfombra") {
        // La bolsa riega por donde pasa: aquí, un rastro de 6 tramos
        for (let k = 0; k < 6; k++) {
          const p = puntoEnPista(this.pista, s + metros + k * TRAMO, 0);
          this.soltar({ item: prueba.item, dueno: DUENO_TRAMPA, x: p.x, y: p.y, angulo: p.angulo, vx: 0, vy: 0, vida: Math.round((item.vida ?? 9) * this.tickHz), objetivo: TRAMO_CLAVOS });
        }
        continue;
      }
      // Lo que cae adelante de quien lo suelta (el andamio, el espejismo): el fantasma, más atrás
      const antes = item.mecanica === "barrera" ? (item.alcance ?? 35) : item.mecanica === "senuelo" ? (item.alcance ?? 30) : -4;
      const fantasma = { id: DUENO_TRAMPA, carro: crearCarro(this.pista, s + metros - antes, 0) };
      MECANICAS[item.mecanica].usar(this, fantasma, prueba.item, item);
    }
  }

  /** Un choque fuerte (o un coletazo) se avisa para el sonido y las chispas */
  /**
   * CAERLE ENCIMA A OTRO CARRO LO EXPLOTA: el que viene cayendo (de un salto, del gancho de la
   * grúa, de la orilla del puente) y toca el techo de uno que está abajo, lo aplasta. Con el
   * escudo o el casco, el de abajo aguanta. Lo decide solo el servidor
   */
  private aplastarCarros(vivos: Jugador[]): void {
    for (const arriba of vivos) {
      const a = arriba.carro;
      if (!arriba.vivo || !enElAire(a) || a.vz >= 0) continue;
      for (const abajo of vivos) {
        const b = abajo.carro;
        if (abajo === arriba || !abajo.vivo) continue;
        const encima = a.z - b.z;
        if (encima < ALTO_TECHO * 0.35 || encima > ALTO_TECHO) continue;
        const toca = circulosCarro(a).some((p) => circulosCarro(b).some((q) => Math.hypot(p.x - q.x, p.y - q.y) < PARAMETROS_FISICA.radio * 1.6));
        if (!toca) continue;
        if (b.escudo > 0 || b.pesado > 0) {
          this.eventos.push({ tipo: "escudo", id: abajo.id, x: b.x, y: b.y });
          // Rebota: sigue cayendo pero ya no encima de él este tick
          a.vz = Math.abs(a.vz) * 0.3;
          continue;
        }
        this.eliminar(abajo, "aplastado");
      }
    }
  }

  private chocar(a: Jugador, b: Jugador): void {
    const par = [a.id, b.id].sort().join("|");
    const hasta = this.sinChoque.get(par);
    if (hasta !== undefined) {
      if (this.tick < hasta) return;
      this.sinChoque.delete(par);
    }
    // Con la dirección de la pista ahí se sabe quién se le echó encima a quién (ver parteDeA)
    // El tutorial: un bot que chocas sale volando (ver TUTORIAL.golpe)
    const bot = this.tutorial && !!a.mente !== !!b.mente ? (a.mente ? a : b) : null;
    const antes = bot && { vx: bot.carro.vx, vy: bot.carro.vy };
    const { fuerza, descontrolados } = chocarCarros(a.carro, b.carro, PARAMETROS_FISICA, this.tickHz, direccionPista(this.pista, a.carro.indice));
    if (bot && antes && fuerza > 0) this.golpeTutorial(bot, antes);
    if (fuerza < 4 && !descontrolados.length) return;
    // Al rencoroso que sale empujado o descontrolado le queda el rencor contra el otro
    for (const [victima, otro] of [[a, b], [b, a]]) {
      const rencor = victima.mente?.personalidad.rencor;
      if (!rencor || !(victima.carro.empujon > 0 || descontrolados.includes(victima.carro))) continue;
      victima.mente!.rencor = { id: otro.id, hasta: this.tick + Math.round(rencor.segundos * this.tickHz) };
    }
    this.eventos.push({
      tipo: "choque",
      ids: [a.id, b.id],
      x: (a.carro.x + b.carro.x) / 2,
      y: (a.carro.y + b.carro.y) / 2,
      fuerza,
      descontrolados: descontrolados.map((c) => (c === a.carro ? a.id : b.id)),
    });
  }

  /** El tutorial: lo que el choque le cambió a la velocidad del bot, mucho más grande, y sin agarre un rato */
  private golpeTutorial(bot: Jugador, antes: { vx: number; vy: number }): void {
    const g = TUTORIAL.golpe;
    const c = bot.carro;
    const dx = c.vx - antes.vx;
    const dy = c.vy - antes.vy;
    const cambio = Math.hypot(dx, dy);
    if (cambio < 0.05) return;
    const nuevo = Math.min(g.maximo, Math.max(g.minimo, cambio * g.multiplica));
    c.vx = antes.vx + (dx / cambio) * nuevo;
    c.vy = antes.vy + (dy / cambio) * nuevo;
    c.empujon = Math.max(c.empujon, g.empujonS);
  }

  private pasoCarrera(vivos: Jugador[]): void {
    this.ticksCarrera++;
    this.seguirLider(this.dt);
    const lider = this.lider();
    for (const j of vivos) {
      if (!j.vivo) continue;
      const { x, y } = j.carro;
      // Pegado al borde de la imagen: más motor para alcanzar (lo predice el navegador). Solo a las
      // personas: los bots no lo necesitan, y con él se volvían imposibles de dejar atrás
      if (!j.mente && j !== lider && alBorde(j.carro, alturaEn(this.pista, x, y), this.camara)) j.carro.rezago = this.ticks(REZAGO);
      const r = revisarEliminacion(j.carro, alturaEn(this.pista, x, y), j.fuera, this.camara, this.pista, this.ticksCarrera, this.tickHz);
      j.fuera = r.fuera;
      if (r.motivo) this.eliminar(j, r.motivo);
    }
    this.revisarFinDeRonda();
  }

  /* ------------------------------ A la red ------------------------------ */

  instantanea(incluirEscenario = true): Instantanea {
    const compartida = this.fase !== "espera" || (!!this.pantalla && this.camara.iniciada);
    const { x, y, h, rumbo, zoom } = this.camara;
    return {
      k: this.tick,
      ...(this.circuito.excavacion ? { ex: { ...this.excavacion.estado, puente: [...this.excavacion.estado.puente] } } : {}),
      f: FASES.indexOf(this.fase),
      cam: compartida ? [red3(x), red3(y), red3(h), red4(rumbo), red3(zoom)] : null,
      c: [...this.jugadores.values()].map((j) => empacarCarro(j.id, j.carro, j.ultimoSeq, j.vivo, j.item)),
      // Lo que persiste no se gasta: se manda como vida completa
      e: this.entidades.map((e) => [
        e.id,
        e.item,
        red3(e.x),
        red3(e.y),
        red4(e.angulo),
        Number.isFinite(e.vidaMax) ? red3(e.vida / e.vidaMax) : 1,
        e.etapa,
      ]),
      ci: this.cajas.flatMap((caja, i) => (caja.hasta > this.tick ? [i] : [])),
      cc: this.cajas.map((c) => c.categoria),
      ...(incluirEscenario && this.pista.circuito.terreno === "obra" ? { o: empacarEscenario(this.pista) } : {}),
    };
  }

  partida(): EstadoPartida {
    return {
      fase: this.fase,
      ronda: this.ronda,
      restanteMs: Math.round((this.restante * 1000) / this.tickHz),
      meta: this.meta,
      puntos: [...this.jugadores.values()].map((j) => ({ id: j.id, puntos: j.puntos })),
      ganadorRonda: this.ganadorRonda,
      ganador: this.ganador,
      ...(this.tutorial ? { leccion: Math.min(this.tutorial.leccion, TUTORIAL.lecciones) } : {}),
      ...(this.preparacionHasta !== null ? { preparacionMs: Math.max(0, Math.round(((this.preparacionHasta - this.tick) * 1000) / this.tickHz)) } : {}),
    };
  }

  estado(): EstadoSala {
    const jugadores = [...this.jugadores.values()]
      .sort((a, b) => a.lugar - b.lugar)
      .map(({ id, nombre, color, vehiculo, mente, listo }) => ({
        id,
        nombre,
        color,
        // El de todos no se manda: pesa menos y los navegadores viejos no lo extrañan
        ...(vehiculo !== VEHICULOS[0] ? { vehiculo } : {}),
        // En multijugador los bots también dicen "listo" (con su tiempo)
        ...(mente ? { bot: true, ...(this.multi && listo ? { listo } : {}) } : listo ? { listo } : {}),
      }));
    return {
      codigo: this.codigo,
      circuito: this.circuito.id,
      local: !!this.pantalla,
      tickHz: this.tickHz,
      estadoHz: this.estadoHz,
      protocolo: 2,
      anfitrion: this.anfitrion,
      jugadores,
      ...(this.multi ? { multi: true, privada: this.multi.privada } : {}),
    };
  }
}

export class GestorSalas {
  private readonly salas = new Map<string, Sala>();

  /**
   * `circuitos`: los mapas que se pueden escoger al crear una sala (los `oculto` no, salvo que
   * sean el de por defecto); `porDefecto`: el que se usa si no se escoge uno válido.
   */
  constructor(
    private readonly circuitos: Circuito[],
    private readonly porDefecto: string,
    private readonly maxSalas: number,
    private readonly tickHz: number,
    private readonly meta = 5,
    private readonly items: Item[] = [],
  ) {}

  get total(): number {
    return this.salas.size;
  }

  /** El circuito con ese id si se puede jugar, o el de por defecto */
  circuito(id?: unknown, ocultos = false): Circuito {
    const elegible = (c: Circuito) => ocultos || !c.oculto || c.id === this.porDefecto;
    return (
      this.circuitos.find((c) => c.id === id && elegible(c)) ??
      this.circuitos.find((c) => c.id === this.porDefecto) ??
      this.circuitos[0]
    );
  }

  /** Una sala nueva con código libre en el mapa `idCircuito`, o null si ya hay demasiadas */
  /** `ocultos`: también los circuitos en preparación (solo el laboratorio, con JUEGO_PRUEBAS) */
  crear(idCircuito?: unknown, ocultos = false): Sala | null {
    if (this.salas.size >= this.maxSalas) return null;
    let codigo: string;
    // No es secreto (se comparte para entrar): Math.random basta, y así la sala corre también en el navegador
    do codigo = `HMO-${1000 + Math.floor(Math.random() * 9000)}`;
    while (this.salas.has(codigo));
    const sala = new Sala(codigo, this.circuito(idCircuito, ocultos), this.tickHz, this.meta, this.items);
    this.salas.set(codigo, sala);
    return sala;
  }

  buscar(codigo: string): Sala | undefined {
    return this.salas.get(codigo);
  }

  /** Las salas con lugar: primero las que esperan gente, luego las más llenas */
  abiertas(): SalaAbierta[] {
    // Las de modo local no se listan: se entra con el código o el QR que muestra su pantalla
    return [...this.salas.values()]
      // Ni las de copa: son de un solo jugador (la campaña); ni las privadas (solo con el código)
      .filter((s) => !s.vacia && !s.pantalla && !s.copa && !s.tutorial && !s.multi?.privada && s.jugadores.size < MAX_JUGADORES)
      .map((s) => {
        const jugadores = [...s.jugadores.values()];
        return {
          codigo: s.codigo,
          circuito: s.circuito.id,
          anfitrion: s.jugadores.get(s.anfitrion)?.nombre ?? "",
          jugadores: jugadores.length,
          bots: jugadores.filter((j) => j.mente).length,
          fase: s.fase,
          ...(s.multi ? { multi: true } : {}),
        };
      })
      .sort((a, b) => Number(a.fase !== "espera") - Number(b.fase !== "espera") || b.jugadores - a.jugadores);
  }

  borrar(codigo: string): void {
    this.salas.delete(codigo);
  }

  /** Un circuito al azar de los que se pueden escoger (Partida rápida "aleatoria") */
  aleatorio(azar: () => number = Math.random): Circuito {
    const elegibles = this.circuitos.filter((c) => !c.oculto || c.id === this.porDefecto);
    return elegibles[Math.floor(azar() * elegibles.length)] ?? this.circuito();
  }

  /**
   * PARTIDA RÁPIDA: la sala multijugador pública que espera gente con lugar para una persona más
   * (un bot se lo cede: Sala.hacerLugar), en el circuito pedido (null: cualquiera). Primero la que
   * tiene más personas. undefined si no hay
   */
  rapida(circuito: string | null): Sala | undefined {
    const personas = (s: Sala) => [...s.jugadores.values()].filter((j) => !j.mente).length;
    return [...this.salas.values()]
      .filter((s) => s.multi && !s.multi.privada && !s.vacia && s.fase === "espera" && !s.preparando && personas(s) < MAX_JUGADORES)
      .filter((s) => circuito === null || s.circuito.id === circuito)
      .sort((a, b) => personas(b) - personas(a))[0];
  }
}
