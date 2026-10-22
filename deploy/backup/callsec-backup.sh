#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

project_dir=/opt/callsec
backup_dir=/var/backups/callsec
key_file=/etc/callsec/backup.key
work_dir=

if [[ $EUID -ne 0 ]]; then
  printf '%s\n' 'Callsec backups must run as root.' >&2
  exit 1
fi

exec 9>/run/lock/callsec-backup.lock
if ! flock -n 9; then
  printf '%s\n' 'A Callsec backup is already running.'
  exit 0
fi

if [[ ! -f $key_file || -L $key_file ]]; then
  printf '%s\n' 'The separate backup encryption key is missing.' >&2
  exit 1
fi
key_mode=$(stat -c '%a' "$key_file")
if [[ $(stat -c '%u' "$key_file") != 0 || ( $key_mode != 600 && $key_mode != 400 ) ]]; then
  printf '%s\n' 'The backup key must be owned by root with mode 600 or 400.' >&2
  exit 1
fi
if [[ $(stat -c '%s' "$key_file") -lt 32 ]]; then
  printf '%s\n' 'The backup encryption key is too short.' >&2
  exit 1
fi

for required_path in "$project_dir/.env" "$project_dir/docker-compose.restore.yml" /etc/callsec /etc/asterisk; do
  if [[ ! -e $required_path ]]; then
    printf 'Required backup source is missing: %s\n' "$required_path" >&2
    exit 1
  fi
done

install -d -o root -g root -m 700 "$backup_dir"
work_dir=$(mktemp -d "$backup_dir/.staging.XXXXXX")

cleanup() {
  if [[ -n $work_dir && $work_dir == "$backup_dir"/.staging.* && -d $work_dir ]]; then
    rm -f -- "$work_dir/database.dump" "$work_dir/metadata.txt" "$work_dir/database.sha256" "$work_dir/archive.enc"
    rmdir -- "$work_dir"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose --project-directory "$project_dir" --env-file "$project_dir/.env" \
  -f "$project_dir/docker-compose.restore.yml" exec -T db \
  pg_dump --username callsec --dbname ai_secretary --format custom --no-owner --no-acl \
  > "$work_dir/database.dump"

source_commit=$(git -c safe.directory="$project_dir" -C "$project_dir" rev-parse HEAD 2>/dev/null || printf '%s' unknown)
printf 'created_utc=%s\nsource_commit=%s\ndatabase=ai_secretary\n' \
  "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$source_commit" > "$work_dir/metadata.txt"
(
  cd "$work_dir"
  sha256sum database.dump > database.sha256
)

archive_paths=(
  etc/callsec
  etc/asterisk
  opt/callsec/.env
  opt/callsec/docker-compose.restore.yml
  opt/callsec/deploy/Caddyfile
)
for optional_path in \
  etc/systemd/system/callsec-voice.service \
  etc/systemd/system/callsec-backup.service \
  etc/systemd/system/callsec-backup.timer; do
  if [[ -e /$optional_path ]]; then
    archive_paths+=("$optional_path")
  fi
done

tar --exclude=etc/callsec/backup.key \
  -C "$work_dir" -cf - database.dump database.sha256 metadata.txt \
  -C / "${archive_paths[@]}" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt \
      -pass "file:$key_file" -out "$work_dir/archive.enc"

archive_file="$backup_dir/callsec-$(date -u +'%Y%m%dT%H%M%SZ').tar.enc"
chmod 600 "$work_dir/archive.enc"
mv -- "$work_dir/archive.enc" "$archive_file"

# Delete only archives created by this script, after a successful replacement.
find "$backup_dir" -maxdepth 1 -type f \
  -name 'callsec-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.tar.enc' \
  -mtime +6 -delete

printf 'Encrypted Callsec backup saved: %s\n' "$archive_file"
