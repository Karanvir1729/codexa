# GCP Deployment Readiness

Codex Phone Supervisor uses GCP for the authenticated control plane and can run real `codex exec` on disposable VM workers through the runtime-only Secret Manager auth path in `docs/GCP_CODEX_AUTH.md`.

No script in this folder deploys or mutates cloud resources unless `DEPLOY_CONFIRM=yes` is set.

## Required Operator Env

```bash
export GCP_PROJECT_ID=your-project-id
export REGION=us-central1
```

Do not hardcode project IDs in source code. The operator provides `GCP_PROJECT_ID`.

## Readiness Inspection

```bash
bash infra/gcp/readiness.sh
```

This checks:

- active gcloud project
- authenticated gcloud account names
- enabled APIs
- Cloud Run services
- Pub/Sub topics
- Secret Manager secret names
- Artifact Registry repositories

Secret values are never printed.

## Provision Control Plane

```bash
DEPLOY_CONFIRM=yes bash infra/gcp/provision-control-plane.sh
```

This creates the Artifact Registry repository, Pub/Sub topics, Secret Manager
secret placeholders, Cloud Storage artifact bucket, Firestore database, and
least-privilege Cloud Run service account. It does not create secret values and
does not deploy Cloud Run.

## NVIDIA Model VM

```bash
DEPLOY_CONFIRM=yes bash infra/gcp/provision-nvidia-model-vm.sh
```

This creates an optional GPU VM that runs an OpenAI-compatible model server
container for NVIDIA/Nemotron-style models. It requires an API key in Secret
Manager, or `GENERATE_NVIDIA_NIM_API_KEY=yes` to generate one without printing
it. It does not expose the model port unless `NVIDIA_ALLOWED_SOURCE_RANGES` is
set explicitly.

## Proposed Architecture

- Cloud Run service: backend API and Twilio webhooks.
- Optional Cloud Run WebSocket/SSE endpoint: dashboard realtime updates.
- Pub/Sub topics: Codex events, approvals, audit events.
- Secret Manager: Twilio, Codex home bundle, GitHub credentials.
- Firestore or Cloud SQL: sessions, projects, approvals, channel bindings.
- Cloud Storage: raw Codex logs, artifacts, diffs.
- Conversational Agents / Dialogflow CX: managed dialog, project-selection conversation, and summaries when explicitly configured.
- Compute Engine GPU VM: optional self-hosted NVIDIA NIM/OpenAI-compatible inference endpoint for summaries, project routing, and risk classification.

GCP VM Codex execution uses `HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle` by default. The VM fetches a dedicated ChatGPT-login Codex home bundle from Secret Manager or restricted GCS, extracts it into `/codex-home`, validates `codex login status`, and then runs `codex exec`. Missing bundle config fails closed with a clear worker error. `secret_manager_api_key` remains fallback-only and should not be used for live VM smokes without explicit approval.
