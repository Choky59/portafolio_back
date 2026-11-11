/**
 * Tipos del juego de carreras compartidos entre servidor y navegador.
 * Este archivo (y todo src/juego/compartido) no puede importar nada de Node ni del DOM:
 * el front lo copia tal cual con `npm run juego:sync`.
 */

export type Vec = [number, number];

/** Tipos de suelo. Cada uno tiene su agarre y tracción en PARAMETROS_FISICA.superficies */
export type TipoSuelo = "asfalto" | "tierra" | "peralte";

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
  /** Al borde de quedarse fuera de la cámara (pasos que faltan): un poco más de motor para alcanzar */
  rezago: number;
  /**
   * Efectos de los items de las copas (pasos que faltan, como los de arriba):
   * enredado (rodadora): la dirección responde menos; ponchado (cactus, clavos): menos velocidad
   * máxima y el carro se jala a un lado; escudo (agua fresca): los golpes rebotan; pesado
   * (casco): pesa más en los choques; viento (tormenta): lo empuja (vientoX, vientoY) de lado;
   * cemento: mientras más trae, más lento va (lo llena la zona de cemento fresco)
   */
  enredado: number;
  ponchado: number;
  escudo: number;
  pesado: number;
  viento: number;
  /** Hacia dónde y qué tan rápido lo arrastra el viento (m/s) mientras dura */
  vientoX: number;
  vientoY: number;
  cemento: number;
  /** Altura sobre el suelo (m) y velocidad vertical (m/s): subiendo una rampa o en el aire */
  z: number;
  vz: number;
  /** Índice de la rampa (circuito.rampas) por la que va subiendo, o -1 */
  rampa: number;
  /**
   * Segundos que le quedan COLGADO del gancho de grúa: va por el aire con su inercia, pero el
   * volante responde como en el piso (en un salto normal, menos). Se apaga al aterrizar
   */
  colgado: number;
  /**
   * Segundos que le quedan al EMPUJÓN de un choque con otro carro: la llanta agarra menos y el
   * volante no borra el giro del golpe, así que el golpe sí le cambia la trayectoria (ver chocarCarros)
   */
  empujon: number;
  /**
   * Segundos que le quedan a la RECUPERACIÓN después de un choque (empujón o trompo): el volante
   * va con tope y el giro que dejó el golpe se apaga solo, para no sobregirar al salir. Solo las
   * personas (ParametrosRecobro.activo); en los bots se queda en 0
   */
  recobro: number;
  /**
   * PRISA de la ronda: cuánto más motor trae (1 al arrancar). El servidor la sube poco a poco
   * mientras dura la ronda (prisaDeRonda) y viaja en la instantánea, así la predicción del
   * navegador topa igual que el servidor
   */
  prisa: number;
}

/** La velocidad que va subiendo durante la ronda (ver EstadoCarro.prisa) */
export interface ParametrosPrisa {
  /** Segundos de carrera para llegar al tope */
  segundos: number;
  /** Cuánto se multiplica la velocidad máxima al llegar (190/135 = de 135 a 190 km/h) */
  tope: number;
}

/** La ayuda para salir de un choque sin sobregirar (ver EstadoCarro.recobro) */
export interface ParametrosRecobro {
  /** Si aplica: las personas sí, los bots no (bots.ts, fisicaDe) */
  activo: boolean;
  /** Segundos de ayuda después de que se acaba el empujón o el trompo */
  duracion: number;
  /** Tope del volante al empezar la ayuda (fracción); sube poco a poco hasta 1 al terminarla */
  volante: number;
  /** Qué tan rápido (1/s, además del volante) se apaga el giro que dejó el golpe */
  estabilizar: number;
}

/** Choques entre carros (los muros usan `radio` y `rebote` generales) */
export interface ParametrosChoque {
  /** Radio de los círculos al chocar con otro carro: un poco más que medio ancho, para que un roce cuente */
  radio: number;
  /** Rebote entre carros: bajo = el golpe empuja en vez de botar */
  rebote: number;
  /** Fricción entre carrocerías: al rozar de lado le pasas parte de tu movimiento (para desviarlo) */
  friccion: number;
  /** El empujón que deja un golpe (ver EstadoCarro.empujon) */
  empujon: ParametrosEmpujon;
}

