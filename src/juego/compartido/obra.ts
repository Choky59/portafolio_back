import type { Muro } from "./tipos";
import type { Pista } from "./pista";
import { dentroDe, distanciaAlBorde, proyectar, puntoEnPista, puntosMuro } from "./pista";
export type TipoPatio = "marco" | "columnas" | "tubos" | "grava" | "tarimas" | "contenedor" | "varilla" | "cuadrilla" | "volteo" | "excavadora" | "grua";
export interface PosicionObra { x: number; y: number; angulo: number }
export interface PatioObra { tipo: TipoPatio; x: number; y: number; giro: number; radio: number; semilla: number }
export interface PlanoObra {
  ladoCerca: number;
  cerca: { x1: number; y1: number; x2: number; y2: number }[];
  barreras: PosicionObra[];
  barriles: { x: number; y: number; luz: boolean }[];
  senales: (PosicionObra & { tipo: string })[];
  banderas: PosicionObra[];
  tubos: PosicionObra[];
  bahias: (PosicionObra & { material: { x: number; y: number } | null })[];
  patios: PatioObra[];
  personas: (PosicionObra & { semilla: number; agachado: boolean })[];
}

/** Mulberry32: identical on server and browser. */
export function rngObra(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = rngObra;

/** Shared pile shapes keep the edge of every gravel heap solid. */
export function montonesObra(random: () => number, cuantos: number, radio = 6) {
  return Array.from({ length: cuantos }, (_, k) => {
    const arena = random() < 0.4;
    const e = Math.min([0.75, 1, 1.25][Math.floor(random() * 3)], (radio - 0.25) / 3.2);
    const a = random() * Math.PI * 2;
    const d = k ? random() * Math.max(0, radio - 3.2 * e) : 0;
    return { arena, e, x: Math.cos(a) * d, y: Math.sin(a) * d, giro: random() * 3 };
  });
}

/**
 * Dónde va cada cosa de la obra (pistas con terreno 'obra'), sin dibujar nada: el piso 2D
 * (mapa.js) pinta las losas y el mundo 3D (construccion.js) pone encima lo que les toca, así
 * que los dos leen el mismo plano. La física también lo usa para las colisiones y los objetos
 * móviles. La colocación inicial conserva el asfalto y el acotamiento libres.
 *
 * - cerca: la malla azul de un solo lado (el de afuera de la pista), con barreras de concreto
 *   rayadas enfrente
 * - barriles: naranjas y blancos a los dos lados, a distancias irregulares, algunos con luz
 * - señales: trabajadores, maquinaria, peligro y desvíos, del lado contrario a la cerca
 * - patios: el resto del terreno lleno de obra (losas, estructuras, tubos, material, gente)
 */

/** Las cuadras de los edificios a medio hacer: muros cerrados de 4 esquinas (sí chocan) */
export function esEstructuraObra(muro: Muro) {
  const p = puntosMuro(muro)
  return p.length === 5 && p[0][0] === p[4][0] && p[0][1] === p[4][1]
}

/** Lo que ya ocupa espacio en el JSON de la pista, con su radio aproximado en metros */
const RADIO_DECORACION: Record<string, number> = { 'grua-torre': 7, excavadora: 9, revolvedora: 6, caseta: 5, tubos: 4, cono: 1, piedra: 2.5 }

/** Lo que puede salir en un patio, con su radio y cuántas veces más que el resto */
const PATIOS: { tipo: TipoPatio; radio: number; peso: number; maximo?: number; lejos?: number }[] = [
  { tipo: 'marco', radio: 10, peso: 3 },
  { tipo: 'columnas', radio: 9, peso: 3 },
  { tipo: 'tubos', radio: 5, peso: 2 },
  { tipo: 'grava', radio: 6, peso: 2 },
  { tipo: 'tarimas', radio: 6, peso: 2 },
  { tipo: 'contenedor', radio: 6, peso: 2 },
  { tipo: 'varilla', radio: 5, peso: 1 },
  { tipo: 'cuadrilla', radio: 4, peso: 2 },
  { tipo: 'volteo', radio: 8, peso: 1, maximo: 3 },
  { tipo: 'excavadora', radio: 12, peso: 1, maximo: 3 },
  { tipo: 'grua', radio: 8, peso: 1, maximo: 2, lejos: 30 },
]

/**
 * Cuánto espacio aparta una pieza puesta a mano (radio, m). Las que pasan por encima del camino
 * (el puente, el dosel del rascacielos) o están en él (columnas, el puente incompleto) no apartan:
 * así siguen saliendo los barriles y las señales a la orilla
 */
export function radioPieza(p: { tipo: string; ancho?: number; fondo?: number }): number {
  if (["puente-via", "dosel", "puente-roto", "columna", "polvo", "malla", "bloque", "barandal", "arco-tunel", "portal", "muro-tunel", "tuberia-gigante", "zanja-puente", "zona-brazo", "soporte-puente"].includes(p.tipo)) return 0
  if (p.tipo === "jersey") return 1.6
  if (p.tipo === "reflector") return 1
  return Math.hypot(p.ancho ?? 8, p.fondo ?? 8) / 2
}

/** Las señales de la obra, en el orden en que van saliendo */
export const SENALES = ['trabajadores', 'maquinaria', 'peligro', 'desvio-izq', 'trabajadores', 'desvio-der', 'maquinaria']

const planos = new WeakMap<Pista, PlanoObra>()
const planosCircuito = new WeakMap<Pista["circuito"], { firma: string; plano: PlanoObra }>()

export function planoObra(pista: Pista): PlanoObra {
  if (!planos.has(pista)) {
    const firma = JSON.stringify(pista.circuito)
    const cache = planosCircuito.get(pista.circuito)
    const plano = cache?.firma === firma ? structuredClone(cache.plano) : armarPlano(pista)
    if (cache?.firma !== firma) planosCircuito.set(pista.circuito, { firma, plano: structuredClone(plano) })
    planos.set(pista, plano)
  }
  return planos.get(pista)!
}

function armarPlano(pista: Pista): PlanoObra {
  const { circuito, mitad, longitud } = pista
  const random = rng(97)
  const b = circuito.limites
  const prohibidos = [...(circuito.barrancos ?? []), ...circuito.muros.filter(esEstructuraObra).map(puntosMuro)]
  const ocupados = (circuito.decoracion ?? []).map((d) => ({ x: d.x, y: d.y, r: (RADIO_DECORACION[d.tipo] ?? 3) * (d.escala ?? 1) }))
  // Las piezas puestas a mano (las que pasan sobre el camino o son solo de vista no apartan nada)
  for (const p of circuito.piezas ?? []) {
    const r = radioPieza(p)
    if (r > 0) ocupados.push({ x: p.x, y: p.y, r })
  }
  for (const p of circuito.patiosFijos ?? []) ocupados.push({ x: p.x, y: p.y, r: PATIOS.find((o) => o.tipo === p.tipo)?.radio ?? 6 })
  for (const r of circuito.rampas ?? []) ocupados.push({ x: r.x, y: r.y, r: Math.max(r.largo, r.ancho) + 3 })
  const ocupar = (x: number, y: number, r: number) => ocupados.push({ x, y, r })

  /** Dentro del terreno, a `margen` metros del borde del asfalto, y sin pisar nada de radio `r` */
  function libre(x: number, y: number, margen: number, r = 0) {
    if (x < b.x + 8 + r || x > b.x + b.ancho - 8 - r || y < b.y + 8 + r || y > b.y + b.alto - 8 - r) return false
    if (proyectar(pista, x, y).distancia < mitad + margen + r) return false
    if (prohibidos.some((p) => dentroDe(p, x, y) || distanciaAlBorde(p, x, y) < r + 0.5)) return false
    return ocupados.every((o) => Math.hypot(o.x - x, o.y - y) > o.r + r)
  }

  // Cerca del paso de la aplanadora no va nada: ahí cruza el camino
  const distanciaS = (a: number, c: number) => Math.min(Math.abs(a - c), longitud - Math.abs(a - c))
  const enCruce = (s: number) => (circuito.ambiente ?? []).some((a) => distanciaS(a.s, s) < 14)

  // El lado de afuera de la pista: el que casi siempre queda fuera del trazo cerrado
  let votos = 0
  for (let s = 0; s < longitud; s += 15) {
    const p = puntoEnPista(pista, s, mitad + 12)
    votos += dentroDe(pista.puntos, p.x, p.y) ? -1 : 1
  }
  const ladoCerca = votos >= 0 ? 1 : -1

  // La cerca y sus barreras: tramos largos con portones (huecos) de vez en cuando
  const cerca: PlanoObra["cerca"] = []
  const barreras: PlanoObra["barreras"] = []
  const PANEL = 4
  let tramo = 40 + random() * 50
  for (let s = 0; s < longitud; s += PANEL) {
    tramo -= PANEL
    if (tramo < 0) {
      // Un portón de 8 a 12 m, por donde se asoma el patio
      s += 4 + Math.round(random() * 2) * PANEL
      tramo = 40 + random() * 60
      continue
    }
    if (enCruce(s)) continue
    const a = puntoEnPista(pista, s, ladoCerca * (mitad + 10))
    const c = puntoEnPista(pista, s + PANEL, ladoCerca * (mitad + 10))
    const largo = Math.hypot(c.x - a.x, c.y - a.y)
    // En la parte de adentro de una curva los paneles se enciman: se brinca ese tramo
    if (largo < PANEL * 0.7 || largo > PANEL * 1.8) continue
    if (!libre(a.x, a.y, 8) || !libre(c.x, c.y, 8)) continue
    cerca.push({ x1: a.x, y1: a.y, x2: c.x, y2: c.y })
    // Una barrera de 3 m enfrente de cada panel, alineada con el camino
    const m = puntoEnPista(pista, s + PANEL / 2, ladoCerca * (mitad + 6.5))
    if (libre(m.x, m.y, 5.5)) barreras.push({ x: m.x, y: m.y, angulo: m.angulo })
  }
  for (const p of cerca) ocupar((p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2, 2.5)
  for (const p of barreras) ocupar(p.x, p.y, 1.6)

  // Reservar las señales antes que los barriles para que no se pierdan entre ellos.
  const senales: PlanoObra["senales"] = []
  const banderas: PlanoObra["banderas"] = []
  for (let s = 25, i = 0; s < longitud - 10; s += 45 + random() * 25, i++) {
    if (enCruce(s)) continue
    const lado = [-ladoCerca, ladoCerca].find((candidato) => {
      const p = puntoEnPista(pista, s, candidato * (mitad + 4.5))
      return libre(p.x, p.y, 3, 1)
    })
    if (lado === undefined) continue
    const p = puntoEnPista(pista, s, lado * (mitad + 4.5))
    // De frente a los carros que vienen
    senales.push({ x: p.x, y: p.y, angulo: p.angulo, tipo: SENALES[senales.length % SENALES.length] })
    ocupar(p.x, p.y, 1.5)
    const q = puntoEnPista(pista, s + 3.5, lado * (mitad + 3.5))
    if (i % 2 === 0 && libre(q.x, q.y, 2.5, 0.6)) {
      banderas.push({ x: q.x, y: q.y, angulo: q.angulo })
      ocupar(q.x, q.y, 1)
    }
  }

  // Barriles: a los dos lados, cada 5 a 16 m, a veces en grupitos de 2 o 3.
  const barriles: PlanoObra["barriles"] = []
  for (const lado of [-1, 1]) {
    let s = random() * 8
    while (s < longitud) {
      const grupo = random() < 0.3 ? 2 + Math.floor(random() * 2) : 1
      for (let k = 0; k < grupo; k++) {
        const lateral = lado * (mitad + 2.4 + random() * (lado === ladoCerca ? 1.8 : 3.5))
        const p = puntoEnPista(pista, s + k * 1.3, lateral)
        if (enCruce(s) || !libre(p.x, p.y, 1.8, 0.5)) continue
        barriles.push({ x: p.x, y: p.y, luz: random() < 0.45 })
        ocupar(p.x, p.y, 0.6)
      }
      s += 5 + random() * 11 + grupo
    }
  }

  // Tubos junto al camino, del lado de adentro, cada tanto
  const tubos: PlanoObra["tubos"] = []
  for (let s = 60; s < longitud; s += 110 + random() * 60) {
    const p = puntoEnPista(pista, s, -ladoCerca * (mitad + 9))
    if (enCruce(s) || !libre(p.x, p.y, 5, 4)) continue
    tubos.push({ x: p.x, y: p.y, angulo: p.angulo })
    ocupar(p.x, p.y, 4.5)
  }

  // Bahías de trabajo pegadas al camino, del lado de adentro: una excavadora y su material, para
  // que la maquinaria salga en la cámara de la carrera y no solo a lo lejos
  const bahias: PlanoObra["bahias"] = []
  const paso = circuito.id === 'excavacion' ? 70 : 85
  const radioBahia = circuito.id === 'excavacion' ? 13 : 11
  for (let s = 16; s < longitud; s += paso) {
    const p = puntoEnPista(pista, s, -ladoCerca * (mitad + radioBahia + 6))
    if (enCruce(s) || !libre(p.x, p.y, 4, radioBahia)) continue
    const q = puntoEnPista(pista, s + 13, -ladoCerca * (mitad + 9))
    const material = libre(q.x, q.y, 5, 2.5)
    bahias.push({ x: p.x, y: p.y, angulo: p.angulo, material: material ? { x: q.x, y: q.y } : null })
    ocupar(p.x, p.y, radioBahia + 0.5)
    if (material) ocupar(q.x, q.y, 2.5)
  }

  // Los patios: una cuadrícula sobre todo el terreno, cada celda con su losa y algo encima; o los
  // puestos a mano (circuito.patiosFijos), y entonces no se sortea ninguno
  const patios: PlanoObra["patios"] = (circuito.patiosFijos ?? []).map((p, i) => ({
    tipo: p.tipo as TipoPatio,
    x: p.x,
    y: p.y,
    giro: p.giro,
    radio: PATIOS.find((o) => o.tipo === p.tipo)?.radio ?? 6,
    semilla: p.semilla ?? 1000 + i * 37,
  }))
  const aMano = !!circuito.patiosFijos
  const cuenta: Partial<Record<TipoPatio, number>> = {}
  const total = PATIOS.reduce((t, p) => t + p.peso, 0)
  const PASO = 21
  for (let y = b.y + PASO / 2; !aMano && y < b.y + b.alto; y += PASO) {
    for (let x = b.x + PASO / 2; x < b.x + b.ancho; x += PASO) {
      const px = x + (random() - 0.5) * 8
      const py = y + (random() - 0.5) * 8
      let elegido: (typeof PATIOS)[number] | null = null
      for (let intento = 0; intento < 3 && !elegido; intento++) {
        let r = random() * total
        const opcion = PATIOS.find((p) => (r -= p.peso) < 0) ?? PATIOS[0]
        if (opcion.maximo && (cuenta[opcion.tipo] ?? 0) >= opcion.maximo) continue
        if (libre(px, py, 6 + (opcion.lejos ?? 0), opcion.radio)) elegido = opcion
      }
      // Sin espacio para nada grande, al menos material suelto o gente
      if (!elegido && libre(px, py, 5, 3)) elegido = random() < 0.5 ? { tipo: 'grava', radio: 3, peso: 1 } : { tipo: 'cuadrilla', radio: 3, peso: 1 }
      if (!elegido) continue
      cuenta[elegido.tipo] = (cuenta[elegido.tipo] ?? 0) + 1
      const giro = random() * Math.PI * 2
      patios.push({ tipo: elegido.tipo, x: px, y: py, giro, radio: elegido.radio, semilla: Math.floor(random() * 1e6) })
      ocupar(px, py, elegido.radio)
    }
  }

  const personas: PlanoObra["personas"] = [];
  for (const p of patios) {
    const random = rng(p.semilla + 700);
    const n = p.tipo === "cuadrilla" ? 3 : ["marco", "columnas"].includes(p.tipo) ? 2 : ["tarimas", "volteo"].includes(p.tipo) ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const ox = (random() - 0.5) * p.radio * 0.9;
      const oy = p.radio * 0.45 + random() * 0.7;
      personas.push({ x: p.x + ox * Math.cos(p.giro) + oy * Math.sin(p.giro), y: p.y - ox * Math.sin(p.giro) + oy * Math.cos(p.giro), angulo: random() * Math.PI * 2, semilla: Math.floor(random() * 1e6), agachado: random() < 0.3 });
    }
  }
  return { ladoCerca, cerca, barreras, barriles, senales, banderas, tubos, bahias, patios, personas }
}
