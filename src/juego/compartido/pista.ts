import type { Circuito, Item, Muro, Rampa, TipoSuelo, Vec } from "./tipos";
import { clonarEscenario, escenarioVacio, prepararEscenario, type Escenario } from "./escenario";

/**
 * Geometría del circuito: la línea central suavizada, el progreso a lo largo de ella
 * (para saber quién va adelante), el suelo en cada punto y los barrancos.
 */

/** Segmento de muro: x1, y1, x2, y2 */
export type Segmento = [number, number, number, number];

export interface Pista {
  circuito: Circuito;
  /** Línea central muestreada cada ~PASO metros (cerrada: el último punto conecta con el primero) */
  puntos: Vec[];
  /** Distancia acumulada desde el punto 0 hasta cada punto */
  acumulado: number[];
  longitud: number;
  mitad: number;
  muros: Segmento[];
  escenario: Escenario;
  /**
   * Las rampas que no son del circuito sino de algo puesto en la pista (la tubería de la obra,
   * rampasDeEntidad): van después de las del circuito en los índices de EstadoCarro.rampa. Las
   * pone la Sala cada tick y el navegador con cada instantánea
   */
  rampasMovibles?: Rampa[];
  /** Huecos temporales de mecanismos del mapa; cada sala tiene su propia lista. */
  huecos?: Vec[][];
}

export interface Proyeccion {
  /** Distancia recorrida a lo largo de la línea central (0 … longitud) */
  s: number;
  /** Distancia a la línea central (sin signo) */
  distancia: number;
  /** Índice del segmento más cercano: sirve de pista para la siguiente búsqueda */
  indice: number;
}

const PASO = 2;
const preparadas = new WeakMap<Circuito, { firma: string; pista: Pista }>();

export function prepararPista(circuito: Circuito): Pista {
  const firma = JSON.stringify(circuito);
  const cache = preparadas.get(circuito);
  if (cache?.firma === firma) return copiarPista(cache.pista);
  const pista = construirPista(circuito);
  preparadas.set(circuito, { firma, pista });
  return copiarPista(pista);
}

function copiarPista(base: Pista): Pista {
  return { ...base, puntos: base.puntos.map(p => [...p]), acumulado: [...base.acumulado], muros: base.muros.map(m => [...m]), escenario: clonarEscenario(base.escenario), rampasMovibles: [], ...(base.circuito.excavacion ? { huecos: [] } : {}) };
}

/** Warm up before accepting connections, avoiding a long first room creation. */
export function precargarPistas(circuitos: Circuito[]): void {
  for (const circuito of circuitos) prepararPista(circuito);
}

