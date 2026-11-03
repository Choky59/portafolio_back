import { readFileSync } from "fs";
import path from "path";
import type { Circuito } from "../src/juego/compartido/tipos";
import { prepararPista } from "../src/juego/compartido/pista";
import { cercanos, restaurarEscenario } from "../src/juego/compartido/escenario";
import { planoObra, rngObra } from "../src/juego/compartido/obra";
import { procesarTicks, RelojPasosFijos, VentanaMetricas } from "../src/juego/compartido/metricas";

const leer = (): Circuito => JSON.parse(readFileSync(path.join(__dirname, "../content/juego/circuitos/obra-negra.json"), "utf8"));

describe("caché de pistas", () => {
  test("comparte el trabajo de preparación y mantiene cada sala totalmente independiente", () => {
    const circuito = leer();
    const a = prepararPista(circuito), b = prepararPista(circuito);
    expect(a.puntos).toEqual(b.puntos);
    expect(a.puntos).not.toBe(b.puntos);
    const id = [...a.escenario.moviles.keys()][0];
    const original = b.escenario.moviles.get(id)!.x;
    a.escenario.moviles.get(id)!.x += 100;
    a.escenario.objetos[0].x += 100;
    a.puntos[0][0] += 100;
    a.muros[0][0] += 100;
    const pa = planoObra(a), pb = planoObra(b);
    pa.patios[0].x += 100;
    expect(b.escenario.moviles.get(id)!.x).toBe(original);
    const c = prepararPista(circuito);
    expect(c.escenario.moviles.get(id)!.x).toBe(original);
    expect(c.escenario.objetos).toEqual(b.escenario.objetos);
    expect(c.puntos).toEqual(b.puntos);
    expect(c.muros).toEqual(b.muros);
    expect(planoObra(c)).toEqual(pb);
  });
  test("invalida la caché si se modifica el circuito original", () => {
    const circuito = leer();
    const a = prepararPista(circuito);
    const planoAnterior = planoObra(a);
    circuito.centro[1][0] += 20;
    circuito.decoracion.push({ tipo: "cono", x: 100, y: 100 });
    const b = prepararPista(circuito);
    expect(b.puntos).not.toEqual(a.puntos);
    expect(b.escenario.moviles.has(`decoracion:${circuito.decoracion.length - 1}`)).toBe(true);
    expect(planoObra(b).barriles[0]).not.toEqual(planoAnterior.barriles[0]);
  });
});

describe("índice espacial móvil", () => {
  test("encuentra exactamente los mismos vecinos y en el mismo orden que el recorrido lineal", () => {
    const pista = prepararPista(leer());
    const e = pista.escenario;
    const azar = rngObra(453);
    let i = 0;
    for (const cuerpo of e.moviles.values()) {
      if (i++ % 3) continue;
      cuerpo.x += 32;
      cuerpo.y -= 17;
      cuerpo.tumbado = true;
    }
    for (let n = 0; n < 120; n++) {
      const x = -120 + azar() * 500, y = -100 + azar() * 400, radio = 0.5 + azar() * 30;
      const referencia = [...e.moviles.values()].filter(c => Math.hypot(c.x - x, c.y - y) < radio + e.definiciones.get(c.id)!.radio + 1).map(c => c.id);
      expect(cercanos(e, x, y, radio).filter(o => o.masa).map(o => o.id)).toEqual(referencia);
    }
    restaurarEscenario(pista);
    for (const c of e.moviles.values()) expect(cercanos(e, c.x, c.y, 1).some(o => o.id === c.id)).toBe(true);
  });
  test("eliminar, reemplazar y vaciar cuerpos no deja entradas fantasma", () => {
    const e = prepararPista(leer()).escenario;
    const antiguo = [...e.moviles.values()][0];
    const nuevo = { ...antiguo, x: 2000, y: 2000 };
    e.moviles.set(antiguo.id, nuevo);
    antiguo.x = 4000;
    antiguo.y = 4000;
    expect(cercanos(e, 4000, 4000).filter(o => o.masa)).toEqual([]);
    expect(cercanos(e, 2000, 2000).some(o => o.id === nuevo.id)).toBe(true);
    e.moviles.delete(nuevo.id);
    nuevo.x = 6000;
    expect(cercanos(e, 6000, 2000).filter(o => o.masa)).toEqual([]);
    const ultimo = [...e.moviles.values()][0];
    e.moviles.clear();
    ultimo.x = 2000;
    expect(e.celdasMoviles.size).toBe(0);
  });
});

describe("relojes y métricas", () => {
  test("recupera todos los ticks en lotes limitados por pasos y por tiempo", () => {
    let tick = 0, ms = 0, turnos = 0;
    while (tick < 20) {
      const antes = tick;
      procesarTicks(() => tick, 20, () => { tick++; ms += 2; }, () => ms);
      expect(tick - antes).toBeLessThanOrEqual(2);
      turnos++;
    }
    expect(tick).toBe(20);
    expect(turnos).toBe(10);
    let rapidos = 0;
    expect(procesarTicks(() => rapidos, 100, () => { rapidos++; }, () => 0)).toBe(96);
  });
  test("el temporizador y el render pueden bombear el reloj sin duplicar ni perder controles", () => {
    const reloj = new RelojPasosFijos(1 / 60, 0);
    let pasos = 0;
    for (let n = 1; n <= 120; n++) {
      const ahora = n * 1000 / 120;
      reloj.avanzar(ahora, () => pasos++);
      reloj.avanzar(ahora, () => pasos++);
      if (n % 12 === 0) reloj.avanzar(ahora - 2, () => pasos++);
      expect(reloj.fraccion(ahora)).toBeGreaterThanOrEqual(0);
      expect(reloj.fraccion(ahora)).toBeLessThanOrEqual(1);
    }
    expect(pasos).toBe(60);
  });
  test("una pausa larga se recupera en turnos cortos sin una ráfaga ilimitada", () => {
    const reloj = new RelojPasosFijos(1 / 60, 0);
    let pasos = 0;
    expect(reloj.avanzar(1000, () => pasos++)).toBe(4);
    for (let n = 0; n < 5; n++) reloj.avanzar(1000, () => pasos++);
    expect(pasos).toBe(15);
    expect(reloj.avanzar(1000, () => pasos++)).toBe(0);
    expect(reloj.fraccion(1000)).toBeCloseTo(0);
  });
  test("los percentiles usan una ventana acotada e ignoran mediciones inválidas", () => {
    const muestras = new VentanaMetricas(3);
    for (const n of [1, 2, 3, 4, NaN, Infinity, -1]) muestras.registrar(n);
    expect(muestras.resumen()).toEqual({ n: 3, p50: 3, p95: 4, p99: 4, max: 4 });
  });
});
