# Codex Rules For This Repository

## Project Identity

- Product name: callsec.
- Public domain: callsec.ru.
- GitHub repository: Andrew56843/AI-Secretary.
- Local project root on Andrew's PC: D:\AI-Secretary.
- Main branch: main.

## Architecture

- `apps/web` is the React + TypeScript frontend.
- `apps/api` is the Node.js + Express + TypeScript backend with Prisma and PostgreSQL.
- `server.js` is the Asterisk AudioSocket voice service. Treat it as the call engine, not as the website frontend or the SaaS API.
- PostgreSQL is the source of truth for accounts, profiles, billing, integrations, call logs, and outbound contact state.
- `/home/andrew/ai/records` on the server stores call recordings used by the web/API deployment.

## Deployment

- The Coolify application `ai-secretary` serves callsec.ru and builds from this Git repository.
- Coolify currently deploys `web` and `api` from `docker-compose.server.yml`.
- The production containers should show `SOURCE_COMMIT` matching the latest pushed commit.
- The legacy voice service currently runs separately on the server as PM2 process `server` from `/home/andrew/ai/server.js`.
- Do not assume that pushing `server.js` to Git updates the live voice service until the PM2/Asterisk voice deployment is migrated to a Git-backed workflow.
- Do not containerize `server.js` casually: it calls host Asterisk commands and uses `/var/spool/asterisk/*`, so Docker needs an explicit migration plan.

## Workflow

- Work locally in `D:\AI-Secretary`.
- Before changing code, check `git status --short`.
- Keep changes scoped and explain server changes before applying them.
- Run relevant checks before pushing:
  - `npm run voice:check` for `server.js`.
  - `npm run lint` for web/API TypeScript checks.
  - `npm run build` before deployment-sensitive changes.
- Commit and push intentional changes to `origin main` so Coolify can deploy them.

## Secrets And Logs

- Never commit `.env`, tokens, API keys, proxy credentials, OAuth secrets, or Telegram bot tokens.
- Do not paste secret values into chat summaries or documentation.
- Server cleanup must not delete live project folders: `/home/andrew/mon`, `/home/andrew/moibike-crm`, `/home/andrew/ai`, `/home/andrew/tableGames`.
- Before deleting server files, list exact paths and sizes. Prefer removing old backup archives, old `.bak` files, and stale deploy logs only.

## Product Rules

- Callsec is a customer-facing multi-tenant AI secretary product, not a demo or a generic CRM.
- Keep Russian copy natural and concise.
- In call logs, user speech should remain visually stronger than assistant speech.
- Telegram transcripts should be sent once after call end, not as separate start/end noise.
- Google Calendar integration is intended to create, move, and cancel events when the user connects Google Calendar.
