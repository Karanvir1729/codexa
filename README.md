# Voice Agent Feedback Engine

End-to-end voice agent scaffold for a high-reasoning, low-latency telephony agent that uses NVIDIA open-weight models, AWS GPU compute, Pipecat/Twilio voice transport, and a first-party automated evaluation loop.

The goal is not just the best-sounding voice. The goal is a complete voice-agent system where calls, transcripts, feedback, evals, and prompt/model improvements form a continuous feedback loop.

## Current Status

Built locally:

- FastAPI backend with health checks, chat endpoint, Twilio inbound webhook, feedback capture, prompt-versioning, and eval APIs.
- OpenAI-compatible LLM adapter supporting:
  - `mock` mode for free local testing.
  - NVIDIA NIM endpoint mode.
  - self-hosted local/AWS vLLM endpoint mode.
- Continuous feedback loop:
  - stores transcripts, feedback, latency records, eval runs, and prompt versions in SQLite.
  - converts low-rated user feedback into prompt improvements.
  - runs YAML eval suites and feeds failures back into the active agent prompt.
  - exports positive examples and passing evals for later SFT/LoRA data prep.
- Twilio integration:
  - `/twilio/inbound` TwiML route.
  - Pipecat Cloud WebSocket shortcut support.
  - self-hosted Pipecat runtime module for STT/LLM/TTS pipeline wiring.
- React operator console:
  - session simulator.
  - feedback submission.
  - eval run controls.
  - prompt version visibility.
  - Pipecat Voice UI Kit dependency included for voice UI expansion.
- AWS deployment assets:
  - CloudFormation stack for GPU vLLM host.
  - Terraform scaffold.
  - CloudShell discovery/deploy/destroy scripts.
  - credit-safe deployment profile using `g5.xlarge`.
  - optional short benchmark profile for larger 49B Nemotron runs gated behind an explicit opt-in.
- Cost controls:
  - deploy script refuses GPU launch without budget guardrail or `BUDGET_EMAIL`.
  - deploy script checks AWS Cost Explorer month-to-date account spend before GPU launch.
  - deploy script checks GPU quota before launch.
  - default GPU instance auto-stops after 4 hours.
  - budget and no-compute guardrail helper scripts are included.
  - app runtime blocks LLM calls when the local estimated spend cap would be exceeded.

Verified locally:

- Backend test suite passes.
- Ruff check passes.
- Frontend production build passes.
- Eval runner passes.
- Training-data export works.

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

The local runtime cap is enabled by default:

```bash
COST_GUARD_ENABLED=true
COST_GUARD_CAP_USD=95
COST_GUARD_RESERVE_USD_PER_CALL=0.01
```

Every model call reserves estimated cost before the LLM request starts. If the next request would exceed the local cap, the API returns HTTP `402` and does not call the model provider.

## NVIDIA NIM Mode

Set:

```bash
LLM_PROVIDER=nvidia
NVIDIA_API_KEY=<from NVIDIA>
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1.5
```

Use this only when credits or free access are confirmed.

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

Export curated positive-feedback and passing-eval examples:

```bash
./scripts/export_training_data.sh
```

## What Still Needs To Be Done

- Wait for AWS GPU quota approval if the account currently has `0` G/VT GPU vCPU quota.
- Confirm AWS credits are active and applicable to the selected GPU instance type and region.
- Create or confirm an AWS budget alert email.
- Deploy the `credit-safe` AWS profile after budget and quota are ready.
- Connect a public HTTPS tunnel or hosted API URL for Twilio webhook testing.
- Add real provider credentials locally:
  - Twilio.
  - NVIDIA or AWS-hosted vLLM.
  - Pipecat Cloud, or Deepgram/Cartesia for self-hosted Pipecat.
- Run a live phone-call test through Twilio.
- Add latency benchmarking around Twilio media stream, Pipecat transport, model response time, TTS, and end-to-end turn-taking.
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
