import type { Controles, EstadoCarro } from "./tipos";
import { nombreOfensivo } from "./nombres";

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
  /**
   * cliente → servidor, con respuesta: { listo } en la sala de espera o en los resultados. Todos
   * ven quién está listo; el anfitrión empieza (`empezar`) cuando lo están
   */
  listo: "sala:listo",
  /**
   * cliente → servidor, con respuesta, en la sala de espera o en los resultados: { color } cambia
   * el color propio (si está libre); solo el anfitrión: { circuito } cambia el mapa de la sala
   * (todos vuelven a la sala de espera en el mapa nuevo y a nadie le queda el "listo") y { meta }
   * las victorias para ganar la partida (una de VICTORIAS)
   */
  ajustes: "sala:ajustes",
  /** anfitrión → servidor, con respuesta: { id } saca de la sala a ese jugador (persona o bot) */
  expulsar: "sala:expulsar",
  /**
   * cliente → servidor, con respuesta: { id, motivo? } reporta a otro jugador de la sala (su
   * nombre o cómo juega). Queda en el registro del servidor para revisarlo
   */
  reportar: "sala:reportar",
  /**
   * cliente → servidor, con respuesta: la cuenta con que se conectó (el token de Firebase va en el
   * `auth` de la conexión) → { ok, cuenta: { uid, invitado, paquetes } | null }
   */
  cuenta: "cuenta:ver",
  /** cliente → servidor, con respuesta: borra lo que el servidor guarda de esa cuenta → { ok } */
  borrarCuenta: "cuenta:borrar",
  /**
   * cliente → servidor, con respuesta: { progreso } (el del modo campaña en este teléfono) → se
   * junta con el de la cuenta (lo mejor de cada copa) y regresa { ok, progreso } ya junto
   */
  progreso: "cuenta:progreso",
  /**
   * SOLO CON JUEGO_PRUEBAS=true (el laboratorio): { item } (id de items.json, o null) deja ese item
   * fijo en tu carro: lo vuelves a tener en cuanto lo usas
   */
  probarItem: "pruebas:item",
  /** SOLO CON JUEGO_PRUEBAS=true: { item, metros } pone esa trampa adelante de la salida en cada ronda (null la quita) */
  ponerTrampa: "pruebas:trampa",
  /** cliente → servidor, con respuesta: { vehiculo } lo compra con monedas (ver PRECIO_VEHICULO) */
  comprar: "cuenta:comprar",
  /**
   * servidor → cliente: la cuenta cambió (gastó un boleto, terminó una copa, compró). Trae la cuenta
   * nueva y, al terminar una copa, lo que ganó: { cuenta, copa?: ResultadoCopa }
   */
  cuentaCambio: "cuenta:cambio",
  /** servidor → al que sacaron de la sala */
  expulsado: "sala:expulsado",
  /** espectador → servidor, con respuesta: { x, y } donde cae su meteorito */
  meteorito: "partida:meteorito",
  /** cliente → servidor, con respuesta: las salas a las que uno se puede unir (SalaAbierta[]) */
  salas: "salas:lista",
  /**
   * MODO LOCAL. Una pantalla (la compu que todos ven) crea la sala, con respuesta; no tiene carro:
   * es la anfitriona (empieza, pone bots) y dibuja a todos. Los jugadores entran desde su celular
   * con `unirse` y el celular es su control
   */
  pantalla: "sala:pantalla",
  /** servidor → todos en la sala: la pantalla se fue y la sala se cerró */
  cerrada: "sala:cerrada",
  /** servidor → clientes de la sala */
  sala: "sala:estado",
  estado: "estado",
  /** Reliable final poses/resets for compact construction snapshots. */
  escenario: "obra:estado",
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

