import { readFileSync } from "fs";
import path from "path";
import { Sala } from "../src/juego/servidor/salas";
import { RendimientoServidor, TICK_LENTO_MS } from "../src/juego/servidor/rendimiento";
import { Circuito } from "../src/juego/compartido/tipos";

/** LOS TIRONES DEL SERVIDOR (Status): qué lo detuvo, con su contexto */

const circuito: Circuito = JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", "prueba.json"), "utf8"));

describe("server stalls (tirones)", () => {
  const rendimiento = new RendimientoServidor();
  afterAll(() => rendimiento.cerrar());

  it("each tick records how long each part took", () => {
    const sala = new Sala("HMO-1234", circuito, 60);
    sala.agregar("a", { nombre: "Ana", color: "rojo" });
    sala.paso();
    expect(sala.perfilPaso).toMatchObject({ vivos: 1, entidades: 0 });
    for (const parte of ["bots", "controles", "escenario", "choques", "items", "resto"]) {
      expect(sala.perfilPaso![parte]).toBeGreaterThanOrEqual(0);
    }
  });

  it("only slow ticks, bursts and state sends are kept, with their context, and taken once", () => {
    const sala = new Sala("HMO-1234", circuito, 60);
    sala.agregar("a", { nombre: "Ana", color: "rojo" });
    sala.paso();
    rendimiento.registrarTick(sala, 2);
    rendimiento.registrarTick(sala, TICK_LENTO_MS + 11);
    rendimiento.registrarControles(sala, 1, "Ana", 6, 6);
    rendimiento.registrarControles(sala, 12, "Ana", 60, 58);
    rendimiento.registrarEstado(sala, 7, 1400, 4);
    const tirones = rendimiento.tomarTirones(sala);
    expect(tirones.map((t) => t.tipo)).toEqual(["tick", "controles", "estado"]);
    expect(tirones[0].detalle).toHaveProperty("choques");
    expect(tirones[1].detalle).toMatchObject({ jugador: "Ana", recibidos: 60, aplicados: 58 });
    expect(tirones[2].detalle).toMatchObject({ bytes: 1400, destinos: 4 });
    expect(rendimiento.tomarTirones(sala)).toEqual([]);
  });
});
