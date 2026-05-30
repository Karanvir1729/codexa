# Voice Agent Feedback Engine

End-to-end voice agent scaffold for a high-reasoning, low-latency telephony agent that uses NVIDIA/open-weight model routing, Pipecat/Twilio voice transport, Codexa planning, and a first-party automated evaluation loop.

The goal is not just the best-sounding voice. The goal is a complete voice-agent system where calls, transcripts, feedback, evals, and prompt/model improvements form a continuous feedback loop.

The active browser voice-to-Codexa path is documented in detail at
[`docs/mainstream-voice-codexa-path.md`](docs/mainstream-voice-codexa-path.md).
That is the source of truth for the `supertone_parakeet` path, OpenRouter
Parakeet STT, Supertonic TTS, and Codexa HTTP orchestration.

For judges and collaborators, this README is the practical runbook. The deeper
architecture notes remain in `docs/`, but the usable setup, demo path, checks,
and remaining risks are captured here so the repo can be opened cold and run.

## Current Status

Built locally:

- FastAPI backend with health checks, chat endpoint, Twilio inbound webhook, feedback capture, prompt-versioning, and eval APIs.
- OpenAI-compatible LLM adapter supporting:
  - `mock` mode for free local testing.
  - Ollama mode for local real-model workflow tests.
  - NVIDIA NIM endpoint mode.
  - self-hosted local/AWS vLLM endpoint mode.
- Continuous feedback loop:
  - stores transcripts, feedback, latency records, eval runs, and prompt versions in SQLite.
  - converts low-rated user feedback into prompt improvements.
  - runs YAML eval suites and feeds failures back into the active agent prompt.
  - optionally reruns eval suites on a schedule so regressions feed back without a manual click.
  - exports positive examples and passing evals for later SFT/LoRA data prep.
- Twilio integration:
  - `/twilio/inbound` TwiML route.
  - Pipecat Cloud WebSocket shortcut support.
  - self-hosted Pipecat runtime module for STT/LLM/TTS pipeline wiring.
  - local Pipecat microphone/speaker runtime with WhisperX STT, Fish Speech/Kokoro TTS, Silero VAD, and VAD-driven interruption.
- React operator console:
  - session simulator.
  - feedback submission.
  - eval run controls.
  - scheduled eval start/stop controls.
  - prompt version visibility.
  - Pipecat Voice UI Kit device/mic panel with local media waveform and device selection.
  - Codexa voice surface with live readiness badge, session sync state, workflow
    flowchart, approval/status metadata, and a text-first task test composer.
- AWS deployment assets:
  - CloudFormation stack for GPU vLLM host.
  - Terraform scaffold.
  - CloudShell discovery/deploy/destroy scripts.
  - credit-safe deployment profile using `g5.xlarge`.
  - optional short benchmark profile for larger 49B Nemotron runs gated behind an explicit opt-in.
  - provider readiness checker for AWS, NVIDIA NIM, Twilio, Pipecat, and local backend.
- Cost controls:
  - deploy script refuses GPU launch without budget guardrail or `BUDGET_EMAIL`.
  - deploy script checks AWS Cost Explorer month-to-date account spend before GPU launch.
  - deploy script checks GPU quota before launch.
  - default GPU instance auto-stops after 4 hours.
  - budget and no-compute guardrail helper scripts are included.
  - app runtime blocks LLM calls when the local estimated spend cap would be exceeded.

Verified locally:

- Backend test suite passes: `96 passed`.
- Ruff check passes: `python -m ruff check app tests`.
- Frontend production build passes: `npm run build`.
- Eval runner passes.
- Training-data export works.
- Local Pipecat voice dependencies install on macOS with Homebrew `portaudio`.
- Mainstream readiness endpoints report OpenRouter STT, Supertonic TTS, and
  Codexa healthy when the local services are running.

## Hackathon Submission Checklist

- Browser voice demo uses Pipecat SmallWebRTC from the React operator console.
- Speech path is `supertone_parakeet`: OpenRouter-hosted NVIDIA Parakeet STT,
  NVIDIA/OpenAI-compatible LLM routing, Codexa planning/execution bridge, and
  Supertonic local TTS.
- Codexa is the visible work layer: the voice agent creates/resumes a Codexa
  session, sends planning/task messages to Codexa, surfaces Codexa approvals and
  status back in speech, and mirrors Codexa workflow nodes in the browser UI.
- `.env.demo.example` is the setup contract for the live demo; secrets stay blank
  in the repo and are filled only in ignored local env files.
- `/api/voice/preflight` checks STT, TTS, Codexa, LLM/runtime readiness before
  Connect so demo blockers are visible early.
- First-party eval and feedback loop is present through the operator console,
  SQLite turn/latency records, prompt versions, YAML eval suites, and exportable
  training data.
- Twilio/Pipecat Cloud is optional for the browser demo; use it only if a phone
  call is part of the final presentation.

## Demo Path In One Page

The final browser demo is not the starter flower-shop bot. It is a coding voice
agent that listens in the browser, plans through Codexa, and speaks back through
the same Pipecat WebRTC session.

```text
Browser operator console
  -> Pipecat SmallWebRTC
  -> FastAPI /api/offer
  -> OpenRouter audio transcription
  -> nvidia/parakeet-tdt-0.6b-v3
  -> NVIDIA/OpenAI-compatible chat model
  -> Codexa planning and Codex execution bridge
  -> Supertonic local TTS
  -> Pipecat audio response
```

