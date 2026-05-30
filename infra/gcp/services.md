# Proposed GCP Services

## APIs

- `run.googleapis.com` - Cloud Run backend/webhook service.
- `compute.googleapis.com` - optional GPU VM for self-hosted NVIDIA NIM inference.
- `artifactregistry.googleapis.com` - container image storage.
- `secretmanager.googleapis.com` - credential storage.
- `dialogflow.googleapis.com` - Conversational Agents / Dialogflow CX dialog layer.
- `pubsub.googleapis.com` - events, approvals, audit stream.
- `firestore.googleapis.com` - project/session state option.
- `storage.googleapis.com` - raw logs/artifacts/diffs.
- `cloudbuild.googleapis.com` - optional image build path.
- `iam.googleapis.com` - service account and IAM inspection.

## Proposed Service Names

- Cloud Run backend: `codex-phone-supervisor-api`
- Artifact Registry repo: `codex-phone-supervisor`
- Pub/Sub topic: `codex-phone-supervisor-events`
- Pub/Sub topic: `codex-phone-supervisor-approvals`
- Pub/Sub topic: `codex-phone-supervisor-audit`
- Pub/Sub topic: `codex-phone-supervisor-instructions`
- Pub/Sub topic: `codex-phone-supervisor-dead-letter`
- Cloud Storage bucket: `${GCP_PROJECT_ID}-codex-phone-supervisor-artifacts`
- Firestore database: `(default)`
- Service account: `codex-phone-supervisor-api@${GCP_PROJECT_ID}.iam.gserviceaccount.com`
- Conversational Agents / Dialogflow CX agent: operator-created, configured by `GCP_CONVERSATION_AGENT_ID`
- Compute Engine NVIDIA NIM VM: optional, configured by `NVIDIA_NIM_BASE_URL`

## Suggested NVIDIA Model

- `nvidia/Llama-3.1-Nemotron-Nano-8B-v1` for the first GPU VM. It is an NVIDIA open model aimed at reasoning, chat, RAG, and tool-calling style tasks, and is small enough to target a single L4/T4-class GPU with constrained context.

## Required Secrets

Secret names only:

- `twilio-auth-token`
- `twilio-account-sid`
- `twilio-phone-number-sid`
- `openai-api-key`
- `codex-api-key`
- `github-token`
- `nvidia-nim-api-key`
- `ngc-api-key` if pulling NGC-hosted NIM containers

Do not print or commit secret values.
