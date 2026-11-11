import { nombreDeBot, tiemposDeBots, vehiculoDeBot } from "../src/juego/servidor/montaje";
import { NAMETAGS } from "../src/juego/compartido/nametags";
import { nombreOfensivo } from "../src/juego/compartido/nombres";
import { LARGO_NOMBRE, sanearJugador } from "../src/juego/compartido/protocolo";
import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { enAgua, enBarranco } from "../src/juego/compartido/pista";
import { Sala } from "../src/juego/servidor/salas";
import { AGRESIVIDAD, AGRESIVIDAD_MAX, DIFICIL_VELOCIDAD_MAX, MOLDES, crearMente, esquivar, fisicaDe, lateralEnPista, pensar, rotarPersonalidades, sortearPersonalidad, type Riesgo } from "../src/juego/servidor/bots";
import { PARAMETROS_FISICA, avanzarCarro, crearCarro } from "../src/juego/compartido/fisica";
import { prepararPista, puntoEnPista } from "../src/juego/compartido/pista";
import { rng } from "./juego.utiles";

const DIR = path.join(__dirname, "..", "content", "juego");
const leerCircuito = (id: string): Circuito => JSON.parse(readFileSync(path.join(DIR, "circuitos", `${id}.json`), "utf8"));
const hermosillo = leerCircuito("hermosillo");
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;

function salaConBots(bots = 2, semilla = 7, circuito = hermosillo) {
  const sala = new Sala("HMO-3333", circuito, HZ, 5, ITEMS, rng(semilla));
  sala.agregar("yo", { nombre: "Jorge", color: "rojo" });
  for (let i = 0; i < bots; i++) expect(sala.agregarBot()).toBeNull();
  return sala;
}

