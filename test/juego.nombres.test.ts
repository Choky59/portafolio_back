import { nombreOfensivo } from "../src/juego/compartido/nombres";
import { sanearJugador } from "../src/juego/compartido/protocolo";

describe("filtro de nombres", () => {
  it("blocks offensive names, also disguised", () => {
    for (const nombre of ["puto", "PENDEJO", "p3nd3jo", "xXpendejoXx", "puuuta", "p.e.n.d.e.j.o", "fuck you", "Hitler", "el culero", "putos"]) {
      expect([nombre, nombreOfensivo(nombre)]).toEqual([nombre, true]);
    }
  });

  it("lets normal names and words that only contain one through", () => {
    for (const nombre of ["Choki", "Computadora", "Pera", "Pola", "Vergara", "Ana", "Beto", "Disputa", "Jota", "Cono", "K", "Lupita", "Chuy"]) {
      expect([nombre, nombreOfensivo(nombre)]).toEqual([nombre, false]);
    }
  });

  it("rejects them when joining a room", () => {
    expect(sanearJugador({ nombre: "pendejo", color: "rojo" })).toEqual({ error: "Ese nombre no está permitido: elige otro" });
    expect(sanearJugador({ nombre: "Choki", color: "rojo" })).toEqual({ nombre: "Choki", color: "rojo" });
  });
});
