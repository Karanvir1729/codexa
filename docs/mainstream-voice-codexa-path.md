# Mainstream Voice-To-Codexa Path

The mainstream path is now a single provider contract:

```text
voice_speech_path = nvidia_gradium
stt_provider      = nvidia_ws
llm_provider      = nemotron
vad_provider      = gradium
tts_provider      = gradium
```

## Configuration

```bash
LLM_PROVIDER=nemotron
NEMOTRON_LLM_URL=http://nemotron-fleet-alb-1322439314.us-west-2.elb.amazonaws.com/v1
NEMOTRON_LLM_MODEL=nvidia/nemotron-3-super

VOICE_RUNTIME=local_pipecat
VOICE_SPEECH_PATH=nvidia_gradium
LOCAL_STT_PROVIDER=nvidia_ws
NVIDIA_ASR_URL=ws://44.241.251.184:8080

LOCAL_TTS_PROVIDER=gradium
GRADIUM_API_KEY=
GRADIUM_VAD_WS_URL=wss://api.gradium.ai/api/speech/asr
GRADIUM_TTS_WS_URL=wss://api.gradium.ai/api/speech/tts

CODEX_ORCHESTRATOR_ENABLED=true
CODEX_ORCHESTRATOR_BASE_URL=http://127.0.0.1:4317
```

## Backend Components

- `backend/app/nvidia_ws_stt.py`: first-party Pipecat STT service for the unauthenticated NVIDIA ASR WebSocket.
- `backend/app/gradium_voice.py`: Gradium semantic VAD processor, Gradium Pipecat TTS service, and text-test TTS helper.
- `backend/app/llm.py`: OpenAI-compatible Nemotron client without an auth requirement.
- `backend/app/local_voice_runtime.py`: Pipecat browser voice pipeline wiring.
- `backend/app/voice_text_test.py`: Cekura/text-mode voice turn runner using the same runtime policy.

## Preflight

`GET /api/voice/preflight?voice_speech_path=nvidia_gradium` validates:

- `VOICE_RUNTIME=local_pipecat`
- `LOCAL_STT_PROVIDER=nvidia_ws`
- `NVIDIA_ASR_URL` is set
- `LLM_PROVIDER=nemotron`
- `NEMOTRON_LLM_URL` and `NEMOTRON_LLM_MODEL` are set
- `LOCAL_TTS_PROVIDER=gradium`
- `GRADIUM_API_KEY` is set
- Codex/Codexa orchestration is enabled

`POST /api/voice/prepare` performs the same checks before a WebRTC connection starts.

## Text And Audio Testing

```bash
curl -sS -X POST http://127.0.0.1:8000/api/voice/text-test/turn \
  -H 'content-type: application/json' \
  -d '{"message":"Say hello and report the active provider stack.","voice_speech_path":"nvidia_gradium"}'

curl -sS -o /tmp/voice-agent-text-audio.wav \
  -X POST http://127.0.0.1:8000/api/voice/text-test/audio \
  -H 'content-type: application/json' \
  -d '{"text":"Demo readiness audio check.","voice_speech_path":"nvidia_gradium"}'
```

## Cekura

Cekura connects to `/api/cekura/ws`. Text-mode Cekura turns route through `run_voice_text_turn`, which records assumed-STT voice turns, latency traces, runtime actions, flow state, and prompt metadata in SQLite.