function construirPista(circuito: Circuito): Pista {
  const puntos = suavizar(circuito.centro, PASO);
  const acumulado: number[] = [0];
  for (let i = 1; i <= puntos.length; i++) {
    const a = puntos[i - 1];
    const b = puntos[i % puntos.length];
    acumulado.push(acumulado[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const longitud = acumulado.pop() as number;

  // Los límites del mundo son cuatro muros más
  const { x, y, ancho, alto } = circuito.limites;
  const muros: Segmento[] = [
    [x, y, x + ancho, y],
    [x + ancho, y, x + ancho, y + alto],
    [x + ancho, y + alto, x, y + alto],
    [x, y + alto, x, y],
  ];
  for (const muro of circuito.muros) {
    const linea = puntosMuro(muro);
    for (let i = 1; i < linea.length; i++) {
      muros.push([linea[i - 1][0], linea[i - 1][1], linea[i][0], linea[i][1]]);
    }
  }

  const pista: Pista = { circuito, puntos, acumulado, longitud, mitad: circuito.ancho / 2, muros, escenario: escenarioVacio() };
  pista.escenario = prepararEscenario(pista);
  return pista;
}

/** Catmull-Rom cerrado: de unos cuantos puntos de control a una curva suave muestreada cada `paso` m */
function suavizar(control: Vec[], paso: number): Vec[] {
  const n = control.length;
  const salida: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = control[(i - 1 + n) % n];
    const p1 = control[i];
    const p2 = control[(i + 1) % n];
    const p3 = control[(i + 2) % n];
    const pasos = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / paso));
    for (let k = 0; k < pasos; k++) {
      const t = k / pasos;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (a: number, b: number, d: number, e: number) =>
        0.5 * (2 * b + (-a + d) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (-a + 3 * b - 3 * d + e) * t3);
      salida.push([c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return salida;
}

/**
 * Proyecta un punto sobre la línea central. Con `cerca` solo busca alrededor de ese índice,
 * para que un carro no "salte" a otro tramo del circuito que pase cerca.
 */
export function proyectar(pista: Pista, x: number, y: number, cerca?: number): Proyeccion {
  const { puntos, acumulado } = pista;
  const n = puntos.length;
  const ventana = cerca === undefined ? n : Math.min(n, 60);
  const inicio = cerca === undefined ? 0 : cerca - ventana / 2;

  let mejor: Proyeccion = { s: 0, distancia: Infinity, indice: 0 };
  for (let k = 0; k < ventana; k++) {
    const i = (((inicio + k) % n) + n) % n;
    const a = puntos[i];
    const b = puntos[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const largo2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / largo2));
    const px = a[0] + dx * t;
    const py = a[1] + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < mejor.distancia) {
      mejor = { s: acumulado[i] + Math.sqrt(largo2) * t, distancia: d, indice: i };
    }
  }
  return mejor;
}

/** Qué tan a la derecha (+) o izquierda (-) de la línea central está (x, y), en metros: lo contrario de puntoEnPista */
export function lateralEnPista(pista: Pista, x: number, y: number): number {
  const c = puntoEnPista(pista, proyectar(pista, x, y).s);
  return -(x - c.x) * Math.sin(c.angulo) + (y - c.y) * Math.cos(c.angulo);
}

/** Posición y dirección de la pista a `s` metros del inicio, desplazada `lateral` metros a la derecha */
/** Hacia dónde va la pista en el tramo `indice` (vector unitario), p. ej. el de Proyeccion.indice */
export function direccionPista(pista: Pista, indice: number): { x: number; y: number } {
  const n = pista.puntos.length;
  const a = pista.puntos[((indice % n) + n) % n];
  const b = pista.puntos[(((indice + 1) % n) + n) % n];
  const largo = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { x: (b[0] - a[0]) / largo, y: (b[1] - a[1]) / largo };
}

export function puntoEnPista(pista: Pista, s: number, lateral = 0): { x: number; y: number; angulo: number } {
  const { puntos, acumulado, longitud } = pista;
  const n = puntos.length;
  s = ((s % longitud) + longitud) % longitud;
  let i = 0;
  while (i < n - 1 && acumulado[i + 1] <= s) i++;
  const a = puntos[i];
  const b = puntos[(i + 1) % n];
  const largo = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const t = (s - acumulado[i]) / largo;
  const angulo = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return {
    x: a[0] + (b[0] - a[0]) * t - Math.sin(angulo) * lateral,
    y: a[1] + (b[1] - a[1]) * t + Math.cos(angulo) * lateral,
    angulo,
  };
}

/**
 * Suelo en un punto: las zonas del circuito mandan; si no, asfalto dentro del camino y tierra fuera.
 * `distancia` (a la línea central) se pasa si ya se calculó, para no proyectar dos veces.
 */
export function sueloEn(pista: Pista, x: number, y: number, distancia?: number): TipoSuelo {
  const zonas = pista.circuito.superficies;
  for (let i = zonas.length - 1; i >= 0; i--) {
    if (dentroDe(zonas[i].poligono, x, y)) return zonas[i].tipo;
  }
  return (distancia ?? proyectar(pista, x, y).distancia) <= pista.mitad ? "asfalto" : "tierra";
}

/**
 * El andamio caído (item "barrera"): un tubo de lado a lado del camino que deja libre un carril
 * de 7 m. Su entidad está en el centro de la parte tapada, con `angulo` a lo largo del tubo; de
 * ahí salen sus puntas. Lo usan igual el servidor y la predicción del navegador
 */
/** Los carriles del camino: cuántos (circuito.carriles, 2 si no dice) y qué tan ancho es cada uno (m) */
export function carriles(pista: Pista, s?: number): { n: number; ancho: number } {
  const puente = pista.circuito.excavacion?.puente;
  if (puente && s !== undefined) {
    const d = Math.abs(((s - puente.s + pista.longitud * 1.5) % pista.longitud) - pista.longitud / 2);
    if (d <= puente.largo / 2 + puente.acceso) return { n: puente.carriles, ancho: puente.anchoCarril };
  }
  const n = Math.max(1, pista.circuito.carriles ?? 2);
  return { n, ancho: (pista.mitad * 2) / n };
}

/** El centro (lateral, m) del carril en que cae `lateral` */
export function centroDeCarril(pista: Pista, lateral: number, s?: number): number {
  const { n, ancho } = carriles(pista, s), mitad = n * ancho / 2;
  const k = Math.max(0, Math.min(n - 1, Math.floor((lateral + mitad) / ancho)));
  return -mitad + ancho * (k + 0.5);
}

/** El andamio tapa UN carril: de lado a lado de él, un poco menos que su ancho */
export function segmentoBarrera(pista: Pista, x: number, y: number, angulo: number): Segmento {
  const mitad = Math.max(1, carriles(pista).ancho / 2 - 0.3);
  const dx = Math.cos(angulo) * mitad;
  const dy = Math.sin(angulo) * mitad;
  return [x - dx, y - dy, x + dx, y + dy];
}

/**
 * Un CIERRE DE OBRA (mecánica "cierre") es un rectángulo a lo largo del camino: `largo` m en la
 * dirección `angulo` (la de la pista) por los carriles que tapa (menos un margen), centrado en
 * (x, y). Devuelve sus 4 esquinas
 */
export function esquinasCierre(pista: Pista, item: Item, x: number, y: number, angulo: number): Vec[] {
  const { n, ancho } = carriles(pista);
  const largo = (item.largo ?? 20) / 2;
  const lado = (Math.min(n - 1, item.carrilesCierre ?? 1) * ancho - 0.8) / 2;
  const fx = Math.cos(angulo);
  const fy = Math.sin(angulo);
  return [
    [x - fx * largo + fy * lado, y - fy * largo - fx * lado],
    [x + fx * largo + fy * lado, y + fy * largo - fx * lado],
    [x + fx * largo - fy * lado, y + fy * largo + fx * lado],
    [x - fx * largo - fy * lado, y - fy * largo + fx * lado],
  ];
}

/**
 * ¿El punto (x, y) cae en lo que ocupa una obra (un cierre, o la tubería con sus rampas: todo el
 * camino), o a menos de `margen` m? Sirve para no cerrar ni montar nada encima de un carro
 */
export function enCierre(pista: Pista, item: Item, e: { x: number; y: number; angulo: number }, x: number, y: number, margen = 0): boolean {
  const { n, ancho } = carriles(pista);
  const dx = x - e.x;
  const dy = y - e.y;
  const a = dx * Math.cos(e.angulo) + dy * Math.sin(e.angulo);
  const b = -dx * Math.sin(e.angulo) + dy * Math.cos(e.angulo);
  const mitadAncho = item.mecanica === "tuberia" ? pista.mitad : (Math.min(n - 1, item.carrilesCierre ?? 1) * ancho - 0.8) / 2;
  return Math.abs(a) <= (item.largo ?? 20) / 2 + margen && Math.abs(b) <= mitadAncho + margen;
}

/**
 * LA TUBERÍA DE LA OBRA (mecánica "tuberia"): atravesada en el camino, centrada en (x, y) y
 * mirando a donde van los carros. A los lados, una rampa de `carrilesRampa` carriles cada una que
 * sube hasta la tubería (se pasa saltando); en medio, lo que sobra del camino tapado con barreras.
 * Afuera del camino la tubería sigue y es sólida. Medidas a lo largo (desde el pie de las rampas,
 * en -largo/2): la rampa (`largoRampa`) y luego la tubería (`diametro`)
 */
export function medidasTuberia(pista: Pista, item: Item) {
  const { ancho } = carriles(pista);
  const largoRampa = item.largoRampa ?? 7;
  const diametro = item.diametro ?? 1.6;
  const anchoRampa = Math.min(pista.mitad, (item.carrilesRampa ?? 1.25) * ancho);
  const pie = -(item.largo ?? largoRampa + diametro) / 2;
  return { largoRampa, diametro, anchoRampa, alto: item.altoRampa ?? 1.6, pie, tubo: pie + largoRampa, centro: pista.mitad - anchoRampa };
}

/** De coordenadas de la entidad (a lo largo, de lado) al mundo */
function local(e: { x: number; y: number; angulo: number }, a: number, b: number): Vec {
  const c = Math.cos(e.angulo);
  const s = Math.sin(e.angulo);
  return [e.x + a * c - b * s, e.y + a * s + b * c];
}

/** Los 4 lados de un rectángulo en coordenadas de la entidad */
function rectangulo(e: { x: number; y: number; angulo: number }, a1: number, a2: number, b1: number, b2: number): Segmento[] {
  const p = [local(e, a1, b1), local(e, a2, b1), local(e, a2, b2), local(e, a1, b2)];
  return p.map((q, i): Segmento => [q[0], q[1], p[(i + 1) % 4][0], p[(i + 1) % 4][1]]);
}

/** Las rampas de la tubería ya montada (a los dos lados del camino) */
export function rampasDeEntidad(pista: Pista, item: Item | undefined, e: { x: number; y: number; angulo: number; etapa: number }): Rampa[] {
  if (!item || item.mecanica !== "tuberia" || e.etapa !== 1) return [];
  const m = medidasTuberia(pista, item);
  return [-1, 1].map((lado) => {
    const [x, y] = local(e, m.pie, lado * (pista.mitad - m.anchoRampa / 2));
    return { x, y, angulo: e.angulo, largo: m.largoRampa, ancho: m.anchoRampa - 0.2, alto: m.alto };
  });
}

/**
 * Lo sólido como muro de una entidad suelta: el andamio caído (un tubo de lado a lado del carril)
 * y el cierre de obra ya cerrado (sus 4 lados). Lo usan el servidor y la predicción del navegador
 */
export function murosDeEntidad(pista: Pista, item: Item | undefined, e: { x: number; y: number; angulo: number; etapa: number }): Segmento[] {
  if (!item || e.etapa !== 1) return [];
  if (item.mecanica === "barrera") return [segmentoBarrera(pista, e.x, e.y, e.angulo)];
  if (item.mecanica === "tuberia") {
    // El tramo de en medio (barreras y tubería) y la tubería afuera del camino, de los dos lados
    const m = medidasTuberia(pista, item);
    const fin = m.tubo + m.diametro;
    return [
      ...(m.centro > 0.5 ? rectangulo(e, m.tubo - 2, fin, -m.centro, m.centro) : []),
      ...rectangulo(e, m.tubo, fin, pista.mitad, pista.mitad + 12),
      ...rectangulo(e, m.tubo, fin, -pista.mitad - 12, -pista.mitad),
    ];
  }
  if (item.mecanica !== "cierre") return [];
  const p = esquinasCierre(pista, item, e.x, e.y, e.angulo);
  return p.map((a, i): Segmento => [a[0], a[1], p[(i + 1) % 4][0], p[(i + 1) % 4][1]]);
}

export function enBarranco(pista: Pista, x: number, y: number): boolean {
  return pista.circuito.barrancos.some((poligono) => dentroDe(poligono, x, y)) || (pista.huecos ?? []).some(poligono => dentroDe(poligono, x, y));
}

export function puntosMuro(muro: Muro): Vec[] {
  return Array.isArray(muro) ? muro : muro.puntos;
}

/** Nivel de la superficie del agua (m): un poco abajo del piso para que la orilla se vea */
export const NIVEL_AGUA = -0.4;
/** Hasta qué profundidad baja el fondo del agua, y qué tan rápido desde la orilla (m por m) */
const PROFUNDIDAD_AGUA = 5;
const PENDIENTE_FONDO = 0.12;

/**
 * Altura del suelo: suma de lomas (y hoyos) con perfil coseno, 0 lejos de todas. Dentro del
 * agua el fondo va bajando desde la orilla, para que se vea hondo.
 */
export function alturaEn(pista: Pista, x: number, y: number): number {
  let h = 0;
  for (const l of pista.circuito.elevacion ?? []) {
    const d = Math.hypot(x - l.x, y - l.y);
    if (d < l.radio) h += (l.altura * (1 + Math.cos((Math.PI * d) / l.radio))) / 2;
  }
  for (const agua of pista.circuito.agua ?? []) {
    if (dentroDe(agua, x, y)) h -= Math.min(PROFUNDIDAD_AGUA, 0.6 + distanciaAlBorde(agua, x, y) * PENDIENTE_FONDO);
  }
  return h;
}

/** ¿El punto cae en el agua? */
export function enAgua(pista: Pista, x: number, y: number): boolean {
  return (pista.circuito.agua ?? []).some((poligono) => dentroDe(poligono, x, y));
}

/**
 * ¿Está (x, y) sobre una rampa? Devuelve cuál (índice), qué tan arriba (t: 0 al pie, 1 en la orilla
 * de arriba) y lo que avanza a lo largo de ella (m), o null
 */
/** La altura de una rampa a la fracción `t` de su largo (0 al pie, 1 en la orilla de arriba) */
export function alturaRampa(r: Rampa, t: number): number {
  const desde = r.desde ?? 0;
  return desde + t * (r.alto - desde);
}

/** La rampa número `indice`: las del circuito y luego las movibles (undefined si ya no está) */
export function rampaNumero(pista: Pista, indice: number): Rampa | undefined {
  const fijas = pista.circuito.rampas ?? [];
  return indice < fijas.length ? fijas[indice] : pista.rampasMovibles?.[indice - fijas.length];
}

export function rampaEn(pista: Pista, x: number, y: number): { indice: number; t: number; avance: number } | null {
  const fijas = pista.circuito.rampas ?? [];
  const movibles = pista.rampasMovibles ?? [];
  const total = fijas.length + movibles.length;
  for (let indice = 0; indice < total; indice++) {
    const r = indice < fijas.length ? fijas[indice] : movibles[indice - fijas.length];
    const { avance, lado } = sobreRampa(r, x, y);
    if (avance >= 0 && avance <= r.largo && Math.abs(lado) <= r.ancho / 2) return { indice, t: avance / r.largo, avance };
  }
  return null;
}

/** Dónde queda (x, y) respecto a la rampa: metros a lo largo (desde el pie) y de lado */
export function sobreRampa(r: Rampa, x: number, y: number): { avance: number; lado: number } {
  const fx = Math.cos(r.angulo);
  const fy = Math.sin(r.angulo);
  return { avance: (x - r.x) * fx + (y - r.y) * fy, lado: -(x - r.x) * fy + (y - r.y) * fx };
}

/**
 * Todas las cajas de items del circuito como [x, y, altura]: las del camino (altura 0, en filas de
 * 3) y las que flotan después de cada rampa (solo se agarran volando)
 */
export function cajasDelCircuito(circuito: Circuito): [number, number, number][] {
  const enElAire = (circuito.rampas ?? []).flatMap((r): [number, number, number][] => {
    if (!r.caja) return [];
    const d = r.largo + r.caja.distancia;
    return [[r.x + Math.cos(r.angulo) * d, r.y + Math.sin(r.angulo) * d, r.caja.altura]];
  });
  return [...circuito.cajas.map(([x, y]): [number, number, number] => [x, y, 0]), ...enElAire];
}

/** Distancia de un punto al borde de un polígono */
export function distanciaAlBorde(poligono: Vec[], x: number, y: number): number {
  let minimo = Infinity;
  for (let i = 0; i < poligono.length; i++) {
    const [ax, ay] = poligono[i];
    const [bx, by] = poligono[(i + 1) % poligono.length];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    minimo = Math.min(minimo, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return minimo;
}

/** Punto dentro de polígono (regla par-impar) */
export function dentroDe(poligono: Vec[], x: number, y: number): boolean {
  let dentro = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const [xi, yi] = poligono[i];
    const [xj, yj] = poligono[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
