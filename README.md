# Agentic Coding Assistant

Desktop-first end-to-end voice-agent system for an agentic coding assistant, with a Python AI/ML runtime and Electron shell.

Goal:

> Build the first ChatGPT Voice style interaction kernel: microphone input, turn-level STT, Flow-style speech-to-intent, streaming local LLM response, spoken playback, and a configurable system prompt.

## Current Stack

- **LLM:** Ollama with `qwen3.5` by default.
- **Python AI/ML runtime:** `services/whisperx_adapter.py` owns WhisperX STT, speaker identity, and deterministic Flow-style speech transforms.
- **STT:** local WhisperX adapter behind `POST /api/stt`.
- **Speech input layer:** Wispr Flow-style `POST /api/speech-intent` rewrite that converts raw speech into the clearest user request before the assistant LLM sees it.
  - Backtrack/self-correction cleanup.
  - Filler removal, smart punctuation, and spoken list formatting.
  - Per-user dictionary corrections and voice snippets.
  - Writing style and language hint controls.
  - Recent speech history with raw/cleaned turns.
- **Turn-taking:** adaptive social-silence predictor that delays end-of-turn and assistant speech until the user has finished a turn.
- **Speaker identity:** persistent per-user voice profiles behind `POST /api/speaker/*`.
  - Production target: NVIDIA NeMo Streaming Sortformer for online diarization and TitaNet-style speaker embeddings.
  - Local CPU fallback: SpeechBrain ECAPA embeddings until the NVIDIA runtime is available on GPU.
- **TTS:** Fish Audio / Fish Speech `s2-pro` through `POST /api/tts` when `FISH_API_KEY` is set.
- **Fallbacks:** browser STT and browser Web Speech TTS remain available for local debugging.
- **Prompting:** no hardcoded coding answer path. The UI sends the current conversation plus the editable system prompt to the LLM.
- **Codex pilot mode:** optional voice-command route that sends cleaned user intent to the Codex CLI so the desktop agent can inspect, edit, test, and operate the target workspace.
- **Desktop shell:** Electron starts/reuses the Node API and Python STT/ML service, opens Agentic Coding Assistant in a native desktop window, and exposes the test dashboard/logs from the app menu.
- **Install surface:** the same voice core also ships as a web/PWA surface for iPhone/Mac testing.

## Run End-to-End

Requires Node.js `>=22.12` for the Electron desktop runtime.

1. Pull the local LLM:

```bash
ollama pull qwen3.5
```

2. Install WhisperX:

```bash
npm run stt:install
```

3. Start the desktop app:

```bash
npm run desktop
```

The Electron shell starts the Python STT/ML service and Node API if they are not already running. It reuses existing services on ports `9001` and `3000` when present.

Manual service mode is still available:

```bash
npm run stt
npm run dev
```

Open:

```text
http://localhost:3000
```

Open the local QA dashboard:

```text
http://localhost:3000/test-dashboard.html
```

## Desktop App

Run:

```bash
npm run desktop
```

The desktop app provides:

- native Electron window for Agentic Coding Assistant
- automatic Python STT/ML service startup
- automatic Node API startup
- microphone permission handling for the local app
- menu shortcuts:
  - `Cmd/Ctrl+1`: Voice App
  - `Cmd/Ctrl+2`: Test Dashboard
  - Provider Health JSON
  - Open Logs Folder
  - Reload / DevTools

Desktop logs:

```text
tmp/desktop-api.log
tmp/desktop-stt.log
```

## Codex Pilot Mode

Turn on **Codex pilot mode** in the left control panel when a voice turn should be handled by Codex instead of the fast assistant LLM.

The route is the same for spoken and typed coding turns:

```text
voice/audio turn -> WhisperX STT -> Flow-style speech intent cleanup
typed text turn  -----------------------------------------------+
                                                               |
                                                               v
-> /api/codex/exec
-> OpenClaw local control plane
-> Codex provider edits/checks the target workspace
-> spoken summary back through the same TTS queue
```

Codex pilot mode now has a **Codex control plane** selector:

- **Direct Codex CLI:** current repo-local `codex exec` path.
- **OpenClaw controls Codex/system:** sends the voice turn through `openclaw agent --local`; OpenClaw is the controller, and coding work should be delegated to the Codex CLI in the target workspace.
- **Auto:** tries OpenClaw when available, then falls back to direct Codex.

Default behavior:

