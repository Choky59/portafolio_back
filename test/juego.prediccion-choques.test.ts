import { readFileSync } from "fs";
import path from "path";
import { Sala } from "../src/juego/servidor/salas";
import { chocarPredicho, predecirLanzamiento, avanzarProvisional } from "../src/juego/servidor/prediccion";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { prepararPista, proyectar, puntoEnPista } from "../src/juego/compartido/pista";
import { PARAMETROS_FISICA, avanzarCarro, copiarCarro } from "../src/juego/compartido/fisica";
import { DURACION } from "../src/juego/servidor/reglas";

/**
 * LO QUE AHORA SE PREDICE EN EL NAVEGADOR, igual que en el servidor:
 *  - los choques del carro propio contra los demás (chocarPredicho, como Sala.aplicarUno);
 *  - lo que tira el espectador (predecirLanzamiento, como Sala.lanzarMeteorito).
 */

const DIR = path.join(__dirname, "..", "content", "juego");
const circuito: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 60;
const ctrl = { seq: 1, giro: 0, acel: 1, freno: 0, mano: false, item: false };

/** Una sala en carrera ya pasado el arranque fantasma (los carros sí chocan) */
function carrera(circ: Circuito, n = 2) {
  const sala = new Sala("HMO-4321", { ...circ, cajas: [] }, HZ, undefined, ITEMS, () => 0.5);
  const ids = ["a", "b", "c"].slice(0, n);
  ids.forEach((id) => sala.agregar(id, { nombre: id.toUpperCase(), color: "rojo" }));
  sala.fase = "carrera";
  (sala as unknown as { ticksCarrera: number }).ticksCarrera = 100 * HZ;
  return { sala, j: (id: string) => sala.jugadores.get(id)! };
}

describe("predicted car-vs-car collisions: the browser bounces exactly like the server", () => {
  it("rear-ending a car: the predicted car equals the server's after the hit", () => {
    const { sala, j } = carrera(circuito);
    const pista = prepararPista(circuito);
    const a = j("a");
    const b = j("b");
    // B parado justo adelante de A; A llega rápido
    const p = puntoEnPista(pista, 60, 0);
    const adelante = { x: Math.cos(p.angulo), y: Math.sin(p.angulo) };
    const indice = proyectar(pista, p.x, p.y).indice;
    Object.assign(a.carro, { x: p.x, y: p.y, angulo: p.angulo, vx: adelante.x * 25, vy: adelante.y * 25, indice });
    Object.assign(b.carro, { x: p.x + adelante.x * 3.6, y: p.y + adelante.y * 3.6, angulo: p.angulo, vx: 0, vy: 0, indice });

    // El navegador: su paso de física y luego el choque contra B como lo ve
    const predicho = copiarCarro(a.carro);
    const otroVisto = copiarCarro(b.carro);
    const vistoAntes = copiarCarro(otroVisto);
    avanzarCarro(predicho, ctrl, PARAMETROS_FISICA, pista, 1 / HZ);
    const [fuerza] = chocarPredicho(pista, HZ, predicho, [otroVisto]);

    // El servidor recibe ese mismo control
    sala.recibirControles("a", ctrl);
    expect(fuerza).toBeGreaterThan(0);
    expect(a.carro).toEqual(predicho);
    // Lo que se ve de B no se toca (solo se mueve el carro propio)
    expect(otroVisto).toEqual(vistoAntes);
  });

  it("not touching: nothing changes", () => {
    const pista = prepararPista(circuito);
    const { j } = carrera(circuito);
    const lejos = copiarCarro(j("b").carro);
    lejos.x += 50;
    const predicho = copiarCarro(j("a").carro);
    const antes = copiarCarro(predicho);
    expect(chocarPredicho(pista, HZ, predicho, [lejos])).toEqual([0]);
    expect(predicho).toEqual(antes);
  });
});

describe("predicted spectator throws: drawn where and when the server drops them", () => {
  function espectador(circ: Circuito) {
    const sala = new Sala("HMO-4322", { ...circ, cajas: [] }, HZ, undefined, ITEMS, () => 0.5);
    for (const id of ["a", "b", "c"]) sala.agregar(id, { nombre: id.toUpperCase(), color: "rojo" });
    // Como en el juego: empieza la partida y A ya explotó
    expect(sala.empezar("a")).toBeNull();
    for (let t = 0; t < DURACION.cuenta * HZ; t++) sala.paso();
    expect(sala.fase).toBe("carrera");
    sala.jugadores.get("a")!.vivo = false;
    return { sala, j: (id: string) => sala.jugadores.get(id)! };
  }

  it("the meteor: same spot and same fall time as the server's", () => {
    const { sala, j } = espectador(circuito);
    const pista = prepararPista(circuito);
    const indice = ITEMS.findIndex((i) => i.id === "meteorito");
    const { x, y } = j("b").carro;
    const provisional = predecirLanzamiento(pista, ITEMS, HZ, indice, x, y)!;
    expect(sala.lanzarMeteorito("a", x, y, true)).toBeNull();
    const real = sala.entidades.find((e) => e.item === indice)!;
    expect(provisional.id).toBeLessThan(0);
    expect(provisional.x).toBe(real.x);
    expect(provisional.y).toBe(real.y);
    expect(provisional.vida).toBe(real.vida);
    // Se acaba a la vez (cae al mismo ritmo)
    let ticks = 0;
    while (avanzarProvisional({ pista, items: ITEMS, tickHz: HZ, yo: { id: "a", carro: j("a").carro }, otros: [] }, provisional)) ticks++;
    expect(ticks + 1).toBe(real.vidaMax);
  });

  it("the scaffold (construction): lands across the aimed lane, like the server's", () => {
    const circ = { ...circuito, espectador: "andamio" } as Circuito;
    const { sala, j } = espectador(circ);
    const pista = prepararPista(circ);
    const indice = ITEMS.findIndex((i) => i.id === "andamio");
    // Apunta un poco a un lado del carro de B: cae centrado en ese carril
    const { x, y } = j("b").carro;
    const provisional = predecirLanzamiento(pista, ITEMS, HZ, indice, x + 1, y + 1)!;
    expect(sala.lanzarMeteorito("a", x + 1, y + 1, true)).toBeNull();
    const real = sala.entidades.find((e) => e.item === indice)!;
    expect(provisional.x).toBeCloseTo(real.x, 9);
    expect(provisional.y).toBeCloseTo(real.y, 9);
    expect(provisional.angulo).toBeCloseTo(real.angulo, 9);
    expect(provisional.vida).toBe(real.vida);
  });
});