/** Las victorias (puntos) para ganar una partida que el anfitrión puede escoger */
export const VICTORIAS = [1, 3, 5, 7, 10] as const;
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
  | { tipo: "obra"; id: string; objeto: string; x: number; y: number; fuerza: number }
  | { tipo: "explosion"; id: string; x: number; y: number; motivo: "barranco" | "agua" | "atras" | "meteorito" }
  /** El escudo de alguien detuvo un golpe */
  | { tipo: "escudo"; id: string; x: number; y: number }
  /** El escorpión pasó de un carro (`de`) a otro (`a`) */
  | { tipo: "pasado"; de: string; a: string; x: number; y: number }
  /** Un espectador tiró un meteorito: aquí va a caer */
  | { tipo: "meteorito"; id: string; x: number; y: number }
  /** El meteorito cayó */
  | { tipo: "impacto"; x: number; y: number }
  /** La gente de la carne asada vio venir un carro y corre */
  | { tipo: "susto"; x: number; y: number }
  /** Un carro (`quien`) atropelló a una persona (la entidad `id`): sale volando con la velocidad del carro */
  | { tipo: "atropello"; id: number; quien: string; x: number; y: number; vx: number; vy: number }
  | { tipo: "punto"; id: string | null }
  /** Alguien sacó un item de una caja */
  | { tipo: "item"; id: string; item: number }
  /** Alguien usó su item */
  | { tipo: "usar"; id: string; item: number; x: number; y: number }
  /** Un item le pegó a alguien */
  | { tipo: "golpe"; id: string; item: number; x: number; y: number }
  /** Dos carros (`ids`) chocaron fuerte; `descontrolados`: a quién le dieron un coletazo */
  | { tipo: "choque"; ids: string[]; x: number; y: number; fuerza: number; descontrolados: string[] };

/**
 * Los colores de las cajas de items: cada caja sale de uno al azar y solo da los items de esa
 * categoría (Item.categoria). Así se sabe más o menos qué te va a tocar antes de agarrarla.
 */
export const CATEGORIAS = [
  { id: "ataque", nombre: "Ataque", color: "#E4572E" },
  { id: "trampa", nombre: "Trampas", color: "#4F8FE8" },
  { id: "escape", nombre: "Escape", color: "#5FAF8C" },
];

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

/**
 * Vehículos: solo se ven distinto, todos miden y manejan igual (la física es la misma). El primero
 * es el de todos; los demás vienen en paquetes que se compran en la app (los dibuja el navegador)
 */
export const VEHICULOS = ["clasico", "deportivo", "bocho", "troca", "grua", "calabaza", "arenero"] as const;
export type Vehiculo = (typeof VEHICULOS)[number];

/**
 * Los paquetes de vehículos que se compran. `producto` es el id del producto en App Store Connect y
 * Google Play (compras dentro de la app, no consumibles): se dan de alta con ese mismo id
 */
export const PAQUETES: readonly { id: string; vehiculos: readonly Vehiculo[]; producto: string }[] = [
  { id: "calle", vehiculos: ["deportivo", "bocho"], producto: "mx.jorgeandresgarcia.edgeracers.paquete.calle" },
  { id: "chamba", vehiculos: ["troca", "grua"], producto: "mx.jorgeandresgarcia.edgeracers.paquete.chamba" },
  { id: "halloween", vehiculos: ["calabaza"], producto: "mx.jorgeandresgarcia.edgeracers.paquete.halloween" },
];

/**
 * Los vehículos de PREMIO: se ganan con un reto de la campaña. `reto` es la clave del progreso
 * (una copa, o `<copa>-dificil`) y `lugar` el peor lugar que todavía lo gana. Uno de premio puede
 * venir también en un paquete (la grúa, en el Chamba): se usa si se compró O si se ganó
 */
export const PREMIOS: readonly { vehiculo: Vehiculo; reto: string; lugar: number }[] = [
  { vehiculo: "arenero", reto: "desierto-dificil", lugar: 1 },
  { vehiculo: "grua", reto: "construccion-dificil", lugar: 1 },
];

/** Los vehículos que se compran (los que lucen los bots, y los que se compran con monedas) */
export const VEHICULOS_DE_PAGA: readonly Vehiculo[] = PAQUETES.flatMap((p) => p.vehiculos);