- Routes voice coding turns through OpenClaw by default, with direct Codex CLI still available from the selector.
- Routes typed coding turns through the same project/session/workspace/control-plane path as voice. The text box is not a separate lightweight chatbot.
- Infers project mode from the request: explicit "new project", "new app", or "from scratch" starts a fresh generated workspace; "current repo", "existing project", or fix/update/debug language stays on the existing project path.
- Uses the project-local `@openai/codex` CLI from `node_modules/.bin/codex`.
- Runs in `workspace-write` sandbox mode.
- Uses non-interactive approval mode `never`.
- Runs code/build requests in a target workspace. Existing-project chats default to this repo; new-project chats are placed under `~/agentic-coding-projects/` so generated apps show up as standalone Codex projects. Legacy `tmp/codex-workspaces/` paths are still accepted, and an explicit `workspaceDir` can be passed to `/api/codex/exec`.
- Shows the active target workspace in the Codex pilot state while a control turn is running.
- Registers generated projects with a normal Codex Desktop app chat in that same folder so they appear under Codex Projects. `codex exec` history alone is not enough for sidebar project visibility.
- The Codex pilot prompt requires real file edits plus focused checks for build requests; it should not answer with canned demo code.
- Keeps the final answer concise so it can be spoken.

Useful env overrides:

```bash
CODEX_PILOT_ENABLED=1
CODEX_PILOT_COMMAND=/path/to/codex
CODEX_PILOT_MODEL=gpt-5-codex
CODEX_PILOT_SANDBOX=workspace-write
CODEX_PILOT_TIMEOUT_MS=300000
CODEX_WORKSPACE_ROOT=~/agentic-coding-projects
CODEX_CONTROL_PROVIDER=openclaw
CODEX_APP_CHAT_REGISTRATION=1
CODEX_APP_CHAT_COMMAND=/Applications/Codex.app/Contents/Resources/codex
CODEX_APP_CHAT_TIMEOUT_MS=90000
OPENCLAW_LOCAL=1
OPENCLAW_TIMEOUT_SECS=180
OPENCLAW_THINKING=off
```

For full-machine control, Codex itself must be configured for that level of access. The default desktop route intentionally keeps voice-triggered edits inside this repository.

OpenClaw control-plane smoke test:

```bash
npm run openclaw:control:test
```

Generic coding-control smoke test:

```bash
npm run codex:calculator:test
```

That test asks the voice Codex route to build a calculator app in a throwaway workspace, then verifies the generated files and runs the generated test script. The runtime path is not calculator-specific; the calculator is only the test task.

## Project and Call History

The app starts each work session from an explicit context picker:

- choose an existing project or create a new one
- open an existing chat/call history item
- start a new chat attached to the selected project

Session history is stored locally in:

```text
data/voice-sessions.json
```

That file is intentionally ignored by git. Browser, typed, and phone-bridge turns can all be attached to the same session model, so the receptionist can resume the right work context instead of treating every call as a blank chat.

## Phone Calls Without Rebuilding Voice Infra

Do not hand-roll Twilio audio transport. The phone path should use Pipecat:

```text
Twilio call
-> Twilio Media Streams
-> Pipecat FastAPIWebsocketTransport + TwilioFrameSerializer
-> STT / LLM-or-Codex-pilot / TTS pipeline
-> Twilio caller
```

Architecture decision:

```text
docs/architecture/voice-telephony-stack-decision.md
```

Local free-tier development flow:

1. Create a Twilio trial account and trial voice number.
2. Expose the local Pipecat bot with ngrok.
3. Configure a TwiML Bin with `<Connect><Stream url="wss://YOUR_NGROK_DOMAIN/ws" />`.
4. Assign the TwiML Bin to the trial number.
5. Call from a verified caller ID.

The repo now includes a local Pipecat/Twilio bot:

```bash
npm run phone:install
npm run phone
```

Expose it from a second terminal:

```bash
ngrok http 7860
```

Then wire the claimed Twilio number to the runner's generated TwiML endpoint:

```bash
npm run twilio:configure
```

That writes `TWILIO_WEBHOOK_BASE_URL` and `PIPECAT_PUBLIC_WS_URL` to `.env` and configures the Twilio number's Voice webhook to `POST https://YOUR_NGROK_DOMAIN/`. Pipecat's runner returns TwiML that connects the call to `wss://YOUR_NGROK_DOMAIN/ws`.

The first call may take longer because local Whisper and Kokoro models can download/warm up. The current phone runtime uses:

- Twilio Media Streams transport through Pipecat's runner.
- Local Whisper STT through `WhisperSTTService`.
- Local Ollama `qwen3.5` through `OLLamaLLMService`.
- Local Kokoro TTS through `KokoroTTSService`.

Production/demo path:

```text
Twilio number -> Pipecat Cloud Twilio WebSocket endpoint -> Agentic Coding Assistant Pipecat bot
```

### Test the Phone Brain Without Calling

Use this to test the same Codex bridge used by the phone bot without dialing Twilio:

```bash
npm run phone:test:codex
```

Use this to check the Twilio/Pipecat/ngrok wiring without placing a call:

```bash
npm run phone:test:stack
```

The local QA dashboard also has a **No-call phone test** button:

