# Security

## Secrets

Secrets must not be baked into Docker images or printed in logs. Local Docker mounts Codex auth read-only from `CODEX_HOME`. GCP runtime secrets should live in Secret Manager and be granted only to the service account that needs them.

Credential-dumping commands such as printing env vars, reading `.env*`, or reading known credential/auth files are blocked by `command-policy.ts`. Command stdout/stderr previews, large command log artifacts, audit events, and orchestrator event payloads are redacted before persistence.

## IAM

Runtime service accounts are split:

- `control-plane-sa`: runs Cloud Run and manages task/worker control-plane actions.
- `worker-vm-sa`: pulls worker images, writes logs/artifacts, and reports status.
- `build-sa`: pushes images.

Scripts do not grant Owner or Editor. Worker storage access is bucket-scoped by `create-storage.sh`.

## Command Approval

Allowed without approval: normal repo inspection, build/test/typecheck/lint commands, controlled Docker builds/runs, Codex execution inside the workspace, and normal dev GCP creation commands for this product.

Requires approval: destructive deletes, broad IAM, unauthenticated public production exposure, secret rotation/deletion, GPU resources, Kubernetes/GKE, very large machines, broad Docker host filesystem mounts, and direct pushes to main.

Blocked: secret dumping, `.env*` and credential/auth file reads, privileged Docker containers, Docker socket mounts, host root Docker mounts, and uploading credentials outside the system.

## Worker Isolation

GCP workers are disposable VMs that run a versioned worker container. VMs have no public IP by default and are labeled for cleanup. The VM is a host, not a hand-configured snowflake.

## Public Endpoints

Cloud Run deployment defaults to `--no-allow-unauthenticated`. Making a public unauthenticated service requires explicit approval.
