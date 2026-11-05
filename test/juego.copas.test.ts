import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { Sala } from "../src/juego/servidor/salas";
import { crearMente } from "../src/juego/servidor/bots";
import { sacarItem } from "../src/juego/servidor/items";
import { crearCarro, rapidez } from "../src/juego/compartido/fisica";
import { lateralEnPista, prepararPista, proyectar } from "../src/juego/compartido/pista";
import { fusionarProgreso, sanearProgreso } from "../src/juego/compartido/protocolo";
import { readdirSync } from "fs";

const DIR = path.join(__dirname, "..", "content", "juego");
const base: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
// Saved for the Gran Cañón cup (its tracks are being prepared, hidden for now)
const GRAN_CANON = ["rodadora", "escorpion", "tormenta", "cactus", "espejismo", "agua-fresca"];
const CONSTRUCCION = ["iman", "martillo", "clavos", "cemento", "andamio", "casco"];

/** A room on the test circuit with A at s = 20 and B ahead at s = 60 (both stopped), on the first straight */
function nuevaSala(circuito: Partial<Circuito> = {}, jugadores = ["a", "b"]) {
  const sala = new Sala("HMO-3333", { ...base, cajas: [], ...circuito }, HZ, 5, ITEMS, () => 0.3);
  jugadores.forEach((id, i) => sala.agregar(id, { nombre: id.toUpperCase(), color: ["rojo", "azul", "verde"][i] }));
  const j = (id: string) => sala.jugadores.get(id)!;
  j("a").carro = crearCarro(sala.pista, 20);
  j("b").carro = crearCarro(sala.pista, 60);
  sala.paso();
  return { sala, j };
}

let seq = 0;
const seqs = new Map<string, number>();
beforeEach(() => {
  seq = 0;
  seqs.clear();
});

/** A uses this item (one control, not moving) */
function usar(sala: Sala, idItem: string, quien = "a") {
  sala.jugadores.get(quien)!.item = ITEMS.findIndex((i) => i.id === idItem);
  sala.recibirControles(quien, { seq: ++seq, giro: 0, acel: 0, freno: 0, mano: false, item: true });
}

/** Every event of the room since the test started (the room empties its list every tick) */
let vistos: unknown[] = [];
beforeEach(() => (vistos = []));

/**
 * `n` ticks; the listed players drive straight at full throttle and the `quietos` send controls
 * without moving (the server only simulates a car with its own controls, like in the real game)
 */
function correr(sala: Sala, n: number, quienes: string[] = [], quietos: string[] = []) {
  for (let t = 0; t < n; t++) {
    for (const id of [...quienes, ...quietos]) {
      const s = (seqs.get(id) ?? 1000) + 1;
      seqs.set(id, s);
      sala.recibirControles(id, { seq: s, giro: 0, acel: quienes.includes(id) ? 1 : 0, freno: 0, mano: false, item: false });
    }
    sala.paso();
    vistos.push(...sala.eventos);
  }
}

const entidad = (sala: Sala, idItem: string) => sala.entidades.find((e) => ITEMS[e.item].id === idItem);

