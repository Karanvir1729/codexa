# Function-Level Documentation

## `AgenticPlanningController.decide`

- File: `codex-phone-supervisor/backend/src/agentic-planning.ts`
- Purpose: Build planner input from the user message, session/project/task/worker state, task graph state, complexity result, risk policy, approvals, constraints, and validation/output-contract context; then produce a structured next orchestration move.
- Inputs: `session`, `userMessage`, optional `project`, optional worker mode.
- Outputs: `{ decision, planner_model, session }`.
- Side effects: Stores redacted planning state on the session/project and emits `planner.decision.created`.
- Called by: `startWorkerBackedProject` and selected project planning paths in `supervisor-tools.ts`.
- Calls into: `PlannerModel.generatePlanningDecision`, `parsePlannerDecision`, `taskComplexityJudge.evaluate`, `classifyApproval`, store/project upserts.
- Validation coverage: `agentic-planning.test.ts`.
- Risk notes: Must remain model-driven. Do not convert this into a fixed checklist; deterministic fallback is allowed only in explicit test-double mode.

## `AgenticPlanningController.createApprovedGraphAndStart`

- File: `codex-phone-supervisor/backend/src/agentic-planning.ts`
- Purpose: Convert an approved planner decision into the matching task graph, persist approved planning metadata, prepare the project, and start ready workers.
- Inputs: session, project, original user goal, approved `PlannerDecision`, optional channel.
- Outputs: graph, project, worker assignments, approved plan, updated session.
- Side effects: Creates task graph, shared docs, worktrees/worker assignments, session/project planning state, and planner approval/execution events.
- Called by: `handlePendingConversationAction` after user approval and by simple execution decisions that do not require approval.
- Calls into: `decisionToComplexity`, `multiWorkerCoordinator.createTaskGraph`, `prepareProject`, `startReadyWork`.
- Validation coverage: `agentic-planning.test.ts`, `multi-worker.test.ts`.
- Risk notes: Approved task splits must not be silently rewritten. Any user revision should update the pending planner decision before graph creation.

## `parsePlannerDecision`

- File: `codex-phone-supervisor/backend/src/agentic-planning.ts`
- Purpose: Validate and normalize structured planner output.
- Inputs: unknown model output.
- Outputs: `PlannerDecision`.
- Side effects: None.
- Called by: `AgenticPlanningController.decide`, tests.
- Calls into: local enum/array/text normalization helpers.
- Validation coverage: `agentic-planning.test.ts`.
- Risk notes: Invalid output must fail closed so the deterministic fallback can ask/approve conservatively.

## `DeterministicFallbackPlannerModel.generatePlanningDecision`

- File: `codex-phone-supervisor/backend/src/agentic-planning.ts`
- Purpose: Conservative test-only planner for status questions, vague requests, simple static pages, multi-page dashboard splits, GCP worker approval, and risky action approval.
- Inputs: `PlannerInput`.
- Outputs: `PlannerDecision`.
- Side effects: None.
- Called by: explicit test-double mode and invalid model fallback path only when `CODEX_PHONE_SUPERVISOR_TEST_MODE=1`.
- Validation coverage: `agentic-planning.test.ts`, `web-text-flow.test.ts`, `multi-worker.test.ts`.
- Risk notes: Heuristics must stay general, must not hardcode smoke app names or project IDs, and must not be selectable through normal runtime provider config.

## `GcpGeminiPlannerModel.generatePlanningDecision`

- File: `codex-phone-supervisor/backend/src/agentic-planning.ts`
- Purpose: Call the configured GCP/Gemini Vertex model with planner context and a JSON schema, then parse the model's structured decision.
- Inputs: `PlannerInput`.
- Outputs: `PlannerDecision`.
- Side effects: Authenticates with Google ADC and calls Vertex AI when `SUPERVISOR_MODEL_PROVIDER=vertex`.
- Called by: `AgenticPlanningController` via `modelForConfig`.
- Calls into: `GoogleAuth`, Vertex `generateContent`, `parsePlannerDecision`.
- Validation coverage: offline parsing/fallback tests; live Gemini calls are not run in this local suite.
- Risk notes: GCP model use must not bypass approval gates for GCP workers, public deploys, IAM, secrets, broad mounts, or destructive actions. Runtime must fail clearly if Vertex/Gemini is not configured.

