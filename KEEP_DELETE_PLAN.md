# Keep/Delete Plan

Generated: 2026-05-25

## Keep: Core Product

- `codex-phone-supervisor/backend/src/**`
- `codex-phone-supervisor/frontend/**`
- `codex-phone-supervisor/scripts/demo.ts`
- `codex-phone-supervisor/scripts/phone-sim.ts`

Reason: these files implement the Codex Phone Supervisor backend, frontend, Twilio/web channels, Codex runner, local demo, and local phone simulator.

## Keep: Tests/Docs/Config

- `.env.example`
- `.gitignore`
- `README.md`
- `REPO_INVENTORY.md`
- `KEEP_DELETE_PLAN.md`
- `package.json`
- `package-lock.json`
- `codex-phone-supervisor/README.md`
- `codex-phone-supervisor/tests/**`
- `codex-phone-supervisor/tsconfig.json`

Reason: these files are needed for setup, reproducible installs, local validation, and onboarding a new engineer.

## Keep: Local Runtime, Ignored By Git

- `.env`
- `data/codex-phone-supervisor/**`
- `node_modules/**`
- `tmp/**`

Reason: these may contain local operator config, session state, audit logs, or install artifacts. They should not be deleted automatically.

## Delete: Unrelated/Legacy

The following files are clearly outside the current focused plan and are safe to keep deleted:

- `.playwright-mcp/**` browser automation snapshots/logs from prior experiments.
- `desktop/**` old Electron desktop shell.
- `playwright.config.mjs` old root Playwright setup.
- `requirements-pipecat-phone.txt` old Python Pipecat dependency file.
- `requirements-whisperx.txt` old Python WhisperX dependency file.
- `scripts/bench-voice-loop.mjs`
- `scripts/develop-test-loop.mjs`
- `scripts/lib/env.mjs`
- `scripts/openclaw-readiness.mjs`
- `scripts/run-pipecat-phone.mjs`
- `scripts/setup-twilio-voice-webhook.mjs`
- `scripts/test-codex-calculator-build.mjs`
- `scripts/test-openclaw-control.mjs`
- `scripts/test-phone-codex-bridge.mjs`
- `scripts/test-phone-stack.mjs`
- `scripts/voice-eval-suite.mjs`
- `scripts/voice-test-preflight.mjs`
- `scripts/voice-test-runner.mjs`
- `server.mjs`
- `services/pipecat_twilio_bot.py`
- `services/whisperx_adapter.py`
- `tests/voice/**`
- `web-react/**`
- `web/**`
- `playing-chess-on-browser-website/**` generated browser-chess smoke fixture from a previous task.

Reason: these belong to the prior OpenClaw/Pipecat/WhisperX/Electron/root-web product direction and duplicate or distract from the lightweight Codex Phone Supervisor plan.

## Unsure: Requires Manual Review

- None at this time.

If new files appear, classify them here before deletion.

## Expected Remaining Tree

```text
.
├── .env.example
├── .gitignore
├── KEEP_DELETE_PLAN.md
├── README.md
├── REPO_INVENTORY.md
├── codex-phone-supervisor/
│   ├── README.md
│   ├── backend/src/
│   ├── frontend/
│   ├── scripts/
│   ├── tests/
│   └── tsconfig.json
├── package-lock.json
└── package.json
```
