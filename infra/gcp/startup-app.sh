#!/usr/bin/env bash
set -euxo pipefail

APP_DIR="${APP_DIR:-/opt/voice-agent-hackathon}"
cd "$APP_DIR"

docker compose -f infra/gcp/docker-compose.app.yml up -d --build
