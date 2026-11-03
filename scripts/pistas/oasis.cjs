// Copa Desierto · Oasis (content/juego/circuitos/desierto.json; el id se queda "desierto" para no
// perder la pista guardada de nadie).
// Generator for content/juego/circuitos/desierto.json: a simple flattened O (a stadium:
// two straights and two wide half-circle ends) of 460 m a lap, in the open desert, with a lake that
// fills the middle (only a sand shoulder by the road) so nobody can cut across.
const fs = require('fs')
const path = require('path')
const back = path.join(__dirname, '..', '..')
const { prepararPista, puntoEnPista, proyectar, dentroDe } = require(`${back}/build/juego/compartido/pista`)

const OBJETIVO = 460

let semilla = 4600
const random = () => {
  semilla = (semilla + 0x6d2b79f5) >>> 0
  let t = semilla
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * The stadium's center line: straights of `recta` m and ends of radius `radio`, a control point
 * every ~12 m. x → east, y → south; starts at the middle of the top straight, heading east.
 */
function estadio(recta, radio) {
  const puntos = []
  const mitad = recta / 2
  const pasos = (largo) => Math.max(2, Math.round(largo / 12))
  // Top straight, from the middle to the right end
  for (let i = 0; i < pasos(mitad); i++) puntos.push([(mitad * i) / pasos(mitad), -radio])
  // Right end: half circle going down
  for (let i = 0; i < pasos(Math.PI * radio); i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / pasos(Math.PI * radio)
    puntos.push([mitad + radio * Math.cos(a), radio * Math.sin(a)])
  }
  // Bottom straight, right to left
  for (let i = 0; i < pasos(recta); i++) puntos.push([mitad - (recta * i) / pasos(recta), radio])
  // Left end: half circle going up
  for (let i = 0; i < pasos(Math.PI * radio); i++) {
    const a = Math.PI / 2 + (Math.PI * i) / pasos(Math.PI * radio)
    puntos.push([-mitad + radio * Math.cos(a), radio * Math.sin(a)])
  }
  // Top straight, from the left end back to the middle (the loop closes on the first point)
  for (let i = 0; i < pasos(mitad); i++) puntos.push([-mitad + (mitad * i) / pasos(mitad), -radio])
  return puntos.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)])
}

// Proportions of a flattened O; the size is tuned until the smoothed lap measures OBJETIVO
const RADIO_POR_RECTA = 0.24
const medir = (recta) => prepararPista({ centro: estadio(recta, recta * RADIO_POR_RECTA), ancho: 14, muros: [], limites: { x: -500, y: -500, ancho: 1000, alto: 1000 } }).longitud
let recta = 130
for (let i = 0; i < 30; i++) recta *= OBJETIVO / medir(recta)
const radio = +(recta * RADIO_POR_RECTA).toFixed(2)
const centro = estadio(recta, radio)

// The lake: the same stadium shape inside the road, leaving ORILLA m of sand between road and water
const ORILLA = 4.5
const radioLago = radio - 7 - ORILLA
const lago = []
for (let i = 0; i < 72; i++) {
  const a = (i / 72) * Math.PI * 2
  // Right half around (recta/2, 0), left half around (-recta/2, 0)
  const cx = Math.cos(a) >= 0 ? recta / 2 : -recta / 2
  lago.push([+(cx + radioLago * Math.cos(a)).toFixed(1), +(radioLago * Math.sin(a)).toFixed(1)])
}

/** A point of the stadium shape of radius r (around the two ends' centers), at angle a */
const enEstadio = (r, a) => [(Math.cos(a) >= 0 ? recta / 2 : -recta / 2) + r * Math.cos(a), r * Math.sin(a)]

// The grassy shore: a ring between the road and the water (outer edge one way, inner edge the
// other, so the lake stays a hole and the water doesn't look green through it)
const PASTO_AFUERA = radioLago + ORILLA - 0.6
const PASTO_ADENTRO = radioLago - 0.4
const anillo = (r) => Array.from({ length: 72 }, (_, i) => enEstadio(r, (i / 72) * Math.PI * 2))
const afuera = anillo(PASTO_AFUERA)
const adentro = anillo(PASTO_ADENTRO).reverse()
const pasto = [...afuera, afuera[0], adentro.at(-1), ...adentro, adentro.at(-1)].map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)])

