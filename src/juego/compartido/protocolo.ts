import type { Controles, EstadoCarro } from "./tipos";

/**
 * Protocolo de red entre el navegador y el servidor (Socket.IO, namespace /juego).
 *
 * Sincronización con servidor autoritativo:
 *   - El cliente SOLO manda sus controles, numerados (`seq`), uno por tick.
 *   - El servidor aplica cada control en cuanto llega (con un límite de un control por tick en
 *     promedio) y en cada tick manda una "instantánea" con el estado de cada carro y el último
 *     `seq` que aplicó de cada quien. Ese `seq` es también el reloj propio de cada carro.
 *   - Con ese `seq` el cliente sabe qué controles suyos ya están incluidos en el estado del
 *     servidor y vuelve a simular los que faltan (predicción + reconciliación).
 * Nadie puede hacer trampa desde el navegador: posiciones y velocidades solo las escribe el servidor.
 */

export const EVENTOS = {
  /** cliente → servidor, con respuesta (ack) */
  crear: "sala:crear",
  unirse: "sala:unirse",
  /** cliente → servidor */
  salir: "sala:salir",
  controles: "controles",
  /** cliente → servidor con ack vacío: mide el ping */
  ping: "ping:juego",
  /** anfitrión → servidor, con respuesta: empieza la partida (o la repite desde resultados) */
  empezar: "partida:empezar",
  /** anfitrión → servidor, con respuesta: { cantidad } de bots en la sala (0 los quita) */
  bots: "sala:bots",
  /** servidor → clientes de la sala */
  sala: "sala:estado",
  estado: "estado",
  /** Fase, ronda y puntos; solo cuando cambian */
  partida: "partida",
  /** Cosas que pasan una vez: explosiones, puntos, items… (efectos y sonido) */
  evento: "evento",
} as const;

/**
 * Fases de una partida:
 *   espera     manejo libre mientras se junta la gente (cada quien con su cámara)
 *   cuenta     3, 2, 1 en la parrilla, carros congelados
 *   carrera    cámara compartida que sigue al líder; el que se queda fuera de la imagen explota
 *   ronda-fin  pausa corta con el punto para el último carro en pie
 *   resultados alguien llegó a la meta de puntos
 */
export const FASES = ["espera", "cuenta", "carrera", "ronda-fin", "resultados"] as const;
export type Fase = (typeof FASES)[number];

/** En estas fases los carros se mueven (y el navegador predice el propio) */
export const FASES_CON_MANEJO: readonly Fase[] = ["espera", "carrera"];

export interface EstadoPartida {
  fase: Fase;
  ronda: number;
  /** Lo que falta de la fase, en ms (cuenta y ronda-fin) */
  restanteMs: number;
  meta: number;
  puntos: { id: string; puntos: number }[];
  ganadorRonda: string | null;
  ganador: string | null;
}

export type Evento =
  | { tipo: "explosion"; id: string; x: number; y: number; motivo: "barranco" | "atras" }
  | { tipo: "punto"; id: string | null }
  /** Alguien sacó un item de una caja */
  | { tipo: "item"; id: string; item: number }
  /** Alguien usó su item */
  | { tipo: "usar"; id: string; item: number; x: number; y: number }
  /** Un item le pegó a alguien */
  | { tipo: "golpe"; id: string; item: number; x: number; y: number };

export const MAX_JUGADORES = 4;
export const LARGO_NOMBRE = 16;

/** Colores que se pueden elegir (id → color del carro) */
export const COLORES = [
  { id: "rojo", nombre: "Rojo", color: "#E4572E" },
  { id: "azul", nombre: "Azul", color: "#4F8FE8" },
  { id: "amarillo", nombre: "Amarillo", color: "#F6C445" },
  { id: "verde", nombre: "Verde", color: "#7FB7A4" },
  { id: "morado", nombre: "Morado", color: "#9C6ADE" },
  { id: "rosa", nombre: "Rosa", color: "#F07FB0" },
];

export interface ControlesRed extends Controles {
  seq: number;
  item: boolean;
}