/**
 * ¿Se puede usar este vehículo? El primero (el de todos) siempre; los de paga con su paquete o
 * comprados con monedas (`comprados`); los de premio con su reto ganado en la campaña
 */
export function puedeUsar(vehiculo: Vehiculo, paquetes: readonly string[], progreso: Progreso = {}, comprados: readonly string[] = []): boolean {
  return (
    vehiculo === VEHICULOS[0] ||
    PAQUETES.some((p) => p.vehiculos.includes(vehiculo) && paquetes.includes(p.id)) ||
    comprados.includes(vehiculo) ||
    PREMIOS.some((p) => p.vehiculo === vehiculo && (progreso[p.reto]?.mejorLugar ?? Infinity) <= p.lugar)
  );
}

/**
 * BOLETOS: cada copa cuesta uno, que se gasta al entrar. Se tienen hasta `max` y se recupera uno
 * cada `recargaMs` (servidor/monedero.ts)
 */
export const BOLETOS = { max: 5, recargaMs: 60 * 60 * 1000 } as const;

/**
 * MONEDAS: cada copa en Difícil, una vez al día, paga según el lugar final (desde la primera vez,
 * sin nada que desbloquear); un vehículo cuesta PRECIO_VEHICULO: lo que
 * dan 10 copas en 1º, 20 en 2º o 40 en 3º
 */
export const PREMIO_LUGAR = [400, 200, 100, 0] as const;

/** Puntos de copa por el lugar en cada pista (los mismos que muestra la tabla de la copa) */
export const PUNTOS_POR_LUGAR = [10, 7, 5, 3] as const;
export const PRECIO_VEHICULO = 4000;

/** Lo que ganó alguien al terminar una copa (viene en EVENTOS.cuentaCambio) */
export interface ResultadoCopa {
  copa: string;
  dificil: boolean;
  lugar: number;
  puntos: number;
  /** Monedas ganadas con esta copa (0 si no tocaba) */
  monedas: number;
  /** Esta copa ya había pagado hoy (Difícil) */
  yaPagoHoy: boolean;
  /** Ya no se usa (las monedas no se desbloquean): siempre false, para las apps viejas */
  desbloqueo: boolean;
}

/** El modo campaña: lo mejor de cada copa (por id de copa) */
export type Progreso = Record<string, { mejorLugar: number; mejoresPuntos: number }>;

/**
 * Lo que llega del navegador como progreso, acotado (ids cortos, lugar de 1 a 4, puntos de 0 a 100).
 * Cada copa puede venir dos veces: `desierto` (Normal) y `desierto-dificil`
 */
export function sanearProgreso(raw: unknown): Progreso {
  const limpio: Progreso = {};
  if (!raw || typeof raw !== "object") return limpio;
  for (const [copa, valor] of Object.entries(raw as Record<string, unknown>).slice(0, 24)) {
    const v = (valor ?? {}) as Record<string, unknown>;
    const lugar = Number(v.mejorLugar);
    const puntos = Number(v.mejoresPuntos);
    if (!/^[a-z-]{1,20}$/.test(copa) || !Number.isInteger(lugar) || lugar < 1 || lugar > 4) continue;
    limpio[copa] = { mejorLugar: lugar, mejoresPuntos: Number.isFinite(puntos) ? Math.max(0, Math.min(100, Math.round(puntos))) : 0 };
  }
  return limpio;
}

/** Junta dos progresos: de cada copa, el mejor lugar y los más puntos */
export function fusionarProgreso(a: Progreso, b: Progreso): Progreso {
  const junto: Progreso = { ...a };
  for (const [copa, v] of Object.entries(b)) {
    const ya = junto[copa];
    junto[copa] = ya ? { mejorLugar: Math.min(ya.mejorLugar, v.mejorLugar), mejoresPuntos: Math.max(ya.mejoresPuntos, v.mejoresPuntos) } : v;
  }
  return junto;
}

