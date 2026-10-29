import { randomInt } from "crypto";
import type { Circuito, EstadoCarro, Item } from "../compartido/tipos";
import { alturaEn, prepararPista, proyectar, type Pista } from "../compartido/pista";
import { PARAMETROS_FISICA, avanzarCarro, chocarCarros, crearCarro } from "../compartido/fisica";
import { PARAMETROS_CAMARA_PARTIDA, ajustarZoom, crearCamara, seguir, type Camara } from "../compartido/camara";
import {
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
  actualizarProgreso,
  distanciaRecorrida,
  revisarEliminacion,
  type MotivoEliminacion,
  type Progreso,
} from "./reglas";
import { MECANICAS, sacarItem, type Conductor, type Efecto, type Entidad, type MundoItems } from "./items";
import { NOMBRES_BOT, crearMente, pensar, type MenteBot } from "./bots";

/**
 * Las cajas de items se recogen a esta distancia y tardan esto en volver a salir. Las filas son de
 * 3 cajas separadas 4.2 m: con este radio cubren todo el ancho del camino, sin huecos.
 */
const RADIO_CAJA = 3.4;
const CAJA_APAGADA = 8;

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
}

export class Sala implements MundoItems {
  readonly jugadores = new Map<string, Jugador>();
  readonly pista: Pista;
  tick = 0;

  /** Lo que anda suelto en la pista (burros, baches, coyotas…) */
  entidades: Entidad[] = [];
  private siguienteEntidad = 1;
  /** Hasta qué tick está apagada cada caja de items */
  private cajas: number[];
  /** Quién explotó en esta ronda, en orden */
  private caidos: string[] = [];
  /** Orden de la parrilla para la siguiente ronda (el primero sale hasta adelante) */
  private ordenSalida: string[] = [];

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
    private readonly azar: () => number = Math.random,
  ) {
    this.pista = prepararPista(circuito);
    this.cajas = circuito.cajas.map(() => 0);
  }

  /** Sin personas (los bots solos no mantienen viva una sala) */
  get vacia(): boolean {
    return ![...this.jugadores.values()].some((j) => !j.mente);
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

  /** Quien manda en la sala: la primera persona (nunca un bot) */
  get anfitrion(): string {
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

  soltar(e: Omit<Entidad, "id" | "edad" | "tocados" | "vidaMax">): void {
    this.entidades.push({ ...e, id: this.siguienteEntidad++, edad: 0, tocados: new Set(), vidaMax: e.vida });
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
    if (!silencioso) this.eventos.push({ tipo: "golpe", id: victima.id, item, x: c.x, y: c.y });
  }

  /** Recoger cajas, mover lo suelto y empujar con el turbo */
  private pasoItems(vivos: Jugador[]): void {
    if (!this.items.length) return;
    this.circuito.cajas.forEach(([x, y], i) => {
      if (this.cajas[i] > this.tick) return;
      const quien = vivos.find((j) => j.item < 0 && Math.hypot(j.carro.x - x, j.carro.y - y) < RADIO_CAJA);
      if (!quien) return;
      quien.item = sacarItem(this.items, this.azar);
      this.cajas[i] = this.tick + Math.round(CAJA_APAGADA * this.tickHz);
      this.eventos.push({ tipo: "item", id: quien.id, item: quien.item });
    });

    this.entidades = this.entidades.filter((e) => {
      const item = this.items[e.item];
      const actualizar = MECANICAS[item.mecanica].actualizar;
      const { limites } = this.circuito;
      const dentro = e.x > limites.x && e.y > limites.y && e.x < limites.x + limites.ancho && e.y < limites.y + limites.alto;
      return dentro && (actualizar ? actualizar(this, e, item) : false);
    });

    for (const j of vivos) {
      if (j.carro.turbo <= 0 || j.turboItem < 0) continue;
      const item = this.items[j.turboItem];
      MECANICAS[item.mecanica].mientras?.(this, j, j.turboItem, item, this.tick);
    }
  }

  /** Ronda nueva o sala de espera: pista limpia, cajas encendidas y nadie trae item */
  private limpiarItems(): void {
    this.entidades = [];
    this.cajas = this.circuito.cajas.map(() => 0);
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
    this.nuevaRonda(0, 0);
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
    this.limpiarItems();
    // Nadie arranca con item: las cajas que quedaron sobre la parrilla se apagan hasta un rato después del arranque
    const hasta = this.tick + this.ticks(DURACION.cuenta + 4);
    this.circuito.cajas.forEach(([x, y], i) => {
      const cerca = [...this.jugadores.values()].some((j) => Math.hypot(j.carro.x - x, j.carro.y - y) < CAJAS_LEJOS_DE_PARRILLA);
      if (cerca) this.cajas[i] = hasta;
    });
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
    this.limpiarItems();
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
      this.pasoItems(vivos);
    }

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
    for (const j of vivos) {
      if (!j.vivo) continue;
      const { x, y } = j.carro;
      const r = revisarEliminacion(j.carro, alturaEn(this.pista, x, y), j.fuera, this.camara, this.pista, this.ticksCarrera, this.tickHz);
      j.fuera = r.fuera;
      if (r.motivo) this.eliminar(j, r.motivo);
    }
    this.revisarFinDeRonda();
  }

  /* ------------------------------ A la red ------------------------------ */

  instantanea(): Instantanea {
    const compartida = this.fase !== "espera";
    const { x, y, h, rumbo, zoom } = this.camara;
    return {
      k: this.tick,
      f: FASES.indexOf(this.fase),
      cam: compartida ? [x, y, h, rumbo, zoom] : null,
      c: [...this.jugadores.values()].map((j) => empacarCarro(j.id, j.carro, j.ultimoSeq, j.vivo, j.item)),
      e: this.entidades.map((e) => [e.id, e.item, e.x, e.y, e.angulo, e.vida / e.vidaMax]),
      ci: this.cajas.flatMap((hasta, i) => (hasta > this.tick ? [i] : [])),
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
      tickHz: this.tickHz,
      anfitrion: this.anfitrion,
      jugadores,
    };
  }
}

export class GestorSalas {
  private readonly salas = new Map<string, Sala>();

  constructor(
    private readonly circuito: Circuito,
    private readonly maxSalas: number,
    private readonly tickHz: number,
    private readonly meta = 5,
    private readonly items: Item[] = [],
  ) {}

  get total(): number {
    return this.salas.size;
  }

  /** Una sala nueva con código libre, o null si ya hay demasiadas */
  crear(): Sala | null {
    if (this.salas.size >= this.maxSalas) return null;
    let codigo: string;
    do codigo = `HMO-${randomInt(1000, 10000)}`;
    while (this.salas.has(codigo));
    const sala = new Sala(codigo, this.circuito, this.tickHz, this.meta, this.items);
    this.salas.set(codigo, sala);
    return sala;
  }

  buscar(codigo: string): Sala | undefined {
    return this.salas.get(codigo);
  }

  /** Las salas con lugar: primero las que esperan gente, luego las más llenas */
  abiertas(): SalaAbierta[] {
    return [...this.salas.values()]
      .filter((s) => !s.vacia && s.jugadores.size < MAX_JUGADORES)
      .map((s) => {
        const jugadores = [...s.jugadores.values()];
        return {
          codigo: s.codigo,
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
