import { readdirSync, readFileSync } from "fs";
import type http from "http";
import path from "path";
import { Server, type Socket } from "socket.io";
import { corsOrigins } from "../../startup/cors";
import type { Circuito, Item } from "../compartido/tipos";
import {
  EVENTOS,
  VEHICULOS,
  normalizarCodigo,
  puedeUsar,
  sanearControles,
  sanearJugador,
  type DatosJugador,
  type Respuesta,
} from "../compartido/protocolo";
import { borrarCuenta, cuentaDe, paquetesDe, vehiculosDesbloqueados, verificarToken } from "./cuentas";
import { GestorSalas, type Sala } from "./salas";
import { METEORITO } from "./reglas";

/**
 * El juego en tiempo real: Socket.IO en el mismo servidor HTTP de Express, en su propio
 * namespace (/juego) para no mezclarse con la API.
 */

/** Same path from src/ (ts-jest) and build/ (node): <root>/content/juego */
const DIR_JUEGO = path.resolve(__dirname, "../../../content/juego");

type Ack = (r: Respuesta) => void;

export function iniciarJuego(server: http.Server) {
  // 60 por defecto: la mitad de espera al siguiente tick y de colchón en los navegadores que a 30
  const tickHz = Number(process.env.JUEGO_TICK_HZ) || 60;
  const maxSalas = Number(process.env.JUEGO_MAX_SALAS) || 50;
  const meta = Number(process.env.JUEGO_PUNTOS_VICTORIA) || 5;
  // Todos los mapas de content/juego/circuitos; quien crea la sala escoge uno
  const porDefecto = process.env.JUEGO_CIRCUITO || "hermosillo";
  const circuitos: Circuito[] = readdirSync(path.join(DIR_JUEGO, "circuitos"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(DIR_JUEGO, "circuitos", f), "utf8")));
  const items: Item[] = JSON.parse(readFileSync(path.join(DIR_JUEGO, "items.json"), "utf8"));

  const io = new Server(server, { serveClient: false, cors: { origin: corsOrigins() } });
  const juego = io.of("/juego");
  const gestor = new GestorSalas(circuitos, porDefecto, maxSalas, tickHz, meta, items);
  const relojes = new Map<string, NodeJS.Timeout>();
  /** id del socket → cómo sacarlo de su sala (para que el anfitrión pueda expulsar) */
  const salidas = new Map<string, () => void>();

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
        avisarPartida(sala);
      }, 1000 / tickHz / 2),
    );
  }

  function avisarSala(sala: Sala) {
    juego.to(sala.codigo).emit(EVENTOS.sala, sala.estado());
    avisarPartida(sala);
  }

  /** Eventos (explosiones, puntos…) y cambios de fase: estos sí deben llegar, nada de volatile */
  function avisarPartida(sala: Sala) {
    for (const evento of sala.eventos.splice(0)) juego.to(sala.codigo).emit(EVENTOS.evento, evento);
    if (!sala.cambioPartida) return;
    sala.cambioPartida = false;
    juego.to(sala.codigo).emit(EVENTOS.partida, sala.partida());
  }

  juego.on("connection", (socket: Socket) => {
    let sala: Sala | null = null;
    /**
     * Quién es: el token de Firebase viene en el `auth` de la conexión y se verifica una vez (null:
     * sin cuenta, como los navegadores del portafolio). Sus paquetes se leen al entrar a una sala
     */
    const quien = verificarToken(socket.handshake.auth?.token);

    /** El vehículo que pidió, si su cuenta lo tiene; si no, el de todos */
    async function vehiculoPermitido(jugador: DatosJugador): Promise<DatosJugador> {
      const pedido = jugador.vehiculo ?? VEHICULOS[0];
      if (pedido === VEHICULOS[0] || vehiculosDesbloqueados()) return jugador;
      const q = await quien;
      const paquetes = q ? await paquetesDe(q.uid).catch(() => []) : [];
      return { ...jugador, vehiculo: puedeUsar(pedido, paquetes) ? pedido : VEHICULOS[0] };
    }

    function salir() {
      if (!sala) return;
      const actual = sala;
      sala = null;
      socket.leave(actual.codigo);
      // La pantalla se fue: la sala local se cierra (los celulares ya no tienen dónde verse)
      if (actual.pantalla === socket.id) {
        juego.to(actual.codigo).emit(EVENTOS.cerrada);
        juego.in(actual.codigo).socketsLeave(actual.codigo);
        clearInterval(relojes.get(actual.codigo));
        relojes.delete(actual.codigo);
        gestor.borrar(actual.codigo);
        return;
      }
      actual.quitar(socket.id);
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
      ack({ ok: true, id: socket.id, sala: destino.estado(), partida: destino.partida() });
      avisarSala(destino);
    }

    socket.on(EVENTOS.crear, async (datos: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      const saneado = sanearJugador(datos);
      if ("error" in saneado) return (ack as Ack)({ ok: false, error: saneado.error });
      const jugador = await vehiculoPermitido(saneado);
      salir();
      const nueva = gestor.crear((datos as { circuito?: unknown } | null)?.circuito);
      if (!nueva) return (ack as Ack)({ ok: false, error: "Hay demasiadas salas abiertas; intenta en un rato" });
      arrancar(nueva);
      entrar(nueva, jugador, ack as Ack); // an empty room always has space
    });

    /** Modo local: esta compu es la pantalla que todos ven; los jugadores entran desde su celular */
    socket.on(EVENTOS.pantalla, (datos: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      salir();
      const nueva = gestor.crear((datos as { circuito?: unknown } | null)?.circuito);
      if (!nueva) return (ack as Ack)({ ok: false, error: "Hay demasiadas salas abiertas; intenta en un rato" });
      nueva.pantalla = socket.id;
      arrancar(nueva);
      sala = nueva;
      socket.join(nueva.codigo);
      (ack as Ack)({ ok: true, id: socket.id, sala: nueva.estado(), partida: nueva.partida() });
      avisarSala(nueva);
    });

    socket.on(EVENTOS.unirse, async (datos: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      const saneado = sanearJugador(datos);
      if ("error" in saneado) return (ack as Ack)({ ok: false, error: saneado.error });
      const jugador = await vehiculoPermitido(saneado);
      const codigo = normalizarCodigo((datos as { codigo?: unknown } | null)?.codigo);
      const destino = codigo ? gestor.buscar(codigo) : undefined;
      if (!destino) return (ack as Ack)({ ok: false, error: "No existe una sala con ese código" });
      if (destino === sala) return (ack as Ack)({ ok: true, id: socket.id, sala: destino.estado(), partida: destino.partida() });
      salir();
      entrar(destino, jugador, ack as Ack);
    });

    socket.on(EVENTOS.controles, (raw: unknown) => {
      const ctrl = sanearControles(raw);
      if (sala && ctrl) sala.recibirControles(socket.id, ctrl);
    });

    // La lista del lobby: salas con lugar (se puede pedir sin estar en ninguna)
    socket.on(EVENTOS.salas, (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack === "function") ack(gestor.abiertas());
    });

    // La cuenta con que se conectó y sus paquetes (null: sin cuenta)
    socket.on(EVENTOS.cuenta, async (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      const q = await quien;
      try {
        ack({ ok: true, cuenta: q ? await cuentaDe(q) : null });
      } catch {
        ack({ ok: false, error: "No se pudo leer tu cuenta; intenta en un rato" });
      }
    });

    // Borrar la cuenta: lo que el juego guarda de ella (la de Firebase la borra el propio jugador)
    socket.on(EVENTOS.borrarCuenta, async (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      const q = await quien;
      if (!q) return ack({ ok: false, error: "No entraste con una cuenta" });
      try {
        await borrarCuenta(q.uid);
        console.info("[juego] cuenta borrada");
        ack({ ok: true });
      } catch {
        ack({ ok: false, error: "No se pudo borrar tu cuenta; intenta en un rato" });
      }
    });

    // Ping real de ida y vuelta para el HUD: responde de inmediato
    socket.on(EVENTOS.ping, (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack === "function") ack();
    });

    socket.on(EVENTOS.empezar, (...args: unknown[]) => {
      const ack = args.at(-1);
      const error = sala ? sala.empezar(socket.id) : "No estás en una sala";
      if (sala) avisarPartida(sala);
      if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true });
    });

    /** Jugar solo o completar la sala: el anfitrión elige cuántos bots hay (en la sala de espera) */
    socket.on(EVENTOS.bots, (...args: unknown[]) => {
      const ack = args.at(-1);
      const responder = (error: string | null) =>
        typeof ack === "function" && ack(error ? { ok: false, error } : { ok: true });
      const cantidad = Number((args[0] as { cantidad?: unknown } | null)?.cantidad);
      if (!sala) return responder("No estás en una sala");
      if (socket.id !== sala.anfitrion) return responder("Solo quien creó la sala puede agregar bots");
      if (!sala.entrePartidas) return responder("Los bots se agregan entre partidas");
      if (!Number.isInteger(cantidad) || cantidad < 0) return responder("Cantidad inválida");
      let error: string | null = null;
      if (cantidad === 0) sala.quitarBots();
      const bots = () => sala!.estado().jugadores.filter((j) => j.bot);
      while (!error && bots().length < cantidad) error = sala.agregarBot();
      // Menos bots: se van los últimos que llegaron
      while (bots().length > cantidad) sala.quitar(bots().at(-1)!.id);
      avisarSala(sala);
      responder(bots().length < cantidad ? error : null);
    });

    /** Listo (o ya no) para la siguiente partida: lo ven todos; el anfitrión empieza */
    socket.on(EVENTOS.listo, (...args: unknown[]) => {
      const ack = args.at(-1);
      const listo = (args[0] as { listo?: unknown } | null)?.listo === true;
      const error = sala ? sala.marcarListo(socket.id, listo) : "No estás en una sala";
      if (sala) avisarSala(sala);
      if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true });
    });

    /** Entre partidas: { color } el propio; solo el anfitrión: { circuito } el mapa y { meta } las victorias */
    socket.on(EVENTOS.ajustes, (...args: unknown[]) => {
      const ack = args.at(-1);
      const datos = (args[0] ?? {}) as { color?: unknown; circuito?: unknown; meta?: unknown };
      let error: string | null = sala ? null : "No estás en una sala";
      if (sala && datos.color !== undefined) error = sala.cambiarColor(socket.id, datos.color);
      if (sala && !error && datos.meta !== undefined) error = sala.cambiarMeta(socket.id, datos.meta);
      if (sala && !error && datos.circuito !== undefined) {
        const circuito = gestor.circuito(datos.circuito);
        error = circuito.id === datos.circuito ? sala.cambiarCircuito(socket.id, circuito) : "Ese mapa no existe";
      }
      if (sala) avisarSala(sala);
      if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true });
    });

    /** Un espectador tira un meteorito: { x, y } en el piso */
    socket.on(EVENTOS.meteorito, (...args: unknown[]) => {
      const ack = args.at(-1);
      const datos = (args[0] ?? {}) as { x?: unknown; y?: unknown };
      const error = sala ? sala.lanzarMeteorito(socket.id, Number(datos.x), Number(datos.y)) : "No estás en una sala";
      if (sala) avisarPartida(sala);
      if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true, recargaMs: METEORITO.recarga * 1000 });
    });

    /** El anfitrión saca a alguien: a un bot se le quita; a una persona se le avisa y sale */
    socket.on(EVENTOS.expulsar, (...args: unknown[]) => {
      const ack = args.at(-1);
      const id = String((args[0] as { id?: unknown } | null)?.id ?? "");
      const error = sala ? sala.puedeExpulsar(socket.id, id) : "No estás en una sala";
      if (!error && sala) {
        if (sala.jugadores.get(id)!.mente) {
          sala.quitar(id);
          avisarSala(sala);
        } else {
          salidas.get(id)?.();
          juego.to(id).emit(EVENTOS.expulsado);
        }
      }
      if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true });
    });

    /**
     * Alguien reporta a otro jugador de su sala. Queda en el registro del servidor, sin datos de
     * la conexión: la sala, el nombre reportado y el motivo (`docker compose logs | grep reporte`).
     * Una vez por quien reporta y reportado en cada sala
     */
    socket.on(EVENTOS.reportar, (...args: unknown[]) => {
      const ack = args.at(-1);
      const datos = (args[0] ?? {}) as { id?: unknown; motivo?: unknown };
      const id = String(datos.id ?? "");
      const motivo = typeof datos.motivo === "string" ? datos.motivo.slice(0, 40) : "nombre";
      let error: string | null = null;
      const reportado = sala?.jugadores.get(id);
      if (!sala) error = "No estás en una sala";
      else if (id === socket.id) error = "No te puedes reportar a ti";
      else if (!reportado || reportado.mente) error = "Ese jugador ya no está";
      else if (!sala.reportes.has(`${socket.id}>${id}`)) {
        sala.reportes.add(`${socket.id}>${id}`);
        console.warn(
          `[juego] reporte ${JSON.stringify({ sala: sala.codigo, nombre: reportado.nombre, motivo, at: new Date().toISOString() })}`,
        );
      }
      if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true });
    });

    salidas.set(socket.id, salir);
    socket.on(EVENTOS.salir, salir);
    socket.on("disconnect", () => {
      salir();
      salidas.delete(socket.id);
    });
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
