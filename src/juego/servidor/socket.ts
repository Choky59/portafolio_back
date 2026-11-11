import { readdirSync, readFileSync } from "fs";
import type http from "http";
import path from "path";
import { Server, type Socket } from "socket.io";
import { corsOrigins } from "../../startup/cors";
import type { Circuito, Item } from "../compartido/tipos";
import {
  EVENTOS,
  MAX_JUGADORES,
  META_MULTI,
  VEHICULOS,
  barraDeStickers,
  normalizarCodigo,
  puedeUsar,
  sanearControles,
  sanearProgreso,
  sanearJugador,
  stickersPropios,
  type DatosJugador,
  type Respuesta,
  type Vehiculo,
} from "../compartido/protocolo";
import { borrarCuenta, docDe, registrarCuenta, vehiculosDesbloqueados, verificarToken, type Quien } from "./cuentas";
import { comprarSticker, comprarVehiculo, cuentaDe, cuentaDesde, ponerBarraStickers, premiarCopa, premiarMulti, revisarBoleto, usarBoleto } from "./monedero";
import { validarCompra, type PedidoCompra } from "./compras";
import { GestorSalas, TUTORIAL, type Sala } from "./salas";
import { armarCopa, copaAbierta, nombreDeBot, tiemposDeBots, vehiculoDeBot, type CopaDatos } from "./montaje";
import { randomUUID } from "crypto";
import { DURACION } from "./reglas";
import { abrirSesionCopa, cerrarSesionCopa, sesiones } from "./sesiones";
import { METEORITO } from "./reglas";
import { CadenciaEstado, EmisorEscenario, estadoEscenario } from "../compartido/red";
import { precargarPistas } from "../compartido/pista";
import { procesarTicks } from "../compartido/metricas";
import { RendimientoServidor } from "./rendimiento";

/**
 * El juego en tiempo real: Socket.IO en el mismo servidor HTTP de Express, en su propio
 * namespace (/juego) para no mezclarse con la API.
 */

/** Same path from src/ (ts-jest) and build/ (node): <root>/content/juego */
const DIR_JUEGO = path.resolve(__dirname, "../../../content/juego");

type Ack = (r: Respuesta) => void;

/** El modo de pruebas del laboratorio (items fijos, circuitos ocultos): nunca en producción */
const modoPruebas = () => process.env.JUEGO_PRUEBAS === "true";


