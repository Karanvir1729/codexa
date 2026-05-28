# Cloud Orchestrator Code Index

Scope: repo-level docs for the current agentic planning, multi-worker output-contract, deterministic Codex file materialization, validation, summary truthfulness, DocumentationIndexer, and test-runner determinism changes.

## Important files

| File | Purpose | Key exports / entry points | Notes |
| --- | --- | --- | --- |
| `codex-phone-supervisor/backend/src/agentic-planning.ts` | Model-driven engineering-lead planning controller. | `AgenticPlanningController`, `PlannerModel`, `GcpGeminiPlannerModel`, `DeterministicFallbackPlannerModel`, `parsePlannerDecision`, `agenticPlanningController` | Runtime uses Vertex/Gemini; deterministic fallback is test-only. Produces structured planner decisions, asks useful clarifications, requires approval for multi-worker/GCP/risky work, stores planning state, and creates approved task graphs without silently changing the approved split. |
| `codex-phone-supervisor/backend/src/supervisor-tools.ts` | Conversation orchestration and pending-action handling. | `handleSupervisorMessage`, `startWorkerBackedProject`, `handlePendingConversationAction` | Routes build requests through the planner where appropriate, supports plan approval/revision, and keeps user-visible responses prose-only. |
| `codex-phone-supervisor/backend/src/task-complexity.ts` | Classifies user goals and creates task graph subtask/output-contract proposals. | `TaskComplexityJudge`, `taskComplexityJudge` | Includes the no-billing/no-backend static SaaS shell split: setup docs, landing/login, dashboard/settings, validation/review. |
| `codex-phone-supervisor/backend/src/multi-worker-coordinator.ts` | Creates task graphs, worker context packets, worktree assignments, completion-gate handling, and follow-on graph advancement. | `MultiWorkerCoordinator`, `multiWorkerCoordinator` | Accepts approved planner metadata, copies requirements/plan state into task graphs and worker context packets, records completion gate results, and creates repair nodes for incomplete app output. |
| `codex-phone-supervisor/backend/src/completion-gate.ts` | Evaluates whether a task graph app node produced required app output and validation evidence. | `evaluateTaskGraphNodeCompletion`, `completionGatePassed` | Uses command events; does not fake filesystem evidence. |
| `codex-phone-supervisor/backend/src/app-output-validation.ts` | Worker-side static app output validation. | `validateAppOutput` | Rejects docs-only output and weak `ls`/`git status` validation for app nodes. |
| `codex-phone-supervisor/backend/src/worker-entry.ts` | Docker/local worker runtime entry point, Codex prompt rendering, deterministic `files_to_write` materialization, worker result posting, and app validation. | `renderCodexPrompt`, `extractFinalWorkerJson`, `safeOutputFiles`, `materializeCodexFiles` | Worker prompts require Codex to return exact app file contents in `files_to_write`; the worker writes those contents through a logged `node /state/runtime/materialize-codex-files.mjs ...` command before validation. |
| `codex-phone-supervisor/backend/src/command-policy.ts` | Command approval/risk classifier. | `classifyCommand` | Allows only the internal materializer command under `/state/runtime/materialize-codex-files.mjs`; arbitrary Node scripts remain governed by policy. |
| `codex-phone-supervisor/backend/src/command-runner.ts` | Logged command execution and command event persistence. | `CommandRunner.run` | Records executor/spawn timeouts as exit code `124` with `command.failed`, so timed-out Codex work cannot be summarized as successful. |
| `codex-phone-supervisor/backend/src/summary.ts` | Grounded task and task graph summaries. | `assessTaskCompletionForSummary`, `generateTaskGraphTruthfulnessSummary`, `generateRunSummary` | Prevents summaries from overstating docs-only app nodes as completed app output. |
| `codex-phone-supervisor/backend/src/documentation-indexer.ts` | Scans generated project repos and writes `.head-developer` documentation indexes. | `DocumentationIndexer`, `documentationIndexer`, `DOCUMENTATION_INDEX_FILES`, `WORKER_CONTEXT_DOC_FILES` | Uses TypeScript AST where practical and safe regex/static parsing fallbacks. |
| `codex-phone-supervisor/backend/src/git-project-manager.ts` | Project repo/docs/worktree management. | `GitProjectManager`, `gitProjectManager` | Integrates documentation index files into shared project docs. |
| `codex-phone-supervisor/backend/src/action-router.ts` | Typed operator action routing from conversation/UI/MCP paths. | `parseOperatorIntent`, `ActionRouter`, `actionRouter` | Includes conversation access to project docs/function docs/variable docs/state model/handoff. |
| `codex-phone-supervisor/backend/src/flowchart.ts` | Runtime flowchart state builder. | `buildFlowchartState` | Adds planner, requirement summary, task split, approval, approved plan, execution start, documentation, task graph, worker, command, and summary nodes from state records. |
| `codex-phone-supervisor/backend/src/index.ts` | HTTP API and worker callback routes. | Express route handlers | Worker result route reloads the gated task before generating summaries. |
| `codex-phone-supervisor/backend/src/types.ts` | Shared domain/state models. | `PlannerDecision`, `ApprovedPlanRecord`, `WorkerOutputContract`, `TaskGraphNodeCompletionGate`, `TaskGraphNode`, `TaskRecord`, `WorkerContextPacket` | Planner state, approved plans, output contracts, and completion-gate fields are persisted across sessions/projects/task graphs/context packets. |
| `codex-phone-supervisor/backend/src/config.ts` | Runtime configuration and provider indicators. | `config` | Defaults supervisor/planner provider to Vertex/Gemini, rejects mock provider config, requires Vertex env unless test double mode is explicitly enabled, and exposes non-secret model provider labels. |
| `codex-phone-supervisor/backend/src/redaction.ts` | Shared secret redaction helpers. | `redactSensitiveText`, `redactSensitiveJson`, `redactCommandEvent` | Redacts bare `token=...` style assignments and planner/audit/command payloads before persistence or display. |
| `package.json` | Repo scripts. | `scripts.test` | Uses `--test-concurrency=1` to make backend subprocess health tests deterministic. |

