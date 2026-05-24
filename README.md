# Tutor-Tron Voice Prototype

First prototype goal:

> Build the browser-based ChatGPT Voice style core loop for Tutor-Tron: continuous listening, interruptible tutor speech, streaming LLM output, and spoken AI answers.

This version is intentionally one browser session. It gives us the interaction kernel we can later replace with Daily/Pipecat, production ASR, production TTS, Redis events, eval workers, and the self-improvement loop.

## What Works Now

- Browser microphone input.
- Local VAD-style mic level meter.
- Continuous speech recognition in supported browsers.
- Barge-in interruption: say "wait", "stop", or "hold on" while the tutor is speaking to cancel the current LLM request and TTS queue. This avoids browser speaker echo being treated as a student turn.
- Streaming LLM response over server-sent events.
- Sentence-by-sentence TTS queue for lower perceived latency.
- TTS provider switcher:
  - Browser Web Speech API for zero-config local testing.
  - Fish Speech / Fish Audio `s2-pro` through `/api/tts` when `FISH_API_KEY` is configured.
  - OpenAI-compatible TTS through `/api/tts` when `OPENAI_API_KEY` is configured.
- WhisperX adapter endpoint at `/api/stt` for turn-level ASR once a WhisperX service is running.
- In-browser latency metrics for first token and first speech.
- CLI benchmark script for chat and remote TTS providers.
- Typed fallback input.
- Provider fallback order:
  1. OpenAI-compatible endpoint if `OPENAI_API_KEY` is set.
  2. Ollama at `http://127.0.0.1:11434` if available.
  3. Built-in tutor fallback so the app still works immediately.

## Run

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Chrome is the best browser for this prototype because it supports the Web Speech recognition API.

## Recommended Speech Stack

For this hackathon prototype:

- **TTS:** Fish Speech / Fish Audio S2-Pro is the preferred voice-quality path. It gives us expressive speech, voice references, and latency controls. Browser TTS remains the zero-config fallback.
- **STT:** WhisperX is useful for accurate turn transcripts, word-level timestamps, diarization, and eval/replay artifacts. For the live low-latency path, keep browser STT for v1 or swap to a streaming ASR service later. WhisperX is not the lowest-friction streaming ASR path.

Relevant implementation choices:

- `TTS_PROVIDER=fish` uses Fish Audio `/v1/tts`.
- `TTS_PROVIDER=openai` uses an OpenAI-compatible `/audio/speech` endpoint.
- `WHISPERX_URL=http://localhost:PORT` enables `/api/stt` proxying to `POST /transcribe`.

## Optional Local LLM

Run Ollama locally:

```bash
ollama pull llama3.2:3b
OLLAMA_MODEL=llama3.2:3b npm run dev
```

Or use an OpenAI-compatible endpoint:

```bash
OPENAI_API_KEY=... OPENAI_MODEL=gpt-4o-mini npm run dev
```

For a custom compatible endpoint:

```bash
OPENAI_API_KEY=... OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_MODEL=your-model npm run dev
```

## Fish Speech / Fish Audio TTS

```bash
FISH_API_KEY=... TTS_PROVIDER=fish FISH_TTS_MODEL=s2-pro npm run dev
```

Optional voice reference:

```bash
FISH_REFERENCE_ID=your_voice_model_id FISH_API_KEY=... TTS_PROVIDER=fish npm run dev
```

Latency/quality trade-off:

```bash
FISH_LATENCY=low FISH_API_KEY=... TTS_PROVIDER=fish npm run dev
FISH_LATENCY=balanced FISH_API_KEY=... TTS_PROVIDER=fish npm run dev
FISH_LATENCY=normal FISH_API_KEY=... TTS_PROVIDER=fish npm run dev
```

## WhisperX Adapter

The app exposes a provider-neutral STT proxy:

```text
POST /api/stt
Content-Type: audio/webm or audio/wav
```

Set:

```bash
WHISPERX_URL=http://localhost:9001 npm run dev
```

Expected service contract:

```text
POST $WHISPERX_URL/transcribe
raw audio body -> { "text": "...", "segments": [...] }
```

This keeps WhisperX behind a replaceable service boundary. The browser still uses Web Speech recognition for live v1 testing.

## Benchmark

With the dev server running:

```bash
npm run bench
```

Remote TTS benchmark:

```bash
BENCH_TTS_PROVIDER=fish FISH_API_KEY=... npm run bench
BENCH_TTS_PROVIDER=openai OPENAI_API_KEY=... npm run bench
```

The benchmark reports provider health, LLM first-token latency, total chat latency, TTS generation time, and returned audio size for remote TTS.

## Interaction Path

```text
Browser mic
-> speech recognition transcript
-> local Node streaming chat API
-> Ollama/OpenAI-compatible/fallback tutor
-> streamed text tokens
-> sentence TTS queue: Fish/OpenAI/browser
-> browser speaker
```

Interruption path:

```text
student starts speaking while tutor talks
-> local VAD / speechstart event
-> abort in-flight LLM request
-> cancel speechSynthesis
-> listen for corrected student turn
```

## Next Build Targets

- Replace browser speech recognition with streaming ASR for production.
- Run a local/hosted Fish Speech service or Fish Audio API with a stable Tutor-Tron voice.
- Add WhisperX turn-level transcript storage for eval/replay.
- Add Daily/Pipecat transport.
- Emit Redis-style event contracts from every turn.
- Add pitfall detection and active teaching strategy cache.
- Add eval-gated strategy promotion.
