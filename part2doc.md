# Part 2 Documentation

## Overview

This document describes the current local Codex supervisor architecture in this repo. It focuses on the v1 path where one local Codex CLI session owns the project repo, while logical Codex subagents are represented as responsibility lanes in the browser flowchart.

The main areas covered are:

- Browser UI: `codex-phone-supervisor/frontend/src/main.tsx`
- Local Codex orchestration: `codex-phone-supervisor/backend/src/codex-session-local.ts`
- Megaplan generation: `codex-phone-supervisor/backend/src/megaplan.ts`
- Flowchart state generation: `codex-phone-supervisor/backend/src/flowchart.ts`
- Runtime configuration: `codex-phone-supervisor/backend/src/config.ts`
- State contracts: `codex-phone-supervisor/backend/src/types.ts`
- Focused tests: `codex-phone-supervisor/tests/flowchart-ui.test.ts` and `codex-phone-supervisor/tests/codex-session-local.test.ts`

The current product path is local-first:

1. User talks to the browser UI.
2. Backend routes planning/intake through Codex-backed local orchestration.
3. Megaplan is created and approval is requested for complex work.
4. One local Codex CLI implementation session starts after approval.
5. Codex chooses how many logical subagents are useful.
6. A parallel flowchart-maker Codex helper writes concise JSON for the UI.
7. A parallel subagent-advisor Codex helper watches for useful subagent opportunities.
8. Local validation runs.
9. Preview opens locally when applicable.
10. A final quality-check Codex helper audits the result.
11. Final summary and Codex history metadata are persisted.

Distributed worker modes still exist in the repo for legacy or experimental paths, but the main UI is designed to present the local Codex CLI flow.

## Verification Snapshot

These checks were run before this document was written:

```bash
npm run typecheck
npm run build
npx tsx --test --test-concurrency=1 codex-phone-supervisor/tests/flowchart-ui.test.ts codex-phone-supervisor/tests/codex-session-local.test.ts
```

Result:

- `npm run typecheck` passed.
- `npm run build` passed.
- Focused tests passed with 16 passing tests and 1 intentionally skipped real-Codex smoke.

The focused tests cover:

- Direct local Codex CLI orchestration.
- Same-account full-access Codex settings.
- Piped `stdout` and `stderr` from the real Codex CLI process.
- Browser chat resume mirroring into a Codex resume session.
- Megaplan GitHub repo URL rendering.
- Flowchart maker timeout behavior.
- Subagent advisor timeout behavior.
- Final quality check behavior.
- Continuous flowchart watcher behavior.
- Validation rejection for missing files and docs-only success.
- New-session reset safety.
- Flowchart UI without legacy worker controls.
- Solid parallel subagent pipeline instead of dashed lanes.

## Runtime Commands

The root `package.json` exposes the main local scripts:

```bash
npm run dev:backend
npm run dev:frontend
npm run build
npm run typecheck
npm run test
npm run codex:local
```

Additional smoke scripts exist:

```bash
npm run smoke:docker-single-worker-app
npm run smoke:docker-two-worker-static-dashboard
npm run smoke:preview
npm run smoke:codex-history
npm run smoke:gcp-vm-safe-command
```

The local browser app normally runs with:

- Backend: `npm run dev:backend`
- Frontend: `npm run dev:frontend`
- Browser URL: `http://127.0.0.1:4318/`
- Backend URL: `http://127.0.0.1:4317/`

Local compose configuration can be checked with:

```bash
docker compose -f docker/docker-compose.local.yml config
```

`docker/docker-compose.local.yml` defines the local API on port `4317` and the frontend on port `4318`. The API service is configured for `WORKER_MODE=codex_session_local`, `DEFAULT_WORKER_MODE=codex_session_local`, and `HEAD_DEVELOPER_DEFAULT_WORKER_TYPE=codex_session_local`. It mounts generated projects at `/generated-projects`, file state at `/state`, and the host Codex home into `/codex-home` read-only.

## Frontend UI

The browser UI is implemented in `codex-phone-supervisor/frontend/src/main.tsx`.

