import type { EstadoCarro, Item } from "../compartido/tipos";
import { enAgua, enBarranco, lateralEnPista, proyectar, puntoEnPista, type Pista } from "../compartido/pista";
import { PARAMETROS_FISICA, circulosCarro, rapidez } from "../compartido/fisica";
import type { Evento } from "../compartido/protocolo";

/**
 * Los items de Hermosillo. Cada item de content/juego/items.json elige una `mecanica` y le da sus
 * números (duración, fuerza, radio…). Aquí vive una sola implementación por mecánica, así que
 * agregar o ajustar un item no requiere tocar este código.
 *
 * Todo se calcula en el servidor. Lo que se suelta o se dispara es una "entidad" que vive unos
 * ticks en la pista; lo que le pasa a un carro es un efecto (aturdido, resbalón, lento, turbo,
 * empujón o frenón) que la física compartida ya sabe aplicar.
 */

/** Distancia del centro del carro a su borde, para los contactos */
const RADIO_CARRO = 1.3;
/** Lo más que se aleja una persona de su lugar en la carne asada al correr (m) */
const LEJOS_DE_CASA = 14;
/** En pánico, cada persona corre a un punto del camino a lo más este tanto antes o después del asador (m) */
const PANICO_LARGO = 9;
/** El burro sale este tanto delante de quien lo tira, y por lo menos este tanto más rápido que él (m/s) */
const SALIDA_MISIL = 6;
const VENTAJA_MISIL = 10;

export interface Entidad {
  id: number;
  /** Índice en la lista de items */
  item: number;
  dueno: string;
  x: number;
  y: number;
  angulo: number;
  vx: number;
  vy: number;
  /** Ticks que le quedan y con los que nació */
  vida: number;
  vidaMax: number;
  /** Ticks desde que salió */
  edad: number;
  /** El misil persigue a este carro */
  objetivo: string | null;
  /** Carros a los que ya les pegó (tope) o que están adentro (charco, bache) */
  tocados: Set<string>;
  /** A cuántos ha agarrado (el bache: el primero se lleva el golpe completo) */
  golpes: number;
  /** Cuánto había avanzado el que va adelante cuando salió (m): para contarle las vueltas */
  nacio: number;
  /**
   * Etapa que se ve (bache: 0, 1 señalización, 2 tapado; charco y asador igual). La Sala la avanza
   * sin que se vea. Una persona la usa para decir si está tranquila (0) o corriendo (1)
   */
  etapa: number;
  /** Persona: su lugar junto al asador, hacia dónde mira ahí y el id del asador */
  casa?: { x: number; y: number; mira: number; asador: number };
  /** Persona en pánico: a dónde corre ahora */
  destino?: { x: number; y: number } | null;
  /** Escorpión: en qué `edad` cambió de carro la última vez (no se regresa luego luego) */
  pase?: number;
}

export interface Conductor {
  id: string;
  carro: EstadoCarro;
}

export interface Efecto {
  /** Segundos */
  aturdido?: number;
  resbalon?: number;
  lento?: number;
  turbo?: number;
  /** Velocidad que se le suma (m/s) */
  empujon?: [number, number];
  /** Fracción de la velocidad que le queda */
  frenar?: number;
  /** Giro que se le suma (rad/s): una sacudida */
  sacudida?: number;
  /** Lo voltea este tanto (rad), con todo y su velocidad: un desvío seco */
  desvio?: number;
  /** Segundos de los efectos de las copas */
  enredado?: number;
  ponchado?: number;
  escudo?: number;
  pesado?: number;
  /** Tormenta: arrastre de lado (m/s) y cuántos segundos */
  viento?: { x: number; y: number; segundos: number };
  /** Cemento: pasos que se le suman a su carga */
  cemento?: number;
  /** Agua fresca: le quita todo lo malo que traiga */
  limpiar?: boolean;
}

/** Lo que una mecánica necesita del mundo; lo implementa la Sala */
export interface MundoItems {
  readonly tickHz: number;
  readonly pista: Pista;
  readonly items: Item[];
  /** Carros vivos */
  conductores(): Conductor[];
  /** Metros recorridos en la carrera: para saber quién va adelante */
  recorrido(id: string): number;
  /** Lo más que ha avanzado el que va adelante en esta partida (m) */
  avance(): number;
  soltar(e: Omit<Entidad, "id" | "edad" | "tocados" | "vidaMax" | "golpes" | "nacio" | "etapa">): void;
  /** Aplica un efecto; `silencioso` no avisa a los clientes (efectos que se renuevan cada tick) */
  golpear(victima: Conductor, item: number, efecto: Efecto, silencioso?: boolean): void;
  /** Algo cayó del cielo en (x, y): explotan los carros a menos de `radio` */
  aplastar(x: number, y: number, radio: number): void;
  /** ¿Sigue en la pista la entidad con este id? */
  existe(id: number): boolean;
  /** Avisa a los navegadores (efectos y sonido) */
  avisar(evento: Evento): void;
  /** Número al azar de 0 a 1 (el de la sala: los tests lo fijan) */
  azar(): number;
  /** ¿Alguien puede estar viendo el punto (x, y)? */
  seVe(x: number, y: number): boolean;
}

export interface Mecanica {
  /** Al apretar la tecla del item */
  usar(m: MundoItems, quien: Conductor, indice: number, item: Item): void;
  /** Un tick de una entidad suelta; false para quitarla */
  actualizar?(m: MundoItems, e: Entidad, item: Item): boolean;
  /** Cada tick mientras el carro tiene su turbo */
  mientras?(m: MundoItems, quien: Conductor, indice: number, item: Item, tick: number): void;
}

/* -------------------------------- Ayudas -------------------------------- */