The demo contract is enforced in backend preflight. If
`VOICE_SPEECH_PATH=supertone_parakeet`, the backend rejects misaligned config
unless all of these are true:

```bash
VOICE_RUNTIME=local_pipecat
LOCAL_STT_PROVIDER=openrouter
OPENROUTER_STT_MODEL=nvidia/parakeet-tdt-0.6b-v3
LOCAL_TTS_PROVIDER=supertonic
SUPERTONIC_LANGUAGE=na
CODEX_ORCHESTRATOR_ENABLED=true
```

Use `.env.demo.example` for the live setup. Secrets stay blank in Git and go
only in ignored local env files such as `.env.local`.

## Codexa Workflow

Codexa is the center of the demo, not just a health check. This repo is the
voice front door and Pipecat runtime; Codexa is the planning, project selection,
approval, and Codex execution layer that the voice agent controls.

Visible surfaces:

- This repo's voice console: open `https://localhost:5173`, choose `Voice`, and
  watch the `Codexa Voice` screen.
- The voice console header shows `Codexa live`, `Codexa down`, or
  `codexa synced` before and after Connect.
- The waveform badge row also shows Codexa readiness next to OpenRouter STT,
  Supertonic TTS, and SmallWebRTC.
- After a task attaches to Codexa, the `Codexa Flow` panel appears under the
  orb. It shows the synced Codexa workflow steps, current status, approval
  state, and a refresh button.
- The right-side variable drawer has a `Codexa` group with `base_url`,
  `session_id`, `project_id`, `task_id`, `requires_approval`, `approval_id`,
  `status`, `flowchart_nodes`, and `last_message`.
- The text-first composer on the same Voice screen can send a deterministic
  Codexa task without using the microphone. If Codexa returns a session, the
  response chip shows the Codex session id and approval state.
- The separate Codexa operator UI is at `http://127.0.0.1:4318`. Use that UI
  to inspect the full Codexa project/session/task view, worker status, pending
  planning questions, approvals, and Codex execution traces.
- The Codexa backend API is at `http://127.0.0.1:4317`; this repo talks to that
  API through `backend/app/codex_orchestrator.py`.

How a voice task moves through Codexa:

```text
User says "Build/fix/add/test..."
  -> browser microphone
  -> Pipecat SmallWebRTC
  -> OpenRouter Parakeet transcript
  -> local runtime classifies task/status/approval intent
  -> CodexOrchestratorBridge
  -> POST http://127.0.0.1:4317/agent/chat
  -> Codexa asks clarifying questions or selects/creates a project
  -> Codexa queues/updates a Codex session
  -> voice agent speaks Codexa's next question/status
  -> UI stores and displays session/project/task/approval metadata
  -> GET /api/voice/codex-orchestrator/status refreshes status and flowchart
```

The bridge keeps one Codexa session mapped to one voice conversation in the
SQLite `codex_orchestrator_sessions` table. Follow-up voice turns reuse the
same `codex_session_id` and `codex_project_id`, so answering Codexa's question
or saying "approve" continues the existing workflow instead of starting over.

Useful demo phrases:

```text
Build a small React todo app in a new project.
Use the existing voice-agent-hackathon project and inspect the README.
Approve it.
What is Codexa doing?
Show Codexa status.
```

Key implementation files:

- `backend/app/codex_orchestrator.py`: intent helpers, session mapping,
  `/agent/chat` delegation, `/codex/status` status fetch, flowchart filtering.
- `backend/app/local_voice_runtime.py`: decides when voice runtime actions
  should delegate to Codexa and records Codexa metadata with the turn.
- `backend/app/main.py`: preflight, prepare, text-test, and
  `/api/voice/codex-orchestrator/status` endpoints.
- `frontend/src/App.tsx`: `Codexa Voice` screen, readiness badge, `Codexa Flow`
  panel, raw Codexa variable group, and text-first task composer.
- `frontend/src/FlowStudio.tsx`: flow nodes can represent `codex_task` steps
  for agent workflows that intentionally hand work to Codexa.

## User Workflow

The intended demo workflow is a browser-first voice coding agent. The user sees
the voice app, speaks or types a task, watches Codexa attach to the task, and can
inspect the same work in the Codexa operator UI.

1. Start the backend, frontend, Codexa backend, Codexa UI, and Supertonic server.
   The expected local surfaces are `https://localhost:5173` for this app,
   `http://127.0.0.1:4318` for Codexa's operator UI, and
   `http://127.0.0.1:4317` for the Codexa API.
2. Open `https://localhost:5173` and choose `Voice` in the left rail. The page
   title should be `Codexa Voice`.
3. Confirm the header shows `voice standby` and either `Codexa live` or
   `codexa synced`. If it shows `Codexa down`, fix Codexa before clicking
   `Connect`; the preflight is designed to expose that failure early.
4. Keep the speech provider on `Supertonic`. This is the only visible demo
   speech path. It maps to `VOICE_SPEECH_PATH=supertone_parakeet`, OpenRouter
   Parakeet STT, Supertonic TTS, SmallWebRTC, and Codexa orchestration.
5. Choose `Agent` for the main demo. Use `Flow` only when you intentionally want
   the voice session to drive a published Flow Studio graph.
6. Choose `VAD` when the user should speak naturally and be detected by voice
   activity. Choose `Push` when the user should hold the spacebar while talking.
