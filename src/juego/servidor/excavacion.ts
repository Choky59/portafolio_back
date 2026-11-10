import type { EstadoCarro } from "../compartido/tipos";
import type { Pista } from "../compartido/pista";
import { circulosCarro, PARAMETROS_FISICA } from "../compartido/fisica";
import { apoyadoExcavacion, carrilPuente, crearEstadoExcavacion, fasePala, fasePuente, lateralPala, localExcavacion, sincronizarExcavacion } from "../compartido/excavacion";

interface Participante { id: string; carro: EstadoCarro; vivo: boolean }

/** Autoridad por sala: una activación por entrada, un impacto por barrido y reinicio por ronda. */
export class MecanicasExcavacion {
  estado = crearEstadoExcavacion();
  private enPlaca = new Set<string>();
  private anteriores = new Map<string, EstadoCarro>();
  private cruzando = new Map<string, { direccion: number; carril: number }>();
  private golpeados = new Set<string>();

  constructor(private readonly pista: Pista) {}

  reiniciar(): void {
    this.estado = crearEstadoExcavacion();
    this.enPlaca.clear(); this.anteriores.clear(); this.cruzando.clear(); this.golpeados.clear();
    if (this.pista.circuito.excavacion) this.pista.huecos = [];
  }

  actualizar(ahora: number, jugadores: Participante[]): Participante[] {
    const c = this.pista.circuito.excavacion;
    if (!c) return [];
    if (fasePala(c, this.estado, ahora).fase === "lista") this.estado.pala = -1;
    for (let i = 0; i < c.puente.carriles; i++) if (fasePuente(c, { ...this.estado, pasando: 0 }, ahora, i).fase === "listo") this.estado.puente[i] = -1;
    this.estado.pasando = 0;
    const placa = new Set<string>();
    const presentes = new Set(jugadores.filter(j => j.vivo).map(j => j.id));
    for (const id of this.anteriores.keys()) if (!presentes.has(id)) { this.anteriores.delete(id); this.cruzando.delete(id); }
    for (const j of jugadores) {
      if (!j.vivo) continue;
      const anterior = this.anteriores.get(j.id);
      this.anteriores.set(j.id, { ...j.carro });
      const p = localExcavacion(this.pista, c.pala.placaS, j.carro);
      if (apoyadoExcavacion(j.carro) && Math.abs(p.avance) < 2.5 && Math.abs(p.lateral - c.pala.placaLateral) < 1.7) {
        placa.add(j.id);
        if (!this.enPlaca.has(j.id) && this.estado.pala < 0) { this.estado.pala = ahora; this.golpeados.clear(); }
      }
      const limites = (carro: EstadoCarro) => {
        const v = circulosCarro(carro).map(q => localExcavacion(this.pista, c.puente.s, q).avance);
        return { min: Math.min(...v) - PARAMETROS_FISICA.radio, max: Math.max(...v) + PARAMETROS_FISICA.radio };
      };
      const actual = limites(j.carro), medio = c.puente.largo / 2;
      const k = carrilPuente(c, localExcavacion(this.pista, c.puente.s, j.carro).lateral);
      let cruce = this.cruzando.get(j.id);
      if (!cruce && anterior && k >= 0 && apoyadoExcavacion(j.carro) && apoyadoExcavacion(anterior)) {
        const previo = limites(anterior);
        const direccion = previo.max <= -medio && actual.max > -medio ? 1 : previo.min >= medio && actual.min < medio ? -1 : 0;
        if (direccion) {
          const a = direccion > 0 ? previo.max : previo.min;
          const b = direccion > 0 ? actual.max : actual.min;
          const t = Math.max(0, Math.min(1, (-direccion * medio - a) / (b - a || 1)));
          const latAntes = localExcavacion(this.pista, c.puente.s, anterior).lateral;
          const latAhora = localExcavacion(this.pista, c.puente.s, j.carro).lateral;
          const entrada = carrilPuente(c, latAntes + (latAhora - latAntes) * t);
          if (entrada >= 0) cruce = { direccion, carril: entrada };
        }
        if (cruce) this.cruzando.set(j.id, cruce);
      }
      if (!cruce) continue;
      const terminado = cruce.direccion > 0 ? actual.min > medio : actual.max < -medio;
      if (terminado && anterior) {
        const previo = limites(anterior);
        const a = cruce.direccion > 0 ? previo.min : previo.max;
        const b = cruce.direccion > 0 ? actual.min : actual.max;
        const t = Math.max(0, Math.min(1, (cruce.direccion * medio - a) / (b - a || 1)));
        const latAntes = localExcavacion(this.pista, c.puente.s, anterior).lateral;
        const latAhora = localExcavacion(this.pista, c.puente.s, j.carro).lateral;
        const salida = carrilPuente(c, latAntes + (latAhora - latAntes) * t);
        // Validar la salida completa, pero romper el carril guardado al entrar.
        if (salida >= 0 && this.estado.puente[cruce.carril] < 0) this.estado.puente[cruce.carril] = ahora;
        this.cruzando.delete(j.id);
        continue;
      }
      if (k < 0 || (cruce.direccion > 0 ? actual.max < -medio : actual.min > medio)) {
        this.cruzando.delete(j.id);
        continue;
      }
      this.estado.pasando |= 1 << cruce.carril;
    }
    this.enPlaca = placa;
    sincronizarExcavacion(this.pista, this.estado, ahora);
    const pala = fasePala(c, this.estado, ahora);
    if (pala.fase !== "barrido") return [];
    const lateral = lateralPala(this.pista, pala.progreso);
    return jugadores.filter(j => {
      if (!j.vivo || this.golpeados.has(j.id) || !apoyadoExcavacion(j.carro)) return false;
      const golpe = circulosCarro(j.carro).some(p => {
        const q = localExcavacion(this.pista, c.pala.s, p);
        // El contacto completo permanece fuera del carril interior seguro.
        return q.lateral < -0.2 && Math.abs(q.avance) < 1.2 + PARAMETROS_FISICA.radio && Math.abs(q.lateral - lateral) < 0.7 + PARAMETROS_FISICA.radio;
      });
      if (golpe) this.golpeados.add(j.id);
      return golpe;
    });
  }
}
