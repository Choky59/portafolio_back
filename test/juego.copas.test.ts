import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { Sala } from "../src/juego/servidor/salas";
import { crearMente } from "../src/juego/servidor/bots";
import { sacarItem } from "../src/juego/servidor/items";
import { ALTURA_LIBRE, PARAMETROS_FISICA, avanzarCarro, chocarCarros, copiarCarro, crearCarro, rapidez } from "../src/juego/compartido/fisica";
import { lateralEnPista, prepararPista, proyectar, puntoEnPista } from "../src/juego/compartido/pista";
import { fusionarProgreso, sanearProgreso } from "../src/juego/compartido/protocolo";
import { readdirSync } from "fs";

const DIR = path.join(__dirname, "..", "content", "juego");
const base: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
// Saved for the Gran Cañón cup (its tracks are being prepared, hidden for now)
const GRAN_CANON = ["rodadora", "escorpion", "tormenta", "cactus", "espejismo", "agua-fresca"];
// The andamio is thrown by the eliminated, it doesn't come out of the boxes. Gancho and carretilla
// are being tried out together (the ladrillo was dropped)
const CONSTRUCCION = ["iman", "martillo", "clavos", "cemento", "casco", "gancho", "carretilla"];

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
      // 6 (Construcción has 8 for now, while its last item is being chosen)
      expect(copa.items!.length).toBeGreaterThanOrEqual(6);
      for (const id of copa.pistas) {
        const c = circuitos.find((x) => x.id === id)!;
        expect(c.items).toEqual(copa.items);
        expect(c.espectador).toBe(copa.espectador);
        // Excavación tiene sus dos mecanismos activables en lugar de la patrulla automática.
        expect((c.ambiente?.length ?? 0) + (c.excavacion ? 2 : 0)).toBeGreaterThan(0);
      }
      // Every mechanic is used by a single item of a single cup
      const mecanicas = copa.items!.map((id) => ITEMS.find((i) => i.id === id)!.mecanica);
      expect(new Set(mecanicas).size).toBe(copa.items!.length);
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
  it("imán: with someone ahead it steals their speed and pulls you toward them", () => {
    const { sala, j } = nuevaSala()
    // Both going at 20 m/s
    for (const id of ["a", "b"]) Object.assign(j(id).carro, { vx: 20 * Math.cos(j(id).carro.angulo), vy: 20 * Math.sin(j(id).carro.angulo) })
    const antes = Math.hypot(j("b").carro.x - j("a").carro.x, j("b").carro.y - j("a").carro.y)
    usar(sala, "iman")
    sala.paso()
    const velocidad = (id: string) => Math.hypot(j(id).carro.vx, j(id).carro.vy)
    expect(velocidad("b")).toBeLessThan(20)
    expect(velocidad("a")).toBeGreaterThan(19.5)
    correr(sala, 2 * HZ, [], ["a", "b"])
    const despues = Math.hypot(j("b").carro.x - j("a").carro.x, j("b").carro.y - j("a").carro.y)
    expect(despues).toBeLessThan(antes - 3)
    expect(entidad(sala, "iman")?.etapa ?? 0).toBe(0)
  })

  it("imán: catching up lets go, gives back what was stolen, and their car doesn't slow you", () => {
    const { sala, j } = nuevaSala()
    for (const id of ["a", "b"]) Object.assign(j(id).carro, { vx: 20 * Math.cos(j(id).carro.angulo), vy: 20 * Math.sin(j(id).carro.angulo) })
    usar(sala, "iman")
    correr(sala, HZ / 2, [], ["a", "b"])
    const iman = entidad(sala, "iman")!
    expect(iman.robado).toBeGreaterThan(0)
    const robado = iman.robado!
    const vB = Math.hypot(j("b").carro.vx, j("b").carro.vy)
    // a catches b: right behind it, faster
    const sb = proyectar(sala.pista, j("b").carro.x, j("b").carro.y).s
    j("a").carro = crearCarro(sala.pista, sb - 4.5)
    Object.assign(j("a").carro, { vx: 30 * Math.cos(j("a").carro.angulo), vy: 30 * Math.sin(j("a").carro.angulo) })
    sala.paso()
    expect(entidad(sala, "iman")).toBeUndefined()
    expect(Math.hypot(j("b").carro.vx, j("b").carro.vy)).toBeGreaterThan(vB + robado * 0.8)
    // For a moment they go through each other: a isn't slowed by the bump
    const vA = Math.hypot(j("a").carro.vx, j("a").carro.vy)
    correr(sala, 3, [], ["a", "b"])
    expect(Math.hypot(j("a").carro.vx, j("a").carro.vy)).toBeGreaterThan(vA - 3)
  })

  it("imán: with nobody ahead it lands on the ground as a field that pulls in and slows the others", () => {
    const { sala, j } = nuevaSala()
    // The other car far ahead, out of reach (70 m): nobody to hook
    j("b").carro = crearCarro(sala.pista, 160)
    correr(sala, 1)
    usar(sala, "iman")
    correr(sala, 2, [], ["a"])
    const campo = entidad(sala, "iman")!
    expect(campo.etapa).toBe(1)
    // b drives into the field at full throttle: it ends near the center, slower than outside
    j("b").carro = crearCarro(sala.pista, 10)
    correr(sala, HZ, ["b"])
    const dentro = Math.hypot(j("b").carro.x - campo.x, j("b").carro.y - campo.y)
    expect(dentro).toBeLessThan(8)
    // Slower than the same second at full throttle without the field
    const sinCampo = crearCarro(sala.pista, 10)
    for (let t = 0; t < HZ; t++) avanzarCarro(sinCampo, { giro: 0, acel: 1, freno: 0, mano: false }, PARAMETROS_FISICA, sala.pista, 1 / HZ)
    expect(Math.hypot(j("b").carro.vx, j("b").carro.vy)).toBeLessThan(Math.hypot(sinCampo.vx, sinCampo.vy) * 0.75)
  })

  it("casco: invincible to everything, and in a crash the other one takes all of it", () => {
    const { sala, j } = nuevaSala()
    Object.assign(j("a").carro, { aturdido: 40 })
    usar(sala, "casco")
    sala.paso()
    expect(j("a").carro.aturdido).toBe(0)
    // No shield bubble: the helmet alone is enough
    expect(j("a").carro.escudo).toBe(0)
    expect(j("a").carro.pesado).toBeGreaterThan(0)
    // Items bounce off
    sala.golpear(j("a"), 0, { aturdido: 2, resbalon: 2 })
    expect(j("a").carro).toMatchObject({ aturdido: 0, resbalon: 0 })
    // A meteor doesn't crush it
    sala.aplastar(j("a").carro.x, j("a").carro.y, 3)
    expect(j("a").vivo).toBe(true)
    // In a crash: b gets the push, a doesn't
    const r = { ...crearCarro(sala.pista, 20, 2.4) }
    const yo = copiarCarro(j("a").carro)
    Object.assign(r, { vx: 0, vy: 0 })
    Object.assign(yo, { vy: 8 * Math.cos(yo.angulo), vx: -8 * Math.sin(yo.angulo) })
    chocarCarros(yo, r, PARAMETROS_FISICA, HZ)
    expect(yo.empujon).toBe(0)
    expect(r.empujon).toBeGreaterThan(0)
  })

  it("martillo neumático: the ring throws sideways the cars it reaches, when it reaches them", () => {
    const { sala, j } = nuevaSala({}, ["a", "b", "c"])
    j("b").carro = crearCarro(sala.pista, 21, 4) // right next to you
    j("c").carro = crearCarro(sala.pista, 20, -10.5) // at the edge of the ring
    usar(sala, "martillo")
    const lateral = (id: string) => {
      const { carro } = j(id)
      return carro.vx * -Math.sin(carro.angulo) + carro.vy * Math.cos(carro.angulo)
    }
    correr(sala, 4, [], ["a", "b", "c"])
    // The close one already flew, the far one not yet: the ring hasn't reached it
    expect(Math.abs(lateral("b"))).toBeGreaterThan(10)
    expect(Math.abs(lateral("c"))).toBeLessThan(1)
    correr(sala, HZ / 2, [], ["a", "b", "c"])
    expect(Math.abs(lateral("c"))).toBeGreaterThan(2)
  })

  it("martillo neumático leaves a cracked hole that's repaired as laps go by", () => {
    const { sala } = nuevaSala()
    usar(sala, "martillo")
    sala.paso()
    const hoyo = entidad(sala, "grieta")!
    expect(hoyo).toBeDefined()
    expect(hoyo.vida).toBe(Infinity)
    expect(ITEMS.find((i) => i.id === "grieta")?.tapar).toBe(2)
  })

  it("bolsa de clavos: for a moment it drops nails where you drive; whoever drives over them gets a flat", () => {
    const { sala, j } = nuevaSala({}, ["a", "b", "c"])
    j("b").carro = crearCarro(sala.pista, 150)
    j("c").carro = crearCarro(sala.pista, 150, 5)
    usar(sala, "clavos")
    // Already up to speed: the trail is long enough to see
    Object.assign(j("a").carro, { vx: 30 * Math.cos(j("a").carro.angulo), vy: 30 * Math.sin(j("a").carro.angulo) })
    correr(sala, HZ + 2, ["a"])
    const tramos = sala.entidades.filter((e) => ITEMS[e.item].id === "clavos" && e.etapa === 1)
    // A continuous trail: pieces of 2.5 m, each starting where the last one ended
    expect(tramos.length).toBeGreaterThan(3)
    for (let k = 1; k < tramos.length; k++) expect(Math.hypot(tramos[k].x - tramos[k - 1].x, tramos[k].y - tramos[k - 1].y)).toBeLessThan(2.6)
    expect(sala.entidades.some((e) => ITEMS[e.item].id === "clavos" && e.etapa === 0)).toBe(false)
    // b drives on the trail; c drives on the other side of the road and doesn't get a flat
    j("b").carro = crearCarro(sala.pista, 15)
    j("c").carro = crearCarro(sala.pista, 15, 5)
    correr(sala, 2 * HZ, ["b", "c"])
    expect(j("b").carro.ponchado).toBeGreaterThan(0)
    expect(j("c").carro.ponchado).toBe(0)
  })

  it("cemento fresco: just driving through it slows you more than dirt (10% more)", () => {
    const { sala, j } = nuevaSala()
    usar(sala, "cemento", "b")
    sala.paso()
    const mancha = entidad(sala, "cemento")!
    const s0 = proyectar(sala.pista, mancha.x, mancha.y).s
    // a arrives at full speed and crosses it
    j("a").carro = crearCarro(sala.pista, s0 - 10)
    Object.assign(j("a").carro, { vx: 48 * Math.cos(j("a").carro.angulo), vy: 48 * Math.sin(j("a").carro.angulo) })
    let minima = Infinity
    for (let t = 0; t < HZ; t++) {
      correr(sala, 1, ["a"])
      minima = Math.min(minima, rapidez(j("a").carro))
    }
    const tope = PARAMETROS_FISICA.velocidadMax * PARAMETROS_FISICA.superficies.tierra.velocidadMax * 0.95
    expect(minima).toBeLessThan(tope)
  })

  it("cemento fresco slows you more and more while you're in it, until you get stuck", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "cemento");
    const zona = entidad(sala, "cemento")!;
    j("b").carro = crearCarro(sala.pista, proyectar(sala.pista, zona.x, zona.y).s - 2);
    correr(sala, 2 * HZ);
    expect(j("b").carro.cemento).toBeGreaterThanOrEqual(120);
    expect(j("b").carro.lento).toBeGreaterThan(0);
  });

  it("andamio thrown by an eliminated player lands across the lane they aim at, and blocks only that lane", () => {
    const { sala, j } = nuevaSala({ espectador: "andamio", carriles: 2 }, ["a", "b", "c"]);
    sala.empezar("a");
    correr(sala, 4 * HZ, ["a", "b"]);
    j("c").vivo = false;
    // Aim at the left lane, a bit ahead of a
    const sa = proyectar(sala.pista, j("a").carro.x, j("a").carro.y).s;
    const objetivo = puntoEnPista(sala.pista, sa + 25, -3.2);
    expect(sala.lanzarMeteorito("c", objetivo.x, objetivo.y)).toBeNull();
    correr(sala, 2 * HZ);
    const andamio = entidad(sala, "andamio")!;
    expect(andamio.etapa).toBe(1);
    const s = proyectar(sala.pista, andamio.x, andamio.y).s;
    // One car in each lane drives at it: only the one in that lane is stopped
    j("a").vivo = true;
    j("b").carro = crearCarro(sala.pista, s - 30, -3.5);
    j("c").carro = crearCarro(sala.pista, s - 30, 3.5);
    j("c").vivo = true;
    correr(sala, 2 * HZ, ["b", "c"]);
    const pasaron = ["b", "c"].filter((id) => proyectar(sala.pista, j(id).carro.x, j(id).carro.y).s > s + 2);
    expect(pasaron).toEqual(["c"]);
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

describe("Copa Construcción: gancho, carretilla y ladrillo", () => {
  it("gancho: lifts you, nothing on the ground touches you up there, and drops you ~30 m ahead", () => {
    const { sala, j } = nuevaSala();
    const s0 = proyectar(sala.pista, j("a").carro.x, j("a").carro.y).s;
    // Keeps your inertia (no push forward): a drives at 24 m/s along the track
    const a0 = j("a").carro;
    Object.assign(a0, { vx: 24 * Math.cos(a0.angulo), vy: 24 * Math.sin(a0.angulo) });
    usar(sala, "gancho");
    sala.paso();
    expect(j("a").carro.z).toBeGreaterThan(0);
    expect(j("a").carro.colgado).toBeGreaterThan(0);
    expect(Math.hypot(j("a").carro.vx, j("a").carro.vy)).toBeCloseTo(24, 0);
    expect(entidad(sala, "gancho")).toBeDefined();
    correr(sala, Math.round(0.6 * HZ), [], ["a", "b"]);
    expect(j("a").carro.z).toBeGreaterThan(ALTURA_LIBRE);
    // Up in the air, a hit from the ground doesn't reach it
    sala.golpear(sala.conductores().find((c) => c.id === "a")!, 0, { aturdido: 1, frenar: 0.1 });
    expect(j("a").carro.aturdido).toBe(0);
    correr(sala, Math.round(1.2 * HZ), [], ["a", "b"]);
    expect(j("a").carro.z).toBe(0);
    expect(entidad(sala, "gancho")).toBeUndefined();
    const avanzo = proyectar(sala.pista, j("a").carro.x, j("a").carro.y).s - s0;
    expect(avanzo).toBeGreaterThan(26);
    expect(avanzo).toBeLessThan(45);
  });

  it("carretilla: rolls backwards along the road and knocks over the first one coming behind", () => {
    const { sala, j } = nuevaSala();
    // b (ahead) throws it back at a
    usar(sala, "carretilla", "b");
    correr(sala, 2 * HZ, [], ["a", "b"]);
    expect(entidad(sala, "carretilla")).toBeUndefined();
    expect(vistos.some((e) => (e as { tipo: string; id?: string }).tipo === "golpe" && (e as { id: string }).id === "a")).toBe(true);
    expect(j("b").carro.aturdido).toBe(0);
  });

  it("carretilla: if it hits no one it stays tipped over on the road for a while", () => {
    const { sala } = nuevaSala();
    // a is last: nobody behind
    usar(sala, "carretilla");
    correr(sala, Math.round(4.2 * HZ), [], ["a", "b"]);
    const volteada = entidad(sala, "carretilla")!;
    expect(volteada.etapa).toBe(1);
    const s = proyectar(sala.pista, volteada.x, volteada.y).s;
    correr(sala, HZ, [], ["a", "b"]);
    expect(proyectar(sala.pista, volteada.x, volteada.y).s).toBeCloseTo(s, 5);
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

  it("an eliminated player can throw another andamio as soon as the 4 s reload ends (even if the last one is still on the road)", () => {
    const { sala, j } = nuevaSala({ espectador: "andamio" }, ["a", "b", "c"])
    sala.empezar("a")
    correr(sala, 4 * HZ, ["a", "b"])
    j("c").vivo = false
    const punto = () => {
      const sa = proyectar(sala.pista, j("a").carro.x, j("a").carro.y).s
      return puntoEnPista(sala.pista, sa + 25, 0)
    }
    let p = punto()
    expect(sala.lanzarMeteorito("c", p.x, p.y)).toBeNull()
    correr(sala, 2 * HZ, ["a", "b"])
    p = punto()
    expect(sala.lanzarMeteorito("c", p.x, p.y)).toMatch(/no está listo/)
    correr(sala, 2 * HZ + 2, ["a", "b"])
    expect(entidad(sala, "andamio")).toBeDefined()
    p = punto()
    expect(sala.lanzarMeteorito("c", p.x, p.y)).toBeNull()
  })

  it("in Construction the eliminated throw scaffolding; elsewhere, meteors as before", () => {
    for (const [espectador, mecanica] of [["andamio", "barrera"], [undefined, "meteorito"]] as const) {
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
