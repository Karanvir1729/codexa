# API Surface Notes

This pass did not add public endpoints. It changed conversation orchestration behavior, worker-result behavior, and documented existing docs/action/flowchart surfaces.

## Conversation planning surface

| Entry point | Request shape | Response shape | Auth | Side effects |
| --- | --- | --- | --- | --- |
| `handleSupervisorMessage` / web-text and voice conversation paths | User message plus session/channel context. | Natural-language response only; planner JSON is never returned raw to the user. | Existing session/channel auth. | May store redacted planner state, ask clarification, create a pending approval, or create/start an approved task graph. |
| Pending action handler | User approval/revision messages such as `approve`, `use one worker`, `use Docker local`, `explain`. | Natural-language plan revision, approval confirmation, or blocker. | Existing session context. | Rewrites only the pending planner decision until approval; approval creates the graph matching the approved split. |

Planner-triggered execution keeps using existing task graph and worker APIs. Multi-worker proposals, GCP worker execution, public deploy, IAM/secrets, broad Docker mounts, and destructive actions must require approval before launch.

## Worker result callback

| Method | Route | Request shape | Response shape | Auth | Side effects |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/workers/:worker_id/result` | Worker result body with `task_id`, `status`, `summary`, optional `next_steps`, and runtime metadata fields. | `{ task }` | Local/docker modes use internal callback; GCP mode requires authenticated Cloud Run callback per existing config. | Updates worker heartbeat, clears task command leases, applies completion gate via `MultiWorkerCoordinator.advanceAfterTaskResult`, reloads gated task, generates summary, updates sessions, may create repair node/task, may advance graph. |

## Worker command event callback

| Method | Route | Request shape | Response shape | Auth | Side effects |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/workers/:worker_id/events` | `CommandEventRecord` from worker runtime. Codex app tasks now send a Codex command event, a materializer command event, file-status event, and validation event. | Stored event payload. | Same callback mode as worker runtime. | Appends command/event-log evidence used by flowchart, completion gates, summaries, and progress. |

Materializer command events are not a separate API. They use the normal worker event path and must show `command = node /state/runtime/materialize-codex-files.mjs ...`, exit code, stdout/stderr previews or refs, and `created: <path>` summary lines.

## Flowchart/docs surfaces

| Method | Route | Purpose | Source of truth |
| --- | --- | --- | --- |
| `GET` | `/orchestrator/flowchart` | Returns runtime nodes/edges for sessions, planner decisions, requirement summaries, task split proposals, user approvals, approved plans, execution starts, projects, task graphs, workers, commands, summaries, previews, operator actions, and docs nodes. | State store records and docs metadata, not static demo data. |
| Conversation/action routes | existing `ActionRouter` paths | Allow users to ask for project docs, functions, variables, state model, handoffs, and docs freshness. | `ActionRouter.inspectDocFile` and project repo `.head-developer` docs. |

`GET /ready` and `GET /orchestrator/flowchart` include non-secret `model_providers`:

```json
{
  "supervisor_model_provider": "Vertex/Gemini",
  "planner_model_provider": "Vertex/Gemini",
  "worker_code_model": "Codex CLI"
}
```

## Test runner

`npm test` now runs `tsx --test --test-concurrency=1 codex-phone-supervisor/tests/*.test.ts`. This is an API/test harness determinism decision: backend subprocess tests allocate ephemeral ports and can miss their 15-second health window under parallel suite load. Focused tests already pass in parallel; serial full-suite execution removes the false health-check flake.
