import { readFileSync } from "fs";
import path from "path";
import { Circuito, Controles, EstadoCarro, Item } from "../src/juego/compartido/tipos";
import { cajasDelCircuito, enAgua, enBarranco, prepararPista, proyectar } from "../src/juego/compartido/pista";
import { PARAMETROS_FISICA, avanzarCarro, chocarCarros, crearCarro, enElAire, rapidez } from "../src/juego/compartido/fisica";
import { Sala } from "../src/juego/servidor/salas";

const DIR = path.join(__dirname, "..", "content", "juego");
const leer = (id: string): Circuito => JSON.parse(readFileSync(path.join(DIR, "circuitos", `${id}.json`), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;
const DT = 1 / HZ;
const p = PARAMETROS_FISICA;
const ACELERAR: Controles = { giro: 0, acel: 1, freno: 0, mano: false };
const SUELTO: Controles = { giro: 0, acel: 0, freno: 0, mano: false };

/** A car `antes` m before the foot of ramp `i`, pointing up it at `v` m/s */
function haciaLaRampa(circuito: Circuito, i: number, v: number, antes = 4): EstadoCarro {
  const pista = prepararPista(circuito);
  const r = circuito.rampas![i];
  const c = crearCarro(pista, 0);
  const fx = Math.cos(r.angulo);
  const fy = Math.sin(r.angulo);
  return { ...c, x: r.x - fx * antes, y: r.y - fy * antes, angulo: r.angulo, vx: fx * v, vy: fy * v, indice: proyectar(pista, r.x, r.y).indice };
}

describe("jump ramps", () => {
  for (const id of ["hermosillo", "san-carlos"]) {
    describe(id, () => {
      const circuito = leer(id);
      const pista = prepararPista(circuito);

      it("has ramps off the road, on the inside of curves, that jump back onto the track (a shortcut)", () => {
        expect(circuito.rampas!.length).toBeGreaterThanOrEqual(2);
        for (const r of circuito.rampas!) {
          const fx = Math.cos(r.angulo);
          const fy = Math.sin(r.angulo);
          for (let a = 0; a <= r.largo; a++) {
            expect(proyectar(pista, r.x + fx * a, r.y + fy * a).distancia).toBeGreaterThan(pista.mitad);
          }
          // Straight on from the lip, it gets back to the road within ~35 m, over free ground
          let vuelve = false;
          for (let a = r.largo; a < r.largo + 36 && !vuelve; a += 1) {
            const x = r.x + fx * a;
            const y = r.y + fy * a;
            expect(enBarranco(pista, x, y) || enAgua(pista, x, y)).toBe(false);
            if (proyectar(pista, x, y).distancia < pista.mitad) vuelve = true;
          }
          expect(vuelve).toBe(true);
          // It's a shortcut: along the road, the landing is further than the ramp's foot
          const pie = proyectar(pista, r.x, r.y).s;
          const lejos = proyectar(pista, r.x + fx * (r.largo + 30), r.y + fy * (r.largo + 30)).s;
          expect((lejos - pie + pista.longitud) % pista.longitud).toBeGreaterThan(r.largo + 10);
        }
      });

      it("fast up the ramp: flies, goes high enough to catch the floating box, and lands", () => {
        circuito.rampas!.forEach((r, i) => {
          const c = haciaLaRampa(circuito, i, p.velocidadMax);
          const [cx, cy, cz] = cajasDelCircuito(circuito)[circuito.cajas.length + i];
          let alcanza = false;
          let maxZ = 0;
          let voló = false;
          for (let t = 0; t < 3 * HZ; t++) {
            avanzarCarro(c, ACELERAR, p, pista, DT);
            voló ||= enElAire(c);
            maxZ = Math.max(maxZ, c.z);
            if (Math.hypot(c.x - cx, c.y - cy) < 3.4 && Math.abs(c.z - cz) < 2) alcanza = true;
          }
          expect(voló).toBe(true);
          expect(maxZ).toBeGreaterThan(r.alto + 0.8);
          expect(alcanza).toBe(true);
          expect(c.z).toBe(0);
          expect(c.rampa).toBe(-1);
        });
      });

      it("slow up the ramp: barely jumps and doesn't reach the box", () => {
        const c = haciaLaRampa(circuito, 0, 12);
        const [cx, cy, cz] = cajasDelCircuito(circuito)[circuito.cajas.length];
        let alcanza = false;
        for (let t = 0; t < 3 * HZ; t++) {
          avanzarCarro(c, SUELTO, p, pista, DT);
          if (Math.hypot(c.x - cx, c.y - cy) < 3.4 && Math.abs(c.z - cz) < 2) alcanza = true;
        }
        expect(alcanza).toBe(false);
      });
    });
  }

  it("landing costs some speed", () => {
    const circuito = leer("hermosillo");
    const pista = prepararPista(circuito);
    const c = haciaLaRampa(circuito, 0, 30);
    let antes = 0;
    for (let t = 0; t < 3 * HZ; t++) {
      const volando = enElAire(c);
      if (volando) antes = rapidez(c);
      avanzarCarro(c, SUELTO, p, pista, DT);
      if (volando && !enElAire(c)) {
        expect(rapidez(c)).toBeLessThan(antes * 0.95);
        return;
      }
    }
    throw new Error("never landed");
  });

  it("cars don't collide when one flies over the other", () => {
    const pista = prepararPista(leer("hermosillo"));
    const abajo = crearCarro(pista, 50);
    const arriba = { ...crearCarro(pista, 50), z: 2.5, vz: 1 };
    expect(chocarCarros(abajo, arriba, p, HZ).fuerza).toBe(0);
    expect([abajo.x, arriba.x]).toEqual([crearCarro(pista, 50).x, crearCarro(pista, 50).x]);
  });

  it("the floating box is only caught flying; driving under it does nothing", () => {
    const circuito = leer("hermosillo");
    const sala = new Sala("HMO-6666", circuito, HZ, 5, ITEMS, () => 0);
    sala.agregar("a", { nombre: "A", color: "rojo" });
    const a = sala.jugadores.get("a")!;
    const caja = sala.cajas[circuito.cajas.length];
    expect(caja.z).toBe(3);
    a.carro = { ...a.carro, x: caja.x, y: caja.y, z: 0 };
    sala.paso();
    expect(a.item).toBe(-1);
    a.carro = { ...a.carro, x: caja.x, y: caja.y, z: 2.6, vz: 0.5, rampa: -1 };
    sala.paso();
    expect(a.item).toBeGreaterThanOrEqual(0);
  });
});

describe("control arcade en rampas y saltos", () => {
  const base: Circuito = {
    ...leer("prueba"),
    centro: [[0, 0], [300, 0], [300, 200], [0, 200]],
    ancho: 100,
    limites: { x: -100, y: -100, ancho: 500, alto: 500 },
    muros: [], superficies: [], barrancos: [], decoracion: [], rampas: [],
  };
  const suelo = prepararPista(base);
  const rampa = prepararPista({ ...base, rampas: [{ x: 0, y: 0, angulo: 0, largo: 100, ancho: 80, alto: 10 }] });
  const carro = () => ({ ...crearCarro(suelo, 20), x: 20, y: 0, angulo: 0, vx: 25, vy: 0, w: 0 });
  const volando = () => ({ ...carro(), z: 10, vz: 2, rampa: -1 });
  function simular(c: EstadoCarro, pista: ReturnType<typeof prepararPista>, ctrl: Controles, ticks: number) {
    for (let t = 0; t < ticks; t++) avanzarCarro(c, ctrl, p, pista, DT);
  }

  it.each([-1, 1])("gira hacia %s en la rampa y en el aire, con menos fuerza que en el suelo", (giro) => {
    const normal = carro(), subiendo = carro(), salto = volando();
    const ctrl = { ...SUELTO, giro };
    simular(normal, suelo, ctrl, 12);
    simular(subiendo, rampa, ctrl, 12);
    simular(salto, suelo, ctrl, 12);
    expect(subiendo.rampa).toBe(0);
    expect(subiendo.angulo * giro).toBeGreaterThan(0.1);
    expect(Math.abs(subiendo.angulo)).toBeLessThan(Math.abs(normal.angulo) * 0.8);
    expect(salto.angulo * giro).toBeGreaterThan(0.05);
    expect(Math.abs(salto.angulo)).toBeLessThan(Math.abs(subiendo.angulo));
    // Steering changes the actual flight path, rather than just rotating the car model.
    expect(salto.y * giro).toBeGreaterThan(0.2);
    expect(salto.vy * giro).toBeGreaterThan(1);
  });

  it("permite contravolante después del despegue para corregir una salida", () => {
    const c = volando();
    simular(c, suelo, { ...SUELTO, giro: 1 }, 6);
    expect(c.vy).toBeGreaterThan(0);
    simular(c, suelo, { ...SUELTO, giro: -1 }, 18);
    expect(enElAire(c)).toBe(true);
    expect(c.w).toBeLessThan(-0.2);
    expect(c.angulo).toBeLessThan(0);
    expect(c.vy).toBeLessThan(0);
  });

  it("corregir el vuelo conserva su rapidez, altura y gravedad", () => {
    const recto = volando(), girando = volando();
    simular(recto, suelo, SUELTO, 12);
    simular(girando, suelo, { giro: 1, acel: 1, freno: 1, mano: true }, 12);
    expect(rapidez(girando)).toBeCloseTo(rapidez(recto), 9);
    expect(rapidez(girando)).toBeCloseTo(25, 9);
    expect(girando.z).toBe(recto.z);
    expect(girando.vz).toBe(recto.vz);
    expect(girando.y).toBeGreaterThan(recto.y);
  });

  it("sin volante conserva el salto recto y al soltarlo deja de girar", () => {
    const c = volando();
    simular(c, suelo, SUELTO, 6);
    expect(c.y).toBe(0);
    expect(c.angulo).toBe(0);
    expect(c.x).toBeCloseTo(25, 9);
    simular(c, suelo, { ...SUELTO, giro: 1 }, 6);
    const giroAnterior = c.w;
    simular(c, suelo, SUELTO, 12);
    expect(Math.abs(c.w)).toBeLessThan(Math.abs(giroAnterior) * 0.1);
  });

  it.each(["aturdido", "trompo"] as const)("mantiene el efecto de %s durante el salto", (efecto) => {
    const recto = { ...volando(), [efecto]: 60, w: 0.7 };
    const girando = { ...recto };
    simular(recto, suelo, SUELTO, 9);
    simular(girando, suelo, { ...SUELTO, giro: 1 }, 9);
    expect(girando).toEqual(recto);
  });
});