It is a single React entrypoint that:

- Talks to the supervisor backend.
- Streams local Codex CLI events.
- Renders browser chat.
- Shows runtime settings.
- Shows the Codex CLI terminal stream.
- Renders the Codex session flowchart.
- Renders the Megaplan approval panel.
- Shows node-level flowchart details.

### Frontend Data Types

Important frontend data types in `main.tsx` include:

- `SessionEvent`
- `Session`
- `TaskRecord`
- `PreviewMetadata`
- `RuntimeSettings`
- `FlowchartState`
- `FlowchartNode`
- `FlowchartEdge`
- `MegaplanRecord`
- `ChatMessage`

`FlowchartState` is the browser graph contract:

- `nodes`: array of `FlowchartNode`
- `edges`: array of `FlowchartEdge`

`FlowchartNode` carries:

- `id`
- `type`
- `label`
- `status`
- `visual_state`
- `summary`
- `detail`
- `position`

`FlowchartEdge` carries:

- `id`
- `from`
- `to`
- `label`

### Frontend Runtime Environment

The UI requires these Vite env values:

- `VITE_SUPERVISOR_API_BASE`
- `VITE_SUPERVISOR_WORKSPACE_PATH`
- `VITE_SUPERVISOR_USER_ID`

They are read into:

- `apiBase`
- `workspacePath`
- `supervisorUserId`

Startup fails if any of these are missing.

### Frontend Helper Functions

Important general helpers:

- `makeId()`: wraps `crypto.randomUUID()`.
- `asRecord(value)`: safely treats an unknown value as a record.
- `stringValue(value)`: returns a non-empty string or `""`.
- `hostVisibleCodexRolloutPath(detail, command)`: picks the best host-visible rollout path for Codex history display.
- `hostVisibleCodexHomePath(detail, command)`: picks the best host-visible Codex home path for Codex history display.
- `readJsonResponse(res)`: parses API responses and throws `ApiError` for structured failures.

Codex terminal helpers:

- `codexTerminalEvents(session)`: filters session events to local Codex and CLI events.
- `renderTerminalEvent(event)`: converts Codex event records into terminal-style text.

Markdown/UI helpers:

- `renderInlineMarkdown(text)`: renders inline code and markdown links.
- `renderMegaplanMarkdown(text)`: renders Megaplan markdown in the browser UI.
- `displayFlowText(text)`: prepares flowchart-safe display text.

### Frontend React State

`App()` stores these important state variables:

- `sessionId`: active supervisor session id.
- `task`: text task input state.
- `instruction`: instruction input state.
- `chatInput`: browser chat textarea value.
- `chatMessages`: displayed chat transcript.
- `isListening`: browser voice input state.
- `voiceStatus`: voice UI status.
- `session`: current `Session` payload.
- `tasks`: current project task list.
- `flowchart`: current `FlowchartState`.
- `megaplan`: current Megaplan record.
- `runtimeSettings`: local Codex runtime settings from `/ready`.
- `selectedNodeId`: active flowchart detail node.
- `orchestratorTaskStatus`: status text for send/start actions.
- `sessionResetStatus`: status text for reset/delete actions.
- `flowPanelWidth`: measured flowchart panel width.

Important refs:

- `recognitionRef`: browser speech recognition instance.
- `cliStreamRef`: terminal stream scroll container.
- `flowPanelRef`: measured flowchart panel container.
- `staleSessionNoticeRef`: deduplicates stale session messages.
- `pollFailureCountRef`: tracks consecutive refresh failures.
- `refreshErrorNoticeRef`: deduplicates refresh error notices.
- `progressEventIdsRef`: prevents duplicate progress messages.
- `voiceProgressEnabledRef`: controls spoken progress updates.

### Frontend API Flow

Startup effects:

- Restore `codex-phone-supervisor-session` from `localStorage`.
- Fetch `${apiBase}/ready` and store `runtimeSettings`.
- Persist `sessionId` back into `localStorage`.
- Auto-scroll the CLI stream when `session.raw_events.length` changes.
- Use `ResizeObserver` to keep `flowPanelWidth` current.

