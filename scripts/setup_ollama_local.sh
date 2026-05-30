#!/usr/bin/env bash
set -euo pipefail

MODEL="${OLLAMA_MODEL:-qwen2.5:0.5b}"

if ! command -v ollama >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install ollama
  else
    echo "Ollama is not installed and Homebrew is unavailable." >&2
    echo "Install Ollama, then rerun this script." >&2
    exit 1
  fi
fi

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1 && brew list --versions ollama >/dev/null 2>&1; then
    brew services start ollama >/dev/null || true
  fi
fi

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  nohup ollama serve >/tmp/voice-agent-ollama.log 2>&1 &
  sleep 3
fi

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Ollama did not start on http://127.0.0.1:11434." >&2
  echo "Check /tmp/voice-agent-ollama.log or start the Ollama app manually." >&2
  exit 1
fi

ollama pull "$MODEL"

python3 - "$MODEL" <<'PY'
import json
import sys
import urllib.request

model = sys.argv[1]
payload = {
    "model": model,
    "messages": [
        {"role": "system", "content": "/no_think\nReply with exactly: ready"},
        {"role": "user", "content": "test"},
    ],
    "temperature": 0,
    "max_tokens": 8,
    "stream": False,
}
request = urllib.request.Request(
    "http://127.0.0.1:11434/v1/chat/completions",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json", "Authorization": "Bearer ollama"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=60) as response:
    data = json.loads(response.read().decode())
print(data["choices"][0]["message"]["content"].strip())
PY

cat <<EOF
Ollama local model is ready.

Use these backend env vars:
  LLM_PROVIDER=ollama
  OLLAMA_BASE_URL=http://localhost:11434/v1
  OLLAMA_API_KEY=ollama
  OLLAMA_MODEL=$MODEL
EOF
