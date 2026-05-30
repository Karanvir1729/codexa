# Voice Agent Feedback Engine

Browser voice agent for Codexa/Codex workflows with one supported real-time stack:

```text
Browser SmallWebRTC
  -> FastAPI /api/offer
  -> NVIDIA WebSocket STT
  -> NVIDIA Nemotron OpenAI-compatible LLM
  -> Codex/Codexa orchestration
  -> Gradium TTS
  -> Pipecat audio response
```

Gradium is also used for semantic VAD. Local/cloud STT, TTS, and LLM fallbacks have been removed from the runtime path.

## Required Runtime

Copy `.env.demo.example` to `.env.local` and fill local secrets there:

```bash
cp .env.demo.example .env.local
```

Required values:

```bash
LLM_PROVIDER=nemotron
NEMOTRON_LLM_URL=http://nemotron-fleet-alb-1322439314.us-west-2.elb.amazonaws.com/v1
NEMOTRON_LLM_MODEL=nvidia/nemotron-3-super

VOICE_RUNTIME=local_pipecat
VOICE_SPEECH_PATH=nvidia_gradium
LOCAL_STT_PROVIDER=nvidia_ws
NVIDIA_ASR_URL=ws://44.241.251.184:8080
LOCAL_TTS_PROVIDER=gradium
GRADIUM_API_KEY=<set locally>

CODEX_ORCHESTRATOR_ENABLED=true
CODEX_ORCHESTRATOR_BASE_URL=http://127.0.0.1:4317
```

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e "backend[dev,voice]"

cd frontend
npm ci
cd ..
```

## Run

Backend:

```bash
mkdir -p logs
set -a && source .env.local && set +a
PYTHONPATH=backend .venv/bin/python -m uvicorn app.main:app \
  --host 0.0.0.0 --port 8000 --log-level info
```

Frontend:

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`, use the Voice Agent console, run preflight, then connect.

## Smoke Checks

```bash
PYTHONPATH=backend .venv/bin/python -m pytest -q
cd frontend && npm run build
```

With the backend running:

```bash
curl -sS http://127.0.0.1:8000/health | python3 -m json.tool

curl -sS \
  'http://127.0.0.1:8000/api/voice/preflight?voice_speech_path=nvidia_gradium' \
  | python3 -m json.tool

curl -sS -X POST http://127.0.0.1:8000/api/voice/prepare \
  -H 'content-type: application/json' \
  -d '{"voice_speech_path":"nvidia_gradium"}' \
  | python3 -m json.tool
```

## Cekura

Project details are in `AGENTS.md`.

```bash
./scripts/run_cekura.sh status
./scripts/run_cekura.sh sync
./scripts/run_cekura.sh run --wait --frequency 1
./scripts/run_cekura.sh triage
```

Keep `CEKURA_API_KEY`, `GRADIUM_API_KEY`, and webhook secrets in `.env.local`, shell environment, or CI secrets only.
