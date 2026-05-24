# Tutor-Tron Voice System

Browser-based end-to-end voice-agent system for Tutor-Tron.

Goal:

> Build the first ChatGPT Voice style interaction kernel: microphone input, turn-level STT, Flow-style speech-to-intent, streaming local LLM response, interruptible speech playback, and a configurable system prompt.

## Current Stack

- **LLM:** Ollama with `qwen3.5` by default.
- **Python AI/ML runtime:** `services/whisperx_adapter.py` owns WhisperX STT, speaker identity, and deterministic Flow-style speech transforms.
- **STT:** local WhisperX adapter behind `POST /api/stt`.
- **Speech input layer:** Wispr Flow-style `POST /api/speech-intent` rewrite that converts raw speech into the clearest user request before the tutor LLM sees it.
  - Backtrack/self-correction cleanup.
  - Filler removal, smart punctuation, and spoken list formatting.
  - Per-student dictionary corrections and voice snippets.
  - Writing style and language hint controls.
  - Recent speech history with raw/cleaned turns.
- **Turn-taking:** adaptive social-silence predictor that delays end-of-turn and assistant speech based on interruption feedback.
- **Speaker identity:** persistent per-student voice profiles behind `POST /api/speaker/*`.
  - Production target: NVIDIA NeMo Streaming Sortformer for online diarization and TitaNet-style speaker embeddings.
  - Local CPU fallback: SpeechBrain ECAPA embeddings until the NVIDIA runtime is available on GPU.
- **TTS:** Fish Audio / Fish Speech `s2-pro` through `POST /api/tts` when `FISH_API_KEY` is set.
- **Fallbacks:** browser STT and browser Web Speech TTS remain available for local debugging.
- **Prompting:** no hardcoded tutor answer path. The UI sends the current conversation plus the editable system prompt to the LLM.
- **Install surface:** the same voice core ships as a browser app and installable PWA for iPhone/Mac. A native Mac shell can wrap the same local server later for global hotkeys/background dictation.

## Run End-to-End

1. Pull the local LLM:

```bash
ollama pull qwen3.5
```

2. Install WhisperX:

```bash
npm run stt:install
```

3. Start the WhisperX adapter:

```bash
npm run stt
```

4. Start the web app in another terminal:

```bash
FISH_API_KEY=... TTS_PROVIDER=fish npm run dev
```

Without a Fish key, use:

```bash
TTS_PROVIDER=browser npm run dev
```

Open:

```text
http://localhost:3000
```

## iPhone and Mac Compatibility

The app is now installable as a PWA:

- iPhone/iPad: serve the app over HTTPS, open it in Safari, then use Share -> Add to Home Screen.
- Mac: open it in Safari or Chrome and install/add it to the Dock.
- The live voice path still calls the same Node + Python services, so the phone must reach the backend over the network.
- For production iPhone support, use HTTPS and keep STT/TTS server-side. Browser STT is only a fallback; WhisperX/server STT is the main path.

Recommended native path when we need OS-level control:

```text
shared web UI + Node API + Python AI runtime
-> PWA for iPhone/Mac now
-> thin Tauri/Electron Mac shell later for hotkey, background mic, and system audio routing
```

## Voice Interaction Path

```text
Browser mic
-> local VAD turn recorder
-> /api/stt
-> WhisperX adapter
-> parallel speaker identity service enrolls/checks student voice
-> /api/speech-intent applies Flow-style cleanup, snippets, dictionary, style, and intent rewrite
-> /api/chat
-> Ollama qwen3.5 streaming response
-> sentence TTS queue
-> Fish Audio TTS or browser TTS
-> browser speaker
```

## Interruption Path

Tutor-Tron uses verified barge-in. When local VAD hears speech over the tutor, the browser records a short overlap window while the speaker identity model and WhisperX run in parallel. Tutor audio is interrupted only when the overlap matches a saved student profile or the speaker identity service is unavailable and the transcript clearly looks like a student correction.

Normal voice turns are intentionally less aggressive than the interruption path: the recorder waits through natural pauses before submitting the turn, then the speech cleanup layer removes filler and false starts. Long, messy spoken input can become a concise question or bullet list before it reaches the tutor.

## Social Turn-Taking Loop

Tutor-Tron keeps a local per-student turn-taking profile:

