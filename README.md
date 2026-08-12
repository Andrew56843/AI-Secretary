# Callsec

Callsec is a multi-tenant AI phone secretary for inbound and outbound calls. Each account has its own prompts, greeting, voice, model, forwarding rules, balance, phone number, call history, contacts, Telegram delivery, and Google Calendar connection.

## Stack

- React 19, TypeScript, Vite and nginx
- Node.js 24, Express 5 and TypeScript
- PostgreSQL and Prisma ORM
- Asterisk AudioSocket voice service in `server.js`
- OpenAI Realtime API and post-call transcription
- Docker Compose for local and production web/API environments

## Repository

- `apps/web` - public site and customer dashboard
- `apps/api` - authentication, tenant data, billing, integrations and voice-service API
- `server.js` - Asterisk/OpenAI call engine
- `scripts` - focused voice-service tests and utilities
- `.codex/rules` - project and deployment rules for Codex sessions

PostgreSQL is the source of truth. The voice service must resolve every call through the API and an exact `AssistantProfile`; it has no shared demo-client fallback.

## Local Development

Use Node.js 24 (`.nvmrc`). Install dependencies and start the hot-reload Docker environment:

```bash
npm ci
npm run docker:dev:up
```

Development endpoints:

- web: `http://localhost:5173`
- API health: `http://localhost:14000/healthz`
- PostgreSQL: `localhost:15432`
- pgAdmin: `http://localhost:15050`

Copy `.env.example` to `.env` and provide local secrets when running services outside Docker. `npm run db:seed` is development-only, never deletes existing accounts, and can be customized with `SEED_OWNER_PHONE`, `SEED_OWNER_PASSWORD`, `SEED_OWNER_NAME`, and `SEED_RESERVED_NUMBERS`.

## Checks

```bash
npm run db:generate
npm run lint
npm test
npm run build
npm audit
```

Voice-only checks:

```bash
npm run voice:check
npm run voice:test
```

## Production

`docker-compose.server.yml` deploys the web and API services. The API runs `prisma migrate deploy` before it starts. The Asterisk voice service currently runs separately under PM2 because it needs host Asterisk commands and spool directories.

Create production secrets independently. In particular, do not reuse `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, or `VOICE_SERVICE_TOKEN`. Google OAuth tokens are encrypted with AES-256-GCM using `DATA_ENCRYPTION_KEY`; legacy encrypted values remain readable during key separation.

See [docs/PRODUCTION_CHECKLIST.md](docs/PRODUCTION_CHECKLIST.md) before accepting customers.

## Balance Top-ups

The dashboard shows manual SBP transfer details for Sber Bank. There is intentionally no payment-provider API or automatic crediting endpoint. An administrator verifies the transfer and records the corresponding balance adjustment.

## Tenant Isolation

Customer routes derive the owner from the verified JWT and scope profiles, contacts, calls, recordings, billing, and integrations to that user. The internal voice API uses a separate service token and bills the exact assistant profile used by the call. Password changes increment `authVersion`, revoking all older session tokens.

The current product intentionally provides one inbound and one outbound scenario per account. Supporting multiple simultaneous scenarios for one account is a separate product change because it requires number-to-profile routing and a dashboard scenario switcher.
