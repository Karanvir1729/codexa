# Voice Agent Architecture

## Runtime

The backend exposes one agent interface across web, WebSocket, Twilio, and eval traffic.
The model client is OpenAI-compatible, so the same code can call NVIDIA NIM,
build.nvidia.com, or a self-hosted vLLM endpoint on AWS GPU compute.

Default model choices are config-driven:

- Production/high reasoning: `nvidia/Llama-3_3-Nemotron-Super-49B-v1_5` on vLLM or NIM.
- Larger frontier deployment: Nemotron 3 Super 120B A12B where GPU capacity allows.
- Development and CI: deterministic `mock` provider with no paid API calls.

## Voice Path

The mainstream browser voice path is now documented in detail at
[`docs/mainstream-voice-codexa-path.md`](mainstream-voice-codexa-path.md).
That path is `VOICE_SPEECH_PATH=supertone_parakeet`: browser SmallWebRTC,
OpenRouter Parakeet STT, NVIDIA/OpenAI-compatible runtime tool selection,
Codexa HTTP orchestration, and Supertonic TTS. The old visible `current`
speech path is no longer part of the app surface.

Twilio inbound calls hit `/twilio/inbound` or the compatibility alias
`/api/twilio/voice`. In default `TWILIO_VOICE_MODE=auto`, local/text runtime
returns Twilio-native `<Gather input="speech">` TwiML, sends `SpeechResult`
to `/twilio/voice-turn`, and routes the transcript through the same
Codexa bridge used by the browser voice/text tests. When
`CODEX_ORCHESTRATOR_ENABLED=true`, Twilio task turns go directly to
`CodexOrchestratorBridge` and then `POST /agent/chat`, so phone calls can drive
the same project planning, approval, local Codex session, GitHub, validation,
and flowchart workflow as the text agent.

When streaming providers are configured, the same inbound route can still return
`<Connect><Stream>` TwiML. The stream can go to either:

- Pipecat Cloud: set `PIPECAT_CLOUD_WS_URL` and `PIPECAT_CLOUD_SERVICE_HOST`.
- Self-hosted Pipecat: set `VOICE_RUNTIME=pipecat`, install `backend[voice]`, and expose
  `/twilio/media-stream` over WSS.

The browser Pipecat runtime uses OpenRouter-hosted Parakeet STT and Supertonic TTS
for the active local path. Other providers remain in code for experiments, but they
are not the mainstream path.

## Feedback Loop

Every turn is written to SQLite with latency, model, provider, prompt version, and raw
usage metadata. User/operator feedback and offline eval results are stored in the same
database. `FeedbackLearner` derives prompt constraints from those records and writes a
new active prompt version. Future responses compile the base system prompt plus learned
hints, so evaluation data immediately flows back into behavior.

The local eval runner mirrors Pipecat's recommended workflow: validate prompt and
conversation logic with text-first simulation before running costly end-to-end audio.
It is intentionally first-party so the project does not depend on Cekura/Secure credits.
The same runner can be started as a scheduler with `EVAL_SCHEDULE_SECONDS` or from the
operator console, so regressions keep flowing into `FeedbackLearner` without manual runs.

## AWS Deployment

`infra/aws` and `infra/aws/cloudformation-vllm.yml` provision a GPU EC2 instance that
starts a vLLM OpenAI-compatible API. CloudShell is the preferred path when local AWS
credentials are not configured. The default profile is credit-safe: a single NVIDIA GPU
running `nvidia/Llama-3.1-Nemotron-Nano-8B-v1` with a 4-hour auto-stop. The 49B Super
profile is reserved for short benchmark runs.
Point the backend at it with:

```bash
LLM_PROVIDER=local
LOCAL_LLM_BASE_URL=http://<gpu-host>:5000/v1
LOCAL_LLM_MODEL=Llama-3_3-Nemotron-Super-49B-v1_5
```

Keep the vLLM security group private to your app/VPN CIDR. Do not expose port 5000 to
the public internet.

## Customization Path

The first improvement loop is online and immediate: eval/feedback data creates a new
active prompt version. The second loop is model customization: `scripts/export_training_data.sh`
exports only passing evals and positive live-feedback turns as JSONL so the team can run
LoRA/SFT on Nemotron through NVIDIA NeMo or a Hugging Face PEFT workflow. Negative
feedback is not trained directly; it becomes regression coverage first.
