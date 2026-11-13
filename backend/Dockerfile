# Build context is the repo root:  docker build -f backend/Dockerfile .
FROM node:22-slim AS build
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/package*.json ./
RUN npm install --no-audit --no-fund
COPY backend/ .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Applies committed migrations. If none have been generated yet (fresh clone), falls back to
# `db push` so the first boot still creates the schema. Commit migrations for real deployments.
CMD ["sh", "-c", "if ls prisma/migrations/*/migration.sql >/dev/null 2>&1; then npx prisma migrate deploy; else npx prisma db push --skip-generate; fi && node dist/server.js"]
