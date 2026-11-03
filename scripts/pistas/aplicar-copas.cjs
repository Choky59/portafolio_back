// Le pone a cada pista de una copa (content/juego/copas.json) lo que la hace de esa copa: sus items
// (sin `items`, los de siempre), lo que tiran sus espectadores (sin `espectador`, meteoritos) y si
// salen los vendedores de la calle (`calle: false` para quitarlos). Las pistas `enPreparacion` (de
// una copa que todavía no está lista) también lo reciben, pero quedan ocultas.
// Correrlo después de cualquier generador de pistas: node scripts/pistas/aplicar-copas.cjs
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, '..', '..', 'content', 'juego')
const copas = JSON.parse(fs.readFileSync(path.join(DIR, 'copas.json'), 'utf8'))
const items = JSON.parse(fs.readFileSync(path.join(DIR, 'items.json'), 'utf8'))

for (const copa of copas) {
  for (const id of [...(copa.items ?? []), copa.espectador].filter(Boolean)) {
    const item = items.find((i) => i.id === id)
    if (!item) throw new Error(`${copa.id}: no existe el item ${id}`)
    if (item.copa !== copa.id && id !== 'meteorito') throw new Error(`${copa.id}: el item ${id} es de la copa ${item.copa}`)
  }
  const pistas = [...copa.pistas.map((id) => [id, false]), ...(copa.enPreparacion ?? []).map((id) => [id, true])]
  for (const [id, oculta] of pistas) {
    const archivo = path.join(DIR, 'circuitos', `${id}.json`)
    const circuito = JSON.parse(fs.readFileSync(archivo, 'utf8'))
    const antes = JSON.stringify(circuito)
    const poner = (campo, valor) => (valor === undefined ? delete circuito[campo] : (circuito[campo] = valor))
    poner('items', copa.items)
    poner('espectador', copa.espectador)
    poner('calle', copa.calle)
    poner('oculto', oculta || undefined)
    // Sin cambios, el archivo se queda como está (las pistas del desierto no se tocan)
    if (JSON.stringify(circuito) !== antes) fs.writeFileSync(archivo, JSON.stringify(circuito, null, 1) + '\n')
    console.log(`${copa.nombre} · ${circuito.nombre}${oculta ? ' (oculta, en preparación)' : ''}`)
  }
}