Session loading helpers:

- `fetchSession(targetSessionId)`: fetches `/codex/status?session_id=...`.
- `existingSessionIsValid(targetSessionId)`: checks if a saved session still exists.
- `loadLatestSession()`: fetches `/codex/status`, picks the latest session, then calls `refresh()`.
- `ensureSupervisorSession(label)`: creates or reuses a supervisor session.

Refresh helpers:

- `refresh(targetSessionId)`: fetches session status, project tasks, Megaplan content, and the flowchart.
- `appendProgressMessages(targetSession)`: maps new `progress.update` events into browser chat messages.
- `loadFlowchart()`: fetches `/orchestrator/flowchart`, stores it, and selects a default node.

Polling:

- `loadFlowchart()` runs every 2 seconds.
- `refresh()` runs every 2 seconds once a `sessionId` exists.

## Flowchart Pipeline

The browser flowchart is rendered from backend-provided `FlowchartState`, then compacted in the frontend.

### Flowchart Constants

The main layout constants are:

- `FLOW_NODE_WIDTH = 190`
- `FLOW_NODE_HEIGHT = 126`
- `FLOW_COLUMN_GAP = 34`
- `FLOW_ROW_GAP = 32`
- `FLOW_PADDING = 24`
- `FLOW_COLUMNS = 4`

State colors are defined in `flowStateColors` for:

- `idle`
- `planning`
- `waiting_for_approval`
- `completed`
- `failed`
- `running`
- `warning`

### Flowchart Layout Helpers

Important helpers:

- `flowNodeStyle(node)`: turns a node into an absolute-positioned card style.
- `flowGraphSize(nodes)`: computes graph canvas width and height.
- `compactFlowchartLayout(nodes, columns)`: sorts and positions nodes.
- `localFlowchartNodes(flowchart, taskIds, currentSessionId)`: filters the raw global graph to the local Codex view.
- `localFlowchartTaskId(node)`: extracts task ids from local Codex flowchart node ids.
- `flowEdgePath(from, to)`: builds normal SVG edge paths.

`compactFlowchartLayout()` prioritizes these node types:

1. `orchestrator`
2. `user_request`
3. `requirement_summary`
4. `codex_plan`
5. `user_approval`
6. `codex_session`
7. `subagent_advisor`
8. `flowchart_maker`
9. `codex_subagent`
10. `validation`
11. `preview`
12. `quality_check`
13. `final_summary`

### Parallel Subagent Circuit

The current UI does not render parallel subagents as a dashed highlight. It renders them as a circuit-style vertical pipeline.

The special layout activates when:

- There is more than one `codex_subagent`.
- The measured flowchart width allows at least 3 columns.

In that case:

- Column 0 contains the main Codex process.
- The middle column contains the vertical stack of Codex-chosen subagents.
- The right column contains validation, preview, final quality check, and final summary.
- `subagent_advisor` and `flowchart_maker` are helper process nodes near the pipeline.

Important functions:

- `parallelCircuit(nodes)`: computes the split bus, join bus, node centers, and bounds for the parallel circuit.
- `isParallelCircuitEdge(edge, from, to)`: hides duplicate generic edges when the circuit renderer is active.

`parallelCircuit()` only returns a circuit when:

- A `codex_session` node exists.
- A `validation` node exists.
- There are at least two `codex_subagent` nodes.
- All subagents are in one column.
- The subagent column is between the Codex session column and validation column.

The SVG circuit uses:

- `data-testid="parallel-agent-pipeline"`
- `flow-arrow-parallel`
- Solid purple paths.
- No `strokeDasharray`.
- No `data-testid="parallel-agent-lanes"`.

The focused UI test enforces these details.

## Backend Local Codex Orchestration

The local backend is centered in `codex-phone-supervisor/backend/src/codex-session-local.ts`.

Important constants:

