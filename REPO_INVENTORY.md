# Repo Inventory

Generated: 2026-05-25

## Product Scope

This repository is focused on Codex Phone Supervisor: a lightweight voice/text control plane for Codex projects.

The product supports four channels:

- Web text chat
- Web browser microphone voice chat
- Twilio SMS
- Twilio phone calls

All channels should route through the same shared agent core, project/session state, project-selection flow, approval firewall, Codex tools, access summary, and audit log.

## Current Source Files

### Root

- `.env.example` - explicit runtime configuration template.
- `.gitignore` - local/runtime/generated file exclusions.
- `README.md` - product overview and local setup.
- `package.json` - Node scripts and dependency manifest.
- `package-lock.json` - pinned dependency graph.
- `REPO_INVENTORY.md` - this inventory.
- `KEEP_DELETE_PLAN.md` - keep/delete classification.

### Backend

- `codex-phone-supervisor/backend/src/access.ts` - Codex access summary, git status, env-name reporting, diff summary.
- `codex-phone-supervisor/backend/src/codex.ts` - non-interactive Codex CLI runner and structured report reducer entrypoint.
- `codex-phone-supervisor/backend/src/config.ts` - explicit environment/config loader and startup validation.
- `codex-phone-supervisor/backend/src/index.ts` - Express API entrypoint.
- `codex-phone-supervisor/backend/src/intent.ts` - status/question answer routing for Codex state questions.
- `codex-phone-supervisor/backend/src/parser.ts` - Codex JSONL event parser.
- `codex-phone-supervisor/backend/src/project-selector.ts` - Codex-backed read-only project selection flow.
- `codex-phone-supervisor/backend/src/reducer.ts` - session state reducer for Codex reports/events.
- `codex-phone-supervisor/backend/src/session.ts` - session defaults and shape migration helpers.
- `codex-phone-supervisor/backend/src/store.ts` - local JSON persistence and audit log appends.
- `codex-phone-supervisor/backend/src/supervisor-tools.ts` - backend-only tools exposed to channels.
- `codex-phone-supervisor/backend/src/telephony-store.ts` - Twilio peer-to-session mapping.
- `codex-phone-supervisor/backend/src/telephony.ts` - Twilio SMS and ConversationRelay phone integration.
- `codex-phone-supervisor/backend/src/types.ts` - shared TypeScript types.

### Frontend

- `codex-phone-supervisor/frontend/index.html` - Vite HTML shell.
- `codex-phone-supervisor/frontend/src/main.tsx` - React dashboard with text/voice chat, timeline, approvals, project/status cards.
- `codex-phone-supervisor/frontend/vite.config.ts` - explicit Vite config.

### Scripts

- `codex-phone-supervisor/scripts/demo.ts` - local API demo script.
- `codex-phone-supervisor/scripts/phone-sim.ts` - local phone/message simulator.

### Tests

- `codex-phone-supervisor/tests/parser.test.ts` - Codex JSONL parser tests.
- `codex-phone-supervisor/tests/reducer.test.ts` - state reducer and approval preservation tests.

### Runtime/Local Data

- `.env` - local operator config; ignored by git and should not be printed.
- `data/codex-phone-supervisor/` - local sessions/audit/runtime state; ignored by git.
- `node_modules/` - local dependency install; ignored by git.
- `tmp/` - local scratch data; ignored by git.

## Current Working-Tree Deletions

These files are currently removed from the working tree because they are legacy or unrelated to the focused Codex Phone Supervisor plan:

- `.playwright-mcp/*` captured browser automation logs/snapshots.
- `desktop/*` old Electron shell.
- `playwright.config.mjs` old root Playwright config.
- `requirements-pipecat-phone.txt` old Python phone runtime requirements.
- `requirements-whisperx.txt` old Python STT runtime requirements.
- `scripts/*` old root scripts for OpenClaw, voice evals, Pipecat, phone stack tests, and development loops.
- `server.mjs` old root web/voice/OpenClaw server.
- `services/*` old Pipecat and WhisperX services.
- `tests/voice/*` old root voice/browser tests.
- `web/*` old root web app and test dashboard.
- `web-react/*` old root React entrypoint.

## Current Gaps

- Shared channel-agnostic agent pipeline still needs to be formalized.
- Project model should be persisted as first-class state instead of inferred only from sessions.
- More tests are needed for project routing, channels, Twilio webhooks, approval firewall, missing config, GCP config validation, and provider mock behavior.
- GCP inspection is currently blocked because `gcloud` is not available on the shell `PATH`.