```text
student speaks
-> VAD estimates stable silence instead of cutting on the first pause
-> tutor response is queued
-> tutor waits for socially acceptable silence before speaking
-> if student interrupts early, store the interruption point
-> increase future end-of-turn and speak-start silence thresholds
-> next response waits longer before speaking
```

Stored feedback includes:

```json
{
  "type": "interruption",
  "reason": "verified student barge-in",
  "msSinceAssistantStart": 1800,
  "assistantTextChars": 240,
  "nextEndSilenceMs": 2060,
  "nextAssistantStartSilenceMs": 1170
}
```

This is not model fine-tuning. It is a lightweight conversation policy loop that learns when this student tends to pause, restart, or interrupt.

```text
first normal user turn
-> active student profile enrolls and persists a voiceprint

student says "wait" / "stop" / correction during tutor speech
-> VAD captures possible barge-in in short windows
-> speaker identity model checks whether audio matches a saved student profile
-> WhisperX transcribes it in parallel
-> speaker identity rejects tutor self-audio
-> verified student voice stops tutor audio
-> accepted user barge-in aborts LLM + TTS
-> next user turn is sent to the LLM
```

Profile behavior:

```text
User A speaks -> update User A voice profile + User A local conversation memory
User B speaks -> update User B voice profile + User B local conversation memory
Future turns -> classify speaker against saved profiles, then route context to that user
```

Remote TTS audio can also enroll an assistant voiceprint. Browser `speechSynthesis` does not expose its raw audio, so browser TTS relies on the enrolled student voiceprint and model-based speaker matching.

This is slower than production streaming ASR. The production-grade model path is NVIDIA NeMo Streaming Sortformer, which is built for online diarization with speaker-cache behavior; the local CPU fallback keeps the system working on this machine.

## Configuration

Copy `.env.example` values into your shell or deployment environment.

Key variables:

```bash
VOICE_AGENT_PROVIDER=ollama
OLLAMA_MODEL=qwen3.5
STT_PROVIDER=whisperx
WHISPERX_URL=http://127.0.0.1:9001
SPEAKER_GUARD_URL=http://127.0.0.1:9001
SPEAKER_TARGET_MODEL=nvidia/diar_streaming_sortformer_4spk-v2.1
SPEAKER_MODEL=speechbrain/spkrec-ecapa-voxceleb
SPEAKER_PROFILE_STORE=data/speaker_profiles.json
SPEECH_INTENT_MODE=rewrite
TTS_PROVIDER=fish
FISH_API_KEY=...
FISH_TTS_MODEL=s2-pro
AGENT_SYSTEM_PROMPT="You are Tutor-Tron..."
```

## API Contracts

### Chat

```text
POST /api/chat
Content-Type: application/json
```

```json
{
  "systemPrompt": "You are Tutor-Tron...",
  "messages": [
    { "role": "user", "content": "Explain derivatives simply." }
  ]
}
```

Returns server-sent events:

```text
event: meta
event: token
event: warning
event: error
event: done
```

### STT

```text
POST /api/stt
Content-Type: audio/webm or audio/wav
```

Expected adapter response:

```json
{
  "text": "What is the derivative of x squared?",
  "segments": [],
  "language": "en"
}
```

### Flow-Style Speech Intent Rewrite

```text
POST /api/speech-intent
Content-Type: application/json
```

```json
{
  "rawText": "um okay so I think I am confused about like why this is not binomial because there are two outcomes but also no replacement",
  "mode": "rewrite",
  "flow": {
    "cleanupLevel": "high",
    "writingStyle": "tutor",
    "languageHint": "auto",
    "dictionary": [
      { "from": "hyper geometric", "to": "hypergeometric", "term": "hypergeometric", "starred": true }
    ],
    "snippets": [
      { "trigger": "quiz me", "text": "Ask me one short diagnostic question after the explanation." }
    ]
  }
}
```

Example response:

```json
{
  "text": "I am confused why this is not binomial. There are two outcomes, but the problem also says sampling is without replacement.",
  "rawText": "...",
  "mode": "rewrite",
  "changed": true,
  "flow": {
    "cleanup_level": "high",
    "writing_style": "tutor",
    "language_hint": "auto",
    "dictionary_applied": [],
    "snippets_applied": []
  }
}
```

Use `mode: "format"` to run only the deterministic local Flow formatter. Use `mode: "rewrite"` to run deterministic cleanup first and then let the configured LLM produce the final user intent. If the LLM is unavailable, the endpoint falls back to local Flow formatting instead of returning an unprocessed raw transcript.