/** La cuenta con que juega alguien, como la ve el cliente */
export interface Cuenta {
  uid: string;
  /** Entró como invitado (sin Google ni Apple) */
  invitado: boolean;
  /** Ids de PAQUETES comprados */
  paquetes: string[];
  /** Vehículos comprados con monedas */
  vehiculos: string[];
  monedas: number;
  /** Siempre true (las monedas ya no se desbloquean); se queda para las apps que aún lo leen */
  monedasActivas: boolean;
  /** Los boletos ahora, y en cuánto llega el siguiente (null: está lleno) */
  boletos: { cantidad: number; max: number; siguienteEnMs: number | null };
  /** Copas (Difícil) que ya pagaron monedas hoy */
  pagadasHoy: string[];
  /** Lo mejor de la campaña, según el servidor */
  progreso: Progreso;
}

export interface ControlesRed extends Controles {
  seq: number;
  item: boolean;
}

/** seq, signed steering byte, throttle byte, brake byte, handbrake/item bits. */
export type ControlesCompactos = [number, number, number, number, number];
export const VERSION_RED = 2;

export function empacarControles(c: ControlesRed): ControlesCompactos {
  return [c.seq, Math.round(Math.max(-1, Math.min(1, c.giro)) * 127),
    Math.round(Math.max(0, Math.min(1, c.acel)) * 255), Math.round(Math.max(0, Math.min(1, c.freno)) * 255),
    (c.mano ? 1 : 0) | (c.item ? 2 : 0)];
}

export interface JugadorSala {
  id: string;
  nombre: string;
  /** id de COLORES */
  color: string;
  /** id de VEHICULOS; si no viene, el primero (el de todos) */
  vehiculo?: Vehiculo;
  /** Lo maneja el servidor */
  bot?: boolean;
  /** Ya está listo para la siguiente partida (las personas; los bots siempre lo están) */
  listo?: boolean;
}

export interface EstadoSala {
  protocolo?: number;
  /** Snapshot rate is independent from the simulation/control tick rate. */
  estadoHz?: number;
  codigo: string;
  circuito: string;
  /** Modo local: hay una pantalla (la anfitriona, sin carro) y los jugadores usan su celular */
  local: boolean;
  /** Ticks por segundo del servidor: el cliente predice con el mismo paso */
  tickHz: number;
  anfitrion: string;
  jugadores: JugadorSala[];
}

/** Una sala con lugar, para la lista del lobby */
export interface SalaAbierta {
  codigo: string;
  /** id del mapa (content/juego/circuitos) */
  circuito: string;
  /** Nombre de quien la creó */
  anfitrion: string;
  /** Personas y bots dentro */
  jugadores: number;
  bots: number;
  fase: Fase;
}

export type Respuesta =
  | { ok: true; id: string; sala: EstadoSala; partida: EstadoPartida; obra?: import("./red").EstadoEscenarioRed }
  | { ok: false; error: string };

export interface DatosJugador {
  nombre: string;
  color: string;
  vehiculo?: Vehiculo;
}

/**
 * Un carro en la instantánea, como arreglo para que pese poco:
 * [id, x, y, angulo, vx, vy, w, derrape, suelo (0 asfalto, 1 tierra), indice, ultimoSeq, vivo (0/1),
 *  aturdido, resbalon, lento, turbo, item (índice en items.json o -1), trompo, rezago, z, vz, rampa]
 */
export type CarroRed = [
  string, number, number, number, number, number, number, number, number, number, number, number,
  number, number, number, number, number, number, number, number, number, number,
  // Los efectos de las copas: enredado, ponchado, escudo, pesado, viento, vientoX, vientoY, cemento
  number, number, number, number, number, number, number, number,
  // El empujón de un choque (segundos) y la recuperación después de él (segundos)
  number, number,
];

/**
 * Algo suelto en la pista (un burro, un bache, coyotas…):
 * [id, item (índice en items.json), x, y, angulo, vida (0 … 1), etapa (el bache: 0 recién
 *  tirado, 1 con señalización, 2 tapado con tablas)]
 */
export type EntidadRed = [number, number, number, number, number, number, number];

