import type { EstadoCarro, Item } from "../compartido/tipos";
import type { Pista } from "../compartido/pista";

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
  /** Carros a los que ya les pegó (tope) o que están adentro (charco) */
  tocados: Set<string>;
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
  soltar(e: Omit<Entidad, "id" | "edad" | "tocados" | "vidaMax">): void;
  /** Aplica un efecto; `silencioso` no avisa a los clientes (efectos que se renuevan cada tick) */
  golpear(victima: Conductor, item: number, efecto: Efecto, silencioso?: boolean): void;
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
    vida: ticks(m, item.vida ?? 10),
    objetivo: null,
  });
}

function seguirVivo(m: MundoItems, e: Entidad): boolean {
  e.edad++;
  return --e.vida > 0;
}

function mover(m: MundoItems, e: Entidad): void {
  e.x += e.vx / m.tickHz;
  e.y += e.vy / m.tickHz;
}

/* ------------------------------ Mecánicas ------------------------------ */

export const MECANICAS: Record<Item["mecanica"], Mecanica> = {
  /** Burro percherón: persigue al rival más cercano que vaya adelante */
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
      const p = frente(quien.carro, 3);
      const v = item.velocidad ?? 40;
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
      const v = item.velocidad ?? 40;
      e.vx = Math.cos(e.angulo) * v;
      e.vy = Math.sin(e.angulo) * v;
      mover(m, e);
      for (const c of conductores) {
        if (inmune(e, c, m, 0.6) || !tocando(e, c, item.radio ?? 1.8)) continue;
        const f = item.fuerza ?? 10;
        m.golpear(c, e.item, { aturdido: item.duracion, empujon: [Math.cos(e.angulo) * f, Math.sin(e.angulo) * f] });
        return false;
      }
      return seguirVivo(m, e);
    },
  },

  /** Bache: se queda en la pista; quien cae pierde el control un momento y frena */
  mina: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 3.5);
    },
    actualizar(m, e, item) {
      for (const c of m.conductores()) {
        if (inmune(e, c, m, 1) || !tocando(e, c, item.radio ?? 2)) continue;
        m.golpear(c, e.item, { aturdido: item.duracion, frenar: item.fuerza });
        return false;
      }
      return seguirVivo(m, e);
    },
  },

  /** Charco de la tromba: mientras lo pisas (y un rato después) no hay agarre */
  mancha: {
    usar(m, quien, indice, item) {
      soltarDetras(m, quien, indice, item, 5);
    },
    actualizar(m, e, item) {
      for (const c of m.conductores()) {
        const dentro = !inmune(e, c, m, 1.5) && tocando(e, c, (item.radio ?? 5) - RADIO_CARRO);
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
};

/** Un item al azar según su `probabilidad` */
export function sacarItem(items: Item[], azar: () => number = Math.random): number {
  const total = items.reduce((s, i) => s + i.probabilidad, 0);
  let r = azar() * total;
  for (let i = 0; i < items.length; i++) {
    r -= items[i].probabilidad;
    if (r <= 0) return i;
  }
  return items.length - 1;
}
