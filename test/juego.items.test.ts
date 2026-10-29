import { readFileSync } from "fs";
import path from "path";
import { Circuito, Item } from "../src/juego/compartido/tipos";
import { Sala } from "../src/juego/servidor/salas";
import { sacarItem } from "../src/juego/servidor/items";
import { crearCarro, avanzarCarro, copiarCarro, PARAMETROS_FISICA } from "../src/juego/compartido/fisica";

const DIR = path.join(__dirname, "..", "content", "juego");
const base: Circuito = JSON.parse(readFileSync(path.join(DIR, "circuitos", "prueba.json"), "utf8"));
const ITEMS: Item[] = JSON.parse(readFileSync(path.join(DIR, "items.json"), "utf8"));
const HZ = 30;

function nuevaSala(items = ITEMS, cajas: [number, number][] = []) {
  const sala = new Sala("HMO-2222", { ...base, cajas }, HZ, 5, items, () => 0);
  sala.agregar("a", { nombre: "A", color: "rojo" });
  sala.agregar("b", { nombre: "B", color: "azul" });
  const j = (id: string) => sala.jugadores.get(id)!;
  // Both on the first straight: A at s = 20, B wherever each test puts it
  j("a").carro = crearCarro(sala.pista, 20);
  j("b").carro = crearCarro(sala.pista, 60);
  sala.paso();
  return { sala, j };
}

let seq = 0;
beforeEach(() => (seq = 0));

/** A presses the item key (one control, not moving) */
function usar(sala: Sala, idItem: string, items = ITEMS) {
  const a = sala.jugadores.get("a")!;
  a.item = items.findIndex((i) => i.id === idItem);
  sala.recibirControles("a", { seq: ++seq, giro: 0, acel: 0, freno: 0, mano: false, item: true });
}

/** A lets go of the item key (items fire on the press, so a new use needs a release first) */
function soltarTecla(sala: Sala) {
  sala.recibirControles("a", { seq: ++seq, giro: 0, acel: 0, freno: 0, mano: false, item: false });
}

function ticks(sala: Sala, n: number) {
  for (let i = 0; i < n; i++) sala.paso();
}

const golpes = (sala: Sala, id: string) => sala.eventos.filter((e) => e.tipo === "golpe" && e.id === id).length;

describe("item boxes", () => {
  it("gives a random item, switches off and comes back after a while", () => {
    const { sala, j } = nuevaSala(ITEMS, [[0, 0]]);
    const caja = sala.pista.circuito.cajas[0];
    Object.assign(j("a").carro, { x: caja[0], y: caja[1] });
    sala.paso();
    expect(j("a").item).toBe(0); // azar() = 0 → the first one
    expect(sala.eventos).toContainEqual({ tipo: "item", id: "a", item: 0 });
    expect(sala.instantanea().ci).toEqual([0]);
    ticks(sala, 8 * HZ);
    expect(sala.instantanea().ci).toEqual([]);
  });

  it("doesn't give a second item to someone who already has one", () => {
    const { sala, j } = nuevaSala(ITEMS, [[0, 0]]);
    j("a").item = 3;
    Object.assign(j("a").carro, { x: 0, y: 0 });
    sala.paso();
    expect(j("a").item).toBe(3);
    expect(sala.instantanea().ci).toEqual([]);
  });
});

