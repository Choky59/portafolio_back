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
  /** cliente → servidor (con respuesta opcional { ok }): se va de la sala de verdad ("Salir al menú": no se le guarda el lugar) */
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
   * (todos vuelven a la sala de espera en el mapa nuevo y a nadie le queda el "listo"). { meta }
   * ya no se cambia: siempre es PUNTOS_MAXIMOS (se acepta solo ese valor, por clientes viejos)
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
  /**
   * cliente → servidor, con respuesta: { vehiculo } (PRECIO_VEHICULO), { sticker } (PRECIO_STICKER)
   * o { boletos: true } (llenar los boletos, precioRecarga) lo compra con monedas → { ok, cuenta }
   */
  comprar: "cuenta:comprar",
  /**
   * cliente → servidor, con respuesta: una compra con dinero ya pagada en la tienda, para que el
   * servidor la verifique con Apple o Google y la acredite (una sola vez):
   * { plataforma: 'ios', jws } o { plataforma: 'android', producto, token } → { ok, cuenta, producto }.
   * Solo con cuenta de Google o Apple (no invitados). `ok` también si ya se había acreditado antes:
   * así la app puede cerrar la transacción
   */
  validarCompra: "cuenta:validarCompra",
  /**
   * cliente → servidor, con respuesta: { stickers } los de la barra del festejo (hasta
   * MAX_STICKERS_BARRA, de los tuyos y en ese orden) → { ok, cuenta }
   */
  barraStickers: "cuenta:stickers",
  /**
   * servidor → cliente: la cuenta cambió (gastó un boleto, terminó una copa, compró). Trae la cuenta
   * nueva y, al terminar una copa, lo que ganó: { cuenta, copa?: ResultadoCopa }
   */
  cuentaCambio: "cuenta:cambio",
  /**
   * LA COPA EN LOCAL (se juega en el navegador; el boleto y el premio, en el servidor).
   * cliente → servidor, con respuesta: { copa, dificil } revisa que esté abierta, gasta un boleto y
   * abre una sesión → { ok, sesion, cuenta }. Necesita internet y cuenta
   */
  copaIniciar: "copa:iniciar",
  /**
   * cliente → servidor, con respuesta: { sesion, lugares: string[][] (ids de cada pista, del 1º al
   * último), yo, vehiculo } cobra la copa una sola vez → { ok, cuenta, copa: ResultadoCopa }, o
   * { ok: false, error, definitivo } (definitivo: no tiene caso reintentar). También avisa con cuentaCambio
   */
  copaResultado: "copa:resultado",
  /**
   * PARTIDA LOCAL (multijugador con una sola persona; los demás son bots): al acabar la
   * preparación, servidor → esa persona: { sesion, codigo, circuito, meta, jugadores, miId }. La
   * carrera corre en su navegador (el servidor solo transmite cuando hay 2 personas o más); la
   * conexión sigue abierta (sin internet, fuera de la partida)
   */
  local: "partida:local",
  /**
   * cliente → servidor, con respuesta: { sesion, lugar } terminó la partida local: se paga su
   * lugar (PREMIO_MULTI, una vez) y la sala vuelve a la sala de espera → { ok, resultado }
   */
  multiResultado: "multi:resultado",
  /**
   * cliente → servidor: la partida local (contra bots) terminó una ronda: { sesion, ronda, puntos }
   * (el marcador, por id). Si se corta la conexión, el servidor sigue la partida desde ahí
   */
  checkpoint: "multi:checkpoint",
  /**
   * cliente → servidor: volver a la partida de la que se cortó la conexión (la misma cuenta, dentro
   * de los 90 s) → { ok, id, sala, partida } como al entrar; su carro, su lugar y sus puntos
   */
  volver: "sala:volver",
  /**
   * cliente → servidor, con respuesta: { ...DatosJugador, codigo } ver la partida de un amigo como
   * espectador (no saca a nadie). Al volver la sala a la espera entra en lugar de un bot, si hay;
   * si no, sigue de espectador → { ok, id, sala, partida, espectador: true, esperandoRelevo }
   */
  ver: "sala:ver",
  /**
   * servidor → la persona de una partida local: llegó un espectador y el servidor toma la partida
   * desde la ronda que sigue (sin reiniciar nada) → { id, sala, partida } como al entrar
   */
  relevo: "partida:relevo",
  /** servidor → al que sacaron de la sala */
  expulsado: "sala:expulsado",
  /** espectador → servidor, con respuesta: { x, y } donde cae su meteorito */
  meteorito: "partida:meteorito",
  /**
   * el ganador de la ronda → servidor, con respuesta, en el festejo (ronda-fin): { sticker } (uno de
   * STICKERS) sale encima de su carro para todos (evento "sticker")
   */
  sticker: "partida:sticker",
  /** cliente → servidor, con respuesta: las salas a las que uno se puede unir (SalaAbierta[]) */
  salas: "salas:lista",
  /**
   * MULTIJUGADOR (con boleto y premio). cliente → servidor, con respuesta: { ...DatosJugador,
   * circuito?: id o null (aleatoria) } entra a una sala pública que espera gente (con esa pista, si
   * la pidió) o, si no hay, crea una con un bot. Como `crear` y `unirse` con { multi: true }: hace
   * falta cuenta y al menos un boleto (se gasta al empezar cada partida: PREMIO_MULTI)
   */
  rapida: "salas:rapida",
  /*
   * LOS AMIGOS (con cuenta). A cada persona se le conoce por su código de amigo (6 números).
   * Todos con respuesta { ok, error? }
   */
  /** { nombre? } (el tuyo, para tus amigos) → { ok, lista: ListaAmigos } */
  amigos: "amigos:lista",
  /** { codigo } manda una solicitud de amistad (si esa persona ya te mandó una, quedan amigos) */
  amigoSolicitar: "amigos:solicitar",
  /** { codigo } acepta la solicitud que te mandó */
  amigoAceptar: "amigos:aceptar",
  /** { codigo } rechaza su solicitud, cancela la tuya o deja de ser tu amigo */
  amigoQuitar: "amigos:quitar",
  /** { codigos: string[] } invita a esos amigos a la sala multijugador en que estás */
  amigoInvitar: "amigos:invitar",
  /**
   * { id } en una sala multijugador: le manda solicitud de amistad a ese jugador (por su cuenta).
   * A un bot no le llega nada (nunca contesta) → { ok, amigos? }
   */
  amigoSolicitarJugador: "amigos:solicitar-jugador",
  /** { activo } "Avísame cuando mis amigos jueguen": una notificación cuando un amigo entra a una sala */
  amigosAvisar: "amigos:avisar",
  /**
   * servidor → todas las conexiones de una cuenta: algo cambió en sus amigos (AvisoAmigos): una
   * solicitud nueva, una aceptada o una invitación a una sala
   */
  amigosAviso: "amigos:aviso",
  /**
   * LAS NOTIFICACIONES (con cuenta, con respuesta { ok }). { token, plataforma, idioma } guarda el
   * teléfono que recibe las push (la invitación de un amigo); { token } lo quita (al salir de la cuenta)
   */
  pushToken: "push:token",
  pushQuitar: "push:quitar",
  /** Con respuesta { ok, telefonos, enviados, errores }: una notificación de prueba a tus propios teléfonos */
  pushPrueba: "push:prueba",
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
 *   ronda-fin  pausa corta: los puntos de la ronda por lugar (PUNTOS_RONDA) y el festejo del 1º
 *   resultados alguien llegó a PUNTOS_MAXIMOS
 */
