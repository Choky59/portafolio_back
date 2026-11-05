import { puntoEnPista, puntosMuro, type Pista } from "./pista";
import { esEstructuraObra, montonesObra, planoObra, rngObra } from "./obra";

/** Same deterministic props on the authoritative server and the predicted client. */
export interface ObjetoEscenario {
  id: string; tipo: string; x: number; y: number; angulo: number; radio: number;
  ancho?: number; fondo?: number; base: number; alto: number;
  /** Zero = anchored; light props receive impulses and can fall over. */
  masa: number;
}
export interface CuerpoEscenario {
  id: string; x: number; y: number; angulo: number; vx: number; vy: number; w: number; tumbado: boolean;
}
export type ObjetoRed = [string, number, number, number, number, number, number, boolean];
export interface ImpactoEscenario { objeto: string; x: number; y: number; fuerza: number }
export interface Escenario {
  objetos: ObjetoEscenario[];
  fijos: Map<string, ObjetoEscenario[]>;
  moviles: Map<string, CuerpoEscenario>;
  definiciones: Map<string, ObjetoEscenario>;
  celdasMoviles: Map<string, Set<string>>;
  ordenMoviles: Map<string, number>;
  radioMovilMax: number;
}
const CELDA = 16;

/** Position setters keep the index valid for physics, reconciliation and direct state restores. */
class MovilesIndexados extends Map<string, CuerpoEscenario> {
  private siguiente = 0;
  private quitarIndice = new Map<string, () => void>();
  constructor(private readonly escenario: Escenario) { super(); }
  set(id: string, cuerpo: CuerpoEscenario): this {
    this.quitarIndice.get(id)?.();
    if (!this.has(id)) this.escenario.ordenMoviles.set(id, this.siguiente++);
    let x = cuerpo.x, y = cuerpo.y, celda = "", vigente = true, ix = NaN, iy = NaN;
    const reubicar = () => {
      if (!vigente) return;
      const nx = Math.floor(x / CELDA), ny = Math.floor(y / CELDA);
      if (nx === ix && ny === iy) return;
      ix = nx; iy = ny;
      const siguiente = `${ix},${iy}`;
      this.escenario.celdasMoviles.get(celda)?.delete(id);
      if (this.escenario.celdasMoviles.get(celda)?.size === 0) this.escenario.celdasMoviles.delete(celda);
      celda = siguiente;
      if (!this.escenario.celdasMoviles.has(celda)) this.escenario.celdasMoviles.set(celda, new Set());
      this.escenario.celdasMoviles.get(celda)!.add(id);
    };
    Object.defineProperties(cuerpo, {
      x: { enumerable: true, configurable: true, get: () => x, set: (valor: number) => { x = valor; reubicar(); } },
      y: { enumerable: true, configurable: true, get: () => y, set: (valor: number) => { y = valor; reubicar(); } },
    });
    this.quitarIndice.set(id, () => {
      vigente = false;
      this.escenario.celdasMoviles.get(celda)?.delete(id);
      if (this.escenario.celdasMoviles.get(celda)?.size === 0) this.escenario.celdasMoviles.delete(celda);
    });
    this.escenario.radioMovilMax = Math.max(this.escenario.radioMovilMax, this.escenario.definiciones.get(id)?.radio ?? 0.85);
    super.set(id, cuerpo);
    reubicar();
    return this;
  }
  delete(id: string): boolean {
    this.quitarIndice.get(id)?.();
    this.quitarIndice.delete(id);
    this.escenario.ordenMoviles.delete(id);
    return super.delete(id);
  }
  clear(): void {
    for (const quitar of this.quitarIndice.values()) quitar();
    this.quitarIndice.clear();
    this.escenario.celdasMoviles.clear();
    this.escenario.ordenMoviles.clear();
    this.escenario.radioMovilMax = 0.85;
    this.siguiente = 0;
    super.clear();
  }
}

