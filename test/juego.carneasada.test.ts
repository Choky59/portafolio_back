import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { Sala } from "../src/juego/servidor/salas";
import { crearCarro, rapidez } from "../src/juego/compartido/fisica";
import { lateralEnPista } from "../src/juego/compartido/pista";

const DIR = path.join(__dirname, "..", "content", "juego");
const base: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
const id = (nombre: string) => ITEMS.findIndex((i) => i.id === nombre);

/** A drops the carne asada smoke and both cars go far away from it */
function conAsador(azar: () => number = () => 0) {
  const sala = new Sala("HMO-4444", { ...base, cajas: [] }, HZ, 5, ITEMS, azar);
  sala.agregar("a", { nombre: "A", color: "rojo" });
  sala.agregar("b", { nombre: "B", color: "azul" });
  const j = (quien: string) => sala.jugadores.get(quien)!;
  j("a").carro = crearCarro(sala.pista, 20);
  j("b").carro = crearCarro(sala.pista, 60);
  sala.paso();
  j("a").item = id("humo");
  sala.recibirControles("a", { seq: 1, giro: 0, acel: 0, freno: 0, mano: false, item: true });
  const asador = sala.entidades.find((e) => e.item === id("asador"))!;
  j("a").carro = crearCarro(sala.pista, 150);
  j("b").carro = crearCarro(sala.pista, 160);
  sala.paso();
  /** Laps of the leader as fractions (only the distance matters) */
  const avanzar = (fraccion: number) => {
    for (const jugador of sala.jugadores.values()) jugador.progreso.vueltas += fraccion;
    sala.paso();
  };
  const gente = () => sala.entidades.filter((e) => e.item === id("persona"));
  return { sala, j, asador, avanzar, gente };
}

describe("carne asada", () => {
  it("first only smoke and grill; the next time around there are 4 to 6 people; the time after, all gone", () => {
    const { sala, asador, avanzar, gente } = conAsador();
    expect(gente()).toHaveLength(0);
    avanzar(0.6);
    expect(gente().length).toBeGreaterThanOrEqual(4);
    expect(gente().length).toBeLessThanOrEqual(6);
    for (const p of gente()) expect(Math.hypot(p.x - asador.x, p.y - asador.y)).toBeLessThan(3);
    avanzar(1);
    expect(sala.entidades).not.toContain(asador);
    sala.paso(); // the people leave with their grill
    expect(gente()).toHaveLength(0);
  });

  it("people run when a car comes fast, and a car that hits one loses 18% of its speed", () => {
    const { sala, j, asador, avanzar, gente } = conAsador();
    avanzar(0.6);
    const antes = new Map(gente().map((p) => [p.id, { x: p.x, y: p.y }]));

    // B comes straight at the grill at 30 m/s from 15 m
    const b = j("b").carro;
    Object.assign(b, { x: asador.x - 15, y: asador.y, angulo: 0, vx: 30, vy: 0 });
    sala.eventos = [];
    sala.paso();
    expect(sala.eventos).toContainEqual(expect.objectContaining({ tipo: "susto" }));
    for (let i = 0; i < 5; i++) sala.paso();
    expect(gente().some((p) => p.etapa === 1)).toBe(true);
    const movidas = gente().filter((p) => Math.hypot(p.x - antes.get(p.id)!.x, p.y - antes.get(p.id)!.y) > 0.5);
    expect(movidas.length).toBeGreaterThan(0);

    // Right on top of someone: run over
    const victima = gente()[0];
    Object.assign(b, { x: victima.x - 1.5, y: victima.y, angulo: 0, vx: 30, vy: 0 });
    sala.eventos = [];
    sala.paso();
    expect(sala.eventos).toContainEqual(expect.objectContaining({ tipo: "atropello", id: victima.id, quien: "b" }));
    // 18% less per person hit (they run onto the road, so it can be more than one at once)
    const atropellos = sala.eventos.filter((e) => e.tipo === "atropello").length;
    expect(rapidez(b)).toBeCloseTo(30 * 0.82 ** atropellos, 5);
    expect(sala.entidades).not.toContain(victima);
  });

  it("in a panic they run back and forth across the road (in the way), not off it", () => {
    let semilla = 7;
    const azar = () => ((semilla = (semilla * 16807) % 2147483647) / 2147483647);
    const { sala, j, asador, avanzar, gente } = conAsador(azar);
    avanzar(0.6);
    const b = j("b").carro;
    // B parked 15 m away with speed (it doesn't move without controls): they stay scared
    Object.assign(b, { x: asador.x - 15, y: asador.y, angulo: 0, vx: 30, vy: 0 });
    const lados = new Map<number, Set<number>>();
    for (let i = 0; i < 6 * HZ; i++) {
      sala.paso();
      for (const p of gente()) {
        const lateral = lateralEnPista(sala.pista, p.x, p.y);
        // Always on the road
        expect(Math.abs(lateral)).toBeLessThan(sala.pista.mitad + 0.5);
        if (Math.abs(lateral) > 1) lados.set(p.id, (lados.get(p.id) ?? new Set()).add(Math.sign(lateral)));
      }
    }
    // And they cross it: most of them were on both sides
    const cruzaron = [...lados.values()].filter((l) => l.size === 2).length;
    expect(cruzaron).toBeGreaterThanOrEqual(gente().length / 2);
  });

  it("people go back to their place once the cars are gone", () => {
    const { sala, j, asador, avanzar, gente } = conAsador();
    avanzar(0.6);
    const p = gente()[0];
    const casa = { ...p.casa! };
    Object.assign(j("b").carro, { x: asador.x - 15, y: asador.y + 12, angulo: 0, vx: 30, vy: 0 });
    for (let i = 0; i < 8; i++) sala.paso();
    j("b").carro = crearCarro(sala.pista, 160);
    for (let i = 0; i < 20 * HZ; i++) sala.paso();
    expect(p.etapa).toBe(0);
    expect(Math.hypot(p.x - casa.x, p.y - casa.y)).toBeLessThan(0.5);
  });
});
