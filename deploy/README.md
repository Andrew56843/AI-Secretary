# Fresh Production Deployment

`docker-compose.restore.yml` runs the website, API, PostgreSQL 16, and Caddy
without Coolify. Asterisk and the AudioSocket voice service run on the Ubuntu
host. The deployment starts with an empty database; it does not create demo
users or copy balances from the old server.

## Prerequisites

- Ubuntu Server 24.04 LTS with Docker Engine and Docker Compose v2.
- DNS for `callsec.ru` pointing to the server; TCP 80 and TCP/UDP 443 available
  to Caddy. An obsolete AAAA record must not point to a different server.
- Git checkout owned by the deployment user, for example `/home/andrew/ai`.
- `/home/andrew/ai/records` created before starting the containers.
- SIP routing, Asterisk, and the host voice service configured separately.

The initial restoration server has about 894 MiB RAM and a 14 GB disk. This
configuration is intended for that small test deployment: PostgreSQL uses
64 MB shared buffers, a 30-connection ceiling, and 2 MB working memory per
operation; Prisma opens at most five pooled connections, and the API uses a
192 MB JavaScript heap ceiling. No container-wide
memory limit is imposed, so migration and startup processes are not killed by
an arbitrary container cap. Leave capacity for Asterisk and the host voice
service. Provision 2 GB swap before building, build the API and web images one
at a time, and monitor RAM, swap activity, disk use, and audio quality. This
machine is not sized for multiple concurrent customer calls.

## Environment

Copy `deploy/.env.restore.example` to the repository-root `.env`, fill the
credentials privately on the server, and set its permissions to `600`.
The root `.env` is ignored by Git. Do not put production credentials in the
example file or pass it around as a troubleshooting attachment.

Generate separate random values of at least 32 bytes for `POSTGRES_PASSWORD`,
`JWT_SECRET`, `DATA_ENCRYPTION_KEY`, and `VOICE_SERVICE_TOKEN`, for example with
`openssl rand -hex 32`. Use a hex password so it is also valid in the PostgreSQL
connection URL. Keep `DATA_ENCRYPTION_KEY` unchanged across deployments because
Google OAuth tokens in the database are encrypted with it.

Set `SOURCE_COMMIT` to the full output of `git rev-parse HEAD`. Both application
images and containers receive that revision as an OCI label; the API also
receives it as an environment variable. Set the same revision in the host
voice-service environment after deploying that checkout.

The OAuth client's authorized redirect URI must be:

```text
https://callsec.ru/api/integrations/google/oauth/callback
```

The API requests `calendar.events` and `userinfo.email`. Configure
`OPENAI_PROXY_URL` and `TELEGRAM_PROXY_URL` with the existing authenticated proxy
URLs. A SOCKS URL is supported for OpenAI; Telegram can use the HTTP proxy URL.

## Start And Verify

Run from the Git checkout:

```sh
mkdir -p /home/andrew/ai/records
docker network inspect callsec-edge >/dev/null 2>&1 || docker network create callsec-edge
docker compose -f docker-compose.restore.yml config --quiet
docker compose -f docker-compose.restore.yml build api
docker compose -f docker-compose.restore.yml build web
docker compose -f docker-compose.restore.yml up -d --no-build
docker compose -f docker-compose.restore.yml ps
curl --fail http://127.0.0.1:14000/healthz
curl --fail https://callsec.ru/healthz
```

The API applies Prisma migrations before it starts. Do not run the development
seed: it creates sample accounts and call logs. Add the two Novofon numbers
`+79952225212` and `+79952225213` to the available number pool using the
production provisioning procedure, then register the owner through the normal
phone-verification flow. Both numbers remain rentable; `52-12` doubles as
verification only for callers with a pending matching request. For the owner's
explicit restoration, `deploy/restore-owner-number.mjs` attaches `52-12` to the
inbound profile and grants a 30-day restoration period with a zero-value audit
entry. It preserves the balance and does not overwrite prompts or integrations.

The host voice service must use `PLATFORM_API_BASE_URL=http://127.0.0.1:14000` and
the same `VOICE_SERVICE_TOKEN` as the API. The API mounts host recordings read
only at `/home/andrew/ai/records`. Caddy forwards public `/api/*` directly to the
API, preserving the HTTPS scheme and one trusted proxy hop. Internal voice
routes are available through the loopback API port, not through Caddy.

Before accepting customer calls, verify phone registration, number reservation,
both call directions and caller IDs, greeting playback, selected voice,
recording playback, balance deductions, Google Calendar operations, and one
Telegram notification after each call.

## Updates And Backups

Pull the intended commit, update `SOURCE_COMMIT` in the private `.env`, then
build `api` and `web` sequentially as above and run
`docker compose -f docker-compose.restore.yml up -d --no-build`. Update and
restart the host voice service from the same checkout after active calls end.
Check the image/container revision labels and health endpoints after each
deployment.

### Shared HTTPS Edge

Only Caddy joins the external `callsec-edge` network. Other applications may
attach their frontend to it using a unique alias; their databases and APIs must
remain on their own private networks. Additional site definitions are imported
from `/data/sites/*.caddy` in Caddy's persistent data volume. Keep the original
site files with each application's deployment configuration and include them in
that application's backup. Never mount its storage or secrets into Callsec.

For example, the separate CRM deployment uses `crm-frontend:80` and
`crm.callsec.ru`. Install its site definition only after the CRM passes its own
health and login checks. Validate and reload/recreate Caddy without restarting
Callsec's API, database, or host voice service.

PostgreSQL and TLS certificates persist in named Docker volumes. Container logs
are rotated automatically. Install the [nightly encrypted backup service](backup/README.md)
after restoration. It backs up PostgreSQL, runtime secrets, and Asterisk
configuration at 03:30 Moscow time and retains seven days locally. Copy its
initial archive and separate encryption key to private off-server storage.
Call recordings require a separate backup; they are not included in the
nightly database/configuration archive.
`docker compose down` preserves data, but `down --volumes` destroys it.
