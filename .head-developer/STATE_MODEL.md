# State Model Notes

## Agentic planning state

Lifecycle: `AgenticPlanningController.decide` creates a redacted `PlannerDecision` from model/fallback output and stores it on the session and project. If execution requires approval, `supervisor-tools.ts` stores the same decision in the pending action. Approval or a simple low-risk start creates an `ApprovedPlanRecord`, then `MultiWorkerCoordinator.createTaskGraph` copies the planning metadata into the task graph. Worker context packets copy the graph planning metadata into worker prompts.

| Field | Type | Writer | Reader | Meaning |
| --- | --- | --- | --- | --- |
| `requirement_summary` | `string | null` | planner controller / approved graph creation | flowchart, status answers, worker context | Redacted summary of what the user asked for and what is approved. |
| `planning_decision_id` | `string | null` | planner controller | flowchart, pending approval, worker context | Stable ID tying planner decision, approval, graph, and execution nodes together. |
| `planner_model` | `string | null` | planner controller | flowchart/debug docs | Model source, for example GCP Gemini or deterministic fallback. |
| `planner_output` | `PlannerDecision | null` | planner controller | pending-action handler, flowchart | Redacted structured decision; invalid model output is replaced by fallback output. |
| `approved_plan` | `ApprovedPlanRecord | null` | approval/start path | graph creation, worker context, prompt | Approved requirements/design/split/worker count/mode. |
| `approval_status` | approval enum | planner and pending-action handlers | flowchart/status | `pending` for proposals that must wait, `approved` after user approval, `not_required` for simple safe starts. |
| `open_questions` / `assumptions` | `string[]` | planner controller | conversation/status/debug | Questions or assumptions the model surfaced. |
| `design_decision_history` | `DesignDecisionRecord[]` | planner controller | project/session history | Rolling record of recent planning decisions. |
| `user_approved_worker_count` / `user_approved_worker_mode` | `number | null` / `WorkerType | null` | planner approval/start path | graph creation, worker context, prompt | Worker count/mode the user approved or the simple-task path accepted. |

Security rule: planner state is redacted before persistence. It is not a place to store raw credentials, env values, tokens, IAM material, or Codex auth data.

## `WorkerOutputContract`

Lifecycle: Created by `TaskComplexityJudge` or `MultiWorkerCoordinator.buildOutputContract`, persisted in `TaskGraphNode`, copied into `WorkerContextPacket`, rendered into worker prompts, and checked by worker validation/completion gates.

| Field | Type | Required | Writer | Reader | Migration note |
| --- | --- | --- | --- | --- | --- |
| `required_app_files` | `string[]` | yes | complexity/coordinator | worker, validation, completion gate | Existing nodes without the field should be treated as empty arrays. |
| `allowed_doc_files` | `string[]` | yes | complexity/coordinator | worker, completion gate | Defaults to `.head-developer` docs. |
| `expected_user_visible_output` | `string[]` | yes | complexity/coordinator | worker, validation, summary | Used for truthful progress and summary language. |
| `validation_commands` | `string[]` | yes | complexity/coordinator | worker, completion gate | Should contain meaningful checks, not only file listing. |
| `acceptance_checks` | `string[]` | yes | complexity/coordinator | worker prompt/UI | Human-readable checklist. |
| `completion_criteria` | `string[]` | yes | complexity/coordinator | worker prompt/UI | Includes docs-only rejection for app nodes. |
| `docs_only_is_insufficient` | `boolean` | yes | complexity/coordinator | worker, gate | Must be `true` for app-building nodes. |

## `TaskGraphNodeCompletionGate`

