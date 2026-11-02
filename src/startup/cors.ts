/**
 * The origins allowed to call this server (CORS_ORIGIN, comma separated). Its own module so the
 * game server can run alone (src/juego/servidorJuego.ts) without loading the API's routes.
 */
export function corsOrigins(): string[] {
    return (process.env.CORS_ORIGIN ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0)
}
