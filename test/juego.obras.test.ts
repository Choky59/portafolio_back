import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { carriles, enCierre, medidasTuberia, murosDeEntidad, prepararPista, proyectar, puntoEnPista, rampasDeEntidad } from "../src/juego/compartido/pista";
import { ALTURA_LIBRE, PARAMETROS_FISICA, avanzarCarro, circulosCarro, colisionMuros, crearCarro } from "../src/juego/compartido/fisica";
import { Sala } from "../src/juego/servidor/salas";
import type { Entidad } from "../src/juego/servidor/items";
import { lateralEnPista } from "../src/juego/servidor/bots";

const DIR = path.join(__dirname, "..", "content", "juego");
const leer = (id: string): Circuito => JSON.parse(readFileSync(path.join(DIR, "circuitos", `${id}.json`), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
const obraNegra = leer("obra-negra");
const pista = prepararPista(obraNegra);
const esCierre = (e: Entidad) => ["cierre", "tuberia"].includes(ITEMS[e.item].mecanica);

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A race in Obra Negra with two idle people (and `bots` that drive), right after the countdown */
function carrera(circuito = obraNegra, semilla = 3, bots = 0) {
  const sala = new Sala("OBR-1111", circuito, HZ, 5, ITEMS, rng(semilla));
  sala.agregar("a", { nombre: "A", color: "rojo" });
  sala.agregar("b", { nombre: "B", color: "azul" });
  for (let i = 0; i < bots; i++) expect(sala.agregarBot()).toBeNull();
  expect(sala.empezar("a")).toBeNull();
  while (sala.fase === "cuenta") sala.paso();
  expect(sala.fase).toBe("carrera");
  const s = sala as any;
  return { sala, s, cierres: (): Entidad[] => s.entidades.filter(esCierre) };
}

/** Runs the race until the first closure shows up (cars kept alive and still: only the closures matter) */
function hastaElPrimero(r: ReturnType<typeof carrera>, max = 40 * HZ) {
  for (let t = 0; t < max && !r.cierres().length; t++) {
    for (const j of r.sala.jugadores.values()) j.vivo = true;
    r.sala.paso();
  }
  return r.cierres();
}

describe("road works in Obra Negra (closures)", () => {
  it("Obra Negra has them (and the tracks outside the Construction Cup don't)", () => {
    expect(obraNegra.obras?.items.length).toBeGreaterThan(0);
    for (const id of ["hermosillo", "san-carlos", "desierto"]) expect(leer(id).obras).toBeUndefined();
    for (const id of obraNegra.obras!.items) expect(ITEMS.find((i) => i.id === id)).toMatchObject({ mecanica: "cierre", probabilidad: 0 });
    expect(ITEMS.find((i) => i.id === "tuberia")).toMatchObject({ mecanica: "tuberia", probabilidad: 0 });
  });

  it("none at the start: the first one comes after `primera` seconds, ahead of the leader, warning first", () => {
    const r = carrera();
    const o = obraNegra.obras!;
    for (let t = 0; t < o.primera * HZ - 2; t++) r.sala.paso();
    expect(r.cierres()).toHaveLength(0);
    const cierres = hastaElPrimero(r);
    expect(cierres.length).toBeGreaterThan(0);
    const item = ITEMS[cierres[0].item];
    expect(cierres).toHaveLength(item.tramos ?? 1);
    for (const e of cierres) {
      expect(e.etapa).toBe(0);
      expect(murosDeEntidad(pista, item, e)).toEqual([]);
    }
    // Ahead of the leader, about as far as configured
    const lider = Math.max(...[...r.sala.jugadores.values()].map((j) => proyectar(pista, j.carro.x, j.carro.y).s));
    const d = (((proyectar(pista, cierres[0].x, cierres[0].y).s - lider) % pista.longitud) + pista.longitud) % pista.longitud;
    expect(d).toBeGreaterThan(o.adelante[0] - 30);
    expect(d).toBeLessThan(o.adelante[1] + 40);
  });

  it("always leaves at least one lane free, and its pieces follow the road", () => {
    const { n, ancho } = carriles(pista);
    for (const semilla of [1, 2, 3, 4, 5, 6]) {
      const r = carrera(obraNegra, semilla);
      const cierres = hastaElPrimero(r);
      expect(cierres.length).toBeGreaterThan(0);
      for (const e of cierres) {
        const item = ITEMS[e.item];
        const s = proyectar(pista, e.x, e.y).s;
        const lateral = lateralEnPista(pista, e, s);
        const mitadTapada = ((item.carrilesCierre ?? 1) * ancho - 0.8) / 2;
        expect(item.carrilesCierre!).toBeLessThan(n);
        // What's left free on one side or the other fits a whole lane
        const libre = Math.max(pista.mitad - (lateral + mitadTapada), lateral - mitadTapada + pista.mitad);
        expect(libre).toBeGreaterThan(ancho - 0.5);
        // Lined up with the road where it sits
        const a = e.angulo - puntoEnPista(pista, s).angulo;
        expect(Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))).toBeLessThan(0.15);
      }
    }
  });

  it("closes after the warning: then it's solid on its 4 sides", () => {
    const r = carrera();
    const cierres = hastaElPrimero(r);
    const item = ITEMS[cierres[0].item];
    for (let t = 0; t < (item.aviso ?? 3) * HZ + 2; t++) r.sala.paso();
    for (const e of r.cierres()) {
      expect(e.etapa).toBe(1);
      expect(murosDeEntidad(pista, item, e)).toHaveLength(4);
    }
  });

  it("doesn't close on a car that's inside: it waits until it leaves", () => {
    const r = carrera();
    const [e] = hastaElPrimero(r);
    const item = ITEMS[e.item];
    const a = r.sala.jugadores.get("a")!;
    const b = r.sala.jugadores.get("b")!;
    // B waits behind it (both in the picture, so nobody gets eliminated)
    const atras = { x: e.x - Math.cos(e.angulo) * 20, y: e.y - Math.sin(e.angulo) * 20 };
    const quieto = () => {
      for (const j of r.sala.jugadores.values()) j.vivo = true;
      Object.assign(a.carro, { x: e.x, y: e.y, angulo: e.angulo, vx: 0, vy: 0, w: 0 });
      Object.assign(b.carro, { ...atras, angulo: e.angulo, vx: 0, vy: 0, w: 0 });
    };
    for (let t = 0; t < ((item.aviso ?? 3) + 1) * HZ; t++) {
      quieto();
      r.sala.paso();
    }
    expect(e.etapa).toBe(0);
    // It backs out (the first piece is the one further back): now it closes
    Object.assign(a.carro, { x: atras.x - Math.cos(e.angulo) * 6, y: atras.y - Math.sin(e.angulo) * 6 });
    for (const j of r.sala.jugadores.values()) j.vivo = true;
    r.sala.paso();
    expect(r.sala.fase).toBe("carrera");
    expect(e.etapa).toBe(1);
  });

  it("a car driving into a closed lane bounces off it (doesn't get in)", () => {
    const item = ITEMS.find((i) => i.id === "obra-carril")!;
    const s = 60;
    const p = puntoEnPista(pista, s);
    const e = { x: p.x, y: p.y, angulo: p.angulo, etapa: 1 };
    const muros = murosDeEntidad(pista, item, e);
    const c = { ...crearCarro(pista, 0), x: p.x - Math.cos(p.angulo) * 25, y: p.y - Math.sin(p.angulo) * 25, angulo: p.angulo, vx: Math.cos(p.angulo) * 30, vy: Math.sin(p.angulo) * 30 };
    let entro = false;
    for (let t = 0; t < 2 * HZ; t++) {
      avanzarCarro(c, { giro: 0, acel: 1, freno: 0, mano: false }, PARAMETROS_FISICA, pista, 1 / HZ);
      colisionMuros(c, muros, PARAMETROS_FISICA);
      entro ||= circulosCarro(c).some((q) => enCierre(pista, item, e, q.x, q.y, -0.5));
    }
    expect(entro).toBe(false);
  });

  it("there are never more than `maximo` at once, and a new round opens everything", () => {
    // With bots driving, the leader moves on and there's room for more ahead
    const r = carrera(obraNegra, 1, 2);
    const o = obraNegra.obras!;
    let mas = 0;
    for (let t = 0; t < 70 * HZ; t++) {
      for (const j of r.sala.jugadores.values()) j.vivo = true;
      r.sala.paso();
      const cierres = r.cierres();
      mas = Math.max(mas, cierres.filter((e) => !cierres.some((a) => a.id === e.id - 1 && a.item === e.item)).length);
    }
    expect(mas).toBeGreaterThan(1);
    expect(mas).toBeLessThanOrEqual(o.maximo);
    r.s.nuevaRonda(0, 0);
    expect(r.cierres()).toHaveLength(0);
  });

  it("the bots see it as a row of hazards along it", () => {
    const r = carrera();
    const cierres = hastaElPrimero(r);
    const riesgos = r.s.riesgos();
    for (const e of cierres) expect(riesgos.filter((q: { x: number; y: number }) => Math.hypot(q.x - e.x, q.y - e.y) < 6).length).toBeGreaterThan(0);
  });
});

