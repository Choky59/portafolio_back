import { readFileSync } from "fs";
import path from "path";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import { GoogleAuth } from "google-auth-library";
import { productoDeTienda, maxBoletos, type ProductoDinero } from "../compartido/protocolo";
import { baseJuego, cuentas } from "./cuentas";
import { boletosAhora } from "./monedero";

/**
 * LAS COMPRAS CON DINERO (App Store y Google Play), sin terceros. La app paga en la tienda y manda
 * la prueba (iOS: el JWS firmado de StoreKit 2; Android: el purchaseToken). Aquí:
 *   1. Se verifica con Apple (la firma, con su certificado raíz) o con Google (su API)
 *   2. Se acredita en la cuenta UNA sola vez: cada compra queda en `juego_compras` con su id de
 *      tienda (no se puede usar la misma en dos cuentas) y en la cuenta (`compras`, para no
 *      acreditarla dos veces aunque lleguen dos peticiones juntas)
 *   3. Android: el servidor consume (consumibles) o reconoce (la boletera) la compra en Google; si
 *      no se hace en 3 días, Google la reembolsa. iOS: la app cierra la transacción al ver ok
 *
 * Variables:
 *   JUEGO_APPLE_BUNDLE_ID          el bundle id de la app (mx.jorgeandresgarcia.edgeracers si no se da)
 *   JUEGO_APPLE_APP_ID             el Apple ID numérico de la app (App Store Connect → Información
 *                                  de la app). Sin él solo se aceptan compras de Sandbox/TestFlight
 *   JUEGO_APPLE_SIN_SANDBOX=true   rechaza las compras de Sandbox (ojo: la revisión de Apple compra en Sandbox)
 *   JUEGO_GOOGLE_PAQUETE           el paquete de Android (el mismo bundle id si no se da)
 *   JUEGO_GOOGLE_CUENTA_SERVICIO   el JSON de la cuenta de servicio con acceso a Play Console
 */

const APP = "mx.jorgeandresgarcia.edgeracers";
const DIR_APPLE = path.resolve(__dirname, "../../../content/juego/apple");

/** Lo que dice la tienda de una compra ya verificada */
export interface CompraVerificada {
  /** Id único de la compra en esa tienda (con la plataforma delante: "apple:…", "google:…") */
  clave: string;
  producto: ProductoDinero;
  plataforma: "ios" | "android";
  /** Production / Sandbox (Apple); Production / Test (Google, compras de testers de licencia) */
  entorno: string;
  /** Solo Android: para consumirla o reconocerla después de acreditar */
  token?: string;
}

type Resultado<T> = ({ ok: true } & T) | { ok: false; error: string };

/* --------------------------------- Apple --------------------------------- */

let verificadoresApple: { entorno: Environment; v: SignedDataVerifier }[] | null = null;

function verificadoresDeApple() {
  if (verificadoresApple) return verificadoresApple;
  const raices = [readFileSync(path.join(DIR_APPLE, "AppleRootCA-G3.cer"))];
  const bundle = process.env.JUEGO_APPLE_BUNDLE_ID || APP;
  const appId = Number(process.env.JUEGO_APPLE_APP_ID) || undefined;
  const lista: { entorno: Environment; v: SignedDataVerifier }[] = [];
  if (appId) lista.push({ entorno: Environment.PRODUCTION, v: new SignedDataVerifier(raices, true, Environment.PRODUCTION, bundle, appId) });
  if (process.env.JUEGO_APPLE_SIN_SANDBOX !== "true") lista.push({ entorno: Environment.SANDBOX, v: new SignedDataVerifier(raices, true, Environment.SANDBOX, bundle) });
  verificadoresApple = lista;
  return lista;
}

/** Verifica el JWS de una transacción de StoreKit 2 (la firma de Apple, la app y el producto) */
async function verificarAppleReal(jws: string): Promise<Resultado<{ compra: CompraVerificada }>> {
  // El JWS dice en qué entorno se hizo; cada verificador acepta solo el suyo
  for (const { v } of verificadoresDeApple()) {
    let t;
    try {
      t = await v.verifyAndDecodeTransaction(jws);
    } catch {
      continue;
    }
    const producto = productoDeTienda(t.productId);
    if (!producto || !t.transactionId) return { ok: false, error: "Esa compra no es de este juego" };
    if (t.revocationDate) return { ok: false, error: "Esa compra fue reembolsada" };
    return { ok: true, compra: { clave: `apple:${t.transactionId}`, producto, plataforma: "ios", entorno: String(t.environment ?? "") } };
  }
  return { ok: false, error: "No se pudo verificar la compra con Apple" };
}