describe("the cups", () => {
  const copas: { id: string; pistas: string[]; items?: string[]; espectador?: string }[] = JSON.parse(readFileSync(path.join(DIR, "copas.json"), "utf8"));
  const circuitos = readdirSync(path.join(DIR, "circuitos")).map((f) => JSON.parse(readFileSync(path.join(DIR, "circuitos", f), "utf8")) as Circuito);

  it("no track is longer than 1.4 km", () => {
    for (const c of circuitos) expect([c.id, prepararPista(c).longitud <= 1400]).toEqual([c.id, true]);
  });

  it("the Desert cup is the game as it was: its 3 tracks with the original items, street vendors and meteors", () => {
    const desierto = copas.find((c) => c.id === "desierto")!;
    expect(desierto.pistas).toEqual(["hermosillo", "san-carlos", "desierto"]);
    for (const id of desierto.pistas) {
      const c = circuitos.find((x) => x.id === id)!;
      expect([id, c.items, c.espectador, c.calle, c.oculto]).toEqual([id, undefined, undefined, undefined, undefined]);
    }
  });

  it("there are 6 cups; the new ones built have 3 tracks, 6 items of their own and what their spectators throw", () => {
    expect(copas).toHaveLength(6);
    for (const copa of copas.filter((c) => c.pistas.length && c.items)) {
      expect(copa.pistas).toHaveLength(3);
      expect(copa.items).toHaveLength(6);
      for (const id of copa.pistas) {
        const c = circuitos.find((x) => x.id === id)!;
        expect(c.items).toEqual(copa.items);
        expect(c.espectador).toBe(copa.espectador);
        expect(c.ambiente?.length).toBeGreaterThan(0);
      }
      // Every mechanic is used by a single item of a single cup
      const mecanicas = copa.items!.map((id) => ITEMS.find((i) => i.id === id)!.mecanica);
      expect(new Set(mecanicas).size).toBe(6);
    }
    // The tracks being prepared for a cup aren't offered yet
    for (const copa of copas as { enPreparacion?: string[] }[]) {
      for (const id of copa.enPreparacion ?? []) expect(circuitos.find((x) => x.id === id)!.oculto).toBe(true);
    }
    const todas = copas.flatMap((c) => c.items ?? []).map((id) => ITEMS.find((i) => i.id === id)!.mecanica);
    expect(new Set(todas).size).toBe(todas.length);
  });

  it("the progress also keeps each cup's Hard result, under its own key", () => {
    const progreso = Object.fromEntries(
      ["desierto", "construccion", "espacio", "volcan", "nieve", "canon"].flatMap((id) => [
        [id, { mejorLugar: 1, mejoresPuntos: 30 }],
        [`${id}-dificil`, { mejorLugar: 2, mejoresPuntos: 20 }],
      ]),
    );
    const limpio = sanearProgreso(progreso);
    expect(Object.keys(limpio)).toHaveLength(12);
    expect(limpio["construccion-dificil"]).toEqual({ mejorLugar: 2, mejoresPuntos: 20 });
  });

  it("the campaign progress keeps the best of each cup, and junk from the browser is dropped", () => {
    expect(sanearProgreso({ desierto: { mejorLugar: 2, mejoresPuntos: 24 }, "<script>": { mejorLugar: 1 }, gruas: { mejorLugar: 9 } })).toEqual({
      desierto: { mejorLugar: 2, mejoresPuntos: 24 },
    });
    expect(
      fusionarProgreso({ desierto: { mejorLugar: 2, mejoresPuntos: 24 } }, { desierto: { mejorLugar: 3, mejoresPuntos: 27 }, construccion: { mejorLugar: 4, mejoresPuntos: 9 } }),
    ).toEqual({ desierto: { mejorLugar: 2, mejoresPuntos: 27 }, construccion: { mejorLugar: 4, mejoresPuntos: 9 } });
  });
});

describe("each cup has its own items", () => {
  it("the boxes of a Construction track only give Construction items (and the same for the Gran Cañón)", () => {
    let semilla = 7;
    const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
    for (const [copa, lista] of [["canon", GRAN_CANON], ["construccion", CONSTRUCCION]] as const) {
      const permitido = (i: Item) => (lista as readonly string[]).includes(i.id);
      const salieron = new Set<string>();
      for (let k = 0; k < 400; k++) salieron.add(ITEMS[sacarItem(ITEMS, azar, ["ataque", "trampa", "escape"][k % 3], permitido)].id);
      expect([...salieron].sort()).toEqual([...lista].sort());
      expect(ITEMS.filter((i) => lista.includes(i.id)).every((i) => i.copa === copa)).toBe(true);
    }
  });

  it("a Desert track (Hermosillo, San Carlos, Oasis: no `items`) only gives the original items", () => {
    const { sala, j } = nuevaSala({ cajas: [[0, 0]] });
    for (let k = 0; k < 40; k++) {
      j("a").item = -1;
      Object.assign(j("a").carro, { x: sala.cajas[0].x, y: sala.cajas[0].y });
      sala.cajas[0].hasta = 0;
      sala.paso();
      expect(ITEMS[j("a").item].copa).toBeUndefined();
    }
  });
});

