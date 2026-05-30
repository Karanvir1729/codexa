#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -n "${PYTHON:-}" ]]; then
  PYTHON_BIN="$PYTHON"
elif [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
else
  PYTHON_BIN="python3"
fi
export PYTHONPATH="${PYTHONPATH:-$ROOT_DIR/backend}"
COMMAND=("${PYTHON_BIN}" -m uvicorn app.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}")
if [[ -f .env.local ]]; then
  COMMAND=("${PYTHON_BIN}" -m dotenv -f .env.local run -- "${COMMAND[@]}")
fi
if [[ -f .env ]]; then
  COMMAND=("${PYTHON_BIN}" -m dotenv -f .env run -- "${COMMAND[@]}")
fi
exec "${COMMAND[@]}"
