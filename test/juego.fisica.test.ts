import { readFileSync } from "fs";
import path from "path";
import { Circuito, Controles, EstadoCarro } from "../src/juego/compartido/tipos";
import { prepararPista, proyectar, puntoEnPista, sueloEn } from "../src/juego/compartido/pista";
import {
  PARAMETROS_FISICA,
  avanzarCarro,
  colisionCarros,
  copiarCarro,
  crearCarro,
  rapidez,
} from "../src/juego/compartido/fisica";

const circuito: Circuito = JSON.parse(
  readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", "prueba.json"), "utf8"),
);
const pista = prepararPista(circuito);
const DT = 1 / 30;
const p = PARAMETROS_FISICA;

function correr(c: EstadoCarro, ctrl: Controles, ticks: number) {
  for (let i = 0; i < ticks; i++) avanzarCarro(c, ctrl, p, pista, DT);
  return c;
}

const ACELERAR: Controles = { giro: 0, acel: 1, freno: 0, mano: false };

describe("pista", () => {
  it("smooths a closed centerline and measures its length", () => {
    expect(pista.puntos.length).toBeGreaterThan(circuito.centro.length * 5);
    expect(pista.longitud).toBeGreaterThan(800);
    expect(pista.longitud).toBeLessThan(1400);
  });

  it("projects points on the centerline back to their progress", () => {
    for (const s of [0, 100, 333, pista.longitud - 10]) {
      const punto = puntoEnPista(pista, s);
      const proy = proyectar(pista, punto.x, punto.y);
      expect(proy.distancia).toBeLessThan(0.01);
      expect(proy.s).toBeCloseTo(s, 1);
    }
  });

  it("is asphalt on the road, dirt off it, and zones override", () => {
    const enCamino = puntoEnPista(pista, 50);
    expect(sueloEn(pista, enCamino.x, enCamino.y)).toBe("asfalto");
    const fuera = puntoEnPista(pista, 50, pista.mitad + 5);
    expect(sueloEn(pista, fuera.x, fuera.y)).toBe("tierra");
    expect(sueloEn(pista, -40, 190)).toBe("tierra");
  });
});

describe("fisica", () => {
  it("is deterministic: same inputs give the same state", () => {
    const giros = Array.from({ length: 200 }, (_, i) => Math.sin(i / 9));
    const simular = () => {
      const c = crearCarro(pista, 0);
      giros.forEach((giro, i) => avanzarCarro(c, { giro, acel: 1, freno: 0, mano: i % 50 > 40 }, p, pista, DT));
      return c;
    };
    expect(simular()).toEqual(simular());
  });

  it("accelerates fast and tops out at the max speed", () => {
    const c = crearCarro(pista, 0);
    correr(c, ACELERAR, 30);
    expect(rapidez(c)).toBeGreaterThan(18); // arcade: ~20 m/s en un segundo
    correr(c, ACELERAR, 30);
    expect(rapidez(c)).toBeLessThanOrEqual(p.velocidadMax + 0.01);
  });

  it("slides much more with the handbrake than in a normal turn", () => {
    const base = correr(crearCarro(pista, 0), ACELERAR, 25);
    const normal = correr(copiarCarro(base), { giro: 1, acel: 1, freno: 0, mano: false }, 8);
    const mano = correr(copiarCarro(base), { giro: 1, acel: 1, freno: 0, mano: true }, 8);
    // Velocidad de lado (no `derrape`, que se satura en 1)
    const lateral = (c: EstadoCarro) => Math.abs(-c.vx * Math.sin(c.angulo) + c.vy * Math.cos(c.angulo));
    expect(lateral(mano)).toBeGreaterThan(lateral(normal) * 1.5);
  });

  it("is slower on dirt than on asphalt", () => {
    const asfalto = crearCarro(pista, 0);
    asfalto.suelo = "asfalto";
    const tierra = crearCarro(pista, 0, pista.mitad + 20);
    correr(asfalto, ACELERAR, 20);
    correr(tierra, ACELERAR, 20);
    expect(tierra.suelo).toBe("tierra");
    expect(rapidez(tierra)).toBeLessThan(rapidez(asfalto) * 0.8);
  });

  it("never leaves the world limits", () => {
    const c = crearCarro(pista, 0);
    c.angulo = -Math.PI / 2; // hacia el muro de arriba, por la tierra
    correr(c, ACELERAR, 300);
    const { x, y, ancho, alto } = circuito.limites;
    expect(c.y).toBeGreaterThanOrEqual(y);
    expect(c.x).toBeGreaterThanOrEqual(x);
    expect(c.x).toBeLessThanOrEqual(x + ancho);
    expect(c.y).toBeLessThanOrEqual(y + alto);
  });

  it("separates two overlapping cars and keeps momentum", () => {
    const a = crearCarro(pista, 0);
    const b = crearCarro(pista, 0.5);
    a.vx = 10;
    const antes = a.vx + b.vx;
    colisionCarros(a, b, p);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(p.radio * 2, 5);
    expect(a.vx + b.vx).toBeCloseTo(antes, 5);
    expect(b.vx).toBeGreaterThan(0);
  });
});
