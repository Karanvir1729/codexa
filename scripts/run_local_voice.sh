#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export LLM_PROVIDER="${LLM_PROVIDER:-ollama}"
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434/v1}"
export OLLAMA_API_KEY="${OLLAMA_API_KEY:-ollama}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:0.5b}"
export REASONING_MODE="${REASONING_MODE:-off}"
export VOICE_RUNTIME="${VOICE_RUNTIME:-local_pipecat}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama is not installed. Run ./scripts/setup_ollama_local.sh first." >&2
  exit 1
fi

if ! curl -fsS "${OLLAMA_BASE_URL%/v1}/api/tags" >/dev/null; then
  echo "ollama is not reachable. Run ./scripts/setup_ollama_local.sh first." >&2
  exit 1
fi

if ! ollama list | awk '{print $1}' | grep -qx "${OLLAMA_MODEL}"; then
  echo "Ollama model ${OLLAMA_MODEL} is not pulled. Pulling it now..." >&2
  ollama pull "${OLLAMA_MODEL}"
fi

PYTHONPATH=backend .venv/bin/python -m app.local_voice_runtime