- `LOCAL_CODEX_BACKEND = "codex_session_local"`
- `LOCAL_CODEX_WORKER_ID`
- `FLOWCHART_MAKER_TIMEOUT_MS = 5_000`
- `FLOWCHART_WATCHER_INTERVAL_MS = 1_000`
- `FLOWCHART_UPDATE_THROTTLE_MS = 1_000`
- `SUBAGENT_ADVISOR_WATCHER_TIMEOUT_MS = 5_000`
- `SUBAGENT_ADVISOR_WATCHER_INTERVAL_MS = 1_000`
- `SUBAGENT_ADVISOR_UPDATE_THROTTLE_MS = 1_000`
- `QUALITY_CHECK_TIMEOUT_MS = 180_000`

Important in-memory watcher maps:

- `liveRolloutPaths`
- `flowchartMakerState`
- `subagentAdvisorWatcherState`

### Implementation Prompt

`buildLocalCodexImplementationPrompt(input)` creates the implementation prompt for the real Codex CLI session.

The prompt tells Codex:

- It is the local orchestrator and implementation lead.
- The user is talking directly to the CLI-backed session.
- One local Codex CLI session owns the repo.
- Codex chooses how many logical subagents to use.
- Subagents are logical responsibility lanes inside this CLI run.
- No disconnected workspaces, worker worktrees, Docker workers, GKE jobs, VM workers, or cloud control-plane resources should be used for this path.
- `.head-developer/MEGAPLAN.md` is the approved plan when present.
- Success requires real files and passing validation.
- Subagent progress updates should be user-facing and omit file paths, commands, internal ids, branch names, and stack traces.
- The final JSON must include `summary`, `final_summary`, `files_changed`, `required_files`, `validation_commands`, `docs_updated`, `preview_entry`, `subagents`, `flowchart_summary`, and `errors`.

Important prompt input variables:

- `userGoal`
- `project`
- `requirementSummary`
- `approvedPlan`
- `plannerDecision`
- `conversationTranscript`
- `proposedResponsibilities`
- `subagentAdvice`

### Starting A Local Codex Session

`startLocalCodexSession(input)`:

- Builds the implementation prompt.
- Captures files before the run.
- Initializes `.head-developer` docs/state.
- Creates or updates the task and session state.
- Starts `completeLocalCodexRun()` asynchronously.

`runCodexCli(input)`:

- Builds a schema path with `buildSchemaFile()`.
- Builds a final output path under `config.runtimeDir`.
- Creates a `CommandEventRecord`.
- Appends `local_codex_session.started`.
- Starts the flowchart watcher.
- Starts the subagent advisor watcher.
- Spawns `config.codexCommand` with `codex exec`.
- Uses `cwd: input.project.workspace_path`.
- Sets `CODEX_HOME: config.codexHome`.
- Pipes child `stdout` and `stderr`.
- Records Codex history metadata after completion.

Important `runCodexCli()` variables:

- `schemaPath`
- `finalMessagePath`
- `commandEventId`
- `startedAt`
- `args`
- `commandDisplay`
- `commandEvent`
- `child`
- `stdout`
- `stderr`

The command args include:

- `exec`
- shared model/profile/reasoning args from `codexSharedArgs()`
- `--json`
- `--color never`
- `--output-schema`
- `--output-last-message`
- `-C <workspace path>`
- `--skip-git-repo-check`
- access args from `codexImplementationAccessArgs()`
- `-` for stdin prompt input

### Completing A Local Codex Run

`completeLocalCodexRun(input)` handles the post-run lifecycle:

- Calls `runCodexCli()`.
- Parses the final Codex report.
- Discovers changed files.
- Runs local validation.
- Starts preview when applicable.
- Runs final quality check.
- Writes flowchart/state/validation artifacts.
- Updates `TaskRecord` and `SessionState`.
- Marks completion only when the run, validation, and quality gates permit it.

## Runtime Configuration

Runtime configuration lives in `codex-phone-supervisor/backend/src/config.ts`.

The config loader reads environment from the process and supports env-file based local configuration unless `CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES=1` is set. Tests commonly set `CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES=1` to isolate their environment.

Important local Codex config fields:

