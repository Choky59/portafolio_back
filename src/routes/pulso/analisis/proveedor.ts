/**
 * The LLM behind the analysis, behind one small interface so it can be swapped
 * (another model, another provider, or a fake one in tests).
 * Gemini is the first implementation: JSON mode with a response schema.
 */
import { PULSO_MODELO_DEFAULT } from "../../../constants/pulso";

export interface IUso {
  entrada: number;
  salida: number;
  /** Calls that searched the web (Google Search grounding), billed apart */
  busquedas?: number;
}

export interface IProveedor {
  modelo: string;
  /** Answers JSON that follows `esquema` (still validated by the caller) */
  /** `buscar`: the model may search Google (for links to other outlets) */
  generar(params: { sistema: string; texto: string; esquema: object; pensar?: "low" | "medium" | "high"; buscar?: boolean }): Promise<{ datos: unknown; uso: IUso }>;
}

/**
 * `ajeno`: not the capture's fault (out of credit, provider down): the worker pauses
 * and tries later without counting a failed try. Otherwise the capture counts a failure.
 */
export class ErrorProveedor extends Error {
  constructor(message: string, readonly ajeno: boolean) {
    super(message);
  }
}

const URL_GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";
const REINTENTOS = 4;
const TIEMPO_LIMITE_MS = 5 * 60 * 1000; // a 3 h show is ~50k tokens in

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function crearGemini(apiKey: string, modelo = PULSO_MODELO_DEFAULT): IProveedor {
  return {
    modelo,
    async generar({ sistema, texto, esquema, pensar = "low", buscar = false }) {
      const cuerpo = {
        systemInstruction: { parts: [{ text: sistema }] },
        contents: [{ role: "user", parts: [{ text: texto }] }],
        ...(buscar ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: esquema,
          thinkingConfig: { thinkingLevel: pensar },
          temperature: 0.2,
        },
      };

      let ultimo = "";
      for (let intento = 0; intento < REINTENTOS; intento++) {
        let res: Response;
        try {
          res = await fetch(`${URL_GEMINI}/${modelo}:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(cuerpo),
            signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
          });
        } catch (err: any) {
          ultimo = `red: ${err?.message ?? err}`;
          await esperar(2 ** intento * 3000);
          continue;
        }

        // Rate limit / overloaded: wait and try again. Out of credit or bad request: stop.
        if (res.status === 429 || res.status >= 500) {
          ultimo = `Gemini ${res.status}`;
          await esperar(2 ** intento * 3000);
          continue;
        }
        const json: any = await res.json().catch(() => ({}));
        if (!res.ok) {
          // Bad key / no permission / out of credit: our setup, not the capture
          throw new ErrorProveedor(`Gemini ${res.status}: ${json?.error?.message ?? "sin detalle"}`, [401, 402, 403].includes(res.status));
        }

        const parte = json?.candidates?.[0]?.content?.parts?.find((p: any) => typeof p.text === "string");
        // No text (blocked, cut off): the capture's content, count it as a failure
        if (!parte) throw new ErrorProveedor(`Gemini sin respuesta (${json?.candidates?.[0]?.finishReason ?? "?"})`, false);
        const u = json.usageMetadata ?? {};
        return {
          datos: JSON.parse(parte.text),
          // Gemini doesn't say how many queries it ran: a searching call counts as one search
          uso: { entrada: u.promptTokenCount ?? 0, salida: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), ...(buscar ? { busquedas: 1 } : {}) },
        };
      }
      throw new ErrorProveedor(`Gemini no respondió tras ${REINTENTOS} intentos (${ultimo})`, true);
    },
  };
}

/** The provider set by the environment (GEMINI_API_KEY, PULSO_MODELO), or null if there's no key */
export function proveedorDelEntorno(): IProveedor | null {
  const key = process.env.GEMINI_API_KEY;
  return key ? crearGemini(key, process.env.PULSO_MODELO || PULSO_MODELO_DEFAULT) : null;
}