describe("bots", () => {
  describe("dodging hazards", () => {
    const pista = prepararPista(hermosillo);
    const riesgoEn = (s: number, lateral: number, radio: number): Riesgo => {
      const p = puntoEnPista(pista, s, lateral);
      return { x: p.x, y: p.y, radio, s, lateral: lateralEnPista(pista, p, s) };
    };
    /** Drives a bot from s = 60 in its lane for 4 s; the closest its center gets to `riesgo` (m) */
    const loMasCerca = (riesgo: Riesgo, ver: boolean) => {
      const mente = { ...crearMente(rng(1)), carril: 0 };
      const carro = crearCarro(pista, 60, 0);
      let menor = Infinity;
      for (let t = 0; t < 4 * HZ; t++) {
        const ctrl = pensar(mente, carro, pista, t, HZ, false, rng(1), true, [], 0, ver ? [riesgo] : []);
        avanzarCarro(carro, ctrl, PARAMETROS_FISICA, pista, 1 / HZ);
        menor = Math.min(menor, Math.hypot(carro.x - riesgo.x, carro.y - riesgo.y));
      }
      return menor;
    };

    it("drives around a pothole in its lane instead of over it", () => {
      const bache = riesgoEn(100, 0, 2);
      expect(loMasCerca(bache, false)).toBeLessThan(bache.radio);
      expect(loMasCerca(bache, true)).toBeGreaterThan(bache.radio + 1);
    });

    it("picks the free side when two hazards sit next to each other", () => {
      const a = riesgoEn(100, 0, 2);
      const b = riesgoEn(102, 4.5, 2);
      const { lateral } = esquivar(pista, 60, 50, 0, [a, b]);
      // Not over A, and not into B on the right: it goes left
      expect(lateral).toBeLessThan(-(a.radio + 1));
    });

    it("ignores what is behind it or far ahead", () => {
      expect(esquivar(pista, 60, 30, 0, [riesgoEn(50, 0, 2), riesgoEn(200, 0, 2)]).lateral).toBe(0);
    });
  });

  describe("aggression against people", () => {
    const pista = prepararPista(hermosillo);
    const conAgresividad = (detras: number, delante: number, fn: () => void) => {
      const antes = { ...AGRESIVIDAD };
      Object.assign(AGRESIVIDAD, { detras, delante });
      try {
        fn();
      } finally {
        Object.assign(AGRESIVIDAD, antes);
      }
    };
    /** A fresh bot in lane +3 at s = 100 decides its controls, with `personas` on the track */
    const decidir = (personas: ReturnType<typeof crearCarro>[]) =>
      pensar({ ...crearMente(rng(1)), carril: 3 }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, personas);

    it("defaults to 20% both ways", () => {
      expect(AGRESIVIDAD).toEqual({ detras: 0.2, delante: 0.2 });
    });

    it("from behind, it steers toward the person ahead", () => {
      conAgresividad(1, 0, () => {
        expect(decidir([crearCarro(pista, 115, -4)]).giro).not.toBeCloseTo(decidir([]).giro, 2);
      });
    });

    it("in front, it cuts across toward the person close behind, without braking", () => {
      conAgresividad(0, 1, () => {
        const ctrl = decidir([crearCarro(pista, 94, -4)]);
        expect(ctrl.giro).not.toBeCloseTo(decidir([]).giro, 2);
        expect(ctrl.freno).toBe(0);
      });
    });

    const molde = (nombre: string) => MOLDES.find((m) => m.nombre === nombre)!;

    it("campaign bots get a personality; the usual ones don't", () => {
      const sala = new Sala("HMO-3334", hermosillo, HZ, 5, ITEMS, rng(3));
      sala.agregar("yo", { nombre: "Jorge", color: "rojo" });
      for (let i = 0; i < 3; i++) expect(sala.agregarBot(0, true)).toBeNull();
      for (const id of ["bot-1", "bot-2", "bot-3"]) expect(sala.jugadores.get(id)!.mente!.campania).toBe(true);
      const libre = salaConBots(1);
      expect(libre.jugadores.get("bot-1")!.mente!.personalidad).toMatchObject({ nombre: "normal", contraBots: false });
      expect(libre.jugadores.get("bot-1")!.mente!.campania).toBe(false);
    });

    it("personalities rotate each round: distinct per bot, all five show up, never over 70%", () => {
      const mentes = [0, 1, 2].map(() => crearMente(rng(1), 0, sortearPersonalidad(MOLDES[0]), true));
      const vistas = new Set<string>();
      const azar = rng(11);
      for (let ronda = 0; ronda < 30; ronda++) {
        rotarPersonalidades(mentes, azar);
        const nombres = mentes.map((m) => m.personalidad.nombre);
        expect(new Set(nombres).size).toBe(3);
        nombres.forEach((n) => vistas.add(n));
        for (const { personalidad: p } of mentes) {
          expect(Math.max(p.detras, p.delante, p.rencor?.detras ?? 0, p.rencor?.delante ?? 0)).toBeLessThanOrEqual(AGRESIVIDAD_MAX);
        }
      }
      expect([...vistas].sort()).toEqual(MOLDES.map((m) => m.nombre).sort());
    });

    it("the values vary from round to round within the personality's range", () => {
      const azar = rng(5);
      const valores = Array.from({ length: 20 }, () => sortearPersonalidad(molde("cazador"), azar).detras);
      expect(Math.min(...valores)).toBeGreaterThanOrEqual(0.4);
      expect(Math.max(...valores)).toBeLessThanOrEqual(0.7);
      expect(new Set(valores.map((v) => v.toFixed(3))).size).toBeGreaterThan(10);
    });

    it("the winner has 5% more engine and always drives at its max", () => {
      const ganador = sortearPersonalidad(molde("ganador"));
      expect(fisicaDe(ganador).velocidadMax).toBeCloseTo(PARAMETROS_FISICA.velocidadMax * 1.05, 5);
      // Even a weak bot (habilidad < 1) aims past the usual top speed on a straight, where a normal one doesn't
      const acelera = (personalidad: ReturnType<typeof sortearPersonalidad>, sPista: number) => {
        const c = crearCarro(pista, sPista, 0);
        c.vx = Math.cos(c.angulo) * PARAMETROS_FISICA.velocidadMax * 0.98;
        c.vy = Math.sin(c.angulo) * PARAMETROS_FISICA.velocidadMax * 0.98;
        const mente = { ...crearMente(rng(1), 0, personalidad, true), habilidad: 0.85, carril: 0 };
        return pensar(mente, c, pista, 1, HZ, false, rng(1), true, []).acel;
      };
      const normal = sortearPersonalidad(molde("cerrador"));
      const enRecta = Array.from({ length: 60 }, (_, i) => i * 20).filter((sPista) => acelera(ganador, sPista) === 1 && acelera(normal, sPista) === 0);
      expect(enRecta.length).toBeGreaterThan(0);
    });

    it("the opportunist only goes after vulnerable cars", () => {
      const oportunista = { ...sortearPersonalidad(molde("oportunista"), () => 1) };
      const decidirCon = (otro: ReturnType<typeof crearCarro>) =>
        pensar({ ...crearMente(rng(1), 0, oportunista, true), carril: 3 }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, [{ carro: otro, bot: false, id: "yo" }]);
      const sano = crearCarro(pista, 115, -1);
      const empujado = { ...crearCarro(pista, 115, -1), empujon: 0.5 };
      const solo = pensar({ ...crearMente(rng(1), 0, oportunista, true), carril: 3 }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, []);
      expect(decidirCon(sano)).toEqual(solo);
      expect(decidirCon(empujado).giro).not.toBeCloseTo(solo.giro, 2);
    });

    it("the grudge-holder ignores everyone until hit, then goes after that car", () => {
      const rencoroso = { ...sortearPersonalidad(molde("rencoroso"), () => 0), rencor: { detras: 0.7, delante: 0.7, segundos: 8 } };
      const otro = { carro: crearCarro(pista, 115, -4), bot: true, id: "bot-2" };
      const mente = { ...crearMente(rng(1), 0, rencoroso, true), carril: 3 };
      const tranquilo = pensar({ ...mente }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, [otro]);
      const solo = pensar({ ...mente }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, []);
      expect(tranquilo).toEqual(solo);
      const conRencor = pensar({ ...mente, rencor: { id: "bot-2", hasta: 100 } }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, [otro]);
      expect(conRencor.giro).not.toBeCloseTo(solo.giro, 2);
      // Once the grudge expires, back to normal
      const pasado = pensar({ ...mente, rencor: { id: "bot-2", hasta: 100 } }, crearCarro(pista, 100, 3), pista, 200, HZ, false, rng(1), true, [otro]);
      expect(pasado.giro).toBeCloseTo(solo.giro, 5);
    });

    it("campaign bots go after other bots too; the usual ones only after people", () => {
      const cazador = sortearPersonalidad(molde("cazador"), () => 1);
      const otroBot = { carro: crearCarro(pista, 115, -4), bot: true };
      const conCazador = pensar({ ...crearMente(rng(1), 0, cazador), carril: 3 }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, [otroBot]);
      const solo = pensar({ ...crearMente(rng(1), 0, cazador), carril: 3 }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, []);
      expect(conCazador.giro).not.toBeCloseTo(solo.giro, 2);
      // The usual bot ignores other bots
      conAgresividad(1, 1, () => {
        expect(decidir([otroBot.carro].map((carro) => ({ carro, bot: true })) as never)).toEqual(decidir([]));
      });
    });

    it("about to fall out of the picture, it stops fighting and just races", () => {
      const cazador = sortearPersonalidad(molde("cazador"), () => 1);
      const otro = [{ carro: crearCarro(pista, 115, -4), bot: false, id: "yo" }];
      const decidirCon = (presas: typeof otro, peligro: number) =>
        pensar({ ...crearMente(rng(1), 0, cazador, true), carril: 3 }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true, presas, peligro);
      // Comfortable: it goes after the car ahead
      expect(decidirCon(otro, 0).giro).not.toBeCloseTo(decidirCon([], 0).giro, 2);
      // At the edge of the picture: it ignores it and drives its line
      expect(decidirCon(otro, 0.8).giro).toBeCloseTo(decidirCon([], 0.8).giro, 5);
      // Halfway: less of a swerve than when comfortable
      const desvio = (peligro: number) => Math.abs(decidirCon(otro, peligro).giro - decidirCon([], peligro).giro);
      expect(desvio(0.4)).toBeLessThan(desvio(0));
    });

    it("Hard: never brakes, always floors it, with the same engine as everyone (100%)", () => {
      const mentes = [0, 1, 2].map(() => crearMente(rng(1), 0, sortearPersonalidad(MOLDES[0]), true, true));
      const azar = rng(9);
      const velocidades: number[] = [];
      for (let ronda = 0; ronda < 20; ronda++) {
        rotarPersonalidades(mentes, azar);
        for (const m of mentes) {
          velocidades.push(m.personalidad.velocidad);
          if (m.personalidad.nombre === "ganador") expect(m.personalidad.velocidad).toBe(DIFICIL_VELOCIDAD_MAX);
        }
      }
      // Even the winner (5% more engine in Normal) is capped at 100% in Hard
      expect(DIFICIL_VELOCIDAD_MAX).toBe(1);
      expect(velocidades.every((v) => v === 1)).toBe(true);
      // Going too fast into any corner of the track: a Normal bot brakes somewhere, a Hard one never does
      const frenos = (dificil: boolean) =>
        Array.from({ length: 60 }, (_, i) => {
          const c = crearCarro(pista, i * 20, 0);
          c.vx = Math.cos(c.angulo) * 50;
          c.vy = Math.sin(c.angulo) * 50;
          return pensar({ ...crearMente(rng(1), 0, undefined, true, dificil), carril: 0 }, c, pista, 1, HZ, false, rng(1), true, []);
        });
      expect(frenos(false).some((c) => c.freno > 0)).toBe(true);
      expect(frenos(true).every((c) => c.freno === 0 && c.acel === 1)).toBe(true);
    });

    it("Hard bots come from the bots request of a Hard cup", () => {
      const sala = new Sala("HMO-3335", hermosillo, HZ, 5, ITEMS, rng(3));
      sala.agregar("yo", { nombre: "Jorge", color: "rojo" });
      expect(sala.agregarBot(0, true, true)).toBeNull();
      expect(sala.agregarBot(0, true)).toBeNull();
      expect(sala.jugadores.get("bot-1")!.mente!.dificil).toBe(true);
      expect(sala.jugadores.get("bot-2")!.mente!.dificil).toBe(false);
    });

    it("with no people around it drives its lane as always", () => {
      expect(decidir([])).toEqual(
        pensar({ ...crearMente(rng(1)), carril: 3 }, crearCarro(pista, 100, 3), pista, 1, HZ, false, rng(1), true),
      );
    });
  });

  it("join with their own name and color, and never host", () => {
    const sala = salaConBots(2);
    const jugadores = sala.estado().jugadores;
    expect(jugadores).toHaveLength(3);
    expect(jugadores.filter((j) => j.bot).map((j) => j.nombre)).toEqual(["Chuy", "Lupita"]);
    expect(new Set(jugadores.map((j) => j.color)).size).toBe(3);
    expect(sala.anfitrion).toBe("yo");
    expect(sala.agregarBot()).toBeNull();
    expect(sala.agregarBot()).toMatch(/4 jugadores/);
  });

  it("a room with only bots left counts as empty", () => {
    const sala = salaConBots(2);
    expect(sala.vacia).toBe(false);
    sala.quitar("yo");
    expect(sala.vacia).toBe(true);
  });

  it.each([
    ["hermosillo", 1],
    ["hermosillo", 2],
    ["hermosillo", 3],
    ["san-carlos", 1],
    ["san-carlos", 2],
    ["san-carlos", 3],
  ])("drive laps of %s without falling off a cliff or into the water (seed %i)", (id, semilla) => {
    const sala = salaConBots(2, semilla as number, leerCircuito(id as string));
    const bots = [...sala.jugadores.values()].filter((j) => j.mente);
    for (let t = 0; t < 40 * HZ; t++) {
      sala.paso();
      for (const b of bots) {
        expect(enBarranco(sala.pista, b.carro.x, b.carro.y)).toBe(false);
        expect(enAgua(sala.pista, b.carro.x, b.carro.y)).toBe(false);
      }
    }
    // In 40 s a decent driver covers well over a lap (~1.3–1.4 km)
    for (const b of bots) expect(sala.recorrido(b.id)).toBeGreaterThan(1000);
  });

  it("play a match: an idle human gets left behind and a bot scores", () => {
    const sala = salaConBots(2);
    expect(sala.empezar("yo")).toBeNull();
    let t = 0;
    while (sala.fase !== "ronda-fin" && t++ < 120 * HZ) sala.paso();
    expect(sala.fase).toBe("ronda-fin");
    expect(sala.jugadores.get("yo")!.vivo).toBe(false);
    expect(sala.ganadorRonda).toMatch(/^bot-/);
  });

  it("start forward after the countdown, not in reverse", () => {
    const sala = salaConBots(2);
    expect(sala.empezar("yo")).toBeNull();
    while (sala.fase === "cuenta") sala.paso();
    const bots = [...sala.jugadores.values()].filter((j) => j.mente);
    const antes = bots.map((b) => sala.recorrido(b.id));
    for (let t = 0; t < HZ; t++) sala.paso();
    bots.forEach((b, i) => expect(sala.recorrido(b.id) - antes[i]).toBeGreaterThan(10));
  });

  it("can be removed before starting", () => {
    const sala = salaConBots(2);
    sala.quitarBots();
    expect(sala.estado().jugadores).toHaveLength(1);
  });
});

