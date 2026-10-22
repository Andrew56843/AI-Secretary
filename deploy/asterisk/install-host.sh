#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 || $# -ne 1 ]]; then
  echo "Usage as root: bash deploy/asterisk/install-host.sh /root/callsec-asterisk.json" >&2
  exit 2
fi

DEPLOY_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INPUT_JSON="$(realpath -- "$1")"
if [[ ! -f "$INPUT_JSON" ]]; then
  echo "Asterisk input JSON does not exist" >&2
  exit 2
fi
if ! /usr/local/bin/node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)' ; then
  echo "Install Node.js 24 at /usr/local/bin/node before running this script" >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y asterisk asterisk-modules ffmpeg sudo curl jq uuid-runtime
if ! id andrew >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash andrew
fi
usermod --append --groups asterisk andrew

GENERATED_DIRECTORY="$(mktemp -d /run/callsec-asterisk.XXXXXX)"
trap 'rm -rf -- "$GENERATED_DIRECTORY"' EXIT
/usr/local/bin/node "$DEPLOY_DIRECTORY/render-config.cjs" "$INPUT_JSON" "$GENERATED_DIRECTORY"
visudo -cf "$DEPLOY_DIRECTORY/../voice/callsec-voice.sudoers"

install -d -o root -g andrew -m 0750 /etc/callsec
install -d -o andrew -g andrew -m 0750 /home/andrew/ai /home/andrew/ai/records
install -d -o asterisk -g asterisk -m 0750 /var/spool/asterisk/outgoing /var/spool/asterisk/outgoing_done /var/spool/asterisk/callsec-outgoing-staging
install -d -o root -g asterisk -m 0750 /var/lib/asterisk/agi-bin
install -o root -g asterisk -m 0640 "$GENERATED_DIRECTORY/pjsip.conf" /etc/asterisk/pjsip.conf
install -o root -g asterisk -m 0640 "$GENERATED_DIRECTORY/extensions.conf" /etc/asterisk/extensions.conf
install -o root -g asterisk -m 0640 "$GENERATED_DIRECTORY/callsec-metadata.json" /etc/asterisk/callsec-metadata.json
for NAME in rtp.conf modules.conf logger.conf; do
  install -o root -g asterisk -m 0640 "$DEPLOY_DIRECTORY/$NAME" "/etc/asterisk/$NAME"
done
install -o root -g root -m 0755 "$DEPLOY_DIRECTORY/callsec-metadata.agi.cjs" /var/lib/asterisk/agi-bin/callsec-metadata.agi.cjs
install -o root -g root -m 0440 "$DEPLOY_DIRECTORY/../voice/callsec-voice.sudoers" /etc/sudoers.d/callsec-voice
install -o root -g root -m 0644 "$DEPLOY_DIRECTORY/../voice/callsec-voice.service" /etc/systemd/system/callsec-voice.service
systemctl daemon-reload
systemctl enable asterisk callsec-voice

echo "Asterisk and voice service files installed."
echo "Install /etc/callsec/voice.env, Node dependencies and source before starting callsec-voice."
echo "Then restart Asterisk and verify app_audiosocket, SIP registration and the dialplan."