## `TaskComplexityJudge.evaluate`

- File: `codex-phone-supervisor/backend/src/task-complexity.ts`
- Purpose: Classify a user goal as simple/moderate/complex and produce suggested subtasks, dependencies, worker count, risks, and output contracts.
- Inputs: `user_goal`, optional project state, active tasks, active workers.
- Outputs: `TaskComplexityDecision`.
- Side effects: Reads repo files through `repoFiles`; no state writes.
- Called by: `MultiWorkerCoordinator.judge`.
- Calls into: `normalize`, `repoFiles`, `subtask`, `contract`, `edge`.
- Validation coverage: `multi-worker.test.ts` and conversation split tests.
- Risk notes: Keyword-based routing must not special-case smoke prompts; static SaaS shell branch is based on capability constraints (`saas`, `dashboard`, static/no backend/no billing), not fixed project names.

## `evaluateTaskGraphNodeCompletion`

- File: `codex-phone-supervisor/backend/src/completion-gate.ts`
- Purpose: Decide whether a task graph node has enough command-event evidence to be considered complete.
- Inputs: `TaskGraphNode`, command events, optional `now`.
- Outputs: `TaskGraphNodeCompletionGate`.
- Side effects: None.
- Called by: `MultiWorkerCoordinator.advanceAfterTaskResult`.
- Calls into: changed-file extraction, doc/app path matching, validation-command matching.
- Validation coverage: `completion-gate.test.ts`.
- Risk notes: Depends on workers logging changed files and validation commands accurately.

## `MultiWorkerCoordinator.advanceAfterTaskResult`

- File: `codex-phone-supervisor/backend/src/multi-worker-coordinator.ts`
- Purpose: Apply task completion results to task graph nodes, evaluate completion gates, create repair nodes when app output is incomplete, and start next ready work.
- Inputs: completed/failed/cancelled `TaskRecord`, worker mode.
- Outputs: updated graph and any new worker assignments.
- Side effects: Updates tasks/task graphs, appends orchestrator events, updates shared docs, may create repair tasks/nodes.
- Called by: `/workers/:worker_id/result` in `index.ts`.
- Calls into: `evaluateTaskGraphNodeCompletion`, `completionGatePassed`, `upsertTask`, `upsertTaskGraph`, `startReadyWork`.
- Validation coverage: `completion-gate.test.ts`, `multi-worker.test.ts`.
- Risk notes: The gate must run before summary generation to avoid overstated completion.

## `buildWorkerContext`

- File: `codex-phone-supervisor/backend/src/multi-worker-coordinator.ts`
- Purpose: Build the packet of project docs, approved planning metadata, output contract, allowed roots, validation expectations, and handoff rules for a worker.
- Inputs: project, task graph, node, optional worker ID.
- Outputs: `WorkerContextPacket`.
- Side effects: Runs `documentationIndexer.updateProjectDocs`, persists context packet, emits `worker_context.created`.
- Called by: `startReadyWork`.
- Calls into: `gitProjectManager.readSharedDocs`, `upsertWorkerContextPacket`.
- Validation coverage: `multi-worker.test.ts`, `documentation-indexer.test.ts`.
- Risk notes: Context must continue to include docs, approved requirements/plan, and output contracts for every worker mode.

## `renderCodexPrompt`

- File: `codex-phone-supervisor/backend/src/worker-entry.ts`
- Purpose: Render the prompt given to worker Codex execution.
- Inputs: task, project, optional worker context packet.
- Outputs: prompt string.
- Side effects: None.
- Called by: worker runtime before `codex exec`.
- Calls into: local prompt formatting helpers.
- Validation coverage: `multi-worker.test.ts`.
- Risk notes: Must keep approved requirements, approved plan, docs-only warning, and the `files_to_write` instruction; removing any of them can allow drift from the approved split or docs-only/tool-only worker output.

## `redactSensitiveText`

- File: `codex-phone-supervisor/backend/src/redaction.ts`
- Purpose: Redact secret-looking values from text before command previews, logs, audit records, planner records, and operator log displays are persisted or shown.
- Inputs: string.
- Outputs: redacted string.
- Side effects: None.
- Called by: command runner, store audit append, action-router log display, worker error handling, planner state redaction.
- Validation coverage: `command-runner.test.ts`, `operator-actions.test.ts`.
- Risk notes: Include bare `token=...` style assignments; gaps here can leak secrets through audit logs or UI log tails.

