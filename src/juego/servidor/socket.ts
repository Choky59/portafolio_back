import { readFileSync } from "fs";
import type http from "http";
import path from "path";
import { Server, type Socket } from "socket.io";
import { corsOrigins } from "../../startup/routes";
import type { Circuito } from "../compartido/tipos";
import {
  EVENTOS,
  normalizarCodigo,
  sanearControles,
  sanearJugador,
  type DatosJugador,
  type Respuesta,
} from "../compartido/protocolo";
import { GestorSalas, type Sala } from "./salas";

/**
 * El juego en tiempo real: Socket.IO en el mismo servidor HTTP de Express, en su propio
 * namespace (/juego) para no mezclarse con la API.
 */

/** Same path from src/ (ts-jest) and build/ (node): <root>/content/juego */
const DIR_JUEGO = path.resolve(__dirname, "../../../content/juego");

type Ack = (r: Respuesta) => void;

export function iniciarJuego(server: http.Server) {
  const tickHz = Number(process.env.JUEGO_TICK_HZ) || 30;
  const maxSalas = Number(process.env.JUEGO_MAX_SALAS) || 50;
  const idCircuito = process.env.JUEGO_CIRCUITO || "prueba";
  const circuito: Circuito = JSON.parse(readFileSync(path.join(DIR_JUEGO, "circuitos", `${idCircuito}.json`), "utf8"));

  const io = new Server(server, { serveClient: false, cors: { origin: corsOrigins() } });
  const juego = io.of("/juego");
  const gestor = new GestorSalas(circuito, maxSalas, tickHz);
  const relojes = new Map<string, NodeJS.Timeout>();

  /**
   * Cada sala tiene su propio reloj: simula los ticks que tocan y manda la instantánea.
   * setInterval no es exacto (en Windows tiene saltos de ~15 ms y suele correr más lento), así
   * que en cada vuelta se calcula cuántos ticks debieron pasar según el tiempo real y se pone
   * al corriente. Si el servidor corriera más lento que los navegadores (que mandan 30 controles
   * por segundo exactos), sus créditos no alcanzarían, la cola se llenaría y se tirarían controles.
   */
  function arrancar(sala: Sala) {
    const inicio = performance.now();
    relojes.set(
      sala.codigo,
      setInterval(() => {
        const debidos = Math.floor(((performance.now() - inicio) / 1000) * tickHz);
        if (sala.tick >= debidos) return;
        while (sala.tick < debidos) sala.paso();
        // volatile: si un cliente va atrasado se le salta una instantánea en vez de encolarla
        juego.to(sala.codigo).volatile.emit(EVENTOS.estado, sala.instantanea());
      }, 1000 / tickHz / 2),
    );
  }

  function avisarSala(sala: Sala) {
    juego.to(sala.codigo).emit(EVENTOS.sala, sala.estado());
  }

  juego.on("connection", (socket: Socket) => {
    let sala: Sala | null = null;

    function salir() {
      if (!sala) return;
      const actual = sala;
      sala = null;
      actual.quitar(socket.id);
      socket.leave(actual.codigo);
      if (actual.vacia) {
        clearInterval(relojes.get(actual.codigo));
        relojes.delete(actual.codigo);
        gestor.borrar(actual.codigo);
      } else {
        avisarSala(actual);
      }
    }

    function entrar(destino: Sala, jugador: DatosJugador, ack: Ack) {
      const error = destino.agregar(socket.id, jugador);
      if (error) return ack({ ok: false, error });
      sala = destino;
      socket.join(destino.codigo);
      ack({ ok: true, id: socket.id, sala: destino.estado() });
      avisarSala(destino);
    }

    socket.on(EVENTOS.crear, (datos: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      const jugador = sanearJugador(datos);
      if ("error" in jugador) return (ack as Ack)({ ok: false, error: jugador.error });
      salir();
      const nueva = gestor.crear();
      if (!nueva) return (ack as Ack)({ ok: false, error: "Hay demasiadas salas abiertas; intenta en un rato" });
      arrancar(nueva);
      entrar(nueva, jugador, ack as Ack); // an empty room always has space
    });

    socket.on(EVENTOS.unirse, (datos: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      const jugador = sanearJugador(datos);
      if ("error" in jugador) return (ack as Ack)({ ok: false, error: jugador.error });
      const codigo = normalizarCodigo((datos as { codigo?: unknown } | null)?.codigo);
      const destino = codigo ? gestor.buscar(codigo) : undefined;
      if (!destino) return (ack as Ack)({ ok: false, error: "No existe una sala con ese código" });
      if (destino === sala) return (ack as Ack)({ ok: true, id: socket.id, sala: destino.estado() });
      salir();
      entrar(destino, jugador, ack as Ack);
    });

    socket.on(EVENTOS.controles, (raw: unknown) => {
      const ctrl = sanearControles(raw);
      if (sala && ctrl) sala.recibirControles(socket.id, ctrl);
    });

    // Ping real de ida y vuelta para el HUD: responde de inmediato
    socket.on(EVENTOS.ping, (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack === "function") ack();
    });

    socket.on(EVENTOS.salir, salir);
    socket.on("disconnect", salir);
  });

  return {
    io,
    gestor,
    cerrar() {
      for (const reloj of relojes.values()) clearInterval(reloj);
      relojes.clear();
      io.close();
    },
  };
}