7. Click `Connect`. The UI runs `/api/voice/preflight`, prepares the voice path,
   opens a Pipecat SmallWebRTC session, requests microphone permission, attaches
   remote assistant audio, and changes the orb from `Ready` to connected states.
8. Speak a coding task such as "Use the existing project and inspect the README."
   The orb moves through `Listening`, `Processing`, and `Speaking`. The browser
   transcript records the user turn and assistant response.
9. When the task is a Codexa task, the backend creates or resumes a Codexa
   session through `/agent/chat`. The `Codexa Flow` panel appears below the orb
   with synced workflow nodes, current status, approval state, and the latest
   Codexa message.
10. Open `http://127.0.0.1:4318` beside the voice app to inspect the full Codexa
    project, session, task, worker status, planning questions, approvals, and
    Codex execution traces.
11. Answer Codexa follow-up questions by voice or through the `Send a task or
    reply` text box. Follow-up turns reuse the same Codexa session, so saying
    "approve it" or "show status" continues the existing workflow.
12. Use `Disconnect` at the end of the demo. It closes the WebRTC transport,
    releases the microphone path, and returns the voice UI to standby.

What the main `Codexa Voice` screen shows:

| Area | What the user sees | What it means |
| --- | --- | --- |
| Header badges | `voice standby`, `voice connected`, `Codexa live`, `Codexa down`, or `codexa synced` | Local WebRTC state and Codexa dependency/session state. `codexa synced` means a voice turn is mapped to a Codexa session. |
| Orb | Circular waveform with `Ready`, `Listening`, `Processing`, or `Speaking` | Live voice state. Before connection it also shows the active STT/TTS badges. |
| Mode controls | `Agent`, `Flow`, `Supertonic`, `VAD`, `Push` | The selected voice behavior, speech provider path, and input mode. These lock while connected so the running WebRTC session stays consistent. |
| Composer | `Send a task or reply`, `Send`, `Play`, and an audio player | Text-only task path for deterministic Codexa testing and Supertonic playback without microphone input. |
| Codexa Flow | Synced node row, current status, approval state, and refresh button | Visible proof that the voice task reached Codexa and that the browser is following Codexa's workflow state. |
| Variable drawer | `Voice`, `Codexa`, `Runtime`, and `TTS` variable groups | Raw state for demo debugging: session ids, project ids, task ids, approval ids, route, runtime actions, latency, provider config, and the last Supertonic payload. |

## UI Button Reference

Main navigation:

| Button | Where | What happens after clicking |
| --- | --- | --- |
| `Voice` | Left rail | Opens the primary `Codexa Voice` console. This is the main hackathon demo surface. |
| `Flow` | Left rail | Opens Flow Studio for graph-based agent workflows. Use this when the voice session should follow a published process graph. |
| `Testing` | Left rail | Opens the Live Ops/testing surface with conversation simulation, Browser Voice, Text Voice Test, eval controls, and runtime debug panels. |
| `Evals` | Left rail | Jumps to the Live Ops surface where regression runs and auto-eval state are visible. |
| `Runtime` | Left rail | Jumps to the Live Ops runtime panels for provider, latency, prompt, and cost state. |

`Codexa Voice` controls:

| Button | What happens after clicking |
| --- | --- |
| `Refresh` icon | Reloads health, prompt, eval, runtime, and voice preflight state. Use it before demo start or after restarting Codexa/Supertonic. |
| `Settings` icon | Toggles the compact runtime/settings panel for voice internals. |
| `Hide variables` / `Show variables` icon | Opens or closes the right variable drawer. The Codexa group is the fastest way to confirm `codex_session_id`, `project_id`, `task_id`, `status`, and approval metadata. |
| `Connect` | Runs voice preflight, verifies the `supertone_parakeet` contract, checks Codexa readiness, prepares speech services, creates the Pipecat client, requests mic access, sends the SmallWebRTC offer to `/api/offer`, attaches assistant audio, and changes the status to connected. If Codexa or speech dependencies are not ready, the UI shows the failure instead of silently connecting to the wrong path. |
| `Connecting` | Temporary disabled state while preflight, prepare, mic permission, and WebRTC negotiation are in progress. |
| `Disconnect` | Closes the Pipecat/WebRTC session, stops active mic routing, clears connected state, and returns the orb to standby. |
| `Mute` | Disables the microphone while staying connected. The assistant audio path remains active. |
| `Unmute` | Re-enables the microphone. If the browser needs permission, it prompts for microphone access. |
| `Hold Space` | Appears when `Push` input is selected. The button itself is disabled because the actual control is the spacebar: press and hold space to send mic audio, release it to stop. |
| `Agent` | Selects the free-form coding voice agent. Coding, status, and approval intents route through Codexa when `CODEX_ORCHESTRATOR_ENABLED=true`. Disabled while connected. |
| `Flow` | Selects graph-driven voice mode. The voice turn is attached to a published flow run rather than the free-form agent loop. Disabled while connected. |
| `Supertonic` | Selects the only demo speech provider path. It pins the UI to `supertone_parakeet`; there is no visible legacy or alternate cloud speech path in the app workflow. Disabled while connected. |
| `VAD` | Selects voice activity detection. The mic stays available and Pipecat detects start/stop speech automatically. Disabled while connected. |
| `Push` | Selects push-to-talk. The user holds the spacebar while speaking. Disabled while connected. |
| `Send` in the `Send a task or reply` composer | Calls `/api/voice/text-test/turn` with the typed message and active speech path. It appends the user/assistant turns, records Codexa metadata, updates the Codexa Flow panel when a session exists, and autoplays the generated Supertonic response when available. |
| `Play` in the composer | Replays the last text-test assistant response by calling `/api/voice/text-test/audio` and loading the returned audio into the browser player. |
| `Refresh Codexa status` icon | Calls `/api/voice/codex-orchestrator/status` for the current conversation/session and refreshes workflow nodes, status, approval fields, and latest Codexa message. |