```text
http://localhost:3000/test-dashboard.html
```

## OpenClaw System-Control Path

OpenClaw is installed as the local system-control layer for growing Agentic Coding Assistant from "voice talks to Codex" into "voice can operate the development environment."

Readiness:

```bash
npm run openclaw:readiness
```

Foreground gateway for local dev:

```bash
npm run openclaw:gateway
```

Design note:

```text
docs/architecture/openclaw-codex-system-control.md
```

Pipecat remains the realtime voice runtime. OpenClaw is the broader control plane for full-system actions and Codex/plugin routing.

## Manual Web Mode

Start the WhisperX adapter:

```bash
npm run stt
```

Start the web app in another terminal:

```bash
FISH_API_KEY=... TTS_PROVIDER=fish npm run dev
```

Without a Fish key, use:

```bash
TTS_PROVIDER=browser npm run dev
```

## iPhone and Mac Compatibility

The app now has a native Electron desktop shell plus an installable PWA:

- iPhone/iPad: serve the app over HTTPS, open it in Safari, then use Share -> Add to Home Screen.
- Mac: use `npm run desktop` for the native shell, or install the PWA from Safari/Chrome.
- The live voice path still calls the same Node + Python services, so the phone must reach the backend over the network.
- For production iPhone support, use HTTPS and keep STT/TTS server-side. Browser STT is only a fallback; WhisperX/server STT is the main path.

Recommended native path when we need OS-level control:

```text
shared web UI + Node API + Python AI runtime
-> Electron desktop shell now
-> PWA for iPhone now
-> later: packaged Mac build with hotkey, background mic, and system audio routing
```

## Voice Interaction Path

```text
Device mic
-> local VAD turn recorder
-> /api/stt
-> WhisperX adapter
-> parallel speaker identity service enrolls/checks user voice
-> /api/speech-intent applies Flow-style cleanup, snippets, dictionary, style, and intent rewrite
-> /api/chat
-> Ollama qwen3.5 streaming response
-> sentence TTS queue
-> Fish Audio TTS or built-in device TTS
-> device speaker
```

## Testing Framework

Agentic Coding Assistant has a local Cekura-style QA harness with a dashboard, persisted run history, deterministic evals, browser tests, and acoustic voice-capture tests.

Dashboard:

```text
http://localhost:3000/test-dashboard.html
```

Runner commands:

```bash
npm run dev:loop
npm run dev:loop:watch
npm run test:voice:runner
npm run test:voice:eval
npm run test:voice:api
npm run test:voice:ui
npm run test:voice:acoustic
```

`npm run dev:loop` is the default build/test loop for active development. It runs syntax checks, then the dashboard-backed voice test runner. `npm run dev:loop:watch` polls source files and reruns the same loop whenever code changes.

Suites:

- `preflight`: verifies app, WhisperX, speech intent, speaker identity, and macOS speaker command.
- `eval`: deterministic voice-agent evals for provider health, Flow-style speech cleanup, assistant LLM streaming, and PWA installability.
- `api`: Playwright API contracts.
- `ui`: Playwright browser smoke tests for the main app and dashboard.
- `bench`: first-token and total response latency benchmark.
- `acoustic`: speaker-to-mic prompt capture test.

Test run artifacts are written to:

```text
data/test-runs/latest.json
data/test-runs/history.json
data/test-runs/dev-loop-latest.json
data/test-runs/<run-id>.json
```

Dashboard APIs:

```text
GET  /api/test-runs/latest
GET  /api/test-runs/history
POST /api/test-runs/run
```

Example:

```bash
curl -s -X POST http://localhost:3000/api/test-runs/run \
  -H 'Content-Type: application/json' \
  --data '{"suites":["preflight","eval","api","ui","bench"]}'
```

Use the full suite when you want the physical voice loop:

```bash
curl -s -X POST http://localhost:3000/api/test-runs/run \
  -H 'Content-Type: application/json' \
  --data '{"suites":["preflight","eval","api","ui","bench","acoustic"]}'
```

## GCP Test Infrastructure Path

The local runner is intentionally container-friendly. With GCP credits, the useful hosted setup is:

- **Cloud Run service:** host the Agentic Coding Assistant API/dashboard container.
- **Cloud Run Jobs:** run `npm run test:voice:runner` on demand or on a schedule. Cloud Run jobs are designed for code that performs work and exits.
- **Pub/Sub:** trigger regression runs from failed sessions, prompt changes, strategy changes, or deploy events.
- **Cloud Storage:** store Playwright traces, audio snippets, failure traces, and replay artifacts.
- **Cloud SQL Postgres:** persist run history, eval scores, strategy versions, and promotion status.
- **Vertex AI Gen AI Evaluation:** add rubric-based or pairwise LLM judge scoring once the deterministic eval set is stable.
- **Cloud Monitoring/Logging/Trace:** alert on first-token latency, failed voice capture, eval regression, and STT/TTS provider failures.

