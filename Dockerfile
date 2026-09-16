# --- Build stage: compile native deps (better-sqlite3) ---
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev

# --- Runtime stage ---
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd -r artbridge && useradd -r -g artbridge artbridge

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data/cache /data/db && chown -R artbridge:artbridge /data /app
ENV DATA_DIR=/data

USER artbridge
EXPOSE 8990

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8990)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