Flow Studio controls:

| Button | What happens after clicking |
| --- | --- |
| `Validate` | Checks the graph for structural problems and updates the validation panel. Use this before publishing or connecting voice to a graph. |
| `Save` | Persists draft flow changes. It is disabled when there are no draft changes. |
| `Publish` | Publishes the saved graph version so a live runner or voice session can execute it. |
| `Start` | Starts a graph simulation run and highlights the active node as messages move through the graph. |
| `Add Node` | Opens the node picker. Choosing a node adds it to the canvas. `codex_task` nodes intentionally hand work to Codexa. |
| `Zoom out`, `Fit view`, `Zoom in` | Adjust the canvas viewport without changing graph behavior. |
| Node card drag | Moves the selected node on the canvas. |
| Inspector `Add` route | Adds an outgoing route from the selected node to another node with the chosen edge label. |
| Route remove icon | Deletes the selected route from the graph. |
| `Connect Flow` | Ensures the flow is published, prepares the voice path, creates a SmallWebRTC connection, starts or attaches a flow run, and links the highlighted graph node to live speech. |
| Flow `Disconnect` | Closes the flow voice WebRTC session and detaches the live graph run from microphone input. |
| Flow `Mute` / `Unmute` | Toggles microphone input for the active flow voice session. |
| Flow `Voice Activity Detection` | Selects VAD input for the flow voice session before connecting. |
| Flow `Push to Talk` | Selects spacebar push-to-talk for the flow voice session before connecting. |
| Flow `Supertonic` | Keeps the flow voice session on the same `supertone_parakeet` demo path as the main Voice screen. |
| `Interrupt current node` | Forces the next simulation message to interrupt the active behavior node, useful for testing barge-in and route behavior. |
| Flow simulation `Send` | Sends the typed simulation utterance to the active flow run and advances the highlighted node if a route matches. |

Live Ops and testing controls:

| Button | What happens after clicking |
| --- | --- |
| `Refresh` icon | Reloads health, prompt, eval, scheduler, cost, and runtime state. |
| `Good` | Marks the latest assistant turn as accurate feedback. This feeds the first-party improvement loop. |
| `Fix` | Marks the latest assistant turn as incorrect feedback. Low-rated feedback can become prompt-improvement input. |
| Sample prompt chips | Immediately submit a predefined test utterance into the text conversation loop. |
| Conversation `Send` | Sends the typed utterance to the chat endpoint and records the turn in the same feedback/eval store. |
| Browser Voice `Connect` / `Disconnect` | Runs the same browser SmallWebRTC path from the testing panel. It is useful for debugging while keeping runtime metrics visible. |
| Browser Voice `Agent`, `Flow`, `Supertonic`, `Voice Activity Detection`, `Push to Talk`, `Mute`, `Unmute` | Same behavior as the main `Codexa Voice` controls, shown alongside runtime metrics. |
| Text Voice Test `Turn` | Sends a final transcript directly through the voice text-test path, bypassing microphone/STT but still exercising the agent, Codexa bridge, TTS text rendering, and metadata recording. |
| Text Voice Test `Suite` | Runs the built-in text voice suite and shows pass/fail checks for each case. |
| Text Voice Test `Play TTS` | Synthesizes and plays the last text-test response through the configured TTS provider. |
| Evaluation `Run` | Runs the YAML eval suite and records aggregate score, failures, and latency. |
| Evaluation `Auto` | Starts scheduled evals. The button becomes `Stop` while the scheduler is running. |
| Evaluation `Stop` | Stops scheduled evals and leaves manual `Run` available. |

## Demo Quick Start

Install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e "backend[dev,voice]"
cd frontend
npm ci
cd ..
```

Prepare local demo env:

```bash
cp .env.demo.example .env.local
```

Fill the required keys and local service URLs in `.env.local`, then start the
supporting services:

```text
Codexa backend API:     http://127.0.0.1:4317
Codexa operator UI:     http://127.0.0.1:4318
Supertonic TTS server:  http://127.0.0.1:7788
Frontend console:       https://localhost:5173
Backend API:            http://127.0.0.1:8000
```

Start this app:

```bash
mkdir -p logs
set -a && source .env.local && set +a
PYTHONPATH=backend .venv/bin/python -m uvicorn app.main:app \
  --host 0.0.0.0 --port 8000 --log-level info
```

In another terminal:

```bash
cd frontend
npm run dev
```

Open `https://localhost:5173`, choose the Voice Agent console, confirm the
preflight badge says Codexa is live, then connect. For a deterministic smoke
test without microphone permissions, use the text/audio endpoints below.

## Readiness Checks

Run these before demo day:

```bash
cd backend
../.venv/bin/python -m pytest -q
../.venv/bin/python -m ruff check app tests
cd ../frontend
npm run build
```