export interface ParametrosEmpujon {
  /** Segundos de empujón con un golpe de fuerza máxima */
  duracion: number;
  /** Agarre que le queda al empujado en el momento del golpe (fracción; se recupera mientras dura) */
  agarre: number;
  /** Qué tanto responde el volante al momento del golpe (fracción): bajo = el giro del golpe sobrevive */
  volante: number;
  /** Desvío (m/s de lado + giro) por debajo del cual un golpe no empuja: un roce no cuenta */
  umbral: number;
  /** Desvío arriba del umbral con el que el empujón es de fuerza máxima */
  pleno: number;
  /**
   * VENTAJA DEL QUE EMBISTE: el que puso todo el acercamiento pesa (1 + ventaja) veces en ese
   * choque. Se desvía menos y el otro sale más empujado (el impulso sigue siendo igual y opuesto)
   */
  ventaja: number;
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
  /** Velocidad máxima y aceleración del que va al borde de la imagen (factor) */
  rezagoVelocidad: number;
  rezagoAceleracion: number;
  /** Enredado: fracción del volante que queda */
  enredadoGiro: number;
  /** Ponchado: velocidad máxima que queda (fracción) y cuánto se jala hacia la derecha (rad/s) */
  ponchadoVelocidad: number;
  ponchadoJalon: number;
  /** Cemento: velocidad máxima que queda con la carga llena (fracción), y cuántos pasos es "lleno" */
  cementoVelocidad: number;
  cementoLleno: number;
  /** Cemento: el tope de velocidad en cuanto lo pisas (fracción) y qué tan rápido frena a él (1/s) */
  cementoTope: number;
  cementoFrenado: number;
  /** Casco: cuánto pesa en un choque (el resto de los carros pesa 1) */
  pesadoMasa: number;
}

