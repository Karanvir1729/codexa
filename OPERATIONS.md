# Operations

## Monitoring

Use Cloud Logging for Cloud Run API logs, VM startup logs, worker container logs, command events, and errors. Every worker VM is labeled with `app=head-developer`, `env`, `project_id`, `task_id`, and `worker_id`.

## Runtime State

Local dev uses file-backed state. Production should move sessions, projects, tasks, workers, command events, approvals, and summaries to Firestore or Cloud SQL.

## Failure Recovery

- Stale sessions return `SESSION_NOT_FOUND`; the UI clears local state.
- Failed commands are stored as command events with exit code, previews, and log refs.
- Failed workers should be marked `failed` or `expired` and cleaned by label.
- Summaries are regenerated from command/event logs when available.

## Cleanup

```bash
scripts/gcp/list-workers.sh
ACTION=stop scripts/gcp/cleanup-workers.sh
ACTION=delete scripts/gcp/cleanup-workers.sh
```

Cleanup scripts target only labeled Head Developer worker VMs for the selected environment.

## Cost Drivers

Main costs are Compute Engine worker VM runtime, Cloud Run API traffic, Artifact Registry storage/egress, Cloud Storage artifacts, and model calls. Default workers use `e2-standard-2`; `e2-standard-4` can be configured. GPUs and GKE are not default paths.

## Debugging

1. Check `/health` and `/ready`.
2. Inspect `/tasks/{task_id}`, `/tasks/{task_id}/commands`, and `/workers/{worker_id}`.
3. Check Cloud Logging for VM startup script failures.
4. Verify the worker image URI exists in Artifact Registry.
5. Confirm service account IAM and bucket-level bindings.
