import { randomInt } from "crypto";
import type { Circuito, EstadoCarro } from "../compartido/tipos";
import { prepararPista, type Pista } from "../compartido/pista";
import { PARAMETROS_FISICA, avanzarCarro, colisionCarros, crearCarro } from "../compartido/fisica";
import {
  COLORES,
  MAX_JUGADORES,
  empacarCarro,
  type ControlesRed,
  type DatosJugador,
  type EstadoSala,
  type Instantanea,
} from "../compartido/protocolo";

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
}

export class Sala {
  readonly jugadores = new Map<string, Jugador>();
  readonly pista: Pista;
  tick = 0;

  constructor(
    readonly codigo: string,
    readonly circuito: Circuito,
    readonly tickHz: number,
  ) {
    this.pista = prepararPista(circuito);
  }

  get vacia(): boolean {
    return this.jugadores.size === 0;
  }

  /** Agrega un jugador; si su color ya está tomado le toca el primero libre. Devuelve un error o null */
  agregar(id: string, datos: DatosJugador): string | null {
    if (this.jugadores.size >= MAX_JUGADORES) return `La sala ya tiene ${MAX_JUGADORES} jugadores`;
    const usados = new Set([...this.jugadores.values()].map((j) => j.color));
    const color = usados.has(datos.color) ? COLORES.find((c) => !usados.has(c.id))!.id : datos.color;
    const lugares = new Set([...this.jugadores.values()].map((j) => j.lugar));
    const lugar = [0, 1, 2, 3].find((l) => !lugares.has(l))!;
    this.jugadores.set(id, {
      id,
      nombre: datos.nombre,
      color,
      lugar,
      carro: this.carroEnParrilla(lugar),
      cola: [],
      creditos: 2,
      ultimoSeq: -1,
    });
    return null;
  }

  quitar(id: string): void {
    this.jugadores.delete(id);
  }

  /** Parrilla de dos en dos detrás de la meta */
  private carroEnParrilla(lugar: number): EstadoCarro {
    const fila = Math.floor(lugar / 2);
    const lado = lugar % 2 ? 1 : -1;
    return crearCarro(this.pista, -8 - fila * 8, lado * this.pista.mitad * 0.45);
  }

  recibirControles(id: string, ctrl: ControlesRed): void {
    const j = this.jugadores.get(id);
    if (!j || ctrl.seq <= j.ultimoSeq || ctrl.seq <= (j.cola.at(-1)?.seq ?? -1)) return;
    j.cola.push(ctrl);
    if (j.cola.length > MAX_COLA) j.cola.splice(0, j.cola.length - MAX_COLA);
    this.aplicar(j);
  }

  /** Aplica los controles en espera mientras haya crédito, cada uno con el paso fijo */
  private aplicar(j: Jugador): void {
    while (j.creditos >= 1 && j.cola.length) {
      const ctrl = j.cola.shift()!;
      avanzarCarro(j.carro, ctrl, PARAMETROS_FISICA, this.pista, 1 / this.tickHz);
      j.ultimoSeq = ctrl.seq;
      j.creditos -= 1;
    }
  }

  /**
   * Un tick del mundo: recarga créditos (y aplica lo que esperaba por ellos) y resuelve choques.
   * Un jugador que no manda controles (pestaña en segundo plano, conexión atorada) no se
   * simula: su tiempo solo avanza con sus propios controles.
   */
  paso(): void {
    this.tick++;
    for (const j of this.jugadores.values()) {
      j.creditos = Math.min(MAX_CREDITOS, j.creditos + CREDITO_POR_TICK);
      this.aplicar(j);
    }
    // Choques entre carros, después de mover a todos
    const lista = [...this.jugadores.values()];
    for (let a = 0; a < lista.length; a++) {
      for (let b = a + 1; b < lista.length; b++) colisionCarros(lista[a].carro, lista[b].carro, PARAMETROS_FISICA);
    }
  }

  instantanea(): Instantanea {
    return { k: this.tick, c: [...this.jugadores.values()].map((j) => empacarCarro(j.id, j.carro, j.ultimoSeq)) };
  }

  estado(): EstadoSala {
    const jugadores = [...this.jugadores.values()]
      .sort((a, b) => a.lugar - b.lugar)
      .map(({ id, nombre, color }) => ({ id, nombre, color }));
    return {
      codigo: this.codigo,
      circuito: this.circuito.id,
      tickHz: this.tickHz,
      anfitrion: jugadores[0]?.id ?? "",
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
    const sala = new Sala(codigo, this.circuito, this.tickHz);
    this.salas.set(codigo, sala);
    return sala;
  }

  buscar(codigo: string): Sala | undefined {
    return this.salas.get(codigo);
  }

  borrar(codigo: string): void {
    this.salas.delete(codigo);
  }
}
