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
  pasoCarro,
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

  it("reverses as fast as it drives forward", () => {
    // Without walls: just the car's own physics, on asphalt
    const frente = crearCarro(pista, 0);
    const reversa = crearCarro(pista, 0);
    for (let i = 0; i < 150; i++) {
      pasoCarro(frente, ACELERAR, p, DT);
      pasoCarro(reversa, { giro: 0, acel: 0, freno: 1, mano: false }, p, DT);
    }
    const adelante = (c: EstadoCarro) => c.vx * Math.cos(c.angulo) + c.vy * Math.sin(c.angulo);
    expect(adelante(frente)).toBeCloseTo(p.velocidadMax, 0);
    expect(adelante(reversa)).toBeCloseTo(-p.velocidadMax, 0);
  });

  it("gives a car at the edge of the picture (rezago) more top speed and acceleration", () => {
    const normal = crearCarro(pista, 0);
    const rezagado = { ...crearCarro(pista, 0), rezago: 1e6 };
    pasoCarro(normal, ACELERAR, p, DT);
    pasoCarro(rezagado, ACELERAR, p, DT);
    expect(rapidez(rezagado) / rapidez(normal)).toBeCloseTo(p.efectos.rezagoAceleracion, 5);
    for (let i = 0; i < 200; i++) {
      pasoCarro(normal, ACELERAR, p, DT);
      pasoCarro(rezagado, ACELERAR, p, DT);
    }
    expect(rapidez(rezagado) / rapidez(normal)).toBeCloseTo(p.efectos.rezagoVelocidad, 2);
    // It wears off one step per control, like the item effects
    const c = { ...crearCarro(pista, 0), rezago: 3 };
    correr(c, ACELERAR, 3);
    expect(c.rezago).toBe(0);
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
      // Bumpers 0.3 m into each other: what a 60 Hz step at this speed actually produces
      const atacante = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 25, vy: 0, w: -6 };
      const victima = { ...crearCarro(pista, 0), x: 4.6, y: 0.3, angulo: 0, vx: 0, vy: 0, w: 0 };
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

  it("rubbing a car's side drags it along (to push it off the road)", () => {
    // A passes B at speed and leans into it: B gets pushed sideways AND dragged forward
    const a = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 30, vy: 4, w: 0 };
    const b = { ...crearCarro(pista, 0), x: 0.5, y: 2.3, angulo: 0, vx: 0, vy: 0, w: 0 };
    colisionCarros(a, b, p);
    expect(b.vy).toBeGreaterThan(1.2); // shoved away (one contact: the push off the road is the empujón)
    expect(b.vx).toBeGreaterThan(1); // and dragged along by the friction
    // A soft hit: it pushes rather than bounces
    expect(a.vy).toBeGreaterThan(-1);
  });

  it("a hit off-center makes the car turn", () => {
    const a = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 0, vy: 0, w: 0 };
    // B hits A's nose from the side
    const b = { ...crearCarro(pista, 0), x: 1.2, y: 2.1, angulo: Math.PI / 2, vx: 0, vy: -15, w: 0 };
    colisionCarros(a, b, p);
    expect(Math.abs(a.w)).toBeGreaterThan(1);
  });

  describe("recobro (help getting out of a crash without oversteering, people only)", () => {
    const BOT = { ...p, recobro: { ...p.recobro, activo: false } };
    /** A car cruising down the track that was just hit: spinning right, without grip for a moment */
    function golpeado() {
      const c = correr(crearCarro(pista, 0), ACELERAR, 30);
      c.empujon = p.choque.empujon.duracion;
      c.w = 3;
      return c;
    }
    /** Runs `ticks` with that steering and those params; returns the car and its most negative turn rate */
    function salir(params: typeof p, giro: number, ticks: number) {
      const c = golpeado();
      let minW = 0;
      for (let i = 0; i < ticks; i++) {
        avanzarCarro(c, { giro, acel: 1, freno: 0, mano: false }, params, pista, DT);
        minW = Math.min(minW, c.w);
      }
      return { c, minW };
    }

    it("full countersteer out of a hit swings back to the other side less", () => {
      // The first 0.8 s after the hit: that's where the countersteer overshoots
      const conAyuda = salir(p, -1, 24);
      const sinAyuda = salir(BOT, -1, 24);
      // Both swing left (the countersteer), but with help about half as hard
      expect(sinAyuda.minW).toBeLessThan(-1.5);
      expect(Math.abs(conAyuda.minW)).toBeLessThan(Math.abs(sinAyuda.minW) * 0.65);
    });

    it("letting go of the wheel, the spin from the hit dies out sooner", () => {
      const conAyuda = salir(p, 0, 27);
      const sinAyuda = salir(BOT, 0, 27);
      expect(Math.abs(conAyuda.c.w)).toBeLessThan(Math.abs(sinAyuda.c.w));
      expect(Math.abs(conAyuda.c.w)).toBeLessThan(0.3);
    });

    it("starts when the hit ends and runs out after its time", () => {
      const c = golpeado();
      avanzarCarro(c, ACELERAR, p, pista, DT);
      expect(c.recobro).toBe(p.recobro.duracion);
      // Past the push, the help counts down to 0
      for (let i = 0; i < Math.ceil((p.choque.empujon.duracion + p.recobro.duracion) / DT) + 2; i++) avanzarCarro(c, ACELERAR, p, pista, DT);
      expect(c.empujon).toBe(0);
      expect(c.recobro).toBe(0);
      // A spin (coletazo) also gets it
      const t = correr(crearCarro(pista, 0), ACELERAR, 30);
      t.trompo = 10;
      avanzarCarro(t, ACELERAR, p, pista, DT);
      expect(t.recobro).toBe(p.recobro.duracion);
    });

    it("bots don't get it: they drive exactly like before", () => {
      const bot = salir(BOT, -1, 45).c;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const antes = salir({ ...p, recobro: undefined } as any, -1, 45).c;
      expect(bot.recobro).toBe(0);
      expect({ ...bot, recobro: 0 }).toEqual({ ...antes, recobro: 0 });
    });
  });

  describe("empujón (a hit knocks the car off its line)", () => {
    /** B cruising straight at 25 m/s; A slams into its rear quarter from the side */
    function golpeDeLado(vy: number) {
      const b = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 25, vy: 0, w: 0 };
      const a = { ...crearCarro(pista, 0), x: -1.2, y: 2.4, angulo: -Math.PI / 2, vx: 25, vy: -vy, w: 0 };
      return { a, b };
    }
    const RECTO: Controles = { giro: 0, acel: 1, freno: 0, mano: false };
    const pasar = (c: EstadoCarro, ticks: number) => {
      for (let i = 0; i < ticks; i++) pasoCarro(c, RECTO, p, DT);
      return c;
    };

    it("a strong side hit leaves the victim without grip and turns its heading", () => {
      const { a, b } = golpeDeLado(12);
      chocarCarros(a, b, p, 30);
      expect(b.empujon).toBeGreaterThan(0.3);
      // Even holding the wheel straight, half a second later it points somewhere else
      pasar(b, 15);
      expect(Math.abs(b.angulo)).toBeGreaterThan(0.2);
    });

    it("the push is proportional: a softer hit turns it less", () => {
      const fuerte = golpeDeLado(12);
      const suave = golpeDeLado(5);
      chocarCarros(fuerte.a, fuerte.b, p, 30);
      chocarCarros(suave.a, suave.b, p, 30);
      expect(suave.b.empujon).toBeLessThan(fuerte.b.empujon);
      expect(Math.abs(pasar(suave.b, 15).angulo)).toBeLessThan(Math.abs(pasar(fuerte.b, 15).angulo));
    });

    it("a light rub doesn't push at all", () => {
      const a = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 20, vy: 0.8, w: 0 };
      const b = { ...crearCarro(pista, 0), x: 0, y: 2.45, angulo: 0, vx: 20, vy: 0, w: 0 };
      chocarCarros(a, b, p, 30);
      expect(a.empujon).toBe(0);
      expect(b.empujon).toBe(0);
    });

    it("the sideways shove isn't turned into forward speed", () => {
      const { a, b } = golpeDeLado(12);
      chocarCarros(a, b, p, 30);
      const sinGas = { ...RECTO, acel: 0 };
      const antes = rapidez(b);
      for (let i = 0; i < 10; i++) pasoCarro(b, sinGas, p, DT);
      expect(rapidez(b)).toBeLessThan(antes);
    });

    it("the one who rams keeps control: the victim takes the push", () => {
      // A comes from the right steering into B's side (the move to run someone off the road)
      const b = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 25, vy: 0, w: 0 };
      const a = { ...crearCarro(pista, 0), x: 0.5, y: 2.4, angulo: -0.35, vx: 25 * Math.cos(-0.35), vy: 25 * Math.sin(-0.35), w: -1.5 };
      const antesA = copiarCarro(a);
      chocarCarros(a, b, p, 30, { x: 1, y: 0 }); // the road runs along +x
      expect(b.empujon).toBeGreaterThan(0.1);
      expect(a.empujon).toBeLessThan(b.empujon * 0.25);
      // The rammer barely changed course; the victim got shoved sideways much harder
      const lateral = (c: EstadoCarro, v: EstadoCarro) => Math.abs(-(c.vx - v.vx) * Math.sin(c.angulo) + (c.vy - v.vy) * Math.cos(c.angulo));
      expect(lateral(a, antesA)).toBeLessThan(lateral(b, { ...b, vx: 25, vy: 0 }) / 2);
    });

    it("head-on into each other, both take it equally", () => {
      const a = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 0, vy: 8, w: 0 };
      const b = { ...crearCarro(pista, 0), x: 0, y: 2.4, angulo: 0, vx: 0, vy: -8, w: 0 };
      chocarCarros(a, b, p, 30);
      expect(a.empujon).toBeCloseTo(b.empujon, 5);
      expect(a.vy).toBeCloseTo(-b.vy, 5);
    });

    it("rear-ending a car straight on doesn't knock the attacker around", () => {
      const a = { ...crearCarro(pista, 0), x: 0, y: 0, angulo: 0, vx: 30, vy: 0, w: 0 };
      const b = { ...crearCarro(pista, 0), x: 4.6, y: 0, angulo: 0, vx: 15, vy: 0, w: 0 };
      chocarCarros(a, b, p, 30);
      expect(a.empujon).toBe(0);
      expect(Math.abs(a.w)).toBeLessThan(0.05);
      expect(Math.abs(a.vy)).toBeLessThan(0.05);
    });
  });

  it("separates two overlapping cars and keeps momentum", () => {
    const a = crearCarro(pista, 0);
    const b = crearCarro(pista, 0.5);
    a.vx = 10;
    const antes = a.vx + b.vx;
    // Without the rammer's advantage (which on purpose makes the rammer weigh more) momentum is kept
    colisionCarros(a, b, { ...p, choque: { ...p.choque, empujon: { ...p.choque.empujon, ventaja: 0 } } });
    // No circle of one car stays inside a circle of the other
    for (const ca of circulosCarro(a)) {
      for (const cb of circulosCarro(b)) expect(Math.hypot(cb.x - ca.x, cb.y - ca.y)).toBeGreaterThan(p.radio * 2 - 0.3);
    }
    expect(a.vx + b.vx).toBeCloseTo(antes, 5);
    expect(b.vx).toBeGreaterThan(0);
  });
});