export const FASES = ["espera", "cuenta", "carrera", "ronda-fin", "resultados"] as const;

/**
 * LOS PUNTOS DE UNA PARTIDA: todos empiezan con PUNTOS_INICIALES y gana quien llega a
 * PUNTOS_MAXIMOS (la meta). Nunca bajan de PUNTOS_MINIMOS: con 0 se sigue jugando
 */
export const PUNTOS_INICIALES = 4;
export const PUNTOS_MAXIMOS = 8;
export const PUNTOS_MINIMOS = 0;
/**
 * Lo que da cada lugar de una ronda (del 1º al último), según cuántos la corrieron. El 1º es el
 * que queda en pie; luego, el último en caer, y así
 */
export const PUNTOS_RONDA: Readonly<Record<number, readonly number[]>> = {
  1: [1],
  2: [1, -1],
  3: [1, 0, -1],
  4: [2, 1, -1, -2],
};

/** Lo que gana o pierde cada quien en una ronda (`orden`: ids, del 1º al último) */
export function puntosDeRonda(orden: readonly string[]): Record<string, number> {
  const tabla = PUNTOS_RONDA[Math.min(orden.length, MAX_JUGADORES)] ?? [];
  return Object.fromEntries(orden.map((id, i) => [id, tabla[i] ?? tabla.at(-1) ?? 0]));
}

