import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { Sala } from "../src/juego/servidor/salas";
import { DURACION, METEORITO, REZAGO } from "../src/juego/servidor/reglas";
import { ControlesRed } from "../src/juego/compartido/protocolo";

const DIR = path.join(__dirname, "..", "content", "juego");
const circuito: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
const METEORO = ITEMS.find((i) => i.mecanica === "meteorito")!;
const BACHE = ITEMS.findIndex((i) => i.id === METEORO.deja);

function nuevaSala(n: number) {
  const sala = new Sala("HMO-3333", { ...circuito, cajas: [] }, HZ, 5, ITEMS, () => 0.5);
  const ids = ["a", "b", "c", "d"].slice(0, n);
  ids.forEach((id) => sala.agregar(id, { nombre: id.toUpperCase(), color: "rojo" }));
  return { sala, j: (id: string) => sala.jugadores.get(id)! };
}

const seqs = new Map<string, number>();
function correr(sala: Sala, ticks: number, ctrl: Partial<ControlesRed> = {}, quienes: string[] = []) {
  for (let t = 0; t < ticks; t++) {
    for (const id of quienes) {
      const seq = (seqs.get(id) ?? 0) + 1;
      seqs.set(id, seq);
      sala.recibirControles(id, { seq, giro: 0, acel: 1, freno: 0, mano: false, item: false, ...ctrl });
    }
    sala.paso();
  }
}

/** Starts a match, waits for the countdown and blows up A (it falls into the water... or anywhere: just mark it) */
function carreraConEspectador(n: number) {
  const r = nuevaSala(n);
  expect(r.sala.empezar("a")).toBeNull();
  correr(r.sala, DURACION.cuenta * HZ);
  expect(r.sala.fase).toBe("carrera");
  r.j("a").vivo = false;
  return r;
}

beforeEach(() => seqs.clear());

describe("spectator meteors", () => {
  it("falls after its time where it was aimed, blows up the car under it and leaves a pothole already hit", () => {
    const { sala, j } = carreraConEspectador(3);
    const { x, y } = j("b").carro;
    expect(sala.lanzarMeteorito("a", x, y)).toBeNull();
    expect(sala.eventos).toContainEqual(expect.objectContaining({ tipo: "meteorito", id: "a", x, y }));
    // Still in the air: B and C sit still (no controls), nothing happens yet
    correr(sala, Math.round((METEORO.vida ?? 2.5) * HZ) - 2);
    expect(j("b").vivo).toBe(true);
    correr(sala, 3);
    expect(j("b").vivo).toBe(false);
    expect(sala.eventos).toContainEqual(expect.objectContaining({ tipo: "explosion", id: "b", motivo: "meteorito" }));
    expect(sala.eventos).toContainEqual(expect.objectContaining({ tipo: "impacto" }));
    // C was not under it
    expect(j("c").vivo).toBe(true);
    const bache = sala.entidades.find((e) => e.item === BACHE);
    expect(bache).toMatchObject({ x, y, golpes: 1 });
  });

  it("only lets eliminated players throw, in rooms of 3 or more, one at a time", () => {
    const dos = carreraConEspectador(2);
    // With 2 players, A's elimination already ended the round; and anyway it's too few
    expect(dos.sala.lanzarMeteorito("a", dos.j("b").carro.x, dos.j("b").carro.y)).toMatch(/carrera|al menos/);

    const { sala, j } = carreraConEspectador(4);
    const { x, y } = j("b").carro;
    expect(sala.lanzarMeteorito("b", x, y)).toMatch(/Solo quien ya explotó/);
    expect(sala.lanzarMeteorito("a", x + 4000, y)).toMatch(/se vea/);
    expect(sala.lanzarMeteorito("a", x, y)).toBeNull();
    expect(sala.lanzarMeteorito("a", x, y)).toMatch(/no está listo/);
    // After it falls and the reload time passes, A can throw again
    correr(sala, METEORITO.recarga * HZ + 1);
    expect(sala.lanzarMeteorito("a", j("c").carro.x, j("c").carro.y)).toBeNull();
  });

  it("is not a box item", () => {
    expect(METEORO.probabilidad).toBe(0);
  });
});

describe("laggard boost (rezago)", () => {
  it("gives the boost to a car at the edge of the shared picture, but never to the leader", () => {
    const { sala, j } = nuevaSala(2);
    expect(sala.empezar("a")).toBeNull();
    correr(sala, DURACION.cuenta * HZ);
    // A drives away; B stays parked until the camera can't zoom out more
    let visto = false;
    for (let t = 0; t < 120 && j("b").vivo; t++) {
      correr(sala, 1, {}, ["a"]);
      if (j("b").carro.rezago > 0) visto = true;
      expect(j("a").carro.rezago).toBe(0);
    }
    expect(visto).toBe(true);
    expect(REZAGO * HZ).toBeGreaterThan(5);
  });
});
