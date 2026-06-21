# AI Secretary Platform

Portfolio MVP for a SaaS-style AI secretary service:

- frontend: React + TypeScript (`apps/web`)
- backend: Node.js + Express + TypeScript + Prisma (`apps/api`)
- database: PostgreSQL
- deployment: Docker Compose
- payments: CloudTips redirect

## What this demo does

- user registration and login with JWT
- creates/updates an AI assistant profile
- reserves a phone number from a free pool
- stores and displays call logs
- serves pre-generated voice preview MP3 files from `apps/web/public/voice-previews`
- redirects balance top-ups to CloudTips with amount and user id
- connects Google Calendar through OAuth 2.0 and stores server-side tokens for future event automation

## Voice Service

The telephony voice service entrypoint is `server.js`.

On the Asterisk test stand it is deployed as:

```text
/home/andrew/ai/server.js
```

Local checks:

```bash
npm run voice:check
```

Local start, when the required telephony/OpenAI environment variables are present:

```bash
npm run voice:start
```

## Run with Docker

```bash
docker compose up --build
```

This is the production-like local environment:

- web: `http://localhost:8080`
- api health: `http://localhost:4000/healthz`
- postgres: `localhost:5432`
- pgAdmin: `http://localhost:5050`

Windows note for folders with non-ASCII path names:

```powershell
$env:DOCKER_BUILDKIT='0'
docker compose up --build -d
```

## Development Docker Environment

Use this mode while coding. Source files are mounted into containers, frontend uses Vite hot reload, and backend uses `tsx watch`.

```bash
npm run docker:dev:up
```

Development URLs:

- web: `http://localhost:5173`
- api health: `http://localhost:14000/healthz`
- postgres: `localhost:15432`
- pgAdmin: `http://localhost:15050`

Watch logs:

```bash
npm run docker:dev:logs
```

Stop dev environment:

```bash
npm run docker:dev:down
```

pgAdmin login:

- email: `admin@example.com`
- password: `admin`

Connect pgAdmin to PostgreSQL:

- host: `db`
- port: `5432`
- user: `postgres`
- password: `postgres`
- database: `ai_secretary`

Seed account:

- phone: `+79054176285`
- password: `123456`

## Payments

`/api/billing/top-up` validates the amount and returns a CloudTips payment link:

```text
https://pay.cloudtips.ru/p/73767f54?amount=[amount]&hideamount=true&userid=[userId]
```

CloudTips payments do not automatically credit the in-app balance yet.

## Google Calendar

Create an OAuth client in Google Cloud Console and add the app callback URL to Authorized redirect URIs:

```text
https://your-domain.example/api/integrations/google/oauth/callback
```

Required server environment variables:

```bash
PUBLIC_WEB_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
VITE_API_URL=
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=https://your-domain.example/api/integrations/google/oauth/callback
```

`VITE_API_URL` is intentionally empty in the container build: nginx proxies `/api/*` from the web container to the API service, so the browser can use the same domain for the site and backend.

## Local development

1. Copy env:

```bash
cp apps/api/.env.example apps/api/.env
```

2. Start PostgreSQL only:

```bash
docker compose up -d db
```

3. Run migrations and seed:

```bash
npm run db:migrate
npm run db:seed
```

Reset database to a clean development state:

```bash
npm run db:reset
```

4. Start apps:

```bash
npm run dev
```