## `buildWorkerSchemaFile`

- File: `codex-phone-supervisor/backend/src/worker-entry.ts`
- Purpose: Write the JSON schema passed to `codex exec --output-schema` for worker output.
- Inputs: task ID.
- Outputs: absolute schema path under `CODEX_PHONE_SUPERVISOR_RUNTIME_DIR` or `/state/runtime`.
- Side effects: Creates the runtime directory and writes `<task>.worker-output.schema.json`.
- Called by: `runAssignedTask`.
- Calls into: `fs.mkdirSync`, `fs.writeFileSync`.
- Validation coverage: `multi-worker.test.ts` checks prompt/schema contract signals indirectly.
- Risk notes: `files_to_write` is required so Codex must produce exact content for worker materialization; schema drift can break Docker worker app creation.

## `extractFinalWorkerJson`

- File: `codex-phone-supervisor/backend/src/worker-entry.ts`
- Purpose: Parse Codex JSONL stdout and extract the final `agent_message` JSON payload.
- Inputs: raw stdout from a `CommandEventRecord`, including stdout read from `stdout_ref` when large.
- Outputs: parsed worker JSON with optional `files_to_write`, or `null` when the final payload is absent/invalid.
- Side effects: None.
- Called by: `materializeCodexFiles`.
- Calls into: `JSON.parse`.
- Validation coverage: covered by fresh two-worker smoke evidence; unit coverage should be expanded if this parser changes.
- Risk notes: It intentionally does not guess from partial output; no parsed `files_to_write` means no materializer command and the task fails validation.

## `safeOutputFiles`

- File: `codex-phone-supervisor/backend/src/worker-entry.ts`
- Purpose: Validate and normalize Codex-proposed output files before materialization.
- Inputs: unknown `files_to_write` value and workspace root.
- Outputs: safe relative `{ path, content }` entries.
- Side effects: None.
- Called by: `materializeCodexFiles`.
- Calls into: `path.resolve`, `path.relative`.
- Validation coverage: exercised by the two-worker smoke; add focused tests if path filtering changes.
- Risk notes: Rejects absolute paths, null bytes, and paths outside the workspace so Codex cannot write outside the assigned worktree.

## `materializerScriptPath`

- File: `codex-phone-supervisor/backend/src/worker-entry.ts`
- Purpose: Create or return the internal Node materializer script path.
- Inputs: `CODEX_PHONE_SUPERVISOR_RUNTIME_DIR` environment variable, defaulting to `/state/runtime`.
- Outputs: `/state/runtime/materialize-codex-files.mjs` or equivalent runtime-dir path.
- Side effects: Writes a small Node script that creates directories and writes exact file contents from a JSON plan.
- Called by: `materializeCodexFiles`.
- Calls into: filesystem APIs.
- Validation coverage: smoke command events `5aad22b0-d14e-419f-b090-af8100720ec5` and `cb39cac0-f66f-4c34-b98a-10c1775e4207`.
- Risk notes: The command policy only allows this exact internal script path.

## `materializeCodexFiles`

- File: `codex-phone-supervisor/backend/src/worker-entry.ts`
- Purpose: Convert Codex `files_to_write` output into real project files through a logged `CommandRunner` command.
- Inputs: task ID, project ID, worker ID, workspace, runtime metadata, and the Codex command event.
- Outputs: materializer `CommandEventRecord` or `null` when Codex did not return safe file content.
- Side effects: Writes `<task>.files-to-write.json`, runs the materializer command, posts the command event back to the API, and logs created-file summaries.
- Called by: `runAssignedTask` after Codex event posting and before file status/validation.
- Calls into: `extractFinalWorkerJson`, `safeOutputFiles`, `materializerScriptPath`, `CommandRunner.run`.
- Validation coverage: `command-policy.test.ts`, fresh two-worker smoke.
- Risk notes: This preserves the product rule that Codex produces the content while the worker performs deterministic, logged file writes.

## `validateAppOutput`

