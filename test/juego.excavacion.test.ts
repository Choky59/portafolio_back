import { readFileSync } from "fs";
import path from "path";
import type { Circuito } from "../src/juego/compartido/tipos";
import { prepararPista, puntoEnPista, enBarranco, proyectar, sueloEn, carriles, centroDeCarril } from "../src/juego/compartido/pista";
import { avanzarCarro, circulosCarro, crearCarro, PARAMETROS_FISICA } from "../src/juego/compartido/fisica";
import { centroCarrilPuente, crearEstadoExcavacion, fasePala, fasePuente, lateralPala, localExcavacion, mitadPuenteEn, riesgosExcavacion, sincronizarExcavacion } from "../src/juego/compartido/excavacion";
import { MecanicasExcavacion } from "../src/juego/servidor/excavacion";
import { Sala } from "../src/juego/servidor/salas";
import { esquivar } from "../src/juego/servidor/bots";

const leer = (id: string): Circuito => JSON.parse(readFileSync(path.join(__dirname, "../content/juego/circuitos", `${id}.json`), "utf8"));
const circuito = leer("excavacion"), c = circuito.excavacion!;
const HZ = 30;

function zona() {
  const pista = prepararPista(circuito), mecanismo = new MecanicasExcavacion(pista);
  const jugador = (id: string, s: number, lat: number) => ({ id, vivo: true, carro: crearCarro(pista, s, lat) });
  return { pista, mecanismo, jugador };
}

function mover(z: ReturnType<typeof zona>, j: ReturnType<ReturnType<typeof zona>["jugador"]>, avance: number, lateral: number) {
  j.carro = crearCarro(z.pista, c.puente.s + avance, lateral);
}

function cruzar(z: ReturnType<typeof zona>, j: ReturnType<ReturnType<typeof zona>["jugador"]>, lateral: number, t = 0) {
  mover(z, j, -16, lateral); z.mecanismo.actualizar(t, [j]);
  mover(z, j, 0, lateral); z.mecanismo.actualizar(t + 0.2, [j]);
  mover(z, j, 16, lateral); z.mecanismo.actualizar(t + 0.4, [j]);
  return t + 0.4;
}

function salaNueva() {
  const sala = new Sala("EXC-1111", circuito, HZ);
  sala.agregar("a", { nombre: "A", color: "rojo" });
  sala.agregar("b", { nombre: "B", color: "azul" });
  return sala;
}

