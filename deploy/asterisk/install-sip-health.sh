#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 || $# -ne 0 ]]; then
  echo 'Usage as root: bash deploy/asterisk/install-sip-health.sh' >&2
  exit 2
fi

SOURCE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for DIRECTORY in /usr/local/lib/callsec /usr/local/lib/callsec/deploy /usr/local/lib/callsec/deploy/asterisk; do
  if [[ -L "$DIRECTORY" ]]; then
    echo 'Refusing a symbolic-link installation directory' >&2
    exit 2
  fi
  install -d -o root -g root -m 0755 "$DIRECTORY"
done
for NAME in sip-health.cjs sip-routing.cjs sip-lines-config.cjs; do
  install -o root -g root -m 0644 "$SOURCE/$NAME" "/usr/local/lib/callsec/deploy/asterisk/$NAME"
done
install -o root -g root -m 0644 "$SOURCE/../../sip-line-health.js" /usr/local/lib/callsec/sip-line-health.js
install -o root -g root -m 0755 "$SOURCE/publish-outbound-call.cjs" /usr/local/lib/callsec/publish-outbound-call.cjs
/usr/local/bin/node /usr/local/lib/callsec/deploy/asterisk/sip-health.cjs --check

SUDOERS="/etc/sudoers.d/.callsec-voice-health.$$.tmp"
trap 'rm -f -- "$SUDOERS"' EXIT
install -o root -g root -m 0440 "$SOURCE/../voice/callsec-voice.sudoers" "$SUDOERS"
/usr/sbin/visudo -cf "$SUDOERS"
mv -f -- "$SUDOERS" /etc/sudoers.d/callsec-voice
for NAME in callsec-sip-health.service callsec-sip-health.timer; do
  install -o root -g root -m 0644 "$SOURCE/../voice/$NAME" "/etc/systemd/system/$NAME"
done
systemctl daemon-reload
systemctl enable --now callsec-sip-health.timer
echo 'SIP health monitoring installed without restarting Asterisk or placing calls.'