export function escenarioVacio(): Escenario {
  const e: Escenario = { objetos: [], fijos: new Map(), moviles: new Map(), definiciones: new Map(), celdasMoviles: new Map(), ordenMoviles: new Map(), radioMovilMax: 0.85 };
  e.moviles = new MovilesIndexados(e);
  return e;
}

/** Cached definitions are copied; no mutable state or collider arrays are shared between rooms. */
export function clonarEscenario(base: Escenario): Escenario {
  const e = escenarioVacio();
  const copias = new Map<ObjetoEscenario, ObjetoEscenario>();
  e.objetos = base.objetos.map(o => { const copia = { ...o }; copias.set(o, copia); return copia; });
  for (const o of e.objetos) e.definiciones.set(o.id, o);
  for (const [celda, objetos] of base.fijos) e.fijos.set(celda, objetos.map(o => copias.get(o)!));
  for (const [id, cuerpo] of base.moviles) e.moviles.set(id, { ...cuerpo });
  return e;
}

export function prepararEscenario(pista: Pista): Escenario {
  const e = escenarioVacio();
  if (pista.circuito.terreno !== "obra") return e;
  const plano = planoObra(pista);
  const agregar = (id: string, tipo: string, x: number, y: number, angulo: number, ancho: number, fondo: number, alto: number, masa = 0, base = 0) => {
    e.objetos.push({ id, tipo, x, y, angulo, ancho, fondo, radio: Math.hypot(ancho, fondo) / 2, alto, base, masa });
  };
  const circulo = (id: string, tipo: string, x: number, y: number, radio: number, alto: number, masa = 0, angulo = 0) => {
    e.objetos.push({ id, tipo, x, y, angulo, radio, alto, base: 0, masa });
  };
  const grava = (id: string, x: number, y: number, giro: number, escala: number, random: () => number, cuantos: number, radio = 6) => {
    for (const p of montonesObra(random, cuantos, radio)) circulo(id, "grava", x + (p.x * Math.cos(giro) - p.y * Math.sin(giro)) * escala, y + (p.x * Math.sin(giro) + p.y * Math.cos(giro)) * escala, 3.2 * p.e * escala, 2.1 * p.e * escala);
  };
  const tarimas = (id: string, x: number, y: number, giro: number, random: () => number) => {
    for (const [ox, oy] of [[-1.9, -1.4], [1.9, -1.4], [-1.9, 1.4], [1.9, 1.4]]) {
      if (random() < 0.2) continue;
      const carga = random();
      agregar(id, "tarimas", x + ox * Math.cos(giro) - oy * Math.sin(giro), y + ox * Math.sin(giro) + oy * Math.cos(giro), giro, 3.2, 2.4, carga < 0.4 ? 1.6 : carga < 0.7 ? 1.4 : 0.9);
    }
  };
  const local = (id: string, tipo: string, x: number, y: number, giro: number, escala = 1, semilla = 0) => {
    const random = rngObra(semilla);
    const caja = (ox: number, oy: number, w: number, d: number, h: number, base = 0) => {
      agregar(id, tipo, x + (ox * Math.cos(giro) - oy * Math.sin(giro)) * escala,
        y + (ox * Math.sin(giro) + oy * Math.cos(giro)) * escala, giro, w * escala, d * escala, h * escala, 0, base * escala);
    };
    if (tipo === "excavadora") {
      caja(0, 0, 5.8, 4.35, 3.1);
      caja(0.4, 0.85, 2.35, 1.9, 2, 3.1);
      caja(7.6, -0.6, 1.6, 2, 1.2, 1.2);
    } else if (tipo === "grua" || tipo === "grua-torre") {
      caja(0, 0, 5, 5, 0.9);
      caja(0, 0, 1.9, 1.9, 40);
    } else if (tipo === "tubos") caja(0, 0, 4.5, 4.7, 4.35);
    else if (tipo === "revolvedora" || tipo === "volteo") caja(0, 0, 8, 2.65, 4.2);
    else if (tipo === "caseta") caja(0, 0, 6.1, 2.7, 2.8);
    else if (tipo === "contenedor") caja(0, 0, 6.1, 2.55, random() < 0.35 ? 5.2 : 2.6);
    else if (tipo === "varilla") caja(0, 0, 10.2, 4, 0.65);
    else if (tipo === "marco") {
      const pisos = 2 + Math.floor(random() * 2);
      for (const ox of [-6, 0, 6]) for (const oy of [-4.5, 4.5]) caja(ox, oy, 0.4, 0.4, pisos * 4 + 0.4);
      for (let piso = 1; piso <= pisos; piso++) {
        for (const oy of [-4.5, 4.5]) caja(0, oy, 12, 0.3, 0.3, piso * 4 + 0.05);
        for (const ox of [-6, 0, 6]) caja(ox, 0, 0.3, 9, 0.3, piso * 4 + 0.05);
      }
    } else if (tipo === "columnas") {
      for (const ox of [-5, 0, 5]) for (const oy of [-3.5, 3.5]) {
        const alto = 1.5 + random() * 4.5;
        const madera = random() < 0.25;
        caja(ox, oy, madera ? 1.1 : 0.8, madera ? 1.1 : 0.8, 0.5 + alto + (madera ? 1.8 : 0));
      }
    }
  };
  plano.cerca.forEach((p, i) => agregar(`cerca:${i}`, "cerca", (p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2,
    Math.atan2(p.y2 - p.y1, p.x2 - p.x1), Math.hypot(p.x2 - p.x1, p.y2 - p.y1), 0.16, 2.9));
  plano.barreras.forEach((p, i) => agregar(`barrera:${i}`, "barrera", p.x, p.y, p.angulo, 3, 0.8, 1.05));
  plano.barriles.forEach((p, i) => circulo(`barril:${i}`, "barril", p.x, p.y, 0.6, 1.65, 0.65));
  plano.senales.forEach((p, i) => circulo(`senal:${i}`, "senal", p.x, p.y, 0.3, 3.8, 0.35, p.angulo + Math.PI / 2));
  plano.banderas.forEach((p, i) => circulo(`bandera:${i}`, "trabajador", p.x, p.y, 0.4, 2.5, 0.8, p.angulo + Math.PI / 2));
  plano.personas.forEach((p, i) => circulo(`persona:${i}`, "trabajador", p.x, p.y, 0.4, 1.85, 0.8, -p.angulo));
  plano.tubos.forEach((p, i) => local(`tubos:${i}`, "tubos", p.x, p.y, p.angulo, 0.85));
  plano.bahias.forEach((p, i) => {
    local(`bahia:${i}`, "excavadora", p.x, p.y, p.angulo - (plano.ladoCerca > 0 ? 0 : Math.PI), pista.circuito.id === "excavacion" ? 1.35 : 1.15);
    if (p.material) tarimas(`material:${i}`, p.material.x, p.material.y, p.angulo, rngObra(5000 + i));
  });
  plano.patios.forEach((p, i) => {
    const id = `patio:${i}`;
    const random = rngObra(p.semilla);
    if (p.tipo === "cuadrilla") circulo(id, "carretilla", p.x - Math.sin(p.giro), p.y - Math.cos(p.giro), 0.85, 1, 1.1, -p.giro);
    else if (p.tipo === "grava") grava(id, p.x, p.y, 0, 1, random, 1 + Math.floor(random() * 3), p.radio);
    else if (p.tipo === "tarimas") tarimas(id, p.x, p.y, -p.giro, random);
    else {
      local(id, p.tipo, p.x, p.y, -p.giro, p.tipo === "tubos" ? 0.9 + random() * 0.3 : p.tipo === "excavadora" ? 1.2 : p.tipo === "grua" ? 1.1 : 1, p.semilla);
      if (p.tipo === "tubos") for (let k = 0; k < 2; k++) {
        const ox = -3 + k * 6, oy = 3.6;
        circulo(`patio-barril:${i}:${k}`, "barril", p.x + ox * Math.cos(p.giro) + oy * Math.sin(p.giro), p.y - ox * Math.sin(p.giro) + oy * Math.cos(p.giro), 0.6, 1.65, 0.65);
      }
      if (p.tipo === "excavadora") grava(`${id}:grava`, p.x + 8 * Math.cos(p.giro) - Math.sin(p.giro), p.y - 8 * Math.sin(p.giro) - Math.cos(p.giro), 0, 1, random, 1);
    }
  });
  pista.circuito.decoracion.forEach((p, i) => {
    const id = `decoracion:${i}`;
    const giro = -(p.rotacion ?? rngObra(i + 3)() * Math.PI * 2);
    const escala = p.escala ?? 1;
    if (p.tipo === "cono") circulo(id, "cono", p.x, p.y, 0.35 * escala, escala, 0.15, giro);
    else if (p.tipo === "piedra") {
      const random = rngObra((i + 1) * 7);
      grava(id, p.x, p.y, giro, escala * 0.8, random, 1 + Math.floor(random() * 2), 3);
    }
    else local(id, p.tipo, p.x, p.y, giro, escala);
  });
  // Las piezas puestas a mano (las zonas de Obra Negra). Lo que pasa por encima del camino (el
  // puente, el dosel) solo choca en sus pies; lo que es solo de vista no choca
  (pista.circuito.piezas ?? []).forEach((p, i) => {
    const id = `pieza:${i}`;
    const c = Math.cos(p.angulo);
    const s = Math.sin(p.angulo);
    const caja = (ox: number, oy: number, w: number, d: number, h: number) => agregar(id, p.tipo, p.x + ox * c - oy * s, p.y + ox * s + oy * c, p.angulo, w, d, h);
    if (["torre", "rascacielos", "estacionamiento", "demolicion", "elevador"].includes(p.tipo)) {
      caja(0, 0, p.ancho ?? 10, p.fondo ?? 10, p.alto ?? (p.pisos ?? 6) * 3.6);
    } else if (p.tipo === "puente-via") {
      for (const lado of [-1, 1]) caja(0, (lado * (p.fondo ?? 30)) / 2, 2.2, 2.2, p.alto ?? 8);
    } else if (p.tipo === "columna") caja(0, 0, p.ancho ?? 1.2, p.fondo ?? 1.2, p.alto ?? 8);
    // Grúas: lo cerrado frente a la tubería (no se ve: lo tapan su modelo y sus barreras), los
    // barandales del puente, los pies de los arcos del túnel y sus muros, y la maquinaria
    else if (p.tipo === "bloque" || p.tipo === "barandal" || p.tipo === "muro-tunel") caja(0, 0, p.ancho ?? 4, p.fondo ?? 0.4, p.alto ?? 3);
    else if (p.tipo === "arco-tunel" || p.tipo === "portal") {
      const pie = p.tipo === "portal" ? 2.4 : 1;
      for (const lado of [-1, 1]) caja(0, (lado * (p.fondo ?? 32)) / 2, pie, pie, p.alto ?? 7);
    } else if (["perforadora", "grua-movil", "generador", "bomba"].includes(p.tipo)) caja(0, 0, p.ancho ?? 4, p.fondo ?? 4, p.alto ?? 3);
    else if (p.tipo === "jersey") caja(0, 0, p.ancho ?? 3, 0.8, 1.05);
    else if (p.tipo === "martillo") {
      caja(0, 0, 5.8, 4.35, 3.1);
      caja(5.2, 0, 2.4, 1.4, 1.6);
    } else if (p.tipo === "reflector") circulo(id, "reflector", p.x, p.y, 0.45, 7);
  });
  // Only the feet of the arch collide: cars pass freely underneath the sign.
  const arco = puntoEnPista(pista, 36);
  for (const lado of [-1, 1]) agregar("portico", "portico", arco.x - Math.sin(arco.angulo) * lado * (pista.mitad + 4), arco.y + Math.cos(arco.angulo) * lado * (pista.mitad + 4), arco.angulo, 2.3, 2.3, 14);
  pista.circuito.muros.forEach((muro, i) => {
    if (!esEstructuraObra(muro)) return;
    const p = puntosMuro(muro);
    agregar(`estructura:${i}`, "edificio", (p[0][0] + p[2][0]) / 2, (p[0][1] + p[2][1]) / 2,
      Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]), Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]), Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]), Array.isArray(muro) ? 2.4 : muro.alto ?? 2.4);
  });
  for (const o of e.objetos) {
    e.definiciones.set(o.id, o);
    if (o.masa) e.moviles.set(o.id, inicial(o));
    else for (let x = Math.floor((o.x - o.radio) / CELDA); x <= Math.floor((o.x + o.radio) / CELDA); x++) {
      for (let y = Math.floor((o.y - o.radio) / CELDA); y <= Math.floor((o.y + o.radio) / CELDA); y++) {
        const k = `${x},${y}`;
        if (!e.fijos.has(k)) e.fijos.set(k, []);
        e.fijos.get(k)!.push(o);
      }
    }
  }
  return e;
}

