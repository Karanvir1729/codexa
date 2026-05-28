# Architecture Review

The current supervisor already has the critical local execution primitive: backend requests eventually call `codex exec --json` through `backend/src/codex.ts`, and the reducer records Codex reports into session state. The web, voice, SMS, and phone paths converge through `/call/message` and `handleUserMessage`, which is the right shape for a cloud control plane.

The weakest part was deterministic orchestration state. Project creation intent was partially inferred from recent assistant text, so a multi-turn flow could let the model select `create_project` without `project_name` and `description`. Session-not-found errors were also represented as plain strings, which made the frontend keep polling stale summaries.

The production spine now needs to preserve the working Codex runner while adding explicit session, project, task, worker, command, approval, and summary records. The control plane should choose projects and workers deterministically, and the execution plane should run commands only through Dockerized or VM workers that emit command events. Summaries must be derived from command/event records rather than model claims.

GCP should be introduced as an execution backend, not a rewrite of the app. Cloud Run can host the API/control plane, Artifact Registry can host versioned worker images, and disposable Compute Engine VMs can pull the worker image and stream heartbeats/results back to the API.