describe("Gran Cañón items (saved for that cup)", () => {
  it("rodadora rolls along the road and tangles the first car it reaches", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "rodadora");
    correr(sala, 3 * HZ);
    expect(j("b").carro.enredado).toBeGreaterThan(0);
    expect(entidad(sala, "rodadora")).toBeUndefined();
  });

  it("escorpión sticks to the car ahead, can be passed on by bumping, and stings when time is up", () => {
    const { sala, j } = nuevaSala({}, ["a", "b", "c"]);
    j("c").carro = crearCarro(sala.pista, 66);
    usar(sala, "escorpion");
    correr(sala, 1);
    expect(entidad(sala, "escorpion")!.objetivo).toBe("b");
    // C runs into B from behind: it's C's now
    j("c").carro = crearCarro(sala.pista, 57);
    correr(sala, 8, ["c"]);
    expect(vistos).toContainEqual(expect.objectContaining({ tipo: "pasado", de: "b", a: "c" }));
    expect(entidad(sala, "escorpion")!.objetivo).toBe("c");
    correr(sala, 4 * HZ);
    expect(entidad(sala, "escorpion")).toBeUndefined();
    expect(vistos).toContainEqual(expect.objectContaining({ tipo: "golpe", id: "c" }));
  });

  it("cactus grows behind you, becomes solid, and punctures whoever hits it", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "cactus");
    correr(sala, HZ + 2);
    const cactus = entidad(sala, "cactus")!;
    expect(cactus.etapa).toBe(1);
    // B comes from behind, straight at it
    j("b").carro = crearCarro(sala.pista, proyectar(sala.pista, cactus.x, cactus.y).s - 25, 0);
    correr(sala, 2 * HZ, ["b"]);
    expect(j("b").carro.ponchado).toBeGreaterThan(0);
    // Solid: B didn't drive through it
    expect(proyectar(sala.pista, j("b").carro.x, j("b").carro.y).s).toBeLessThan(proyectar(sala.pista, cactus.x, cactus.y).s);
  });

  it("tormenta pushes everybody else sideways for a while, not whoever used it", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "tormenta");
    expect(j("b").carro.viento).toBeGreaterThan(0);
    expect(Math.hypot(j("b").carro.vientoX, j("b").carro.vientoY)).toBeCloseTo(4.5, 1);
    expect(j("a").carro.viento).toBe(0);
    const antes = { x: j("b").carro.x, y: j("b").carro.y };
    correr(sala, HZ, [], ["b"]);
    // ~4.5 m sideways in a second, toward the edge
    expect(Math.hypot(j("b").carro.x - antes.x, j("b").carro.y - antes.y)).toBeGreaterThan(3.5);
  });

  it("espejismo is a fake box ahead: whoever grabs it spins and gets no item", () => {
    const { sala, j } = nuevaSala();
    j("b").carro = crearCarro(sala.pista, 30);
    usar(sala, "espejismo", "b");
    const caja = entidad(sala, "espejismo")!;
    expect(proyectar(sala.pista, caja.x, caja.y).s).toBeCloseTo(60, -1);
    correr(sala, 3 * HZ, ["a"]);
    expect(entidad(sala, "espejismo")).toBeUndefined();
    expect(vistos).toContainEqual(expect.objectContaining({ tipo: "golpe", id: "a" }));
    expect(j("a").item).toBe(-1);
  });

  it("agua fresca clears what's bad and makes hits bounce off for 3 s", () => {
    const { sala, j } = nuevaSala();
    Object.assign(j("a").carro, { aturdido: 50, ponchado: 50, enredado: 50 });
    usar(sala, "agua-fresca");
    vistos.push(...sala.eventos);
    expect(j("a").carro).toMatchObject({ aturdido: 0, ponchado: 0, enredado: 0 });
    expect(j("a").carro.escudo).toBeGreaterThan(2 * HZ);
    sala.golpear(j("a"), 0, { aturdido: 2 });
    vistos.push(...sala.eventos);
    expect(j("a").carro.aturdido).toBe(0);
    expect(vistos).toContainEqual(expect.objectContaining({ tipo: "escudo", id: "a" }));
  });
});