/** Lo menos que dura una partida con `jugadores`, en rondas: ganándolas todas de PUNTOS_INICIALES a PUNTOS_MAXIMOS */
export function rondasMinimas(jugadores: number): number {
  const mejor = Math.max(1, ...(PUNTOS_RONDA[Math.max(1, Math.min(jugadores, MAX_JUGADORES))] ?? [1]));
  return Math.ceil((PUNTOS_MAXIMOS - PUNTOS_INICIALES) / mejor);
}

/** Los puntos de partida acotados a [PUNTOS_MINIMOS, PUNTOS_MAXIMOS] */
export const acotarPuntos = (p: number): number => Math.max(PUNTOS_MINIMOS, Math.min(PUNTOS_MAXIMOS, p));

/**
 * Los lugares por puntos, de más a menos; empatados, el mismo lugar (1, 1, 3, 4) y en la lista,
 * en el orden de `ids`
 */
export function lugaresConEmpate(ids: readonly string[], puntos: Readonly<Record<string, number>>): { id: string; lugar: number }[] {
  const orden = ids.map((id, i) => ({ id, i, p: puntos[id] ?? 0 })).sort((a, b) => b.p - a.p || a.i - b.i);
  return orden.map((j) => ({ id: j.id, lugar: orden.findIndex((o) => o.p === j.p) + 1 }));
}
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
  /** Solo en la sala del tutorial: la lección que se está jugando (1, 2 o 3) */
  leccion?: number;
  /**
   * Multijugador: la preparación (vehículo y stickers, 2 × PREPARACION_MS) va corriendo en la sala
   * de espera; lo que falta en ms. Al terminar empieza la partida
   */
  preparacionMs?: number;
}

export type Evento =
  | { tipo: "obra"; id: string; objeto: string; x: number; y: number; fuerza: number }
  /** `z`: altura sobre el camino donde explotó (solo viene si no es 0: el fondo de un hueco) */
  | { tipo: "explosion"; id: string; x: number; y: number; z?: number; motivo: "barranco" | "agua" | "atras" | "meteorito" | "aplastado" }
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
  /** Terminó una ronda: `id` el 1º (festeja), `cambios` lo que ganó o perdió cada quien */
  | { tipo: "punto"; id: string | null; cambios?: Record<string, number> }
  /** El ganador de la ronda puso un sticker (uno de STICKERS) encima de su carro */
  | { tipo: "sticker"; id: string; sticker: string }
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

/** Los stickers que puede poner el ganador de una ronda en su festejo */
export const STICKERS = [
  "aprobacion",
  "celebracion",
  "risa",
  "presumido",
  "sorpresa",
  "confusion",
  "enojo",
  "tristeza",
  "nervios",
  "amor",
  "llanto",
  "victoria",
] as const;
/** Los que tiene todos desde el principio; los demás se compran a PRECIO_STICKER monedas */
export const STICKERS_GRATIS = ["aprobacion", "celebracion"] as const;
export const PRECIO_STICKER = 400;
/** Cuántos lleva cada quien en la barra del festejo (los demás los tiene, pero no salen en la partida) */
export const MAX_STICKERS_BARRA = 4;

