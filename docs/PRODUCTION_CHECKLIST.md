# Production Checklist

Callsec should not accept paid customers until every required item below is verified.

## Infrastructure

- Node.js 24 is used for web/API builds and for the PM2 voice process.
- PostgreSQL has automatic encrypted backups and a tested restore procedure.
- `https://callsec.ru/healthz` or the routed API health endpoint is monitored.
- Disk usage is monitored for `/home/andrew/ai/records` and database volumes.
- PM2, Asterisk, Docker/Coolify, API errors, and failed transcript deliveries have alerts.

## Secrets

- Generate independent random values for `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, and `VOICE_SERVICE_TOKEN`.
- Set `ADMIN_PHONES` explicitly; do not grant admin access in source code.
- Store OpenAI, Telegram, Google, payment, database, and proxy credentials only in the deployment secret store.
- Back up `DATA_ENCRYPTION_KEY` securely. Losing it makes encrypted integration tokens unreadable.
- Rotate any credential that was ever pasted into chat, logs, source files, or screenshots.

## Web And API

- Set `NODE_ENV=production`, `PUBLIC_WEB_URL=https://callsec.ru`, and the exact CORS allowlist.
- Set `TRUST_PROXY_HOPS` to the actual number of trusted reverse proxies.
- Confirm registration, login, recovery, password change, logout, and old-token revocation.
- Confirm two different accounts cannot read or modify each other's profiles, recordings, contacts, billing, or integrations.
- Move rate-limit state to Redis before running more than one API replica.

## Payments

- Sign a merchant agreement with an internet-acquiring provider; CloudTips must not be used to sell the service.
- Set `CLOUDPAYMENTS_PUBLIC_ID`, `CLOUDPAYMENTS_API_SECRET`, and `CLOUDPAYMENTS_OFFER_URL`.
- Configure the Check, Pay, Fail, and Refund webhook URLs from the README as HTTPS POST notifications.
- Run provider test payments, duplicate webhook delivery, wrong-amount rejection, failed payment, and full refund.
- Configure online receipts and tax details required for the legal entity and applicable version of 54-FZ.
- Reconcile provider reports against `PaymentOrder` and `BillingTransaction` records.

## Telephony And AI

- Route every DID to a specific account profile through the platform API.
- Confirm calls are rejected when the profile is missing, the number rental expired, or balance is zero.
- Test at least two concurrent calls and verify separate prompts, voices, transcripts, recordings, and charges.
- Test inbound, outbound, forwarding, hangup, provider failure, proxy delay, and Asterisk restart.
- Confirm the chosen voice is sent in every Realtime session and no legacy client configuration is loaded.

## Integrations

- Configure Google OAuth production consent, callback URL, scopes, and test create/find/reschedule/cancel flows.
- Configure the Telegram bot webhook/polling process and proxy; verify exactly one final transcript per call.
- Confirm disconnecting Google or Telegram removes stored tokens/identifiers and stops further delivery.

## Legal And Support

- Have the privacy policy, terms, offer, consent language, recording notice, data-retention period, and deletion process reviewed for the operating jurisdiction.
- Publish seller identity, legal details, tariffs, billing rules, refund rules, and support response expectations.
- Define how users notify callers about recording and transcription where required.
- Provide a support path for incorrect charges, number release, data export, and account deletion.

## Release

- Run `npm run lint`, `npm test`, `npm run build`, `npm run voice:check`, and `npm audit`.
- Review database migrations and take a backup before deployment.
- Deploy web/API from the intended Git commit and verify the running commit.
- Deploy `server.js` separately to PM2, restart it, and run a real inbound and outbound smoke call.
- Keep a rollback artifact for the previous web/API image and voice-service file.
