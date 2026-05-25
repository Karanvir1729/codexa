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

Twilio inbound calls hit `/twilio/inbound` and receive `<Connect><Stream>` TwiML.
The stream can go to either:

- Pipecat Cloud: set `PIPECAT_CLOUD_WS_URL` and `PIPECAT_CLOUD_SERVICE_HOST`.
- Self-hosted Pipecat: set `VOICE_RUNTIME=pipecat`, install `backend[voice]`, and expose
  `/twilio/media-stream` over WSS.

The Pipecat runtime uses Deepgram STT, NVIDIA/OpenAI-compatible LLM, and Cartesia TTS by
default because this keeps the LLM on NVIDIA while using low-latency speech services.
Those services are replaceable through configuration.

## Feedback Loop

Every turn is written to SQLite with latency, model, provider, prompt version, and raw
usage metadata. User/operator feedback and offline eval results are stored in the same
database. `FeedbackLearner` derives prompt constraints from those records and writes a
new active prompt version. Future responses compile the base system prompt plus learned
hints, so evaluation data immediately flows back into behavior.

The local eval runner mirrors Pipecat's recommended workflow: validate prompt and
conversation logic with text-first simulation before running costly end-to-end audio.
It is intentionally first-party so the project does not depend on Cekura/Secure credits.

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
