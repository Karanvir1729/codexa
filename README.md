# Codex Phone Supervisor

Codex Phone Supervisor is a voice/text control plane for Codex projects.

It supervises Codex from four channels:

- in-app text chat
- in-app microphone voice chat
- Twilio SMS
- Twilio phone calls through ConversationRelay

The voice and messaging layers never run shell commands directly. They send typed `UserMessage` objects into one shared agent core. The backend records events, exposes state, routes projects, and keeps approvals behind explicit API decisions.

New chat sessions start with a project-selection conversation. The selector asks a short follow-up when needed, chooses only from configured project roots, and attaches the session to the selected workspace before coding instructions are accepted.

The dashboard also has two operator-only terminal controls: an embedded local shell and a button that physically opens Terminal.app and runs the Codex CLI. These controls are for the human operator only; supervisor chat, browser voice, Twilio SMS, and Twilio phone calls cannot access them.

`codex_cli` is the default local path. Optional `gcp_conversation_ai` and `nvidia_nim` modes remain legacy/experimental provider integrations for managed dialog or self-hosted inference. Those providers return only text or structured decisions; Codex tool execution remains behind the backend approval firewall.

## Five-Minute Architecture

```text
web text       \
web voice       \
Twilio SMS       -> shared agent core -> project router -> local Codex CLI orchestrator
Twilio phone    /
```

## V1 Local Codex Session Path

The default product path is `codex_session_local`: one local Codex CLI orchestrator session owns the selected project repo and writes all implementation changes there.

```text
user request
-> clarification when needed
-> proposed plan
-> approval for complex work
-> one local Codex CLI orchestrator session
-> Codex chooses any useful internal logical subagents
-> local validation
-> local preview
-> flowchart and grounded final summary
```

The user is talking directly to Codex through the local CLI-backed session. Codex decides how many internal logical subagents to use and reports their responsibilities, files changed, and validation results. These subagents are not OS workers, Docker containers, VM workers, Kubernetes Jobs, or separate worktrees.

The v1 source of truth is the local repo plus local file state. Each generated repo gets `.head-developer/` docs and `.head-developer/state.json` session metadata. Firestore, GKE, GCP VM workers, Cloud Run control-plane callbacks, GCS Codex bundles, Secret Manager Codex auth, worker callback infrastructure, and per-worker worktrees remain legacy/experimental paths and are not required for local app building.

Backend tools:

- `list_projects()`
- `select_project(projectId)`
- `get_codex_status(projectId/sessionId)`
- `get_codex_events(projectId/sessionId)`
- `get_codex_summary(projectId/sessionId)`
- `send_codex_instruction(projectId/sessionId, instruction)`
- `get_access_summary(projectId)`
- `get_git_diff_summary(projectId)`
- `get_pending_approval(projectId/sessionId)`
- `approve_action(approvalId)`
- `deny_action(approvalId)`
- `stop_session(sessionId)`

The supervisor mode is configured explicitly with `SUPERVISOR_MODEL_PROVIDER=codex_cli | gcp_conversation_ai | nvidia_nim | openai | mock`. `mock` requires `CODEX_PHONE_SUPERVISOR_TEST_MODE=1`.

## Repository Layout

```text
codex-phone-supervisor/
  backend/src/      Express API, agent core, project router, Codex runner, Twilio bridge
  frontend/         Vite React dashboard
  scripts/          local demo and phone-message simulator
  tests/            parser, reducer, router, config, provider, firewall tests
infra/gcp/          dry-run GCP readiness and deployment planning
```

Root files are intentionally limited to package metadata, environment examples, ignore rules, and this README.

## Setup

Requires Node.js `>=22.12` and an installed Codex CLI.

```bash
npm install
cp .env.example .env
```

Edit `.env`. The app intentionally requires explicit paths, ports, origins, workspace, project roots, model provider, and Codex executable. It does not infer those values from local defaults.

Set `CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS` to the directories that contain projects the chat selector is allowed to choose from. The selector will not attach Codex to paths outside those roots.