describe("Copa Construcción items", () => {
  it("imán de grúa hooks the car ahead and pulls it back toward you", () => {
    const { sala, j } = nuevaSala();
    const antes = Math.hypot(j("b").carro.x - j("a").carro.x, j("b").carro.y - j("a").carro.y);
    usar(sala, "iman");
    correr(sala, 2 * HZ, [], ["a", "b"]);
    const despues = Math.hypot(j("b").carro.x - j("a").carro.x, j("b").carro.y - j("a").carro.y);
    expect(despues).toBeLessThan(antes - 3);
  });

  it("martillo neumático throws the cars next to you sideways", () => {
    const { sala, j } = nuevaSala();
    j("b").carro = crearCarro(sala.pista, 21, 4);
    usar(sala, "martillo");
    const { carro } = j("b");
    const lateral = carro.vx * -Math.sin(carro.angulo) + carro.vy * Math.cos(carro.angulo);
    expect(Math.abs(lateral)).toBeGreaterThan(10);
  });

  it("bolsa de clavos covers the road from side to side: every car that crosses gets a flat", () => {
    const { sala, j } = nuevaSala({}, ["a", "b", "c"]);
    usar(sala, "clavos");
    // Two cars cross it, on opposite sides of the road
    j("b").carro = crearCarro(sala.pista, 0, -5);
    j("c").carro = crearCarro(sala.pista, 0, 5);
    correr(sala, 2 * HZ, ["b", "c"]);
    expect(j("b").carro.ponchado).toBeGreaterThan(0);
    expect(j("c").carro.ponchado).toBeGreaterThan(0);
  });

  it("cemento fresco slows you more and more while you're in it, until you get stuck", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "cemento");
    const zona = entidad(sala, "cemento")!;
    j("b").carro = crearCarro(sala.pista, proyectar(sala.pista, zona.x, zona.y).s - 2);
    correr(sala, 2 * HZ);
    expect(j("b").carro.cemento).toBeGreaterThanOrEqual(120);
    expect(j("b").carro.lento).toBeGreaterThan(0);
  });

  it("andamio falls ahead and blocks every lane but one", () => {
    const { sala, j } = nuevaSala({}, ["a", "b", "c"]);
    usar(sala, "andamio");
    correr(sala, 2 * HZ);
    const andamio = entidad(sala, "andamio")!;
    expect(andamio.etapa).toBe(1);
    const s = proyectar(sala.pista, andamio.x, andamio.y).s;
    // One car on each side of the road drives at it: one gets through, the other doesn't
    j("b").carro = crearCarro(sala.pista, s - 30, -4);
    j("c").carro = crearCarro(sala.pista, s - 30, 4);
    correr(sala, 2 * HZ, ["b", "c"]);
    const pasaron = ["b", "c"].filter((id) => proyectar(sala.pista, j(id).carro.x, j(id).carro.y).s > s + 2);
    expect(pasaron).toHaveLength(1);
  });

  it("casco: three times as heavy, you shove others in a crash and barely slow down", () => {
    const choque = (conCasco: boolean) => {
      const { sala, j } = nuevaSala();
      j("b").carro = crearCarro(sala.pista, 32);
      if (conCasco) usar(sala, "casco");
      correr(sala, HZ, ["a"]);
      return { a: rapidez(j("a").carro), b: rapidez(j("b").carro) };
    };
    const sin = choque(false);
    const con = choque(true);
    expect(con.a).toBeGreaterThan(sin.a);
    expect(con.b).toBeGreaterThan(sin.b);
  });
});

describe("what makes each track unique", () => {
  it("the steamroller goes back and forth across the road, is solid and stuns whoever it catches", () => {
    const { sala, j } = nuevaSala({ ambiente: [{ item: "aplanadora", s: 70, desde: -6, hasta: 6, velocidad: 4 }] });
    const aplanadora = entidad(sala, "aplanadora")!;
    // It reaches both edges of the road and turns back
    const laterales: number[] = [];
    for (let t = 0; t < 12 * HZ; t++) {
      sala.paso();
      laterales.push(lateralEnPista(sala.pista, aplanadora.x, aplanadora.y));
    }
    expect(Math.min(...laterales)).toBeLessThan(-5);
    expect(Math.max(...laterales)).toBeGreaterThan(5);
    expect(sala.entidades.filter((e) => ITEMS[e.item].id === "aplanadora")).toHaveLength(1);
    // B drives into it
    j("b").carro = crearCarro(sala.pista, 55, 0);
    Object.assign(aplanadora, { x: j("b").carro.x + 10, y: j("b").carro.y, golpes: 10 * HZ });
    correr(sala, HZ, ["b"]);
    expect(vistos).toContainEqual(expect.objectContaining({ tipo: "golpe", id: "b" }));
  });

  it("in Construction the eliminated throw oil (a slippery puddle); elsewhere, meteors as before", () => {
    for (const [espectador, mecanica] of [["aceite", "mancha"], [undefined, "meteorito"]] as const) {
      const { sala, j } = nuevaSala({ espectador }, ["a", "b", "c"]);
      sala.empezar("a");
      correr(sala, 4 * HZ, ["a", "b"]);
      j("c").vivo = false;
      const { x, y } = j("a").carro;
      expect(sala.lanzarMeteorito("c", x, y)).toBeNull();
      expect(ITEMS[sala.entidades.at(-1)!.item].mecanica).toBe(mecanica);
    }
  });

  it("bots of a higher level are faster", () => {
    const azar = () => 0.5;
    expect(crearMente(azar, 3).habilidad).toBeGreaterThan(crearMente(azar, 0).habilidad);
  });
});