Node prefers the Python endpoint at:

```text
POST http://127.0.0.1:9001/speech-intent
```

If the Python service is unavailable, Node uses its equivalent local formatter as a fallback so voice turns still work.

### TTS

```text
POST /api/tts
Content-Type: application/json
```

```json
{
  "provider": "fish",
  "text": "Let's work through it.",
  "speed": 1.02
}
```

Returns audio bytes for remote providers.

### Speaker Identity

The speaker identity service runs in the same local adapter as WhisperX:

```text
POST /api/speaker/enroll
POST /api/speaker/enroll-assistant
POST /api/speaker/classify
POST /api/speaker/reset
GET /api/speaker/profiles
```

All endpoints accept raw `audio/webm` or `audio/wav`.

Classification response:

```json
{
  "is_user": true,
  "reason": "user_similarity_pass",
  "user_similarity": 0.82,
  "assistant_similarity": 0.21,
  "profile_match": {
    "id": "user_a",
    "name": "User A",
    "similarity": 0.82,
    "samples": 3
  },
  "user_samples": 1,
  "assistant_samples": 0
}
```

## Test

```bash
node --check server.mjs
node --check web/app.js
python3.12 -m py_compile services/whisperx_adapter.py
npm run bench
```

Voice test framework:

```bash
npm run test:voice:api
```

Acoustic speaker-to-mic test:

```bash
npm run test:voice:acoustic
```

The acoustic test opens the browser UI, starts a voice session, uses macOS `say` to speak through your selected speaker, waits for Tutor-Tron to transcribe/respond, then speaks an interruption through the same speaker.

By default this acoustic test disables speaker-identity blocking immediately before the interruption so it can isolate the physical speaker-to-mic barge-in path. Speaker identity itself is covered by API tests and can be required in the acoustic run with:

```bash
VOICE_TEST_REQUIRE_SPEAKER_IDENTITY=1 npm run test:voice:acoustic
```

Requirements:

- macOS with `/usr/bin/say`
- Chrome installed
- speaker volume audible to the microphone
- Chrome microphone permission allowed
- `npm run stt` and `npm run dev` running, or equivalent services at `http://localhost:3000`

Useful overrides:

```bash
VOICE_TEST_SAY_VOICE=Samantha \
VOICE_TEST_USER_UTTERANCE="Explain derivatives with an example." \
VOICE_TEST_INTERRUPT_UTTERANCE="Wait, explain the exponent part again." \
npm run test:voice:acoustic
```

Preflight only:

```bash
npm run test:voice:preflight
```

Playwright stores traces, screenshots, videos, and text attachments under `test-results/`.

With the server running:

```bash
curl -N -s -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  --data '{"messages":[{"role":"user","content":"Give me one sentence about calculus."}],"systemPrompt":"You are concise."}'
```

Generate a local STT test file:

```bash
mkdir -p tmp
say -o tmp/stt-test.aiff "What is two plus two?"
ffmpeg -y -i tmp/stt-test.aiff tmp/stt-test.wav
curl -s -X POST http://localhost:3000/api/stt \
  -H 'Content-Type: audio/wav' \
  --data-binary @tmp/stt-test.wav
```

Speaker identity test:

```bash
say -v Samantha -o tmp/user-voice.aiff "Wait, I have a different question."
say -v Daniel -o tmp/assistant-voice.aiff "Derivatives measure change."
ffmpeg -y -i tmp/user-voice.aiff -ar 16000 -ac 1 tmp/user-voice.wav
ffmpeg -y -i tmp/assistant-voice.aiff -ar 16000 -ac 1 tmp/assistant-voice.wav
curl -s -X POST http://localhost:3000/api/speaker/reset
curl -s -X POST http://localhost:3000/api/speaker/enroll \
  -H 'Content-Type: audio/wav' \
  --data-binary @tmp/user-voice.wav
curl -s -X POST http://localhost:3000/api/speaker/classify \
  -H 'Content-Type: audio/wav' \
  --data-binary @tmp/assistant-voice.wav
```

## Next Build Targets

- Replace turn-based WhisperX with streaming ASR for lower interruption latency.
- Add Daily/Pipecat transport.
- Persist transcripts and latency traces.
- Add pitfall detection and active teaching strategy cache.
- Add eval-gated strategy promotion.
