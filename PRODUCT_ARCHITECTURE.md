# Product Architecture

The product is a cloud AI Head Developer. All channels normalize into the same control plane:

- Web text
- Web voice
- Twilio SMS
- Twilio phone calls
- Operator sessions

## Control Plane

Cloud Run hosts the API and Cloud Orchestrator. The orchestrator owns session state, project selection, task records, worker assignment, command/event logs, approvals, and grounded summaries.

Key records are typed in `codex-phone-supervisor/backend/src/types.ts`: `SessionState`, `ProjectRecord`, `TaskRecord`, `WorkerRecord`, `CommandEventRecord`, `RunSummaryRecord`, and `ApprovalRequestRecord`.

State access goes through the `StateStore` boundary. Local development defaults to `FileStateStore`; isolated tests can use `MemoryStateStore`; Cloud Run defaults to `FirestoreStateStore` so state survives service restarts. Schema details are documented in `docs/STATE_SCHEMA.md`.

Firestore production state must avoid whole-state scans on request hot paths. Sessions, projects, tasks, workers, task graphs, command events, approvals, summaries, worker context packets, runtime command requests, and orchestration events are written as typed documents with top-level query fields. Hot paths use direct document reads or single-field Firestore queries with bounded limits; broad list endpoints are paginated/bounded and are not used for worker callbacks or task graph advancement.

## AI Model Boundaries

The user-facing supervisor and agentic planner use real GCP Vertex/Gemini by default. Runtime config defaults `SUPERVISOR_MODEL_PROVIDER` to `vertex`; `mock` is not a runtime provider and is rejected by config validation.

Required runtime Vertex env vars are `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, and `VERTEX_MODEL`. Missing Vertex config fails clearly before orchestration can silently degrade.

The dashboard exposes non-secret model indicators:

- `supervisor_model_provider`: `Vertex/Gemini`
- `planner_model_provider`: `Vertex/Gemini`
- `worker_code_model`: `Codex CLI`

Codex CLI is used only by workers for implementation/code generation. It is not the user-facing supervisor planner.

## Execution Plane

Workers are isolated behind `WorkerManager` implementations:

- `LocalWorkerManager`
- `DockerLocalWorkerManager`
- `GcpVmWorkerManager`
- `GkeJobWorkerManager`

The GCP VM worker path creates disposable Compute Engine VMs with no public IP by default. Each VM pulls an exact Artifact Registry worker image and runs the worker container with `task_id`, `worker_id`, API callback URL, workspace config, and runtime-only Codex auth metadata. Real `codex exec` on GCP uses `HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle`: the VM fetches a dedicated ChatGPT-login Codex home bundle from Secret Manager or restricted GCS, extracts it into `/codex-home`, validates `codex login status`, and runs Codex CLI without dumping credential files. The OpenAI API-key method remains fallback-only and is disabled by default for live VM smokes.

The GKE Job worker path is a prototype alternative. It creates one Kubernetes Job per worker assignment in the `head-developer-workers` namespace, uses the `head-developer-worker` Kubernetes service account mapped through Workload Identity Federation to `gke-worker-sa@PROJECT.iam.gserviceaccount.com`, mounts emptyDir volumes for `/workspace`, `/state`, and `/codex-home`, fetches the restricted Codex home bundle at runtime, and posts authenticated callbacks to Cloud Run. It preserves `gcp_vm`; it is not a production migration yet.

Current GKE workers intentionally use Pod-local `/workspace` and therefore do not yet create durable repo branches. API-side git repo preparation is skipped for `gke_job` execution because those local Cloud Run repo files are not the worker's execution workspace. Worker output is accepted only through command events, file materialization evidence, validation commands, completion gates, and summaries until the durable repo/PR lifecycle below is implemented.

## Durable Repo And PR Lifecycle Design

The production parallel-development path should make worker outputs durable before claiming end-to-end multi-worker development:

1. Project repo creation: create or select a project repository before task graph execution and record repo URL, default branch, provider, and visibility on the project.
2. File ownership planning: translate each task graph node output contract into explicit file ownership claims. Detect overlapping claims before parallel launch and either revise the split, request approval, or serialize conflicting work.
3. Worker isolation: Docker/local workers can use git worktrees directly. GKE/VM workers should write to Pod/VM-local workspaces, then upload a signed artifact bundle containing generated files, metadata, validation output, command event IDs, and a patch/manifest to restricted GCS.
4. Branch materialization: the orchestrator downloads each artifact into an integration workspace, applies the patch on a per-task branch, commits with worker/task metadata, and runs node-level validation.
5. Conflict detection: before merge, compare changed files, expected files, and git merge results. Conflicts become explicit review/repair tasks; no worker silently overwrites another worker.
6. Pull request creation: after branch validation, push worker branches and create PRs with non-secret summaries, changed files, validation commands, command IDs, and reviewer checklist.
7. Integration merge: a merge coordinator orders PRs by task-graph dependencies, performs dry-run merges, reruns integration validation, and asks for approval before pushing/merging to the protected default branch.
8. Audit trail: record branch names, commit SHAs, PR URLs, merge status, conflicts, approvals, and final validation in project/task graph state and flowchart nodes.

Direct pushes to `main`/`master`, public deploys, secret changes, IAM changes, and destructive conflict resolution remain approval-gated.

## Worker Lifecycle

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

Next steps are implementing the durable repo/branch/PR lifecycle, raising or working around the `SSD_TOTAL_GB` GKE scale-up quota in `us-central1`, fixing GKE worker process exit semantics so Kubernetes Job status matches orchestrator success, proving the Codex home bundle smoke end-to-end on disposable VMs, storing large command logs in Cloud Storage, adding Firestore index/migration automation as query volume grows, and adding service-account/OIDC token exchange if Codex exposes a supported workload identity auth contract.