describe("bots of online rooms", () => {
  const fijo = (...valores: number[]) => () => valores.shift() ?? 0;

  it("70 % the base car, 15 % a cup prize, 15 % one you buy", () => {
    expect(vehiculoDeBot(fijo(0.69, 0.5))).toBe("clasico");
    expect(vehiculoDeBot(fijo(0.7, 0))).toBe("arenero");
    expect(vehiculoDeBot(fijo(0.84, 0.99))).toBe("grua");
    expect(vehiculoDeBot(fijo(0.85, 0))).toBe("deportivo");
    expect(vehiculoDeBot(fijo(0.99, 0.99))).toBe("calabaza");
  });

  it("they arrive in 3-8, 8-14 and 14-20 s: the room is full in 20 s at most (quick match: the last two)", () => {
    expect(tiemposDeBots("sala", () => 0)).toEqual([3000, 8000, 14000]);
    expect(tiemposDeBots("sala", () => 0.999999)).toEqual([8000, 14000, 20000]);
    expect(tiemposDeBots("rapida", () => 0.5)).toEqual([11000, 17000]);
    expect(tiemposDeBots("hueco", () => 0)).toEqual([5000]);
    // Replacing a bot that got fed up: within 15 s
    expect(tiemposDeBots("relevo", () => 0.999999)).toEqual([15000]);
    // Quick match hosted by you: the first one joins after about 3 s
    expect(tiemposDeBots("primero", () => 0.5)).toEqual([3000]);
  });
});

describe("nametags of online bots", () => {
  it("1000 different names, each a valid player name", () => {
    expect(NAMETAGS).toHaveLength(1000);
    expect(new Set(NAMETAGS.map((n) => n.toLowerCase())).size).toBe(1000);
    for (const n of NAMETAGS) {
      expect(n.length).toBeLessThanOrEqual(LARGO_NOMBRE);
      expect(nombreOfensivo(n)).toBe(false);
      expect(sanearJugador({ nombre: n, color: "rojo" })).toMatchObject({ nombre: n });
    }
  });

  it("a bot never takes a name already in the room", () => {
    const usados = NAMETAGS.slice(0, 999);
    expect(nombreDeBot(usados, () => 0)).toBe(NAMETAGS[999]);
    expect(nombreDeBot([NAMETAGS[0].toUpperCase()], () => 0)).toBe(NAMETAGS[1]);
  });
});
