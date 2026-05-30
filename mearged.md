# Merged Voice UI + App Builder Handoff

Date: 2026-05-30
Branch: `twillio`
Repo: `Karanvir1729/codexa`

## What This Branch Contains

This branch merges the voice UI and the Codex App Builder into one local browser experience.

The main product surface is now the root voice UI:

```text
http://127.0.0.1:5173/
```

Inside that UI, the sidebar has a new **Builder** page. This replaces the need to open the standalone App Builder UI at `4318` for normal testing.

## Current Runtime Shape

The app is still local-first.

```text
Voice UI / Builder UI:  http://127.0.0.1:5173
Voice backend:          http://127.0.0.1:8000
Codex supervisor API:   http://127.0.0.1:4317
Legacy builder UI:      http://127.0.0.1:4318
```

The root Vite app proxies App Builder calls through:

```text
/supervisor-api -> http://localhost:4317
```

That lets the integrated Builder page talk to the same local Codex supervisor without CORS or a second frontend.

## What Was Added

### Integrated Builder Page

File:

```text
frontend/src/AppBuilder.tsx
```

The Builder page includes:

- Text chat with Codex.
- Real local Codex CLI stream panel.
- Runtime badges for model, reasoning, full local access, and skills.
- Session flowchart.
- Megaplan panel.
- Repo / branch metadata when a Megaplan exists.
- Preview link when a preview is reported.
- Saved text and voice interaction history.

### Root Voice UI Navigation

File:

```text
frontend/src/App.tsx
```

The sidebar now includes:

```text
Voice
Builder
Flow
Testing
Self-learn
Evals
Runtime
```

### Builder Styling

File:

```text
frontend/src/styles.css
```

The Builder page uses the same dark/light theme as the voice UI. It avoids the older light standalone Builder styling.

The flowchart is shown as three clean vertical lanes:

```text
Main path
Parallel Codex agents
Quality path
```

This makes parallel agents visually distinct without dashed overlays or overlapping arrows.

### Vite Proxy

File:

```text
frontend/vite.config.mjs
```

Added:

```js
"/supervisor-api": {
  target: "http://localhost:4317",
  changeOrigin: true,
  rewrite: (path) => path.replace(/^\/supervisor-api/, "")
}
```

## Interaction Persistence

The Builder page stores recent interaction messages locally under:

```text
codex-phone-supervisor-builder-interactions
```

It also hydrates from supervisor `session.recent_messages`, including:

- `web_text` messages as app text interactions.
- `web_voice` messages as app voice interactions.
- System/progress events as system messages.

This means text and voice-driven Builder conversations can reappear after reload as long as the supervisor session is still available or local browser storage remains.

## How To Run

From repo root:

```bash
./scripts/run_backend.sh
npm --prefix frontend run dev -- --host 127.0.0.1
```

The Codex supervisor backend should also be running on `4317`. If needed:

```bash
npm run codex-phone-supervisor:dev
```

Then open:

```text
http://127.0.0.1:5173/
```

Use **Builder** in the sidebar for text testing.

## Text Test That Passed

Prompt used from the integrated Builder page:

```text
Text smoke test: please plan a tiny local static landing page called builder-text-smoke, but do not implement yet. Ask me for any missing technical requirements before starting.
```

Observed behavior:

- The UI created/attached a local supervisor session.
- The user message appeared in the Builder chat.
- Progress/system messages streamed back into the chat.
- Codex asked clarifying technical questions before implementation.
- The flowchart updated with runtime nodes:
  - Orchestrator
  - User request
  - Requirement summary
  - User approval
- The CLI stream panel stayed present and truthful, showing no Codex implementation process because implementation was not approved.
- The chat survived reload through saved interaction hydration.

## Browser Verification

Validated in Chrome against:

```text
http://127.0.0.1:5173/
```

Checks:

- Builder nav item opens the integrated Builder page.
- Text input sends to the supervisor.
- Supervisor response appears in chat.
- Flowchart renders inside the voice UI theme.
- Saved interaction count updates.
- Reload keeps the Builder conversation visible.
- Browser console had no errors during the test.

## Important Behavior

The Builder is not a mock UI.

It calls the real local supervisor backend:

```text
POST /supervisor-api/call/message
GET  /supervisor-api/codex/status
GET  /supervisor-api/orchestrator/flowchart
GET  /supervisor-api/sessions/:session_id/megaplan
GET  /supervisor-api/projects/:project_id/tasks
```

The flowchart does not invent subagents. It displays Codex subagent nodes only when the supervisor flowchart reports them.

## What To Build On Next

Recommended next steps:

1. Keep improving the Builder page inside `frontend/src/AppBuilder.tsx`; do not revive the old standalone UI as the main path.
2. Add a small unit/integration test around saved Builder interactions.
3. Consider extracting the Builder API calls into `frontend/src/api.ts` if the page grows.
4. Add a visible filter for text vs voice interactions if the chat gets noisy.
5. Improve the flowchart empty state for sessions where no subagents are reported yet.
6. Keep Twilio as an input channel, not a separate product surface.

## Validation Commands

Known passing command:

```bash
npm --prefix frontend run build
```

Recommended full validation before release:

```bash
npm test
npm run build
docker compose -f docker/docker-compose.local.yml config
```

