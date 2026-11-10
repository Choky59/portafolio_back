import type { EstadoCarro, Vec } from "./tipos";
import { puntoEnPista, type Pista } from "./pista";

/** Configuración exclusiva de Excavación; tiempos en segundos y distancias en metros. */
export interface ConfiguracionExcavacion {
  profundidad: number;
  pala: { s: number; placaS: number; placaLateral: number; aviso: number; barrido: number; retorno: number; recarga: number; empuje: number; deslizamiento: number };
  puente: { s: number; largo: number; carriles: number; anchoCarril: number; acceso: number; transicion: number; caida: number; abierto: number; reparacion: number; recarga: number; huecos: Vec[][]; zanja: Vec[] };
}

/** Inicios según el reloj de simulación del servidor; -1 significa sin activar. */
export interface EstadoExcavacion { pala: number; puente: number[]; pasando: number }
export type FasePala = "lista" | "aviso" | "barrido" | "retorno" | "recarga";
export type FasePuente = "listo" | "cruzando" | "caida" | "abierto" | "reparacion" | "recarga";
export const crearEstadoExcavacion = (): EstadoExcavacion => ({ pala: -1, puente: [-1, -1, -1, -1], pasando: 0 });

function etapa<T extends string>(desde: number, ahora: number, fases: [T, number][], libre: T): { fase: T; progreso: number } {
  if (desde < 0) return { fase: libre, progreso: 0 };
  let t = Math.max(0, ahora - desde);
  for (const [fase, segundos] of fases) {
    if (t < segundos - 1e-8) return { fase, progreso: Math.min(1, t / segundos) };
    t -= segundos;
  }
  return { fase: libre, progreso: 0 };
}

export function fasePala(c: ConfiguracionExcavacion, e: EstadoExcavacion, ahora: number) {
  const p = c.pala;
  return etapa<FasePala>(e.pala, ahora, [["aviso", p.aviso], ["barrido", p.barrido], ["retorno", p.retorno], ["recarga", p.recarga]], "lista");
}

export function fasePuente(c: ConfiguracionExcavacion, e: EstadoExcavacion, ahora: number, carril = 0) {
  const p = c.puente;
  const fase = etapa<FasePuente>(e.puente[carril] ?? -1, ahora, [["caida", p.caida], ["abierto", p.abierto], ["reparacion", p.reparacion], ["recarga", p.recarga]], "listo");
  return fase.fase === "listo" && (e.pasando & (1 << carril)) ? { fase: "cruzando" as const, progreso: 0 } : fase;
}

export function centroCarrilPuente(c: ConfiguracionExcavacion, carril: number): number {
  return (carril + 0.5 - c.puente.carriles / 2) * c.puente.anchoCarril;
}

export function carrilPuente(c: ConfiguracionExcavacion, lateral: number): number {
  const k = Math.floor(lateral / c.puente.anchoCarril + c.puente.carriles / 2);
  return k >= 0 && k < c.puente.carriles ? k : -1;
}

/** Ensanche local: no cambia el ancho del resto de la pista ni su línea central. */
export function mitadPuenteEn(pista: Pista, s: number): number {
  const p = pista.circuito.excavacion?.puente;
  if (!p) return pista.mitad;
  const ds = Math.abs(((s - p.s + pista.longitud * 1.5) % pista.longitud) - pista.longitud / 2);
  const t = Math.max(0, Math.min(1, (ds - p.largo / 2 - p.acceso) / p.transicion));
  const mezcla = 1 - t * t * (3 - 2 * t);
  return pista.mitad + (p.carriles * p.anchoCarril / 2 - pista.mitad) * mezcla;
}

/** Coordenadas respecto a un tramo. No busca ni modifica la trayectoria. */
export function localExcavacion(pista: Pista, s: number, p: { x: number; y: number }) {
  const centro = puntoEnPista(pista, s), c = Math.cos(centro.angulo), t = Math.sin(centro.angulo);
  return { avance: (p.x - centro.x) * c + (p.y - centro.y) * t, lateral: -(p.x - centro.x) * t + (p.y - centro.y) * c };
}

/** El cucharón barre únicamente el carril exterior; el interior permanece disponible. */
export function lateralPala(pista: Pista, progreso: number): number {
  return -pista.mitad - 1.4 + (pista.mitad + 0.5) * progreso;
}

export function sincronizarExcavacion(pista: Pista, estado: EstadoExcavacion, ahora: number): void {
  const c = pista.circuito.excavacion;
  if (!c) return;
  pista.huecos = c.puente.huecos.filter((_, i) => ["caida", "abierto", "reparacion"].includes(fasePuente(c, estado, ahora, i).fase));
}

/** Los bots reciben el mismo aviso que las personas, antes de que se abra el hueco. */
export function riesgosExcavacion(pista: Pista, e: EstadoExcavacion, ahora: number) {
  const c = pista.circuito.excavacion;
  const riesgos: { x: number; y: number; s: number; lateral: number; radio: number; fijo: boolean }[] = [];
  if (!c) return riesgos;
  const agregar = (s: number, lateral: number, radio: number) => riesgos.push({ ...puntoEnPista(pista, s, lateral), s, lateral, radio, fijo: true });
  for (let i = 0; i < c.puente.carriles; i++) {
    const puente = fasePuente(c, e, ahora, i).fase;
    if (!["cruzando", "caida", "abierto", "reparacion"].includes(puente)) continue;
    for (let d = -c.puente.largo / 2; d <= c.puente.largo / 2; d += 4) agregar(c.puente.s + d, centroCarrilPuente(c, i), c.puente.anchoCarril / 2);
  }
  const pala = fasePala(c, e, ahora).fase;
  if (pala === "aviso" || pala === "barrido") agregar(c.pala.s, -pista.mitad / 2, pista.mitad / 2);
  return riesgos;
}

export function apoyadoExcavacion(c: EstadoCarro): boolean { return c.z <= 0.3; }
