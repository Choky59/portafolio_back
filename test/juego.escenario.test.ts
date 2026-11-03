import { readFileSync } from "fs";
import path from "path";
import type { Circuito } from "../src/juego/compartido/tipos";
import { prepararPista, puntoEnPista } from "../src/juego/compartido/pista";
import { avanzarCarro, colisionEscenario, crearCarro, PARAMETROS_FISICA as p, SIN_CONTROLES } from "../src/juego/compartido/fisica";
import { actualizarEscenario, contactoObjeto, empacarEscenario, escenarioVacio, restaurarEscenario, type ObjetoEscenario } from "../src/juego/compartido/escenario";
import { planoObra } from "../src/juego/compartido/obra";
import { Sala } from "../src/juego/servidor/salas";

const circuito = (id: string): Circuito => JSON.parse(readFileSync(path.join(__dirname, "../content/juego/circuitos", `${id}.json`), "utf8"));
const DT = 1 / 30;

function banco() {
  const pista = prepararPista(circuito("obra-negra"));
  pista.escenario = escenarioVacio();
  pista.muros = [];
  const carro = crearCarro(pista, 0);
  Object.assign(carro, { x: 50, y: 50, angulo: 0, vx: 20 });
  return { pista, carro };
}

function barril(pista: ReturnType<typeof prepararPista>, x = 54, y = 50, id = "barril:0") {
  const o: ObjetoEscenario = { id, tipo: "barril", x, y, angulo: 0, radio: 0.6, alto: 1.65, base: 0, masa: 0.65 };
  pista.escenario.objetos.push(o);
  pista.escenario.definiciones.set(o.id, o);
  pista.escenario.moviles.set(o.id, { id: o.id, x, y, angulo: 0, vx: 0, vy: 0, w: 0, tumbado: false });
  return pista.escenario.moviles.get(o.id)!;
}