const ticks = (m: MundoItems, segundos = 0) => Math.round(segundos * m.tickHz);

/** Un punto `d` metros delante (o detrás, si es negativo) del carro */
function frente(c: EstadoCarro, d: number): { x: number; y: number } {
  return { x: c.x + Math.cos(c.angulo) * d, y: c.y + Math.sin(c.angulo) * d };
}

/** Quien suelta algo no se lo come en cuanto sale (ni el que lo dispara) */
function inmune(e: Entidad, c: Conductor, m: MundoItems, segundos: number): boolean {
  return c.id === e.dueno && e.edad < ticks(m, segundos);
}

function tocando(e: Entidad, c: Conductor, radio: number): boolean {
  return Math.hypot(c.carro.x - e.x, c.carro.y - e.y) < radio + RADIO_CARRO;
}

/** ¿Algún círculo de la caja de choque del carro toca algo de este radio? (lo sólido no deja acercarse al centro) */
function rozando(e: Entidad, c: Conductor, radio: number): boolean {
  return circulosCarro(c.carro).some((p) => Math.hypot(p.x - e.x, p.y - e.y) < radio + PARAMETROS_FISICA.radio + 0.3);
}

/** ¿Dos carros se están tocando? (sus cajas de choque) */
function carrosTocandose(a: EstadoCarro, b: EstadoCarro): boolean {
  const limite = PARAMETROS_FISICA.choque.radio * 2 + 0.3;
  return circulosCarro(a).some((p) => circulosCarro(b).some((q) => Math.hypot(p.x - q.x, p.y - q.y) < limite));
}

function soltarDetras(m: MundoItems, quien: Conductor, indice: number, item: Item, distancia: number): void {
  const p = frente(quien.carro, -distancia);
  m.soltar({
    item: indice,
    dueno: quien.id,
    x: p.x,
    y: p.y,
    angulo: quien.carro.angulo,
    vx: 0,
    vy: 0,
    // Lo que persiste se queda hasta que termine la partida
    vida: item.persiste ? Infinity : ticks(m, item.vida ?? 10),
    objetivo: null,
  });
}

/**
 * Etapa que LE TOCA a algo que se acaba con las vueltas (`tapar`): 0 recién tirado, 1 la
 * intermedia (señalización, charco más chico), 2 la final (tablas, charco seco). Las vueltas son
 * las que da el que va adelante desde que salió.
 * Cada etapa toca a MEDIA vuelta (con `tapar` = 2: la 1 a media vuelta, la 2 a vuelta y media):
 * a esa altura el líder está del otro lado del circuito y nadie lo ve, así que ya cambió cuando
 * vuelven a pasar. A la vuelta exacta el líder está encima: el cambio esperaría a que lo dejen
 * atrás y se vería hasta la pasada siguiente, una vuelta tarde.
 * La que se ve y cuenta (`e.etapa`) la alcanza cuando nadie la está viendo (Sala.taparBaches).
 */
export function etapaDebida(m: MundoItems, e: Entidad, item: Item): number {
  if (!item.tapar) return 0;
  const vueltas = (m.avance() - e.nacio) / m.pista.longitud;
  if (vueltas >= item.tapar - 0.5) return 2;
  return vueltas >= item.tapar - 1.5 ? 1 : 0;
}

/**
 * ¿Un carro (con algo de velocidad) atropelló a esta persona? Si sí, al carro le queda `fuerza`
 * de su velocidad y se avisa para que el navegador la haga volar.
 */
function atropellada(m: MundoItems, e: Entidad, item: Item): boolean {
  for (const c of m.conductores()) {
    if (rapidez(c.carro) < 2) continue;
    const alcance = (item.radio ?? 0.5) + PARAMETROS_FISICA.radio;
    if (!circulosCarro(c.carro).some((p) => Math.hypot(p.x - e.x, p.y - e.y) < alcance)) continue;
    m.golpear(c, e.item, { frenar: item.fuerza ?? 0.82 }, true);
    m.avisar({ tipo: "atropello", id: e.id, quien: c.id, x: e.x, y: e.y, vx: c.carro.vx, vy: c.carro.vy });
    return true;
  }
  return false;
}

/**
 * Un paso de alguien en pánico por el camino: corre hacia un punto al azar de la pista (del
 * otro lado y a lo más `largo` m antes o después) y, al llegar, escoge otro. No se mete al
 * barranco ni al agua.
 */
function correrPorElCamino(m: MundoItems, e: Entidad, velocidad: number, largo: number, centro = proyectar(m.pista, e.x, e.y).s): void {
  if (!e.destino || Math.hypot(e.destino.x - e.x, e.destino.y - e.y) < 0.6) {
    const s = centro + (m.azar() * 2 - 1) * largo;
    const lado = lateralEnPista(m.pista, e.x, e.y) >= 0 ? -1 : 1;
    const p = puntoEnPista(m.pista, s, lado * m.azar() * m.pista.mitad * 0.85);
    e.destino = { x: p.x, y: p.y };
  }
  const dx = e.destino.x - e.x;
  const dy = e.destino.y - e.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = e.x + (dx / d) * (velocidad / m.tickHz);
  const ny = e.y + (dy / d) * (velocidad / m.tickHz);
  if (!enBarranco(m.pista, nx, ny) && !enAgua(m.pista, nx, ny)) {
    e.x = nx;
    e.y = ny;
  }
  e.angulo = Math.atan2(dy, dx);
}

function seguirVivo(m: MundoItems, e: Entidad): boolean {
  e.edad++;
  return --e.vida > 0;
}

/** ¿Esta entidad es sólida, como un poste? (el estorbo, el cactus ya crecido, la aplanadora) */
export function esEstorbo(item: Item | undefined, etapa: number): boolean {
  if (!item) return false;
  return item.mecanica === "estorbo" || (item.mecanica === "crece" && etapa >= 1) || (item.mecanica === "cruce" && !!item.solido);
}

