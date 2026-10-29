import { randomInt } from "crypto";
import type { Circuito, EstadoCarro, Item } from "../compartido/tipos";
import { alturaEn, cajasDelCircuito, enAgua, prepararPista, proyectar, puntoEnPista, type Pista } from "../compartido/pista";
import { PARAMETROS_FISICA, avanzarCarro, chocarCarros, circulosCarro, colisionFija, crearCarro } from "../compartido/fisica";
import { PARAMETROS_CAMARA_PARTIDA, ajustarZoom, crearCamara, enVista, seguir, type Camara } from "../compartido/camara";
import {
  CATEGORIAS,
  COLORES,
  FASES,
  FASES_CON_MANEJO,
  MAX_JUGADORES,
  empacarCarro,
  type ControlesRed,
  type DatosJugador,
  type EstadoPartida,
  type EstadoSala,
  type Evento,
  type Fase,
  type Instantanea,
  type SalaAbierta,
} from "../compartido/protocolo";
import {
  DURACION,
  METEORITO,
  REZAGO,
  actualizarProgreso,
  alBorde,
  distanciaRecorrida,
  revisarEliminacion,
  type MotivoEliminacion,
  type Progreso,
} from "./reglas";
import { MECANICAS, etapaDebida, sacarItem, type Conductor, type Efecto, type Entidad, type MundoItems } from "./items";
import { NOMBRES_BOT, crearMente, pensar, type MenteBot } from "./bots";

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
const MAX_CREDITOS = 6;
/** Controles en espera (~330 ms). Más que esto es un cliente atorado: se tiran los viejos */
const MAX_COLA = 10;
const MIN_JUGADORES_PARTIDA = 2;
/** Metros entre un lugar de la parrilla y el siguiente */
const SEPARACION_PARRILLA = 5;
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
  /** Desde qué tick puede tirar otro meteorito (de espectador) */
  meteoritoListo: number;
}

export class Sala implements MundoItems {
  readonly jugadores = new Map<string, Jugador>();
  readonly pista: Pista;
  tick = 0;

  /** Lo que anda suelto en la pista (burros, baches, coyotas…) */
  entidades: Entidad[] = [];
  private siguienteEntidad = 1;
  /** Las cajas de items: dónde están ahora, de qué color y hasta cuándo están apagadas */
  readonly cajas: Caja[];
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
  ronda = 0;
  ganadorRonda: string | null = null;
  ganador: string | null = null;
  readonly camara: Camara = crearCamara();

  /** Lo que pasó desde la última vez que se leyó (lo manda el socket) */
  eventos: Evento[] = [];
  /** La fase, la ronda o los puntos cambiaron: hay que avisar */
  cambioPartida = false;

  constructor(
    readonly codigo: string,
    readonly circuito: Circuito,
    readonly tickHz: number,
    readonly meta = 5,
    readonly items: Item[] = [],
    readonly azar: () => number = Math.random,
  ) {
    this.pista = prepararPista(circuito);
    this.cajas = cajasDelCircuito(circuito).map(([x, y, z]) => ({ x, y, z, categoria: 0, hasta: 0 }));
    this.cajas.forEach((caja) => this.pintarCaja(caja));
    this.proximaCalle = this.ticks(CALLE_CADA[0]);
  }

  /** Modo local: el id de la pantalla (la anfitriona, sin carro), o null */
  pantalla: string | null = null;

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

  /* ----------------------------- Jugadores ----------------------------- */

