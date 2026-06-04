# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────────────
# Next.js standalone output (next.config.ts: output:'standalone') traces the
# minimal node_modules into .next/standalone, so the runtime image needs no
# `npm install`.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
ENV HUSKY=0 \
    NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
# COPY refreshes package-lock.json's mtime; bump the install marker so the
# mtime-based dependency-freshness preflight (scripts/check-deps.mjs, run as
# prebuild) still sees the install as current in the layered build.
RUN touch node_modules/.package-lock.json && npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
# ffmpeg from Debian provides HEVC demux + stream-copy + the fMP4 muxer — all
# this deployment needs, since HLS_ENCODER=passthrough does no transcoding.
# No NVIDIA/CUDA libraries: passthrough is pure stream-copy.
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HLS_ENCODER=passthrough \
    HIKCONNECT_BASE_URL=https://api.hik-connect.com \
    PORT=8080 \
    HOSTNAME=0.0.0.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Standalone server bundle + the static chunks it does not trace.
# (No public/ dir in this project, so nothing to copy there.)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 8080
CMD ["node", "server.js"]