function inicial(o: ObjetoEscenario): CuerpoEscenario {
  return { id: o.id, x: o.x, y: o.y, angulo: o.angulo, vx: 0, vy: 0, w: 0, tumbado: false };
}

export function cercanos(e: Escenario, x: number, y: number, r = 4): ObjetoEscenario[] {
  const encontrados = new Set<ObjetoEscenario>();
  for (let ix = Math.floor((x - r) / CELDA); ix <= Math.floor((x + r) / CELDA); ix++) {
    for (let iy = Math.floor((y - r) / CELDA); iy <= Math.floor((y + r) / CELDA); iy++) {
      for (const o of e.fijos.get(`${ix},${iy}`) ?? []) encontrados.add(o);
    }
  }
  const radio = r + e.radioMovilMax + 1;
  const moviles: string[] = [];
  for (let ix = Math.floor((x - radio) / CELDA); ix <= Math.floor((x + radio) / CELDA); ix++) {
    for (let iy = Math.floor((y - radio) / CELDA); iy <= Math.floor((y + radio) / CELDA); iy++) {
      for (const id of e.celdasMoviles.get(`${ix},${iy}`) ?? []) moviles.push(id);
    }
  }
  // Preserve the old insertion order so collision resolution remains deterministic.
  moviles.sort((a, b) => e.ordenMoviles.get(a)! - e.ordenMoviles.get(b)!);
  for (const id of moviles) {
    const cuerpo = e.moviles.get(id)!;
    const o = e.definiciones.get(cuerpo.id)!;
    if (Math.hypot(cuerpo.x - x, cuerpo.y - y) < r + o.radio + 1) encontrados.add(o);
  }
  return [...encontrados];
}