/** Los stickers de una cuenta: los gratis y los comprados que existen, en el orden de STICKERS */
export function stickersPropios(comprados: readonly unknown[] = []): string[] {
  return STICKERS.filter((s) => (STICKERS_GRATIS as readonly string[]).includes(s) || comprados.includes(s));
}

/**
 * La barra del festejo, saneada: solo de los propios, sin repetir y hasta MAX_STICKERS_BARRA, en el
 * orden pedido. Vacía (o sin nada válido), los gratis
 */
export function barraDeStickers(pedida: unknown, propios: readonly string[]): string[] {
  const lista = Array.isArray(pedida) ? pedida : [];
  const barra = [...new Set(lista.filter((s): s is string => typeof s === "string" && propios.includes(s)))].slice(0, MAX_STICKERS_BARRA);
  return barra.length ? barra : STICKERS_GRATIS.filter((s) => propios.includes(s));
}

/** Cuántos stickers puede poner el ganador en un festejo, y cada cuánto (s) */
export const LIMITE_STICKERS = { porFestejo: 6, cada: 0.35 };

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
export const BOLETOS = { max: 5, maxGrande: 10, recargaMs: 30 * 60 * 1000 } as const;

/** Hasta cuántos boletos guarda una cuenta: 10 con la boletera grande (comprada), si no 5 */
export const maxBoletos = (boletera = false): number => (boletera ? BOLETOS.maxGrande : BOLETOS.max);

/** Llenar los boletos con monedas (sin boletos, antes de la recarga con dinero): más con la boletera grande */
export const PRECIO_RECARGA = { normal: 500, grande: 750 } as const;
export const precioRecarga = (boletera = false): number => (boletera ? PRECIO_RECARGA.grande : PRECIO_RECARGA.normal);

/**
 * LO QUE SE COMPRA CON DINERO (App Store y Google Play). `tienda` es el id del producto en las dos
 * tiendas (el mismo en App Store Connect y en Play Console). Los consumibles se pueden comprar
 * otra vez; la boletera es para siempre (en Google se reconoce sin consumirla). El precio lo pone
 * cada tienda: `precio` es solo el texto de respaldo mientras la tienda contesta
 */
export type ProductoDinero = {
  id: string;
  tienda: string;
  consumible: boolean;
  da: { monedas: number } | { recarga: true } | { boletera: true };
  precio: string;
};
export const PRODUCTOS_DINERO: readonly ProductoDinero[] = [
  { id: "recarga", tienda: "mx.jorgeandresgarcia.edgeracers.recarga", consumible: true, da: { recarga: true }, precio: "US$0.99" },
  { id: "boletera", tienda: "mx.jorgeandresgarcia.edgeracers.boletera", consumible: false, da: { boletera: true }, precio: "US$3.99" },
  { id: "monedas-500", tienda: "mx.jorgeandresgarcia.edgeracers.monedas500", consumible: true, da: { monedas: 500 }, precio: "US$0.99" },
  { id: "monedas-3000", tienda: "mx.jorgeandresgarcia.edgeracers.monedas3000", consumible: true, da: { monedas: 3000 }, precio: "US$3.99" },
  { id: "monedas-10000", tienda: "mx.jorgeandresgarcia.edgeracers.monedas10000", consumible: true, da: { monedas: 10000 }, precio: "US$9.99" },
];
/** El producto con ese id de tienda (o null si no es nuestro) */
export const productoDeTienda = (tienda: unknown): ProductoDinero | null => PRODUCTOS_DINERO.find((p) => p.tienda === tienda) ?? null;

/**
 * MONEDAS: cada copa en Difícil, una vez al día, paga según el lugar final (desde la primera vez,
 * sin nada que desbloquear); un vehículo cuesta PRECIO_VEHICULO: lo que
 * dan 10 copas en 1º, 20 en 2º o 40 en 3º
 */
export const PREMIO_LUGAR = [400, 200, 100, 0] as const;