export interface JugadorSala {
  id: string;
  nombre: string;
  /** id de COLORES */
  color: string;
  /** Lo maneja el servidor */
  bot?: boolean;
}

export interface EstadoSala {
  codigo: string;
  circuito: string;
  /** Ticks por segundo del servidor: el cliente predice con el mismo paso */
  tickHz: number;
  anfitrion: string;
  jugadores: JugadorSala[];
}

export type Respuesta =
  | { ok: true; id: string; sala: EstadoSala; partida: EstadoPartida }
  | { ok: false; error: string };

export interface DatosJugador {
  nombre: string;
  color: string;
}

/**
 * Un carro en la instantánea, como arreglo para que pese poco:
 * [id, x, y, angulo, vx, vy, w, derrape, suelo (0 asfalto, 1 tierra), indice, ultimoSeq, vivo (0/1),
 *  aturdido, resbalon, lento, turbo, item (índice en items.json o -1)]
 */
export type CarroRed = [
  string, number, number, number, number, number, number, number, number, number, number, number,
  number, number, number, number, number,
];

/**
 * Algo suelto en la pista (un burro, un bache, coyotas…):
 * [id, item (índice en items.json), x, y, angulo, vida (0 … 1)]
 */
export type EntidadRed = [number, number, number, number, number, number];

export interface Instantanea {
  /** Número de tick del servidor */
  k: number;
  /** Fase (índice en FASES) */
  f: number;
  /** Cámara compartida [x, y, h, rumbo, zoom], o null en la sala de espera (cada quien la suya) */
  cam: [number, number, number, number, number] | null;
  c: CarroRed[];
  e: EntidadRed[];
  /** Cajas de items apagadas (índices en circuito.cajas) */
  ci: number[];
}

export function empacarCarro(id: string, c: EstadoCarro, seq: number, vivo: boolean, item: number): CarroRed {
  return [
    id, c.x, c.y, c.angulo, c.vx, c.vy, c.w, c.derrape, c.suelo === "tierra" ? 1 : 0, c.indice, seq, vivo ? 1 : 0,
    c.aturdido, c.resbalon, c.lento, c.turbo, item,
  ];
}

export function desempacarCarro(r: CarroRed): { id: string; estado: EstadoCarro; seq: number; vivo: boolean; item: number } {
  return {
    id: r[0],
    estado: {
      x: r[1], y: r[2], angulo: r[3], vx: r[4], vy: r[5], w: r[6], derrape: r[7],
      suelo: r[8] ? "tierra" : "asfalto", indice: r[9],
      aturdido: r[12], resbalon: r[13], lento: r[14], turbo: r[15],
    },
    seq: r[10],
    vivo: r[11] === 1,
    item: r[16],
  };
}

/** "hmo 4821", "HMO-4821" o "4821" → "HMO-4821" (o null si no parece un código) */
export function normalizarCodigo(texto: unknown): string | null {
  if (typeof texto !== "string") return null;
  const digitos = texto.replace(/\D/g, "");
  return digitos.length === 4 ? `HMO-${digitos}` : null;
}

/**
 * Lo que llega del navegador no es de fiar: se acota cada control a su rango.
 * Así un cliente modificado no puede, por ejemplo, acelerar al 500%.
 */
export function sanearControles(raw: unknown): ControlesRed | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) return null;
  const numero = (v: unknown, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : 0;
  return {
    seq: r.seq,
    giro: numero(r.giro, -1, 1),
    acel: numero(r.acel, 0, 1),
    freno: numero(r.freno, 0, 1),
    mano: r.mano === true,
    item: r.item === true,
  };
}

/** Nombre y color válidos, o el error a mostrar */
export function sanearJugador(raw: unknown): DatosJugador | { error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const nombre = typeof r.nombre === "string" ? r.nombre.trim().replace(/\s+/g, " ").slice(0, LARGO_NOMBRE) : "";
  if (!nombre) return { error: "Escribe tu nombre" };
  const color = COLORES.some((c) => c.id === r.color) ? (r.color as string) : COLORES[0].id;
  return { nombre, color };
}