- `config.codexCommand`
- `config.codexHome`
- `config.localCodex.model`
- `config.localCodex.profile`
- `config.localCodex.profileV2`
- `config.localCodex.reasoningEffort`
- `config.localCodex.planningModel`
- `config.localCodex.planningProfile`
- `config.localCodex.planningProfileV2`
- `config.localCodex.planningReasoningEffort`
- `config.localCodex.mirrorBrowserConversationToResume`
- `config.localCodex.sandbox`
- `config.localCodex.bypassApprovalsAndSandbox`
- `config.localCodex.inheritShellEnvironment`

Important default behavior:

- `CODEX_PHONE_SUPERVISOR_CODEX_MODEL` falls back to `CODEX_MODEL`, then `gpt-5.5`.
- `CODEX_PHONE_SUPERVISOR_CODEX_REASONING_EFFORT` defaults to `xhigh`.
- `CODEX_PHONE_SUPERVISOR_CODEX_PLANNING_REASONING_EFFORT` defaults to `low`.
- `CODEX_PHONE_SUPERVISOR_CODEX_SANDBOX` defaults to `danger-full-access`.
- `CODEX_PHONE_SUPERVISOR_CODEX_BYPASS_APPROVALS_AND_SANDBOX` defaults to enabled.
- `CODEX_PHONE_SUPERVISOR_CODEX_INHERIT_SHELL_ENV` defaults to enabled.

The orchestrator defaults are local:

- `orchestrator.workerMode` defaults to `codex_session_local`.
- `orchestrator.defaultWorkerType` defaults to `codex_session_local`.

Allowed worker mode values still include legacy modes:

- `codex_session_local`
- `local`
- `docker_local`
- `gcp_vm`
- `gke_job`

Allowed reasoning efforts are:

- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

The `/ready` endpoint exposes local Codex readiness metadata to the browser UI. The frontend uses it to display model, coding reasoning, fast planning reasoning, access mode, inherited shell behavior, skill inventory, plugin/account configuration, and browser chat resume status.

## Megaplan And Approval

Megaplan generation lives in `codex-phone-supervisor/backend/src/megaplan.ts`.

Important functions:

- `buildMegaplanMarkdown(input)`
- `writeMegaplan(input)`
- `getMegaplanForSession(session)`

Megaplan approval is queued through `queueLocalMegaplanApproval()` in `codex-phone-supervisor/backend/src/supervisor-tools.ts`.

`queueLocalMegaplanApproval()`:

- Forces the local implementation mode to `codex_session_local`.
- Keeps worker count at one.
- Runs subagent advice before approval.
- Writes `.head-developer/MEGAPLAN.md`.
- Stores `pending_action.type = "approve_megaplan"`.
- Waits for the user to approve before implementation starts.

When the user approves, the pending-plan branch in `supervisor-tools.ts` creates an `ApprovedPlanRecord` and calls `startLocalCodexSession()`.

The browser UI renders the Megaplan through:

- `megaplan`
- `setMegaplan`
- `renderMegaplanMarkdown()`
- `Approve Megaplan` button
- `/sessions/:session_id/megaplan`

Megaplan repo metadata is displayed with:

- `megaplan.repo.name`
- `megaplan.repo.web_url`
- `megaplan.repo.branch`
- `megaplan.repo.commit`
- `megaplan.updated_at`

## Watchers And Helper Codex Sessions

The backend uses helper Codex sessions to keep the UI useful without blocking the main implementation session.

### Flowchart Watcher

Important functions:

- `startFlowchartWatcher(input)`
- `runFlowchartMakerOnce(input)`
- `scheduleFlowchartSummaryUpdate(input)`
- `fallbackFlowchartSummary(input)`

Important variables:

- `FLOWCHART_MAKER_TIMEOUT_MS`
- `FLOWCHART_WATCHER_INTERVAL_MS`
- `FLOWCHART_UPDATE_THROTTLE_MS`
- `flowchartMakerState`
- `liveRolloutPaths`

Behavior:

- Polls while the implementation task is running.
- Summarizes workspace activity.
- Reads live Codex rollout JSONL when available.
- Runs a short read-only Codex helper to produce browser-safe flowchart JSON.
- Falls back to local summaries when generated JSON is missing.