- File: `codex-phone-supervisor/backend/src/app-output-validation.ts`
- Purpose: Validate that static app tasks produced real app files, linked assets, required page signals, and JS validation evidence.
- Inputs: workspace path, changed files, command events, optional worker context.
- Outputs: `AppOutputValidationResult`.
- Side effects: Reads generated files from disk; no state writes.
- Called by: `worker-entry.ts` after Codex execution.
- Calls into: safe file reads, asset-reference parsing, expected-file and page checks.
- Validation coverage: `app-output-validation.test.ts`.
- Risk notes: Conservative checks may require better output contracts for non-static frameworks.

## `CommandRunner.run`

- File: `codex-phone-supervisor/backend/src/command-runner.ts`
- Purpose: Execute or delegate a command, persist start/end command events, enforce command policy, and emit orchestrator command events.
- Inputs: `CommandRunnerInput` with task/project/worker IDs, command/args, cwd, workspace path, optional timeout, runtime metadata, and optional executor.
- Outputs: `CommandEventRecord`.
- Side effects: Writes command events, command log artifacts for large stdout/stderr, task command counts, and orchestrator events.
- Called by: worker runtime, GitProjectManager, operator actions, and validation paths.
- Calls into: `classifyCommand`, child process `spawn`, store upserts.
- Validation coverage: `command-runner.test.ts`.
- Risk notes: Timed-out commands must always become exit code `124`; otherwise summaries could overstate incomplete Codex work.

## `classifyCommand`

- File: `codex-phone-supervisor/backend/src/command-policy.ts`
- Purpose: Decide whether a command is allowed, blocked, or requires approval.
- Inputs: command text, cwd, workspace path, and approval flag.
- Outputs: `CommandPolicyDecision`.
- Side effects: None.
- Called by: `CommandRunner.run`.
- Calls into: path containment helper and regex allow/approval/block rules.
- Validation coverage: `command-policy.test.ts`.
- Risk notes: The internal materializer allowlist is intentionally narrow: `node /state/runtime/materialize-codex-files.mjs ...`.

## `assessTaskCompletionForSummary`

- File: `codex-phone-supervisor/backend/src/summary.ts`
- Purpose: Ground summaries in command events, workspace files, and task graph completion gates.
- Inputs: task ID and optional command events.
- Outputs: `SummaryCompletionAssessment`.
- Side effects: Reads store/project workspace files; no writes.
- Called by: `generateRunSummary`, `generateTaskGraphTruthfulnessSummary`.
- Calls into: `getTask`, `getProject`, `getTaskGraph`, workspace file scanners.
- Validation coverage: `summary-truthfulness.test.ts`.
- Risk notes: Should remain aligned with completion gate semantics.

## `DocumentationIndexer.updateProjectDocs`

- File: `codex-phone-supervisor/backend/src/documentation-indexer.ts`
- Purpose: Scan a project repo and write `.head-developer` docs for files, functions, variables, API routes, state fields, validation, and handoffs.
- Inputs: `ProjectRecord`, optional changed files.
- Outputs: `DocumentationIndexResult`.
- Side effects: Writes docs under the project repo, updates project docs metadata, emits events.
- Called by: `MultiWorkerCoordinator.buildWorkerContext`, project docs flows.
- Calls into: AST/static scanners, renderers, freshness checks.
- Validation coverage: `documentation-indexer.test.ts`.
- Risk notes: AST coverage is best-effort; safe fallbacks must not hallucinate symbols.

## `/workers/:worker_id/result` handler

- File: `codex-phone-supervisor/backend/src/index.ts`
- Purpose: Accept worker task results, clear leases, run graph completion gates, reload gated task state, then generate grounded summaries and advance graph work.
- Inputs: worker ID path parameter and worker result body.
- Outputs: JSON `{ task }`.
- Side effects: Heartbeat update, task/lease updates, graph updates, summary events, session updates.
- Called by: worker callback path.
- Calls into: `workerManagerFor(...).handleTaskResult`, `multiWorkerCoordinator.advanceAfterTaskResult`, `cloudOrchestrator.completeTask`.
- Validation coverage: `completion-gate.test.ts`, broader worker/result tests.
- Risk notes: Summary must use the post-gate task state, not the original optimistic worker result.
