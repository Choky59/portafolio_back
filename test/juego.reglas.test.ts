import { readFileSync } from "fs";
import path from "path";
import { Circuito } from "../src/juego/compartido/tipos";
import { Sala } from "../src/juego/servidor/salas";
import { DURACION } from "../src/juego/servidor/reglas";
import { enVista, PARAMETROS_CAMARA_PARTIDA } from "../src/juego/compartido/camara";
import { ControlesRed } from "../src/juego/compartido/protocolo";
import { puntoEnPista } from "../src/juego/compartido/pista";

const base: Circuito = JSON.parse(
  readFileSync(path.join(__dirname, "..", "content", "juego", "circuitos", "prueba.json"), "utf8"),
);
// A cliff next to the first straight, off the road
const circuito: Circuito = { ...base, barrancos: [[[40, 20], [60, 20], [60, 40], [40, 40]]] };
const HZ = 30;

function nuevaSala(n = 2, meta = 5) {
  const sala = new Sala("HMO-1111", circuito, HZ, meta);
  const ids = ["a", "b", "c", "d"].slice(0, n);
  ids.forEach((id) => sala.agregar(id, { nombre: id.toUpperCase(), color: "rojo" }));
  return { sala, j: (id: string) => sala.jugadores.get(id)! };
}

const seqs = new Map<string, number>();
/** Runs `ticks` ticks; the listed players send `ctrl` every tick */
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

/** Starts a match and waits for the countdown */
function arrancar(sala: Sala) {
  expect(sala.empezar("a")).toBeNull();
  correr(sala, DURACION.cuenta * HZ);
  expect(sala.fase).toBe("carrera");
}

beforeEach(() => seqs.clear());

describe("starting a match", () => {
  it("only the host can start, and with at least 2 players", () => {
    const solo = nuevaSala(1);
    expect(solo.sala.empezar("a")).toMatch(/al menos 2/);
    const { sala } = nuevaSala(2);
    expect(sala.empezar("b")).toMatch(/Solo quien creó/);
    expect(sala.empezar("a")).toBeNull();
    expect(sala.fase).toBe("cuenta");
    expect(sala.cambioPartida).toBe(true);
  });

  it("freezes the cars during the countdown", () => {
    const { sala, j } = nuevaSala();
    sala.empezar("a");
    const antes = { ...j("a").carro };
    correr(sala, 30, {}, ["a"]);
    expect(j("a").carro.x).toBe(antes.x);
    expect(j("a").ultimoSeq).toBe(30); // consumed, not simulated
  });
});

describe("elimination", () => {
  it("blows up a car that falls into a cliff, and the last one standing scores", () => {
    const { sala, j } = nuevaSala();
    arrancar(sala);
    Object.assign(j("b").carro, { x: 50, y: 30 });
    correr(sala, 1);
    expect(j("b").vivo).toBe(false);
    expect(sala.eventos).toContainEqual(expect.objectContaining({ tipo: "explosion", id: "b", motivo: "barranco" }));
    expect(sala.fase).toBe("ronda-fin");
    expect(j("a").puntos).toBe(1);
    expect(sala.ganadorRonda).toBe("a");
  });

  it("blows up a car left out of the shared camera, but not during the grace time", () => {
    const { sala, j } = nuevaSala();
    arrancar(sala);
    // B stays on the grid; A drives away. During the grace time nobody is out
    Object.assign(j("b").carro, { x: -100, y: 330 });
    correr(sala, DURACION.gracia * HZ - 2, {}, ["a"]);
    expect(j("b").vivo).toBe(true);
    // After it, B is out of the picture for longer than fueraMax: boom
    correr(sala, DURACION.fueraMax * HZ + 3, {}, ["a"]);
    expect(j("b").vivo).toBe(false);
    expect(sala.eventos).toContainEqual(expect.objectContaining({ id: "b", motivo: "atras" }));
  });

  it("zooms out instead of blowing up someone who is just a bit behind", () => {
    const { sala, j } = nuevaSala();
    arrancar(sala);
    // A gets ~40 m ahead while B crawls: with the normal camera B would be out
    correr(sala, 45, {}, ["a"]);
    expect(sala.camara.zoom).toBeGreaterThan(1.05);
    expect(j("b").vivo).toBe(true);
  });

  it("keeps the leader in the picture", () => {
    const { sala, j } = nuevaSala();
    arrancar(sala);
    correr(sala, 60, {}, ["a", "b"]);
    for (const id of ["a", "b"]) {
      expect(enVista(sala.camara, j(id).carro.x, j(id).carro.y, 0, PARAMETROS_CAMARA_PARTIDA)).toBe(true);
    }
  });
});

