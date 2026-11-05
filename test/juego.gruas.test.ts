import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { prepararPista, proyectar, puntoEnPista } from "../src/juego/compartido/pista";
import { PARAMETROS_FISICA, ALTURA_LIBRE, avanzarCarro, crearCarro, rapidez } from "../src/juego/compartido/fisica";
import { esEstructuraObra } from "../src/juego/compartido/obra";
import { lateralEnPista } from "../src/juego/servidor/bots";
import { Sala } from "../src/juego/servidor/salas";
import type { Entidad } from "../src/juego/servidor/items";

const DIR = path.join(__dirname, "..", "content", "juego");
const circuito: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "gruas.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
const pista = prepararPista(circuito);

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

/**
 * A car at `s`, `lateral`, at `v` m/s, driven for `segundos` holding its lateral (steering at a
 * point 12 m ahead on its line). Collides with the scenery like in a race. Returns its track
 */
function manejar(s: number, lateral: number, v: number, segundos: number) {
  const p = puntoEnPista(pista, s, lateral);
  const c = { ...crearCarro(pista, 0), x: p.x, y: p.y, angulo: p.angulo, vx: Math.cos(p.angulo) * v, vy: Math.sin(p.angulo) * v, indice: proyectar(pista, p.x, p.y).indice };
  const pasos: { s: number; z: number; lat: number }[] = [];
  for (let t = 0; t < segundos * HZ; t++) {
    const pr = proyectar(pista, c.x, c.y, c.indice);
    const meta = puntoEnPista(pista, pr.s + 12, lateral);
    let d = Math.atan2(meta.y - c.y, meta.x - c.x) - c.angulo;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    avanzarCarro(c, { giro: Math.max(-1, Math.min(1, d * 3)), acel: 1, freno: 0, mano: false }, PARAMETROS_FISICA, pista, 1 / HZ);
    pasos.push({ s: proyectar(pista, c.x, c.y, c.indice).s, z: c.z, lat: lateralEnPista(pista, c, pr.s) });
  }
  return { c, pasos };
}

