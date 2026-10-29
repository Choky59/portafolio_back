import { readdirSync, readFileSync } from "fs";
import path from "path";
import { Circuito, Vec } from "../src/juego/compartido/tipos";
import { dentroDe, enAgua, prepararPista, proyectar, puntoEnPista, puntosMuro } from "../src/juego/compartido/pista";

const DIR = path.join(__dirname, "..", "content", "juego", "circuitos");
const circuitos: Circuito[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(path.join(DIR, f), "utf8")));

/** Distance from a point to a polyline (closed if the polygon flag is set) */
function distanciaALinea(x: number, y: number, linea: Vec[], cerrada: boolean): number {
  let minimo = Infinity;
  const n = cerrada ? linea.length : linea.length - 1;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = linea[i];
    const [bx, by] = linea[(i + 1) % linea.length];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    minimo = Math.min(minimo, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return minimo;
}

describe.each(circuitos.map((c) => [c.id, c] as const))("circuit %s", (_, circuito) => {
  const pista = prepararPista(circuito);
  // The centerline every meter
  const muestras = Array.from({ length: Math.floor(pista.longitud) }, (_, s) => puntoEnPista(pista, s));

  it("never crosses or brushes against itself", () => {
    const paso = 4;
    for (let i = 0; i < muestras.length; i += paso) {
      for (let j = i + paso; j < muestras.length; j += paso) {
        // Points close along the track are naturally close: only far-apart stretches count
        const separacion = Math.min(j - i, pista.longitud - (j - i));
        if (separacion < circuito.ancho * 3) continue;
        const d = Math.hypot(muestras[i].x - muestras[j].x, muestras[i].y - muestras[j].y);
        if (d < circuito.ancho + 2) throw new Error(`s=${i} and s=${j} are only ${d.toFixed(1)} m apart`);
      }
    }
  });

  it("keeps cliffs off the road, with a dirt shoulder before the drop", () => {
    for (const barranco of circuito.barrancos) {
      for (const p of muestras) {
        expect(dentroDe(barranco, p.x, p.y)).toBe(false);
        expect(distanciaALinea(p.x, p.y, barranco, true)).toBeGreaterThan(pista.mitad + 3);
      }
    }
  });

  it("keeps the water (sea, marina) off the road, with some land before it", () => {
    for (const agua of circuito.agua ?? []) {
      for (const p of muestras) {
        expect(dentroDe(agua, p.x, p.y)).toBe(false);
        expect(distanciaALinea(p.x, p.y, agua, true)).toBeGreaterThan(pista.mitad + 4);
      }
    }
  });

  it("keeps the visual zones (beach, sidewalks…) from covering the road unless they're meant to", () => {
    // Only the dirt riverbed (Vado del Río) is supposed to cross the road
    for (const zona of circuito.superficies.filter((z) => z.estilo === "playa")) {
      for (const p of muestras) expect(dentroDe(zona.poligono, p.x, p.y)).toBe(false);
    }
  });

  it("keeps walls and buildings off the road", () => {
    for (const muro of circuito.muros) {
      const linea = puntosMuro(muro);
      for (const p of muestras) expect(distanciaALinea(p.x, p.y, linea, false)).toBeGreaterThan(pista.mitad + 1);
    }
  });

  it("puts every item box on the road (never in the water)", () => {
    for (const [x, y] of circuito.cajas) {
      expect(proyectar(pista, x, y).distancia).toBeLessThan(pista.mitad - 1);
      expect(enAgua(pista, x, y)).toBe(false);
    }
  });

  it("boats float on the water and everything else is on land", () => {
    for (const d of circuito.decoracion) expect(enAgua(pista, d.x, d.y)).toBe(!!d.flota);
  });

  it("has a clear starting grid", () => {
    for (let s = -24; s <= 0; s += 2) {
      for (const lateral of [-pista.mitad * 0.45, pista.mitad * 0.45]) {
        const p = puntoEnPista(pista, s, lateral);
        expect(circuito.barrancos.some((b) => dentroDe(b, p.x, p.y))).toBe(false);
      }
    }
  });

  it("fits inside the world", () => {
    const { x, y, ancho, alto } = circuito.limites;
    for (const p of muestras) {
      expect(p.x - pista.mitad).toBeGreaterThan(x);
      expect(p.y - pista.mitad).toBeGreaterThan(y);
      expect(p.x + pista.mitad).toBeLessThan(x + ancho);
      expect(p.y + pista.mitad).toBeLessThan(y + alto);
    }
  });
});
