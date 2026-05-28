# Cloud Orchestrator State Schema

The production state store is collection-oriented and migration-safe. Every record stores the typed payload used by the API plus stable IDs and timestamps. Firestore collections use `FIRESTORE_COLLECTION_PREFIX`, defaulting to `head_developer_<env>`.

## Collections

| Logical model | Firestore collection | Document ID |
| --- | --- | --- |
| sessions | `<prefix>_sessions` | `session_id` |
| projects | `<prefix>_projects` | `project_id` |
| tasks | `<prefix>_tasks` | `task_id` |
| workers | `<prefix>_workers` | `worker_id` |
| command_events | `<prefix>_command_events` | `event_id` |
| summaries | `<prefix>_summaries` | `task_id` |
| approvals | `<prefix>_approvals` | `approval_id` |
| mcp_events | `<prefix>_mcp_events` | `mcp_call_id` |
| progress_events / event log | `<prefix>_events` | `event_id` |
| settings | `<prefix>_settings` | `orchestrator` |

Each Firestore document currently stores:

- `payload`: JSON string containing the typed record.
- `updated_at`: Firestore timestamp for the adapter write.

The JSON payload keeps schema evolution simple: add optional fields first, deploy readers that tolerate missing fields, then deploy writers. For high-volume query optimization, add indexed top-level fields in a later migration without changing the payload contract.

Worker payloads keep launch metadata and runtime metadata separately. `image_uri` and `recorded_image_uri` are the image recorded when the worker was created. Runtime reports may add `actual_image_uri`, `actual_image_digest`, `actual_vm_name`, `actual_worker_mode`, `startup_attempt_id`, `run_attempt_id`, `container_started_at`, `worker_runtime_version`, and `last_runtime_report_at` so reused VMs or rerun containers can report what actually started without erasing the original request.

## Append-Only Events

`<prefix>_events` is append-only by `event_id`. It stores session, project, task, worker, command, approval, MCP, summary, and progress events. Existing event documents should not be mutated except for explicit repair migrations.

`<prefix>_command_events` is keyed by `event_id` and may be updated while a command transitions from running to completed. The event log still receives separate `command.started`, `command.completed`, or `command.failed` entries.

## Local Development

Local development uses `FileStateStore` by default and writes the same logical schema into `sessions.json`. Tests can use `FileStateStore` with a temp directory or `MemoryStateStore`.

## Cloud Run

Cloud Run defaults to `FirestoreStateStore` when `K_SERVICE` is present. Set these env vars explicitly in production:

- `HEAD_DEVELOPER_STATE_STORE=firestore`
- `FIRESTORE_PROJECT_ID=<gcp-project>`
- `FIRESTORE_DATABASE_ID=(default)`
- `FIRESTORE_COLLECTION_PREFIX=head_developer_prod`