describe("the roaming pipe across the road (tuberia: off camera, once a lap)", () => {
  // Grúas ya tiene su tubería fija (zona 1): la que cambia de lugar se prueba en una copia que sí la tiene
  const gruas: Circuito = { ...leer("gruas"), tuberia: { item: "tuberia", adelante: [550, 950] } };
  const pistaG = prepararPista(gruas);
  const TUBERIA = ITEMS.find((i) => i.id === "tuberia")!;
  const T = ITEMS.indexOf(TUBERIA);

  /** A race in Grúas with bots driving (the person in "yo" is out: the bots lead) */
  function carreraGruas(semilla: number) {
    const sala = new Sala("GRU-2222", gruas, HZ, 5, ITEMS, rng(semilla));
    sala.agregar("yo", { nombre: "Yo", color: "rojo" });
    for (let i = 0; i < 3; i++) expect(sala.agregarBot(1)).toBeNull();
    expect(sala.empezar("yo")).toBeNull();
    while (sala.fase === "cuenta") sala.paso();
    sala.jugadores.get("yo")!.vivo = false;
    const s = sala as any;
    return { sala, s, tuberia: (): Entidad | null => s.entidades.find((e: Entidad) => e.item === T) ?? null };
  }

  it("Grúas has the road works, and its fixed pipe instead of the roaming one", () => {
    expect(gruas.obras!.items).toEqual(expect.arrayContaining(["obra-carril", "obra-cuello", "obra-material"]));
    expect(leer("gruas").tuberia).toBeUndefined();
    expect(leer("gruas").piezas!.some((p) => p.tipo === "tuberia-gigante")).toBe(true);
    expect(obraNegra.tuberia).toBeUndefined();
    expect(TUBERIA).toMatchObject({ mecanica: "tuberia", probabilidad: 0, soloRonda: true });
  });

  it("there's one somewhere ahead (at most a few seconds without one while it finds a spot), already up, and it only appears and disappears off camera", () => {
    let cambios = 0;
    for (const semilla of [2, 7]) {
      const r = carreraGruas(semilla);
      // Busca dónde montarla cada medio segundo: en unos segundos ya está
      for (let t = 0; t < 8 * HZ && !r.tuberia(); t++) r.sala.paso();
      let antes = r.tuberia();
      expect(antes).not.toBeNull();
      expect(antes!.etapa).toBe(1);
      expect(r.s.tuberiaSeVe(TUBERIA, antes)).toBe(false);
      let sin = 0;
      for (let t = 0; t < 90 * HZ && r.sala.fase === "carrera"; t++) {
        // Se quitó la de antes (ya pasada): no se vio irse
        const previa = r.tuberia();
        r.sala.paso();
        const ahora = r.tuberia();
        if (previa && previa !== ahora) expect(r.s.tuberiaSeVe(TUBERIA, previa)).toBe(false);
        if (!ahora) {
          sin++;
          expect(sin).toBeLessThan(5 * HZ);
          continue;
        }
        sin = 0;
        // Only one at a time, with its two ramps for the physics
        expect(r.s.entidades.filter((e: Entidad) => e.item === T)).toHaveLength(1);
        expect(r.s.pista.rampasMovibles).toHaveLength(2);
        if (ahora !== antes) {
          cambios++;
          expect(r.s.tuberiaSeVe(TUBERIA, ahora)).toBe(false);
          expect(ahora.etapa).toBe(1);
          antes = ahora;
        }
      }
    }
    expect(cambios).toBeGreaterThan(0);
  });

  it("two ramps of 1.25 lanes at the sides (2.5 in all), the middle blocked", () => {
    const centro = puntoEnPista(pistaG, 60);
    const e = { x: centro.x, y: centro.y, angulo: centro.angulo, etapa: 1 };
    const rampas = rampasDeEntidad(pistaG, TUBERIA, e);
    expect(rampas).toHaveLength(2);
    const { ancho } = carriles(pistaG);
    expect(rampas[0].ancho + rampas[1].ancho).toBeCloseTo(2.5 * ancho, 0);
    expect(murosDeEntidad(pistaG, TUBERIA, e).length).toBeGreaterThan(0);
  });

  /** A pipe already up on a straight of Grúas, and a car `antes` m before it at `lateral`, at `v` m/s */
  function contraLaTuberia(lateral: number, v: number) {
    const pista = prepararPista(gruas);
    const s = 60;
    const centro = puntoEnPista(pista, s);
    const e = { x: centro.x, y: centro.y, angulo: centro.angulo, etapa: 1 };
    pista.rampasMovibles = rampasDeEntidad(pista, TUBERIA, e);
    const muros = murosDeEntidad(pista, TUBERIA, e);
    const salida = puntoEnPista(pista, s - 25, lateral);
    const c = { ...crearCarro(pista, 0), x: salida.x, y: salida.y, angulo: salida.angulo, vx: Math.cos(salida.angulo) * v, vy: Math.sin(salida.angulo) * v };
    let maxZ = 0;
    for (let t = 0; t < 2 * HZ; t++) {
      avanzarCarro(c, { giro: 0, acel: 1, freno: 0, mano: false }, PARAMETROS_FISICA, pista, 1 / HZ);
      if (c.z <= ALTURA_LIBRE) colisionMuros(c, muros, PARAMETROS_FISICA);
      maxZ = Math.max(maxZ, c.z);
    }
    const pasada = proyectar(pista, c.x, c.y).s - s;
    return { pista, c, maxZ, pasada };
  }

  it("a car on a ramp lane jumps over the pipe and keeps going", () => {
    const m = medidasTuberia(pistaG, TUBERIA);
    for (const lado of [-1, 1]) {
      const { maxZ, pasada } = contraLaTuberia(lado * (pistaG.mitad - m.anchoRampa / 2), 30);
      expect(maxZ).toBeGreaterThan(TUBERIA.altoRampa! - 0.1);
      expect(pasada).toBeGreaterThan(20);
    }
  });

  it("a car down the middle is stopped by the barriers", () => {
    const { pasada } = contraLaTuberia(0, 30);
    expect(pasada).toBeLessThan(0);
  });

  it("if the pipe goes away while a car is on its ramp, the car just drops to the ground", () => {
    const pista = prepararPista(gruas);
    const centro = puntoEnPista(pista, 60);
    pista.rampasMovibles = rampasDeEntidad(pista, TUBERIA, { x: centro.x, y: centro.y, angulo: centro.angulo, etapa: 1 });
    const r0 = pista.rampasMovibles[0];
    const c = { ...crearCarro(pista, 0), x: r0.x + Math.cos(r0.angulo) * 3, y: r0.y + Math.sin(r0.angulo) * 3, angulo: r0.angulo };
    avanzarCarro(c, { giro: 0, acel: 0, freno: 0, mano: false }, PARAMETROS_FISICA, pista, 1 / HZ);
    expect(c.rampa).toBeGreaterThanOrEqual(0);
    pista.rampasMovibles = [];
    c.x += 100;
    expect(() => avanzarCarro(c, { giro: 0, acel: 0, freno: 0, mano: false }, PARAMETROS_FISICA, pista, 1 / HZ)).not.toThrow();
    expect(c.rampa).toBe(-1);
    expect(c.z).toBe(0);
  });

  it("a new round takes it down, ramps included (the next race puts up a new one)", () => {
    const r = carreraGruas(2);
    for (let t = 0; t < 8 * HZ && !r.tuberia(); t++) r.sala.paso();
    expect(r.tuberia()).not.toBeNull();
    r.s.nuevaRonda(0, 0);
    expect(r.tuberia()).toBeNull();
    expect(r.s.pista.rampasMovibles).toHaveLength(0);
  });
});
