import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { Sala, TUTORIAL } from "../src/juego/servidor/salas";
import { DURACION } from "../src/juego/servidor/reglas";
import { prisaDeRonda } from "../src/juego/compartido/fisica";
import { crearMente, pensar } from "../src/juego/servidor/bots";
import { rng } from "./juego.utiles";

const DIR = path.join(__dirname, "..", "content", "juego");
const circuito: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", `${TUTORIAL.circuito}.json`), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;

/** The tutorial room: you ("a") and its two calm bots, already started */
function salaTutorial() {
  const sala = new Sala("HMO-7777", circuito, HZ, 5, ITEMS, rng(7));
  sala.agregar("a", { nombre: "A", color: "rojo" });
  sala.prepararTutorial();
  expect(sala.empezar("a")).toBeNull();
  return { sala, yo: sala.jugadores.get("a")!, bots: [...sala.jugadores.values()].filter((j) => j.mente) };
}

let seq = 0;
/** You drive like a careful bot (following the track at full throttle) */
const piloto = crearMente(rng(3), 4);
/** Runs `ticks` ticks while you drive, with `item` pressed or not */
function correr(sala: Sala, ticks: number, item = false) {
  for (let t = 0; t < ticks; t++) {
    const yo = sala.jugadores.get("a")!;
    // Like the room does with its bots: during the countdown it doesn't try to move (or it would think it's stuck)
    const ctrl = pensar(piloto, yo.carro, sala.pista, sala.tick, HZ, false, rng(t), sala.fase === "carrera" && yo.vivo);
    sala.recibirControles("a", { ...ctrl, seq: ++seq, item });
    sala.paso();
  }
}

/** The round's top-speed multiplier right now (the one everybody would have without the tutorial) */
const prisaRonda = (sala: Sala) => prisaDeRonda((sala as unknown as { ticksCarrera: number }).ticksCarrera / HZ);
const cuentaTicks = (DURACION.cuenta + TUTORIAL.cuentaExtra) * HZ;

