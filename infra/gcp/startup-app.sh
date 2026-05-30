#!/usr/bin/env bash
set -euo pipefail

exec > >(tee -a /var/log/voice-agent-app-startup.log | logger -t voice-agent-app-startup -s 2>/dev/console) 2>&1

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git rsync docker.io docker-compose

if apt-cache show docker-compose-plugin >/dev/null 2>&1; then
  apt-get install -y docker-compose-plugin
fi

systemctl enable --now docker
mkdir -p /opt/voice-agent
chmod 755 /opt/voice-agent

echo "App VM is ready. Upload the repo to /opt/voice-agent and run docker compose."
