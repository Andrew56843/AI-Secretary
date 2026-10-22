# Encrypted Database And Configuration Backups

The host script runs at 03:30 Europe/Moscow through systemd. It creates a
PostgreSQL custom-format dump, adds the deployment environment and Asterisk
configuration, and encrypts the archive with AES-256-CBC and PBKDF2 (200,000
iterations, SHA-256). `/etc/callsec/backup.key` is never included in the archive.
Files and temporary data are accessible only to root. A completed archive is
renamed atomically; failed backups do not replace existing archives. Archives
older than seven days are removed only after a new backup succeeds.

The archive contains:

- `database.dump`, its SHA-256 checksum, and the deployed Git revision.
- `/etc/callsec`, except the separate backup encryption key.
- `/etc/asterisk`.
- `/opt/callsec/.env`, the production Compose file, and Caddy configuration.
- The voice and backup systemd units when present.

Call recordings are intentionally excluded. Copy `/home/andrew/ai/records`
separately to preserve the audio archive. The database stores call metadata,
not the audio files. Keep a separate copy of the Git repository as well.

## Install On The Production Host

Run as root from `/opt/callsec` after the application and Asterisk are working:

```sh
install -d -o root -g root -m 700 /etc/callsec /var/backups/callsec
if [ ! -e /etc/callsec/backup.key ]; then
  (umask 077; openssl rand -hex 32 > /etc/callsec/backup.key)
fi
install -o root -g root -m 750 deploy/backup/callsec-backup.sh /usr/local/sbin/callsec-backup
install -o root -g root -m 644 deploy/backup/callsec-backup.service /etc/systemd/system/callsec-backup.service
install -o root -g root -m 644 deploy/backup/callsec-backup.timer /etc/systemd/system/callsec-backup.timer
systemctl daemon-reload
systemctl start callsec-backup.service
systemctl enable --now callsec-backup.timer
systemctl list-timers callsec-backup.timer
```

Generate the backup key only on the first installation. For subsequent updates,
keep the existing key and reinstall just the script and units. Copy the key and
at least the initial encrypted archive off the server to private storage on the
owner's PC. Store the key separately from the archives. Losing both the server
and its only local backup also loses the data; this timer does not upload files.

Inspect scheduled failures with:

```sh
systemctl status callsec-backup.service
journalctl -u callsec-backup.service --since yesterday
```

## Verify Or Restore

Run as root using a saved encryption key. Extract into a private temporary
directory first, not directly over the running server:

```sh
set -o pipefail
restore_dir=$(mktemp -d /root/callsec-restore.XXXXXX)
chmod 700 "$restore_dir"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -pass file:/etc/callsec/backup.key \
  -in /var/backups/callsec/callsec-YYYYMMDDTHHMMSSZ.tar.enc \
  | tar -C "$restore_dir" -xf -
(cd "$restore_dir" && sha256sum --check database.sha256)
```

Review the recovered environment and Asterisk configuration before installing
them on the replacement host. Preserve the recovered `DATA_ENCRYPTION_KEY` or
the stored Google OAuth tokens cannot be decrypted. Keep the backup key private
and outside the Git checkout.

To restore the database, stop the API and voice service so they cannot modify
it while restoring. On a fresh server, install the recovered `.env` with mode
600 at `/opt/callsec/.env`, then start PostgreSQL only. The following command
replaces matching database objects and must target the intended restore
database:

```sh
cd /opt/callsec
docker compose -f docker-compose.restore.yml up -d db
docker compose -f docker-compose.restore.yml exec -T db \
  pg_restore --username callsec --dbname ai_secretary \
    --clean --if-exists --no-owner --no-acl --exit-on-error \
  < "$restore_dir/database.dump"
docker compose -f docker-compose.restore.yml up -d --no-build
```

Wait until PostgreSQL is healthy before running `pg_restore`. Start the host
voice service after checking the API health endpoint. Verify user access,
balances, profiles, and integrations; restore recordings separately if needed.
After verification, remove the extracted plaintext from the private temporary
directory. Do not leave decrypted `.env` files in shared folders.
