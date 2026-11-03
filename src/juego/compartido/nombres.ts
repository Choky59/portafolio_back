/**
 * Filtro de nombres: los jugadores ven los nombres de desconocidos (salas abiertas, etiquetas
 * sobre los carros), así que un nombre ofensivo no entra. Las tiendas lo piden para el contenido
 * que escriben los usuarios (App Store, regla 1.2).
 *
 * Se normaliza antes de comparar: minúsculas, sin acentos, "l33t" a letras (p3nd3jo) y letras
 * repetidas juntas (puuuta). Las palabras cortas solo cuentan como palabra completa, para no
 * bloquear nombres normales que las contienen ("computadora" tiene "puta"); las largas e
 * inconfundibles también dentro de otra palabra (xXpendejoXx).
 */

/** Palabras completas (también en plural o con -s) */
const PALABRAS = [
  // español
  "puta", "puto", "putas", "putos", "verga", "vergas", "culo", "culero", "culera", "chinga", "chingas",
  "mierda", "cabron", "cabrona", "joto", "marica", "mamon", "mamona", "mamada", "panocha", "zorra",
  "pendejo", "pendeja", "pinche", "ojete", "violador", "violar",
  "polla", "follar", "gilipollas", "malparido", "hijueputa", "perra",
  // inglés
  "fuck", "fucker", "shit", "bitch", "cunt", "dick", "cock", "pussy", "whore", "slut", "asshole", "bastard",
  "retard", "rape", "rapist", "porn", "nazi", "hitler", "kkk", "fag", "faggot", "nigger", "nigga", "tranny",
];

/** Inconfundibles: cuentan aunque estén pegadas a otras letras */
const RAICES = [
  "pendej", "chingad", "culer", "mierd", "maricon", "putit", "hijodeputa", "hdp",
  "fuck", "motherf", "nigger", "nigga", "faggot", "asshole", "hitler", "rapist",
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

/** Minúsculas, sin acentos y l33t a letras */
function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[013457@$!]/g, (c) => LEET[c] ?? c);
}

/** Sin letras repetidas juntas: "puuuta" → "puta" */
const colapsar = (texto: string) => texto.replace(/(.)\1+/g, "$1");

const PALABRAS_N = new Set(PALABRAS.map(normalizar));
const PALABRAS_C = new Set([...PALABRAS_N].map(colapsar));
const RAICES_N = RAICES.map(normalizar);
const RAICES_C = RAICES_N.map(colapsar);

/**
 * ¿Es ofensiva esta palabra? Tal cual, sin la -s final, o, si repite letras, sin repetirlas
 * ("puuuta"). Sin repetidas solo cuando el nombre las repite: "pera" no es "perra"
 */
function palabraOfensiva(p: string): boolean {
  for (const w of [p, p.replace(/s$/, "")]) {
    if (PALABRAS_N.has(w)) return true;
    const c = colapsar(w);
    if (c !== w && PALABRAS_C.has(c)) return true;
  }
  return false;
}

/** ¿El nombre tiene alguna palabra ofensiva? */
export function nombreOfensivo(nombre: string): boolean {
  const palabras = normalizar(nombre).split(/[^a-zñ]+/).filter(Boolean);
  if (palabras.some(palabraOfensiva)) return true;
  // Todo junto, sin espacios ni símbolos: "p.e.n.d.e.j.o", "xXfuckXx"
  const junto = palabras.join("");
  const juntoC = colapsar(junto);
  return RAICES_N.some((r) => junto.includes(r)) || (juntoC !== junto && RAICES_C.some((r) => juntoC.includes(r)));
}
