/**
 * Lo que comparten los generadores de pistas (scripts/pistas/*.cjs). Cada generador describe su
 * pista (forma, muros, relieve, decoración, peligros) y escribe content/juego/circuitos/<id>.json.
 *
 * Usan el código compilado del juego (build/), así que antes: npx tsc -p .
 * Después de generar: node scripts/pistas/aplicar-copas.cjs (pone a cada pista los items y el
 * espectador de su copa) y npm test (revisa que cada pista sea jugable).
 */
const fs = require('fs')
const path = require('path')

const RAIZ = path.join(__dirname, '..', '..')
const pistaJs = require(path.join(RAIZ, 'build', 'juego', 'compartido', 'pista'))
const { prepararPista, puntoEnPista, proyectar, dentroDe } = pistaJs

/** Números al azar repetibles (la misma semilla, la misma pista) */
function azar(semilla) {
  let s = semilla >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const r1 = (n) => +n.toFixed(1)
const MUNDO_GRANDE = { x: -2000, y: -2000, ancho: 4000, alto: 4000 }

/**
 * Escala los puntos de control (`forma`: [[x, y]…] a cualquier tamaño) hasta que la vuelta, ya
 * suavizada como la suaviza el juego, mida `metros`. Regresa los puntos escalados
 */
function aLargo(forma, metros, ancho) {
  let escala = 1
  const medir = (e) => prepararPista({ centro: forma.map(([x, y]) => [x * e, y * e]), ancho, muros: [], limites: MUNDO_GRANDE }).longitud
  for (let i = 0; i < 40; i++) escala *= metros / medir(escala)
  return forma.map(([x, y]) => [r1(x * escala), r1(y * escala)])
}

/** El rectángulo del mundo: la pista y todo lo que se dibuja, más un margen */
function limitesDe(puntos, margen) {
  const xs = puntos.map((p) => p[0])
  const ys = puntos.map((p) => p[1])
  const x = Math.min(...xs) - margen
  const y = Math.min(...ys) - margen
  return { x: r1(x), y: r1(y), ancho: r1(Math.max(...xs) + margen - x), alto: r1(Math.max(...ys) + margen - y) }
}

/** Filas de cajas de items a lo ancho del camino, una por carril, en los metros `ss` de la vuelta */
function filasDeCajas(pista, ss, carriles) {
  const cajas = []
  const ancho = (pista.mitad * 2) / carriles
  for (const s of ss) {
    for (let k = 0; k < carriles; k++) {
      const p = puntoEnPista(pista, s, -pista.mitad + ancho * (k + 0.5))
      cajas.push([r1(p.x), r1(p.y)])
    }
  }
  return cajas
}

/** Una rampa de salto en el metro `s`, centrada en `lateral`, con su caja flotando adelante */
function rampa(pista, s, lateral = 0, { largo = 7, ancho = 6, alto = 1.6 } = {}) {
  const p = puntoEnPista(pista, s, lateral)
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), angulo: +p.angulo.toFixed(4), largo, ancho, alto, caja: { distancia: 15, altura: 3 } }
}

/** Un rectángulo cerrado (para muros: edificios, contenedores, peñascos) */
function rect(cx, cy, w, h, angulo = 0) {
  const c = Math.cos(angulo)
  const s = Math.sin(angulo)
  const esquinas = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [r1(cx + x * c - y * s), r1(cy + x * s + y * c)])
  return [...esquinas, esquinas[0]]
}

/** Un muro paralelo al camino, a `distancia` de la orilla (lado +1 derecha, -1 izquierda), en el metro `s` */
function alLado(pista, s, lado, distancia, largo, grueso, extra = {}) {
  const p = puntoEnPista(pista, s, lado * (pista.mitad + distancia + grueso / 2))
  return { puntos: rect(p.x, p.y, largo, grueso, p.angulo), ...extra }
}

/** +1 si la derecha del camino (lateral positivo) es el lado de afuera del circuito, -1 si es el de adentro */
function ladoDeAfuera(pista) {
  const p = puntoEnPista(pista, 0, 10)
  return dentroDe(pista.puntos, p.x, p.y) ? -1 : 1
}

/**
 * Una franja paralela al camino entre los metros s0 y s1, de `desde` a `hasta` metros de la
 * orilla, del lado `lado` (+1 derecha, -1 izquierda): para barrancos, pozos y bordes de cañada.
 * `desde` puede variar con s (una función), para que la orilla se acerque y se aleje
 */
function franja(pista, { lado, s0, s1, desde, hasta, paso = 6 }) {
  const cerca = []
  const lejos = []
  const d = typeof desde === 'function' ? desde : () => desde
  for (let s = s0; s <= s1 + 0.01; s += paso) {
    const a = puntoEnPista(pista, s, lado * (pista.mitad + d(s)))
    const b = puntoEnPista(pista, s, lado * (pista.mitad + hasta))
    cerca.push([r1(a.x), r1(a.y)])
    lejos.push([r1(b.x), r1(b.y)])
  }
  return [...cerca, ...lejos.reverse()]
}