/* --------------------------------- Google --------------------------------- */

const API_GOOGLE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
let authGoogle: GoogleAuth | null = null;

function clienteGoogle(): GoogleAuth | null {
  if (authGoogle) return authGoogle;
  const json = process.env.JUEGO_GOOGLE_CUENTA_SERVICIO;
  if (!json) return null;
  authGoogle = new GoogleAuth({ credentials: JSON.parse(json), scopes: ["https://www.googleapis.com/auth/androidpublisher"] });
  return authGoogle;
}

const urlCompraGoogle = (producto: string, token: string) =>
  `${API_GOOGLE}/${encodeURIComponent(process.env.JUEGO_GOOGLE_PAQUETE || APP)}/purchases/products/${encodeURIComponent(producto)}/tokens/${encodeURIComponent(token)}`;

/** Lo que contesta purchases.products.get (solo lo que se usa) */
interface CompraGoogle {
  /** 0 pagada, 1 cancelada, 2 pendiente */
  purchaseState?: number;
  /** 0 sin consumir, 1 consumida */
  consumptionState?: number;
  /** 0 sin reconocer, 1 reconocida */
  acknowledgementState?: number;
  orderId?: string;
  /** 0: compra de prueba (tester de licencia) */
  purchaseType?: number;
}

/** Pregunta a Google por un purchaseToken */
async function verificarGoogleReal(tienda: string, token: string): Promise<Resultado<{ compra: CompraVerificada }>> {
  const producto = productoDeTienda(tienda);
  if (!producto) return { ok: false, error: "Esa compra no es de este juego" };
  const cliente = clienteGoogle();
  if (!cliente) return { ok: false, error: "Las compras de Google Play todavía no están activas" };
  let datos: CompraGoogle;
  try {
    datos = (await (await cliente.getClient()).request<CompraGoogle>({ url: urlCompraGoogle(tienda, token) })).data;
  } catch {
    return { ok: false, error: "No se pudo verificar la compra con Google" };
  }
  if (datos.purchaseState === 2) return { ok: false, error: "Tu pago está pendiente: llegará cuando Google lo confirme" };
  if (datos.purchaseState !== 0) return { ok: false, error: "Esa compra se canceló" };
  return {
    ok: true,
    compra: { clave: `google:${token}`, producto, plataforma: "android", entorno: datos.purchaseType === 0 ? "Test" : "Production", token },
  };
}

/** Consume (consumibles) o reconoce (la boletera) una compra de Google ya acreditada */
async function cerrarGoogleReal(compra: CompraVerificada): Promise<void> {
  const cliente = clienteGoogle();
  if (!cliente || !compra.token) return;
  const url = urlCompraGoogle(compra.producto.tienda, compra.token);
  const http = await cliente.getClient();
  const datos = (await http.request<CompraGoogle>({ url })).data;
  if (compra.producto.consumible) {
    if (datos.consumptionState !== 1) await http.request({ url: `${url}:consume`, method: "POST" });
  } else if (datos.acknowledgementState !== 1) {
    await http.request({ url: `${url}:acknowledge`, method: "POST", data: {} });
  }
}

/** Con quién se verifica (las pruebas lo cambian para no hablar con Apple ni con Google) */
export const tiendas = {
  verificarApple: verificarAppleReal,
  verificarGoogle: verificarGoogleReal,
  cerrarGoogle: cerrarGoogleReal,
};

/* --------------------------------- Acreditar --------------------------------- */

/** Una compra en `juego_compras` (el historial; _id = la clave de la tienda) */
export interface DocCompra {
  _id: string;
  uid: string;
  producto: string;
  plataforma: "ios" | "android";
  entorno: string;
  fecha: Date;
}

const SIN_BASE = { ok: false as const, error: "No se pudo conectar con las cuentas; intenta en un rato" };

/**
 * Acredita una compra verificada en la cuenta, una sola vez. `nueva: false` si ya se había
 * acreditado (la app volvió a mandarla porque no alcanzó a cerrar la transacción)
 */
