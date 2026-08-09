# Deployment Notes

## Local

- Main local path: `D:\AI-Secretary`.
- Local Docker compose path: `D:\AI-Secretary\docker-compose.yml`.
- Local URLs:
  - web: `http://localhost:8080`
  - api: `http://localhost:4000`
  - postgres: `localhost:5432`
  - pgAdmin: `http://localhost:5050`

## Production

- Public site: `https://callsec.ru`.
- Coolify app name/resource: `ai-secretary`.
- Coolify app UUID observed on the server: `q10g7iuizo8l4ojk716d4vww`.
- Coolify compose source: `docker-compose.server.yml`.
- Production app currently has two Git-backed services:
  - `web`: React/Vite build served by nginx.
  - `api`: Express/Prisma backend.
- The API has read-only access to call recordings through `/home/andrew/ai/records`.

## Voice Service

- `server.js` is the voice service entrypoint.
- Live legacy process: PM2 process `server`, running `/home/andrew/ai/server.js`.
- It listens on AudioSocket and metadata ports, normally `127.0.0.1:9019` and `127.0.0.1:9020`.
- It integrates with the SaaS API through `PLATFORM_API_BASE_URL` and `VOICE_SERVICE_TOKEN`.
- It depends on host Asterisk:
  - Asterisk CLI commands through `sudo /usr/sbin/asterisk -rx ...`.
  - Outbound call files in `/var/spool/asterisk/outgoing`.
  - Archived call status in `/var/spool/asterisk/outgoing_done`.
- Because of that, do not move `server.js` into Docker until the Asterisk host integration is deliberately migrated.

## Git And Auto Deploy

- Pushing to `origin main` updates the Git source used by Coolify.
- Verify production deployment by checking that the running containers expose the latest `SOURCE_COMMIT`.
- Root `server.js` is tracked by Git, but the live PM2 voice process does not automatically update from Git yet.