/**
 * EL MULTIJUGADOR: cada partida cuesta un boleto a cada persona (se cobra al empezar la
 * preparación) y paga por el lugar final, sin límite por día
 */
export const PREMIO_MULTI = [150, 75, 25, 0] as const;
/** La preparación antes de cada partida: un paso para el vehículo y otro para los stickers (ms cada uno) */
export const PREPARACION_MS = 15_000;
/** Lo que se ve la pantalla de victoria de una partida multijugador antes de volver todos a la sala de espera (s) */
export const RESULTADOS_MULTI_S = 10;
/** Lo que tarda un bot en decir "listo" en la sala de espera (s, al azar en el rango): como una persona */
export const LISTO_BOTS = [3, 8] as const;
/** De vuelta en la sala de espera después de una partida: lo que tarda cada bot en decir "listo" (s) */
export const LISTO_BOTS_TRAS_PARTIDA = [5, 14] as const;
/**
 * Lo que aguanta un bot listo a que el anfitrión (una persona) empiece la partida (s, al azar en el
 * rango): después se va de la sala, harto, y llega otro (LLEGADA_BOTS.relevo)
 */
export const PACIENCIA_BOTS = [20, 40] as const;
/**
 * Cuándo llegan los bots a una sala multijugador (s desde que se creó, al azar en cada rango). La
 * de Partida rápida ya nace con uno y le llegan los otros dos. Si se libera un lugar, otro en `hueco`
 */
export const LLEGADA_BOTS = {
  sala: [[3, 8], [8, 14], [14, 20]] as const,
  rapida: [[8, 14], [14, 20]] as const,
  /** Partida rápida en una sala nueva donde tú eres el anfitrión: el primer bot no llega al instante */
  primero: [[2, 4]] as const,
  hueco: [5, 10] as const,
  /** Un bot que se fue harto de esperar (PACIENCIA_BOTS): el que lo reemplaza */
  relevo: [3, 15] as const,
};

/** Lo que ganó alguien al terminar una partida multijugador (viene en EVENTOS.cuentaCambio) */
export interface ResultadoMulti {
  lugar: number;
  monedas: number;
}

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
  /** Los stickers que tiene: los gratis y los comprados (en el orden de STICKERS) */
  stickers: string[];
  /** Los que lleva en la barra del festejo (hasta MAX_STICKERS_BARRA), en su orden */
  barraStickers: string[];
  monedas: number;
  /** Siempre true (las monedas ya no se desbloquean); se queda para las apps que aún lo leen */
  monedasActivas: boolean;
  /** Compró la boletera grande (guarda hasta BOLETOS.maxGrande) */
  boletera: boolean;
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
  /** Sala multijugador (boleto y premio, se llena con bots) y si es privada (solo con el código) */
  multi?: boolean;
  privada?: boolean;
  /** Multijugador: la pista es al azar (en cada partida sale otra; el lobby dice "Aleatoria") */
  aleatoria?: boolean;
  /** Multijugador: quienes ven la partida sin jugar (entran en lugar de un bot al volver a la espera) */
  espectadores?: { id: string; nombre: string }[];
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
  /** Multijugador: con boleto y premio */
  multi?: boolean;
}

/** LOS AMIGOS: dónde anda un amigo conectado */
export interface SalaDeAmigo {
  codigo: string;
  circuito: string;
  /** Personas y bots dentro */
  jugadores: number;
  privada: boolean;
  /** Se puede entrar ahora (esperando gente y con lugar) */
  abierta: boolean;
  /** Está en partida (o preparándola): se puede ver como espectador */
  enPartida?: boolean;
}

export interface Amigo {
  codigo: string;
  nombre: string;
  /** Tiene el juego abierto (alguna conexión con su cuenta) */
  conectado: boolean;
  /** Está en una sala multijugador; null si anda en los menús o en un juego de un jugador */
  sala: SalaDeAmigo | null;
}

