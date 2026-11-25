# Only the game server (src/juego/servidorJuego.ts), for the VM close to the players.
# Built from the repo root:  docker build -f deploy/juego/Dockerfile .

# Debian (glibc), not Alpine: node-datachannel (the WebRTC fast channel, src/juego/servidor/canal.ts)
# ships prebuilt binaries for glibc

# 1. Compile the TypeScript
FROM node:20-bookworm-slim AS compilar
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# 2. Run: production dependencies, the compiled code and the game's content (maps, items)
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=compilar /app/build ./build
COPY content/juego ./content/juego
USER node
EXPOSE 3000
# The WebRTC fast channel (JUEGO_RTC_PUERTO, one UDP port for every player)
EXPOSE 10000/udp
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/salud').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "build/juego/servidorJuego.js"]
