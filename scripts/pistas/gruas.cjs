// Copa Construcción · Grúas: ~1.1 km y 4 carriles, con una recta larga entre contenedores y grúas
// torre, por donde va y viene la aplanadora.
const c = require('./comun.cjs')

const CARRILES = 4
const ANCHO = CARRILES * 7
const random = c.azar(1212)
const centro = c.aLargo(
  [[0, 0], [200, 0], [262, 30], [272, 92], [222, 134], [152, 122], [92, 152], [20, 142], [-32, 100], [-32, 40]],
  1100,
  ANCHO,
)
const circuito = {
  id: 'gruas',
  nombre: 'Grúas',
  terreno: 'obra',
  centro,
  ancho: ANCHO,
  carriles: CARRILES,
  limites: c.limitesDe(centro, 80),
  superficies: [],
  barrancos: [],
  muros: [],
  cajas: [],
  decoracion: [],
}
let pista = c.prepararPista(circuito)

// Contenedores de colores a lo largo de la recta y en las curvas
const CONTENEDORES = ['#C9473A', '#4F8FE8', '#5FAF8C', '#F2C230', '#9C6ADE']
for (let k = 0; k < 16; k++) {
  const s = (k / 16) * pista.longitud + random() * 25
  circuito.muros.push(c.alLado(pista, s, k % 2 ? 1 : -1, 6 + random() * 10, 12, 5, { alto: 5 + (k % 3 === 0 ? 5 : 0), color: CONTENEDORES[k % CONTENEDORES.length] }))
}

circuito.cajas = c.filasDeCajas(pista, [140, 480, 820], CARRILES)
circuito.ambiente = [c.cruce(pista, 'aplanadora', 110, { velocidad: 4.5, pausa: 1.2 })]
pista = c.prepararPista(circuito)
c.regar(circuito, pista, random, [['grua-torre', 4, 1, 1.2], ['revolvedora', 3, 1, 1], ['tubos', 5, 0.9, 1.3], ['caseta', 2, 1, 1]], { delCamino: 10, entreSi: 16 })
for (let k = 0; k < 22; k++) {
  const p = c.puntoEnPista(pista, (k / 22) * pista.longitud + 4, (k % 2 ? 1 : -1) * (pista.mitad + 2.2))
  if (c.libre(circuito, pista, p.x, p.y, { delCamino: 1.5, entreSi: 3 })) circuito.decoracion.push({ tipo: 'cono', x: c.r1(p.x), y: c.r1(p.y), escala: 1 })
}
c.regar(circuito, pista, random, [['piedra', 12, 0.6, 1]])
c.escribir(circuito)
