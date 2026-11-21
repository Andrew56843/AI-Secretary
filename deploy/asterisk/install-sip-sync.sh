#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 || $# -ne 0 ]]; then
  echo 'Usage as root: bash deploy/asterisk/install-sip-sync.sh' >&2
  exit 2
fi

DEPLOY_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
/usr/local/bin/node "$DEPLOY_DIRECTORY/install-dialplan.cjs" --check
for DIRECTORY in /usr/local/lib/callsec /etc/asterisk /var/lib/asterisk/agi-bin; do
  if [[ -L "$DIRECTORY" ]]; then
    echo 'Refusing a symbolic-link installation directory' >&2
    exit 2
  fi
done
install -d -o root -g root -m 0755 /usr/local/lib/callsec
install -d -o root -g asterisk -m 0750 /etc/asterisk
for NAME in sync-sip-lines.cjs sip-lines-config.cjs sip-routing.cjs; do
  install -o root -g root -m 0644 "$DEPLOY_DIRECTORY/$NAME" "/usr/local/lib/callsec/$NAME"
done
install -o root -g root -m 0755 "$DEPLOY_DIRECTORY/callsec-metadata.agi.cjs" /var/lib/asterisk/agi-bin/callsec-metadata.agi.cjs
install -o root -g root -m 0644 "$DEPLOY_DIRECTORY/sip-routing.cjs" /var/lib/asterisk/agi-bin/sip-routing.cjs
/usr/local/bin/node <<'NODE'
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const groupId = Number(execFileSync('/usr/bin/id', ['-g', 'asterisk'], {encoding: 'utf8'}).trim());
for (const [file, initial] of [
  ['/etc/asterisk/callsec-sip-lines.conf', ''],
  ['/etc/asterisk/callsec-sip-routes.json', '{}\n'],
]) {
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Unsafe SIP configuration file');
  } else {
    fs.writeFileSync(file, initial, {mode: 0o640, flag: 'wx'});
    fs.chownSync(file, 0, groupId);
  }
}
const file = '/etc/asterisk/pjsip.conf';
const stat = fs.lstatSync(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Unsafe base PJSIP configuration');
const text = fs.readFileSync(file, 'utf8');
if (!/^#include\s+callsec-sip-lines[.]conf\s*$/m.test(text)) {
  const temporary = '/etc/asterisk/.pjsip-callsec-install.tmp';
  fs.writeFileSync(temporary, `${text.trimEnd()}\n\n#include callsec-sip-lines.conf\n`, {mode: 0o640, flag: 'wx'});
  fs.chownSync(temporary, 0, groupId);
  fs.renameSync(temporary, file);
}
NODE
/usr/local/bin/node "$DEPLOY_DIRECTORY/install-dialplan.cjs" "$DEPLOY_DIRECTORY/extensions.conf.tpl"
for NAME in callsec-sip-sync.service callsec-sip-sync.timer; do
  install -o root -g root -m 0644 "$DEPLOY_DIRECTORY/../voice/$NAME" "/etc/systemd/system/$NAME"
done
systemctl daemon-reload
systemctl enable callsec-sip-sync.timer
echo 'Dedicated SIP synchronization installed without restarting Asterisk.'
echo 'After API migration and private token setup, start callsec-sip-sync.service and callsec-sip-sync.timer.'