export function iniciarJuego(server: http.Server) {
  // 60 por defecto: la mitad de espera al siguiente tick y de colchón en los navegadores que a 30
  const tickHz = Number(process.env.JUEGO_TICK_HZ) || 60;
  const estadoHz = Math.min(tickHz, Math.max(1, Number(process.env.JUEGO_ESTADO_HZ) || 30));
  const maxSalas = Number(process.env.JUEGO_MAX_SALAS) || 50;
  const meta = Number(process.env.JUEGO_PUNTOS_VICTORIA) || 5;
  // Todos los mapas de content/juego/circuitos; quien crea la sala escoge uno
  const porDefecto = process.env.JUEGO_CIRCUITO || "hermosillo";
  const circuitos: Circuito[] = readdirSync(path.join(DIR_JUEGO, "circuitos"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(DIR_JUEGO, "circuitos", f), "utf8")));
  const items: Item[] = JSON.parse(readFileSync(path.join(DIR_JUEGO, "items.json"), "utf8"));
  // Las copas de la campaña: el servidor arma cada una y decide su resultado
  const copas: CopaDatos[] = JSON.parse(readFileSync(path.join(DIR_JUEGO, "copas.json"), "utf8"));
  precargarPistas(circuitos);

  const io = new Server(server, { serveClient: false, cors: { origin: corsOrigins() } });
  const juego = io.of("/juego");
  const gestor = new GestorSalas(circuitos, porDefecto, maxSalas, tickHz, meta, items);
  const relojes = new Map<string, () => void>();
  const rendimiento = new RendimientoServidor();
  /** id del socket → cómo sacarlo de su sala (para que el anfitrión pueda expulsar) */
  const salidas = new Map<string, () => void>();
  const emisores = new WeakMap<Sala, EmisorEscenario>();
  const grupoLigero = (sala: Sala) => `${sala.codigo}:red2`;
  /** id del socket → su cuenta (las salas multijugador cobran boletos y pagan premios) */
  const quienes = new Map<string, Quien>();
  /** Los bots que van a llegar a cada sala multijugador (por código) */
  const llegadas = new Map<string, Set<NodeJS.Timeout>>();
  const solicitaLigero = (datos: unknown) => (datos as { protocolo?: unknown } | null)?.protocolo === 2;

  function prepararObra(sala: Sala) {
    let emisor = emisores.get(sala);
    if (!emisor) emisores.set(sala, (emisor = new EmisorEscenario()));
    const obra = emisor.preparar(sala.pista, sala.tick);
    if (obra.cambio) juego.to(grupoLigero(sala)).emit(EVENTOS.escenario, obra.cambio);
    return obra;
  }

  /**
   * Cada sala tiene su propio reloj: simula los ticks que tocan y manda la instantánea.
   * setInterval no es exacto (en Windows tiene saltos de ~15 ms y suele correr más lento), así
   * que en cada vuelta se calcula cuántos ticks debieron pasar según el tiempo real y se pone
   * al corriente. Los controles mantienen su frecuencia física. La recuperación se reparte en
   * turnos cortos para atender sockets entre lotes, sin saltarse los ticks pendientes.
   */
  function arrancar(sala: Sala) {
    const inicio = performance.now();
    sala.estadoHz = estadoHz;
    const cadencia = new CadenciaEstado(estadoHz);
    let cerrado = false;
    let continuacion: NodeJS.Immediate | null = null;
    const correr = () => {
      if (cerrado || continuacion) return;
      const debidos = Math.floor(((performance.now() - inicio) / 1000) * tickHz);
      if (sala.tick >= debidos) return;
      const pendientes = procesarTicks(() => sala.tick, debidos, () => {
        const t = performance.now();
        sala.paso();
        rendimiento.registrarTick(sala, performance.now() - t);
      }, () => performance.now());
      rendimiento.pendientes(sala, pendientes);
      if (pendientes) {
        avisarPartida(sala);
        continuacion = setImmediate(() => { continuacion = null; correr(); });
        return;
      }
      if (cadencia.toca(performance.now() - inicio)) {
        const obra = prepararObra(sala);
        const inst = sala.instantanea(false);
        const ligeros = juego.adapter.rooms.get(grupoLigero(sala))?.size ?? 0;
        const total = juego.adapter.rooms.get(sala.codigo)?.size ?? 0;
        // Old installed clients retain their full construction snapshots.
        if (total > ligeros) juego.to(sala.codigo).except(grupoLigero(sala)).volatile.emit(EVENTOS.estado,
          { ...inst, ...(sala.circuito.terreno === "obra" ? { o: obra.todos } : {}) });
        if (ligeros) juego.to(grupoLigero(sala)).volatile.emit(EVENTOS.estado,
          { ...inst, od: true, ...(obra.activos.length ? { o: obra.activos } : {}) });
      }
      avisarPartida(sala);
    };
    const intervalo = setInterval(correr, 1000 / tickHz / 2);
    relojes.set(sala.codigo, () => {
      cerrado = true;
      clearInterval(intervalo);
      if (continuacion) clearImmediate(continuacion);
    });
  }

  /** Lo más que puede durar una partida local antes de que la sala vuelva sola a la sala de espera */
  const LOCAL_MAX_MS = 15 * 60 * 1000;

  function avisarSala(sala: Sala) {
    prepararObra(sala);
    juego.to(sala.codigo).emit(EVENTOS.sala, sala.estado());
    avisarPartida(sala);
  }

  /** Borra una sala: su reloj, los bots que iban a llegar y la sala */
  function cerrarSala(codigo: string) {
    relojes.get(codigo)?.();
    relojes.delete(codigo);
    cancelarBots(codigo);
    gestor.borrar(codigo);
  }

  /* --------------------------- El multijugador --------------------------- */

  /** Un bot de sala multijugador: su vehículo al azar (vehiculoDeBot) y un nametag como de persona */
  function botMulti(sala: Sala): string | null {
    // En las salas privadas solo juegan las personas que tienen el código
    if (sala.multi?.privada) return "En una sala privada no entran bots";
    return sala.agregarBot(0, false, false, vehiculoDeBot(), nombreDeBot([...sala.jugadores.values()].map((j) => j.nombre)));
  }

  function cancelarBots(codigo: string) {
    for (const t of llegadas.get(codigo) ?? []) clearTimeout(t);
    llegadas.delete(codigo);
  }

  /** Programa la llegada de bots a una sala multijugador (ms desde ahora, uno por cada tiempo) */
  function programarBots(sala: Sala, tiempos: number[]) {
    if (sala.multi?.privada) return;
    let pendientes = llegadas.get(sala.codigo);
    if (!pendientes) llegadas.set(sala.codigo, (pendientes = new Set()));
    for (const ms of tiempos) {
      const t = setTimeout(() => {
        pendientes!.delete(t);
        llegaBot(sala);
      }, ms);
      pendientes.add(t);
    }
  }

  /** Llega un bot (si sigue habiendo lugar, en la sala de espera); con la sala llena, empieza */
  function llegaBot(sala: Sala) {
    if (gestor.buscar(sala.codigo) !== sala || !sala.multi) return;
    if (sala.fase !== "espera" || sala.preparando || sala.local || sala.jugadores.size >= MAX_JUGADORES) return;
    botMulti(sala);
    avisarSala(sala);
    revisarArranque(sala);
  }

  /** Se liberó un lugar y ya no viene ningún bot: que llegue otro */
  function revisarHueco(sala: Sala) {
    if (!sala.multi || sala.fase !== "espera" || sala.preparando || sala.local || sala.jugadores.size >= MAX_JUGADORES) return;
    // Los lugares vacíos que ningún bot en camino va a llenar
    const faltan = MAX_JUGADORES - sala.jugadores.size - (llegadas.get(sala.codigo)?.size ?? 0);
    if (faltan > 0) programarBots(sala, Array.from({ length: faltan }, () => tiemposDeBots("hueco")[0]));
  }

  /** Las personas (no el anfitrión) que todavía no dicen "listo"; con `bots`, también los bots */
  function faltanListos(sala: Sala, bots = false): string[] {
    return sala.estado().jugadores.filter((j) => (bots || !j.bot) && !j.listo && j.id !== sala.anfitrion).map((j) => j.id);
  }

  /**
   * Si el anfitrión es una persona, la partida empieza cuando ella le da "Empezar ya". Si es un bot,
   * él "empieza" en cuanto la sala está llena y todos (personas y bots) dijeron que están listos
   */
  function revisarArranque(sala: Sala) {
    if (!sala.multi || sala.preparando || sala.local || sala.fase !== "espera" || sala.jugadores.size < MAX_JUGADORES) return;
    if (!sala.jugadores.get(sala.anfitrion)?.mente) return;
    if (faltanListos(sala, true).length) return;
    void prepararPartida(sala);
  }

  /**
   * Empieza la preparación de una partida multijugador y cobra un boleto a cada persona. A quien
   * ya no tenga, se le saca de la sala con el aviso, y su lugar lo toma un bot
   */
  async function prepararPartida(sala: Sala) {
    if (sala.empezarPreparacion()) return;
    cancelarBots(sala.codigo);
    avisarSala(sala);
    const personas = sala.estado().jugadores.filter((j) => !j.bot).map((j) => j.id);
    await Promise.all(
      personas.map(async (id) => {
        const q = quienes.get(id);
        const r = q ? await usarBoleto(q.uid).catch(() => ({ ok: false as const, error: "No se pudo usar el boleto" })) : { ok: false as const, error: "Entra con una cuenta para jugar en línea" };
        if (r.ok) {
          if (q) juego.to(id).emit(EVENTOS.cuentaCambio, { cuenta: await cuentaDe(q).catch(() => null) });
          return;
        }
        juego.to(id).emit(EVENTOS.expulsado, { motivo: r.error });
        salidas.get(id)?.();
      }),
    );
    // A quien se fue sin boleto nadie lo reemplaza: la partida ya está cerrada
  }

  /** Terminó una partida multijugador: a cada persona, las monedas de su lugar (una vez) */
  function pagarMulti(sala: Sala) {
    const m = sala.multi;
    if (!m || m.pagada || sala.fase !== "resultados") return;
    m.pagada = true;
    sala.lugaresFinales().forEach((id, i) => {
      const q = quienes.get(id);
      if (!q) return;
      premiarMulti(q.uid, i + 1)
        .then(async (r) => {
          if (!r.ok) return console.error("[juego] no se pudo premiar la partida:", r.error);
          juego.to(id).emit(EVENTOS.cuentaCambio, { cuenta: await cuentaDe(q), multi: r.resultado });
        })
        .catch((e) => console.error("[juego] no se pudo premiar la partida:", (e as Error).message));
    });
  }

  /**
   * Terminó la última pista de una copa: se guarda el resultado en la cuenta del dueño y se le
   * pagan las monedas que toquen (una sola vez), y se le avisa con su cuenta nueva
   */
  function premiar(sala: Sala) {
    const c = sala.copa;
    if (!c?.final || c.premiada) return;
    c.premiada = true;
    const { lugar, puntos } = c.final;
    premiarCopa(c.uid, c.id, c.dificil, lugar, puntos)
      .then(async (r) => {
        if (!r.ok) return console.error("[juego] no se pudo premiar la copa:", r.error);
        const doc = await docDe(c.uid);
        juego.to(c.dueno).emit(EVENTOS.cuentaCambio, {
          cuenta: cuentaDesde({ uid: c.uid, invitado: false }, doc),
          copa: r.resultado,
        });
      })
      .catch((e) => console.error("[juego] no se pudo premiar la copa:", (e as Error).message));
  }

  /** Eventos (explosiones, puntos…) y cambios de fase: estos sí deben llegar, nada de volatile */
  function avisarPartida(sala: Sala) {
    premiar(sala);
    pagarMulti(sala);
    for (const evento of sala.eventos.splice(0)) juego.to(sala.codigo).emit(EVENTOS.evento, evento);
    // Un bot dijo "listo" o todos volvieron a la sala de espera: la sala otra vez (y quizá ya se empieza)
    // Una sola persona: la partida corre en su navegador. Se le manda todo para armarla
    if (sala.localPorEmpezar && sala.local) {
      sala.localPorEmpezar = false;
      sala.local.sesion = randomUUID();
      sala.local.desde = Date.now();
      const { sesion, persona } = sala.local;
      juego.to(persona).emit(EVENTOS.local, {
        sesion,
        codigo: sala.codigo,
        circuito: sala.circuito.id,
        meta: sala.meta,
        // Cada bot con su agresividad: en el navegador juega igual que aquí
        jugadores: sala.estado().jugadores.map((j) => (j.bot ? { ...j, agresion: sala.jugadores.get(j.id)?.mente?.personalidad.detras } : j)),
        miId: persona,
      });
      // Si nunca manda su resultado, la sala no se queda atorada
      setTimeout(() => {
        if (sala.local?.sesion !== sesion) return;
        sala.terminarLocal();
        avisarSala(sala);
      }, LOCAL_MAX_MS);
    }
    // De vuelta en la sala de espera tras una partida: la mitad de los bots se va y llegan otros,
    // todos en a lo más 20 s (en una privada no hay bots)
    if (sala.rotacionPendiente) {
      sala.rotacionPendiente = false;
      // Pista aleatoria: en la siguiente partida sale otra
      if (sala.multi?.aleatoria) sala.cambiarCircuito(sala.anfitrion, gestor.aleatorio());
      if (sala.multi && !sala.multi.privada) {
        sala.rotarBots();
        const faltan = MAX_JUGADORES - sala.jugadores.size;
        if (faltan > 0) programarBots(sala, tiemposDeBots("sala").slice(0, faltan));
        sala.cambioJugadores = true;
      }
    }
    // Bots que se fueron hartos de esperar a que el anfitrión empezara: llegan otros (a lo más en 15 s)
    if (sala.botsHartos > 0) {
      const relevos = Array.from({ length: sala.botsHartos }, () => tiemposDeBots("relevo")[0]);
      sala.botsHartos = 0;
      programarBots(sala, relevos);
    }
    if (sala.cambioJugadores) {
      sala.cambioJugadores = false;
      juego.to(sala.codigo).emit(EVENTOS.sala, sala.estado());
      revisarArranque(sala);
    }
    if (!sala.cambioPartida) return;
    sala.cambioPartida = false;
    juego.to(sala.codigo).emit(EVENTOS.partida, sala.partida());
  }

  juego.on("connection", (socket: Socket) => {
    let sala: Sala | null = null;
    let ligero = false;
    /**
     * Quién es: el token de Firebase viene en el `auth` de la conexión y se verifica una vez (null:
     * sin cuenta, como los navegadores del portafolio). Sus paquetes se leen al entrar a una sala
     */
    const quien = verificarToken(socket.handshake.auth?.token);
    quien.then((q) => q && quienes.set(socket.id, q)).catch(() => undefined);

    /** Para entrar a una sala multijugador: con cuenta y al menos un boleto. Devuelve un error o null */
    async function puedeMulti(): Promise<string | null> {
      const q = await quien.catch(() => null);
      if (!q) return "Entra con una cuenta para jugar en línea";
      return revisarBoleto(q.uid).catch(() => "No se pudo leer tu cuenta; intenta en un rato");
    }
    // Queda registrada en la base del juego (si no se puede, se juega igual)
    quien
      .then((q) => q && registrarCuenta(q))
      .catch((e) => console.error("[juego] no se pudo registrar la cuenta:", (e as Error).message));

    /**
     * El vehículo que pidió, si su cuenta lo tiene (en un paquete, comprado con monedas o ganado en
     * la campaña); si no, el de todos
     */
    async function vehiculoPermitido(jugador: DatosJugador): Promise<DatosJugador> {
      const pedido = jugador.vehiculo ?? VEHICULOS[0];
      const q = await quien;
      const doc = q ? await docDe(q.uid).catch(() => null) : null;
      // La barra de stickers del festejo: la de la cuenta (sin cuenta, los gratis), nunca la que mande el cliente
      const stickers = barraDeStickers(doc?.barraStickers, stickersPropios(doc?.stickers));
      if (pedido === VEHICULOS[0] || vehiculosDesbloqueados()) return { ...jugador, stickers };
      return { ...jugador, stickers, vehiculo: puedeUsar(pedido, doc?.paquetes ?? [], doc?.progreso ?? {}, doc?.vehiculos ?? []) ? pedido : VEHICULOS[0] };
    }

    /**
     * Entrar a una copa de la campaña: con cuenta, la copa abierta (y su Difícil, si la pidió)
     * según el progreso del servidor y, solo en Difícil, un boleto, que se gasta aquí (Normal es
     * gratis: no paga monedas). Devuelve la copa o un error
     */
    async function prepararCopa(pedida: unknown, dificil: boolean): Promise<{ copa: CopaDatos; uid: string } | { error: string }> {
      const q = await quien;
      if (!q) return { error: "Entra con una cuenta para jugar la campaña" };
      const progreso = (await docDe(q.uid).catch(() => null))?.progreso ?? {};
      const abierta = copaAbierta(copas, pedida, dificil, progreso);
      if ("error" in abierta) return abierta;
      if (dificil) {
        const boleto = await usarBoleto(q.uid);
        if (!boleto.ok) return { error: boleto.error };
      }
      return { copa: abierta.copa, uid: q.uid };
    }

    /**
     * Solo en modo de pruebas (JUEGO_PRUEBAS=true, nunca en producción): entrar directo a la pista
     * `pista` (0, 1 o 2) de una copa en Difícil, sin cuenta, sin boleto y sin revisar el progreso.
     * No paga monedas ni guarda nada en la cuenta
     */
    async function copaDePrueba(pedida: unknown, pista: unknown): Promise<{ copa: CopaDatos; uid: string; pista: number } | { error: string } | null> {
      if (pista === undefined) return null;
      // Pedida sin el modo de pruebas: se rechaza (no se vaya a gastar un boleto en una copa normal)
      if (!modoPruebas()) return { error: "La pista directa solo funciona con JUEGO_PRUEBAS=true en el servidor" };
      if (typeof pista !== "number") return { error: "Esa pista no existe" };
      const copa = copas.find((c) => c.id === pedida);
      if (!copa || copa.pistas.length !== 3) return { error: "Esa copa no existe" };
      if (!Number.isInteger(pista) || pista < 0 || pista > 2) return { error: "Esa pista no existe" };
      return { copa, uid: (await quien)?.uid ?? "", pista };
    }

    function salir() {
      if (!sala) return;
      const actual = sala;
      sala = null;
      socket.leave(actual.codigo);
      socket.leave(grupoLigero(actual));
      ligero = false;
      // La pantalla se fue: la sala local se cierra (los celulares ya no tienen dónde verse)
      if (actual.pantalla === socket.id) {
        juego.to(actual.codigo).emit(EVENTOS.cerrada);
        juego.in(actual.codigo).socketsLeave(grupoLigero(actual));
        juego.in(actual.codigo).socketsLeave(actual.codigo);
        cerrarSala(actual.codigo);
        return;
      }
      actual.quitar(socket.id);
      if (actual.vacia) {
        cerrarSala(actual.codigo);
      } else {
        avisarSala(actual);
        revisarHueco(actual);
      }
    }

    function entrar(destino: Sala, jugador: DatosJugador, ack: Ack, compacto = false) {
      const error = destino.agregar(socket.id, jugador);
      if (error) return ack({ ok: false, error });
      sala = destino;
      socket.join(destino.codigo);
      ligero = compacto;
      if (ligero) socket.join(grupoLigero(destino));
      ack({ ok: true, id: socket.id, sala: destino.estado(), partida: destino.partida(),
        ...(ligero ? { obra: estadoEscenario(destino.pista, destino.tick) } : {}) });
      avisarSala(destino);
    }

    socket.on(EVENTOS.crear, async (datos: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      const saneado = sanearJugador(datos);
      if ("error" in saneado) return (ack as Ack)({ ok: false, error: saneado.error });
      const jugador = await vehiculoPermitido(saneado);
      // Una copa de la campaña: la arma el servidor (y en Difícil gasta el boleto)
      const pedida = (datos as { copa?: unknown } | null)?.copa;
      const dificil = (datos as { dificil?: unknown } | null)?.dificil === true;
      const prueba = pedida !== undefined ? await copaDePrueba(pedida, (datos as { pistaPrueba?: unknown } | null)?.pistaPrueba) : null;
      const enCopa = prueba ?? (pedida !== undefined ? await prepararCopa(pedida, dificil) : null);
      if (enCopa && "error" in enCopa) return (ack as Ack)({ ok: false, error: enCopa.error });
      // La de prueba arranca en la pista pedida, siempre en Difícil
      const inicio = prueba && !("error" in prueba) ? prueba.pista : 0;
      const enDificil = prueba ? true : dificil;
      salir();
      // El laboratorio puede correr también en los circuitos en preparación
      const pruebas = modoPruebas() && (datos as { pruebas?: unknown } | null)?.pruebas === true;
      // El tutorial (la primera vez que se juega): su pista, sus bots y sus tres lecciones (ver TUTORIAL)
      const tutorial = !enCopa && (datos as { tutorial?: unknown } | null)?.tutorial === true;
      // Multijugador: con cuenta y boleto; se llena con bots que llegan con el tiempo
      const multi = !enCopa && !tutorial && (datos as { multi?: unknown } | null)?.multi === true;
      if (multi) {
        const error = await puedeMulti();
        if (error) return (ack as Ack)({ ok: false, error });
        const pedido = (datos as { circuito?: unknown } | null)?.circuito;
        const nueva = gestor.crear(pedido === null || pedido === undefined ? gestor.aleatorio().id : pedido);
        if (!nueva) return (ack as Ack)({ ok: false, error: "Hay demasiadas salas abiertas; intenta en un rato" });
        nueva.multi = { privada: (datos as { privada?: unknown } | null)?.privada === true, partidas: 0, pagada: false, aleatoria: pedido === null || pedido === undefined };
        nueva.meta = META_MULTI;
        arrancar(nueva);
        entrar(nueva, jugador, ack as Ack, solicitaLigero(datos));
        programarBots(nueva, tiemposDeBots("sala"));
        return;
      }
      const nueva = gestor.crear(enCopa ? enCopa.copa.pistas[inicio] : tutorial ? TUTORIAL.circuito : (datos as { circuito?: unknown } | null)?.circuito, pruebas);
      if (!nueva) return (ack as Ack)({ ok: false, error: "Hay demasiadas salas abiertas; intenta en un rato" });
      arrancar(nueva);
      entrar(nueva, jugador, ack as Ack, solicitaLigero(datos)); // an empty room always has space
      if (tutorial) {
        nueva.prepararTutorial();
        avisarSala(nueva);
        return;
      }
      if (enCopa) {
        // Sus victorias y sus 3 bots. La de prueba nunca se premia (premiada desde el principio)
        armarCopa(nueva, enCopa.copa, { dueno: socket.id, uid: enCopa.uid, dificil: enDificil, inicio, premiada: !!prueba });
        avisarSala(nueva);
        if (prueba) return;
        // El boleto ya se gastó: la cuenta nueva
        const q = await quien;
        if (q) socket.emit(EVENTOS.cuentaCambio, { cuenta: await cuentaDe(q) });
      }
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
      ligero = solicitaLigero(datos);
      if (ligero) socket.join(grupoLigero(nueva));
      (ack as Ack)({ ok: true, id: socket.id, sala: nueva.estado(), partida: nueva.partida(),
        ...(ligero ? { obra: estadoEscenario(nueva.pista, nueva.tick) } : {}) });
      avisarSala(nueva);
    });

    /*
     * LA COPA EN LOCAL: el navegador la juega sin servidor. Aquí solo se gasta el boleto (al
     * entrar, solo en Difícil) y se cobra el premio (al terminar), con una sesión de por medio (sesiones.ts)
     */
    socket.on(EVENTOS.copaIniciar, async (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      const datos = (args[0] ?? {}) as { copa?: unknown; dificil?: unknown };
      try {
        const q = await quien;
        if (!q) return ack({ ok: false, error: "Entra con una cuenta para jugar la campaña" });
        // Sin base no hay dónde guardar la sesión: no se gasta el boleto
        if (!(await sesiones())) return ack({ ok: false, error: "No se pudo conectar con las cuentas; intenta en un rato" });
        const dificil = datos.dificil === true;
        const enCopa = await prepararCopa(datos.copa, dificil);
        if ("error" in enCopa) return ack({ ok: false, error: enCopa.error });
        const sesion = await abrirSesionCopa(q.uid, enCopa.copa.id, dificil);
        if (!sesion.ok) return ack({ ok: false, error: sesion.error });
        const cuenta = await cuentaDe(q);
        socket.emit(EVENTOS.cuentaCambio, { cuenta });
        ack({ ok: true, sesion: sesion.sesion, cuenta });
      } catch (e) {
        console.error("[juego] no se pudo abrir la copa:", (e as Error).message);
        ack({ ok: false, error: "No se pudo empezar la copa; intenta en un rato" });
      }
    });

    socket.on(EVENTOS.copaResultado, async (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      const datos = (args[0] ?? {}) as { sesion?: unknown; lugares?: unknown; yo?: unknown; vehiculo?: unknown };
      try {
        const q = await quien;
        if (!q) return ack({ ok: false, error: "Entra con una cuenta para cobrar la copa" });
        // El vehículo con que la corrió tiene que ser suyo
        if (datos.vehiculo !== undefined) {
          const permitido = await vehiculoPermitido({ nombre: "", color: "", vehiculo: datos.vehiculo as Vehiculo });
          if (permitido.vehiculo !== datos.vehiculo) return ack({ ok: false, error: "Ese vehículo no es tuyo", definitivo: true });
        }
        const cerrada = await cerrarSesionCopa(q.uid, datos.sesion, datos.lugares, datos.yo, copas);
        if (!cerrada.ok) return ack(cerrada);
        const r = await premiarCopa(q.uid, cerrada.copa, cerrada.dificil, cerrada.lugar, cerrada.puntos).catch((e) => ({ ok: false as const, error: (e as Error).message }));
        if (!r.ok) {
          // No se pudo pagar: la sesión se vuelve a abrir para que el navegador reintente
          await (await sesiones())?.updateOne({ _id: datos.sesion as string, uid: q.uid }, { $set: { estado: "abierta" }, $unset: { cerrada: "" } });
          console.error("[juego] no se pudo premiar la copa:", r.error);
          return ack({ ok: false, error: "No se pudo guardar el resultado de la copa; intenta en un rato" });
        }
        const cuenta = await cuentaDe(q);
        socket.emit(EVENTOS.cuentaCambio, { cuenta, copa: r.resultado });
        ack({ ok: true, cuenta, copa: r.resultado });
      } catch (e) {
        console.error("[juego] no se pudo cobrar la copa:", (e as Error).message);
        ack({ ok: false, error: "No se pudo cobrar la copa; intenta en un rato" });
      }
    });

    socket.on(EVENTOS.unirse, async (datos: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      const saneado = sanearJugador(datos);
      if ("error" in saneado) return (ack as Ack)({ ok: false, error: saneado.error });
      const jugador = await vehiculoPermitido(saneado);
      const codigo = normalizarCodigo((datos as { codigo?: unknown } | null)?.codigo);
      const destino = codigo ? gestor.buscar(codigo) : undefined;
      if (!destino) return (ack as Ack)({ ok: false, error: "No existe una sala con ese código" });
      if (destino.copa && destino !== sala) return (ack as Ack)({ ok: false, error: "Esa sala es de una copa de la campaña" });
      if (destino === sala) return (ack as Ack)({ ok: true, id: socket.id, sala: destino.estado(), partida: destino.partida(),
        ...(ligero ? { obra: estadoEscenario(destino.pista, destino.tick) } : {}) });
      if (destino.multi) {
        const error = await puedeMulti();
        if (error) return (ack as Ack)({ ok: false, error });
        // La sala pudo cerrarse mientras se leía la cuenta
        if (gestor.buscar(destino.codigo) !== destino) return (ack as Ack)({ ok: false, error: "No existe una sala con ese código" });
        // Ya le dieron "Empezar ya": la sala se cerró hasta que termine la partida
        if (destino.preparando || destino.local || destino.fase !== "espera") return (ack as Ack)({ ok: false, error: "Esa sala ya está en partida; intenta en un rato" });
      }
      salir();
      if (destino.multi && !destino.hacerLugar()) return (ack as Ack)({ ok: false, error: "La sala está llena" });
      entrar(destino, jugador, ack as Ack, solicitaLigero(datos));
      revisarArranque(destino);
    });

    /**
     * Terminó una partida local (la de una persona contra bots): { sesion, lugar }. Se paga su
     * lugar una vez, si dio tiempo de jugarla, y la sala vuelve a la sala de espera
     */
    socket.on(EVENTOS.multiResultado, async (...args: unknown[]) => {
      const ack = args.at(-1);
      const responder = (r: object) => typeof ack === "function" && ack(r);
      const datos = (args[0] ?? {}) as { sesion?: unknown; lugar?: unknown };
      const actual = sala;
      if (!actual?.local || actual.local.persona !== socket.id || actual.local.sesion !== datos.sesion || !actual.local.sesion) {
        return responder({ ok: false, error: "Esa partida ya terminó" });
      }
      const lugar = Number(datos.lugar);
      const total = actual.jugadores.size;
      // Lo menos que dura: la meta en rondas, cada una con su cuenta, la gracia y el festejo
      const minimo = actual.meta * (DURACION.cuenta + DURACION.gracia + DURACION.rondaFin) * 1000;
      const valido = Number.isInteger(lugar) && lugar >= 1 && lugar <= total && Date.now() - actual.local.desde >= minimo;
      actual.terminarLocal();
      avisarSala(actual);
      if (!valido) return responder({ ok: false, error: "El resultado de la partida no cuadra" });
      const q = quienes.get(socket.id);
      if (!q) return responder({ ok: false, error: "Entra con una cuenta para jugar en línea" });
      try {
        const r = await premiarMulti(q.uid, lugar);
        if (!r.ok) return responder({ ok: false, error: r.error });
        socket.emit(EVENTOS.cuentaCambio, { cuenta: await cuentaDe(q), multi: r.resultado });
        responder({ ok: true, resultado: r.resultado });
      } catch (e) {
        console.error("[juego] no se pudo premiar la partida local:", (e as Error).message);
        responder({ ok: false, error: "No se pudo guardar; intenta en un rato" });
      }
    });

    /**
     * PARTIDA RÁPIDA: a una sala multijugador pública que espera gente (con la pista pedida, o
     * cualquiera); si no hay, una nueva con un bot y los otros dos en camino
     */
    socket.on(EVENTOS.rapida, async (datos: unknown, ack: unknown) => {
      if (typeof ack !== "function") return;
      const saneado = sanearJugador(datos);
      if ("error" in saneado) return (ack as Ack)({ ok: false, error: saneado.error });
      const error = await puedeMulti();
      if (error) return (ack as Ack)({ ok: false, error });
      const jugador = await vehiculoPermitido(saneado);
      const pedido = (datos as { circuito?: unknown } | null)?.circuito;
      const circuito = typeof pedido === "string" && gestor.circuito(pedido).id === pedido ? pedido : null;
      salir();
      const destino = gestor.rapida(circuito);
      if (destino && destino.hacerLugar()) {
        entrar(destino, jugador, ack as Ack, solicitaLigero(datos));
        revisarArranque(destino);
        return;
      }
      const nueva = gestor.crear(circuito ?? gestor.aleatorio().id);
      if (!nueva) return (ack as Ack)({ ok: false, error: "Hay demasiadas salas abiertas; intenta en un rato" });
      nueva.multi = { privada: false, partidas: 0, pagada: false, aleatoria: circuito === null };
      nueva.meta = META_MULTI;
      arrancar(nueva);
      // La mitad de las veces la sala "la creó" el bot: entra primero y queda de anfitrión
      const botPrimero = Math.random() < 0.5;
      if (botPrimero) botMulti(nueva);
      entrar(nueva, jugador, ack as Ack, solicitaLigero(datos));
      // Si el anfitrión eres tú, el primero en unirse llega unos segundos después, como una persona
      if (!botPrimero) programarBots(nueva, tiemposDeBots("primero"));
      avisarSala(nueva);
      programarBots(nueva, tiemposDeBots("rapida"));
    });

    socket.on(EVENTOS.controles, (raw: unknown) => {
      const ctrl = sanearControles(raw);
      if (sala && ctrl) sala.recibirControles(socket.id, ctrl);
    });

    socket.on(EVENTOS.escenario, (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      ack(sala ? { ok: true, obra: estadoEscenario(sala.pista, sala.tick) } : { ok: false, error: "No estás en una sala" });
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

    /*
     * El progreso del modo campaña. Con cuenta manda el del SERVIDOR: lo escribe él al terminar cada
     * copa (premiar), y lo que traiga el teléfono ya no cuenta (las monedas dependen de él). Sin
     * cuenta, se queda en el teléfono
     */
    socket.on(EVENTOS.progreso, async (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      const q = await quien;
      if (!q) return ack({ ok: true, progreso: sanearProgreso((args[0] as { progreso?: unknown } | null)?.progreso) });
      try {
        ack({ ok: true, progreso: (await docDe(q.uid))?.progreso ?? {} });
      } catch {
        ack({ ok: false, error: "No se pudo leer tu avance; intenta en un rato" });
      }
    });

    // Laboratorio: un item fijo para tu carro ({ item: id o null }). Solo con JUEGO_PRUEBAS=true
    socket.on(EVENTOS.probarItem, (...args: unknown[]) => {
      const ack = args.at(-1);
      const responder = (r: object) => typeof ack === "function" && ack(r);
      if (!modoPruebas()) return responder({ ok: false, error: "El modo de pruebas está apagado (JUEGO_PRUEBAS=true en el servidor)" });
      if (!sala) return responder({ ok: false, error: "No estás en una sala" });
      const id = (args[0] as { item?: unknown } | null)?.item;
      if (id === null || id === undefined) {
        sala.itemsFijos.delete(socket.id);
        return responder({ ok: true });
      }
      const indice = items.findIndex((i) => i.id === id);
      if (indice < 0) return responder({ ok: false, error: "Ese item no existe" });
      sala.itemsFijos.set(socket.id, indice);
      // Ya: lo cambia aunque traiga otro
      const j = sala.jugadores.get(socket.id);
      if (j) j.item = indice;
      responder({ ok: true });
    });

    // Laboratorio: una trampa adelante de la salida en cada ronda ({ item: id o null, metros }). Solo con JUEGO_PRUEBAS=true
    socket.on(EVENTOS.ponerTrampa, (...args: unknown[]) => {
      const ack = args.at(-1);
      const responder = (r: object) => typeof ack === "function" && ack(r);
      if (!modoPruebas()) return responder({ ok: false, error: "El modo de pruebas está apagado (JUEGO_PRUEBAS=true en el servidor)" });
      if (!sala) return responder({ ok: false, error: "No estás en una sala" });
      const datos = (args[0] ?? {}) as { item?: unknown; metros?: unknown };
      if (datos.item === null || datos.item === undefined) {
        sala.trampaPrueba = null;
        return responder({ ok: true });
      }
      const indice = items.findIndex((i) => i.id === datos.item && i.categoria === "trampa");
      if (indice < 0) return responder({ ok: false, error: "Esa no es una trampa" });
      const metros = (Array.isArray(datos.metros) ? datos.metros : [40, 80, 120]).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n < 600).slice(0, 6);
      sala.trampaPrueba = { item: indice, metros };
      responder({ ok: true });
    });

    // Comprar un vehículo con monedas: { vehiculo }. Responde la cuenta nueva
    socket.on(EVENTOS.comprar, async (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      const q = await quien;
      if (!q) return ack({ ok: false, error: "Entra con una cuenta para comprar" });
      try {
        const pedido = (args[0] ?? {}) as { vehiculo?: unknown; sticker?: unknown };
        const r = pedido.sticker !== undefined ? await comprarSticker(q.uid, String(pedido.sticker)) : await comprarVehiculo(q.uid, String(pedido.vehiculo ?? ""));
        if (!r.ok) return ack({ ok: false, error: r.error });
        ack({ ok: true, cuenta: await cuentaDe(q) });
      } catch {
        ack({ ok: false, error: "No se pudo comprar; intenta en un rato" });
      }
    });

    // Una compra con dinero (App Store / Google Play): se verifica con la tienda y se acredita una vez
    socket.on(EVENTOS.validarCompra, async (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      const q = await quien;
      if (!q) return ack({ ok: false, error: "Entra con una cuenta para comprar" });
      if (q.invitado) return ack({ ok: false, error: "Entra con Google o Apple para comprar" });
      try {
        const r = await validarCompra(q.uid, (args[0] ?? {}) as PedidoCompra);
        if (!r.ok) return ack({ ok: false, error: r.error });
        ack({ ok: true, producto: r.producto, nueva: r.nueva, cuenta: await cuentaDe(q) });
      } catch (e) {
        console.error("[juego] error al validar una compra:", (e as Error).message);
        ack({ ok: false, error: "No se pudo validar la compra; intenta en un rato" });
      }
    });

    // La barra de stickers del festejo: { stickers }. Responde la cuenta nueva
    socket.on(EVENTOS.barraStickers, async (...args: unknown[]) => {
      const ack = args.at(-1);
      if (typeof ack !== "function") return;
      const q = await quien;
      if (!q) return ack({ ok: false, error: "Entra con una cuenta para elegir tus stickers" });
      try {
        const r = await ponerBarraStickers(q.uid, (args[0] as { stickers?: unknown } | null)?.stickers);
        if (!r.ok) return ack({ ok: false, error: r.error });
        // En una sala (la preparación de la copa): la barra nueva vale desde el siguiente festejo
        sala?.ponerBarra(socket.id, r.barra);
        ack({ ok: true, cuenta: await cuentaDe(q) });
      } catch {
        ack({ ok: false, error: "No se pudo guardar; intenta en un rato" });
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
      if (typeof ack === "function") {
        if ((args[0] as { metricas?: unknown } | null)?.metricas === true) ack({ servidor: rendimiento.resumen(sala) });
        else ack();
      }
    });

    socket.on(EVENTOS.empezar, (...args: unknown[]) => {
      const ack = args.at(-1);
      // Multijugador: "Empezar ya" completa la sala con bots y empieza la preparación
      if (sala?.multi) {
        let error: string | null = null;
        if (socket.id !== sala.anfitrion) error = "Solo quien creó la sala puede empezar";
        else if (sala.fase !== "espera" || sala.preparando) error = "La partida ya va a empezar";
        // Todos los que están (personas y bots) tienen que estar listos; los lugares vacíos los llenan bots
        else if (faltanListos(sala, true).length) error = "Todavía no están todos listos";
        else if (sala.jugadores.size < 2) error = "Se necesitan al menos 2 corredores";
        // Se juega con los que están (2, 3 o 4): desde aquí la sala ya no recibe a nadie
        else void prepararPartida(sala);
        if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true });
        return;
      }
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
      // Nivel de los bots (las copas lo suben), de 0 a 4
      const nivel = Math.max(0, Math.min(4, Math.round(Number((args[0] as { nivel?: unknown } | null)?.nivel) || 0)));
      // La campaña: cada bot con su personalidad (ver PERSONALIDADES en bots.ts)
      const personalidades = (args[0] as { personalidades?: unknown } | null)?.personalidades === true;
      // La copa en Difícil (ya ganada en 1º): bots que no frenan y con más motor
      const dificil = (args[0] as { dificil?: unknown } | null)?.dificil === true;
      if (!sala) return responder("No estás en una sala");
      if (socket.id !== sala.anfitrion) return responder("Solo quien creó la sala puede agregar bots");
      if (sala.multi) return responder("En línea los bots llegan solos");
      if (!sala.entrePartidas) return responder("Los bots se agregan entre partidas");
      if (!Number.isInteger(cantidad) || cantidad < 0) return responder("Cantidad inválida");
      // Los bots de una copa los pone el servidor al armarla
      if (sala.copa) return responder(cantidad === sala.estado().jugadores.filter((j) => j.bot).length ? null : "La copa ya tiene sus bots");
      let error: string | null = null;
      if (cantidad === 0) sala.quitarBots();
      const bots = () => sala!.estado().jugadores.filter((j) => j.bot);
      while (!error && bots().length < cantidad) error = sala.agregarBot(nivel, personalidades, dificil);
      // Menos bots: se van los últimos que llegaron
      while (bots().length > cantidad) sala.quitar(bots().at(-1)!.id);
      avisarSala(sala);
      responder(bots().length < cantidad ? error : null);
    });

    /** Listo (o ya no) para la siguiente partida: lo ven todos; el anfitrión empieza */
    socket.on(EVENTOS.listo, async (...args: unknown[]) => {
      const ack = args.at(-1);
      const listo = (args[0] as { listo?: unknown } | null)?.listo === true;
      // Multijugador: para decir que juegas hace falta un boleto (en la preparación ya se gastó)
      const sinBoleto = listo && sala?.multi && !sala.preparando ? await puedeMulti() : null;
      const error = sinBoleto ?? (sala ? sala.marcarListo(socket.id, listo) : "No estás en una sala");
      if (sala) {
        // En la preparación, "listo" es que ya escogió vehículo y stickers: si ya todas las personas
        // terminaron, la partida empieza de una vez
        if (!error && sala.multi && sala.preparando && !sala.estado().jugadores.some((j) => !j.bot && !j.listo)) sala.adelantarPreparacion();
        avisarSala(sala);
        revisarArranque(sala);
      }
      if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true });
    });

    /** El ganador de la ronda, en su festejo: { sticker } encima de su carro (lo ven todos) */
    socket.on(EVENTOS.sticker, (...args: unknown[]) => {
      const ack = args.at(-1);
      const sticker = (args[0] as { sticker?: unknown } | null)?.sticker;
      const error = sala ? sala.ponerSticker(socket.id, sticker) : "No estás en una sala";
      if (typeof ack === "function") ack(error ? { ok: false, error } : { ok: true });
    });

    /**
     * Entre partidas: { color } y { vehiculo } los propios (el vehículo, si su cuenta lo tiene);
     * solo el anfitrión: { circuito } el mapa y { meta } las victorias
     */
    socket.on(EVENTOS.ajustes, async (...args: unknown[]) => {
      const ack = args.at(-1);
      const datos = (args[0] ?? {}) as { color?: unknown; circuito?: unknown; meta?: unknown; vehiculo?: unknown };
      let error: string | null = sala ? null : "No estás en una sala";
      if (sala && datos.vehiculo !== undefined) {
        const existe = (VEHICULOS as readonly unknown[]).includes(datos.vehiculo);
        const permitido = existe ? (await vehiculoPermitido({ nombre: "", color: "", vehiculo: datos.vehiculo as Vehiculo })).vehiculo : null;
        // La cuenta se lee con await: para entonces pudo haber salido de la sala
        if (!sala) return typeof ack === "function" && ack({ ok: false, error: "No estás en una sala" });
        error = permitido && permitido === datos.vehiculo ? sala.cambiarVehiculo(socket.id, permitido) : "Ese vehículo no es tuyo";
      }
      if (sala && !error && datos.color !== undefined) error = sala.cambiarColor(socket.id, datos.color);
      if (sala && !error && datos.meta !== undefined) error = sala.cambiarMeta(socket.id, datos.meta);
      if (sala && !error && datos.circuito === null && sala.multi) {
        // Multijugador: "Aleatoria" (otra pista al azar, y en cada partida otra)
        error = sala.cambiarCircuito(socket.id, gestor.aleatorio());
        if (!error) sala.multi.aleatoria = true;
      } else if (sala && !error && datos.circuito !== undefined) {
        const circuito = gestor.circuito(datos.circuito);
        error = circuito.id === datos.circuito ? sala.cambiarCircuito(socket.id, circuito) : "Ese mapa no existe";
        if (!error && sala.multi) sala.multi.aleatoria = false;
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
          // Quedó un lugar: que siga llegando gente (otro bot)
          revisarHueco(sala);
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
      quienes.delete(socket.id);
    });
  });

  return {
    io,
    gestor,
    cerrar() {
      for (const parar of relojes.values()) parar();
      relojes.clear();
      for (const codigo of [...llegadas.keys()]) cancelarBots(codigo);
      rendimiento.cerrar();
      io.close();
    },
  };
}
