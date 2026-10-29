import { readFileSync } from "fs";
import path from "path";
import { Circuito } from "../src/juego/compartido/tipos";
import { prepararPista, puntoEnPista } from "../src/juego/compartido/pista";
import { crearCarro } from "../src/juego/compartido/fisica";
import {
  PARAMETROS_CAMARA_PARTIDA,
  ZOOM_MAX,
  ajustarZoom,
  crearCamara,
  enVista,
  seguir,
} from "../src/juego/compartido/camara";

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

  it("sees what's in front of it and not what's far behind or to the sides", () => {
    const cam = crearCamara();
    const carro = crearCarro(pista, 100);
    seguir(cam, pista, carro, 1 / 60, PARAMETROS_CAMARA_PARTIDA);
    const p = PARAMETROS_CAMARA_PARTIDA;
    const dx = Math.cos(cam.rumbo);
    const dy = Math.sin(cam.rumbo);
    expect(enVista(cam, carro.x, carro.y)).toBe(true);
    expect(enVista(cam, carro.x + dx * 20, carro.y + dy * 20)).toBe(true);
    // Far behind (under the drone and past it) and far to the sides
    expect(enVista(cam, carro.x - dx * (p.distancia + 40), carro.y - dy * (p.distancia + 40))).toBe(false);
    expect(enVista(cam, carro.x - dy * 80, carro.y + dx * 80)).toBe(false);
    expect(enVista(cam, carro.x + dy * 80, carro.y - dx * 80)).toBe(false);
  });

  it("zooms out up to double to fit a car that's falling behind, and back in when it catches up", () => {
    const cam = crearCamara();
    const lider = crearCarro(pista, 200);
    seguir(cam, pista, lider, 1 / 30, PARAMETROS_CAMARA_PARTIDA);
    const atras = puntoEnPista(pista, 200 - 45);
    expect(enVista(cam, atras.x, atras.y)).toBe(false);

    const carros = [lider, atras].map((c) => ({ x: c.x, y: c.y, altura: 0 }));
    for (let i = 0; i < 90; i++) ajustarZoom(cam, carros, 1 / 30);
    expect(cam.zoom).toBeGreaterThan(1.1);
    expect(cam.zoom).toBeLessThanOrEqual(ZOOM_MAX);
    expect(enVista(cam, atras.x, atras.y)).toBe(true);

    // Way too far behind: the camera stops at double and that car stays out
    const lejos = puntoEnPista(pista, 200 - 300);
    for (let i = 0; i < 120; i++) ajustarZoom(cam, [carros[0], { x: lejos.x, y: lejos.y, altura: 0 }], 1 / 30);
    expect(cam.zoom).toBeCloseTo(ZOOM_MAX, 1);
    expect(enVista(cam, lejos.x, lejos.y)).toBe(false);

    // Everyone together again: it comes back in, slowly
    for (let i = 0; i < 300; i++) ajustarZoom(cam, [carros[0]], 1 / 30);
    expect(cam.zoom).toBeLessThan(1.1);
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