describe("Excavación de 900 metros", () => {
  it("reproduce la guía simplificada, con zonas de obra colocadas a mano y dos carriles", () => {
    const p = prepararPista(circuito);
    expect(p.longitud).toBeCloseTo(900, 1);
    expect(circuito.ancho).toBe(14);
    expect(circuito.carriles).toBe(2);
    expect(circuito.patiosFijos!.length).toBeGreaterThan(0);
    expect(circuito.ambiente).toBeUndefined();
    const a = puntoEnPista(p, c.puente.s - c.puente.largo / 2), b = puntoEnPista(p, c.puente.s + c.puente.largo / 2);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(c.puente.largo, 2);
    for (const s of [c.pala.s, c.pala.placaS, c.puente.s]) expect(s).toBeGreaterThan(40);
    for (const [x, y] of circuito.cajas) expect(proyectar(p, x, y).distancia).toBeLessThan(6);
  });

  it("solamente Excavación configura estos mecanismos", () => {
    for (const id of ["hermosillo", "san-carlos", "desierto", "gruas", "obra-negra"]) {
      const p = prepararPista(leer(id));
      expect(p.circuito.excavacion).toBeUndefined();
      expect(p.huecos).toBeUndefined();
      expect(riesgosExcavacion(p, crearEstadoExcavacion(), 10)).toEqual([]);
    }
  });

  it("la pala avisa, barre, regresa y recarga con fronteras de tiempo deterministas", () => {
    const e = { ...crearEstadoExcavacion(), pala: 10 };
    expect(fasePala(c, e, 10).fase).toBe("aviso");
    expect(fasePala(c, e, 10 + c.pala.aviso).fase).toBe("barrido");
    expect(fasePala(c, e, 10 + c.pala.aviso + c.pala.barrido).fase).toBe("retorno");
    expect(fasePala(c, e, 10 + c.pala.aviso + c.pala.barrido + c.pala.retorno).fase).toBe("recarga");
    expect(fasePala(c, e, 30).fase).toBe("lista");
  });

  it("solo activa la placa un coche vivo apoyado en ella", () => {
    const { mecanismo, jugador } = zona();
    const j = jugador("a", c.pala.placaS, c.pala.placaLateral);
    j.carro.z = 2;
    mecanismo.actualizar(0, [j]);
    expect(mecanismo.estado.pala).toBe(-1);
    j.carro.z = 0; j.vivo = false;
    mecanismo.actualizar(1, [j]);
    expect(mecanismo.estado.pala).toBe(-1);
    j.vivo = true;
    mecanismo.actualizar(2, [j]);
    expect(mecanismo.estado.pala).toBe(2);
  });

  it("mantenerse sobre la placa no vuelve a dispararla; hay que salir y entrar después de la recarga", () => {
    const { mecanismo, jugador } = zona();
    const j = jugador("a", c.pala.placaS, c.pala.placaLateral);
    mecanismo.actualizar(0, [j]);
    mecanismo.actualizar(0.5, [j]);
    expect(mecanismo.estado.pala).toBe(0);
    mecanismo.actualizar(20, [j]);
    expect(mecanismo.estado.pala).toBe(-1);
    mecanismo.actualizar(21, []);
    mecanismo.actualizar(22, [j]);
    expect(mecanismo.estado.pala).toBe(22);
  });

  it("avisa sin golpear, golpea una sola vez y deja libre el carril interior", () => {
    const { pista, mecanismo, jugador } = zona();
    const placa = jugador("a", c.pala.placaS, c.pala.placaLateral);
    mecanismo.actualizar(0, [placa]);
    const victima = jugador("b", c.pala.s, lateralPala(pista, 0.5));
    const seguro = jugador("c", c.pala.s, pista.mitad / 2);
    expect(mecanismo.actualizar(0.5, [victima, seguro])).toHaveLength(0);
    const t = c.pala.aviso + c.pala.barrido * 0.5;
    expect(mecanismo.actualizar(t, [victima, seguro]).map(j => j.id)).toEqual(["b"]);
    expect(mecanismo.actualizar(t + 0.001, [victima, seguro])).toHaveLength(0);
    victima.carro.z = 2;
    mecanismo.reiniciar(); mecanismo.estado.pala = 0;
    expect(mecanismo.actualizar(t, [victima, seguro])).toHaveLength(0);
  });

  it("amplía solo el puente a cuatro carriles asfaltados con accesos progresivos", () => {
    const { pista } = zona();
    expect(carriles(pista, c.puente.s)).toEqual({ n: 4, ancho: 7 });
    expect(carriles(pista, 0)).toEqual({ n: 2, ancho: 7 });
    expect(mitadPuenteEn(pista, c.puente.s)).toBe(14);
    expect(mitadPuenteEn(pista, c.puente.s - 60)).toBe(7);
    expect(mitadPuenteEn(pista, c.puente.s - 30)).toBeGreaterThan(7);
    expect(mitadPuenteEn(pista, c.puente.s - 30)).toBeLessThan(14);
    for (let i = 0; i < 4; i++) {
      const lat = centroCarrilPuente(c, i);
      expect(centroDeCarril(pista, lat, c.puente.s)).toBe(lat);
      for (const d of [-18, 0, 18]) {
        const p = puntoEnPista(pista, c.puente.s + d, lat);
        expect(sueloEn(pista, p.x, p.y)).toBe("asfalto");
        expect(enBarranco(pista, p.x, p.y)).toBe(false);
      }
    }
  });

  it.each([0, 1, 2, 3])("el carril %s espera a que salga también la parte trasera del primer coche", i => {
    const z = zona(), lat = centroCarrilPuente(c, i), j = z.jugador("a", c.puente.s - 16, lat);
    z.mecanismo.actualizar(0, [j]);
    mover(z, j, 0, lat); z.mecanismo.actualizar(0.2, [j]);
    expect(z.mecanismo.estado.puente).toEqual([-1, -1, -1, -1]);
    expect(z.mecanismo.estado.pasando).toBe(1 << i);
    mover(z, j, c.puente.largo / 2 + 0.4, lat); z.mecanismo.actualizar(0.4, [j]);
    expect(z.pista.huecos).toHaveLength(0);
    mover(z, j, 16, lat); z.mecanismo.actualizar(0.6, [j]);
    expect(z.mecanismo.estado.puente[i]).toBe(0.6);
    expect(fasePuente(c, z.mecanismo.estado, 0.6, i).fase).toBe("caida");
    expect(z.pista.huecos).toEqual([c.puente.huecos[i]]);
    for (let k = 0; k < 4; k++) {
      const p = puntoEnPista(z.pista, c.puente.s, centroCarrilPuente(c, k));
      expect(enBarranco(z.pista, p.x, p.y)).toBe(k === i);
    }
  });

  it("la grúa termina la reposición antes de devolver el suelo y el puente no se reactiva por estar detenido", () => {
    const z = zona(), { pista, mecanismo, jugador } = z;
    const j = jugador("a", c.puente.s - 16, -3.5);
    const inicio = cruzar(z, j, -3.5);
    const reparado = inicio + c.puente.caida + c.puente.abierto + c.puente.reparacion;
    mecanismo.actualizar(reparado - 0.01, [j]);
    expect(pista.huecos).toHaveLength(1);
    mecanismo.actualizar(reparado, [j]);
    expect(pista.huecos).toHaveLength(0);
    mecanismo.actualizar(30, [j]);
    expect(mecanismo.estado.puente).toEqual([-1, -1, -1, -1]);
    mecanismo.actualizar(30.5, []);
    cruzar(z, j, -3.5, 31);
    expect(mecanismo.estado.puente[1]).toBe(31.4);
  });

  it("detenerse sobre el puente no lo rompe y regresar por donde entró cancela el cruce", () => {
    const z = zona(), j = z.jugador("a", c.puente.s - 16, -10.5);
    z.mecanismo.actualizar(0, [j]);
    mover(z, j, 0, -10.5); z.mecanismo.actualizar(0.2, [j]);
    z.mecanismo.actualizar(20, [j]);
    expect(z.mecanismo.estado.puente).toEqual([-1, -1, -1, -1]);
    expect(z.pista.huecos).toHaveLength(0);
    mover(z, j, -16, -10.5); z.mecanismo.actualizar(21, [j]);
    expect(z.mecanismo.estado.puente).toEqual([-1, -1, -1, -1]);
    expect(z.mecanismo.estado.pasando).toBe(0);
  });

  it("salir por un lateral o aparecer en medio no cuenta como cruzar el puente", () => {
    const z = zona(), j = z.jugador("a", c.puente.s - 16, -10.5);
    z.mecanismo.actualizar(0, [j]);
    mover(z, j, 0, -10.5); z.mecanismo.actualizar(0.2, [j]);
    mover(z, j, 0, -20); z.mecanismo.actualizar(0.3, [j]);
    mover(z, j, 16, -10.5); z.mecanismo.actualizar(0.4, [j]);
    expect(z.mecanismo.estado.puente).toEqual([-1, -1, -1, -1]);
    z.mecanismo.reiniciar();
    mover(z, j, 0, -10.5); z.mecanismo.actualizar(1, [j]);
    mover(z, j, 16, -10.5); z.mecanismo.actualizar(2, [j]);
    expect(z.mecanismo.estado.puente).toEqual([-1, -1, -1, -1]);
  });

  it("cambiar de carril durante el cruce rompe únicamente el carril por el que empezó", () => {
    const z = zona(), j = z.jugador("a", c.puente.s - 16, -10.5);
    z.mecanismo.actualizar(0, [j]);
    mover(z, j, 0, -3.5); z.mecanismo.actualizar(0.2, [j]);
    expect(z.mecanismo.estado.pasando).toBe(1);
    mover(z, j, 16, -3.5); z.mecanismo.actualizar(0.4, [j]);
    expect(z.mecanismo.estado.puente).toEqual([0.4, -1, -1, -1]);
  });

  it("guarda el carril en el instante de entrada aunque cambie de carril entre dos ticks", () => {
    const z = zona(), j = z.jugador("a", c.puente.s - 16, -10.5);
    z.mecanismo.actualizar(0, [j]);
    mover(z, j, -8, -6.5); z.mecanismo.actualizar(0.1, [j]);
    expect(z.mecanismo.estado.pasando).toBe(1);
    mover(z, j, 0, 3.5); z.mecanismo.actualizar(0.2, [j]);
    expect(z.mecanismo.estado.pasando).toBe(1);
    mover(z, j, 16, 10.5); z.mecanismo.actualizar(0.4, [j]);
    expect(z.mecanismo.estado.puente).toEqual([0.4, -1, -1, -1]);
  });

  it("también conserva el carril de entrada cuando cruza de regreso y sale por otro", () => {
    const z = zona(), j = z.jugador("a", c.puente.s + 16, 10.5);
    z.mecanismo.actualizar(0, [j]);
    mover(z, j, 0, 3.5); z.mecanismo.actualizar(0.2, [j]);
    expect(z.mecanismo.estado.pasando).toBe(8);
    mover(z, j, -16, 3.5); z.mecanismo.actualizar(0.4, [j]);
    expect(z.mecanismo.estado.puente).toEqual([-1, -1, -1, 0.4]);
  });

  it("cambiar de carril después de salir no rompe por error el carril vecino", () => {
    const z = zona(), j = z.jugador("a", c.puente.s - 16, -10.5);
    z.mecanismo.actualizar(0, [j]);
    mover(z, j, 0, -7.2); z.mecanismo.actualizar(0.2, [j]);
    const extension = -Math.min(...circulosCarro(j.carro).map(q => localExcavacion(z.pista, c.puente.s, q).avance)) + PARAMETROS_FISICA.radio;
    mover(z, j, c.puente.largo / 2 + extension - 0.05, -7.2);
    z.mecanismo.actualizar(0.3, [j]);
    mover(z, j, c.puente.largo / 2 + extension + 3, -6.5);
    z.mecanismo.actualizar(0.4, [j]);
    expect(z.mecanismo.estado.puente).toEqual([0.4, -1, -1, -1]);
  });

  it("los cuatro carriles se rompen de forma independiente cuando salen cuatro coches", () => {
    const z = zona(), js = Array.from({ length: 4 }, (_, i) => z.jugador(String(i), c.puente.s - 16, centroCarrilPuente(c, i)));
    z.mecanismo.actualizar(0, js);
    js.forEach((j, i) => mover(z, j, 0, centroCarrilPuente(c, i)));
    z.mecanismo.actualizar(0.2, js);
    expect(z.mecanismo.estado.pasando).toBe(15);
    js.forEach((j, i) => {
      mover(z, j, 16, centroCarrilPuente(c, i));
      z.mecanismo.actualizar(0.4 + i * 0.2, js);
      expect(z.pista.huecos).toHaveLength(i + 1);
    });
    expect(z.mecanismo.estado.puente.every(t => t >= 0)).toBe(true);
    expect(z.mecanismo.estado.pasando).toBe(0);
  });

  it("un cruce rápido entre dos ticks también se detecta; saltar todo el puente no lo activa", () => {
    for (const zCarro of [0, 3]) {
      const z = zona(), j = z.jugador("a", c.puente.s - 16, 10.5);
      j.carro.z = zCarro; z.mecanismo.actualizar(0, [j]);
      mover(z, j, 16, 10.5); j.carro.z = zCarro;
      z.mecanismo.actualizar(1 / HZ, [j]);
      expect(z.mecanismo.estado.puente[3]).toBe(zCarro ? -1 : 1 / HZ);
    }
  });

  it("también espera al coche completo si cruza el puente de regreso", () => {
    const z = zona(), j = z.jugador("a", c.puente.s + 16, 10.5);
    z.mecanismo.actualizar(0, [j]);
    mover(z, j, 0, 10.5); z.mecanismo.actualizar(0.2, [j]);
    mover(z, j, -16, 10.5); z.mecanismo.actualizar(0.4, [j]);
    expect(z.mecanismo.estado.puente).toEqual([-1, -1, -1, 0.4]);
  });

  it("salas independientes y reinicio de ronda no comparten huecos ni cambian el layout", () => {
    const a = zona(), b = zona(), antes = JSON.stringify(circuito);
    a.mecanismo.estado.puente[0] = 0;
    a.mecanismo.actualizar(3, []);
    expect(a.pista.huecos).toHaveLength(1);
    expect(b.pista.huecos).toHaveLength(0);
    a.mecanismo.reiniciar();
    expect(a.pista.huecos).toHaveLength(0);
    expect(a.mecanismo.estado).toEqual(crearEstadoExcavacion());
    expect(JSON.stringify(circuito)).toBe(antes);
  });

  it("un cliente reconstruye exactamente la apertura desde el estado de la instantánea", () => {
    const servidor = zona(), cliente = zona();
    servidor.mecanismo.estado = { pala: 0, puente: [1, -1, 2, -1], pasando: 0 };
    servidor.mecanismo.actualizar(4, []);
    const red = JSON.parse(JSON.stringify(servidor.mecanismo.estado));
    sincronizarExcavacion(cliente.pista, red, 4);
    expect(cliente.pista.huecos).toEqual(servidor.pista.huecos);
  });

  it("los bots pueden tomar un carril exterior cuando los dos centrales se rompen", () => {
    const { pista } = zona();
    const riesgos = riesgosExcavacion(pista, { pala: -1, puente: [-1, 0, 0, -1], pasando: 0 }, 0.5);
    expect(riesgos.length).toBeGreaterThan(1);
    const eleccion = esquivar(pista, c.puente.s - 25, 35, 3.5, riesgos);
    expect(Math.abs(eleccion.lateral)).toBeGreaterThan(8.1);
    expect(Math.abs(eleccion.lateral)).toBeLessThan(12.9);
  });

  it("la sala aplica el empujón hacia la excavación y respeta casco/escudo", () => {
    for (const protegido of [null, "escudo", "pesado"] as const) {
      const sala = salaNueva(), interna = sala as any;
      sala.fase = "carrera";
      sala.tick = Math.round((c.pala.aviso + c.pala.barrido / 2) * HZ) - 1;
      interna.excavacion.estado.pala = 0;
      const victima = sala.jugadores.get("a")!, seguro = sala.jugadores.get("b")!;
      victima.carro = crearCarro(sala.pista, c.pala.s, lateralPala(sala.pista, 0.5));
      seguro.carro = crearCarro(sala.pista, c.pala.s, 3.5);
      if (protegido) victima.carro[protegido] = 50;
      sala.paso();
      const p = puntoEnPista(sala.pista, c.pala.s);
      const impulso = -Math.sin(p.angulo) * victima.carro.vx + Math.cos(p.angulo) * victima.carro.vy;
      expect(impulso).toBeCloseTo(protegido ? 0 : c.pala.empuje, 2);
      expect(sala.eventos.some(e => e.tipo === (protegido ? "escudo" : "obra"))).toBe(true);
    }
  });

  it("el empujón alcanza la fosa con la física real si el conductor no se recupera", () => {
    const { pista } = zona(), carro = crearCarro(pista, c.pala.s, -3);
    const p = puntoEnPista(pista, c.pala.s);
    carro.vx = -Math.sin(p.angulo) * c.pala.empuje;
    carro.vy = Math.cos(p.angulo) * c.pala.empuje;
    carro.empujon = c.pala.deslizamiento;
    let cae = false;
    for (let k = 0; k < HZ * 3 && !cae; k++) {
      avanzarCarro(carro, { giro: 0, acel: 0, freno: 0, mano: false }, PARAMETROS_FISICA, pista, 1 / HZ);
      cae = enBarranco(pista, carro.x, carro.y);
    }
    expect(cae).toBe(true);
  });

  it.each([false, true])("el perseguidor del carril inicial cae aunque el primero cambie de carril (%s)", cambia => {
    const sala = salaNueva(), interna = sala as any;
    sala.fase = "carrera";
    const a = sala.jugadores.get("a")!, b = sala.jugadores.get("b")!;
    for (const [adelante, atras] of [[-16, -23], [0, -8], [16, 0]]) {
      a.carro = crearCarro(sala.pista, c.puente.s + adelante, cambia && adelante >= 0 ? 3.5 : -3.5);
      b.carro = crearCarro(sala.pista, c.puente.s + atras, -3.5);
      sala.paso();
    }
    expect(a.vivo).toBe(true);
    expect(b.vivo).toBe(false);
    expect(sala.instantanea().ex!.puente[1]).toBeGreaterThanOrEqual(0);
    expect(sala.instantanea().ex!.puente[2]).toBe(-1);
    expect(sala.eventos.some(e => e.tipo === "explosion" && e.motivo === "barranco")).toBe(true);
    interna.nuevaRonda(c.puente.s, 0);
    expect(sala.pista.huecos).toEqual([]);
    expect(sala.instantanea().ex).toEqual(crearEstadoExcavacion());
    for (const j of sala.jugadores.values()) {
      const s = proyectar(sala.pista, j.carro.x, j.carro.y).s;
      expect(Math.abs(s - c.puente.s)).toBeGreaterThan(c.puente.largo / 2 + 3);
    }
  });

  it("en espera no activa mecanismos y cambiar de mapa elimina su estado de la red", () => {
    const sala = salaNueva();
    sala.jugadores.get("a")!.carro = crearCarro(sala.pista, c.pala.placaS, c.pala.placaLateral);
    sala.paso();
    expect(sala.instantanea().ex).toEqual(crearEstadoExcavacion());
    expect(sala.cambiarCircuito("a", leer("hermosillo"))).toBeNull();
    expect(sala.instantanea().ex).toBeUndefined();
    expect(sala.pista.huecos).toBeUndefined();
  });
});