/** Circle versus circle/oriented box, including a circle starting inside a solid. */
export function contactoObjeto(o: ObjetoEscenario, x: number, y: number, radio: number, cuerpo?: CuerpoEscenario) {
  const dx = x - (cuerpo?.x ?? o.x), dy = y - (cuerpo?.y ?? o.y);
  if (!o.ancho || !o.fondo) {
    const d = Math.hypot(dx, dy);
    const r = radio + (cuerpo?.tumbado ? Math.max(o.radio, 0.85) : o.radio);
    if (d >= r) return null;
    return { nx: d > 0 ? dx / d : 1, ny: d > 0 ? dy / d : 0, profundidad: r - d };
  }
  const a = cuerpo?.angulo ?? o.angulo, c = Math.cos(a), s = Math.sin(a);
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const w = o.ancho / 2, h = o.fondo / 2;
  const ex = lx - Math.max(-w, Math.min(w, lx)), ey = ly - Math.max(-h, Math.min(h, ly));
  const d = Math.hypot(ex, ey);
  if (d >= radio) return null;
  let nx: number, ny: number, profundidad: number;
  if (d > 1e-8) { nx = ex / d; ny = ey / d; profundidad = radio - d; }
  else if (w - Math.abs(lx) < h - Math.abs(ly)) { nx = lx < 0 ? -1 : 1; ny = 0; profundidad = radio + w - Math.abs(lx); }
  else { nx = 0; ny = ly < 0 ? -1 : 1; profundidad = radio + h - Math.abs(ly); }
  return { nx: nx * c - ny * s, ny: nx * s + ny * c, profundidad };
}

