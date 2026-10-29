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
};

/**
 * Un item al azar según su `probabilidad`; con `categoria`, solo de los de esa categoría (el
 * color de la caja). Si esa categoría no tiene ninguno, de todos.
 */
export function sacarItem(items: Item[], azar: () => number = Math.random, categoria?: string): number {
  const peso = (i: Item) => (categoria === undefined || i.categoria === categoria ? i.probabilidad : 0);
  const total = items.reduce((s, i) => s + peso(i), 0);
  if (total <= 0) return categoria === undefined ? items.length - 1 : sacarItem(items, azar);
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
