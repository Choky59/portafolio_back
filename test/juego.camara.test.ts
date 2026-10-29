import { readFileSync } from "fs";
import path from "path";
import { Circuito } from "../src/juego/compartido/tipos";
import { prepararPista, puntoEnPista } from "../src/juego/compartido/pista";
import { crearCarro } from "../src/juego/compartido/fisica";
import { crearCamara, seguir } from "../src/juego/compartido/camara";

const circuito: Circuito = JSON.parse(
  readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", "prueba.json"), "utf8"),
);
const pista = prepararPista(circuito);

describe("camara", () => {
  it("starts on the car, looking down the track", () => {
    const cam = crearCamara();
    const carro = crearCarro(pista, 0);
    seguir(cam, pista, carro, 1 / 60);
    expect(cam.x).toBeCloseTo(carro.x);
    expect(cam.rumbo).toBeCloseTo(puntoEnPista(pista, 14).angulo);
  });

  it("follows the track direction, not the car's heading", () => {
    const cam = crearCamara();
    const carro = crearCarro(pista, 0);
    seguir(cam, pista, carro, 1 / 60);
    const rumbo = cam.rumbo;
    carro.angulo += Math.PI; // a spin
    for (let i = 0; i < 60; i++) seguir(cam, pista, carro, 1 / 60);
    expect(cam.rumbo).toBeCloseTo(rumbo, 5);
  });

  it("turns the short way and settles on the new direction", () => {
    const cam = crearCamara();
    seguir(cam, pista, crearCarro(pista, 0), 1 / 60);
    const carro = crearCarro(pista, 300);
    for (let i = 0; i < 600; i++) seguir(cam, pista, carro, 1 / 60);
    expect(cam.rumbo).toBeCloseTo(puntoEnPista(pista, 314).angulo, 2);
    expect(Math.abs(cam.rumbo)).toBeLessThanOrEqual(Math.PI * 2);
  });
});