export interface ListaAmigos {
  /** Tu código de amigo */
  codigo: string;
  /** Pidió que le avisen cuando sus amigos jueguen (amigos:avisar) */
  avisarAmigos?: boolean;
  /** Primero los conectados */
  amigos: Amigo[];
  /** Las que te mandaron y las que mandaste (sin contestar) */
  solicitudes: { codigo: string; nombre: string }[];
  enviadas: { codigo: string; nombre: string }[];
}

export type AvisoAmigos =
  | { tipo: "solicitud"; de: { codigo: string; nombre: string } }
  | { tipo: "aceptada"; de: { codigo: string; nombre: string } }
  | { tipo: "invitacion"; de: { codigo: string; nombre: string }; sala: SalaDeAmigo };

export type Respuesta =
  | { ok: true; id: string; sala: EstadoSala; partida: EstadoPartida; obra?: import("./red").EstadoEscenarioRed }
  | { ok: false; error: string };

export interface DatosJugador {
  nombre: string;
  color: string;
  vehiculo?: Vehiculo;
  /** Su barra de stickers: la pone el servidor desde la cuenta (lo que mande el cliente no cuenta) */
  stickers?: string[];
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
  // El empujón de un choque (segundos), la recuperación después de él (segundos) y la prisa de la ronda
  number, number, number,
  // Colgado del gancho de grúa (segundos)
  number,
];

/**
 * Algo suelto en la pista (un burro, un bache, coyotas…):
 * [id, item (índice en items.json), x, y, angulo, vida (0 … 1), etapa (el bache: 0 recién
 *  tirado, 1 con señalización, 2 tapado con tablas)]
 */
export type EntidadRed = [number, number, number, number, number, number, number];

export interface Instantanea {
  /** Estado autoritativo de Excavación; omitido en las demás pistas. */
  ex?: import("./excavacion").EstadoExcavacion;
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
    c.suelo === "tierra" ? 1 : c.suelo === "peralte" ? 2 : 0, c.indice, seq, vivo ? 1 : 0,
    c.aturdido, c.resbalon, c.lento, c.turbo, item, c.trompo, c.rezago, red3(c.z), red3(c.vz), c.rampa,
    c.enredado, c.ponchado, c.escudo, c.pesado, c.viento, red3(c.vientoX), red3(c.vientoY), c.cemento,
    red3(c.empujon), red3(c.recobro ?? 0), red4(c.prisa ?? 1),
    red3(c.colgado ?? 0),
  ];
}