/** El rival más cercano que va adelante de `quien` (o null): al que persiguen el burro, el escorpión y el imán */
function rivalAdelante(m: MundoItems, quien: Conductor, maximo = Infinity): Conductor | null {
  const mio = m.recorrido(quien.id);
  let mejor: Conductor | null = null;
  let menor = maximo;
  for (const c of m.conductores()) {
    const delante = m.recorrido(c.id) - mio;
    if (c.id !== quien.id && delante > 0 && delante < menor) {
      menor = delante;
      mejor = c;
    }
  }
  return mejor;
}

/** Un punto de la pista `metros` adelante del carro, al mismo lado del camino */
function adelanteEnPista(m: MundoItems, c: EstadoCarro, metros: number, lateral = lateralEnPista(m.pista, c.x, c.y)) {
  return puntoEnPista(m.pista, proyectar(m.pista, c.x, c.y, c.indice).s + metros, lateral);
}

/** Lado por el que el carro pasa sobre algo: +1 si lo trae a su izquierda, -1 a su derecha */
function ladoDe(c: Conductor, e: Entidad): number {
  const dx = e.x - c.carro.x;
  const dy = e.y - c.carro.y;
  return Math.cos(c.carro.angulo) * dy - Math.sin(c.carro.angulo) * dx > 0 ? -1 : 1;
}

function mover(m: MundoItems, e: Entidad): void {
  e.x += e.vx / m.tickHz;
  e.y += e.vy / m.tickHz;
}

/* ------------------------------ Mecánicas ------------------------------ */

