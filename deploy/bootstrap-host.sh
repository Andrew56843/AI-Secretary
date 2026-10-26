#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'Run as root.' >&2
  exit 1
fi
. /etc/os-release
if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 24.04 ]; then
  echo 'This bootstrap expects Ubuntu 24.04.' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if ! swapon --noheadings --show | grep -q .; then
  if [ ! -e /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
  fi
fi

apt-get update -qq
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git sudo ufw fail2ban ffmpeg asterisk \
  jq uuid-runtime logrotate xz-utils

install -m 0755 -d /etc/apt/keyrings
curl -fsSL --retry 3 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n' > /etc/apt/sources.list.d/docker.sources
apt-get update -qq
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]; then
  node_download_dir=$(mktemp -d)
  curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$node_download_dir/SHASUMS256.txt"
  node_archive=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ { print $2; exit }' "$node_download_dir/SHASUMS256.txt")
  test -n "$node_archive"
  curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v24.x/$node_archive" -o "$node_download_dir/$node_archive"
  (cd "$node_download_dir" && grep " $node_archive$" SHASUMS256.txt | sha256sum -c -)
  install -d /opt/node24
  tar -xJf "$node_download_dir/$node_archive" -C /opt/node24 --strip-components=1
  ln -sfn /opt/node24/bin/node /usr/local/bin/node
  ln -sfn /opt/node24/bin/npm /usr/local/bin/npm
  ln -sfn /opt/node24/bin/npx /usr/local/bin/npx
fi

if ! id andrew >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash andrew
fi
install -d -m 0750 -o andrew -g andrew /home/andrew/ai /home/andrew/ai/records
install -d -m 0700 /etc/callsec /var/backups/callsec
timedatectl set-timezone Europe/Moscow

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban
apt-get clean
node --version
docker --version
docker compose version
docker network inspect callsec-edge >/dev/null 2>&1 || docker network create callsec-edge
df -h /
free -h