## Tests

| File | Coverage |
| --- | --- |
| `codex-phone-supervisor/tests/completion-gate.test.ts` | Docs-only app output rejection, gate pass evidence, repair-node creation. |
| `codex-phone-supervisor/tests/app-output-validation.test.ts` | Static app validation rejects weak validation and accepts linked HTML/CSS/JS plus `node --check`. |
| `codex-phone-supervisor/tests/multi-worker.test.ts` | Task graph creation, docs context, worktrees, output contracts, prompt warnings, flowchart nodes. |
| `codex-phone-supervisor/tests/summary-truthfulness.test.ts` | Summaries report docs-only app nodes as incomplete. |
| `codex-phone-supervisor/tests/documentation-indexer.test.ts` | Project docs creation, function/variable/API/state docs, worker context docs, flowchart docs nodes. |
| `codex-phone-supervisor/tests/command-policy.test.ts` | Internal materializer command is allowed only through the command policy path. |
| `codex-phone-supervisor/tests/command-runner.test.ts` | Timed-out executor results become failed command events with exit code `124`. |
| `codex-phone-supervisor/tests/agentic-planning.test.ts` | Planner output parsing/fallbacks, vague/simple/multi-worker/GCP/risky conversation behavior, approval/revision, output contracts, no raw JSON, and planner flowchart nodes. |

## Data flow

User goal -> `AgenticPlanningController.decide` -> structured `PlannerDecision` -> optional clarification/proposal/approval -> approved plan -> `TaskGraphRecord` / `TaskGraphNode` with `WorkerOutputContract` -> `MultiWorkerCoordinator.buildWorkerContext` -> worker `renderCodexPrompt` -> `codex exec --json` returns structured `files_to_write` -> worker materializer writes those exact files through `CommandRunner` -> file status and validation commands -> worker `validateAppOutput` -> `/workers/:worker_id/result` -> `advanceAfterTaskResult` completion gate -> `generateRunSummary` / flowchart.

## Fragile areas

- Completion gates currently infer changed files from command event summaries/previews. The materializer command now emits `created: <path>` summaries, but non-materializer paths still need accurate changed-file summaries.
- Static app validation is intentionally conservative and may require contracts to specify concrete expected pages for complex prompts.
- `npm test` is intentionally serialized because full-suite parallel backend subprocess startup flakes health checks under load.
