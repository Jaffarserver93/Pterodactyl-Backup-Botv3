# ── Stage 1: install dependencies ────────────────────────────────────────────
FROM node:24-slim AS deps

WORKDIR /app

COPY bot/package.json ./

# npm overrides pin es5-ext away from the malicious 0.10.64 release
RUN npm install --legacy-peer-deps

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-slim

WORKDIR /app

# Copy installed modules and source
COPY --from=deps /app/node_modules ./node_modules
COPY bot/package.json ./
COPY bot/src/ ./src/

# Render sets PORT automatically; default to 8080
ENV PORT=8080
EXPOSE 8080

# tsx runs TypeScript directly — no build step needed
CMD ["./node_modules/.bin/tsx", "src/backup-bot.ts"]
