// Copa Desierto · Dunas: ~900 m y 3 carriles en forma de riñón, con el camino subiendo y bajando
// dunas, una rampa en la recta de atrás y remolinos de arena que cruzan.
const c = require('./comun.cjs')

const CARRILES = 3
const ANCHO = CARRILES * 7
const random = c.azar(9001)

const centro = c.aLargo(
  [[0, 0], [60, -18], [120, -8], [160, 25], [152, 78], [112, 96], [76, 78], [44, 102], [0, 112], [-42, 84], [-52, 36]],
  900,
  ANCHO,
)
const circuito = {
  id: 'dunas',
  nombre: 'Dunas',
  centro,
  ancho: ANCHO,
  carriles: CARRILES,
  limites: c.limitesDe(centro, 75),
  superficies: [],
  barrancos: [],
  muros: [],
  cajas: [],
  elevacion: [],
  decoracion: [],
}
let pista = c.prepararPista(circuito)

// Las dunas: tres sobre el camino (se sube y se baja) y más alrededor
for (const [s, altura, radio] of [[170, 5, 30], [430, 6, 34], [660, 4.5, 26]]) {
  const p = c.puntoEnPista(pista, s)
  circuito.elevacion.push({ x: c.r1(p.x), y: c.r1(p.y), radio, altura })
}
for (let i = 0; i < 9; i++) {
  const { x, y, ancho, alto } = circuito.limites
  const px = x + random() * ancho
  const py = y + random() * alto
  if (c.proyectar(pista, px, py).distancia < pista.mitad + 25) continue
  circuito.elevacion.push({ x: c.r1(px), y: c.r1(py), radio: 25 + Math.round(random() * 25), altura: 5 + Math.round(random() * 8) })
}

circuito.rampas = [c.rampa(pista, 330, 0)]
circuito.cajas = c.filasDeCajas(pista, [100, 390, 720], CARRILES)
circuito.ambiente = [c.cruce(pista, 'remolino', 240, { velocidad: 3.5 }), c.cruce(pista, 'remolino', 580, { velocidad: 3 })]
pista = c.prepararPista(circuito)
c.regar(circuito, pista, random, [['saguaro', 26], ['piedra', 22, 0.8, 1.6]])
c.escribir(circuito)
