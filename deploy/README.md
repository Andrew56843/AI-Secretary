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
- Node.js 24 and npm 11.21.3 for host voice-service dependency installation.

The Docker builders pin npm 11.21.3. Use that version on the host too, or run
`npm exec --yes --package=npm@11.21.3 -- npm ci`. Older npm releases before
11.18.0 can silently ignore root overrides across workspace links
([npm fix](https://github.com/npm/cli/releases/tag/v11.18.0)).
The scoped `@prisma/config@6.19.3` overrides patch `deepmerge-ts` and `effect`
without migrating the application to Prisma 7. Keep the Prisma configuration
regression tests when updating or removing those overrides.

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

Copy `deploy/.env.restore.example` to `/etc/callsec/app.env`, fill the
credentials privately on the server, and keep it owned by root with mode `600`.
Pass `--env-file /etc/callsec/app.env` explicitly to Docker Compose. Do not put
the SIP configuration token in the checkout's `.env` or any voice-readable
file. Do not commit filled environment files or troubleshooting attachments.

Generate separate random values of at least 32 bytes for `POSTGRES_PASSWORD`,
`JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `VOICE_SERVICE_TOKEN`, and `SIP_CONFIG_TOKEN`, for example with
`openssl rand -hex 32`. Use a hex password so it is also valid in the PostgreSQL
connection URL. Keep `DATA_ENCRYPTION_KEY` unchanged across deployments because
Google OAuth tokens and SIP passwords in the database are encrypted with it.
`SIP_CONFIG_TOKEN` must differ from `VOICE_SERVICE_TOKEN`. Only the API and the
root-owned SIP synchronization service receive the former; the voice process
only receives safe routing metadata.

Set `SOURCE_COMMIT` to the full output of `git rev-parse HEAD`. Both application
images and containers receive that revision as an OCI label; the API also
receives it as an environment variable. Set the same revision in the host
voice-service environment after deploying that checkout.

The OAuth client's authorized redirect URI must be:

```text
https://callsec.ru/api/integrations/google/oauth/callback
```

Set `TEST_CALLER_ID=+79952225212` in the private API environment to allow paid
test calls to an account's own verified phone before it rents a number. An active
number rented by that account takes priority. The test caller ID is never used
to call other customers' phones; ordinary outbound calls require the account's
own active rental. Without either eligible caller ID, the API rejects a test
request before putting it in the queue. Pass this setting through Compose when
recreating the API; the host voice service receives the selected caller ID from
the API, not from its own environment.

The API requests `calendar.events` and `userinfo.email`. Configure
`OPENAI_PROXY_URL` and `TELEGRAM_PROXY_URL` with the existing authenticated proxy
URLs. A SOCKS URL is supported for OpenAI; Telegram can use the HTTP proxy URL.

## Start And Verify

Run from the Git checkout:

```sh
mkdir -p /home/andrew/ai/records
docker network inspect callsec-edge >/dev/null 2>&1 || docker network create callsec-edge
docker compose --env-file /etc/callsec/app.env -f docker-compose.restore.yml config --quiet
docker compose --env-file /etc/callsec/app.env -f docker-compose.restore.yml build api
docker compose --env-file /etc/callsec/app.env -f docker-compose.restore.yml build web
docker compose --env-file /etc/callsec/app.env -f docker-compose.restore.yml up -d --no-build
docker compose --env-file /etc/callsec/app.env -f docker-compose.restore.yml ps
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

Pull the intended commit, update `SOURCE_COMMIT` in `/etc/callsec/app.env`, then
build `api` and `web` sequentially as above and run
`docker compose --env-file /etc/callsec/app.env -f docker-compose.restore.yml up -d --no-build`. Update and
restart the host voice service from the same checkout after active calls end.
Check the image/container revision labels and health endpoints after each
deployment.

### Dedicated SIP Line Rollout

Deploy the dedicated-line changes as one coordinated maintenance operation.
The new API and voice code deliberately reject outbound calls without a valid,
enabled DID-bound SIP route; deploying only the API will interrupt outbound calls.

1. In Novofon, set each SIP line to the fixed outgoing DID it serves. Keep the
   existing incoming routes unchanged until replacement registrations are verified.
2. Preserve `DATA_ENCRYPTION_KEY`, back up the database and Asterisk configuration,
   and wait for all active calls and queued Asterisk call files to finish. Stop
   `callsec-voice` and both `callsec-sip-sync` units during the schema/import/host
   transition, and pause incoming traffic, so no call or synchronization starts
   while host files are being replaced.
3. Apply the Prisma migration and import the private SIP bundle into `SipLine`.
   Each entry references an existing `ReservedPhoneNumber`; it does not create a
   SaaS user or change its rental. The password is encrypted with authenticated
   `enc:v2` encryption. The CLI accepts JSON on stdin only and prints no credentials.
   In the built API container the command is `node dist/scripts/provision-sip-lines.js`.
   Pipe a root-readable bundle into `docker compose ... exec -T api` rather than
   putting passwords in command arguments or source files. An encrypted envelope
   `{ "encrypted": "enc:v2:..." }` is supported with the same data encryption key.
4. Install `/etc/callsec/sip-sync.env` as root:root `0600`, with
   `SIP_CONFIG_API_URL=http://127.0.0.1:14000/internal/voice/sip-lines/config` and the
   same independent `SIP_CONFIG_TOKEN` used by the API. Run
   `bash deploy/asterisk/install-sip-sync.sh` and the synchronization service as
   described in [the host instructions](asterisk/README.md). The installer also
   replaces the managed transfer dialplan and reloads it, without restarting
   Asterisk, so transfers cannot retain the old shared endpoint. The generated
   secret include and non-secret route map belong under `/etc/asterisk`, outside Git.
5. Reusing the legacy SIP login requires an explicit, quiescent registration
   transition. Do not register the same login through both the legacy and canonical
   registration objects. The sync helper refuses this collision. Preserve the
   legacy inbound endpoint/identify configuration while disabling only its old
   registration, then verify the new registration before resuming traffic.
6. Confirm both dedicated registrations are `Registered`, route-map revisions
   match the API, and caller IDs match their DIDs. Start the matching voice code,
   verify incoming, rented-number outgoing and owner-only test calls, then enable
   the synchronization timer. Check one billing entry and one Telegram result.

The private configuration endpoint is loopback-only and must never be exposed
through Caddy. Ordinary profile responses and call metadata contain endpoint,
DID and revision only, never SIP passwords or provider employee credentials.
Do not rotate the encryption key to troubleshoot a failed import. Keep the
database, `/etc/callsec`, Asterisk files and matching source revision together in
the rollback plan; an old API cannot safely substitute a different caller ID.

### Call Finalization Upgrade

Apply `20261121130000_call_billing_snapshots` and
`20261121131000_telegram_delivery_claims` before starting the matching API.
First pause new calls, drain active calls and queued call files, and wait for
the old voice process to finish transcription, call logs and balance charges.
Only then stop voice and update the API/voice together. Do not interrupt an
old in-flight call and try to reconstruct its price from the current profile.

The API saves `CallBillingSnapshot` before admitting a conversation. The selected
model and integer kopeck rate are immutable for that UUID, including repeated
start requests. Final billing does not depend on the current profile or the
short-lived `ActiveCall`. Positive-duration callbacks without an authorized
snapshot return 409; retain their voice-side recordings and metadata for review,
not an automatic charge at a guessed rate. Only a zero-duration `MISSED` can be
recorded without a start snapshot, at zero cost.

Final callbacks require a stable `callUuid`. A per-call transaction lock protects
the ledger entry, call log and contact attempt update as one operation. Duplicate
callbacks do not repeat those effects or Calendar post-processing. The HTTP
response no longer waits for Telegram networking.
Graceful API shutdown closes HTTP admission and drains tracked delivery jobs
before disconnecting Prisma. Compose grants 60 seconds for this shutdown.

Only the API sends final transcripts. Its dispatcher recovers persisted `PENDING`
deliveries on startup and every 30 seconds. A short database transaction claims
one delivery as `SENDING`; no database connection is held during the HTTP send.
Confirmed acceptance becomes `SENT`. A rejected delivery becomes `FAILED`;
timeouts, connection loss, invalid responses and interrupted sends become
`UNKNOWN`. Neither `FAILED` nor `UNKNOWN` is automatically resent, including when
historical sibling rows remain pending. Stale `SENDING` is marked `UNKNOWN`, not
put back in the queue. Review those results before any manual retry because
Telegram may have accepted a message whose response was lost. Voice keeps local
transcripts on API failure and never sends a competing Telegram fallback.

The migrations do not delete, merge or rewrite historical delivery records.
Back up the database and deploy all matching code together; do not roll back
only the API against rows using the new delivery states.

The optional real-PostgreSQL regression suite requires an explicitly isolated
localhost database whose name ends in `_test`. Apply migrations there using its
explicit `DATABASE_URL`, then set `CALLSEC_INTEGRATION_DATABASE_URL` to the same
URL and run `node --import tsx --test apps/api/src/lib/call-finalization.integration.test.ts`.
Without that variable, real database tests are skipped. Never point this suite
at production or at a shared development database.

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