With backend, Supertonic, and Codexa running:

```bash
curl -sS http://127.0.0.1:8000/health | python -m json.tool

curl -sS \
  'http://127.0.0.1:8000/api/voice/preflight?voice_speech_path=supertone_parakeet' \
  | python -m json.tool

curl -sS -X POST http://127.0.0.1:8000/api/voice/prepare \
  -H 'content-type: application/json' \
  -d '{"voice_speech_path":"supertone_parakeet"}' \
  | python -m json.tool

curl -sS -o /tmp/voice-agent-text-audio.wav \
  -w '%{http_code} %{content_type} %{size_download}\n' \
  -X POST http://127.0.0.1:8000/api/voice/text-test/audio \
  -H 'content-type: application/json' \
  -d '{"text":"Demo readiness audio check."}'
```

Expected readiness signals:

- `/health` returns `voice_mainstream_ready: true`.
- `/api/voice/preflight` returns `dependencies.stt.healthy: true`,
  `dependencies.tts.healthy: true`, and `dependencies.codex.healthy: true`.
- `/api/voice/prepare` returns `ready: true`.
- `/api/voice/text-test/audio` returns `200 audio/wav`.

The live LLM path should also be tested with:

```bash
curl -sS -X POST http://127.0.0.1:8000/api/voice/text-test/turn \
  -H 'content-type: application/json' \
  -d '{"text":"Hello, can you confirm the voice coding agent is ready?","voice_speech_path":"supertone_parakeet"}' \
  | python -m json.tool
```

If this returns `provider: llm-error` or times out, switch to a known-responsive
NVIDIA/OpenAI-compatible model before demo.

## Important Cost Boundary

There is no universal AWS switch that blocks every paid action, especially while using the root account. This project therefore uses practical guardrails:

- keep the default runtime in free local `mock` mode.
- require budget setup before GPU deployment scripts proceed.
- use the smallest practical NVIDIA GPU profile first.
- auto-stop GPU instances.
- keep quota low until a benchmark needs more.
- destroy GPU stacks immediately after testing.

AWS credits should be consumed before normal billing only if the credits are active and applicable to the launched service/region/instance type. Always verify credits and budgets in the AWS console before launching compute.

AWS applies eligible credits automatically before charging remaining eligible usage. This project still defaults to a `$95` local cap rather than `$100` so there is a buffer for delayed billing data, Cost Explorer checks, taxes, or non-eligible charges.

## Repository Secret Policy

Raw secrets are intentionally not committed.

Do not commit:

- AWS access keys or root credentials.
- NVIDIA API keys.
- Twilio auth tokens.
- Deepgram, Cartesia, or Pipecat credentials.
- `.env`, SQLite databases, generated exports, private keys, or local cloud config.

Use `.env.example` as the setup contract. Karan should create a local `.env` on his machine and fill in the values through a password manager, GitHub repository secrets, AWS IAM Identity Center, or short-lived least-privilege IAM credentials.

## Local Run

```bash
cp .env.example .env
python -m venv .venv
source .venv/bin/activate
pip install -e "backend[dev]"
./scripts/run_backend.sh
```

In another terminal:

