/**
 * Tipos del juego de carreras compartidos entre servidor y navegador.
 * Este archivo (y todo src/juego/compartido) no puede importar nada de Node ni del DOM:
 * el front lo copia tal cual con `npm run juego:sync`.
 */

export type Vec = [number, number];

/** Tipos de suelo. Cada uno tiene su agarre y tracción en PARAMETROS_FISICA.superficies */
export type TipoSuelo = "asfalto" | "tierra";

/** Estado físico de un carro: objeto plano para poder copiarlo y re-simularlo (predicción) */
export interface EstadoCarro {
  x: number;
  y: number;
  /** Hacia dónde apunta el carro, en radianes (0 = +x) */
  angulo: number;
  vx: number;
  vy: number;
  /** Velocidad angular actual (rad/s) */
  w: number;
  /** Qué tanto está derrapando, de 0 a 1 (para marcas de llanta y polvo) */
  derrape: number;
  suelo: TipoSuelo;
  /** Segmento de la línea central más cercano (acelera la búsqueda y evita saltar de tramo) */
  indice: number;
  /**
   * Efectos de los items, en pasos que faltan (bajan uno por cada control aplicado). Son parte
   * del estado para que el navegador los prediga igual que el servidor.
   */
  aturdido: number;
  resbalon: number;
  lento: number;
  turbo: number;
  /** Descontrolado por un coletazo de otro carro (pasos que faltan): sin volante y casi sin agarre */
  trompo: number;
}

/** Choques entre carros (los muros usan `radio` y `rebote` generales) */
export interface ParametrosChoque {
  /** Radio de los círculos al chocar con otro carro: un poco más que medio ancho, para que un roce cuente */
  radio: number;
  /** Rebote entre carros: bajo = el golpe empuja en vez de botar */
  rebote: number;
  /** Fricción entre carrocerías: al rozar de lado le pasas parte de tu movimiento (para desviarlo) */
  friccion: number;
}

export interface ParametrosColetazo {
  /** Velocidad (m/s) con la que la cola tiene que llegar al otro carro para descontrolarlo */
  velocidadMinima: number;
  /** Giro (rad/s) que le mete al golpeado un coletazo con fuerza máxima */
  giro: number;
  /** Segundos de trompo con un coletazo de fuerza máxima */
  duracion: number;
  /** Agarre que le queda al golpeado mientras da el trompo (fracción) */
  agarre: number;
  /** Qué tan rápido se le pasa el giro durante el trompo (1/s) */
  frenadoGiro: number;
}

export interface ParametrosEfectos {
  /** Giro descontrolado mientras estás aturdido (rad/s) */
  giroAturdido: number;
  /** Agarre que queda al resbalar (fracción) */
  resbalonAgarre: number;
  /** Velocidad máxima que queda con calor (fracción) */
  lentoVelocidad: number;
  turboVelocidad: number;
  turboAceleracion: number;
}

/** Un item de content/juego/items.json. `mecanica` elige el comportamiento; el resto son sus números */
export interface Item {
  id: string;
  nombre: string;
  descripcion: string;
  mecanica: "misil" | "mina" | "mancha" | "cono" | "nube" | "obstaculo" | "abanico" | "turbo" | "estorbo";
  /** Peso al sacarlo de una caja (0: no sale de cajas; lo deja otro item, como el asador) */
  probabilidad: number;
  /** Lo que se suelta se queda en el mapa hasta que termine la partida (ignora `vida`) */
  persiste?: boolean;
  /** Al acabarse su `vida`, deja en el mismo lugar este otro item (por id) */
  deja?: string;
  /** Mina: a quien caiga después del primero solo lo desvía este tanto (grados) */
  desvio?: number;
  color: string;
  /** Segundos que dura el efecto en quien lo recibe */
  duracion?: number;
  /** Empujón (m/s) o, en mina y tope, fracción de la velocidad que queda */
  fuerza?: number;
  /** Radio de alcance (m) */
  radio?: number;
  /** Velocidad del proyectil (m/s) */
  velocidad?: number;
  /** Qué tan rápido dobla un proyectil que persigue (rad/s) */
  giro?: number;
  /** Largo del cono (m) */
  alcance?: number;
  /** Apertura del cono o del abanico (grados) */
  angulo?: number;
  cantidad?: number;
  /** Segundos que vive lo que se suelta o se dispara */
  vida?: number;
}

