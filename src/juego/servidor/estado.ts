import { createHash, timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { RendimientoServidor } from "./rendimiento";
import type { Sala } from "./salas";

/**
 * EL ESTADO DEL SERVIDOR para la página de admin (/admin/status del portafolio): una foto en vivo
 * de las salas y del proceso, y una muestra cada `cadaMs` (5 s) de la última hora, en memoria
 * (se pierde al reiniciar). No guarda nombres: los jugadores salen por su color.
 */

/** Lo que el colector necesita del servidor del juego (socket.ts) */
export interface FuenteEstado {
  salas(): Sala[];
  /** La sala la simula el servidor (tiene reloj): las locales corren en el navegador */
  simulada(codigo: string): boolean;
  sockets(): number;
  /** El último ping que reportó ese jugador (ms), si su cliente lo manda */
  ping(idJugador: string): number | undefined;
  rendimiento: RendimientoServidor;
  tickHz: number;
  estadoHz: number;
}

export interface MuestraEstado {
  t: number;
  salas: number;
  simuladas: number;
  personas: number;
  bots: number;
  espectadores: number;
  sockets: number;
  /** El peor de las salas simuladas (ms por tick) */
  tickP95: number;
  tickMax: number;
  pendientes: number;
  bucleP95: number;
  bucleMax: number;
  cpu: number;
  rssMb: number;
  heapMb: number;
  pingP50: number | null;
  pingP95: number | null;
}

const red = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const mb = (bytes: number) => red(bytes / 1048576, 1);

function percentil(valores: number[], p: number): number | null {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.max(0, Math.ceil(orden.length * p) - 1)];
}

function tipoDe(s: Sala): string {
  if (s.local) return "local";
  if (s.copa) return "copa";
  if (s.tutorial) return "tutorial";
  if (s.multi) return s.multi.privada ? "privada" : "multi";
  if (s.pantalla) return "pantalla";
  return "sala";
}

export class ColectorEstado {
  private readonly historial: MuestraEstado[] = [];
  private readonly bucle = monitorEventLoopDelay({ resolution: 10 });
  private cpuAntes = process.cpuUsage();
  private relojAntes = performance.now();
  private readonly reloj: NodeJS.Timeout | null;

  constructor(
    private readonly fuente: FuenteEstado,
    private readonly capacidad = 720,
    cadaMs = 5000,
  ) {
    this.bucle.enable();
    this.reloj = cadaMs > 0 ? setInterval(() => this.muestrear(), cadaMs) : null;
    this.reloj?.unref();
  }

  /** Las salas ahora, con el costo de su tick y el ping de cada persona */
  private fotoSalas() {
    return this.fuente.salas().map((s) => {
      const simulada = this.fuente.simulada(s.codigo);
      const r = this.fuente.rendimiento.resumen(simulada ? s : null);
      const jugadores = [...s.jugadores.values()];
      return {
        codigo: s.codigo,
        circuito: s.circuito.id,
        tipo: tipoDe(s),
        fase: s.fase,
        simulada,
        personas: jugadores.filter((j) => !j.mente).length,
        bots: jugadores.filter((j) => j.mente).length,
        espectadores: s.espectadores.size,
        tick: simulada ? r.tick : null,
        pendientes: r.pendientes,
        cola: r.cola,
        pings: jugadores.filter((j) => !j.mente).map((j) => ({ color: j.color, ping: this.fuente.ping(j.id) ?? null })),
      };
    });
  }

  /** Toma una muestra del intervalo que terminó (la llama el reloj; pública para las pruebas) */
  muestrear(): MuestraEstado {
    const salas = this.fotoSalas();
    const simuladas = salas.filter((s) => s.simulada);
    const ahora = performance.now();
    const cpu = process.cpuUsage(this.cpuAntes);
    const transcurrido = Math.max(1, ahora - this.relojAntes);
    this.cpuAntes = process.cpuUsage();
    this.relojAntes = ahora;
    const memoria = process.memoryUsage();
    const pings = salas.flatMap((s) => s.pings.map((p) => p.ping)).filter((p): p is number => p !== null);
    const muestra: MuestraEstado = {
      t: Date.now(),
      salas: salas.length,
      simuladas: simuladas.length,
      personas: salas.reduce((n, s) => n + s.personas, 0),
      bots: salas.reduce((n, s) => n + s.bots, 0),
      espectadores: salas.reduce((n, s) => n + s.espectadores, 0),
      sockets: this.fuente.sockets(),
      tickP95: Math.max(0, ...simuladas.map((s) => s.tick?.p95 ?? 0)),
      tickMax: Math.max(0, ...simuladas.map((s) => s.tick?.max ?? 0)),
      pendientes: Math.max(0, ...simuladas.map((s) => s.pendientes)),
      bucleP95: red(this.bucle.percentile(95) / 1e6),
      bucleMax: red(this.bucle.max / 1e6),
      // user + system en µs contra el tiempo real en ms: % de un núcleo
      cpu: red(((cpu.user + cpu.system) / 1000 / transcurrido) * 100, 1),
      rssMb: mb(memoria.rss),
      heapMb: mb(memoria.heapUsed),
      pingP50: percentil(pings, 0.5),
      pingP95: percentil(pings, 0.95),
    };
    this.bucle.reset();
    this.historial.push(muestra);
    if (this.historial.length > this.capacidad) this.historial.splice(0, this.historial.length - this.capacidad);
    return muestra;
  }

  /** Lo que responde /admin/metricas: la foto en vivo y la última hora */
  resumen() {
    const memoria = process.memoryUsage();
    return {
      vivo: {
        t: Date.now(),
        uptime: Math.round(process.uptime()),
        node: process.version,
        tickHz: this.fuente.tickHz,
        estadoHz: this.fuente.estadoHz,
        sockets: this.fuente.sockets(),
        rssMb: mb(memoria.rss),
        heapMb: mb(memoria.heapUsed),
        ultima: this.historial.at(-1) ?? null,
        salas: this.fotoSalas(),
      },
      historial: [...this.historial],
    };
  }

  cerrar(): void {
    if (this.reloj) clearInterval(this.reloj);
    this.bucle.disable();
  }
}

/**
 * El servidor del juego de este proceso (el backend completo también lo corre): la ruta del API
 * lo lee cuando no hay JUEGO_STATUS_URL
 */
let local: ColectorEstado | null = null;
export const registrarEstadoLocal = (c: ColectorEstado | null) => void (local = c);
export const estadoLocal = () => local;

/** La clave del header x-juego-admin contra JUEGO_ADMIN_TOKEN (sin la variable, nunca) */
export function claveAdminValida(clave: unknown): boolean {
  const esperada = process.env.JUEGO_ADMIN_TOKEN;
  if (!esperada || typeof clave !== "string" || !clave) return false;
  const h = (t: string) => createHash("sha256").update(t, "utf8").digest();
  return timingSafeEqual(h(clave), h(esperada));
}
