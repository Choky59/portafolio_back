import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { enBarranco } from "../src/juego/compartido/pista";
import { Sala } from "../src/juego/servidor/salas";
import { rng } from "./juego.utiles";

const DIR = path.join(__dirname, "..", "content", "juego");
const hermosillo: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "hermosillo.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;

function salaConBots(bots = 2, semilla = 7) {
  const sala = new Sala("HMO-3333", hermosillo, HZ, 5, ITEMS, rng(semilla));
  sala.agregar("yo", { nombre: "Jorge", color: "rojo" });
  for (let i = 0; i < bots; i++) expect(sala.agregarBot()).toBeNull();
  return sala;
}

describe("bots", () => {
  it("join with their own name and color, and never host", () => {
    const sala = salaConBots(2);
    const jugadores = sala.estado().jugadores;
    expect(jugadores).toHaveLength(3);
    expect(jugadores.filter((j) => j.bot).map((j) => j.nombre)).toEqual(["Chuy", "Lupita"]);
    expect(new Set(jugadores.map((j) => j.color)).size).toBe(3);
    expect(sala.anfitrion).toBe("yo");
    expect(sala.agregarBot()).toBeNull();
    expect(sala.agregarBot()).toMatch(/4 jugadores/);
  });

  it("a room with only bots left counts as empty", () => {
    const sala = salaConBots(2);
    expect(sala.vacia).toBe(false);
    sala.quitar("yo");
    expect(sala.vacia).toBe(true);
  });

  it.each([1, 2, 3])("drive laps of the Hermosillo circuit without falling off a cliff (seed %i)", (semilla) => {
    const sala = salaConBots(2, semilla);
    const bots = [...sala.jugadores.values()].filter((j) => j.mente);
    for (let t = 0; t < 40 * HZ; t++) {
      sala.paso();
      for (const b of bots) expect(enBarranco(sala.pista, b.carro.x, b.carro.y)).toBe(false);
    }
    // In 40 s a decent driver covers well over a lap (~1.4 km)
    for (const b of bots) expect(sala.recorrido(b.id)).toBeGreaterThan(1000);
  });

  it("play a match: an idle human gets left behind and a bot scores", () => {
    const sala = salaConBots(2);
    expect(sala.empezar("yo")).toBeNull();
    let t = 0;
    while (sala.fase !== "ronda-fin" && t++ < 60 * HZ) sala.paso();
    expect(sala.fase).toBe("ronda-fin");
    expect(sala.jugadores.get("yo")!.vivo).toBe(false);
    expect(sala.ganadorRonda).toMatch(/^bot-/);
  });

  it("can be removed before starting", () => {
    const sala = salaConBots(2);
    sala.quitarBots();
    expect(sala.estado().jugadores).toHaveLength(1);
  });
});
