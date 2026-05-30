#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p data/sft
export PYTHONPATH="${PYTHONPATH:-$ROOT_DIR/backend}"
"${PYTHON:-python}" -m app.training_data data/sft/voice-agent-positive-examples.jsonl
