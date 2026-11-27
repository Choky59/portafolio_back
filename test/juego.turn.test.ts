import { iceParaServidor, limpiarIce, olvidarIce, serviciosIce } from "../src/juego/servidor/canal";

/**
 * EL RELEVO TURN de Cloudflare para el canal rápido: las credenciales temporales se piden con la
 * llave (JUEGO_TURN_KEY_ID / JUEGO_TURN_TOKEN), se guardan, y si algo falla queda solo STUN.
 */

const RESPUESTA = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "usuario",
      credential: "clave",
    },
  ],
};

const fetchReal = global.fetch;
const entorno = { ...process.env };

afterEach(() => {
  global.fetch = fetchReal;
  process.env = { ...entorno };
  olvidarIce();
  jest.restoreAllMocks();
});

describe("the TURN relay (Cloudflare Realtime)", () => {
  it("cleans Cloudflare's list: no port 53 (browsers block it), nothing that isn't stun/turn", () => {
    const lista = limpiarIce([...RESPUESTA.iceServers, { urls: "http://malo" }, null]);
    expect(lista).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "usuario",
        credential: "clave",
      },
    ]);
    expect(limpiarIce("x")).toEqual([]);
  });

  it("the server (libjuice) gets the STUN and the UDP relays with their credentials", () => {
    expect(iceParaServidor(limpiarIce(RESPUESTA.iceServers))).toEqual([
      "stun:stun.cloudflare.com:3478",
      { hostname: "turn.cloudflare.com", port: 3478, username: "usuario", password: "clave", relayType: "TurnUdp" },
    ]);
  });

  it("without the key: only STUN, and it doesn't call Cloudflare", async () => {
    delete process.env.JUEGO_TURN_KEY_ID;
    delete process.env.JUEGO_TURN_TOKEN;
    const llamada = jest.fn();
    global.fetch = llamada as unknown as typeof fetch;
    expect(await serviciosIce()).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
    expect(llamada).not.toHaveBeenCalled();
  });

  it("with the key: asks once (POST with the token) and keeps the credentials", async () => {
    process.env.JUEGO_TURN_KEY_ID = "llave";
    process.env.JUEGO_TURN_TOKEN = "secreto";
    jest.spyOn(console, "info").mockImplementation(() => {});
    const llamada = jest.fn(async () => new Response(JSON.stringify(RESPUESTA), { status: 201 }));
    global.fetch = llamada as unknown as typeof fetch;
    const [a, b] = await Promise.all([serviciosIce(), serviciosIce()]);
    const c = await serviciosIce();
    expect(llamada).toHaveBeenCalledTimes(1);
    const [url, opciones] = llamada.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/llave/credentials/generate-ice-servers");
    expect(opciones.method).toBe("POST");
    expect((opciones.headers as Record<string, string>).Authorization).toBe("Bearer secreto");
    expect(a).toEqual(limpiarIce(RESPUESTA.iceServers));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("if Cloudflare fails: only STUN (the channel still tries direct, and Socket.IO is the backup)", async () => {
    process.env.JUEGO_TURN_KEY_ID = "llave";
    process.env.JUEGO_TURN_TOKEN = "malo";
    jest.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await serviciosIce()).toEqual([{ urls: "stun:stun.l.google.com:19302" }]);
  });
});