References:

- Cloud Run overview: https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run
- Pub/Sub overview: https://docs.cloud.google.com/pubsub/docs/pubsub-basics
- Vertex AI Gen AI evaluation: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/evaluation-overview

## Interruption Path

Agentic Coding Assistant currently uses turn-based conversation. While the assistant is thinking or speaking, mic audio is ignored so the app does not transcribe its own TTS as user input. The next voice turn starts after the assistant finishes speaking.

Normal voice turns wait through natural pauses before submitting the turn, then the speech cleanup layer removes filler and false starts. Long, messy spoken input can become a concise question or bullet list before it reaches the assistant.

## Social Turn-Taking Loop

Agentic Coding Assistant keeps a local per-user turn-taking profile:

```text
user speaks
-> VAD estimates stable silence instead of cutting on the first pause
-> assistant response is queued
-> assistant waits for socially acceptable silence before speaking
-> wait for the assistant to finish speaking
-> increase future end-of-turn and speak-start silence thresholds only from explicit feedback events
-> next response waits longer before speaking
```

Stored feedback includes:

```json
{
  "type": "turn_timing_feedback",
  "reason": "user started speaking before the assistant was ready",
  "msSinceAssistantStart": 1800,
  "assistantTextChars": 240,
  "nextEndSilenceMs": 2060,
  "nextAssistantStartSilenceMs": 1170
}
```

This is not model fine-tuning. It is a lightweight conversation policy loop that learns when this user tends to pause or restart.

```text
first normal user turn
-> active user profile enrolls and persists a voiceprint

assistant finishes speaking
-> VAD captures the next user turn
-> speaker identity updates the active voice profile
-> WhisperX transcribes the completed turn
-> Flow-style cleanup rewrites the transcript into a clear request
-> next user turn is sent to the LLM or Codex pilot
```

Profile behavior:

```text
User A speaks -> update User A voice profile + User A local conversation memory
User B speaks -> update User B voice profile + User B local conversation memory
Future turns -> classify speaker against saved profiles, then route context to that user
```

Remote TTS audio can also enroll an assistant voiceprint. Browser `speechSynthesis` does not expose its raw audio, so browser TTS relies on the enrolled user voiceprint and model-based speaker matching.

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
AGENT_SYSTEM_PROMPT="You are Agentic Coding Assistant..."
TELEPHONY_STACK=pipecat
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
PIPECAT_PUBLIC_WS_URL=wss://YOUR_NGROK_DOMAIN/ws
DAILY_API_KEY=...
```

## API Contracts

### Chat

```text
POST /api/chat
Content-Type: application/json
```

```json
{
  "systemPrompt": "You are Agentic Coding Assistant...",
  "messages": [
    { "role": "user", "content": "Explain the failing calculator test and suggest the next fix." }
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
  "text": "Run the calculator tests and tell me what failed.",
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
  "rawText": "um okay so run the calculator tests first then fix the parser bug and summarize the files you changed",
  "mode": "rewrite",
  "flow": {
    "cleanupLevel": "high",
    "writingStyle": "assistant",
    "languageHint": "auto",
    "dictionary": [
      { "from": "coat x", "to": "Codex", "term": "Codex", "starred": true }
    ],
    "snippets": [
      { "trigger": "run tests", "text": "Run the focused test suite after making the change." }
    ]
  }
}
```

Example response:

```json
{
  "text": "Run the calculator tests first, fix the parser bug, and summarize the files changed.",
  "rawText": "...",
  "mode": "rewrite",
  "changed": true,
  "flow": {
    "cleanup_level": "high",
    "writing_style": "assistant",
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

The acoustic test opens the browser UI, starts a voice session, uses macOS `say` to speak through your selected speaker, waits for Agentic Coding Assistant to transcribe/respond, and verifies the turn-based voice loop.

Requirements:

- macOS with `/usr/bin/say`
- Chrome installed
- speaker volume audible to the microphone
- Chrome microphone permission allowed
- `npm run stt` and `npm run dev` running, or equivalent services at `http://localhost:3000`

Useful overrides:

```bash
VOICE_TEST_SAY_VOICE=Samantha \
VOICE_TEST_USER_UTTERANCE="Explain what you are changing before you edit." \
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
  --data '{"messages":[{"role":"user","content":"Give me one sentence about this repo."}],"systemPrompt":"You are concise."}'
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
say -v Daniel -o tmp/assistant-voice.aiff "I am running the focused test suite."
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

- Replace turn-based WhisperX with streaming ASR when lower-latency turn capture is needed.
- Add Daily/Pipecat transport.
- Persist transcripts and latency traces.
- Add coding-failure detection and an active tool/prompt strategy cache.
- Add eval-gated strategy promotion for coding workflows.