describe("rounds and points", () => {
  function ganarRonda(sala: Sala, j: (id: string) => any, perdedor: string) {
    Object.assign(j(perdedor).carro, { x: 50, y: 30 });
    correr(sala, 1);
    expect(sala.fase).toBe("ronda-fin");
  }

  it("respawns everybody together where the winner was", () => {
    const { sala, j } = nuevaSala(3);
    arrancar(sala);
    correr(sala, 40, {}, ["a"]);
    Object.assign(j("b").carro, { x: 50, y: 30 });
    Object.assign(j("c").carro, { x: 45, y: 25 });
    correr(sala, 1);
    expect(sala.ganadorRonda).toBe("a");
    const donde = { ...j("a").carro };
    correr(sala, DURACION.rondaFin * HZ);
    expect(sala.fase).toBe("cuenta");
    expect(sala.ronda).toBe(2);
    for (const id of ["a", "b", "c"]) {
      expect(j(id).vivo).toBe(true);
      expect(Math.hypot(j(id).carro.x - donde.x, j(id).carro.y - donde.y)).toBeLessThan(30);
    }
  });

  it("ends the match at the goal and can play again", () => {
    const { sala, j } = nuevaSala(2, 2);
    arrancar(sala);
    ganarRonda(sala, j, "b");
    correr(sala, DURACION.rondaFin * HZ + DURACION.cuenta * HZ);
    expect(sala.fase).toBe("carrera");
    ganarRonda(sala, j, "b");
    correr(sala, DURACION.rondaFin * HZ);
    expect(sala.fase).toBe("resultados");
    expect(sala.ganador).toBe("a");
    expect(sala.partida().puntos).toEqual([{ id: "a", puntos: 2 }, { id: "b", puntos: 0 }]);

    expect(sala.empezar("a")).toBeNull();
    expect(sala.fase).toBe("cuenta");
    expect(j("a").puntos).toBe(0);
  });

  it("nobody scores if the last two go down in the same tick", () => {
    const { sala, j } = nuevaSala();
    arrancar(sala);
    Object.assign(j("a").carro, { x: 50, y: 30 });
    Object.assign(j("b").carro, { x: 55, y: 35 });
    correr(sala, 1);
    expect(sala.ganadorRonda).toBeNull();
    expect(j("a").puntos + j("b").puntos).toBe(0);
  });
});

describe("starting grid", () => {
  /** Lateral offset (m to the right of the centerline) of a car */
  const lateral = (sala: Sala, id: string) => {
    const c = sala.jugadores.get(id)!.carro;
    const p = puntoEnPista(sala.pista, sala.recorrido(id));
    return (c.x - p.x) * -Math.sin(p.angulo) + (c.y - p.y) * Math.cos(p.angulo);
  };

  it("is staggered: each car further back, alternating left and right", () => {
    const { sala } = nuevaSala(4);
    sala.empezar("a");
    const ids = ["a", "b", "c", "d"];
    const s = ids.map((id) => sala.recorrido(id));
    for (let i = 1; i < 4; i++) expect(s[i]).toBeLessThan(s[i - 1] - 3);
    expect(ids.map((id) => Math.sign(lateral(sala, id)))).toEqual([-1, 1, -1, 1]);
  });

  it("puts the round's winner at the back and the first one to blow up in front", () => {
    const { sala, j } = nuevaSala(3);
    arrancar(sala);
    // C blows up first, then B: A wins
    Object.assign(j("c").carro, { x: 50, y: 30 });
    correr(sala, 1);
    Object.assign(j("b").carro, { x: 45, y: 25 });
    correr(sala, 1);
    expect(sala.ganadorRonda).toBe("a");
    correr(sala, DURACION.rondaFin * HZ);
    expect(sala.fase).toBe("cuenta");
    expect(sala.recorrido("c")).toBeGreaterThan(sala.recorrido("b"));
    expect(sala.recorrido("b")).toBeGreaterThan(sala.recorrido("a"));
  });

  it("switches off the item boxes on the grid, so nobody starts with an item", () => {
    const conCajas = { ...circuito, cajas: [[-12, 0], [-14, 3]] as [number, number][] };
    const sala = new Sala("HMO-1111", { ...conCajas, centro: base.centro }, HZ);
    sala.agregar("a", { nombre: "A", color: "rojo" });
    sala.agregar("b", { nombre: "B", color: "azul" });
    sala.empezar("a");
    expect(sala.instantanea().ci).toEqual([0, 1]);
    correr(sala, DURACION.cuenta * HZ + 30, {}, ["a", "b"]);
    expect([...sala.jugadores.values()].every((x) => x.item < 0)).toBe(true);
  });
});

describe("people coming and going", () => {
  it("someone who joins mid-match watches until the next round", () => {
    const { sala } = nuevaSala();
    arrancar(sala);
    sala.agregar("c", { nombre: "C", color: "verde" });
    expect(sala.jugadores.get("c")!.vivo).toBe(false);
  });

  it("a disconnection can end the round", () => {
    const { sala, j } = nuevaSala(3);
    arrancar(sala);
    Object.assign(j("c").carro, { x: 50, y: 30 });
    correr(sala, 1);
    expect(sala.fase).toBe("carrera");
    sala.quitar("b");
    expect(sala.fase).toBe("ronda-fin");
    expect(sala.ganadorRonda).toBe("a");
  });

  it("with only one player left it goes back to the waiting room", () => {
    const { sala, j } = nuevaSala();
    arrancar(sala);
    sala.quitar("b");
    expect(sala.fase).toBe("espera");
    expect(j("a").vivo).toBe(true);
    expect(sala.anfitrion).toBe("a");
  });
});
