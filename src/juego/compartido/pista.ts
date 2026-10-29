import type { Circuito, TipoSuelo, Vec } from "./tipos";

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

export function prepararPista(circuito: Circuito): Pista {
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
  for (const linea of circuito.muros) {
    for (let i = 1; i < linea.length; i++) {
      muros.push([linea[i - 1][0], linea[i - 1][1], linea[i][0], linea[i][1]]);
    }
  }

  return { circuito, puntos, acumulado, longitud, mitad: circuito.ancho / 2, muros };
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

/** Posición y dirección de la pista a `s` metros del inicio, desplazada `lateral` metros a la derecha */
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

export function enBarranco(pista: Pista, x: number, y: number): boolean {
  return pista.circuito.barrancos.some((poligono) => dentroDe(poligono, x, y));
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