/** Lo único que manda un jugador: sus controles */
export interface Controles {
  /** -1 izquierda … 1 derecha */
  giro: number;
  /** 0 … 1 */
  acel: number;
  /** 0 … 1 (frena y, ya detenido, da reversa) */
  freno: number;
  /** Freno de mano */
  mano: boolean;
}

export interface ParametrosSuelo {
  /** Qué tan rápido se mata la velocidad lateral (1/s). Más alto = menos derrape */
  agarre: number;
  /** Multiplica la aceleración */
  traccion: number;
  /** Fracción de la velocidad máxima que se alcanza en este suelo */
  velocidadMax: number;
  /** Frenado por rodamiento sin acelerar (m/s²) */
  rodamiento: number;
}

export interface ParametrosFisica {
  aceleracion: number;
  velocidadMax: number;
  reversaMax: number;
  frenado: number;
  giro: number;
  /** Debajo de esta velocidad el giro se reduce (un carro detenido no gira) */
  velocidadGiroPleno: number;
  /** Qué tan rápido responde el volante (1/s) */
  respuestaGiro: number;
  /** A velocidad máxima el giro baja a (1 - esto) */
  subviraje: number;
  /** Multiplica el agarre lateral con freno de mano (más bajo = derrape más largo) */
  agarreMano: number;
  /** Multiplica el giro con freno de mano */
  giroMano: number;
  /** Desaceleración del freno de mano (m/s²) */
  frenoMano: number;
  /** Parte de la velocidad lateral que se vuelve hacia adelante al salir del derrape */
  recuperacion: number;
  rebote: number;
  radio: number;
  superficies: Record<TipoSuelo, ParametrosSuelo>;
  efectos: ParametrosEfectos;
  choque: ParametrosChoque;
  coletazo: ParametrosColetazo;
}

/* ---------------------------------- Circuito ---------------------------------- */

/** Zona que cambia el suelo dentro de un polígono (p. ej. un tramo de terracería en la pista) */
export interface ZonaSuelo {
  tipo: TipoSuelo;
  poligono: Vec[];
  /** Solo cambia cómo se dibuja: "rio" (lecho seco), "banqueta", "plaza" */
  estilo?: string;
  /** Para "rio": por dónde corre el hilo de agua */
  cauce?: Vec[];
}

/**
 * Loma (altura > 0) u hoyo (altura < 0) con perfil suave. La física es plana: la altura solo se
 * dibuja y se usa para saber qué se ve en la cámara.
 */
export interface Loma {
  x: number;
  y: number;
  radio: number;
  altura: number;
}

/**
 * Un muro: solo puntos (prueba.json), o con altura y color para edificios. `oculto` choca pero
 * no se dibuja (va debajo de una decoración que ya tiene su modelo: la Catedral, el camión…)
 */
export type Muro = Vec[] | { puntos: Vec[]; alto?: number; color?: string; oculto?: boolean };

export interface Decoracion {
  tipo: string;
  x: number;
  y: number;
  rotacion?: number;
  escala?: number;
  /** Va sobre el agua (barcos), no en el fondo */
  flota?: boolean;
}

/** El circuito como datos (content/juego/circuitos/*.json) */
export interface Circuito {
  id: string;
  nombre: string;
  /** Puntos de control de la línea central (circuito cerrado), en metros. Se suavizan con Catmull-Rom */
  centro: Vec[];
  /** Ancho del camino en metros */
  ancho: number;
  /** Rectángulo del mundo; fuera de él hay muro */
  limites: { x: number; y: number; ancho: number; alto: number };
  superficies: ZonaSuelo[];
  barrancos: Vec[][];
  /** Mar, lagos, marinas: caer adentro elimina (como un barranco) y el fondo baja desde la orilla */
  agua?: Vec[][];
  muros: Muro[];
  cajas: Vec[];
  decoracion: Decoracion[];
  elevacion?: Loma[];
  /** No se ofrece para jugar (el circuito de prueba del laboratorio) */
  oculto?: boolean;
}
