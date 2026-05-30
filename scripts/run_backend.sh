#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

export PYTHONPATH="${PYTHONPATH:-$ROOT_DIR/backend}"
exec "${PYTHON:-python}" -m uvicorn app.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}"
