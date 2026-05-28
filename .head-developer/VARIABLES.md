# Variable and Field Documentation

## Planner state fields

| Name | File | Type | Meaning | Writer | Reader | Default / allowed values | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SUPERVISOR_MODEL_PROVIDER` | env / `config.ts` | `string` | Runtime supervisor/planner provider. | environment/config default | config, model provider, planner | Defaults to `vertex`; `mock` is rejected. | Missing Vertex config must fail clearly, not fall back to a fake model. |
| `VERTEX_PROJECT_ID` / `VERTEX_LOCATION` / `VERTEX_MODEL` | env / `config.ts` | `string` | Required Vertex/Gemini supervisor configuration. | environment | `GcpGeminiPlannerModel`, supervisor model provider | Required when provider is `vertex` unless test double mode is active. | Do not print project-specific env values in logs/reports. |
| `CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL` | env / `config.ts` | `deterministic | unset` | Test-only deterministic supervisor/planner double. | isolated tests | config/model provider/planner | Requires `CODEX_PHONE_SUPERVISOR_TEST_MODE=1`. | Must not be used in local/Docker/production runtime. |
| `model_providers.supervisor_model_provider` / `planner_model_provider` / `worker_code_model` | `config.ts`, `types.ts` | `string` | Non-secret dashboard/API labels for user-facing supervisor, planner, and worker code model. | config | `/ready`, flowchart, dashboard | `Vertex/Gemini`, `Vertex/Gemini`, `Codex CLI`. | Must not include keys, tokens, credential paths, or project IDs. |
| `PlannerDecision.decision_type` | `types.ts` | enum | Model-selected next orchestration move, such as clarification, proposal, approval, simple start, multi-worker start, revise, continue, or blocker. | `PlannerModel` via `parsePlannerDecision` | `AgenticPlanningController`, `supervisor-tools.ts`, flowchart | Must be one of the allowed planner decision types. | Unknown values fail closed and trigger fallback. |
| `PlannerDecision.proposed_task_split` | `types.ts` | `PlannerTaskSplitItem[]` | Proposed worker/task split with titles, goals, dependencies, expected files, and validation commands. | planner model/fallback | approval UI, task graph creation, worker prompt | Empty for clarification/status/simple cases. | Multi-worker graph must match the approved split. |
| `PlannerDecision.requires_user_approval` | `types.ts` | `boolean` | Whether execution must pause for user approval. | planner model/fallback | supervisor pending action handler | `true` for multi-worker proposals, GCP workers, and risky actions. | False here can bypass approval gates. |
| `PlannerDecision.execution_allowed` | `types.ts` | `boolean` | Whether execution may begin immediately. | planner model/fallback | `startWorkerBackedProject` | Simple low-risk tasks can set true. | Must stay false for clarification, pending approval, blocked, and risky paths. |
| `SessionState.requirement_summary` / `ProjectRecord.requirement_summary` / `TaskGraphRecord.requirement_summary` | `types.ts` | `string | null` | Redacted planner requirements summary for continuity and worker context. | `AgenticPlanningController` and graph creation | flowchart, worker context, prompts, status answers | Null before first planner pass. | Should not contain secrets or unapproved scope drift. |
| `planner_output` | `types.ts` | `PlannerDecision | null` | Redacted structured planner decision retained for auditability and plan revision. | planner controller | pending-action handler, flowchart, docs/debug views | Null until planned. | Must be redacted before persistence. |
| `approved_plan` | `types.ts` | `ApprovedPlanRecord | null` | User-approved requirements, design, task split, worker count/mode, risk level, and approval reason. | `createApprovedGraphAndStart` | task graph, worker context, prompt, flowchart | Null until approval or no-approval simple start. | Workers must follow this plan; do not rewrite it silently. |
| `approval_status` | `types.ts` | `not_required | pending | approved | rejected | null` | Planner approval lifecycle state. | planner controller/pending handler | flowchart, status answers, coordinator review | Pending for multi-worker/GCP/risky proposals. | Incorrect status can launch work too early or leave work stuck. |
| `user_approved_worker_count` / `user_approved_worker_mode` | `types.ts` | `number | null`, `WorkerType | null` | Explicit worker count/mode approved by the user or accepted for a simple no-approval path. | planner approval/start path | graph creation, worker context, prompts, flowchart | Null until known. | Must be honored when user says "use one worker" or "use Docker local". |

## Output contract fields

| Name | File | Type | Meaning | Writer | Reader | Default / allowed values | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `WorkerOutputContract.required_app_files` | `types.ts` | `string[]` | App/source files or patterns required for an app node to complete. | `task-complexity.ts`, `multi-worker-coordinator.ts` | worker prompt, validation, completion gate | Empty for docs-only nodes. | Too vague means weak completion proof; too strict can block valid output. |
| `allowed_doc_files` | `types.ts` | `string[]` | Documentation files workers may update without satisfying app completion. | complexity/coordinator | worker prompt, completion gate | `.head-developer/*` docs. | Must not let docs-only changes pass app tasks. |
| `expected_user_visible_output` | `types.ts` | `string[]` | Human-visible output expected from a subtask. | complexity/coordinator | worker prompt, app validation, summaries | Prompt-specific list. | Summaries may be misleading if this is generic. |
| `validation_commands` | `types.ts` | `string[]` | Commands expected as proof for the node. | complexity/coordinator | worker prompt, completion gate | Static tasks include `node --check` variants. | Weak commands like `ls` must not be sufficient. |
| `docs_only_is_insufficient` | `types.ts` | `boolean` | Marks app nodes where docs-only output must fail. | complexity/coordinator | worker prompt, completion gate | `true` for app nodes, `false` for docs/setup nodes. | Core guard against fake app completion. |

## Worker output and materialization fields

| Name | File | Type | Meaning | Writer | Reader | Default / allowed values | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `files_to_write` | `worker-entry.ts` schema | `{ path: string; content: string }[]` | Exact file content Codex asks the worker to materialize. | Codex final JSON output | `materializeCodexFiles` | Required by schema; empty only for non-file tasks. | If missing, no app files are materialized and app nodes fail. |
| `WorkerOutputFile.path` | `worker-entry.ts` | `string` | Relative workspace path to write. | Codex final JSON output | `safeOutputFiles`, materializer script | Must be relative and inside workspace. | Absolute/outside paths are rejected to prevent workspace escape. |
| `WorkerOutputFile.content` | `worker-entry.ts` | `string` | Exact file bytes/text to write. | Codex final JSON output | materializer script | Any string content. | Large content is stored in runtime plan file before command execution. |
| `CODEX_PHONE_SUPERVISOR_RUNTIME_DIR` | environment / `worker-entry.ts` | `string` | Runtime directory for worker schema, materialization plan, and materializer script. | environment | worker runtime | Defaults to `/state/runtime`. | Command policy allows only the expected materializer path under `/state/runtime`; alternate paths may require policy updates. |
| `materializationPassed` | `worker-entry.ts` | `boolean` | Whether the logged materializer command exists and exited `0`. | `runAssignedTask` | task status/summary calculation | `true` only when materializer event exit code is `0`. | Prevents Codex exit `0` from being enough when no files were actually written. |
| `timed_out` | `CommandRunnerInput.executor` result / spawn result | `boolean` | Indicates the executor/child process hit the timeout policy. | executor or spawn timer | `CommandRunner.run` | Optional; false by default. | Forces exit code `124` to avoid false success on timed-out commands. |

## Completion gate task fields

| Name | File | Type | Meaning | Writer | Reader | Lifecycle |
| --- | --- | --- | --- | --- | --- | --- |
| `TaskRecord.completion_gate_status` | `types.ts` | `"passed" | "failed" | "not_applicable" | null` | Latest gate result for the task. | `advanceAfterTaskResult` | summaries, UI/state inspection | Set after worker result for graph nodes. |
| `completion_gate_reasons` | `types.ts` | `string[]` | Human-readable gate reasons. | coordinator | summaries/UI | Persisted with task for post-restart inspection. |
| `completion_gate_missing_required_app_files` | `types.ts` | `string[]` | Required app files not evidenced. | coordinator | summaries/repair planning | Empty when gate passes. |
| `completion_gate_docs_only` | `types.ts` | `boolean | null` | Whether observed output was docs-only. | coordinator | summaries/UI | `true` for docs-only app failures. |
| `TaskGraphNode.repair_task_for_node_id` | `types.ts` | `string | null` | Links a repair node back to the failed source node. | coordinator | flowchart/future repair scheduling | Set only on generated repair nodes. |

## Static SaaS shell classifier variables

| Name | File | Type | Meaning | Writer | Reader | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| `noBillingRequested` | `task-complexity.ts` | `boolean` | User explicitly excluded billing/Stripe/payment work. | local classifier | `TaskComplexityJudge.evaluate` | If missed, billing subtask may be added unnecessarily. |
| `noBackendRequested` | `task-complexity.ts` | `boolean` | User explicitly requested static/no backend output. | local classifier | static shell branch | If missed, task may be over-scoped. |
| `staticSaasShell` | `task-complexity.ts` | `boolean` | Detects static SaaS dashboard shell with landing/login/dashboard/settings and no billing. | local classifier | static shell branch | Must stay capability-based, not prompt-fixture based. |

## Documentation indexer constants

| Name | File | Type | Meaning | Default / allowed values | Risk |
| --- | --- | --- | --- | --- | --- |
| `DOCUMENTATION_INDEX_FILES` | `documentation-indexer.ts` | readonly string array | Docs written into generated project repos. | `CODE_INDEX.md`, `FUNCTIONS.md`, `VARIABLES.md`, `API_SURFACE.md`, `STATE_MODEL.md`, `WORKER_HANDOFFS.md`, `VALIDATION.md` | Missing file names break worker context and freshness checks. |
| `WORKER_CONTEXT_DOC_FILES` | `documentation-indexer.ts` | readonly string array | Docs workers should read before acting. | Project brief, task graph, architecture, code/function/variable/state docs, handoffs. | Worker prompts become under-contextualized if this list shrinks. |
| `SKIP_DIRS` | `documentation-indexer.ts` | `Set<string>` | Directories excluded from scans. | `.git`, `node_modules`, builds, caches. | Scanning generated dependencies can be slow/noisy. |
| `TEXT_EXTENSIONS` / `CODE_EXTENSIONS` | `documentation-indexer.ts` | `Set<string>` | Files eligible for docs scanning and AST parsing. | TS/JS/HTML/CSS/JSON/MD/SVG. | Unsupported frameworks may require extension updates. |

## Test runner script

| Name | File | Type | Meaning | Default / allowed values | Risk |
| --- | --- | --- | --- | --- | --- |
| `scripts.test` | `package.json` | command string | Runs the full Node test suite serially. | `tsx --test --test-concurrency=1 codex-phone-supervisor/tests/*.test.ts` | This is test determinism only. It avoids backend subprocess health flakes from parallel startup contention and does not change product runtime behavior. |