```bash
cd frontend
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

The default `.env.example` uses:

```bash
LLM_PROVIDER=mock
```

That mode is intentionally free and does not call paid APIs.

For the fastest local real LLM profile, install Ollama and pull the Qwen 2.5 0.5B model:

```bash
./scripts/setup_ollama_local.sh
```

Then run the backend with:

```bash
LLM_PROVIDER=ollama \
OLLAMA_BASE_URL=http://localhost:11434/v1 \
OLLAMA_MODEL=qwen2.5:0.5b \
OLLAMA_KEEP_ALIVE=30m \
MAX_COMPLETION_TOKENS=24 \
./scripts/run_backend.sh
```

`qwen2.5:0.5b` is the default local real LLM because this repo prioritizes voice turn latency. The local profile keeps the model warm and caps completions tightly so evals and voice turns do not pay repeated cold-start or rambling-token latency. Swap `OLLAMA_MODEL` or `LLM_PROVIDER` to a hosted external model when you are ready for higher quality.

## Local Pipecat Voice

The mainstream browser voice path is `VOICE_SPEECH_PATH=supertone_parakeet`.
It uses Pipecat SmallWebRTC, OpenRouter Parakeet STT, the configured
OpenAI-compatible LLM, Codexa HTTP orchestration, and Supertonic TTS. The
older visible `current` speech path is no longer exposed.

The older local microphone/speaker notes below are retained for provider
experiments, but they are not the mainstream app path.

Install the local voice dependencies:

```bash
brew install portaudio
source .venv/bin/activate
pip install -e "backend[voice]"
./scripts/setup_ollama_local.sh
PYTHONPATH=backend .venv/bin/python scripts/prewarm_local_voice_models.py
```

Run the local Pipecat voice agent:

```bash
./scripts/run_local_voice.sh
```

Default local/cloud voice stack:

- Transport: Pipecat `LocalAudioTransport` using the Mac microphone and speaker.
- STT: Pipecat `WhisperSTTService` / Faster Whisper with multilingual `LOCAL_STT_MODEL=base` and `LOCAL_STT_LANGUAGE=auto`, which keeps Hindi/English input usable without the 2s+ CPU latency of `small`. Use `LOCAL_STT_PROVIDER=whisperx` or `LOCAL_STT_PROVIDER=nvidia` for heavier model paths.
- TTS: production target is a separate GPU-backed Fish Speech or Voxtral worker.
  `kokoro` is the CPU fallback that keeps the demo usable while GPU quota is
  unavailable. Keep `LOCAL_TTS_TEXT_AGGREGATION_MODE=sentence`; token-level
  aggregation makes local voices sound word-by-word.
- VAD/interruption: Pipecat Silero VAD with a 50 ms speech-start window, 120 ms speech-stop window, 120 ms user speech timeout, and 10 ms output chunks.
- LLM: Ollama OpenAI-compatible API using `qwen2.5:0.5b`.

On the first run, Kokoro downloads its ONNX model/voice files and Whisper downloads the selected Whisper model. macOS may ask for microphone permission for the terminal app. Speak over the assistant while it is talking to test interruption.

For NVIDIA speech, point Pipecat at an NVIDIA/NIM or Riva-compatible gRPC endpoint:

```bash
LOCAL_STT_PROVIDER=nvidia \
LOCAL_TTS_PROVIDER=nvidia \
NVIDIA_STT_SERVER=localhost:50051 \
NVIDIA_STT_USE_SSL=false \
NVIDIA_TTS_SERVER=localhost:50051 \
NVIDIA_TTS_USE_SSL=false \
./scripts/run_local_voice.sh
```

For remote Whisper experiments, point the app at a separately managed HTTP
worker:

```bash
LOCAL_STT_PROVIDER=remote_whisper \
LOCAL_STT_MODEL=large-v3-turbo \
REMOTE_WHISPER_BASE_URL=http://127.0.0.1:7001 \
./scripts/run_local_voice.sh
```

The remote Whisper interface accepts raw 16 kHz int16 PCM, defaults to
`large-v3-turbo`, and uses an RMS silence gate so quiet WebRTC tails do not
hallucinate filler text. This is a provider experiment, not the mainstream
browser demo path.

For an Apple-Silicon MLX fallback, switch provider and model explicitly:

```bash
LOCAL_STT_PROVIDER=mlx_whisper \
LOCAL_STT_MODEL=mlx-community/whisper-large-v3-turbo-q4 \
./scripts/run_local_voice.sh
```

For Fish Speech TTS, start the Fish Speech API server separately and keep this app pointed at it:

```bash
LOCAL_TTS_PROVIDER=fish_speech \
FISH_SPEECH_BASE_URL=http://127.0.0.1:8080 \
LOCAL_TTS_TEXT_AGGREGATION_MODE=sentence \
./scripts/run_local_voice.sh
```

Fish Speech S2 is a heavier TTS stack than Kokoro, so this repo integrates
with the Fish Speech HTTP server instead of vendoring the model weights into
the backend.

For Mistral Voxtral TTS, point the backend at an OpenAI-compatible vLLM-Omni
worker that you manage separately:

```bash
LOCAL_TTS_PROVIDER=voxtral \
VOXTRAL_TTS_BASE_URL=http://127.0.0.1:8001/v1 \
./scripts/run_local_voice.sh
```

These local/remote provider options are kept for experimentation. The demo UI
should stay on `Supertonic` unless the team intentionally changes the
architecture contract.

Local voice turns are written to the same SQLite `conversations` and `turns` tables as the text/API loop, so later eval export and feedback work against the same data store.

The local runtime cap is enabled by default:

```bash
COST_GUARD_ENABLED=true
COST_GUARD_CAP_USD=95
COST_GUARD_RESERVE_USD_PER_CALL=0.01
```

Every model call reserves estimated cost before the LLM request starts. If the next request would exceed the local cap, the API returns HTTP `402` and does not call the model provider.

## Docker Compose

```bash
cp .env.example .env
docker-compose up --build
```

The frontend container serves React through nginx on `http://localhost:8080` and proxies `/api`, `/health`, and `/twilio` traffic to the backend service.

## Provider Readiness

Run this before attempting real provider traffic:

```bash
./scripts/check_provider_readiness.sh
```

Add `--live` when credentials are present and you want to make real provider validation calls:

```bash
./scripts/check_provider_readiness.sh --live
```

Current known deployment reality:

- AWS GPU EC2 cannot be launched until AWS approves the rejected G/VT quota request.
- Hosted NVIDIA NIM is the immediate fallback for the high-reasoning model path.
- Twilio requires `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`.
- Local Pipecat voice uses `VOICE_RUNTIME=local_pipecat` and the open-source local dependencies above.
- Twilio Pipecat provider mode still requires either `PIPECAT_CLOUD_WS_URL` + `PIPECAT_CLOUD_SERVICE_HOST`, or `VOICE_RUNTIME=pipecat` with Deepgram and Cartesia keys.

An AWS quota appeal draft is in `docs/aws_quota_appeal.md`.

## NVIDIA NIM Mode

Set:

```bash
LLM_PROVIDER=nvidia
NVIDIA_API_KEY=<from NVIDIA>
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1.5
```

Use this when AWS GPU quota is blocked or when NVIDIA API trial access is available.

## AWS GPU vLLM Mode

Use AWS CloudShell from the logged-in AWS Console:

```bash
git clone <repo-url>
cd voice-agent-hackathon
./scripts/cloudshell_discover.sh
source /tmp/voice-agent-discovery/deploy.env
```

Create budget guardrails before launching compute:

