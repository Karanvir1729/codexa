#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
elif [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export VOICE_RUNTIME="${VOICE_RUNTIME:-local_pipecat}"
export PYTHONPATH="${PYTHONPATH:-$ROOT_DIR/backend}"
"${PYTHON:-python}" -m app.local_voice_runtime