export interface Instantanea {
  /** In protocol 2, `o` only contains bodies that are still moving. */
  od?: true;
  /** Moved construction props; omitted outside construction tracks. */
  o?: import("./escenario").ObjetoRed[];
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
  /** De qué color es cada caja (índice en CATEGORIAS), en el orden de cajasDelCircuito() */
  cc: number[];
}

/**
 * Redondeo para mandar por la red: milímetros y diezmilésimas de radián. Un número así ocupa
 * ~8 caracteres en el JSON en vez de ~18, y la instantánea cabe en un solo paquete. El error
 * (medio milímetro) queda muy por debajo de lo que la predicción del navegador corrige.
 */
export const red3 = (n: number): number => Math.round(n * 1000) / 1000;
export const red4 = (n: number): number => Math.round(n * 10000) / 10000;

export function empacarCarro(id: string, c: EstadoCarro, seq: number, vivo: boolean, item: number): CarroRed {
  return [
    id, red3(c.x), red3(c.y), red4(c.angulo), red3(c.vx), red3(c.vy), red4(c.w), red3(c.derrape),
    c.suelo === "tierra" ? 1 : 0, c.indice, seq, vivo ? 1 : 0,
    c.aturdido, c.resbalon, c.lento, c.turbo, item, c.trompo, c.rezago, red3(c.z), red3(c.vz), c.rampa,
    c.enredado, c.ponchado, c.escudo, c.pesado, c.viento, red3(c.vientoX), red3(c.vientoY), c.cemento,
    red3(c.empujon), red3(c.recobro ?? 0),
  ];
}

export function desempacarCarro(r: CarroRed): { id: string; estado: EstadoCarro; seq: number; vivo: boolean; item: number } {
  return {
    id: r[0],
    estado: {
      x: r[1], y: r[2], angulo: r[3], vx: r[4], vy: r[5], w: r[6], derrape: r[7],
      suelo: r[8] ? "tierra" : "asfalto", indice: r[9],
      aturdido: r[12], resbalon: r[13], lento: r[14], turbo: r[15], trompo: r[17] ?? 0, rezago: r[18] ?? 0,
      z: r[19] ?? 0, vz: r[20] ?? 0, rampa: r[21] ?? -1,
      enredado: r[22] ?? 0, ponchado: r[23] ?? 0, escudo: r[24] ?? 0, pesado: r[25] ?? 0,
      viento: r[26] ?? 0, vientoX: r[27] ?? 0, vientoY: r[28] ?? 0, cemento: r[29] ?? 0,
      empujon: r[30] ?? 0,
      recobro: r[31] ?? 0,
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
  if (Array.isArray(raw)) {
    if (raw.length !== 5 || !raw.every(Number.isSafeInteger)) return null;
    const [seq, giro, acel, freno, bits] = raw as ControlesCompactos;
    if (seq < 0 || giro < -127 || giro > 127 || acel < 0 || acel > 255 || freno < 0 || freno > 255 || bits < 0 || bits > 3) return null;
    return { seq, giro: giro / 127, acel: acel / 255, freno: freno / 255, mano: !!(bits & 1), item: !!(bits & 2) };
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.seq !== "number" || !Number.isSafeInteger(r.seq) || r.seq < 0) return null;
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

/** Nombre, color y vehículo válidos, o el error a mostrar */
export function sanearJugador(raw: unknown): DatosJugador | { error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const nombre = typeof r.nombre === "string" ? r.nombre.trim().replace(/\s+/g, " ").slice(0, LARGO_NOMBRE) : "";
  if (!nombre) return { error: "Escribe tu nombre" };
  if (nombreOfensivo(nombre)) return { error: "Ese nombre no está permitido: elige otro" };
  const color = COLORES.some((c) => c.id === r.color) ? (r.color as string) : COLORES[0].id;
  const vehiculo = VEHICULOS.includes(r.vehiculo as Vehiculo) ? (r.vehiculo as Vehiculo) : VEHICULOS[0];
  return { nombre, color, vehiculo };
}