const MARGEN = 70
const limites = {
  x: +(-recta / 2 - radio - MARGEN).toFixed(1),
  y: +(-radio - MARGEN).toFixed(1),
  ancho: +(recta + 2 * radio + 2 * MARGEN).toFixed(1),
  alto: +(2 * radio + 2 * MARGEN).toFixed(1),
}

const circuito = {
  id: 'desierto',
  nombre: 'Oasis',
  centro,
  ancho: 14,
  limites,
  superficies: [{ tipo: 'tierra', estilo: 'pasto', poligono: pasto }],
  barrancos: [],
  agua: [lago],
  muros: [],
  cajas: [],
  elevacion: [
    // Dunes all around the oval, and a low one in the middle
    { x: 0, y: -radio - 55, radio: 45, altura: 9 },
    { x: -recta / 2 - radio - 45, y: 0, radio: 40, altura: 7 },
    { x: recta / 2 + radio + 45, y: 10, radio: 42, altura: 8 },
    { x: -45, y: radio + 55, radio: 38, altura: 6 },
    { x: 60, y: radio + 58, radio: 34, altura: 7 },
  ].map((h) => ({ ...h, x: +h.x.toFixed(1), y: +h.y.toFixed(1) })),
  decoracion: [],
}

const pista = prepararPista(circuito)


// Item boxes: rows of three across the road, one on each straight and one on the right end
for (const s of [55, 175, 300]) {
  for (const lateral of [-4.2, 0, 4.2]) {
    const p = puntoEnPista(pista, s, lateral)
    circuito.cajas.push([+p.x.toFixed(1), +p.y.toFixed(1)])
  }
}

// Life on the lake (they float and rock with the water): rowboats, kayaks, people swimming or on a
// ring, and ducks, two of them with their ducklings in a row behind
const enElLago = [
  { tipo: 'bote', x: -35, y: -6, rotacion: 0.3 },
  { tipo: 'bote', x: 45, y: 8, rotacion: 2.8 },
  { tipo: 'kayak', x: -58, y: 9, rotacion: -0.4 },
  { tipo: 'kayak', x: 15, y: -10, rotacion: 0.2 },
  { tipo: 'kayak', x: 70, y: -4, rotacion: 3.0 },
  { tipo: 'nadador', x: -15, y: 4, rotacion: 0.8 },
  { tipo: 'nadador', x: -10, y: 8, rotacion: -2.4 },
  { tipo: 'nadador', x: 25, y: 2, rotacion: 1.9 },
  { tipo: 'nadador', x: 55, y: 12, rotacion: 0.1 },
  { tipo: 'nadador', x: -75, y: -8, rotacion: 2.6 },
  { tipo: 'flotador', x: 5, y: 10 },
  { tipo: 'flotador', x: 34, y: -11 },
  { tipo: 'pato', x: -80, y: 4, rotacion: 1.2 },
  { tipo: 'pato', x: 78, y: 5, rotacion: -2 },
  { tipo: 'pato', x: -2, y: -4, rotacion: 0.6 },
]
for (const [x, y, rotacion] of [[-45, 12, 0], [60, -12, Math.PI]]) {
  enElLago.push({ tipo: 'pato', x, y, rotacion })
  for (let i = 1; i <= 3; i++) {
    enElLago.push({ tipo: 'pato', x: x - Math.cos(rotacion) * 1.2 * i, y: y + Math.sin(rotacion) * 1.2 * i, rotacion, escala: 0.5 })
  }
}
for (const d of enElLago) {
  // Well inside the water: the point and 2.5 m around it
  const dentro = [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]].every(([dx, dy]) => dentroDe(lago, d.x + dx, d.y + dy))
  if (!dentro) throw new Error(`${d.tipo} en ${d.x},${d.y} queda fuera del lago`)
  circuito.decoracion.push({ ...d, x: +d.x.toFixed(1), y: +d.y.toFixed(1), ...(d.rotacion !== undefined ? { rotacion: +d.rotacion.toFixed(2) } : {}), flota: true })
}

