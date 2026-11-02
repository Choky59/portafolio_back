# Only the game server (src/juego/servidorJuego.ts), for the VM close to the players.
# Built from the repo root:  docker build -f deploy/juego/Dockerfile .

# 1. Compile the TypeScript
FROM node:20-alpine AS compilar
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# 2. Run: production dependencies, the compiled code and the game's content (maps, items)
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=compilar /app/build ./build
COPY content/juego ./content/juego
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/salud || exit 1
CMD ["node", "build/juego/servidorJuego.js"]
