// Copa Desierto · Cañada seca: ~1.3 km y 2 carriles de curvas cerradas entre mesas de roca, con un
// barranco a la orilla de la curva larga (el que se abre mucho, se cae) y un remolino.
const c = require('./comun.cjs')

const random = c.azar(4242)
const centro = c.aLargo(
  [[0, 0], [80, -10], [150, 10], [190, 60], [170, 120], [210, 170], [200, 240], [140, 262], [90, 222], [40, 252], [-20, 232], [-52, 170], [-22, 120], [-62, 70], [-50, 20]],
  1300,
  14,
)
const circuito = {
  id: 'canada',
  nombre: 'Cañada seca',
  centro,
  ancho: 14,
  carriles: 2,
  limites: c.limitesDe(centro, 80),
  superficies: [],
  barrancos: [],
  muros: [],
  cajas: [],
  elevacion: [],
  decoracion: [],
}
let pista = c.prepararPista(circuito)
const afuera = c.ladoDeAfuera(pista)

// El barranco: por fuera de la curva larga de la derecha, a 4 m de la orilla y 30 de hondo
circuito.barrancos.push(c.franja(pista, { lado: afuera, s0: pista.longitud * 0.36, s1: pista.longitud * 0.5, desde: 4, hasta: 32 }))

// Mesas de roca a los dos lados de la cañada: muros cafés, altos
const ROCA = ['#B5754A', '#A5663F', '#C08457']
for (let k = 0; k < 14; k++) {
  const s = (k / 14) * pista.longitud + random() * 30
  const lado = k % 2 ? afuera : -afuera
  if (lado === afuera && s > pista.longitud * 0.33 && s < pista.longitud * 0.53) continue // ahí está el barranco
  circuito.muros.push(c.alLado(pista, s, lado, 6 + random() * 8, 18 + random() * 22, 8 + random() * 8, { alto: 8 + Math.round(random() * 12), color: ROCA[k % 3] }))
}
for (let i = 0; i < 6; i++) {
  const { x, y, ancho, alto } = circuito.limites
  circuito.elevacion.push({ x: c.r1(x + random() * ancho), y: c.r1(y + random() * alto), radio: 30 + Math.round(random() * 20), altura: 6 + Math.round(random() * 10) })
}

circuito.cajas = c.filasDeCajas(pista, [150, 500, 850, 1150], 2)
circuito.ambiente = [c.cruce(pista, 'remolino', 650, { velocidad: 3.2 })]
pista = c.prepararPista(circuito)
c.regar(circuito, pista, random, [['saguaro', 30], ['piedra', 30, 0.9, 1.8]])
c.escribir(circuito)
