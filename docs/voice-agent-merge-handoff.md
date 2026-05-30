# Voice Agent Merge Handoff

This branch preserves the working voice-agent path as a standalone integration surface for another app. Keep the voice runtime boundary intact and build new app features around the HTTP/WebRTC endpoints instead of replacing the pipeline internals.

## Preserved Runtime Path

- Browser transport: SmallWebRTC through `POST /api/offer`
- Production telephony transport: Twilio routes through the existing backend telephony path
- STT: Nemotron Speech Streaming over `NVIDIA_ASR_URL`
- LLM: Nemotron 3 Super 120B through `NEMOTRON_LLM_URL` and `NEMOTRON_LLM_MODEL`
- VAD/TTS: Gradium through `GRADIUM_API_KEY`, `GRADIUM_VAD_WS_URL`, and `GRADIUM_TTS_WS_URL`
- Browser speech path: `nvidia_gradium`
- Backend runtime: `VOICE_RUNTIME=local_pipecat`

## Required Environment

Set these in the target app environment, GitHub Actions secrets, Vercel/Cloud/Pipecat Cloud secrets, or the local `.env.local` file used by the operator. Do not hard-code them in source files.

```bash
LLM_PROVIDER=nemotron
VOICE_RUNTIME=local_pipecat
VOICE_SPEECH_PATH=nvidia_gradium
LOCAL_STT_PROVIDER=nvidia_ws
LOCAL_STT_MODEL=nemotron-speech-streaming
LOCAL_TTS_PROVIDER=gradium

NVIDIA_ASR_URL=ws://44.241.251.184:8080
NEMOTRON_LLM_URL=http://nemotron-fleet-alb-1322439314.us-west-2.elb.amazonaws.com/v1
NEMOTRON_LLM_MODEL=nvidia/nemotron-3-super

GRADIUM_API_KEY=<set in secret store>
GRADIUM_VAD_WS_URL=wss://api.gradium.ai/api/speech/asr
GRADIUM_TTS_WS_URL=wss://api.gradium.ai/api/speech/tts
GRADIUM_TTS_VOICE_ID=YTpq7expH9539ERJ
```

If Cekura evals are needed, also set `CEKURA_API_KEY` in the same secret store and configure the Cekura WebSocket URL to the deployed backend `/api/cekura/ws`.

## Integration Contract

The other app should treat this backend as the voice runtime service.

- `GET /health`: confirms the selected model/provider path and `voice_mainstream_ready`.
- `GET /api/voice/preflight?voice_speech_path=nvidia_gradium`: validates the STT, Gradium, LLM, and Codexa dependencies before opening voice.
- `POST /api/offer`: accepts the SmallWebRTC browser offer and starts the Pipecat voice pipeline.
- `POST /api/voice/text-test/turn`: text-mode regression path for the same voice brain.
- `POST /api/voice/text-test/audio`: Gradium TTS audio sanity path.
- `GET /api/voice/runtime-profile`: runtime tuning and recent voice quality state.

The frontend `Start` button should be the only user-facing action needed to begin a live listening session. `Mute` and `Unmute` only gate continuous mic input. `Push to talk` is a separate hold control, and the keyboard hold key is `P`.

## Merge Rules

1. Keep `backend/app/local_voice_runtime.py`, `backend/app/gradium_voice.py`, `backend/app/nvidia_ws_stt.py`, and `backend/app/main.py` together. They define the live voice path.
2. Keep `frontend/src/browserAudioMediaManager.ts` with the SmallWebRTC client. It preserves mic state during connection setup and prevents stale listening/processing states.
3. Preserve `VoiceSpeechPath = "nvidia_gradium"` in `frontend/src/api.ts`; do not reintroduce old speech providers into the browser voice path.
4. Keep `/api/voice/preflight` as the integration gate. The target app should call it before opening a WebRTC session.
5. Add new app features by consuming conversation IDs, turns, runtime profile, and orchestrator status. Avoid coupling new UI state directly into the Pipecat processors.

## Verification Before Handoff

Run:

```bash
./.venv/bin/python scripts/check_provider_readiness.py
./.venv/bin/python -m pytest backend/tests/test_feedback_loop.py backend/tests/test_mainstream_preflight.py
cd frontend && npm run build
```

Expected provider path:

```text
llm_provider=nemotron
model=nvidia/nemotron-3-super
local_stt_provider=nvidia_ws
local_stt_model=nemotron-speech-streaming
local_tts_provider=gradium
voice_speech_path=nvidia_gradium
```

## Secret Handoff

For hackathon handoff, give Karan the `.env.local` values through a private channel or configure them directly in the deployment secret store. The repo intentionally tracks examples and placeholders only, so the voice agent can be merged safely without leaking reusable credentials.
