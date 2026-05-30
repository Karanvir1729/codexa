# Voice Agent Architecture

## Runtime

The backend exposes the same assistant logic to browser voice, text-test endpoints, and Cekura WebSocket evaluations. The real-time browser stack has one supported provider set:

- STT: NVIDIA WebSocket ASR at `NVIDIA_ASR_URL`.
- LLM: NVIDIA Nemotron through an OpenAI-compatible `/v1` endpoint.
- VAD: Gradium semantic VAD over the Gradium ASR WebSocket.
- TTS: Gradium WebSocket TTS.

The old local/cloud provider fallbacks are not part of the runtime. Legacy env values are normalized to the supported providers only to keep stale `.env.local` files from crashing startup.

## Voice Flow

```text
Browser microphone
  -> Pipecat SmallWebRTC transport
  -> Gradium semantic VAD
  -> NVIDIA WebSocket STT
  -> runtime command/profile selection
  -> Nemotron chat completion
  -> optional Codex/Codexa delegation
  -> Gradium TTS
  -> browser speaker
```

`VOICE_SPEECH_PATH=nvidia_gradium` is the only browser speech path. Preflight rejects any runtime that is not `VOICE_RUNTIME=local_pipecat`, `LOCAL_STT_PROVIDER=nvidia_ws`, `LOCAL_TTS_PROVIDER=gradium`, and `LLM_PROVIDER=nemotron`.

## Feedback Loop

Every turn is written to SQLite with latency, provider, prompt version, runtime actions, and quality signals. Feedback and Cekura results feed the same evaluation tables so failures can become prompt constraints or regression coverage.
