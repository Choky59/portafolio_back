import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { prepararPista } from "../src/juego/compartido/pista";
import { PARAMETROS_FISICA as p, crearCarro, pasoCarro, prisaDeRonda, rapidez } from "../src/juego/compartido/fisica";
import { desempacarCarro, empacarCarro } from "../src/juego/compartido/protocolo";
import { Sala } from "../src/juego/servidor/salas";
import { DURACION } from "../src/juego/servidor/reglas";

const DIR = path.join(__dirname, "..", "content", "juego");
const circuito: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
const kmh = (v: number) => v * 3.6;

describe("the round's rush (prisa)", () => {
  it("goes from 135 km/h at the start to 190 km/h at one minute, and stays there", () => {
    expect(kmh(p.velocidadMax * prisaDeRonda(0))).toBeCloseTo(135, 5);
    expect(kmh(p.velocidadMax * prisaDeRonda(30))).toBeCloseTo(162.5, 5);
    expect(kmh(p.velocidadMax * prisaDeRonda(60))).toBeCloseTo(190, 5);
    expect(kmh(p.velocidadMax * prisaDeRonda(200))).toBeCloseTo(190, 5);
  });

  it("raises the car's top speed", () => {
    const pista = prepararPista(circuito);
    const tope = (prisa: number) => {
      const c = { ...crearCarro(pista, 0), prisa };
      for (let i = 0; i < 10 * HZ; i++) pasoCarro(c, { giro: 0, acel: 1, freno: 0, mano: false }, p, 1 / HZ);
      return kmh(rapidez(c));
    };
    expect(tope(1)).toBeCloseTo(135, 0);
    expect(tope(prisaDeRonda(60))).toBeCloseTo(190, 0);
  });

  it("travels in the snapshot (an old one means no rush)", () => {
    const c = { ...crearCarro(prepararPista(circuito), 0), prisa: 1.2345 };
    const r = empacarCarro("a", c, 1, true, -1);
    expect(desempacarCarro(r).estado.prisa).toBeCloseTo(1.2345, 4);
    expect(desempacarCarro(r.slice(0, 32) as typeof r).estado.prisa).toBe(1);
  });

  it("the server raises it for everyone as the race goes on, and resets it for the next countdown", () => {
    const sala = new Sala("HMO-3333", { ...circuito, cajas: [] }, HZ, 5, ITEMS, () => 0.5);
    ["a", "b"].forEach((id) => sala.agregar(id, { nombre: id, color: "rojo" }));
    expect(sala.empezar("a")).toBeNull();
    for (let t = 0; t < DURACION.cuenta * HZ; t++) sala.paso();
    expect(sala.fase).toBe("carrera");
    for (const j of sala.jugadores.values()) expect(j.carro.prisa).toBe(1);
    (sala as any).ticksCarrera = 30 * HZ;
    sala.paso();
    for (const j of sala.jugadores.values()) expect(j.carro.prisa).toBeCloseTo(prisaDeRonda(30), 2);
    (sala as any).cambiarFase("cuenta", DURACION.cuenta);
    sala.paso();
    for (const j of sala.jugadores.values()) expect(j.carro.prisa).toBe(1);
  });
});
