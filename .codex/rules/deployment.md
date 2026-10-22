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
- Current server: `83.217.203.61`, Ubuntu 24.04, checkout `/opt/callsec`.
- Production compose: `docker-compose.restore.yml`, no Coolify on this small server.
- Production app has Git-backed services:
  - `web`: React/Vite build served by nginx.
  - `api`: Express/Prisma backend.
- PostgreSQL 16 and Caddy HTTPS run in the same compose project.
- The API has read-only access to call recordings through `/home/andrew/ai/records`.

## Voice Service

- `server.js` is the voice service entrypoint.
- Host process: systemd `callsec-voice`, running `/opt/callsec/server.js`.
- Voice environment: `/etc/callsec/voice.env`.
- It listens on AudioSocket and metadata ports, normally `127.0.0.1:9019` and `127.0.0.1:9020`.
- It integrates with the SaaS API through `PLATFORM_API_BASE_URL` and `VOICE_SERVICE_TOKEN`.
- It depends on host Asterisk:
  - Asterisk CLI commands through `sudo /usr/sbin/asterisk -rx ...`.
  - Outbound call files in `/var/spool/asterisk/outgoing`.
  - Archived call status in `/var/spool/asterisk/outgoing_done`.
- Because of that, do not move `server.js` into Docker until the Asterisk host integration is deliberately migrated.
- SIP uses Novofon TLS port 5061 with server certificate verification. Local transport listens on 5071; RTP uses UDP 10000-10199.
- Both DIDs are rentable. `+79952225212` is assigned to the owner and is also the verification DID; `+79952225213` remains available.
- Verification intercepts only an incoming call from the exact caller with a pending unexpired request; all other calls follow normal profile routing.

## Git And Auto Deploy

- Pushing to `origin main` updates the source repository; deployment is explicit on the new server.
- Verify production deployment by checking that the running containers expose the latest `SOURCE_COMMIT`.
- Pull the desired commit in `/opt/callsec`, update `SOURCE_COMMIT` in the production environment, build API/web sequentially and run compose up.
- Restart `callsec-voice` after voice source or its environment changes. All host templates and services are versioned under `deploy/`.
- Nightly encrypted database/configuration backups are installed from `deploy/backup`. Their separate key and off-server recovery copies belong outside Git.

