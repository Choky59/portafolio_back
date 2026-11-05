import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { carriles, prepararPista, proyectar, puntoEnPista, sueloEn } from "../src/juego/compartido/pista";
import { PARAMETROS_FISICA, avanzarCarro, circulosCarro, crearCarro, rapidez } from "../src/juego/compartido/fisica";
import { esEstructuraObra, planoObra } from "../src/juego/compartido/obra";
import { desempacarCarro, empacarCarro } from "../src/juego/compartido/protocolo";
import { lateralEnPista } from "../src/juego/servidor/bots";
import { Sala } from "../src/juego/servidor/salas";
import type { Entidad } from "../src/juego/servidor/items";

const DIR = path.join(__dirname, "..", "content", "juego");
const circuito: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "obra-negra.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
const pista = prepararPista(circuito);
const ACELERAR = { giro: 0, acel: 1, freno: 0, mano: false };

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

/** A car on the road at `s`, `lateral`, going along it at `v` m/s */
function carroEn(s: number, lateral: number, v: number) {
  const p = puntoEnPista(pista, s, lateral);
  return { ...crearCarro(pista, 0), x: p.x, y: p.y, angulo: p.angulo, vx: Math.cos(p.angulo) * v, vy: Math.sin(p.angulo) * v, indice: proyectar(pista, p.x, p.y).indice };
}

