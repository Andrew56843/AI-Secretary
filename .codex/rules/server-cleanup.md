# Server Cleanup Rules

Use these rules before deleting files on `andrew@93.77.186.23`.

## Live Project Folders

Do not delete these folders unless Andrew explicitly names one of them:

- `/home/andrew/mon`
- `/home/andrew/moibike-crm`
- `/home/andrew/ai`
- `/home/andrew/tableGames`

## Usually Safe Cleanup Candidates

These can be deleted after listing exact paths and sizes:

- old `*.bak*` files
- old `*.before-*` files
- old `*.tar.gz` snapshots
- stale deploy logs
- duplicate old project backup directories

## Never Delete Blindly

- `.env` files that are currently used by live services
- `/home/andrew/ai/records`
- PostgreSQL volumes
- Coolify runtime directories under `/data/coolify` unless the exact file is an old backup and has been inspected
- `/var/spool/asterisk/*` except known temporary call files created by the voice service

## Current Known Server Shape

- `callsec.ru` is served by Coolify.
- The old voice stand is PM2 process `server` from `/home/andrew/ai/server.js`.
- Server cleanup should avoid stopping PM2 or Docker unless the task is explicitly a deployment/migration.