describe("Grúas by zones (hand-made scenery)", () => {
  it("no random buildings, every zone has its pieces, and the fixed pipe replaces the roaming one", () => {
    expect(circuito.muros.filter(esEstructuraObra)).toHaveLength(0);
    expect(circuito.tuberia).toBeUndefined();
    for (const tipo of ["tuberia-gigante", "bloque", "zona-brazo", "perforadora", "puente-acero", "muro-contencion", "tubo-grande", "grua-movil", "arco-tunel", "portal", "muro-tunel"]) {
      expect(circuito.piezas!.some((p) => p.tipo === tipo)).toBe(true);
    }
    expect(circuito.ambiente!.some((a) => a.item === "brazo")).toBe(true);
    expect(circuito.elevacion!.some((l) => l.altura < 0)).toBe(true);
  });

  it("the central excavation never sinks the road (it's all inside, away from it)", () => {
    for (const l of circuito.elevacion!) {
      for (let s = 0; s < pista.longitud; s += 5) {
        for (const lat of [-pista.mitad - 3, 0, pista.mitad + 3]) {
          const p = puntoEnPista(pista, s, lat);
          expect(Math.hypot(p.x - l.x, p.y - l.y)).toBeGreaterThan(l.radio);
        }
      }
    }
  });

  describe("zone 1: the giant pipe", () => {
    const rampas = circuito.rampas!.filter((r) => r.estilo === "tuberia");
    const sPie = proyectar(pista, rampas[0].x, rampas[0].y).s;
    const latDe = (r: (typeof rampas)[number]) => lateralEnPista(pista, r, proyectar(pista, r.x, r.y).s);

    it("has two ramps of different widths; the narrow one has a prize box in the air", () => {
      expect(rampas).toHaveLength(2);
      const [ancha, angosta] = [...rampas].sort((a, b) => b.ancho - a.ancho);
      expect(ancha.ancho).toBeGreaterThan(angosta.ancho + 2);
      expect(angosta.caja).toBeDefined();
      expect(ancha.caja).toBeUndefined();
    });

    it("fast up either ramp, the car flies over the pipe and keeps going", () => {
      for (const r of rampas) {
        const { pasos } = manejar(sPie - 25, latDe(r), PARAMETROS_FISICA.velocidadMax, 3);
        const encima = pasos.filter((p) => p.s > sPie + 9 && p.s < sPie + 12.5);
        expect(encima.length).toBeGreaterThan(0);
        for (const p of encima) expect(p.z).toBeGreaterThan(3.2);
        expect(pasos[pasos.length - 1].s).toBeGreaterThan(sPie + 40);
      }
    });

    it("down a closed lane, the car is stopped before the pipe", () => {
      const { pasos } = manejar(sPie - 25, 0, 30, 3);
      expect(Math.max(...pasos.map((p) => p.s))).toBeLessThan(sPie);
    });
  });

  describe("zone 3: the steel bridge over the excavation", () => {
    const tramos = circuito.rampas!.filter((r) => r.estilo === "acero");
    const s0 = proyectar(pista, tramos[0].x, tramos[0].y).s;
    const ultimo = tramos[tramos.length - 1];
    const s1 = proyectar(pista, ultimo.x + Math.cos(ultimo.angulo) * ultimo.largo, ultimo.y + Math.sin(ultimo.angulo) * ultimo.largo).s;
    // La altura del piso (el trampolín del final sube un poco más)
    const ALTO = 5;

    it("is high (5 m), drawn as one continuous strip, and ends in a kicker (no way down at the end)", () => {
      expect(Math.max(...tramos.map((r) => r.alto))).toBeGreaterThan(ALTO);
      const ultimoTramo = tramos[tramos.length - 1];
      expect(ultimoTramo.alto).toBeGreaterThan(ultimoTramo.desde ?? 0);
      expect(circuito.piezas!.filter((p) => p.tipo === "puente-acero").length).toBeGreaterThanOrEqual(1);
    });

    it("the inside lanes go up onto it, ride it the whole way at its height (it's solid everywhere they go), and fly off the end", () => {
      for (const lat of [5.5, 8, 11]) {
        const { pasos, c } = manejar(s0 - 15, lat, 22, 7);
        const arriba = pasos.filter((p) => p.s > s0 + 20 && p.s < s1 - 8);
        expect(arriba.length).toBeGreaterThan(20);
        for (const p of arriba) expect(p.z).toBeCloseTo(ALTO, 1);
        // Off the kicker: higher than the deck for a moment, then down on the road further on
        expect(Math.max(...pasos.filter((p) => p.s > s1 - 1).map((p) => p.z))).toBeGreaterThan(ALTO);
        expect(pasos[pasos.length - 1].s).toBeGreaterThan(s1 + 15);
        expect(pasos[pasos.length - 1].z).toBe(0);
        expect(rapidez(c)).toBeGreaterThan(15);
      }
    });

    it("the outside lanes stay on the ground and pass beside it", () => {
      const { pasos } = manejar(s0 - 15, -10, 22, 7);
      for (const p of pasos) expect(p.z).toBe(0);
      expect(pasos[pasos.length - 1].s).toBeGreaterThan(s1 + 10);
    });

    it("no railings: from the ground route you drive underneath it, never lifted onto it", () => {
      expect(circuito.piezas!.some((p) => p.tipo === "barandal")).toBe(false);
      const { pasos } = manejar(s0 + 30, 7, 15, 3);
      for (const p of pasos) expect(p.z).toBe(0);
    });

    it("up on it, steering off the edge you fall to the road (and only land on the ground)", () => {
      const p = puntoEnPista(pista, s0 + 40, 8);
      const c = { ...crearCarro(pista, 0), x: p.x, y: p.y, angulo: p.angulo, vx: Math.cos(p.angulo) * 15, vy: Math.sin(p.angulo) * 15, z: ALTO, indice: proyectar(pista, p.x, p.y).indice };
      let cayo = false;
      for (let t = 0; t < 3 * HZ; t++) {
        const pr = proyectar(pista, c.x, c.y, c.indice);
        const meta = puntoEnPista(pista, pr.s + 8, -8);
        let d = Math.atan2(meta.y - c.y, meta.x - c.x) - c.angulo;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        avanzarCarro(c, { giro: Math.max(-1, Math.min(1, d * 3)), acel: 0.5, freno: 0, mano: false }, PARAMETROS_FISICA, pista, 1 / HZ);
        if (c.z === 0 && lateralEnPista(pista, c, pr.s) < 0) cayo = true;
      }
      expect(cayo).toBe(true);
      expect(c.z).toBe(0);
    });

    it("there's no way down halfway (only the kicker at the end)", () => {
      expect(circuito.rampas!.some((r) => r.estilo === "acero-salida")).toBe(false);
    });
  });

  describe("zone 2: the excavator's arm", () => {
    function carrera() {
      const sala = new Sala("GRU-7777", circuito, HZ, 5, ITEMS, rng(7));
      sala.agregar("a", { nombre: "A", color: "rojo" });
      sala.agregar("b", { nombre: "B", color: "azul" });
      expect(sala.empezar("a")).toBeNull();
      while (sala.fase === "cuenta") sala.paso();
      const brazo = () => (sala as any).entidades.find((e: Entidad) => ITEMS[e.item].mecanica === "brazo") as Entidad;
      return { sala, brazo };
    }
    const BRAZO = ITEMS.find((i) => i.mecanica === "brazo")!;
    const cucharon = (e: Entidad) => ({ x: e.x + Math.cos(e.angulo) * BRAZO.alcance!, y: e.y + Math.sin(e.angulo) * BRAZO.alcance! });

    it("stands off the road and every so often reaches into the marked zone on the road", () => {
      const { sala, brazo } = carrera();
      const zona = circuito.piezas!.find((p) => p.tipo === "zona-brazo")!;
      let adentro = 0;
      let afuera = 0;
      for (let t = 0; t < 12 * HZ; t++) {
        for (const j of sala.jugadores.values()) j.vivo = true;
        sala.paso();
        const e = brazo();
        expect(proyectar(pista, e.x, e.y).distancia).toBeGreaterThan(pista.mitad + 3);
        if (e.etapa === 1) {
          adentro++;
          const b = cucharon(e);
          expect(proyectar(pista, b.x, b.y).distancia).toBeLessThan(pista.mitad);
          expect(Math.hypot(b.x - zona.x, b.y - zona.y)).toBeLessThan(4);
        } else afuera++;
      }
      expect(adentro).toBeGreaterThan(HZ);
      expect(afuera).toBeGreaterThan(HZ);
    });

    it("hits whoever is under the bucket: slowed down and stunned", () => {
      const { sala, brazo } = carrera();
      sala.paso();
      for (let t = 0; t < 12 * HZ && brazo().etapa !== 1; t++) {
        for (const j of sala.jugadores.values()) j.vivo = true;
        sala.paso();
      }
      const a = sala.jugadores.get("a")!;
      const b = cucharon(brazo());
      Object.assign(a.carro, { x: b.x, y: b.y, vx: 20, vy: 0 });
      sala.paso();
      expect(a.carro.aturdido).toBeGreaterThan(0);
      expect(rapidez(a.carro)).toBeLessThan(20);
    });
  });

  it("zone 5: the tunnel keeps the road clear (only its walls at the edges, outside the road)", () => {
    const tunel = circuito.piezas!.filter((p) => ["arco-tunel", "portal", "muro-tunel"].includes(p.tipo));
    expect(tunel.length).toBeGreaterThan(20);
    for (const o of pista.escenario.objetos.filter((o) => ["arco-tunel", "portal", "muro-tunel"].includes(o.tipo))) {
      const mete = Math.min(o.ancho ?? 0, o.fondo ?? 0) / 2;
      expect(proyectar(pista, o.x, o.y).distancia - mete).toBeGreaterThan(pista.mitad);
    }
  });

  describe("landing on top of another car blows it up", () => {
    function dos() {
      const sala = new Sala("GRU-9999", circuito, HZ, 5, ITEMS, rng(9));
      sala.agregar("a", { nombre: "A", color: "rojo" });
      sala.agregar("b", { nombre: "B", color: "azul" });
      sala.agregar("c", { nombre: "C", color: "verde" });
      expect(sala.empezar("a")).toBeNull();
      while (sala.fase === "cuenta") sala.paso();
      return sala;
    }
    /** A on the ground, B falling right on top of it from `z` m */
    function caer(sala: Sala, z: number, vz = -6) {
      const a = sala.jugadores.get("a")!;
      const b = sala.jugadores.get("b")!;
      const p = puntoEnPista(pista, 40, -5);
      Object.assign(a.carro, { x: p.x, y: p.y, angulo: p.angulo, vx: 0, vy: 0, z: 0, vz: 0, rampa: -1 });
      Object.assign(b.carro, { x: p.x, y: p.y, angulo: p.angulo, vx: 0, vy: 0, z, vz, rampa: -1 });
      sala.paso();
      return { a, b };
    }

    it("the one underneath explodes (the one falling keeps going)", () => {
      const sala = dos();
      const { a, b } = caer(sala, 1.4);
      expect(a.vivo).toBe(false);
      expect(b.vivo).toBe(true);
    });

    it("with the helmet (or the shield) the one underneath holds", () => {
      const sala = dos();
      sala.jugadores.get("a")!.carro.pesado = 100;
      const { a } = caer(sala, 1.4);
      expect(a.vivo).toBe(true);
    });

    it("cars side by side on the ground, or going up, don't crush each other", () => {
      const sala = dos();
      const { a } = caer(sala, 0.2, -1);
      expect(a.vivo).toBe(true);
      const otra = dos();
      const r = caer(otra, 1.2, 4);
      expect(r.a.vivo).toBe(true);
    });
  });

  it("the bots line up with the pipe's ramps and jump it instead of crashing into it", () => {
    const rampas = circuito.rampas!.map((r, i) => (r.estilo === "tuberia" ? i : -1)).filter((i) => i >= 0);
    const sPie = proyectar(pista, circuito.rampas![rampas[0]].x, circuito.rampas![rampas[0]].y).s;
    let llegan = 0;
    let saltan = 0;
    for (const semilla of [1, 2, 5, 8]) {
      const sala = new Sala("GRU-8888", circuito, HZ, 5, ITEMS, rng(semilla));
      sala.agregar("yo", { nombre: "Yo", color: "rojo" });
      for (let i = 0; i < 3; i++) expect(sala.agregarBot(1)).toBeNull();
      expect(sala.empezar("yo")).toBeNull();
      while (sala.fase === "cuenta") sala.paso();
      const vistos = new Set<string>();
      const saltaron = new Set<string>();
      for (let t = 0; t < 40 * HZ && sala.fase === "carrera"; t++) {
        sala.jugadores.get("yo")!.vivo = false;
        sala.paso();
        for (const j of sala.jugadores.values()) {
          if (!j.vivo || j.id === "yo") continue;
          const s = proyectar(pista, j.carro.x, j.carro.y).s;
          if (Math.abs(s - (sPie - 3)) < 3) vistos.add(j.id);
          if (rampas.includes(j.carro.rampa)) saltaron.add(j.id);
        }
      }
      llegan += vistos.size;
      saltan += [...vistos].filter((id) => saltaron.has(id)).length;
    }
    expect(llegan).toBeGreaterThan(3);
    expect(saltan / llegan).toBeGreaterThan(0.8);
  });
});