/** ¿Está (x, y) libre para decorar? Lejos del camino, fuera del agua, barrancos, muros y otros adornos */
function libre(circuito, pista, x, y, { delCamino = 7, entreSi = 8 } = {}) {
  return (
    proyectar(pista, x, y).distancia > pista.mitad + delCamino &&
    !(circuito.agua ?? []).some((a) => dentroDe(a, x, y)) &&
    !circuito.barrancos.some((b) => dentroDe(b, x, y)) &&
    !circuito.muros.some((m) => dentroDe(m.puntos ?? m, x, y)) &&
    circuito.decoracion.every((d) => Math.hypot(d.x - x, d.y - y) > entreSi)
  )
}

/** Riega decoración al azar: `tipos` es [[tipo, cuántos, escalaMin, escalaMax], …] */
function regar(circuito, pista, random, tipos, opciones) {
  const { x: X, y: Y, ancho: W, alto: H } = circuito.limites
  for (const [tipo, cuantos, eMin = 0.8, eMax = 1.3] of tipos) {
    let puestos = 0
    for (let i = 0; i < cuantos * 200 && puestos < cuantos; i++) {
      const x = X + 6 + random() * (W - 12)
      const y = Y + 6 + random() * (H - 12)
      if (!libre(circuito, pista, x, y, opciones)) continue
      circuito.decoracion.push({ tipo, x: r1(x), y: r1(y), escala: +(eMin + random() * (eMax - eMin)).toFixed(2) })
      puestos++
    }
  }
}

/** Un peligro del ambiente que cruza el camino de orilla a orilla en el metro `s` */
function cruce(pista, item, s, { velocidad = 4, pausa = 1, sobra = 3 } = {}) {
  return { item, s: Math.round(s), desde: -(pista.mitad + sobra), hasta: pista.mitad + sobra, velocidad, pausa }
}

/**
 * Revisa lo básico antes de escribir (las pruebas revisan todo): el largo, y que el camino no se
 * cruce ni se roce consigo mismo (puntos lejanos de la vuelta a menos de un camino y medio)
 */
function revisar(circuito, { maximo = 1400 } = {}) {
  const pista = prepararPista(circuito)
  if (pista.longitud > maximo) throw new Error(`${circuito.id}: mide ${pista.longitud.toFixed(0)} m (máximo ${maximo})`)
  const paso = 6
  const muestras = []
  for (let s = 0; s < pista.longitud; s += paso) muestras.push({ s, ...puntoEnPista(pista, s) })
  for (const a of muestras) {
    for (const b of muestras) {
      const separadas = Math.min(Math.abs(a.s - b.s), pista.longitud - Math.abs(a.s - b.s)) > pista.mitad * 6
      if (separadas && Math.hypot(a.x - b.x, a.y - b.y) < pista.mitad * 2 + 8) {
        throw new Error(`${circuito.id}: el camino se roza consigo mismo cerca de (${a.x.toFixed(0)}, ${a.y.toFixed(0)})`)
      }
    }
  }
  return pista
}

/** Distancia de (x, y) al segmento (x1, y1)–(x2, y2) */
function aSegmento(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(x - (x1 + dx * t), y - (y1 + dy * t))
}

/** Quita los muros que quedaron a menos de 2 m de la orilla (en las curvas una esquina se acerca) */
function quitarMurosPegados(circuito, pista) {
  const muestras = []
  for (let s = 0; s < pista.longitud; s += 2) muestras.push(puntoEnPista(pista, s))
  const antes = circuito.muros.length
  circuito.muros = circuito.muros.filter((muro) => {
    const p = muro.puntos ?? muro
    return muestras.every((m) => p.slice(1).every((b, i) => aSegmento(m.x, m.y, p[i][0], p[i][1], b[0], b[1]) > pista.mitad + 2))
  })
  if (circuito.muros.length < antes) console.log(`${circuito.id}: ${antes - circuito.muros.length} muro(s) muy pegados al camino, quitados`)
}

function escribir(circuito) {
  quitarMurosPegados(circuito, prepararPista(circuito))
  const pista = revisar(circuito)
  const archivo = path.join(RAIZ, 'content', 'juego', 'circuitos', `${circuito.id}.json`)
  fs.writeFileSync(archivo, JSON.stringify(circuito, null, 1) + '\n')
  console.log(`${circuito.id}: ${pista.longitud.toFixed(0)} m, ${circuito.carriles ?? 2} carriles, ${circuito.cajas.length} cajas, ${circuito.decoracion.length} adornos`)
  return pista
}

module.exports = { ...pistaJs, azar, r1, aLargo, limitesDe, filasDeCajas, rampa, rect, alLado, ladoDeAfuera, franja, libre, regar, cruce, revisar, escribir }