For full-device operator access, set `CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH=/` and `CODEX_PHONE_SUPERVISOR_TERMINAL_CWD=/`. Keep `CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT` pointed at the repository when you want newly generated projects created inside this repo.

The default execution mode is:

```env
WORKER_MODE=codex_session_local
DEFAULT_WORKER_MODE=codex_session_local
```

No Docker daemon, Firestore database, GKE cluster, Cloud Run service, or VM worker pool is needed for the default local build path.

## Run Locally

Backend:

```bash
npm run dev:backend
```

Frontend:

```bash
npm run dev:frontend
```

Open the origin configured in `CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS`.

## Commands

```bash
npm run typecheck
npm test
npm run build
npm run demo
npm run phone -- <session_id> "what changed?"
npm run gcp:readiness
npm run gcp:provision
```

## HTTP API

```text
POST /call/message
POST /codex/start
POST /codex/instruct
GET  /codex/status
GET  /codex/events
GET  /codex/summary
GET  /codex/access
GET  /projects
POST /projects/select
POST /approval/respond
POST /twilio/voice
POST /twilio/sms
POST /twilio/message-status
POST /terminal/launch-codex
```

## Twilio

For real phone/SMS usage, expose the backend with HTTPS and set:

```env
TWILIO_SMS_ENABLED=1
TWILIO_VOICE_ENABLED=1
CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL=https://your-public-host
TWILIO_CONVERSATION_RELAY_WS_URL=wss://your-public-host/twilio/conversation-relay
TWILIO_VALIDATE_SIGNATURES=1
TWILIO_AUTH_TOKEN=your_twilio_auth_token
```

If `TWILIO_VOICE_ENABLED=1`, startup fails unless
`TWILIO_CONVERSATION_RELAY_WS_URL` is explicitly configured. Outside test mode,
that URL must use `wss://`.

Configure Twilio webhooks:

```text
Voice webhook: POST https://your-public-host/twilio/voice
SMS webhook:   POST https://your-public-host/twilio/sms
Status hook:   POST https://your-public-host/twilio/message-status
```

## Safety Rules

- Codex runs through one local `codex exec --json` CLI orchestrator session for the default v1 path.
- The local Codex prompt requires all work to stay in the single selected repo and tells Codex to choose any useful internal logical subagents itself.
- The local Codex implementation session uses the configured local Codex account, model, profiles, plugins, shell environment, and full-access mode by default; tune `CODEX_PHONE_SUPERVISOR_CODEX_*` only when you intentionally want a narrower sandbox.
- Risky shell, network, package install, file deletion, deploy, git-push, secret, credential, payment/billing, GCP resource, Twilio mutation, or outside-workspace actions are approval-gated.
- Access summaries expose environment variable names only, never secret values.
- Every instruction, Codex event, and approval decision is appended to the audit log.
- Physical Terminal.app launch is loopback-only and requires explicit `CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_*` config.

## Legacy Cloud Worker Experiments

GCP support remains in the repo as an experimental/legacy worker path, not the v1 default. It supports an authenticated Cloud Run control plane and disposable no-public-IP VM workers. Real `codex exec` on GCP VMs uses the runtime-only Secret Manager auth path described in [GCP_CODEX_AUTH.md](/Users/karanvirkhanna/tutor-tron-voice/docs/GCP_CODEX_AUTH.md); credentials are never baked into images or copied from local Codex auth.

Run the read-only readiness check:

```bash
export GCP_PROJECT_ID=your-project-id
export REGION=us-central1
npm run gcp:readiness
```

Create the planned control-plane resources only after confirming the target
project:

```bash
export GCP_PROJECT_ID=your-project-id
export REGION=us-central1
export DEPLOY_CONFIRM=yes
npm run gcp:provision
```

The scripts in `infra/gcp/` require `GCP_PROJECT_ID` and `REGION`, fail if the active gcloud project does not match, print commands before running them, and refuse resource creation unless `DEPLOY_CONFIRM=yes`.