/** Un item de content/juego/items.json. `mecanica` elige el comportamiento; el resto son sus números */
export interface Item {
  id: string;
  nombre: string;
  descripcion: string;
  mecanica:
    | "misil"
    | "mina"
    | "mancha"
    | "cono"
    | "nube"
    | "obstaculo"
    | "abanico"
    | "turbo"
    | "estorbo"
    | "meteorito"
    | "persona"
    | "calle"
    // Copa Desierto
    | "rodante"
    | "pegajoso"
    | "crece"
    | "viento"
    | "senuelo"
    | "escudo"
    // Copa Construcción
    | "iman"
    | "alfombra"
    | "fragua"
    | "onda"
    | "barrera"
    | "pesado"
    | "gancho"
    | "retro"
    | "parabola"
    // Peligros del ambiente (los pone la pista, no salen de cajas)
    | "cruce"
    | "cierre"
    | "tuberia"
    | "escombro"
    | "brazo";
  /** Peso al sacarlo de una caja (0: no sale de cajas; lo deja otro item, como el asador) */
  probabilidad: number;
  /**
   * De qué copa es (copas.json): solo sale en las pistas de esa copa. Sin copa, es de las pistas
   * libres (Hermosillo, San Carlos)
   */
  copa?: string;
  /** Peligro del ambiente: los carros chocan contra él (la aplanadora) */
  solido?: boolean;
  /** De qué color de caja sale (id de CATEGORIAS en protocolo.ts): cada color da solo los suyos */
  categoria?: string;
  /** Lo que se suelta se queda en el mapa hasta que termine la partida (ignora `vida`) */
  persiste?: boolean;
  /** Con `persiste`: se queda solo hasta que acabe la ronda (el cráter del meteorito), no toda la partida */
  soloRonda?: boolean;
  /** Al acabarse su `vida`, deja en el mismo lugar este otro item (por id) */
  deja?: string;
  /** Lo que deja aparece en cuanto se suelta, no al acabarse (el asador sale junto con el humo) */
  dejaAlSoltar?: boolean;
  /** Bolsa de clavos: cuánto tiempo riega (s) y qué tan ancha es la franja (m) */
  riego?: number;
  ancho?: number;
  /** Martillo: lo que tarda el anillo en abrirse (s); el golpe viaja con él */
  vidaOnda?: number;
  /** Lo que deja ya cuenta como pisado (el bache de un meteorito: solo desvía) */
  dejaGastado?: boolean;
  /** Mina: a quien caiga después del primero solo lo desvía este tanto (grados) */
  desvio?: number;
  /**
   * Lo que persiste y se acaba con las vueltas (del que va adelante): en la pasada número
   * `tapar` ya terminó, y en la anterior se ve en su etapa intermedia. El bache: señalización de desviación
   * y luego tablas (ya no hace nada). El charco: más chico (`encoge`) y luego se seca y se va
   */
  tapar?: number;
  /** Charco en su etapa intermedia: fracción de su radio que le queda */
  encoge?: number;
  /** En su etapa intermedia llega gente (el asador): entre `min` y `max` de este item (por id) */
  llegan?: { item: string; min: number; max: number };
  /** Lo que grita el personaje de la calle (el navegador las va mostrando en un globo) */
  frases?: string[];
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
  /** Segundos en que a quien lo disparó no le pega (después sí: te puede regresar) */
  inmunidad?: number;
  /** Largo del cono (m) */
  alcance?: number;
  /** Imán: fracción de la velocidad que le roba por tick al que jala */
  roba?: number;
  /** Imán: a qué distancia (m) se suelta al alcanzarlo, y cuántos s no chocan después */
  contacto?: number;
  sinChoque?: number;
  /** Imán sin nadie adelante: el campo en el piso (s, m, jalón m/s por s, lo que le queda de velocidad por tick) */
  vidaCampo?: number;
  radioCampo?: number;
  fuerzaCampo?: number;
  frenarCampo?: number;
  /** Apertura del cono o del abanico (grados) */
  angulo?: number;
  cantidad?: number;
  /** Segundos que vive lo que se suelta o se dispara */
  vida?: number;
  /** Carretilla volteada, ladrillo tirado: segundos que se queda en el piso como obstáculo */
  vidaSuelo?: number;
  /** Lo que se queda en el piso (carretilla, ladrillo): fracción de la velocidad que le deja al que lo pisa */
  fuerzaSuelo?: number;
  /**
   * Cierre de obra: qué tan largo es cada tramo (m), cuántos tramos seguidos lleva (cada uno es una
   * entidad, alineada con el camino en su punto: así el cierre sigue las curvas) y cuántos carriles tapa
   */
  largo?: number;
  tramos?: number;
  carrilesCierre?: number;
  /** Cierre de obra: segundos de aviso (conos y señal, todavía se pasa) antes de quedar cerrado */
  aviso?: number;
  /** Tubería: el largo, alto y ancho (en carriles) de cada una de sus dos rampas, y su diámetro (m) */
  largoRampa?: number;
  altoRampa?: number;
  carrilesRampa?: number;
  diametro?: number;
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
  /** Debajo de esta velocidad el giro normal se reduce (y entra el giro en su lugar, giroEnSitio) */
  velocidadGiroPleno: number;
  /**
   * Giro sobre su propio eje a baja velocidad (fracción del giro normal): detenido, el carro rota
   * en su lugar y se zafa de lo que lo atoró; se va quitando hasta velocidadGiroPleno
   */
  giroEnSitio?: number;
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
  /** Gravedad en los saltos (m/s²) */
  gravedad: number;
  /** Fracción de la velocidad que queda al aterrizar */
  aterrizaje: number;
  superficies: Record<TipoSuelo, ParametrosSuelo>;
  efectos: ParametrosEfectos;
  choque: ParametrosChoque;
  coletazo: ParametrosColetazo;
  recobro: ParametrosRecobro;
  prisa: ParametrosPrisa;
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

/**
 * Rampa de salto (fuera del camino, en las curvas): se sube desde (x, y) en la dirección `angulo`,
 * `largo` m, hasta `alto` m; quien sale por arriba con velocidad sale volando. `caja`: una caja de
 * items en el aire, `distancia` m después de la rampa y a `altura` m del suelo: solo se agarra volando
 */
export interface Rampa {
  x: number;
  y: number;
  angulo: number;
  largo: number;
  ancho: number;
  alto: number;
  /** Altura al pie (0 si no dice): con `desde` = `alto` es un piso plano elevado (el puente de Grúas) */
  desde?: number;
  caja?: { distancia: number; altura: number };
  /**
   * Cómo se dibuja: "puente" es el despegue del puente incompleto (de lado a lado del camino);
   * "rescate" (la rampita para salir del hueco) y "llegada" (la que baja al camino) son parte del
   * mismo puente y las dibuja su pieza "puente-roto"
   */
  estilo?: string;
}

/**
 * Una pieza de la escenografía de la obra puesta a mano (las zonas de Obra Negra: torres, el
 * rascacielos, el puente sobre el camino, el estacionamiento, la demolición…). `angulo`: hacia
 * dónde mira su eje x (casi siempre, el del camino). La colisión de cada tipo está en
 * escenario.ts (piezaEnEscenario) y su modelo en construccion.js del navegador
 */
export interface PiezaObra {
  tipo: string;
  x: number;
  y: number;
  angulo: number;
  /** Medidas (m): a lo largo de x, de y, y de alto; o pisos. `largo`: un segundo tramo a lo largo (la llegada del puente) */
  largo?: number;
  ancho?: number;
  fondo?: number;
  alto?: number;
  pisos?: number;
  /** Variante de dibujo (semilla) */
  semilla?: number;
  /**
   * El puente de acero de Grúas ("puente-acero"): su cubierta como franja continua, punto por
   * punto a lo largo: [x adentro, y adentro, x afuera, y afuera, altura]
   */
  perfil?: number[][];
}

/** Un patio de la obra puesto a mano (los tipos de siempre: marco, columnas, tarimas…) */
export interface PatioFijo {
  tipo: string;
  x: number;
  y: number;
  giro: number;
  semilla?: number;
}

/**
 * Un lugar donde caen ESCOMBROS de la demolición (Sala.ponerEscombros): en el metro `s` de la
 * vuelta, a `lateral` m del centro, cada `cada` s (empezando a los `desfase` s de carrera)
 */
export interface LugarEscombros {
  s: number;
  lateral: number;
  cada: number;
  desfase?: number;
}

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
  /** Dos mecanismos activables exclusivos de la excavación. */
  excavacion?: import("./excavacion").ConfiguracionExcavacion;
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
  rampas?: Rampa[];
  /** Carriles del camino (7 m cada uno): si viene, el ancho sale de aquí */
  carriles?: number;
  /** El suelo del lugar: "arena" (el desierto, por defecto) u "obra" (grava de construcción) */
  terreno?: string;
  /**
   * La identidad de la pista (la de su copa, ver copas.json): los ids de los items que salen de
   * sus cajas (sin esto, todos los que salen de cajas), lo que tiran los eliminados (sin esto,
   * nada) y sus peligros del ambiente
   */
  items?: string[];
  espectador?: string;
  ambiente?: Ambiente[];
  /** Tramos del camino que se van cerrando por obras durante la ronda (ver Obras) */
  obras?: Obras;
  /**
   * La escenografía de la obra hecha a mano (Obra Negra): sus piezas, y los patios en lugares
   * fijos en vez de la cuadrícula al azar (con `patiosFijos`, ya no se sortean)
   */
  piezas?: PiezaObra[];
  patiosFijos?: PatioFijo[];
  /** Donde caen escombros de la demolición */
  escombros?: LugarEscombros[];
  /**
   * La tubería de la obra (un item con mecánica "tuberia"): siempre hay una montada en algún lugar
   * adelante, fuera de la cámara; ya pasada, se cambia de lugar sin que se vea (Sala.ponerTuberia).
   * `adelante`: a cuántos m adelante del primero se monta (de, a)
   */
  tuberia?: { item: string; adelante: [number, number] };
  /** false: no salen personajes de la calle (los vendedores); en las pistas del desierto sí salen */
  calle?: boolean;
}

