// Copa Construcción · Excavación: ~1.3 km y 2 carriles alrededor de un pozo enorme. En un tramo la
// orilla del pozo queda pegada al camino (ahí se cae seguido); montones de tierra y la aplanadora.
const c = require('./comun.cjs')

const random = c.azar(5050)
const centro = c.aLargo(
  [[0, 0], [150, -10], [222, 40], [232, 130], [182, 202], [90, 212], [10, 182], [-30, 110], [-20, 40]],
  1300,
  14,
)
const circuito = {
  id: 'excavacion',
  nombre: 'Excavación',
  terreno: 'obra',
  centro,
  ancho: 14,
  carriles: 2,
  limites: c.limitesDe(centro, 70),
  superficies: [],
  barrancos: [],
  muros: [],
  cajas: [],
  elevacion: [],
  decoracion: [],
}
let pista = c.prepararPista(circuito)
const adentro = -c.ladoDeAfuera(pista)

// El pozo: todo el centro, que se acerca a 3.5 m de la orilla en un tramo y se aleja en el resto
const L = pista.longitud
const cerca = (s) => {
  const t = s / L
  // De 0.3 a 0.55 de la vuelta, pegado; transiciones suaves antes y después
  const pegado = t > 0.3 && t < 0.55 ? 1 : t > 0.22 && t <= 0.3 ? (t - 0.22) / 0.08 : t >= 0.55 && t < 0.63 ? (0.63 - t) / 0.08 : 0
  return 3.5 + (1 - pegado) * 22
}
circuito.barrancos.push(c.franja(pista, { lado: adentro, s0: 0, s1: L - 6, desde: cerca, hasta: 300, paso: 6 }).slice(0, Math.floor(L / 6) + 1))

// Montones de tierra alrededor, por fuera
for (let i = 0; i < 8; i++) {
  const p = c.puntoEnPista(pista, random() * L, -adentro * (pista.mitad + 25 + random() * 25))
  circuito.elevacion.push({ x: c.r1(p.x), y: c.r1(p.y), radio: 14 + Math.round(random() * 10), altura: 3 + Math.round(random() * 4) })
}

circuito.cajas = c.filasDeCajas(pista, [120, 470, 820, 1150], 2)
circuito.ambiente = [c.cruce(pista, 'aplanadora', 960, { velocidad: 3.2, pausa: 1.5 })]
pista = c.prepararPista(circuito)
c.regar(circuito, pista, random, [['excavadora', 3, 1, 1.1], ['revolvedora', 2, 1, 1], ['grua-torre', 1, 1, 1], ['tubos', 4, 0.9, 1.2], ['caseta', 1, 1, 1]], { delCamino: 9, entreSi: 14 })
c.regar(circuito, pista, random, [['piedra', 20, 0.6, 1.2]])
c.escribir(circuito)
