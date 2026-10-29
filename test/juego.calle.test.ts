import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { Sala } from "../src/juego/servidor/salas";
import { crearCarro, rapidez } from "../src/juego/compartido/fisica";
import { lateralEnPista, proyectar } from "../src/juego/compartido/pista";

const DIR = path.join(__dirname, "..", "content", "juego");
const base: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
const CALLE = ITEMS.findIndex((i) => i.id === "calle");

function nuevaSala() {
  let semilla = 11;
  const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
  const sala = new Sala("HMO-5555", { ...base, cajas: [] }, HZ, 5, ITEMS, azar);
  sala.agregar("a", { nombre: "A", color: "rojo" });
  sala.agregar("b", { nombre: "B", color: "azul" });
  const j = (id: string) => sala.jugadores.get(id)!;
  j("a").carro = crearCarro(sala.pista, 20);
  j("b").carro = crearCarro(sala.pista, 10);
  const calles = () => sala.entidades.filter((e) => e.item === CALLE);
  return { sala, j, calles };
}

describe("street character", () => {
  it("shows up every 12 s in the middle of the road, ahead of the leader and out of sight; at most 3 at once", () => {
    const { sala, j, calles } = nuevaSala();
    for (let i = 0; i < 11 * HZ; i++) sala.paso();
    expect(calles()).toHaveLength(0);
    for (let i = 0; i < 2 * HZ; i++) sala.paso();
    expect(calles()).toHaveLength(1);
    const p = calles()[0];
    expect(Math.abs(lateralEnPista(sala.pista, p.x, p.y))).toBeLessThan(sala.pista.mitad * 0.5);
    const delante = proyectar(sala.pista, p.x, p.y).s - j("a").progreso.s;
    expect(delante).toBeGreaterThanOrEqual(119);
    expect(sala.seVe(p.x, p.y)).toBe(false);
    // 12 s later, a second one
    for (let i = 0; i < 12 * HZ; i++) sala.paso();
    expect(calles()).toHaveLength(2);
    // Another 45 s: never more than 3 at once
    let maximo = 0;
    for (let i = 0; i < 45 * HZ; i++) {
      sala.paso();
      maximo = Math.max(maximo, calles().length);
    }
    expect(maximo).toBe(3);
  });

  it("when a car comes fast it runs back and forth across the road (still in the way)", () => {
    const { sala, j, calles } = nuevaSala();
    for (let i = 0; i < 13 * HZ; i++) sala.paso();
    const p = calles()[0];
    const inicio = { x: p.x, y: p.y };
    // B 15 m away with speed (it doesn't move without controls): it stays scared
    Object.assign(j("b").carro, { x: p.x - 15, y: p.y, angulo: 0, vx: 30, vy: 0 });
    const lados = new Set<number>();
    for (let i = 0; i < 6 * HZ; i++) {
      sala.paso();
      const lateral = lateralEnPista(sala.pista, p.x, p.y);
      expect(Math.abs(lateral)).toBeLessThan(sala.pista.mitad + 0.5);
      if (Math.abs(lateral) > 1) lados.add(Math.sign(lateral));
    }
    expect(p.etapa).toBe(1);
    expect(Math.hypot(p.x - inicio.x, p.y - inicio.y)).toBeGreaterThan(1);
    expect(lados.size).toBe(2);
  });

  it("running one over slows the car 18% and sends it flying", () => {
    const { sala, j, calles } = nuevaSala();
    for (let i = 0; i < 13 * HZ; i++) sala.paso();
    const p = calles()[0];
    const b = j("b").carro;
    Object.assign(b, { x: p.x - 1.5, y: p.y, angulo: 0, vx: 25, vy: 0 });
    sala.eventos = [];
    sala.paso();
    expect(sala.eventos).toContainEqual(expect.objectContaining({ tipo: "atropello", id: p.id, quien: "b" }));
    expect(rapidez(b)).toBeCloseTo(25 * 0.82, 5);
    expect(calles()).toHaveLength(0);
  });

  it("when its time is up it leaves, but only while nobody is looking", () => {
    const { sala, j, calles } = nuevaSala();
    for (let i = 0; i < 13 * HZ; i++) sala.paso();
    const p = calles()[0];
    // B parks next to it (looking at it) until well past its time
    j("b").carro = { ...crearCarro(sala.pista, 0), x: p.x + 20, y: p.y };
    for (let i = 0; i < 50 * HZ; i++) sala.paso();
    expect(sala.entidades).toContain(p);
    j("b").carro = crearCarro(sala.pista, 10);
    sala.paso();
    expect(sala.entidades).not.toContain(p);
  });
});