describe("interacciones de la obra", () => {
  test.each(["obra-negra", "gruas", "excavacion"])("%s: todos los tipos y personas del plano tienen colisiones", (id) => {
    const pista = prepararPista(circuito(id));
    const plano = planoObra(pista);
    const ids = pista.escenario.definiciones;
    for (const [nombre, valores] of Object.entries({ cerca: plano.cerca, barrera: plano.barreras, barril: plano.barriles, senal: plano.senales, bandera: plano.banderas, persona: plano.personas, tubos: plano.tubos, bahia: plano.bahias, patio: plano.patios, decoracion: pista.circuito.decoracion })) {
      valores.forEach((_, i) => expect(ids.has(`${nombre}:${i}`)).toBe(true));
    }
    expect(pista.escenario.moviles.size).toBeGreaterThan(100);
    expect(empacarEscenario(pista)).toEqual([]);
    expect(planoObra(prepararPista(circuito(id)))).toEqual(plano);
  });

  test("el arco permite pasar por debajo y sus bases son sólidas", () => {
    const pista = prepararPista(circuito("obra-negra"));
    const centro = puntoEnPista(pista, 36);
    const bases = pista.escenario.objetos.filter(o => o.id === "portico");
    expect(bases).toHaveLength(2);
    for (const o of bases) {
      expect(contactoObjeto(o, centro.x, centro.y, p.radio)).toBeNull();
      expect(contactoObjeto(o, o.x, o.y, p.radio)).not.toBeNull();
    }
  });

  test("rectángulos girados y centros exactos producen normales válidas", () => {
    const o: ObjetoEscenario = { id: "barrera", tipo: "barrera", x: 0, y: 0, angulo: Math.PI / 4, ancho: 3, fondo: 0.8, radio: 2, alto: 1, base: 0, masa: 0 };
    const dentro = contactoObjeto(o, 0, 0, 1.1)!;
    expect(Math.hypot(dentro.nx, dentro.ny)).toBeCloseTo(1);
    expect(dentro.profundidad).toBeGreaterThan(1.1);
    expect(contactoObjeto(o, 20, 20, 1.1)).toBeNull();
  });

  test("un impacto empuja y derriba un barril, reduce la velocidad y genera feedback", () => {
    const { pista, carro } = banco();
    const cuerpo = barril(pista);
    const impactos: string[] = [];
    for (let i = 0; i < 15; i++) {
      avanzarCarro(carro, SIN_CONTROLES, p, pista, DT, e => impactos.push(e.objeto));
      actualizarEscenario(pista, DT);
    }
    expect(cuerpo.tumbado).toBe(true);
    expect(cuerpo.x).toBeGreaterThan(54.5);
    expect(carro.vx).toBeLessThan(20);
    expect(impactos).toContain(cuerpo.id);
  });

  test("un barril desplazado colisiona en su posición nueva y un salto lo sobrepasa", () => {
    const { pista, carro } = banco();
    const cuerpo = barril(pista);
    cuerpo.x = 90;
    Object.assign(carro, { x: 51.5, vx: 20 });
    expect(colisionEscenario(carro, pista, p)).toBe(0);
    Object.assign(carro, { x: 88, z: 3, vx: 20 });
    expect(colisionEscenario(carro, pista, p)).toBe(0);
    carro.z = 0;
    expect(colisionEscenario(carro, pista, p)).toBeGreaterThan(0);
  });

  test("las barreras frenan al carro a máxima velocidad y detienen objetos empujados", () => {
    const { pista, carro } = banco();
    const pared: ObjetoEscenario = { id: "pared", tipo: "barrera", x: 60, y: 50, angulo: Math.PI / 2, ancho: 12, fondo: 0.2, radio: 6.1, alto: 2, base: 0, masa: 0 };
    for (const x of [3, 4]) for (const y of [2, 3]) pista.escenario.fijos.set(`${x},${y}`, [pared]);
    carro.vx = 50;
    for (let i = 0; i < 20; i++) avanzarCarro(carro, SIN_CONTROLES, p, pista, DT);
    expect(carro.x).toBeLessThan(58);
    const cuerpo = barril(pista);
    cuerpo.vx = 45;
    cuerpo.tumbado = true;
    for (let i = 0; i < 40; i++) actualizarEscenario(pista, DT);
    expect(cuerpo.x).toBeLessThan(59.1);
  });

  test("los barriles transmiten el empuje y derriban a otros objetos pequeños", () => {
    const { pista } = banco();
    const a = barril(pista), b = barril(pista, 56, 50, "barril:1");
    a.vx = 20;
    a.tumbado = true;
    for (let i = 0; i < 25; i++) actualizarEscenario(pista, DT);
    expect(b.x).toBeGreaterThan(56.3);
    expect(b.tumbado).toBe(true);
  });

  test("instantáneas y reinicio conservan/restauran todo el estado móvil", () => {
    const { pista } = banco();
    const cuerpo = barril(pista);
    Object.assign(cuerpo, { x: 60, y: 51, vx: 3, vy: 2, w: 1, tumbado: true });
    const red = empacarEscenario(pista);
    restaurarEscenario(pista);
    expect(cuerpo.x).toBe(54);
    expect(cuerpo.tumbado).toBe(false);
    restaurarEscenario(pista, red);
    expect(empacarEscenario(pista)).toEqual(red);
  });

  test("servidor y predicción reproducen el mismo choque y movimiento", () => {
    const a = banco(), b = banco();
    barril(a.pista); barril(b.pista);
    for (let i = 0; i < 30; i++) {
      for (const mundo of [a, b]) {
        avanzarCarro(mundo.carro, { ...SIN_CONTROLES, acel: 1 }, p, mundo.pista, DT);
        actualizarEscenario(mundo.pista, DT);
      }
    }
    expect(a.carro).toEqual(b.carro);
    expect(empacarEscenario(a.pista)).toEqual(empacarEscenario(b.pista));
  });

  test("las salas incluyen el estado móvil para jugadores que entran después", () => {
    const sala = new Sala("HMO-0000", circuito("obra-negra"), 30, 3, [], () => 0.5);
    const cuerpo = [...sala.pista.escenario.moviles.values()][0];
    cuerpo.x += 4;
    cuerpo.tumbado = true;
    expect(sala.instantanea().o?.some(o => o[0] === cuerpo.id && o[7])).toBe(true);
  });

  test("las pistas de desierto no reciben obstáculos de construcción", () => {
    expect(prepararPista(circuito("hermosillo")).escenario.objetos).toEqual([]);
  });
});