```bash
BUDGET_EMAIL=you@example.com ./scripts/cloudshell_apply_credit_guardrails.sh
```

If GPU quota is zero, request the minimum credit-safe quota:

```bash
./scripts/cloudshell_request_gpu_quota.sh
```

Deploy the credit-safe profile:

```bash
./scripts/cloudshell_deploy_profiles.sh credit-safe
```

The deploy script runs `scripts/cloudshell_cost_guard.sh` before creating the GPU stack. It checks AWS Cost Explorer month-to-date unblended cost and refuses to deploy if projected spend would exceed `AWS_SPEND_CAP_USD`:

```bash
AWS_SPEND_CAP_USD=95 ./scripts/cloudshell_deploy_profiles.sh credit-safe
```

After the stack is ready, set the backend to the vLLM endpoint:

```bash
LLM_PROVIDER=local
LOCAL_LLM_BASE_URL=http://<instance-ip>:5000/v1
LOCAL_LLM_API_KEY=dummy
LOCAL_LLM_MODEL=nvidia/Llama-3.1-Nemotron-Nano-8B-v1
```

Destroy GPU compute when finished:

```bash
./scripts/cloudshell_destroy_vllm.sh
```

## Twilio + Pipecat

For Pipecat Cloud:

```bash
PIPECAT_CLOUD_WS_URL=wss://api.pipecat.daily.co/ws/twilio
PIPECAT_CLOUD_SERVICE_HOST=<agent>.<organization>
PUBLIC_BASE_URL=https://<your-api-host>
```

For self-hosted Pipecat:

```bash
pip install -e "backend[voice]"
VOICE_RUNTIME=pipecat
DEEPGRAM_API_KEY=<from provider>
CARTESIA_API_KEY=<from provider>
PUBLIC_BASE_URL=https://<your-api-host>
```

For local open-source voice without telephony:

```bash
VOICE_RUNTIME=local_pipecat
./scripts/run_local_voice.sh
```

Point the Twilio voice webhook to:

```text
POST https://<your-api-host>/twilio/inbound
```

## Evaluation Loop

Run locally:

```bash
cd backend
pytest
../scripts/run_eval.sh
```

Or use the operator console's `Run` button. Eval results and live feedback rebuild the active prompt version automatically.

To run the feedback loop continuously, either press `Auto` in the operator console or set:

```bash
EVAL_SCHEDULE_SECONDS=300
EVAL_SCHEDULE_APPLY_FEEDBACK=true
```

The scheduler exposes status at:

```text
GET /api/evals/scheduler
```

Export curated positive-feedback and passing-eval examples:

```bash
./scripts/export_training_data.sh
```

## Cekura External Testing

The first-party eval loop above is already runnable without external credits.
Cekura can be layered on top when the team has account access.

Codex MCP setup for a local developer machine:

```toml
[mcp_servers.cekura]
url = "https://api.cekura.ai/mcp"
```

For shared CI or project-scoped auth, use an API key instead of browser auth:

```bash
codex mcp add cekura --env CEKURA_API_KEY=YOUR_API_KEY_HERE -- \
  sh -c 'npx -y mcp-remote https://api.cekura.ai/mcp --header "X-CEKURA-API-KEY:$CEKURA_API_KEY"'
```

Recommended first Cekura coverage for this repo:

- Mainstream readiness: preflight rejects any path that is not
  `supertone_parakeet` and reports Codexa down before Connect.
- OpenRouter STT contract: Parakeet is selected and no legacy
  `remote_whisper` default leaks into the demo path.
- Supertonic TTS contract: `SUPERTONIC_LANGUAGE=na` is passed through to the TTS
  payload and audio returns WAV.
- Codexa planning bridge: a coding request creates or resumes a Codexa session,
  returns a user-facing plan/status, and stores Codexa metadata with the turn.
- Interruption behavior: user speech during assistant audio interrupts playback
  and records interruption metrics.
- Flow mode: selected voice flow variables mutate only through the runtime action
  bridge and produce visible variable badges.
- LLM fallback: a provider timeout returns a graceful spoken apology and records
  `llm-error` without crashing the WebRTC session.
- Eval feedback loop: a failed local YAML eval is stored, reflected in
  `/api/self-learn`, and can create a new prompt version.

Good first Codex prompt after Cekura auth:

```text
Use the Cekura MCP to list my agents, read this repo's voice endpoints and
prompt/eval files, then create 10 evaluators for the mainstream
supertone_parakeet browser voice path. Use /api/voice/text-test/turn for
deterministic text-first coverage and reserve live WebRTC cases for final smoke.
```

For repeatability, keep Cekura's seed/reset webhooks pointed at a lightweight
local test hook or a staging database. The agent records conversations, turns,
feedback, latency metrics, eval runs, and prompt versions in SQLite, so each
external run should use an isolated database file or a cleanup hook.

## What Still Needs To Be Done

- Re-test the live NVIDIA/OpenAI-compatible LLM before demo. The dependency
  preflight can pass while a slow model still times out during a full text turn.
- Fix or accept the current frontend dependency audit result: `npm ci` reports
  five moderate vulnerabilities.
- Add Cekura credentials and create the external evaluators once dashboard
  access is available.
- Connect a public HTTPS tunnel or hosted API URL if Twilio phone-call testing
  is part of the presentation.
- Add real provider credentials locally for Twilio, Pipecat Cloud, or
  Deepgram/Cartesia only if the phone path becomes required.