export function actualizarEscenario(pista: Pista, dt: number): void {
  const e = pista.escenario, b = pista.circuito.limites;
  for (const cuerpo of e.moviles.values()) {
    if (Math.abs(cuerpo.vx) + Math.abs(cuerpo.vy) + Math.abs(cuerpo.w) < 0.015) { cuerpo.vx = cuerpo.vy = cuerpo.w = 0; continue; }
    const o = e.definiciones.get(cuerpo.id)!;
    const r = cuerpo.tumbado ? Math.max(o.radio, 0.85) : o.radio;
    for (let paso = 0; paso < 2; paso++) {
      cuerpo.x += cuerpo.vx * dt / 2; cuerpo.y += cuerpo.vy * dt / 2; cuerpo.angulo += cuerpo.w * dt / 2;
      cuerpo.x = Math.max(b.x + r, Math.min(b.x + b.ancho - r, cuerpo.x));
      cuerpo.y = Math.max(b.y + r, Math.min(b.y + b.alto - r, cuerpo.y));
      for (const fijo of cercanos(e, cuerpo.x, cuerpo.y, r)) {
        if (fijo.id === cuerpo.id || fijo.base > 1) continue;
        const otro = e.moviles.get(fijo.id);
        const contacto = contactoObjeto(fijo, cuerpo.x, cuerpo.y, r, otro);
        if (!contacto) continue;
        const inversa = otro ? o.masa / fijo.masa : 0;
        const reparto = 1 / (1 + inversa);
        cuerpo.x += contacto.nx * contacto.profundidad * reparto; cuerpo.y += contacto.ny * contacto.profundidad * reparto;
        if (otro) { otro.x -= contacto.nx * contacto.profundidad * (1 - reparto); otro.y -= contacto.ny * contacto.profundidad * (1 - reparto); }
        const vn = (cuerpo.vx - (otro?.vx ?? 0)) * contacto.nx + (cuerpo.vy - (otro?.vy ?? 0)) * contacto.ny;
        if (vn < 0) {
          const impulso = -1.2 * vn * reparto;
          cuerpo.vx += impulso * contacto.nx; cuerpo.vy += impulso * contacto.ny;
          if (otro) {
            otro.vx -= impulso * contacto.nx * inversa; otro.vy -= impulso * contacto.ny * inversa;
            if (-vn > 3) otro.tumbado = true;
          }
        }
      }
    }
    cuerpo.vx *= Math.exp(-3.5 * dt); cuerpo.vy *= Math.exp(-3.5 * dt); cuerpo.w *= Math.exp(-5 * dt);
  }
}

export function empacarEscenario(pista: Pista): ObjetoRed[] {
  const red = (n: number) => Math.round(n * 1000) / 1000;
  return [...pista.escenario.moviles.values()].filter((c) => {
    const o = pista.escenario.definiciones.get(c.id)!;
    return c.tumbado || Math.abs(c.x - o.x) + Math.abs(c.y - o.y) > 0.001;
  }).map((c) => [c.id, red(c.x), red(c.y), red(c.angulo), red(c.vx), red(c.vy), red(c.w), c.tumbado]);
}

export function restaurarEscenario(pista: Pista, estado: ObjetoRed[] = []): void {
  for (const c of pista.escenario.moviles.values()) Object.assign(c, inicial(pista.escenario.definiciones.get(c.id)!));
  for (const [id, x, y, angulo, vx, vy, w, tumbado] of estado) {
    const cuerpo = pista.escenario.moviles.get(id);
    if (cuerpo) Object.assign(cuerpo, { x, y, angulo, vx, vy, w, tumbado });
  }
}