describe("Obra Negra by zones (hand-made scenery)", () => {
  it("no random buildings: no structure walls and the yards are the hand-placed ones", () => {
    expect(circuito.muros.filter(esEstructuraObra)).toHaveLength(0);
    expect(circuito.piezas!.length).toBeGreaterThan(20);
    expect(planoObra(pista).patios).toHaveLength(circuito.patiosFijos!.length);
    for (const tipo of ["torre", "puente-via", "jersey", "rascacielos", "dosel", "columna", "estacionamiento", "puente-roto", "demolicion", "martillo"]) {
      expect(circuito.piezas!.some((p) => p.tipo === tipo)).toBe(true);
    }
  });

  it("nothing solid gets into the road but the columns under the skyscraper", () => {
    for (const o of pista.escenario.objetos) {
      if (o.masa) continue;
      const mete = o.ancho !== undefined ? Math.min(o.ancho, o.fondo ?? o.ancho) / 2 : o.radio;
      if (proyectar(pista, o.x, o.y).distancia - mete < pista.mitad) expect(o.tipo).toBe("columna");
    }
  });

  it("the columns split the road: a narrow inside lane and the wide outside, both fit a car with room", () => {
    const columnas = circuito.piezas!.filter((p) => p.tipo === "columna" && proyectar(pista, p.x, p.y).distancia < pista.mitad);
    expect(columnas.length).toBeGreaterThanOrEqual(3);
    for (const c of columnas) {
      const s = proyectar(pista, c.x, c.y).s;
      const lat = lateralEnPista(pista, c, s);
      const media = (c.ancho ?? 1.2) / 2;
      expect(pista.mitad - (Math.abs(lat) + media)).toBeGreaterThan(5);
      expect(Math.abs(lat) - media + pista.mitad).toBeGreaterThan(10);
    }
  });

  it("the bots see the columns as hazards, but not the Jersey barriers at the edge", () => {
    const sala = new Sala("ZON-1111", circuito, HZ, 5, ITEMS, rng(1));
    const fijos = (sala as any).riesgosFijos() as { x: number; y: number; lateral: number }[];
    const columnas = circuito.piezas!.filter((p) => p.tipo === "columna" && proyectar(pista, p.x, p.y).distancia < pista.mitad);
    for (const c of columnas) expect(fijos.some((f) => Math.hypot(f.x - c.x, f.y - c.y) < 0.5)).toBe(true);
    // The row is seen whole: points in between and before the first one, all on the columns' line
    expect(fijos.length).toBeGreaterThan(columnas.length * 2);
    for (const f of fijos) expect(Math.abs(f.lateral - 3.5)).toBeLessThan(1);
  });

  it("racing, the bots go around the columns instead of crashing into them", () => {
    const columnas = circuito.piezas!.filter((p) => p.tipo === "columna" && proyectar(pista, p.x, p.y).distancia < pista.mitad);
    const [desde, hasta] = [Math.min(...columnas.map((c) => proyectar(pista, c.x, c.y).s)) - 4, Math.max(...columnas.map((c) => proyectar(pista, c.x, c.y).s)) + 4];
    let pasadas = 0;
    let golpes = 0;
    for (const semilla of [1, 2, 3, 4, 5, 6]) {
      const sala = new Sala("ZON-6666", circuito, HZ, 5, ITEMS, rng(semilla));
      sala.agregar("yo", { nombre: "Yo", color: "rojo" });
      for (let i = 0; i < 3; i++) expect(sala.agregarBot(1)).toBeNull();
      expect(sala.empezar("yo")).toBeNull();
      while (sala.fase === "cuenta") sala.paso();
      const enZona = new Set<string>();
      const ultimo = new Map<string, number>();
      for (let t = 0; t < 90 * HZ && sala.fase === "carrera"; t++) {
        sala.jugadores.get("yo")!.vivo = false;
        sala.paso();
        for (const j of sala.jugadores.values()) {
          if (!j.vivo) continue;
          const s = proyectar(pista, j.carro.x, j.carro.y).s;
          const dentro = s > desde && s < hasta;
          if (dentro && !enZona.has(j.id)) pasadas++;
          if (dentro) enZona.add(j.id);
          else enZona.delete(j.id);
          for (const c of columnas) {
            const toca = circulosCarro(j.carro).some((q) => Math.hypot(q.x - c.x, q.y - c.y) < PARAMETROS_FISICA.radio + 0.75);
            const clave = `${j.id}:${c.x}`;
            if (toca && (ultimo.get(clave) ?? -1e9) < t - HZ) golpes++;
            if (toca) ultimo.set(clave, t);
          }
        }
      }
    }
    expect(pasadas).toBeGreaterThan(10);
    expect(golpes / pasadas).toBeLessThan(0.1);
  });

  describe("the incomplete bridge jump (zone 4)", () => {
    const rampa = circuito.rampas!.find((r) => r.estilo === "puente")!;
    const sPie = proyectar(pista, rampa.x, rampa.y).s;

    it("is a ramp across the whole road, on the start straight", () => {
      expect(rampa.ancho).toBeGreaterThan(2 * pista.mitad);
      expect(sPie).toBeGreaterThan(36);
      expect(sPie).toBeLessThan(100);
    });

    it("fast, every lane flies over the gap and lands further on", () => {
      const { n, ancho } = carriles(pista);
      for (let k = 0; k < n; k++) {
        const c = carroEn(sPie - 20, -pista.mitad + ancho * (k + 0.5), PARAMETROS_FISICA.velocidadMax);
        let maxZ = 0;
        let aterrizo = -1;
        for (let t = 0; t < 3 * HZ; t++) {
          avanzarCarro(c, ACELERAR, PARAMETROS_FISICA, pista, 1 / HZ);
          maxZ = Math.max(maxZ, c.z);
          if (maxZ > 1 && c.z === 0 && aterrizo < 0) aterrizo = proyectar(pista, c.x, c.y).s;
        }
        expect(maxZ).toBeGreaterThan(rampa.alto);
        // The gap is 10 m past the lip: lands beyond it
        expect(aterrizo - (sPie + rampa.largo)).toBeGreaterThan(10);
      }
    });

    it("a round never starts on top of it (nor in its gap): the grid moves back before its foot", () => {
      const fin = Math.max(...circuito.rampas!.filter((r) => r.estilo).map((r) => proyectar(pista, r.x, r.y).s));
      for (const donde of [sPie - 5, sPie + 4, sPie + 15, fin + 5, fin + 20]) {
        const sala = new Sala("ZON-5555", circuito, HZ, 5, ITEMS, rng(5));
        ["a", "b", "c", "d"].forEach((id) => sala.agregar(id, { nombre: id, color: "rojo" }));
        (sala as any).nuevaRonda(donde, 1);
        for (const j of sala.jugadores.values()) {
          const s = proyectar(pista, j.carro.x, j.carro.y).s;
          const dentro = s > sPie - 3 && s < fin + 8;
          expect(dentro).toBe(false);
          expect(j.carro.z).toBe(0);
        }
      }
    });

    it("slow, it just drops off and keeps going (no explosion, no wall)", () => {
      const c = carroEn(sPie - 10, 0, 8);
      for (let t = 0; t < 4 * HZ; t++) avanzarCarro(c, ACELERAR, PARAMETROS_FISICA, pista, 1 / HZ);
      expect(proyectar(pista, c.x, c.y).s).toBeGreaterThan(sPie + 30);
      expect(c.z).toBe(0);
    });
  });

  describe("the banked curve of the parking garage (zone 3)", () => {
    it("is its own surface across the road, with more grip than asphalt", () => {
      for (let s = 640; s <= 760; s += 20) {
        for (const lat of [-9, 0, 9]) {
          const p = puntoEnPista(pista, s, lat);
          expect(sueloEn(pista, p.x, p.y)).toBe("peralte");
        }
      }
      const fuera = puntoEnPista(pista, 100);
      expect(sueloEn(pista, fuera.x, fuera.y)).toBe("asfalto");
      expect(PARAMETROS_FISICA.superficies.peralte.agarre).toBeGreaterThan(PARAMETROS_FISICA.superficies.asfalto.agarre);
    });

    it("keeps more speed through the curve than if it were plain asphalt", () => {
      const plano: Circuito = { ...circuito, superficies: [] };
      const pistaPlana = prepararPista(plano);
      const vuelta = (p: typeof pista) => {
        const c = carroEn(630, 0, PARAMETROS_FISICA.velocidadMax);
        Object.assign(c, { indice: proyectar(p, c.x, c.y).indice });
        // Steering to follow the road: aim a bit ahead
        for (let t = 0; t < 4 * HZ; t++) {
          const pr = proyectar(p, c.x, c.y, c.indice);
          const meta = puntoEnPista(p, pr.s + 14);
          let d = Math.atan2(meta.y - c.y, meta.x - c.x) - c.angulo;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          avanzarCarro(c, { giro: Math.max(-1, Math.min(1, d * 3)), acel: 1, freno: 0, mano: false }, PARAMETROS_FISICA, p, 1 / HZ);
        }
        return { s: proyectar(p, c.x, c.y).s, derrape: c.derrape };
      };
      const conPeralte = vuelta(pista);
      const sinPeralte = vuelta(pistaPlana);
      expect(conPeralte.s).toBeGreaterThanOrEqual(sinPeralte.s - 0.5);
    });

    it("travels in the snapshot", () => {
      const c = { ...crearCarro(pista, 0), suelo: "peralte" as const };
      expect(desempacarCarro(empacarCarro("a", c, 1, true, -1)).estado.suelo).toBe("peralte");
    });
  });

  describe("the demolition debris (zone 5)", () => {
    it("falls on the road, always at the same spots, during the race", () => {
      const sala = new Sala("ZON-2222", circuito, HZ, 5, ITEMS, rng(2));
      sala.agregar("a", { nombre: "A", color: "rojo" });
      sala.agregar("b", { nombre: "B", color: "azul" });
      expect(sala.empezar("a")).toBeNull();
      while (sala.fase === "cuenta") sala.paso();
      const vistos = new Map<number, Entidad>();
      for (let t = 0; t < 20 * HZ; t++) {
        for (const j of sala.jugadores.values()) j.vivo = true;
        sala.paso();
        for (const e of (sala as any).entidades as Entidad[]) if (ITEMS[e.item].mecanica === "escombro") vistos.set(e.id, e);
      }
      expect(vistos.size).toBeGreaterThanOrEqual(circuito.escombros!.length * 2);
      for (const e of vistos.values()) {
        const cerca = circuito.escombros!.some((l) => {
          const p = puntoEnPista(pista, l.s, l.lateral);
          return Math.hypot(p.x - e.x, p.y - e.y) < 0.5;
        });
        expect(cerca).toBe(true);
        expect(proyectar(pista, e.x, e.y).distancia).toBeLessThan(pista.mitad);
      }
    });

    /** A race with a debris piece just dropped at the first spot; `pasar(t)` drives car A over it after t s */
    function conEscombro() {
      const sala = new Sala("ZON-3333", circuito, HZ, 5, ITEMS, rng(3));
      sala.agregar("a", { nombre: "A", color: "rojo" });
      sala.agregar("b", { nombre: "B", color: "azul" });
      expect(sala.empezar("a")).toBeNull();
      while (sala.fase === "cuenta") sala.paso();
      const l = circuito.escombros![0];
      const ESCOMBRO = ITEMS.findIndex((i) => i.mecanica === "escombro");
      const p = puntoEnPista(pista, l.s, l.lateral);
      (sala as any).soltar({ item: ESCOMBRO, dueno: "", x: p.x, y: p.y, angulo: 0, vx: 0, vy: 0, vida: 10 * HZ, objetivo: null });
      const a = sala.jugadores.get("a")!;
      return (segundos: number, antes = 30) => {
        for (let t = 0; t < Math.round(segundos * HZ); t++) sala.paso();
        Object.assign(a.carro, carroEn(l.s - 0.5, l.lateral, antes));
        sala.paso();
        return rapidez(a.carro) / antes;
      };
    }

    it("is marked on the ground first: while it's only the warning (and falling), it doesn't touch anyone", () => {
      const ESCOMBRO = ITEMS.find((i) => i.mecanica === "escombro")!;
      expect(ESCOMBRO.aviso).toBeGreaterThanOrEqual(1);
      expect(conEscombro()(ESCOMBRO.aviso! * 0.5)).toBeGreaterThan(0.95);
    });

    it("once on the ground, it slows down whoever runs over it", () => {
      const ESCOMBRO = ITEMS.find((i) => i.mecanica === "escombro")!;
      expect(conEscombro()((ESCOMBRO.aviso ?? 0) + (ESCOMBRO.duracion ?? 0.8) + 0.2)).toBeLessThan(0.85);
    });
  });

  it("road-work closures never land on the jump, the columns or the debris spots", () => {
    const sala = new Sala("ZON-4444", circuito, HZ, 5, ITEMS, rng(4));
    sala.agregar("yo", { nombre: "Yo", color: "rojo" });
    for (let i = 0; i < 3; i++) expect(sala.agregarBot(1)).toBeNull();
    expect(sala.empezar("yo")).toBeNull();
    while (sala.fase === "cuenta") sala.paso();
    sala.jugadores.get("yo")!.vivo = false;
    const L = pista.longitud;
    const lejos = (a: number, b: number) => Math.min(((a - b) % L + L) % L, ((b - a) % L + L) % L);
    const rampa = circuito.rampas!.find((r) => r.estilo === "puente")!;
    const prohibidos = [
      proyectar(pista, rampa.x, rampa.y).s + rampa.largo,
      ...circuito.piezas!.filter((p) => p.tipo === "columna" && proyectar(pista, p.x, p.y).distancia < pista.mitad).map((p) => proyectar(pista, p.x, p.y).s),
      ...circuito.escombros!.map((l) => l.s),
    ];
    let vistos = 0;
    for (let t = 0; t < 80 * HZ && sala.fase === "carrera"; t++) {
      sala.paso();
      for (const e of (sala as any).entidades as Entidad[]) {
        if (ITEMS[e.item].mecanica !== "cierre") continue;
        vistos++;
        const s = proyectar(pista, e.x, e.y).s;
        for (const u of prohibidos) expect(lejos(s, u)).toBeGreaterThan(8);
      }
    }
    expect(vistos).toBeGreaterThan(0);
  });
});