  /** Agrega un bot con el primer nombre y color libres. Devuelve un error o null */
  agregarBot(): string | null {
    const usados = new Set([...this.jugadores.values()].map((j) => j.nombre));
    const nombre = NOMBRES_BOT.find((n) => !usados.has(n)) ?? "Bot";
    let n = 1;
    while (this.jugadores.has(`bot-${n}`)) n++;
    const colores = new Set([...this.jugadores.values()].map((j) => j.color));
    const color = COLORES.find((c) => !colores.has(c.id))?.id ?? COLORES[0].id;
    const error = this.agregar(`bot-${n}`, { nombre, color });
    if (!error) this.jugadores.get(`bot-${n}`)!.mente = crearMente(this.azar);
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
      meteoritoListo: 0,
    });
    this.cambioPartida = true;
    return null;
  }

  quitar(id: string): void {
    if (!this.jugadores.delete(id)) return;
    this.cambioPartida = true;
    // Sin gente suficiente no hay partida: todos de vuelta a la sala de espera
    if (this.fase !== "espera" && this.jugadores.size < MIN_JUGADORES_PARTIDA) this.volverAEspera();
    else if (this.fase === "carrera") this.revisarFinDeRonda();
  }

  /** Quien manda en la sala: la pantalla en modo local; si no, la primera persona (nunca un bot) */
  get anfitrion(): string {
    if (this.pantalla) return this.pantalla;
    return [...this.jugadores.values()].filter((j) => !j.mente).sort((a, b) => a.lugar - b.lugar)[0]?.id ?? "";
  }

  /**
   * Parrilla intercalada detrás del punto `s` de la pista: el primero hasta adelante a la
   * izquierda, el segundo a la derecha y un poco más atrás, el tercero a la izquierda más atrás…
   */
  private carroEnParrilla(posicion: number, s: number): EstadoCarro {
    const lado = posicion % 2 ? 1 : -1;
    return crearCarro(this.pista, s - 6 - posicion * SEPARACION_PARRILLA, lado * this.pista.mitad * 0.45);
  }

  /* ------------------------------ Controles ----------------------------- */

  recibirControles(id: string, ctrl: ControlesRed): void {
    const j = this.jugadores.get(id);
    if (!j || ctrl.seq <= j.ultimoSeq || ctrl.seq <= (j.cola.at(-1)?.seq ?? -1)) return;
    j.cola.push(ctrl);
    if (j.cola.length > MAX_COLA) j.cola.splice(0, j.cola.length - MAX_COLA);
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
        avanzarCarro(j.carro, ctrl, PARAMETROS_FISICA, this.pista, this.dt);
        // Postes y asadores: en el mismo orden que la predicción del navegador (justo después de avanzar)
        for (const e of this.estorbos()) colisionFija(j.carro, e.x, e.y, this.items[e.item].radio ?? 0.5, PARAMETROS_FISICA);
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
   * Un espectador tira un meteorito a (x, y): tiene que estar en la carrera ya eliminado, en una
   * sala de más de 2, sin otro meteorito suyo en el aire, ya recargado, y el punto tiene que
   * verse en la cámara compartida (en tierra). Devuelve un error o null.
   */
  lanzarMeteorito(id: string, x: number, y: number): string | null {
    const j = this.jugadores.get(id);
    const indice = this.items.findIndex((i) => i.mecanica === "meteorito");
    const item = this.items[indice];
    if (!j || !item) return "No hay meteoritos en esta sala";
    if (this.fase !== "carrera") return "Los meteoritos se tiran durante la carrera";
    if (j.vivo) return "Solo quien ya explotó puede tirar meteoritos";
    if (this.jugadores.size < METEORITO.minJugadores) return `Se necesitan al menos ${METEORITO.minJugadores} jugadores`;
    if (this.tick < j.meteoritoListo || this.entidades.some((e) => e.dueno === id && e.item === indice)) {
      return "Tu meteorito todavía no está listo";
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "Punto inválido";
    if (!enVista(this.camara, x, y, alturaEn(this.pista, x, y), PARAMETROS_CAMARA_PARTIDA, 0) || enAgua(this.pista, x, y)) {
      return "Apunta a algo que se vea en la pantalla";
    }
    this.soltar({
      item: indice,
      dueno: id,
      x,
      y,
      angulo: this.azar() * Math.PI * 2,
      vx: 0,
      vy: 0,
      vida: this.ticks(item.vida ?? 1.25),
      objetivo: null,
    });
    j.meteoritoListo = this.tick + this.ticks(METEORITO.recarga);
    this.eventos.push({ tipo: "meteorito", id, x, y });
    return null;
  }

  /** Cayó un meteorito: explota quien tenga alguna parte de su carro dentro del radio */
  aplastar(x: number, y: number, radio: number): void {
    this.eventos.push({ tipo: "impacto", x, y });
    for (const j of this.jugadores.values()) {
      if (!j.vivo) continue;
      const debajo = circulosCarro(j.carro).some((c) => Math.hypot(c.x - x, c.y - y) < radio + PARAMETROS_FISICA.radio);
      if (debajo) this.eliminar(j, "meteorito");
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

  /** Lo sólido que está en el piso (postes, asadores) */
  private estorbos(): Entidad[] {
    return this.entidades.filter((e) => this.items[e.item]?.mecanica === "estorbo");
  }

  /** Aplica el efecto de un item a un carro (las duraciones no se suman: se toma la mayor) */
  golpear(victima: Conductor, item: number, efecto: Efecto, silencioso = false): void {
    const c = victima.carro;
    const t = (s?: number) => (s ? Math.round(s * this.tickHz) : 0);
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
      this.items.some((item) => item.categoria === CATEGORIAS[k].id && item.probabilidad > 0),
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
      quien.item = sacarItem(this.items, this.azar, CATEGORIAS[caja.categoria]?.id);
      caja.hasta = this.tick + Math.round(CAJA_APAGADA * this.tickHz);
      // Cuando vuelva a salir será de otro color
      this.pintarCaja(caja);
      this.eventos.push({ tipo: "item", id: quien.id, item: quien.item });
    }

    this.taparBaches();
    this.ponerCalle();
    const dejados: Entidad[] = [];
    this.entidades = this.entidades.filter((e) => {
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
    for (const e of dejados) this.dejar(e);

    for (const j of vivos) {
      if (j.carro.turbo <= 0 || j.turboItem < 0) continue;
      const item = this.items[j.turboItem];
      MECANICAS[item.mecanica].mientras?.(this, j, j.turboItem, item, this.tick);
    }
  }

  /**
   * Ronda nueva o sala de espera: cajas encendidas y nadie trae item. Entre rondas lo que persiste
   * (postes, baches, charcos, asadores) se queda, salvo lo que haya quedado sobre la parrilla;
   * lo demás (burros, topes, coyotas…) se quita. `todo` también quita lo que persiste.
   */
  private limpiarItems(todo: boolean): void {
    this.entidades = this.entidades.filter(
      (e) =>
        !todo &&
        !Number.isFinite(e.vida) &&
        [...this.jugadores.values()].every((j) => Math.hypot(j.carro.x - e.x, j.carro.y - e.y) > PERSISTENTES_LEJOS_DE_PARRILLA),
    );
    for (const caja of this.cajas) {
      caja.hasta = 0;
      this.pintarCaja(caja);
    }
    for (const j of this.jugadores.values()) {
      j.item = -1;
      j.turboItem = -1;
    }
  }

  /* ------------------------------ Partida ------------------------------ */

  /** El anfitrión empieza (o repite desde resultados). Devuelve un error o null */
  empezar(id: string): string | null {
    if (id !== this.anfitrion) return "Solo quien creó la sala puede empezar";
    if (this.fase !== "espera" && this.fase !== "resultados") return "La partida ya empezó";
    if (this.jugadores.size < MIN_JUGADORES_PARTIDA) return `Se necesitan al menos ${MIN_JUGADORES_PARTIDA} jugadores`;
    for (const j of this.jugadores.values()) j.puntos = 0;
    this.ronda = 0;
    this.ganador = null;
    // La primera ronda sale en el orden en que entraron a la sala
    this.ordenSalida = [...this.jugadores.values()].sort((a, b) => a.lugar - b.lugar).map((j) => j.id);
    // Partida nueva, pista limpia: lo que persistía de la partida anterior se va
    this.limpiarItems(true);
    this.nuevaRonda(0, 0);
    this.reiniciarAvance();
    return null;
  }

  /**
   * Todos a la parrilla detrás de `s` (la meta, o donde iba el ganador) y cuenta regresiva.
   * Salir adelante es ventaja, así que el orden es el de `ordenSalida`: el ganador de la ronda
   * anterior hasta atrás y el primero que explotó hasta adelante. Quien entró después de que se
   * armó ese orden sale todavía más adelante (llega sin puntos).
   */
  private nuevaRonda(s: number, vueltas: number): void {
    this.ronda++;
    this.ganadorRonda = null;
    const conocidos = this.ordenSalida.filter((id) => this.jugadores.has(id));
    const nuevos = [...this.jugadores.keys()].filter((id) => !conocidos.includes(id));
    [...nuevos, ...conocidos].forEach((id, posicion) => {
      const j = this.jugadores.get(id)!;
      j.carro = this.carroEnParrilla(posicion, s);
      j.vivo = true;
      j.fuera = 0;
      j.cola = [];
      j.progreso = { vueltas, s: proyectar(this.pista, j.carro.x, j.carro.y).s };
      // Si la parrilla quedó del otro lado de la meta, ajusta la vuelta
      if (j.progreso.s - s > this.pista.longitud / 2) j.progreso.vueltas--;
    });
    this.caidos = [];
    this.limpiarItems(false);
    // Nadie arranca con item: las cajas que quedaron sobre la parrilla se apagan hasta un rato después del arranque
    const hasta = this.tick + this.ticks(DURACION.cuenta + 4);
    for (const caja of this.cajas) {
      const cerca = [...this.jugadores.values()].some((j) => Math.hypot(j.carro.x - caja.x, j.carro.y - caja.y) < CAJAS_LEJOS_DE_PARRILLA);
      if (cerca) caja.hasta = hasta;
    }
    this.camara.iniciada = false;
    this.camara.zoom = 1;
    this.seguirLider(0);
    this.cambiarFase("cuenta", DURACION.cuenta);
  }

  private volverAEspera(): void {
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
    j.cola = [];
    this.caidos.push(j.id);
    this.eventos.push({ tipo: "explosion", id: j.id, x: j.carro.x, y: j.carro.y, motivo });
  }

  /** La ronda termina cuando queda uno (o ninguno, si cayeron al mismo tiempo) */
  private revisarFinDeRonda(): void {
    const vivos = [...this.jugadores.values()].filter((j) => j.vivo);
    if (vivos.length > 1) return;
    const ganador = vivos[0] ?? null;
    if (ganador) ganador.puntos++;
    this.ganadorRonda = ganador?.id ?? null;
    // Orden de la siguiente salida: al revés de como terminaron. Primero los que vieron la ronda
    // de espectadores, luego los que cayeron (el primero en caer, más adelante) y el ganador al final
    const espectadores = [...this.jugadores.values()].filter((j) => !j.vivo && !this.caidos.includes(j.id)).map((j) => j.id);
    this.ordenSalida = [...espectadores, ...this.caidos, ...vivos.map((j) => j.id)];
    this.eventos.push({ tipo: "punto", id: this.ganadorRonda });
    this.cambiarFase("ronda-fin", DURACION.rondaFin);
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
    // Los bots "mandan" su control de este tick, como cualquier jugador
    for (const j of this.jugadores.values()) {
      if (!j.mente) continue;
      const mueve = FASES_CON_MANEJO.includes(this.fase) && j.vivo;
      this.recibirControles(j.id, pensar(j.mente, j.carro, this.pista, this.tick, this.tickHz, j.item >= 0, this.azar, mueve));
    }
    for (const j of this.jugadores.values()) {
      j.creditos = Math.min(MAX_CREDITOS, j.creditos + CREDITO_POR_TICK);
      this.aplicar(j);
    }
    // Choques entre carros vivos, después de mover a todos (con coletazos)
    const vivos = [...this.jugadores.values()].filter((j) => j.vivo);
    for (let a = 0; a < vivos.length; a++) {
      for (let b = a + 1; b < vivos.length; b++) this.chocar(vivos[a], vivos[b]);
    }
    if (FASES_CON_MANEJO.includes(this.fase)) {
      for (const j of vivos) actualizarProgreso(j.progreso, j.carro, this.pista);
      const lider = this.lider();
      if (lider) this.avanceMax = Math.max(this.avanceMax, distanciaRecorrida(lider.progreso, this.pista));
      this.pasoItems(vivos);
    }

    // Modo local: la pantalla no tiene carro propio que seguir; en la espera también sigue al de adelante
    if (this.pantalla && this.fase === "espera") this.seguirLider(this.dt);

    switch (this.fase) {
      case "cuenta":
        if (--this.restante <= 0) {
          this.ticksCarrera = 0;
          this.cambiarFase("carrera", 0);
        }
        break;
      case "carrera":
        this.pasoCarrera(vivos);
        break;
      case "ronda-fin":
        if (--this.restante > 0) break;
        if (this.ganadorRonda && this.jugadores.get(this.ganadorRonda)!.puntos >= this.meta) {
          this.ganador = this.ganadorRonda;
          this.cambiarFase("resultados", 0);
        } else {
          // Todos reaparecen juntos donde iba el ganador (o el líder, si nadie ganó)
          const base = this.jugadores.get(this.ganadorRonda ?? "") ?? this.lider() ?? [...this.jugadores.values()][0];
          this.nuevaRonda(base.progreso.s, base.progreso.vueltas);
        }
        break;
    }
  }

  /** Un choque fuerte (o un coletazo) se avisa para el sonido y las chispas */
  private chocar(a: Jugador, b: Jugador): void {
    const { fuerza, descontrolados } = chocarCarros(a.carro, b.carro, PARAMETROS_FISICA, this.tickHz);
    if (fuerza < 4 && !descontrolados.length) return;
    this.eventos.push({
      tipo: "choque",
      ids: [a.id, b.id],
      x: (a.carro.x + b.carro.x) / 2,
      y: (a.carro.y + b.carro.y) / 2,
      fuerza,
      descontrolados: descontrolados.map((c) => (c === a.carro ? a.id : b.id)),
    });
  }

  private pasoCarrera(vivos: Jugador[]): void {
    this.ticksCarrera++;
    this.seguirLider(this.dt);
    const lider = this.lider();
    for (const j of vivos) {
      if (!j.vivo) continue;
      const { x, y } = j.carro;
      // Pegado al borde de la imagen: un poco más de motor para alcanzar (lo predice el navegador)
      if (j !== lider && alBorde(j.carro, alturaEn(this.pista, x, y), this.camara)) j.carro.rezago = this.ticks(REZAGO);
      const r = revisarEliminacion(j.carro, alturaEn(this.pista, x, y), j.fuera, this.camara, this.pista, this.ticksCarrera, this.tickHz);
      j.fuera = r.fuera;
      if (r.motivo) this.eliminar(j, r.motivo);
    }
    this.revisarFinDeRonda();
  }

  /* ------------------------------ A la red ------------------------------ */

  instantanea(): Instantanea {
    const compartida = this.fase !== "espera" || (!!this.pantalla && this.camara.iniciada);
    const { x, y, h, rumbo, zoom } = this.camara;
    return {
      k: this.tick,
      f: FASES.indexOf(this.fase),
      cam: compartida ? [x, y, h, rumbo, zoom] : null,
      c: [...this.jugadores.values()].map((j) => empacarCarro(j.id, j.carro, j.ultimoSeq, j.vivo, j.item)),
      // Lo que persiste no se gasta: se manda como vida completa
      e: this.entidades.map((e) => [
        e.id,
        e.item,
        e.x,
        e.y,
        e.angulo,
        Number.isFinite(e.vidaMax) ? e.vida / e.vidaMax : 1,
        e.etapa,
      ]),
      ci: this.cajas.flatMap((caja, i) => (caja.hasta > this.tick ? [i] : [])),
      cc: this.cajas.map((c) => c.categoria),
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
    };
  }

  estado(): EstadoSala {
    const jugadores = [...this.jugadores.values()]
      .sort((a, b) => a.lugar - b.lugar)
      .map(({ id, nombre, color, mente }) => (mente ? { id, nombre, color, bot: true } : { id, nombre, color }));
    return {
      codigo: this.codigo,
      circuito: this.circuito.id,
      local: !!this.pantalla,
      tickHz: this.tickHz,
      anfitrion: this.anfitrion,
      jugadores,
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
  private circuito(id?: unknown): Circuito {
    const elegible = (c: Circuito) => !c.oculto || c.id === this.porDefecto;
    return (
      this.circuitos.find((c) => c.id === id && elegible(c)) ??
      this.circuitos.find((c) => c.id === this.porDefecto) ??
      this.circuitos[0]
    );
  }

  /** Una sala nueva con código libre en el mapa `idCircuito`, o null si ya hay demasiadas */
  crear(idCircuito?: unknown): Sala | null {
    if (this.salas.size >= this.maxSalas) return null;
    let codigo: string;
    do codigo = `HMO-${randomInt(1000, 10000)}`;
    while (this.salas.has(codigo));
    const sala = new Sala(codigo, this.circuito(idCircuito), this.tickHz, this.meta, this.items);
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
      .filter((s) => !s.vacia && !s.pantalla && s.jugadores.size < MAX_JUGADORES)
      .map((s) => {
        const jugadores = [...s.jugadores.values()];
        return {
          codigo: s.codigo,
          circuito: s.circuito.id,
          anfitrion: s.jugadores.get(s.anfitrion)?.nombre ?? "",
          jugadores: jugadores.length,
          bots: jugadores.filter((j) => j.mente).length,
          fase: s.fase,
        };
      })
      .sort((a, b) => Number(a.fase !== "espera") - Number(b.fase !== "espera") || b.jugadores - a.jugadores);
  }

  borrar(codigo: string): void {
    this.salas.delete(codigo);
  }
}
