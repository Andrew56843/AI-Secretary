FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json

RUN npm ci

COPY apps/api ./apps/api

RUN npm run db:generate --workspace @ai-secretary/api
RUN npm run build --workspace @ai-secretary/api

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api ./apps/api

EXPOSE 4000

CMD ["sh", "-c", "npm run db:deploy --workspace @ai-secretary/api && npm run db:seed --workspace @ai-secretary/api && npm run start --workspace @ai-secretary/api"]
