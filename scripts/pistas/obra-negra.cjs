// Copa Construcción · Obra negra: ~800 m y 3 carriles entre edificios a medio construir, con dos
// rampas de tablones y la aplanadora cruzando la recta de atrás.
const c = require('./comun.cjs')

const CARRILES = 3
const ANCHO = CARRILES * 7
const random = c.azar(777)
const centro = c.aLargo(
  [[0, 0], [110, 0], [140, 20], [140, 70], [115, 95], [88, 78], [58, 100], [18, 100], [-15, 75], [-15, 25]],
  800,
  ANCHO,
)
const circuito = {
  id: 'obra-negra',
  nombre: 'Obra negra',
  terreno: 'obra',
  centro,
  ancho: ANCHO,
  carriles: CARRILES,
  limites: c.limitesDe(centro, 70),
  superficies: [],
  barrancos: [],
  muros: [],
  cajas: [],
  decoracion: [],
}
let pista = c.prepararPista(circuito)

// Edificios en obra negra: bloques de concreto gris, de varios pisos, a los dos lados
const CONCRETO = ['#B8B4AC', '#A9A49B', '#C4BFB5']
for (let k = 0; k < 12; k++) {
  const s = (k / 12) * pista.longitud + 15 + random() * 20
  circuito.muros.push(c.alLado(pista, s, k % 2 ? 1 : -1, 5 + random() * 6, 16 + random() * 14, 12 + random() * 8, { alto: 9 + Math.round(random() * 10), color: CONCRETO[k % 3] }))
}

circuito.rampas = [c.rampa(pista, 190, 0), c.rampa(pista, 560, -4)]
circuito.cajas = c.filasDeCajas(pista, [110, 340, 650], CARRILES)
circuito.ambiente = [c.cruce(pista, 'aplanadora', 420, { velocidad: 3.5, pausa: 1.5 })]
pista = c.prepararPista(circuito)

// La obra: grúas torre, revolvedoras, una excavadora, tubos, la caseta y conos en las orillas
c.regar(circuito, pista, random, [['grua-torre', 2, 1, 1.1], ['revolvedora', 2, 1, 1], ['excavadora', 1, 1, 1], ['tubos', 4, 0.9, 1.2], ['caseta', 2, 1, 1]], { delCamino: 10, entreSi: 14 })
for (let k = 0; k < 18; k++) {
  const p = c.puntoEnPista(pista, (k / 18) * pista.longitud + 6, (k % 2 ? 1 : -1) * (pista.mitad + 2.2))
  if (c.libre(circuito, pista, p.x, p.y, { delCamino: 1.5, entreSi: 3 })) circuito.decoracion.push({ tipo: 'cono', x: c.r1(p.x), y: c.r1(p.y), escala: 1 })
}
c.regar(circuito, pista, random, [['piedra', 14, 0.6, 1]])
c.escribir(circuito)
