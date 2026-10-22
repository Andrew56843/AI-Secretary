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

- Current production host: `83.217.203.61`, Ubuntu 24.04. Source checkout: `/opt/callsec`.
- `docker-compose.restore.yml` deploys PostgreSQL, API, web and Caddy HTTPS. The old Coolify compose remains for reference.
- The production containers should show `SOURCE_COMMIT` matching the latest pushed commit.
- The host voice service is systemd `callsec-voice`, running `/opt/callsec/server.js` from the same Git checkout.
- Pushing Git alone does not deploy. Pull the intended commit, rebuild changed containers and restart `callsec-voice` when voice source changes.
- Production secrets are in `/etc/callsec` and the ignored `/opt/callsec/.env`; recovery copies on the PC are outside Git in `D:\Callsec-Private`.
- Novofon uses verified SIP TLS port 5061; Timeweb blocks port 5060. See `deploy/asterisk`.
- Both `+79952225212` and `+79952225213` belong to the rental pool; `52-12` is assigned to the owner's inbound profile.
- `52-12` also verifies registration/recovery: intercept only an incoming call from the exact caller with an unexpired pending request. Other calls use the normal AI profile.
- Do not containerize `server.js` casually: it calls host Asterisk commands and uses `/var/spool/asterisk/*`, so Docker needs an explicit migration plan.

## Workflow

- Work locally in `D:\AI-Secretary`.
- Before changing code, check `git status --short`.
- Keep changes scoped and explain server changes before applying them.
- Run relevant checks before pushing:
  - `npm run voice:check` for `server.js`.
  - `npm run lint` for web/API TypeScript checks.
  - `npm run build` before deployment-sensitive changes.
- Commit and push intentional changes to `origin main`, then deploy the exact commit using `deploy/README.md`.

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