export async function acreditar(uid: string, compra: CompraVerificada, ahora = Date.now()): Promise<Resultado<{ nueva: boolean }>> {
  const base = await baseJuego();
  const col = await cuentas();
  if (!base || !col) return SIN_BASE;
  const historial = base.collection<DocCompra>("juego_compras");
  const { clave, producto } = compra;

  // 1. El historial: la compra es de esta cuenta (si ya era de otra, no se acredita aquí)
  try {
    await historial.insertOne({ _id: clave, uid, producto: producto.id, plataforma: compra.plataforma, entorno: compra.entorno, fecha: new Date(ahora) });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    const ya = await historial.findOne({ _id: clave });
    if (ya && ya.uid !== uid) return { ok: false, error: "Esa compra ya se usó en otra cuenta" };
  }

  // 2. La cuenta: lo que da, y la clave en `compras` en la misma escritura (nunca dos veces)
  for (let i = 0; i < 5; i++) {
    const doc = await col.findOne({ _id: uid });
    if (doc?.compras?.includes(clave)) return { ok: true, nueva: false };
    const da = producto.da;
    const cambio: Record<string, unknown> = {};
    const quitar: Record<string, ""> = {};
    let sumar: Record<string, number> | null = null;
    if ("monedas" in da) sumar = { monedas: da.monedas };
    else if ("recarga" in da) {
      // Boletos llenos: la recarga ya no corre
      cambio.boletos = maxBoletos(doc?.boletera);
      quitar.recargaDesde = "";
    } else if (!doc?.boletera) {
      // La boletera: se queda con los que tiene ahora (con el tope de antes) y la recarga sigue
      // desde ahora hasta llenar los 10
      const b = boletosAhora(doc, ahora);
      cambio.boletera = true;
      cambio.boletos = b.cantidad;
      cambio.recargaDesde = new Date(b.desde ?? ahora);
    }
    const filtro = {
      _id: uid,
      compras: { $ne: clave },
      // Que nadie haya gastado un boleto en medio
      boletos: doc?.boletos === undefined ? { $exists: false } : doc.boletos,
      recargaDesde: doc?.recargaDesde === undefined ? { $exists: false } : doc.recargaDesde,
    };
    try {
      const r = await col.updateOne(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filtro as any,
        {
          ...(Object.keys(cambio).length ? { $set: cambio } : {}),
          ...(Object.keys(quitar).length ? { $unset: quitar } : {}),
          ...(sumar ? { $inc: sumar } : {}),
          $push: { compras: clave },
          $setOnInsert: { paquetes: [], creada: new Date(ahora) },
        },
        { upsert: !doc },
      );
      if (r.modifiedCount || r.upsertedCount) return { ok: true, nueva: true };
    } catch (e) {
      // Otra petición creó la cuenta en medio: se vuelve a leer
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  return { ok: false, error: "No se pudo acreditar la compra; intenta otra vez" };
}

/** Lo que manda la app (EVENTOS.validarCompra) */
export type PedidoCompra = { plataforma?: unknown; jws?: unknown; producto?: unknown; token?: unknown };

/**
 * Verifica y acredita lo que mandó la app. `producto` es el id de PRODUCTOS_DINERO (para el aviso);
 * ok también si ya se había acreditado, para que la app cierre la transacción
 */
export async function validarCompra(uid: string, pedido: PedidoCompra): Promise<Resultado<{ producto: string; nueva: boolean }>> {
  const v =
    pedido.plataforma === "ios" && typeof pedido.jws === "string" && pedido.jws.length < 20000
      ? await tiendas.verificarApple(pedido.jws)
      : pedido.plataforma === "android" && typeof pedido.producto === "string" && typeof pedido.token === "string" && pedido.token.length < 1000
        ? await tiendas.verificarGoogle(pedido.producto, pedido.token)
        : ({ ok: false, error: "Compra inválida" } as const);
  if (!v.ok) return v;
  const r = await acreditar(uid, v.compra);
  if (!r.ok) return r;
  if (v.compra.plataforma === "android") {
    // Si falla, la app la vuelve a mandar después (sigue sin cerrar en Google) y se reintenta aquí
    try {
      await tiendas.cerrarGoogle(v.compra);
    } catch (e) {
      console.error("[juego] no se pudo cerrar una compra en Google:", (e as Error).message);
    }
  }
  if (r.nueva) console.info(`[juego] compra acreditada: ${v.compra.producto.id} (${v.compra.plataforma}, ${v.compra.entorno})`);
  return { ok: true, producto: v.compra.producto.id, nueva: r.nueva };
}
