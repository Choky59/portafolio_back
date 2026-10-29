import { readFileSync } from "fs";
import path from "path";
import { Circuito, Controles, EstadoCarro } from "../src/juego/compartido/tipos";
import { prepararPista, proyectar, puntoEnPista, sueloEn } from "../src/juego/compartido/pista";
import {
  PARAMETROS_FISICA,
  avanzarCarro,
  chocarCarros,
  circulosCarro,
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

  it("item effects: stunned ignores the controls and spins, then wears off", () => {
    const c = correr(crearCarro(pista, 0), ACELERAR, 20);
    const v = rapidez(c);
    c.aturdido = 10;
    correr(c, ACELERAR, 10);
    expect(rapidez(c)).toBeLessThan(v); // no throttle while stunned
    expect(Math.abs(c.w)).toBeGreaterThan(3);
    expect(c.aturdido).toBe(0);
  });

  it("item effects: sliding, heat and turbo change grip and top speed", () => {
    const giro: Controles = { giro: 1, acel: 1, freno: 0, mano: false };
    const base = correr(crearCarro(pista, 0), ACELERAR, 25);
    const normal = correr(copiarCarro(base), giro, 8);
    const mojado = copiarCarro(base);
    mojado.resbalon = 100;
    correr(mojado, giro, 8);
    const lateral = (c: EstadoCarro) => Math.abs(-c.vx * Math.sin(c.angulo) + c.vy * Math.cos(c.angulo));
    expect(lateral(mojado)).toBeGreaterThan(lateral(normal) * 2);

    const lento = crearCarro(pista, 0);
    lento.lento = 1000;
    correr(lento, ACELERAR, 90);
    expect(rapidez(lento)).toBeLessThanOrEqual(p.velocidadMax * p.efectos.lentoVelocidad + 0.01);

    const turbo = crearCarro(pista, 0);
    turbo.turbo = 1000;
    correr(turbo, { ...ACELERAR, acel: 0 }, 60); // the turbo floors it by itself
    expect(rapidez(turbo)).toBeGreaterThan(p.velocidadMax);
  });

  describe("coletazo (tail whip)", () => {
    /** A car drifting with its tail swinging toward +y, and another one right beside its tail */
    function escena(w: number, vx = 5) {
      const atacante = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx, vy: 0, w };
      const victima = { ...crearCarro(pista, 0), x: -1.5, y: 2, angulo: 0, vx: 0, vy: 0, w: 0 };
      return { atacante, victima };
    }

    it("a fast swinging tail sends the other car spinning", () => {
      const { atacante, victima } = escena(-8);
      const r = chocarCarros(atacante, victima, p, 30);
      expect(r.descontrolados).toEqual([victima]);
      expect(victima.trompo).toBeGreaterThan(10);
      expect(Math.abs(victima.w)).toBeGreaterThan(2);
      expect(atacante.trompo).toBe(0);
    });

    it("a slow tail only bumps", () => {
      const { atacante, victima } = escena(-2);
      expect(chocarCarros(atacante, victima, p, 30).descontrolados).toEqual([]);
      expect(victima.trompo).toBe(0);
    });

    it("hitting with the nose is a normal crash, not a coletazo", () => {
      const atacante = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 25, vy: 0, w: -6 };
      const victima = { ...crearCarro(pista, 0), x: 2.4, y: 0.3, vx: 0, vy: 0, w: 0 };
      const r = chocarCarros(atacante, victima, p, 30);
      expect(r.fuerza).toBeGreaterThan(10);
      expect(r.descontrolados).toEqual([]);
    });

    it("while spinning the wheel does nothing and the tires barely grip", () => {
      const base = correr(crearCarro(pista, 0), ACELERAR, 25);
      const normal = correr(copiarCarro(base), { giro: 1, acel: 1, freno: 0, mano: false }, 6);
      const trompo = copiarCarro(base);
      trompo.trompo = 30;
      trompo.w = 4;
      correr(trompo, { giro: -1, acel: 1, freno: 0, mano: false }, 6);
      // Steering left did nothing: it kept spinning right
      expect(trompo.w).toBeGreaterThan(0);
      const lateral = (c: EstadoCarro) => Math.abs(-c.vx * Math.sin(c.angulo) + c.vy * Math.cos(c.angulo));
      expect(lateral(trompo)).toBeGreaterThan(lateral(normal));
      expect(trompo.trompo).toBe(24);
    });
  });

  it("the hitbox covers the whole car: nose to tail contact is a crash", () => {
    // B right behind A, bumpers 0.6 m apart: one circle each wouldn't touch, three do
    const a = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 0, vy: 0, w: 0 };
    const b = { ...crearCarro(pista, 0), x: -3.8, y: 0, angulo: 0, vx: 15, vy: 0, w: 0 };
    expect(colisionCarros(a, b, p)).toBeGreaterThan(10);
    expect(a.vx).toBeGreaterThan(5);
  });

  it("a hit off-center makes the car turn", () => {
    const a = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 0, vy: 0, w: 0 };
    // B hits A's nose from the side
    const b = { ...crearCarro(pista, 0), x: 1.2, y: 2.1, angulo: Math.PI / 2, vx: 0, vy: -15, w: 0 };
    colisionCarros(a, b, p);
    expect(Math.abs(a.w)).toBeGreaterThan(1);
  });

  it("separates two overlapping cars and keeps momentum", () => {
    const a = crearCarro(pista, 0);
    const b = crearCarro(pista, 0.5);
    a.vx = 10;
    const antes = a.vx + b.vx;
    colisionCarros(a, b, p);
    // No circle of one car stays inside a circle of the other
    for (const ca of circulosCarro(a)) {
      for (const cb of circulosCarro(b)) expect(Math.hypot(cb.x - ca.x, cb.y - ca.y)).toBeGreaterThan(p.radio * 2 - 0.3);
    }
    expect(a.vx + b.vx).toBeCloseTo(antes, 5);
    expect(b.vx).toBeGreaterThan(0);
  });
});