### Subagent Advisor Watcher

Important functions:

- `runSubagentAdvisor()`
- `startSubagentAdvisorWatcher(input)`
- `runSubagentAdvisorWatcherOnce(input)`
- `scheduleSubagentAdvisorUpdate(input)`

Important variables:

- `SUBAGENT_ADVISOR_WATCHER_TIMEOUT_MS`
- `SUBAGENT_ADVISOR_WATCHER_INTERVAL_MS`
- `SUBAGENT_ADVISOR_UPDATE_THROTTLE_MS`
- `subagentAdvisorWatcherState`

Behavior:

- Runs as a fast read-only Codex process.
- Recommends whether subagents are useful.
- Updates `task.codex_subagent_advisor`.
- Writes `.head-developer/subagent-advisor.json`.
- Does not decide the actual implementation subagents. The implementation Codex session remains the source of truth for actual subagent names and count.

### Final Quality Check

Important function:

- `runFinalQualityCheck(input)`

Important variables and artifacts:

- `QUALITY_CHECK_TIMEOUT_MS = 180_000`
- `task.codex_quality_check`
- `task.codex_quality_check_path`
- `.head-developer/QUALITY_CHECK.json`
- `.head-developer/QUALITY_CHECK.md`

Behavior:

- Runs after validation and preview work.
- Uses Codex as an audit-only reviewer.
- Checks the user request, Megaplan, validation evidence, and functionality.
- For UI projects, requires browser, Playwright, Chrome, or Computer Use inspection when a preview exists.

## Flowchart Backend State

Flowchart state is built in `codex-phone-supervisor/backend/src/flowchart.ts`.

Important functions:

- `buildFlowchartState()`
- `readLocalCodexFlowchartJson(task)`
- `normalizeLocalFlowchartSummary(value)`
- `withLocalSystemProcessNodes(summary, qualityCheck)`
- `subagentAdvisorSummaryTextForFlowchart(advisor)`

Important local node kinds:

- `user_request`
- `requirement_summary`
- `plan`
- `megaplan`
- `approval`
- `codex_session`
- `subagent_advisor`
- `subagent`
- `flowchart_maker`
- `validation`
- `preview`
- `quality_check`
- `final_summary`

For local Codex tasks, flowchart state prefers:

1. `task.codex_flowchart_json_path`
2. `task.codex_flowchart_summary`
3. fallback local task/session summaries

`withLocalSystemProcessNodes()` ensures the local system process is visible even when Codex returns a partial flowchart. It can add nodes for:

- Subagent advisor
- Flowchart maker
- Quality check

The browser filters and displays this state through `localFlowchartNodes()`.

## State Model And Important Variables

State contracts live in `codex-phone-supervisor/backend/src/types.ts`.

### TaskRecord Local Codex Fields

Important `TaskRecord` fields for the local Codex path:

- `task_id`
- `project_id`
- `user_goal`
- `normalized_goal`
- `status`
- `plan`
- `worker_id`
- `codex_run_id`
- `command_count`
- `latest_summary`
- `next_steps`
- `execution_backend`
- `local_state_path`
- `codex_subagents`
- `codex_subagent_advisor`
- `codex_quality_check`
- `codex_quality_check_path`
- `codex_flowchart_summary`
- `codex_flowchart_json_path`
- `local_validation_result`
- `files_changed`
- `final_summary`
- `codex_session_id`
- `codex_rollout_path`
- `codex_rollout_host_path`
- `codex_rollout_relative_path`
- `codex_home`
- `codex_home_host_path`
- `codex_history_kind`
- `codex_resume_command`
- `codex_prompt_excerpt`
- `codex_model`
- `codex_reasoning_effort`
- `codex_started_at`
- `codex_completed_at`
- `codex_history_confidence`
- `codex_history_verification_command`

### LocalCodexSubagentReport

`LocalCodexSubagentReport` fields:

- `name`
- `responsibility`
- `status`
- `changed_files`
- `validation`
- `summary`

Allowed `status` values:

- `waiting`
- `running`
- `completed`
- `failed`
- `skipped`
- `unknown`

### LocalCodexSubagentAdvisorUpdate

`LocalCodexSubagentAdvisorUpdate` fields:

- `recommended`
- `confidence`
- `status`
- `summary`
- `suggested_subagents`
- `user_check_in_needed`
- `updated_at`
- `source`
- `error`

Allowed advisor `status` values:

- `watching`
- `use_subagents`
- `single_lane_ok`
- `needs_user_check_in`
- `unknown`

### LocalCodexQualityCheckResult

`LocalCodexQualityCheckResult` fields:

- `status`
- `summary`
- `meets_megaplan`
- `meets_user_request`
- `functionality_checked`
- `validation_reviewed`
- `ui_review`
- `tools_used`
- `checks`
- `findings`
- `recommended_fixes`
- `updated_at`
- `source`
- `error`

`ui_review` contains:

- `status`
- `summary`
- `tools_attempted`

### LocalCodexFlowchartSummary

`LocalCodexFlowchartSummary` fields:

- `title`
- `overview`
- `nodes`
- `edges`

Each `LocalCodexFlowchartNodeReport` has:

- `id`
- `kind`
- `label`
- `status`
- `summary`
- `depends_on`

Each `LocalCodexFlowchartEdgeReport` has:

- `from`
- `to`
- `label`

### LocalCodexValidationResult

`LocalCodexValidationResult` fields include:

- `status`
- `validated_at`
- `required_files_exist`
- `docs_updated`
- `docs_only_success_rejected`
- `preview_loaded`
- `files_changed`
- `app_files`
- `commands`

Each command result includes:

- `command`
- `status`
- `exit_code`
- `summary`

### Session And Project Fields

Important project/session fields used around the local Codex path:

- `pending_action`
- `pending_action_payload`
- `planner_output`
- `approved_plan`
- `approval_status`
- `open_questions`
- `assumptions`
- `design_decision_history`
- `last_active_session_id`
- `current_project_id`
- `active_task_id`
- `recent_messages`
- `instruction_history`
- `codex_conversation_session_id`
- `codex_conversation_resume_command`
- `codex_conversation_mirrored_at`
- `codex_conversation_mirror_error`

## Tests And Validation

Focused tests:

- `codex-phone-supervisor/tests/flowchart-ui.test.ts`
- `codex-phone-supervisor/tests/codex-session-local.test.ts`
- `codex-phone-supervisor/tests/config-failure.test.ts`
- `codex-phone-supervisor/tests/app-output-validation.test.ts`
- `codex-phone-supervisor/tests/smoke-scripts.test.ts`

`flowchart-ui.test.ts` checks the UI source for:

- `data-testid="codex-session-flowchart"`
- `data-testid="codex-cli-stream"`
- `stdout/stderr piped live`
- `Codex internal logical subagents`
- Runtime settings display
- Skill and plugin status display
- Browser chat resume display
- Megaplan panel display
- Flowchart maker and subagent advisor display
- Final quality check display
- `parallelCircuit`
- `subagents.length > 1 && columnCount >= 3`
- `subagentColumns.size !== 1`
- `data-testid="parallel-agent-pipeline"`
- `flow-arrow-parallel`
- Absence of `strokeDasharray: "7 5"`
- Absence of `data-testid="parallel-agent-lanes"`
- Absence of legacy worker controls

`codex-session-local.test.ts` checks the backend for:

- Prompt names Codex as the direct CLI orchestrator.
- Runtime defaults to `codex_session_local`.
- State store defaults to file storage in the local test setup.
- Prompt includes the browser conversation transcript.
- Prompt lets Codex choose subagent count and names.
- Prompt asks for truthful flowchart reporting.
- Prompt names Megaplan, approval gate, flowchart maker, and final quality check.
- Same-account full-access settings.
- `CODEX_HOME: config.codexHome`.
- `--model config.localCodex.model`.
- `model_reasoning_effort=config.localCodex.reasoningEffort`.
- `shell_environment_policy.inherit=all`.
- `--dangerously-bypass-approvals-and-sandbox` when configured.
- `local_codex_session.stdout` and `local_codex_session.stderr`.
- Browser chat mirror into a resumable Codex session.
- Megaplan repo URL uses GitHub URL instead of local file path.
- Flowchart maker read-only helper is capped at five seconds.
- Subagent advisor read-only helper is capped at five seconds.
- Final quality check runs as a separate Codex gate.
- Continuous flowchart watcher writes live JSON.
- Validation rejects missing files and docs-only success.
- Session reset refuses to delete the configured workspace root.