describe("using items", () => {
  it("is used once per key press, and only if you have one", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "bache");
    expect(sala.entidades).toHaveLength(1);
    expect(j("a").item).toBe(-1);
    // Holding the key: no second use even with a new item
    j("a").item = 1;
    sala.recibirControles("a", { seq: ++seq, giro: 0, acel: 0, freno: 0, mano: false, item: true });
    expect(sala.entidades).toHaveLength(1);
  });

  it("Burro percherón chases the nearest rival ahead and spins it", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "burro");
    expect(sala.entidades[0].objetivo).toBe("b");
    ticks(sala, 60);
    expect(j("b").carro.aturdido).toBeGreaterThan(0);
    expect(golpes(sala, "b")).toBe(1);
    expect(sala.entidades).toHaveLength(0);
  });

  it("Bache: the first one to fall loses control; it stays and only deflects the next ones", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "bache");
    const { x, y } = sala.entidades[0];
    j("a").carro = crearCarro(sala.pista, 150); // out of the way: only the pothole touches B
    Object.assign(j("b").carro, { x, y, vx: 20, vy: 0, angulo: 0 });
    sala.paso();
    expect(j("b").carro.aturdido).toBeGreaterThan(0);
    expect(j("b").carro.vx).toBeCloseTo(20 * 0.45);
    expect(sala.entidades).toHaveLength(1); // still there

    // B again, on a fresh pass (it left and came back): now just a ~28° swerve, same speed
    Object.assign(j("b").carro, { x: x + 40, y, aturdido: 0 });
    sala.paso();
    Object.assign(j("b").carro, { x: x + 0.5, y: y - 1, vx: 20, vy: 0, angulo: 0 });
    sala.paso();
    const c = j("b").carro;
    expect(c.aturdido).toBe(0);
    expect(Math.abs(c.angulo)).toBeCloseTo((28 * Math.PI) / 180, 2);
    expect(Math.hypot(c.vx, c.vy)).toBeCloseTo(20, 5);
    // While it's still on it, nothing more happens
    const angulo = c.angulo;
    sala.paso();
    expect(c.angulo).toBe(angulo);
  });

  it("Charco makes you slide while you're in it, announcing it once", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "charco");
    const { x, y } = sala.entidades[0];
    Object.assign(j("b").carro, { x, y });
    ticks(sala, 10);
    expect(j("b").carro.resbalon).toBeGreaterThan(0);
    expect(golpes(sala, "b")).toBe(1);
  });

  it("Ola de calor slows down the rivals in front, not the ones behind", () => {
    const { sala, j } = nuevaSala();
    j("b").carro = crearCarro(sala.pista, 35);
    usar(sala, "calor");
    expect(j("b").carro.lento).toBeGreaterThan(0);

    const otra = nuevaSala();
    otra.j("b").carro = crearCarro(otra.sala.pista, 5);
    usar(otra.sala, "calor");
    expect(otra.j("b").carro.lento).toBe(0);
  });

  it("Humo de carne asada: the smoke lasts 10 s and leaves the grill (asador) behind, for good", () => {
    const { sala } = nuevaSala();
    usar(sala, "humo");
    const nube = sala.entidades[0];
    expect(ITEMS[nube.item].id).toBe("humo");
    ticks(sala, 10 * HZ - 5);
    expect(ITEMS[sala.entidades[0].item].id).toBe("humo");
    ticks(sala, 10);
    expect(sala.entidades).toHaveLength(1);
    const asador = sala.entidades[0];
    expect(ITEMS[asador.item].id).toBe("asador");
    expect([asador.x, asador.y]).toEqual([nube.x, nube.y]);
    ticks(sala, 60 * HZ);
    expect(sala.entidades).toContain(asador);
  });

  it("Charco stays on the road", () => {
    const { sala } = nuevaSala();
    usar(sala, "charco");
    ticks(sala, 60 * HZ);
    expect(sala.entidades).toHaveLength(1);
  });

  it("Poste de luz is solid: you can't drive through it, and it stays", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "poste");
    const poste = sala.entidades[0];
    j("a").carro = crearCarro(sala.pista, 150);
    // B comes at it fast, straight on
    Object.assign(j("b").carro, { x: poste.x - 6, y: poste.y, angulo: 0, vx: 30, vy: 0 });
    for (let i = 0; i < 20; i++) {
      sala.recibirControles("b", { seq: ++seq, giro: 0, acel: 1, freno: 0, mano: false, item: false });
      sala.paso();
    }
    expect(j("b").carro.x).toBeLessThan(poste.x);
    expect(sala.entidades).toContain(poste);
  });

  it("the grill never comes out of a box (only the smoke leaves it)", () => {
    const asador = ITEMS.findIndex((i) => i.id === "asador");
    for (let k = 0; k < 200; k++) expect(sacarItem(ITEMS, () => k / 200)).not.toBe(asador);
  });

  it("a new match starts with a clean road", () => {
    const { sala } = nuevaSala();
    usar(sala, "poste");
    expect(sala.entidades).toHaveLength(1);
    expect(sala.empezar("a")).toBeNull();
    expect(sala.entidades).toHaveLength(0);
  });

  it("between rounds what stays on the map stays, except what's on the starting grid", () => {
    const { sala } = nuevaSala();
    expect(sala.empezar("a")).toBeNull();
    const poner = (id: string, s: number) => {
      const p = crearCarro(sala.pista, s);
      const indice = ITEMS.findIndex((i) => i.id === id);
      const persiste = ITEMS[indice].persiste;
      sala.soltar({ item: indice, dueno: "a", x: p.x, y: p.y, angulo: 0, vx: 0, vy: 0, vida: persiste ? Infinity : 300, objetivo: null });
    };
    poner("poste", 300); // far down the road
    poner("charco", -10); // right on the grid
    poner("tope", 300); // doesn't stay
    (sala as any).nuevaRonda(0, 0);
    expect(sala.entidades.map((e) => ITEMS[e.item].id)).toEqual(["poste"]);
  });

  it("caps how many things stay on the map", () => {
    const { sala, j } = nuevaSala();
    for (let i = 0; i < 40; i++) {
      j("a").carro = crearCarro(sala.pista, 50 + i * 10);
      usar(sala, i % 2 ? "poste" : "charco");
      soltarTecla(sala);
      sala.paso();
      sala.paso();
    }
    expect(sala.entidades.length).toBe(30);
  });

  it("Tope stops you dead, once", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "tope");
    const { x, y } = sala.entidades[0];
    j("a").carro = crearCarro(sala.pista, 150); // out of the way: only the bump touches B
    Object.assign(j("b").carro, { x, y, vx: 30, vy: 0 });
    sala.paso();
    expect(j("b").carro.vx).toBeCloseTo(30 * 0.25);
    sala.paso();
    expect(j("b").carro.vx).toBeCloseTo(30 * 0.25);
  });

  it("Coyotas fly in a fan and push whoever they hit", () => {
    const { sala, j } = nuevaSala();
    j("b").carro = crearCarro(sala.pista, 30);
    usar(sala, "coyotas");
    expect(sala.entidades).toHaveLength(5);
    ticks(sala, 15);
    expect(Math.hypot(j("b").carro.vx, j("b").carro.vy)).toBeGreaterThan(5);
    expect(golpes(sala, "b")).toBeGreaterThanOrEqual(1);
  });

  it("El camión urbano is a strong turbo that shoves whoever is in front", () => {
    const { sala, j } = nuevaSala();
    const sinTurbo = copiarCarro(j("a").carro);
    usar(sala, "camion");
    expect(j("a").carro.turbo).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      sala.recibirControles("a", { seq: ++seq, giro: 0, acel: 1, freno: 0, mano: false, item: false });
      avanzarCarro(sinTurbo, { giro: 0, acel: 1, freno: 0, mano: false }, PARAMETROS_FISICA, sala.pista, 1 / HZ);
      sala.paso();
    }
    expect(Math.hypot(j("a").carro.vx, j("a").carro.vy)).toBeGreaterThan(Math.hypot(sinTurbo.vx, sinTurbo.vy) * 1.3);

    // Someone right in front gets thrown
    const frente = { x: j("a").carro.x + Math.cos(j("a").carro.angulo) * 3, y: j("a").carro.y + Math.sin(j("a").carro.angulo) * 3 };
    Object.assign(j("b").carro, { ...frente, vx: 0, vy: 0, aturdido: 0 });
    sala.paso();
    expect(Math.hypot(j("b").carro.vx, j("b").carro.vy)).toBeGreaterThan(10);
  });

  it("a new item made only in the config works with its own numbers", () => {
    const items: Item[] = [
      ...ITEMS,
      { id: "bache-grande", nombre: "Bachezote", descripcion: "", mecanica: "mina", probabilidad: 1, color: "#000", radio: 6, vida: 10, duracion: 2, fuerza: 0.1 },
    ];
    const { sala, j } = nuevaSala(items);
    usar(sala, "bache-grande", items);
    const { x, y } = sala.entidades[0];
    // 6 m away: a regular bache (radius 2) would miss, this one doesn't
    Object.assign(j("b").carro, { x: x + 6, y, vx: 20, vy: 0 });
    sala.paso();
    expect(j("b").carro.aturdido).toBe(2 * HZ);
    expect(j("b").carro.vx).toBeCloseTo(2);
  });

  it("a new round clears the road and everybody's items", () => {
    const { sala, j } = nuevaSala();
    usar(sala, "bache");
    j("b").item = 2;
    expect(sala.empezar("a")).toBeNull();
    expect(sala.entidades).toHaveLength(0);
    expect(j("b").item).toBe(-1);
  });
});
