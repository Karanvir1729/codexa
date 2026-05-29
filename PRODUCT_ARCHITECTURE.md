# Product Architecture

The product is a local-first AI Head Developer. All channels normalize into the same control plane:

- Web text
- Web voice
- Twilio SMS
- Twilio phone calls
- Operator sessions

## Control Plane

For v1, the API and dashboard run locally. The orchestrator owns session state, project selection, task records, Codex session events, approvals, local validation, preview metadata, and grounded summaries.

Key records are typed in `codex-phone-supervisor/backend/src/types.ts`: `SessionState`, `ProjectRecord`, `TaskRecord`, `WorkerRecord`, `CommandEventRecord`, `RunSummaryRecord`, and `ApprovalRequestRecord`.

State access goes through the `StateStore` boundary. The v1 local path defaults to `FileStateStore` and writes project-local `.head-developer/state.json` metadata. Isolated tests can use `MemoryStateStore`. Firestore remains available for legacy/cloud experiments but is not required for local app building. Schema details are documented in `docs/STATE_SCHEMA.md`.

The v1 source of truth is the selected local repo. There are no separate worker writes, no merge between worker worktrees, no GKE/VM cleanup loop, no worker callback hot path, and no Firestore dependency for local builds.

## AI Model Boundaries

The user-facing supervisor and agentic planner default to the local Codex CLI path. Runtime config defaults `SUPERVISOR_MODEL_PROVIDER` to `codex_cli`; `mock` is not a runtime provider and is rejected by config validation.

Planner output remains model-driven, but the controller applies generic safety/performance normalization after parsing: cloud and multi-worker execution still require approval, and serial or overlapping splits for one static app surface are collapsed to one worker so simple builds do not spend minutes running unnecessary sequential workers. This guard is based on task structure and file ownership, not prompt names or sample app strings.

The dashboard exposes non-secret model indicators:

- `supervisor_model_provider`: `Codex CLI`
- `planner_model_provider`: `Codex CLI`
- `worker_code_model`: `Codex CLI`

Codex CLI is used by the single local orchestrator and implementation session. It is not a distributed worker fleet.

## Execution Plane

The preferred backend is `codex_session_local`.

Responsibilities:

1. Create or select the local project repo.
2. Initialize `.head-developer` docs.
3. Ask, propose, and approve requirements through conversation.
4. Start one local Codex CLI orchestrator session with `codex exec --json`.
5. Instruct Codex to choose how many internal logical subagents are useful.
6. Keep all code in one repo/workspace.
7. Capture Codex session/history metadata.
8. Validate the final repo locally.
9. Open a local preview when applicable.
10. Render the flowchart from real events.

The structured Codex prompt identifies Codex as the local orchestrator and implementation lead, then requires it to keep all work in one repo. It explicitly forbids disconnected workspaces, per-worker worktrees, external workers, Docker workers, GKE jobs, VM workers, Cloud Run orchestration, Firestore task state, Secret Manager Codex auth, GCS Codex bundles, and worker callbacks for the v1 path.

Codex may report logical subagents such as frontend, backend, shared logic, tests, docs, integration, or validation, but it chooses the count and split. These are flowchart concepts derived from Codex output/events, not separate operating-system workers.

## Flowchart

The dashboard flowchart visualizes the local product path:

- user request
- requirement summary and clarification questions
- approved plan
- one Codex session node
- logical subagent nodes reported by Codex
- files changed
- validation commands
- preview node
- final summary node

The dashboard clearly labels this path: "Built by one local Codex orchestrator session."

## Legacy Worker Experiments

The older worker backends remain in the repo for experiments and regression coverage:

- `LocalWorkerManager`
- `DockerLocalWorkerManager`
- `GcpVmWorkerManager`
- `GkeJobWorkerManager`

These modes are not the main v1 product path. Docker, GCP VMs, GKE Jobs, Cloud Run worker callbacks, Firestore worker state, per-worker worktrees, and cloud Codex auth bundles must not be required for local app building.

The GCP VM worker path creates disposable Compute Engine VMs with no public IP by default. Each VM pulls an exact Artifact Registry worker image and runs the worker container with `task_id`, `worker_id`, API callback URL, workspace config, and runtime-only Codex auth metadata. Real `codex exec` on GCP uses `HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle`: the VM fetches a dedicated ChatGPT-login Codex home bundle from Secret Manager or restricted GCS, extracts it into `/codex-home`, validates `codex login status`, and runs Codex CLI without dumping credential files. The OpenAI API-key method remains fallback-only and is disabled by default for live VM smokes.