`config-failure.test.ts` checks:

- Missing required environment failures.
- Local Codex CLI provider defaults.
- Unsupported reasoning-effort rejection.
- Codex auth defaults.
- Twilio URL requirements.
- Terminal shell requirements.

`app-output-validation.test.ts` checks:

- Docs-only output is rejected for app-building tasks.
- Weak validation such as only `ls` or `git status` is rejected.
- Static HTML/CSS/JS apps can pass when assets and syntax checks are valid.
- Backend-only and infrastructure-only contracts are handled separately.

`smoke-scripts.test.ts` checks:

- Smoke scripts are executable.
- Smoke scripts avoid secret-printing and hardcoded fake Codex output.
- Smoke scripts use the expected product paths.
- Local compose config does not configure the mock supervisor provider.

## Validation Expectations

`codex-phone-supervisor/backend/src/codex-session-local.ts` defines the local Codex final JSON schema. The final report is expected to include:

- `summary`
- `status`
- `final_summary`
- `files_changed`
- `required_files`
- `validation_commands`
- `docs_updated`
- `preview_entry`
- `subagents`
- `flowchart_summary`
- `errors`

Default validation commands are inferred from package scripts and source files where applicable. Common checks include:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `node --check` for JavaScript-like files

Local validation requires:

- Required files exist.
- Real app/source output exists when the task is app-building.
- Docs-only success is rejected for app-building tasks.
- Validation commands pass, or failures are reported honestly.
- `.head-developer` docs/state are updated.
- Preview is started only after preliminary validation passes.
- Final completion requires local validation success, Codex report status `completed`, and final quality check success.

Flowchart summaries are written to `.head-developer/flowchart.json` when available. The browser UI sanitizes displayed flowchart text to avoid raw paths, filenames, inline code, command details, stack traces, and internal implementation noise.

## Legacy And Experimental Boundaries

Legacy distributed orchestration concepts still exist in the repo, including:

- Worker records
- Task graphs
- Docker local workers
- GCP VM workers
- GKE Job workers
- Worker callbacks
- Distributed worker flowchart nodes

These are not the main local product path.

The current local UI should emphasize:

- One local Codex CLI session.
- Codex as orchestrator.
- Codex-chosen logical subagents.
- Local repo as source of truth.
- Local file state.
- Local validation.
- Local preview.
- Browser flowchart from real local events and summary JSON.

The frontend test explicitly checks that the browser UI does not expose legacy worker controls such as:

- Worker mode selector
- Docker legacy run button
- GCP VM legacy run button
- Operator terminal
- Cloud orchestrator wording

## Operational Notes

For normal local development:

```bash
npm run dev:backend
npm run dev:frontend
```

For fast local verification:

```bash
npm run typecheck
npm run build
npx tsx --test --test-concurrency=1 codex-phone-supervisor/tests/flowchart-ui.test.ts codex-phone-supervisor/tests/codex-session-local.test.ts
```

For full repo verification:

```bash
npm test
docker compose -f docker/docker-compose.local.yml config
```

The browser UI depends on polling to stay current. If the UI appears stale:

1. Confirm the backend is running on `127.0.0.1:4317`.
2. Confirm the frontend is running on `127.0.0.1:4318`.
3. Use `Load latest session`.
4. Use `Refresh flowchart`.
5. Check `/codex/status?session_id=...` and `/orchestrator/flowchart` if the UI does not update.

The local Codex path depends on a real Codex CLI and the same local Codex account/config. It should not fake subagent names, flowchart state, validation, preview status, or Codex history.