- Wait for AWS GPU quota approval if the account currently has `0` G/VT GPU vCPU
  quota, then deploy the `credit-safe` AWS profile after budget and quota are
  ready.
- Confirm AWS credits are active and applicable to the selected GPU instance
  type and region.
- Run Fish Speech or another production-grade multilingual/multi-speaker TTS
  server on a GPU box if Supertonic is replaced.
- Add WhisperX alignment/diarization as a post-call eval step for word-level timing; the live loop already uses WhisperX ASR without alignment to protect turn latency.
- Run a live phone-call test through Twilio.
- Expand latency benchmarking around Twilio media stream, Pipecat transport, STT, model first token, TTS first audio, and end-to-end turn-taking.
- Add more eval suites for:
  - interruption handling.
  - tool-call correctness.
  - safety boundaries.
  - latency regression.
  - voice-call recovery after STT/TTS errors.
- Add a scheduled eval job and dashboard trend charts.
- Convert exported examples into a real fine-tuning or LoRA preparation pipeline once enough data exists.
- Replace root-account AWS usage with least-privilege IAM or IAM Identity Center access for collaborators.

## Prompt Trail

The project was built from these user prompts:

```text
I want you to use NVIDIA's LLM, so find the state-of-the-art open-weight models, and then we're going to use my AWS account compute to create high-reasoning voice engines. And then we're going to use PipeCat's high-performance infrastructure and Twilio's telephony to optimize network performance and eliminate latency. And then later on, we will implement Secure's automated testing and evaluation platform to move forward. So it needs to, you need to create a system where evaluation data flows back into the agent to improve performance, reliability, and accuracy over time. So go build it. It needs to be, it's not just the best sounding voice, it's the best system. Your challenge is to build a voice agent that utilizes a continuous feedback loop. Okay, none of this should be hard-coded. Everything on this should be properly functional, end-to-end, properly working by the end of your response. Fully functional systems, implement your own automated testing and evaluation platform to move forward because we are not, we don't have the credits for Secure. So right now, what I want you to do is build the entire thing, end-to-end, fully. I'll give you my AWS credentials once you ask for it, and precisely ask for what you want. Nvidia, I believe you can access open-weight models yourself. If you need anything from me for Nvidia, I can happily provide you whatever you want. But your goal is to build everything end-to-end, build this entire thing. I want you to use voice UI kits from PipeCat as well. And this is not just, you're not starting from square one, no. We're gonna use already-made systems and collect them, collectively use them to make a better system. So go ahead and build.
```

```text
I don't know where to get any of these from, I allow you to use my entire chrome browser and access the aws account, as for the nvidia if you can find some way of getting the api credits for that model or just go through aws that would be best but it should satisfy what I originally asked for. 
"Leveraging and customizing SOTA open weights models
Infrastructure and network optimization
Auto-Improvement harness
We aren't just looking for the best-sounding voice; we are looking for the best system. Your challenge is to build a voice agent that utilizes a continuous feedback loop:

Build & Customize: Leverage NVIDIA-accelerated SOTA open-weights models and AWS compute to create high-reasoning voice engines.
Deploy at Scale: Use Pipecat’s high-performance infrastructure and Twilio's telephony to optimize network performance and eliminate latency."
```

```text
We have $100 in cloud credits can't we use that inside of amazon, nothing paid, all free.
```

```text
can you set everything up? and make it so AWS blocks all paid calls. Fully set everything using my chrome browser.
```

```text
You can open up my Gmail on Mehar (work) in chrome browser. Check all the latest emails. And recheck.
```

```text
No check the chrome profile (Mehar (work))
```

```text
push changes to a repo, add Karanvir1729, make a readme file with the current stuff that is done. and stuff that needs to be done along with all the prompts that I have given you so far. make the repo private and push all the secrets too so that karan can work on his device.
```

```text
Okay, so if we're using NVIDIA for a high-resing model, can't we just use a local model to just test things out first? I have Olama installed. I feel there should be a very fast open-source model that you can install on my own computer. Make sure that model is less than a gigabyte, and you could use actually a Quinn, like a few hundred million parameter models, and just make that entire workflow almost instant. Like, we wanna just test the voice agent, right? The backend model can be changed constantly. The high-resing model, it's going to be a bit tough to navigate, so currently what we need to do is use a self-hosted pipeline for the pipecat, and see if our current system even works, right? And then once later on, we can incorporate the AWS GPU and other things. And for now, if possible, can you open up a case and make that use case more specific on why we need this GPU usage, because AWS is not letting us use the GPU, right? So we need that, otherwise we can't even do this hackathon. So go ahead and actually do this, because I don't wanna run this, I wanna actually try this out, make changes, and try to get this done.
```

```text
does the voice agent work? can I talk, does interruption work?
```

```text
Why the hell are we using the browser stuff, take a look at pipecat and almost all of pipecat's used stt and tts are opensource why the hell are we not downloading it and using it. BUILD IT and MAKE IT WORK. I want a full voice agent not a hardcoded siri.
```

```text
the stt we have currently is ass, also where is browser voice ui kit from pipecat, i want that. Is there a better stt that can take in mutliple languages too like is WhisperX good?
```

```text
I forgot to say before it worked well it's just that the stt was bad. Also for tts let's use fish speech: [fishaudio/fish-speech](https://github.com/fishaudio/fish-speech), because this has multispeech support.
```
