# syntax=docker/dockerfile:1
# Moki — imagen multi-arquitectura (amd64 / arm64: Mac Apple Silicon, Raspberry Pi 4/5 de 64 bits).

# ---------- build: fuentes + bundle web, y después solo dependencias de producción ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN node scripts/build-fonts.mjs && npx vite build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---------- runtime ----------
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji fonts-dejavu-core ca-certificates \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    MOKI_HOST=0.0.0.0 \
    MOKI_PORT=7410 \
    MOKI_DATA_DIR=/data \
    MOKI_CHROMIUM_PATH=/usr/bin/chromium \
    MOKI_NO_SANDBOX=1 \
    NODE_OPTIONS=--max-old-space-size=768
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 7410
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7410/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server/index.ts"]
