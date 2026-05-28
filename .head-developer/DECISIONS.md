# Decision Log

## Planning is model-driven, not a rigid workflow script

Decision: Build requests now pass through `AgenticPlanningController`, which asks the configured GCP/Gemini planner model for a structured decision. Test/offline mode uses a conservative deterministic fallback, but the controller still treats planning as a decision layer rather than a fixed checklist.

Reason: The orchestrator already has strong execution infrastructure. It needed an engineering-lead layer that can clarify, summarize, propose design/splits, request approval, revise plans, or start simple safe tasks based on context.

Consequence: Simple low-risk tasks can start quickly; vague work asks a focused question; multi-worker/GCP/risky work waits for approval; approved task graphs must match the approved split.

## Planner output is persisted as redacted structured state

Decision: Planner decisions, approved plans, requirement summaries, approval status, assumptions, open questions, and approved worker count/mode are stored on sessions/projects/task graphs and copied into worker context packets.

Reason: Execution, flowchart, summaries, and future revisions need an auditable plan ID and requirements context.

Consequence: Planner state is part of the product state model and must be redacted before persistence. Do not store raw secrets, Codex auth, env files, or IAM material in planner fields.

## Approval gates remain authoritative

Decision: Planner recommendations cannot bypass approval policy. Multi-worker proposals, GCP VM workers, public deploys, IAM/secrets, broad Docker mounts, and destructive actions require explicit approval before launch.

Reason: Model planning should improve orchestration quality without weakening existing safety gates.

Consequence: `requires_user_approval` and `execution_allowed` are enforced by supervisor routing and pending-action handling. Invalid or unsafe planner output falls back conservatively.

## Completion gates are required for app-building nodes

Decision: A worker-reported `completed` status is not enough for app nodes. `MultiWorkerCoordinator.advanceAfterTaskResult` must evaluate command-event evidence, app files, and validation commands before the graph can progress.

Reason: Prior multi-worker smoke showed workers could produce only `.head-developer` docs while summaries overstated success.

Consequence: Docs-only app output becomes `needs_repair` at the graph node level and `failed` at the task level, with a repair node queued.

## Static SaaS shell split excludes billing/backend when requested

Decision: A prompt that explicitly asks for static HTML/CSS/JS, no backend, and no billing is split into setup docs, landing/login, dashboard/settings, and validation/review.

Reason: The smaller two-worker smoke must avoid fake billing/backend scope and prove two independent Docker workers can produce real static app files.

Consequence: Billing subtasks are omitted when `noBillingRequested` is true.

## Summaries use gated task state

Decision: `/workers/:worker_id/result` reloads the task after `advanceAfterTaskResult` before generating the run summary.

Reason: Summary generation must see the post-gate failed/incomplete state instead of the worker's optimistic completion payload.

## Codex file content is materialized deterministically by the worker

Decision: For Docker/local worker app tasks, Codex must return exact generated file content in `files_to_write`. The worker then writes those exact files using a logged `CommandRunner` command: `node /state/runtime/materialize-codex-files.mjs <task>.files-to-write.json`.

Reason: Nested `apply_patch` attempts inside worker Codex were unreliable and could produce docs-only/no-file runs while Codex still exited successfully. The product rule still holds: Codex produces the content, and the worker only materializes that content through the normal command/event path.

Consequence: A successful app task now requires both the Codex command event and the materializer command event, followed by real file validation. Summaries must distinguish Codex-generated content from worker materialization.

## Timed-out commands are failed command events

Decision: `CommandRunner.run` records executor/spawn timeouts as exit code `124` and emits `command.failed`.

Reason: A previous Codex timeout could look like an exit `0` after process teardown. That made incomplete work appear successful.

Consequence: Timed-out Codex work blocks task completion and must be retried or repaired with honest state.

## Test suite runs serially

Decision: `npm test` uses `tsx --test --test-concurrency=1`.

Reason: Full-suite parallel execution can start multiple backend subprocesses simultaneously, causing health-check flakes. Focused backend tests pass, and the serial full suite passes.

Consequence: This changes only test-runner determinism, not product runtime behavior.

## Codex auth audit remains behavior-neutral

Decision: CodexAuthAudit is audit-only. No credentials are rotated, copied, printed, or provisioned into GCP in this pass.

Reason: Auth identity verification must not become a secret-handling side effect.

Consequence: Nonce smoke artifacts may remain as local evidence. They must not contain tokens, cookies, API keys, refresh tokens, credential JSON, or full environment dumps.