describe("tutorial", () => {
  it("has two calm bots that never go after you, and isn't listed as an open room", () => {
    const { sala, bots } = salaTutorial();
    expect(bots).toHaveLength(TUTORIAL.bots);
    for (const b of bots) expect([b.mente!.personalidad.detras, b.mente!.personalidad.delante]).toEqual([0, 0]);
    expect(sala.partida().leccion).toBe(1);
    expect(sala.meta).toBe(TUTORIAL.lecciones);
  });

  it("lesson 1: you drive alone, with a longer countdown, no item boxes, and it ends on time", () => {
    const { sala, yo, bots } = salaTutorial();
    expect(sala.fase).toBe("cuenta");
    expect(bots.every((b) => !b.vivo)).toBe(true);
    expect(sala.instantanea().ci).toHaveLength(sala.cajas.length);
    correr(sala, cuentaTicks);
    expect(sala.fase).toBe("carrera");
    // Alone, the round doesn't end right away (a normal round ends with one car left)
    correr(sala, 5 * HZ);
    expect(sala.fase).toBe("carrera");
    correr(sala, (TUTORIAL.segundos[0] - 5) * HZ + 2);
    expect(sala.fase).toBe("ronda-fin");
    expect(sala.ganadorRonda).toBe(yo.id);
  });

  it("goes through the three lessons and ends with you as the winner", () => {
    const { sala, yo, bots } = salaTutorial();
    correr(sala, cuentaTicks + (TUTORIAL.segundos[0] + 1) * HZ);
    correr(sala, DURACION.rondaFin * HZ + 2);
    // Lesson 2: the bots race (you start first), and the boxes still don't give items
    expect(sala.partida().leccion).toBe(2);
    expect(sala.fase).toBe("cuenta");
    expect(bots.every((b) => b.vivo)).toBe(true);
    expect(sala.instantanea().ci).toHaveLength(sala.cajas.length);
    for (const b of bots) expect(sala.recorrido(yo.id)).toBeGreaterThan(sala.recorrido(b.id));
    // It ends at most at its time (plus the festejo); then lesson 3, from its countdown
    let t = 0;
    for (; t < cuentaTicks + (TUTORIAL.segundos[1] + DURACION.rondaFin + 1) * HZ && sala.partida().leccion === 2; t++) correr(sala, 1);
    // Lesson 3: you always have the item, and it comes back after you use it
    expect(sala.partida().leccion).toBe(3);
    expect(sala.fase).toBe("cuenta");
    correr(sala, 2);
    const burro = ITEMS.findIndex((i) => i.id === TUTORIAL.item);
    expect(yo.item).toBe(burro);
    correr(sala, cuentaTicks);
    correr(sala, 1, true);
    expect(yo.item).toBe(-1);
    correr(sala, Math.ceil((TUTORIAL.recargaItem + 0.2) * HZ));
    if (yo.vivo) expect(yo.item).toBe(burro);
    // It ends on its own (bots out, or its time) and then the results, within its time and the festejo
    for (let t = 0; t < (TUTORIAL.segundos[2] + DURACION.rondaFin + 1) * HZ && sala.fase !== "resultados"; t++) correr(sala, 1);
    expect(sala.fase).toBe("resultados");
    expect(sala.ganador).toBe(yo.id);
    expect(sala.partida().leccion).toBe(3);
  });

  it("a bot you hit flies off much farther than in a normal room", () => {
    const empuje = (tutorial: boolean) => {
      const sala = new Sala("HMO-7778", circuito, HZ, 5, ITEMS, rng(7));
      sala.agregar("a", { nombre: "A", color: "rojo" });
      if (tutorial) sala.prepararTutorial();
      else sala.agregarBot(0);
      const yo = sala.jugadores.get("a")!;
      const bot = [...sala.jugadores.values()].find((j) => j.mente)!;
      // Side by side, you coming into it sideways
      Object.assign(bot.carro, { x: 0, y: 0, angulo: 0, vx: 20, vy: 0, w: 0 });
      Object.assign(yo.carro, { x: 0, y: -2.2, angulo: 0, vx: 20, vy: 6, w: 0 });
      (sala as unknown as { chocar(a: unknown, b: unknown): void }).chocar(yo, bot);
      return { lateral: Math.abs(bot.carro.vy), empujon: bot.carro.empujon };
    };
    const normal = empuje(false);
    const tutorial = empuje(true);
    expect(tutorial.lateral).toBeGreaterThan(normal.lateral * 2);
    expect(tutorial.lateral).toBeGreaterThanOrEqual(TUTORIAL.golpe.minimo - 0.01);
    expect(tutorial.empujon).toBeGreaterThanOrEqual(TUTORIAL.golpe.empujonS);
  });

  it("lesson 2: your top speed is the bots', and it drops on its own if you get far ahead", () => {
    const { sala, yo, bots } = salaTutorial();
    sala.tutorial!.leccion = 2;
    for (const b of bots) b.vivo = true;
    correr(sala, 1);
    const prisa = bots[0].carro.prisa;
    expect(yo.carro.prisa).toBeCloseTo(prisa * TUTORIAL.ritmo.igual, 5);
    // Far ahead of every bot: it goes down little by little, to the minimum
    for (const b of bots) b.progreso = { ...b.progreso, vueltas: yo.progreso.vueltas - 1 };
    (sala as unknown as { fase: string }).fase = "carrera";
    correr(sala, 1);
    expect(yo.carro.prisa).toBeLessThan(prisa * TUTORIAL.ritmo.igual);
    expect(yo.carro.prisa).toBeGreaterThan(prisa * TUTORIAL.ritmo.minimo);
  });

  it("rubber banding: if you fall behind the bots, you go faster and they go slower", () => {
    for (const leccion of [2, 3]) {
      const { sala, yo, bots } = salaTutorial();
      sala.tutorial!.leccion = leccion;
      for (const b of bots) b.vivo = true;
      correr(sala, 1);
      const prisa = prisaRonda(sala);
      const normal = leccion === 2 ? TUTORIAL.ritmo.igual : 1;
      expect(yo.carro.prisa).toBeCloseTo(prisa * normal, 5);
      // A lap behind the bots
      yo.progreso = { ...yo.progreso, vueltas: yo.progreso.vueltas - 1 };
      (sala as unknown as { fase: string }).fase = "carrera";
      correr(sala, 2 * HZ);
      expect(yo.carro.prisa).toBeCloseTo(prisaRonda(sala) * TUTORIAL.alcance.impulso, 2);
      for (const b of bots) if (b.vivo) expect(b.carro.prisa).toBeCloseTo(prisaRonda(sala) * TUTORIAL.alcance.botsMinimo, 2);
    }
  });

  it("repeats lesson 1 if you fall off before the time is up", () => {
    const { sala, yo } = salaTutorial();
    correr(sala, cuentaTicks + 2 * HZ);
    // Off the track and far away: out of the picture, it blows up
    Object.assign(yo.carro, { x: yo.carro.x + 500, y: yo.carro.y + 500, vx: 0, vy: 0 });
    correr(sala, 2 * HZ);
    expect(yo.vivo).toBe(false);
    expect(sala.fase).toBe("ronda-fin");
    correr(sala, DURACION.rondaFin * HZ + 2);
    expect(sala.partida().leccion).toBe(1);
    expect(sala.fase).toBe("cuenta");
  });
});
