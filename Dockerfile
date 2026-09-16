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

# gosu lets the entrypoint drop from root to an unprivileged user after fixing up volume
# permissions, without the signal-handling problems `su`/`sudo` have for a long-running process.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV DATA_DIR=/data
EXPOSE 8990

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8990)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Image starts as root; the entrypoint immediately chowns /data and re-execs as PUID:PGID.
ENTRYPOINT ["docker-entrypoint.sh"]
