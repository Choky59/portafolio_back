import { readFileSync } from "fs";
import path from "path";
import { Sala } from "../src/juego/servidor/salas";
import { predecirUso, avanzarProvisional } from "../src/juego/servidor/prediccion";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { prepararPista } from "../src/juego/compartido/pista";
import { PARAMETROS_FISICA, avanzarCarro, copiarCarro } from "../src/juego/compartido/fisica";

/**
 * LA PREDICCIÓN DE LOS ITEMS: lo que el navegador predice al usar un item tiene que ser lo mismo
 * que hace el servidor, o el carro "brinca" cuando llega la confirmación.
 */

const circuito: Circuito = JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(__dirname, "..", "content", "juego", "items.json"), "utf8"));
const HZ = 60;
const indiceDe = (mecanica: string) => ITEMS.findIndex((i) => i.mecanica === mecanica);

/** Una sala en carrera: Ana ya andando con su item en la mano, Beto detrás en la parrilla (nadie adelante) */
function salaConItem(indice: number) {
  const sala = new Sala("HMO-1234", circuito, HZ, undefined, ITEMS, () => 0.5);
  sala.agregar("a", { nombre: "Ana", color: "rojo" });
  sala.agregar("b", { nombre: "Beto", color: "azul" });
  sala.fase = "carrera";
  const a = sala.jugadores.get("a")!;
  Object.assign(a.carro, { vx: 25, vy: 0, angulo: 0 });
  a.item = indice;
  return { sala, a };
}

describe("item prediction: the browser predicts exactly what the server does", () => {
  for (const mecanica of ["turbo", "escudo", "pesado"]) {
    it(`${mecanica}: the predicted car equals the server's car after using it`, () => {
      const indice = indiceDe(mecanica);
      expect(indice).toBeGreaterThanOrEqual(0);
      const { sala, a } = salaConItem(indice);
      const pista = prepararPista(circuito);

      // The browser: its physics step, then the item (like Sala.aplicarUno)
      const predicho = copiarCarro(a.carro);
      const ctrl = { seq: 0, giro: 0, acel: 1, freno: 0, mano: false, item: true };
      avanzarCarro(predicho, ctrl, PARAMETROS_FISICA, pista, 1 / HZ);
      predecirUso({ pista, items: ITEMS, tickHz: HZ, yo: { id: "a", carro: predicho }, otros: [] }, indice);

      // The server gets that same control
      sala.recibirControles("a", ctrl);
      expect(a.item).toBe(-1);
      expect(a.carro).toEqual(predicho);
      // And the effect is really there (not two cars that both missed it)
      const campo = mecanica as "turbo" | "escudo" | "pesado";
      expect(predicho[campo]).toBeGreaterThan(0);
    });
  }

  it("what's dropped behind (a pothole) comes out where the server puts it", () => {
    const indice = indiceDe("mina");
    const { sala, a } = salaConItem(indice);
    const pista = prepararPista(circuito);
    const predicho = copiarCarro(a.carro);
    const ctrl = { seq: 0, giro: 0, acel: 1, freno: 0, mano: false, item: true };
    avanzarCarro(predicho, ctrl, PARAMETROS_FISICA, pista, 1 / HZ);
    const [provisional] = predecirUso({ pista, items: ITEMS, tickHz: HZ, yo: { id: "a", carro: predicho }, otros: [] }, indice);

    sala.recibirControles("a", ctrl);
    const real = sala.entidades.find((e) => e.item === indice)!;
    expect(provisional).toBeDefined();
    expect(provisional.id).toBeLessThan(0);
    expect(provisional.x).toBeCloseTo(real.x, 6);
    expect(provisional.y).toBeCloseTo(real.y, 6);
  });

  it("what's thrown (the burro) moves on its own like the server's", () => {
    const indice = indiceDe("misil");
    const { sala, a } = salaConItem(indice);
    const pista = prepararPista(circuito);
    const predicho = copiarCarro(a.carro);
    const ctrl = { seq: 0, giro: 0, acel: 1, freno: 0, mano: false, item: true };
    avanzarCarro(predicho, ctrl, PARAMETROS_FISICA, pista, 1 / HZ);
    const b = sala.jugadores.get("b")!;
    const ctx = { pista, items: ITEMS, tickHz: HZ, yo: { id: "a", carro: predicho }, otros: [{ id: "b", carro: copiarCarro(b.carro) }] };
    const [provisional] = predecirUso(ctx, indice);
    sala.recibirControles("a", ctrl);
    const real = sala.entidades.find((e) => e.item === indice)!;
    // Ten ticks: both move the same
    for (let t = 0; t < 10; t++) {
      avanzarProvisional(ctx, provisional);
      sala.paso();
    }
    expect(provisional.x).toBeCloseTo(real.x, 3);
    expect(provisional.y).toBeCloseTo(real.y, 3);
  });

  it("an item with nothing to predict (or no item) changes nothing", () => {
    const pista = prepararPista(circuito);
    const { a } = salaConItem(-1);
    const carro = copiarCarro(a.carro);
    expect(predecirUso({ pista, items: ITEMS, tickHz: HZ, yo: { id: "a", carro }, otros: [] }, -1)).toEqual([]);
    expect(carro).toEqual(a.carro);
  });
});