export const MECANICAS: Record<Item["mecanica"], Mecanica> = {
  /**
   * Burro percherón: persigue al rival más cercano que vaya adelante. Sale lejos y más rápido que
   * quien lo tira (si no, un carro a toda velocidad lo alcanza y se lo come), y a su dueño no le
   * pega durante `inmunidad` segundos; después sí, si le regresa.
   */
  misil: {
    usar(m, quien, indice, item) {
      const mio = m.recorrido(quien.id);
      let objetivo: string | null = null;
      let menor = Infinity;
      for (const c of m.conductores()) {
        const delante = m.recorrido(c.id) - mio;
        if (c.id !== quien.id && delante > 0 && delante < menor) {
          menor = delante;
          objetivo = c.id;
        }
      }
      const p = frente(quien.carro, SALIDA_MISIL);
      const propia = quien.carro.vx * Math.cos(quien.carro.angulo) + quien.carro.vy * Math.sin(quien.carro.angulo);
      const v = Math.max(item.velocidad ?? 40, propia + VENTAJA_MISIL);
      m.soltar({
        item: indice,
        dueno: quien.id,
        x: p.x,
        y: p.y,
        angulo: quien.carro.angulo,
        vx: Math.cos(quien.carro.angulo) * v,
        vy: Math.sin(quien.carro.angulo) * v,
        vida: ticks(m, item.vida ?? 6),
        objetivo,
      });
    },
    actualizar(m, e, item) {
      const conductores = m.conductores();
      const objetivo = conductores.find((c) => c.id === e.objetivo);
      if (objetivo) {
        // Dobla hacia el objetivo, con un límite de giro por tick: se le puede sacar la vuelta
        let d = Math.atan2(objetivo.carro.y - e.y, objetivo.carro.x - e.x) - e.angulo;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const maximo = (item.giro ?? 3) / m.tickHz;
        e.angulo += Math.max(-maximo, Math.min(maximo, d));
      }
      // Conserva la velocidad con la que salió
      const v = Math.hypot(e.vx, e.vy) || item.velocidad || 40;
      e.vx = Math.cos(e.angulo) * v;
      e.vy = Math.sin(e.angulo) * v;
      mover(m, e);
      for (const c of conductores) {
        if (inmune(e, c, m, item.inmunidad ?? 0.6) || !tocando(e, c, item.radio ?? 1.8)) continue;
        const f = item.fuerza ?? 10;
        m.golpear(c, e.item, { aturdido: item.duracion, empujon: [Math.cos(e.angulo) * f, Math.sin(e.angulo) * f] });
        return false;
      }
      return seguirVivo(m, e);
    },
  },

  /**
   * Bache: el primero que cae pierde el control un momento y frena. Si el bache persiste, se
   * queda, y a los que caigan después solo los desvía (`desvio` grados, hacia el lado del bache).
   * Con `tapar`, a las tantas vueltas lo tapan con tablas y ya no hace nada.
   */
  mina: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 3.5);
    },
    actualizar(m, e, item) {
      // Tapado con tablas: ya es asfalto
      if (e.etapa === 2) return seguirVivo(m, e);
      for (const c of m.conductores()) {
        const dentro = !inmune(e, c, m, 1) && tocando(e, c, item.radio ?? 2);
        // Una vez por pasada: mientras sigue encima no le vuelve a hacer nada
        if (!dentro) {
          e.tocados.delete(c.id);
          continue;
        }
        if (e.tocados.has(c.id)) continue;
        e.tocados.add(c.id);
        if (e.golpes === 0 || !item.persiste) {
          m.golpear(c, e.item, { aturdido: item.duracion, frenar: item.fuerza });
        } else {
          m.golpear(c, e.item, { desvio: ((item.desvio ?? 28) * Math.PI) / 180 * ladoDe(c, e) });
        }
        e.golpes++;
        if (!item.persiste) return false;
      }
      return seguirVivo(m, e);
    },
  },

  /**
   * Charco de la tromba: mientras lo pisas (y un rato después) no hay agarre. Con `tapar`, se va
   * secando: en la etapa 1 queda más chico (`encoge`) y en la 2 desaparece
   */
  mancha: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 5);
    },
    actualizar(m, e, item) {
      if (e.etapa >= 2) return false;
      const radio = (item.radio ?? 5) * (e.etapa === 1 ? (item.encoge ?? 0.5) : 1);
      for (const c of m.conductores()) {
        const dentro = !inmune(e, c, m, 1.5) && tocando(e, c, radio - RADIO_CARRO);
        if (dentro) m.golpear(c, e.item, { resbalon: item.duracion }, e.tocados.has(c.id));
        if (dentro) e.tocados.add(c.id);
        else e.tocados.delete(c.id);
      }
      return seguirVivo(m, e);
    },
  },

  /** Ola de calor: cono instantáneo hacia adelante que frena y sacude */
  cono: {
    usar(m, quien, indice, item) {
      const alcance = item.alcance ?? 22;
      const mitad = (((item.angulo ?? 50) / 2) * Math.PI) / 180;
      for (const c of m.conductores()) {
        if (c.id === quien.id) continue;
        const dx = c.carro.x - quien.carro.x;
        const dy = c.carro.y - quien.carro.y;
        let d = Math.atan2(dy, dx) - quien.carro.angulo;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        if (Math.hypot(dx, dy) > alcance || Math.abs(d) > mitad) continue;
        m.golpear(c, indice, { lento: item.duracion, sacudida: (d >= 0 ? 1 : -1) * (item.fuerza ?? 3) });
      }
      // La onda que se ve: va pegada al carro medio segundo
      soltarDetras(m, quien, indice, item, 0);
    },
    actualizar(m, e) {
      const dueno = m.conductores().find((c) => c.id === e.dueno);
      if (dueno) {
        e.x = dueno.carro.x;
        e.y = dueno.carro.y;
        e.angulo = dueno.carro.angulo;
      }
      return seguirVivo(m, e);
    },
  },

  /** Humo de carne asada: no cambia la física, tapa la vista de los de atrás */
  nube: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 6);
    },
    actualizar: seguirVivo,
  },

  /** Tope: atravesado en la pista; quien lo cruza frena en seco (una vez) */
  obstaculo: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 4);
    },
    actualizar(m, e, item) {
      const largo = item.radio ?? 6;
      // El tope es un segmento perpendicular a la dirección en que se soltó
      const px = -Math.sin(e.angulo);
      const py = Math.cos(e.angulo);
      for (const c of m.conductores()) {
        if (e.tocados.has(c.id) || inmune(e, c, m, 1)) continue;
        const dx = c.carro.x - e.x;
        const dy = c.carro.y - e.y;
        const t = Math.max(-largo, Math.min(largo, dx * px + dy * py));
        if (Math.hypot(dx - px * t, dy - py * t) > RADIO_CARRO + 0.4) continue;
        e.tocados.add(c.id);
        m.golpear(c, e.item, { frenar: item.fuerza });
      }
      return seguirVivo(m, e);
    },
  },

  /** Coyotas: abanico de proyectiles cortos que empujan */
  abanico: {
    usar(m, quien, indice, item) {
      const n = Math.max(1, item.cantidad ?? 5);
      const apertura = ((item.angulo ?? 50) * Math.PI) / 180;
      const p = frente(quien.carro, 2.6);
      for (let i = 0; i < n; i++) {
        const a = quien.carro.angulo + (n > 1 ? (i / (n - 1) - 0.5) * apertura : 0);
        const v = item.velocidad ?? 36;
        m.soltar({
          item: indice,
          dueno: quien.id,
          x: p.x,
          y: p.y,
          angulo: a,
          vx: Math.cos(a) * v + quien.carro.vx,
          vy: Math.sin(a) * v + quien.carro.vy,
          vida: ticks(m, item.vida ?? 0.7),
          objetivo: null,
        });
      }
    },
    actualizar(m, e, item) {
      mover(m, e);
      e.angulo += 12 / m.tickHz; // giran como platillo
      for (const c of m.conductores()) {
        if (c.id === e.dueno || !tocando(e, c, item.radio ?? 1.4)) continue;
        const v = Math.hypot(e.vx, e.vy) || 1;
        const f = item.fuerza ?? 14;
        m.golpear(c, e.item, { aturdido: item.duracion, empujon: [(e.vx / v) * f, (e.vy / v) * f] });
        return false;
      }
      return seguirVivo(m, e);
    },
  },

  /** El camión urbano: turbo propio; mientras dura, avienta a quien esté enfrente */
  turbo: {
    usar(m, quien, indice, item) {
      m.golpear(quien, indice, { turbo: item.duracion }, true);
    },
    mientras(m, quien, indice, item) {
      const alcance = item.radio ?? 4.5;
      for (const c of m.conductores()) {
        // Ya aturdido = ya lo aventó hace un momento: no se acumulan empujones
        if (c.id === quien.id || c.carro.aturdido > 0) continue;
        const dx = c.carro.x - quien.carro.x;
        const dy = c.carro.y - quien.carro.y;
        const adelante = dx * Math.cos(quien.carro.angulo) + dy * Math.sin(quien.carro.angulo);
        if (adelante < 0 || Math.hypot(dx, dy) > alcance) continue;
        const d = Math.hypot(dx, dy) || 1;
        const f = item.fuerza ?? 20;
        m.golpear(c, indice, { empujon: [(dx / d) * f, (dy / d) * f], aturdido: 0.3 });
      }
    },
  },

  /**
   * Estorbo (poste de luz, asador): algo sólido que se queda en el piso. El choque contra él no
   * es de aquí: la Sala lo resuelve en cada paso de cada carro (colisionFija), igual que la
   * predicción del navegador, para que pegarle a un poste no produzca correcciones.
   */
  estorbo: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 4.5);
    },
    // Con `tapar` se va en su última etapa (el asador, cuando se acaba la fiesta)
    actualizar(m, e, item) {
      if (item.tapar && e.etapa >= 2) return false;
      return seguirVivo(m, e);
    },
  },

  /**
   * Persona de la carne asada (llega con el asador, no sale de las cajas). Tranquila, está en su
   * lugar junto al asador. Si viene un carro rápido a menos de `alcance` m, entra en pánico y
   * corre de un lado a otro POR EL CAMINO: a un punto al azar de la pista cerca del asador y, al
   * llegar, a otro. No es lo lógico, pero estorba y eso hace el juego más movido. Si un carro la
   * alcanza, sale volando (eso lo dibuja el navegador) y al carro le queda `fuerza` de su
   * velocidad. Se va cuando se va su asador.
   */
  persona: {
    usar() {
      // Nadie la trae: llega con el asador
    },
    actualizar(m, e, item) {
      const casa = e.casa;
      if (!casa || !m.existe(casa.asador)) return false;
      const conductores = m.conductores();
      if (atropellada(m, e, item)) return false;

      // ¿Viene alguien?
      let amenaza: Conductor | null = null;
      let menor = item.alcance ?? 18;
      for (const c of conductores) {
        const d = Math.hypot(c.carro.x - e.x, c.carro.y - e.y);
        if (d < menor && rapidez(c.carro) > 4) {
          menor = d;
          amenaza = c;
        }
      }

      let dx = 0;
      let dy = 0;
      let v = 0;
      if (amenaza) {
        if (e.etapa === 0) {
          m.avisar({ tipo: "susto", x: e.x, y: e.y });
          e.destino = null;
        }
        e.etapa = 1;
        // Al llegar (o al empezar) escoge otro punto del camino, del otro lado si puede
        if (!e.destino || Math.hypot(e.destino.x - e.x, e.destino.y - e.y) < 0.6) {
          const s = proyectar(m.pista, casa.x, casa.y).s + (m.azar() * 2 - 1) * PANICO_LARGO;
          const lado = lateralEnPista(m.pista, e.x, e.y) >= 0 ? -1 : 1;
          const p = puntoEnPista(m.pista, s, lado * m.azar() * m.pista.mitad * 0.85);
          e.destino = { x: p.x, y: p.y };
        }
        dx = e.destino.x - e.x;
        dy = e.destino.y - e.y;
        v = item.velocidad ?? 6;
      } else {
        e.etapa = 0;
        e.destino = null;
        // De regreso a su lugar, caminando
        dx = casa.x - e.x;
        dy = casa.y - e.y;
        v = Math.hypot(dx, dy) > 0.3 ? 1.6 : 0;
      }
      const largo = Math.hypot(dx, dy);
      if (v > 0 && largo > 0) {
        const nx = e.x + (dx / largo) * (v / m.tickHz);
        const ny = e.y + (dy / largo) * (v / m.tickHz);
        // Ni al barranco, ni al agua, ni muy lejos del asador
        const libre =
          !enBarranco(m.pista, nx, ny) && !enAgua(m.pista, nx, ny) && Math.hypot(nx - casa.x, ny - casa.y) < LEJOS_DE_CASA;
        if (libre) {
          e.x = nx;
          e.y = ny;
        }
        e.angulo = Math.atan2(dy, dx);
      } else {
        e.angulo = casa.mira;
      }
      return seguirVivo(m, e);
    },
  },

  /**
   * Personaje de la calle (mazapanes, limpiavidrios…): la Sala lo pone de vez en cuando en medio
   * del camino, adelante y donde nadie lo ve. Ahí se queda, volteando a ver al carro que viene y
   * gritándole (las frases las dibuja el navegador). Atropellarlo frena como a la gente de la
   * carne asada. Al acabarse su `vida` se va, pero solo cuando nadie lo ve.
   */
  calle: {
    usar() {
      // Nadie lo trae: lo pone la Sala
    },
    actualizar(m, e, item) {
      if (atropellada(m, e, item)) return false;
      let menor = Infinity;
      let rapido = false;
      for (const c of m.conductores()) {
        const d = Math.hypot(c.carro.x - e.x, c.carro.y - e.y);
        if (d < menor) {
          menor = d;
          rapido = rapidez(c.carro) > 4;
          e.angulo = Math.atan2(c.carro.y - e.y, c.carro.x - e.x);
        }
      }
      // 1: un carro viene rápido y cerca: corre de un lado a otro del camino (estorba, como la
      // gente de la carne asada). Si no, se queda parado gritándole al que viene
      if (menor < (item.alcance ?? 25) && rapido) {
        e.etapa = 1;
        correrPorElCamino(m, e, item.velocidad ?? 5.5, 6);
      } else {
        e.etapa = 0;
        e.destino = null;
      }
      e.edad++;
      e.vida = Math.max(0, e.vida - 1);
      return e.vida > 0 || m.seVe(e.x, e.y);
    },
  },

  /**
   * Meteorito: no sale de las cajas, lo tiran los espectadores (Sala.lanzarMeteorito). Mientras
   * cae es una marca en el piso; al llegar, aplasta lo que esté debajo. Lo que deja (`deja`, un
   * bache) lo suelta la Sala, como el asador del humo.
   */
  meteorito: {
    usar() {
      // Nadie lo trae: no sale de las cajas
    },
    actualizar(m, e, item) {
      if (seguirVivo(m, e)) return true;
      m.aplastar(e.x, e.y, item.radio ?? 3);
      return false;
    },
  },

  /* ------------------------------ Copa Desierto ------------------------------ */

  /**
   * Rodadora: rueda por el camino siguiendo la pista (no en línea recta) y va creciendo. Al primero
   * que alcanza lo enreda (la dirección responde poco) y lo frena un poco; ahí se deshace.
   */
  rodante: {
    usar(m, quien, indice, item) {
      const p = adelanteEnPista(m, quien.carro, 7);
      m.soltar({ item: indice, dueno: quien.id, x: p.x, y: p.y, angulo: p.angulo, vx: 0, vy: 0, vida: ticks(m, item.vida ?? 7), objetivo: null });
    },
    actualizar(m, e, item) {
      // Sigue la pista a su velocidad, con un leve zigzag (va rebotando)
      const proy = proyectar(m.pista, e.x, e.y);
      const lateral = lateralEnPista(m.pista, e.x, e.y) * 0.98 + Math.sin(e.edad / 9) * 0.06;
      const p = puntoEnPista(m.pista, proy.s + (item.velocidad ?? 30) / m.tickHz, lateral);
      e.angulo = p.angulo;
      e.x = p.x;
      e.y = p.y;
      // Crece: del radio base al doble al final de su vida
      const radio = (item.radio ?? 1.4) * (1 + e.edad / Math.max(1, e.vidaMax));
      for (const c of m.conductores()) {
        if (inmune(e, c, m, item.inmunidad ?? 1) || !tocando(e, c, radio)) continue;
        m.golpear(c, e.item, { enredado: item.duracion, frenar: item.fuerza ?? 0.75 });
        return false;
      }
      return seguirVivo(m, e);
    },
  },

  /**
   * Escorpión: se le pega al rival de adelante y a los `vida` s lo pica (lo frena en seco y lo
   * aturde). Mientras, quien lo trae se lo puede pasar a otro carro chocándolo; no regresa al que
   * se lo acaba de pasar hasta medio segundo después.
   */
  pegajoso: {
    usar(m, quien, indice, item) {
      const objetivo = rivalAdelante(m, quien) ?? m.conductores().find((c) => c.id !== quien.id);
      if (!objetivo) return;
      m.soltar({
        item: indice,
        dueno: quien.id,
        x: objetivo.carro.x,
        y: objetivo.carro.y,
        angulo: objetivo.carro.angulo,
        vx: 0,
        vy: 0,
        vida: ticks(m, item.vida ?? 3.5),
        objetivo: objetivo.id,
      });
    },
    actualizar(m, e, item) {
      const conductores = m.conductores();
      const lleva = conductores.find((c) => c.id === e.objetivo);
      // El que lo traía explotó: se va con él
      if (!lleva) return false;
      // ¿Chocó con alguien? Se le pasa (no de regreso luego luego)
      if (e.edad - (e.pase ?? -Infinity) > ticks(m, 0.5)) {
        for (const c of conductores) {
          if (c.id === lleva.id || !carrosTocandose(c.carro, lleva.carro)) continue;
          m.avisar({ tipo: "pasado", de: lleva.id, a: c.id, x: c.carro.x, y: c.carro.y });
          e.objetivo = c.id;
          e.pase = e.edad;
          e.tocados = new Set([lleva.id]);
          break;
        }
      }
      const ahora = conductores.find((c) => c.id === e.objetivo)!;
      e.x = ahora.carro.x;
      e.y = ahora.carro.y;
      e.angulo = ahora.carro.angulo;
      if (seguirVivo(m, e)) return true;
      // Se acabó el tiempo: ¡pica!
      m.golpear(ahora, e.item, { aturdido: item.duracion ?? 1, frenar: item.fuerza ?? 0.15 });
      return false;
    },
  },

  /**
   * Cactus: lo plantas detrás y en `crecer` s ya es sólido (los carros chocan con él, como con un
   * poste; eso lo hace la Sala). El que lo toca ya crecido queda ponchado
   */
  crece: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 4.5);
    },
    actualizar(m, e, item) {
      if (e.etapa === 0 && e.edad >= ticks(m, item.alcance ?? 1)) e.etapa = 1;
      if (e.etapa === 1) {
        for (const c of m.conductores()) {
          const cerca = rozando(e, c, item.radio ?? 0.9);
          if (cerca && !e.tocados.has(c.id)) m.golpear(c, e.item, { ponchado: item.duracion });
          if (cerca) e.tocados.add(c.id);
          else e.tocados.delete(c.id);
        }
      }
      return seguirVivo(m, e);
    },
  },

  /**
   * Tormenta de arena: a todos los demás carros que se ven, un viento de lado durante `duracion`
   * s (los arrastra a `fuerza` m/s), hacia la orilla del camino que tienen más cerca (para
   * sacarlos); hay que corregir con el volante. La nube que se ve va con quien la soltó
   */
  viento: {
    usar(m, quien, indice, item) {
      const f = item.fuerza ?? 10;
      for (const c of m.conductores()) {
        if (c.id === quien.id || !m.seVe(c.carro.x, c.carro.y)) continue;
        const p = puntoEnPista(m.pista, proyectar(m.pista, c.carro.x, c.carro.y, c.carro.indice).s);
        // Hacia afuera: del lado en que ya va (la normal de la pista)
        const lado = lateralEnPista(m.pista, c.carro.x, c.carro.y) >= 0 ? 1 : -1;
        const nx = -Math.sin(p.angulo) * lado;
        const ny = Math.cos(p.angulo) * lado;
        m.golpear(c, indice, { viento: { x: nx * f, y: ny * f, segundos: item.duracion ?? 3 } });
      }
      soltarDetras(m, quien, indice, { ...item, vida: item.duracion ?? 3 }, 0);
    },
    actualizar(m, e) {
      const dueno = m.conductores().find((c) => c.id === e.dueno);
      if (dueno) {
        e.x = dueno.carro.x;
        e.y = dueno.carro.y;
      }
      return seguirVivo(m, e);
    },
  },

  /**
   * Espejismo: una caja de items falsa, `alcance` m adelante en la pista, igual a las de verdad
   * (`etapa`: el color de caja que imita). El que la agarra queda aturdido y no recibe nada
   */
  senuelo: {
    usar(m, quien, indice, item) {
      const p = adelanteEnPista(m, quien.carro, item.alcance ?? 30);
      m.soltar({ item: indice, dueno: quien.id, x: p.x, y: p.y, angulo: 0, vx: 0, vy: 0, vida: ticks(m, item.vida ?? 25), objetivo: null });
    },
    actualizar(m, e, item) {
      if (e.edad === 0) e.etapa = Math.floor(m.azar() * 3);
      for (const c of m.conductores()) {
        if (inmune(e, c, m, 1) || !tocando(e, c, item.radio ?? 2)) continue;
        m.golpear(c, e.item, { aturdido: item.duracion ?? 1.2, frenar: item.fuerza ?? 0.6 });
        return false;
      }
      return seguirVivo(m, e);
    },
  },

  /** Agua fresca: te quita todo lo malo que traigas y por `duracion` s los golpes te rebotan */
  escudo: {
    usar(m, quien, indice, item) {
      m.golpear(quien, indice, { limpiar: true, escudo: item.duracion ?? 3 }, true);
    },
  },

  /* ---------------------------- Copa Construcción ---------------------------- */

  /**
   * Imán de grúa: durante `duracion` s engancha al rival de adelante (a menos de `alcance` m): a
   * él lo frena y lo jala hacia ti, y a ti te jala hacia él. El imán que se ve va contigo
   */
  iman: {
    usar(m, quien, indice, item) {
      const objetivo = rivalAdelante(m, quien, item.alcance ?? 70);
      m.soltar({
        item: indice,
        dueno: quien.id,
        x: quien.carro.x,
        y: quien.carro.y,
        angulo: quien.carro.angulo,
        vx: 0,
        vy: 0,
        vida: ticks(m, item.duracion ?? 3),
        objetivo: objetivo?.id ?? null,
      });
    },
    actualizar(m, e, item) {
      const conductores = m.conductores();
      const dueno = conductores.find((c) => c.id === e.dueno);
      if (!dueno) return false;
      const objetivo = conductores.find((c) => c.id === e.objetivo);
      e.x = dueno.carro.x;
      e.y = dueno.carro.y;
      if (objetivo) {
        const dx = objetivo.carro.x - dueno.carro.x;
        const dy = objetivo.carro.y - dueno.carro.y;
        const d = Math.hypot(dx, dy) || 1;
        e.angulo = Math.atan2(dy, dx);
        const f = (item.fuerza ?? 9) / m.tickHz;
        m.golpear(objetivo, e.item, { frenar: 0.985, empujon: [(-dx / d) * f, (-dy / d) * f] }, true);
        m.golpear(dueno, e.item, { empujon: [(dx / d) * f * 0.6, (dy / d) * f * 0.6] }, true);
      }
      return seguirVivo(m, e);
    },
  },

  /** Bolsa de clavos: de lado a lado del camino, detrás de ti. Al que pase lo poncha (una vez) */
  alfombra: {
    usar(m, quien, indice, item) {
      const p = adelanteEnPista(m, quien.carro, -6, 0);
      // El ángulo de la entidad va a lo ancho del camino
      m.soltar({ item: indice, dueno: quien.id, x: p.x, y: p.y, angulo: p.angulo + Math.PI / 2, vx: 0, vy: 0, vida: ticks(m, item.vida ?? 9), objetivo: null });
    },
    actualizar(m, e, item) {
      const ax = Math.cos(e.angulo);
      const ay = Math.sin(e.angulo);
      for (const c of m.conductores()) {
        if (e.tocados.has(c.id) || inmune(e, c, m, 1)) continue;
        const dx = c.carro.x - e.x;
        const dy = c.carro.y - e.y;
        const a_lo_ancho = dx * ax + dy * ay;
        const a_lo_largo = Math.abs(dx * -ay + dy * ax);
        if (Math.abs(a_lo_ancho) > m.pista.mitad + 1 || a_lo_largo > (item.radio ?? 1.2) + RADIO_CARRO) continue;
        e.tocados.add(c.id);
        m.golpear(c, e.item, { ponchado: item.duracion });
      }
      return seguirVivo(m, e);
    },
  },

  /**
   * Cemento fresco: una mancha gris detrás de ti. Mientras estás adentro se te va pegando (cada
   * vez más lento); si se te llena, te atoras un momento
   */
  fragua: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 6);
    },
    actualizar(m, e, item) {
      const lleno = PARAMETROS_FISICA.efectos.cementoLleno;
      for (const c of m.conductores()) {
        if (inmune(e, c, m, 1.2) || !tocando(e, c, (item.radio ?? 6) - RADIO_CARRO)) continue;
        // +3 por tick y la física quita 1: se carga de vacío a lleno en ~1 s
        m.golpear(c, e.item, { cemento: 3 }, true);
        if (c.carro.cemento >= lleno && !e.tocados.has(c.id)) {
          e.tocados.add(c.id);
          m.golpear(c, e.item, { frenar: 0.1, lento: item.duracion ?? 1 });
        }
      }
      return seguirVivo(m, e);
    },
  },

  /** Martillo neumático: una sacudida alrededor de ti que avienta de lado a los carros cercanos */
  onda: {
    usar(m, quien, indice, item) {
      const rx = -Math.sin(quien.carro.angulo);
      const ry = Math.cos(quien.carro.angulo);
      const f = item.fuerza ?? 17;
      for (const c of m.conductores()) {
        if (c.id === quien.id) continue;
        const dx = c.carro.x - quien.carro.x;
        const dy = c.carro.y - quien.carro.y;
        if (Math.hypot(dx, dy) > (item.radio ?? 9)) continue;
        // De lado: hacia el lado en que está respecto a ti
        const lado = dx * rx + dy * ry >= 0 ? 1 : -1;
        m.golpear(c, indice, { empujon: [rx * lado * f, ry * lado * f], sacudida: lado * 2.5, aturdido: item.duracion ?? 0.35 });
      }
      soltarDetras(m, quien, indice, { ...item, vida: 0.5 }, 0);
    },
    actualizar(m, e) {
      const dueno = m.conductores().find((c) => c.id === e.dueno);
      if (dueno) {
        e.x = dueno.carro.x;
        e.y = dueno.carro.y;
      }
      return seguirVivo(m, e);
    },
  },

  /**
   * Andamio: cae `alcance` m adelante en la pista a los `crecer` s (antes se ve su sombra) y queda
   * atravesado tapando todo el camino menos un carril. Es sólido (Sala.barreras y la predicción
   * del navegador, con segmentoBarrera). `etapa` 0 cayendo, 1 en el piso
   */
  barrera: {
    usar(m, quien, indice, item) {
      const s = proyectar(m.pista, quien.carro.x, quien.carro.y, quien.carro.indice).s + (item.alcance ?? 35);
      // El carril libre: una orilla al azar; el tubo tapa el resto
      const libre = m.azar() < 0.5 ? 1 : -1;
      const p = puntoEnPista(m.pista, s, -libre * 3.5);
      m.soltar({ item: indice, dueno: quien.id, x: p.x, y: p.y, angulo: p.angulo + Math.PI / 2, vx: 0, vy: 0, vida: ticks(m, item.vida ?? 7), objetivo: null });
    },
    actualizar(m, e, item) {
      if (e.etapa === 0 && e.edad >= ticks(m, item.duracion ?? 1.5)) {
        e.etapa = 1;
        m.avisar({ tipo: "impacto", x: e.x, y: e.y });
      }
      return seguirVivo(m, e);
    },
  },

  /** Casco: por `duracion` s pesas el triple (la física compartida resuelve los choques) */
  pesado: {
    usar(m, quien, indice, item) {
      m.golpear(quien, indice, { pesado: item.duracion ?? 4 }, true);
    },
  },

  /* --------------------------- Peligros del ambiente --------------------------- */

  /**
   * Un peligro que va y viene cruzando el camino (el remolino del desierto, la aplanadora). Lo pone
   * la Sala (pasoAmbiente) según `circuito.ambiente`, que dice dónde y cómo se mueve. Al que toca:
   * `duracion` s aturdido y `fuerza` de su velocidad (aplanadora) o un trompo (remolino, sin
   * `solido`). La aplanadora además es sólida: eso lo resuelve la Sala, como un poste
   */
  cruce: {
    usar() {
      // No sale de cajas
    },
    actualizar(m, e, item) {
      const ruta = e.casa;
      if (!ruta) return false;
      // casa.x / casa.y: las dos orillas (lateral); casa.mira: la velocidad; casa.asador: la pausa (s)
      const meta = e.etapa === 0 ? ruta.y : ruta.x;
      const s = proyectar(m.pista, e.x, e.y).s;
      const lateral = lateralEnPista(m.pista, e.x, e.y);
      const paso = ruta.mira / m.tickHz;
      if (e.golpes > 0) {
        // Esperando en la orilla
        e.golpes--;
      } else if (Math.abs(meta - lateral) <= paso) {
        e.etapa = 1 - e.etapa;
        e.golpes = ticks(m, ruta.asador);
      } else {
        const p = puntoEnPista(m.pista, s, lateral + Math.sign(meta - lateral) * paso);
        e.x = p.x;
        e.y = p.y;
        e.angulo = p.angulo + (Math.sign(meta - lateral) > 0 ? Math.PI / 2 : -Math.PI / 2);
      }
      for (const c of m.conductores()) {
        const cerca = rozando(e, c, item.radio ?? 2.5);
        if (cerca && !e.tocados.has(c.id)) {
          m.golpear(
            c,
            e.item,
            item.solido
              ? { aturdido: item.duracion ?? 1.2, frenar: item.fuerza ?? 0.3 }
              : { sacudida: (item.fuerza ?? 7) * (m.azar() < 0.5 ? -1 : 1), resbalon: item.duracion ?? 0.8 },
          );
        }
        if (cerca) e.tocados.add(c.id);
        else e.tocados.delete(c.id);
      }
      e.edad++;
      return true;
    },
  },
};

/**
 * Un item al azar según su `probabilidad`, de los `permitido` (los de la copa de la pista); con
 * `categoria`, solo de los de esa categoría (el color de la caja). Si esa categoría no tiene
 * ninguno, de todos los permitidos.
 */
export function sacarItem(
  items: Item[],
  azar: () => number = Math.random,
  categoria?: string,
  /** Solo los de la pista (los de su copa) */
  permitido: (i: Item) => boolean = () => true,
): number {
  const peso = (i: Item) => (permitido(i) && (categoria === undefined || i.categoria === categoria) ? i.probabilidad : 0);
  const total = items.reduce((s, i) => s + peso(i), 0);
  if (total <= 0) return categoria === undefined ? items.length - 1 : sacarItem(items, azar, undefined, permitido);
  let r = azar() * total;
  let ultimo = -1;
  for (let i = 0; i < items.length; i++) {
    if (peso(items[i]) <= 0) continue;
    ultimo = i;
    r -= peso(items[i]);
    if (r <= 0) return i;
  }
  return ultimo;
}