// The oasis around the water: palms all along the shore (small, so their fronds don't hide the
// road) with reeds between them; bigger palm groves outside the two curves; a desert tent with
// camels resting by it, outside the bottom straight
const conRumbo = (a) => +a.toFixed(2)
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2 + 0.1
  const [x, y] = enEstadio(radioLago + 1.4, a)
  circuito.decoracion.push({ tipo: 'palmera', x: +x.toFixed(1), y: +y.toFixed(1), escala: +(0.5 + random() * 0.12).toFixed(2) })
}
for (let i = 0; i < 22; i++) {
  const a = (i / 22) * Math.PI * 2 + 0.25
  const [x, y] = enEstadio(radioLago + 0.4, a)
  circuito.decoracion.push({ tipo: 'juncos', x: +x.toFixed(1), y: +y.toFixed(1), escala: +(0.8 + random() * 0.4).toFixed(2) })
}
for (const lado of [-1, 1]) {
  for (let i = 0; i < 7; i++) {
    // Outside the end: around its center, beyond the road, facing out
    const a = (lado > 0 ? 0 : Math.PI) + (random() - 0.5) * 2.2
    const r = radio + 7 + 8 + random() * 16
    const x = lado * (recta / 2) + r * Math.cos(a)
    const y = r * Math.sin(a)
    circuito.decoracion.push({ tipo: 'palmera', x: +x.toFixed(1), y: +y.toFixed(1), escala: +(0.8 + random() * 0.4).toFixed(2) })
  }
}
circuito.decoracion.push(
  { tipo: 'carpa', x: 8, y: +(radio + 44).toFixed(1), rotacion: conRumbo(Math.PI) },
  { tipo: 'camello', x: -10, y: +(radio + 42).toFixed(1), rotacion: conRumbo(-0.4) },
  { tipo: 'camello', x: 24, y: +(radio + 47).toFixed(1), rotacion: conRumbo(2.6) },
  { tipo: 'camello', x: 30, y: +(radio + 38).toFixed(1), rotacion: conRumbo(1.4), escala: 0.9 },
)

// Saguaros and rocks: around the oval, away from the road, the lake and each other
const libre = (x, y) =>
  proyectar(pista, x, y).distancia > pista.mitad + 7 &&
  !circuito.agua.some((a) => dentroDe(a, x, y)) &&
  circuito.decoracion.every((d) => Math.hypot(d.x - x, d.y - y) > 9)
const { x: X, y: Y, ancho: W, alto: H } = limites
let saguaros = 0
let piedras = 0
for (let i = 0; i < 6000 && (saguaros < 34 || piedras < 26); i++) {
  const x = X + 8 + random() * (W - 16)
  const y = Y + 8 + random() * (H - 16)
  if (!libre(x, y)) continue
  const tipo = random() < 0.55 ? 'saguaro' : 'piedra'
  if (tipo === 'saguaro' && saguaros >= 34) continue
  if (tipo === 'piedra' && piedras >= 26) continue
  tipo === 'saguaro' ? saguaros++ : piedras++
  circuito.decoracion.push({ tipo, x: +x.toFixed(1), y: +y.toFixed(1), escala: +(0.8 + random() * 0.6).toFixed(2) })
}

fs.writeFileSync(`${back}/content/juego/circuitos/desierto.json`, JSON.stringify(circuito, null, 1) + '\n')
console.log(
  'longitud',
  pista.longitud.toFixed(1),
  'm | rectas',
  recta.toFixed(1),
  'm | radio de las curvas',
  radio,
  'm | en el lago',
  enElLago.length,
  '| lago, a',
  ORILLA,
  'm del camino | puntos',
  centro.length,
  '| cajas',
  circuito.cajas.length,
  '| saguaros',
  saguaros,
  '| piedras',
  piedras,
)
