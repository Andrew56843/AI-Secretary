# AI Secretary Platform

Portfolio MVP for a SaaS-style AI secretary service:

- frontend: React + TypeScript (`apps/web`)
- backend: Node.js + Express + TypeScript + Prisma (`apps/api`)
- database: PostgreSQL
- deployment: Docker Compose

## What this demo does

- user registration and login with JWT
- creates/updates an AI assistant profile
- reserves a phone number from a free pool
- stores and displays call logs

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