export function desempacarCarro(r: CarroRed): { id: string; estado: EstadoCarro; seq: number; vivo: boolean; item: number } {
  return {
    id: r[0],
    estado: {
      x: r[1], y: r[2], angulo: r[3], vx: r[4], vy: r[5], w: r[6], derrape: r[7],
      suelo: r[8] === 2 ? "peralte" : r[8] ? "tierra" : "asfalto", indice: r[9],
      aturdido: r[12], resbalon: r[13], lento: r[14], turbo: r[15], trompo: r[17] ?? 0, rezago: r[18] ?? 0,
      z: r[19] ?? 0, vz: r[20] ?? 0, rampa: r[21] ?? -1,
      enredado: r[22] ?? 0, ponchado: r[23] ?? 0, escudo: r[24] ?? 0, pesado: r[25] ?? 0,
      viento: r[26] ?? 0, vientoX: r[27] ?? 0, vientoY: r[28] ?? 0, cemento: r[29] ?? 0,
      empujon: r[30] ?? 0,
      recobro: r[31] ?? 0,
      prisa: r[32] ?? 1,
      colgado: r[33] ?? 0,
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

/**
 * EL REPORTE DE RENDIMIENTO del cliente (viene en el ping, cada ~2 s, en una partida en línea): lo
 * que vio desde el reporte anterior. Lo junta el servidor por partida y por jugador para la página
 * de admin (Status), y así se ve de qué lado viene el lag de un teléfono: render, red o predicción.
 */
export interface ReporteCliente {
  /** Los ms que cubre este reporte */
  ventanaMs: number;
  /* Render */
  fps: number;
  cuadroP50: number;
  cuadroP95: number;
  cuadroMax: number;
  /** Cuadros de más de 50 ms (tirones que se notan) y cuadros en total */
  cuadrosLargos: number;
  cuadros: number;
  /** Calidad adaptativa (teléfonos): nivel (0 = la mejor) y perfil; null en la compu */
  nivelCalidad: number | null;
  perfil: string | null;
  /** La pestaña o la app estuvo en segundo plano en esta ventana */
  oculto: boolean;
  /* Bajada: los estados del servidor */
  estados: number;
  huecoP95: number;
  huecoMax: number;
  /** Atraso p95 de los estados (ms) y colchones de los otros carros y de la cámara (ms) */
  atraso: number;
  colchonOtros: number;
  colchonCamara: number;
  /** Veces que la interpolación se quedó sin estado y siguió de largo */
  deLargo: number;
  /* Subida: los controles */
  envioP95: number;
  confirmacionP95: number;
  pendientes: number;
  /* Red y predicción */
  rttP50: number;
  rttP95: number;
  rttP99: number;
  correcciones: number;
  ultimaCorreccion: number;
  errorChoqueP95: number;
  /** Solo en el primer reporte de la partida */
  dispositivo?: DispositivoCliente;
}

export interface DispositivoCliente {
  /** "ios" | "android" | "web" */
  plataforma: string;
  nativo: boolean;
  celular: boolean;
  ligero: boolean;
  dpr: number;
  ancho: number;
  alto: number;
  ua: string;
}

/** El reporte acotado (cada número a su rango, textos cortos), o null si no es un reporte */
export function sanearReporte(raw: unknown): ReporteCliente | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown, max = 1e5) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v * 100) / 100)) : 0);
  const texto = (v: unknown, largo: number) => (typeof v === "string" ? v.slice(0, largo) : "");
  const ventanaMs = n(r.ventanaMs, 60000);
  if (!ventanaMs) return null;
  const d = r.dispositivo && typeof r.dispositivo === "object" ? (r.dispositivo as Record<string, unknown>) : null;
  return {
    ventanaMs,
    fps: n(r.fps, 500),
    cuadroP50: n(r.cuadroP50, 10000),
    cuadroP95: n(r.cuadroP95, 10000),
    cuadroMax: n(r.cuadroMax, 60000),
    cuadrosLargos: n(r.cuadrosLargos, 30000),
    cuadros: n(r.cuadros, 30000),
    nivelCalidad: typeof r.nivelCalidad === "number" && Number.isFinite(r.nivelCalidad) ? n(r.nivelCalidad, 20) : null,
    perfil: typeof r.perfil === "string" ? texto(r.perfil, 16) : null,
    oculto: r.oculto === true,
    estados: n(r.estados, 30000),
    huecoP95: n(r.huecoP95, 60000),
    huecoMax: n(r.huecoMax, 60000),
    atraso: n(r.atraso, 60000),
    colchonOtros: n(r.colchonOtros, 60000),
    colchonCamara: n(r.colchonCamara, 60000),
    deLargo: n(r.deLargo, 30000),
    envioP95: n(r.envioP95, 60000),
    confirmacionP95: n(r.confirmacionP95, 60000),
    pendientes: n(r.pendientes, 10000),
    rttP50: n(r.rttP50, 60000),
    rttP95: n(r.rttP95, 60000),
    rttP99: n(r.rttP99, 60000),
    correcciones: n(r.correcciones, 30000),
    ultimaCorreccion: n(r.ultimaCorreccion, 10000),
    errorChoqueP95: n(r.errorChoqueP95, 10000),
    ...(d
      ? {
          dispositivo: {
            plataforma: ["ios", "android", "web"].includes(d.plataforma as string) ? (d.plataforma as string) : "web",
            nativo: d.nativo === true,
            celular: d.celular === true,
            ligero: d.ligero === true,
            dpr: n(d.dpr, 10),
            ancho: n(d.ancho, 20000),
            alto: n(d.alto, 20000),
            ua: texto(d.ua, 200),
          },
        }
      : {}),
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