Lifecycle: Generated after worker result for task graph nodes. Stored on the node and mirrored onto `TaskRecord` fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `"passed" | "failed" | "not_applicable"` | Whether the node completion evidence passed. |
| `reasons` | `string[]` | Why the gate passed or failed. |
| `changed_files` | `string[]` | Files inferred from command event summaries/stdout/stderr. |
| `app_files` | `string[]` | Non-doc app/source files observed. |
| `docs_only` | `boolean` | True when only documentation changes were observed. |
| `missing_required_app_files` | `string[]` | Required files/patterns not evidenced. |
| `validation_commands_run` | `string[]` | Matching validation commands observed. |
| `missing_validation_commands` | `string[]` | Required validation commands not observed. |

## `TaskRecord` completion-gate fields

| Field | Type | Meaning | Writer | Reader |
| --- | --- | --- | --- | --- |
| `completion_gate_status` | gate status or null | Latest gate status for the task. | `MultiWorkerCoordinator.advanceAfterTaskResult` | summaries, flowchart/state inspection. |
| `completion_gate_reasons` | `string[]` | Gate reasons. | coordinator | summary/debug views. |
| `completion_gate_missing_required_app_files` | `string[]` | Missing app evidence. | coordinator | repair planning. |
| `completion_gate_docs_only` | `boolean | null` | Whether output was docs-only. | coordinator | summary/UI. |

## `TaskGraphNode` repair fields

| Field | Type | Meaning |
| --- | --- | --- |
| `repair_task_for_node_id` | `string | null` | Present on repair nodes created because a source node failed the completion gate. |

## `WorkerContextPacket` docs and contract fields

| Field | Type | Meaning |
| --- | --- | --- |
| `relevant_docs` | record of doc path to content | Shared project docs read by the worker before acting. |
| `expected_files` | `string[]` | Files/patterns the worker is expected to produce/update. |
| `validation_commands` | `string[]` | Validation commands the worker should run where applicable. |
| `output_contract` | `WorkerOutputContract` | Machine-readable completion contract for the task graph node. |

## Worker Codex output schema

Lifecycle: Written per task by `buildWorkerSchemaFile`, supplied to `codex exec --output-schema`, parsed from Codex JSONL stdout, and used only as the source plan for logged materialization.

| Field | Type | Required | Meaning | Writer | Reader |
| --- | --- | --- | --- | --- | --- |
| `summary` | `string` | yes | Codex's short task summary. | Codex final JSON | worker result summary context. |
| `status` | enum | yes | Codex self-reported status. | Codex final JSON | worker runtime; not trusted alone for task completion. |
| `files_modified` | `string[]` | yes | Codex-reported changed files. | Codex final JSON | command summaries/debugging. |
| `files_to_write` | `{ path: string; content: string }[]` | yes | Exact content that the worker writes through the materializer command. | Codex final JSON | `materializeCodexFiles`. |
| `test_results` | structured array | yes | Codex-reported test/validation notes. | Codex final JSON | summaries/debugging. |

Completion rule: `files_to_write` content still is not sufficient by itself. The worker must materialize it through a logged command event, run validation, and pass `validateAppOutput` plus the graph completion gate.

## `CommandEventRecord` materialization and timeout evidence

| Field | Type | Meaning | Writer | Reader |
| --- | --- | --- | --- | --- |
| `command` | `string` | Materialization events use `node /state/runtime/materialize-codex-files.mjs <plan>`. | `CommandRunner.run` | flowchart, summaries, command history. |
| `summary` | `string` | Materialization events list `created: <path>` lines; timeout events say `Command timed out after ...`. | worker runtime / CommandRunner | completion gate, summaries. |
| `exit_code` | `number | null` | Materializer and validation must exit `0`; timed-out commands are `124`. | `CommandRunner.run` | completion gate, summaries, flowchart. |
| `stdout_ref` / `stderr_ref` | `string | null` | Large Codex JSONL/log output artifact paths. | `CommandRunner.run` | Codex history bridge and worker parser. |

## Documentation index state

`DocumentationIndexResult` and `DocumentationFreshnessReport` describe generated project docs. They are not a replacement for task completion evidence. Freshness can recommend a follow-up documentation task, but docs-only changes do not satisfy app-building nodes.