/**
 * OBRAS EN LA CALLE: durante la carrera, adelante del que va primero, se cierra un tramo del
 * camino (un item con mecánica "cierre": un carril, dos, o material tirado). Primero se ve el
 * aviso (conos y señal, todavía se pasa) y luego queda cerrado, sólido como un muro, hasta que
 * se acaba su `vida`. Siempre queda al menos un carril libre. Con la ronda nueva se abre todo
 */
export interface Obras {
  /** Los items de cierre que pueden salir (ids, al azar) */
  items: string[];
  /** Segundos de carrera antes del primer cierre, y cada cuánto sale otro */
  primera: number;
  cada: number;
  /** Cuántos cierres puede haber a la vez */
  maximo: number;
  /** Qué tan adelante del primero aparecen (m de pista: de, a) */
  adelante: [number, number];
}

/**
 * Un peligro del ambiente: una entidad (el item `item`, con mecánica "cruce") que va y viene
 * entre los puntos de la pista `desde` y `hasta` (metros recorridos y lateral), `veces` a la
 * vez, a `velocidad` m/s, esperando `pausa` s en cada orilla
 */
export interface Ambiente {
  item: string;
  /** En qué metro de la vuelta cruza, de qué lado empieza y a qué lado llega (m del centro) */
  s: number;
  desde: number;
  hasta: number;
  velocidad: number;
  pausa?: number;
}