The GKE Job worker path is a prototype alternative. It creates one Kubernetes Job per worker assignment in the `head-developer-workers` namespace, uses the `head-developer-worker` Kubernetes service account mapped through Workload Identity Federation to `gke-worker-sa@PROJECT.iam.gserviceaccount.com`, mounts emptyDir volumes for `/workspace`, `/state`, and `/codex-home`, fetches the restricted Codex home bundle at runtime, and posts authenticated callbacks to Cloud Run. It preserves `gcp_vm`; it is not a production migration yet.

Current GKE workers intentionally use Pod-local `/workspace` and therefore do not yet create durable repo branches. API-side git repo preparation is skipped for `gke_job` execution because those local Cloud Run repo files are not the worker's execution workspace. A minimal API artifact handoff now restores persisted project app files into each GKE Pod before execution and persists generated app files back into the state store after validation. Preview routes use preview/artifact metadata caches and replace stale requested files before serving assets so Cloud Run instance-local stale files do not win without forcing a full artifact rewrite on every CSS/JS request. This makes previewable app files available across sequential GKE Jobs, but it is still not a replacement for durable branches, remote repository pushes, or PRs.

## Durable Repo And PR Lifecycle Design

If the legacy parallel-development path is revived, it must make worker outputs durable before claiming end-to-end multi-worker development:

1. Project repo creation: create or select a project repository before task graph execution and record repo URL, default branch, provider, and visibility on the project.
2. File ownership planning: translate each task graph node output contract into explicit file ownership claims. Detect overlapping claims before parallel launch and either revise the split, request approval, or serialize conflicting work.
3. Worker isolation: Docker/local workers can use git worktrees directly. GKE/VM workers should write to Pod/VM-local workspaces, then upload a signed artifact bundle containing generated files, metadata, validation output, command event IDs, and a patch/manifest to restricted GCS. The current GKE API artifact handoff is an interim small-file mechanism for previewability, not the final durable artifact store.
4. Branch materialization: the orchestrator downloads each artifact into an integration workspace, applies the patch on a per-task branch, commits with worker/task metadata, and runs node-level validation.
5. Conflict detection: before merge, compare changed files, expected files, and git merge results. Conflicts become explicit review/repair tasks; no worker silently overwrites another worker.
6. Pull request creation: after branch validation, push worker branches and create PRs with non-secret summaries, changed files, validation commands, command IDs, and reviewer checklist.
7. Integration merge: a merge coordinator orders PRs by task-graph dependencies, performs dry-run merges, reruns integration validation, and asks for approval before pushing/merging to the protected default branch.
8. Audit trail: record branch names, commit SHAs, PR URLs, merge status, conflicts, approvals, and final validation in project/task graph state and flowchart nodes.

Direct pushes to `main`/`master`, public deploys, secret changes, IAM changes, and destructive conflict resolution remain approval-gated.

## Worker Lifecycle

This lifecycle applies only to legacy worker modes, not `codex_session_local`.

1. Task is created from a user goal.
2. Orchestrator selects a worker type.
3. Worker record is created with expiry.
4. Worker sends heartbeat.
5. Commands run through `CommandRunner`.
6. Command events are appended.
7. Worker returns result.
8. Summary is generated from command/event records.
9. Worker stops, expires, or is cleaned up.

## Safety Policy

All commands go through command classification. Low-risk workspace commands run directly. Destructive, broad IAM, public deploy, GPU, GKE, direct main push, and secret mutation commands require approval. Credential dumping is blocked.

## GCP Resources

These resources are legacy/experimental and are not required for the v1 local Codex session path.

- Cloud Run: API/control plane
- Artifact Registry: worker images
- Compute Engine: disposable workers
- GKE Autopilot: prototype disposable Kubernetes Job workers
- Cloud Storage: logs/artifacts
- Pub/Sub or Cloud Tasks: task dispatch
- Firestore: production state store for sessions, projects, tasks, workers, command events, summaries, approvals, MCP events, and progress/event log records
- Secret Manager: explicitly allowed secrets
- Cloud Logging/Error Reporting: observability

## Roadmap

Next steps are hardening the local Codex CLI orchestrator path, improving the flowchart event extraction, broadening local validation, and proving voice-driven plan/approval UX. Cloud worker durability, Firestore indexes, and GKE/VM auth remain experimental backlog items.
