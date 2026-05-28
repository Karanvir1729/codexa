# RUNBOOK

## Local Dev

```bash
npm install
npm run dev:backend
npm run dev:frontend
```

Backend defaults come from `.env` and `.env.codex-phone-supervisor`. The backend must have a real Codex CLI path in `CODEX_PHONE_SUPERVISOR_CODEX_COMMAND` for app creation.

The user-facing supervisor and planner default to Vertex/Gemini. `SUPERVISOR_MODEL_PROVIDER=mock` is not a valid runtime provider. Local runtime must have real Vertex configuration or fail clearly with:

```text
Vertex/Gemini supervisor is not configured. Set required GCP/Vertex env vars.
```

Required Vertex/Gemini env vars:

```bash
export SUPERVISOR_MODEL_PROVIDER=vertex
export VERTEX_PROJECT_ID=your-gcp-project-id
export VERTEX_LOCATION=us-central1
export VERTEX_MODEL=gemini-2.5-flash
```

The dashboard provider indicator should show:

```text
Supervisor: Vertex/Gemini
Planner: Vertex/Gemini
Worker code model: Codex CLI
```

Local state defaults to `FileStateStore`:

```bash
export HEAD_DEVELOPER_STATE_STORE=file
export CODEX_PHONE_SUPERVISOR_STORE_DIR=tmp/codex-phone-supervisor
```

Use `HEAD_DEVELOPER_STATE_STORE=memory` only for isolated tests where persistence across restart is not required.

## Docker Local

```bash
docker compose --env-file .env.codex-phone-supervisor -f docker/docker-compose.local.yml up --build --scale worker=2
```

The API runs on `127.0.0.1:4317` and the frontend on `127.0.0.1:4318`. Docker Local workers poll for assigned task graph nodes and run Codex CLI inside the worker container.

Docker Local project discovery is intentionally isolated from the repo root. API, frontend, and workers use `/generated-projects` in containers, backed by `tmp/codex-phone-supervisor-projects` on the host. This keeps the browser app from listing unrelated repo folders or old smoke fixtures as selectable projects.

Docker Local does not configure a mock supervisor. It passes through `SUPERVISOR_MODEL_PROVIDER` and defaults it to `vertex`, with `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, and `VERTEX_MODEL` passed from the host environment. If those are empty, API/worker startup fails with the Vertex/Gemini configuration error above.

Codex auth is mounted, not baked into images:

```bash
export CODEX_HOME="$HOME/.codex"
```

The worker explicitly sets `CODEX_HOME=/codex-home` and uses `/codex-home` internally. Docker Local bind-mounts that path from the repo-local host directory `.codex-worker-home/`, so worker `codex exec` history survives worker container restarts and can be inspected without `docker exec`.

Default paths:

- host path: `.codex-worker-home/` (`/Users/karanvirkhanna/tutor-tron-voice/.codex-worker-home` in this workspace)
- container path: `/codex-home`

```bash
find .codex-worker-home/sessions -type f -name '*.jsonl' | tail
grep -R "your task text or NONCE" .codex-worker-home/sessions
grep -R "NONCE-HISTORY-BRIDGE" /Users/karanvirkhanna/tutor-tron-voice/.codex-worker-home/sessions
```

Authentication material is copied into the writable worker home from the read-only `CODEX_HOME` mount at container startup. Secrets stay in mounted directories and are not baked into Docker images. Set `INSTALL_CODEX_CLI=1` when building the dev worker base if you want the image to install the configured Codex npm package.

Each worker Codex command event records the detected Codex session id when emitted by the CLI, the verified rollout JSONL path when found, the host-visible path, the container path, and a host verification `grep` command. The dashboard only shows `codex exec resume <SESSION_ID>` when the CLI emitted a real session id. If only a rollout JSONL path is known, the dashboard shows the verified rollout path, grep verification command, and `verified_by_prompt_match` confidence without inventing a resumable session id. If `CODEX_VISIBILITY_MIRROR=true`, the system may create a separate read-only visibility mirror session after a worker run; it must label itself as a mirror and is not execution proof.

## GCP Setup

```bash
export GCP_PROJECT_ID=your-project
export GCP_REGION=us-central1
export GCP_ZONE=us-central1-a
scripts/gcp/enable-apis.sh
scripts/gcp/create-artifact-registry.sh
scripts/gcp/create-service-accounts.sh
scripts/gcp/create-storage.sh
scripts/gcp/create-pubsub-or-tasks.sh
scripts/gcp/create-firestore-or-db.sh
```

Production Cloud Run state should use Firestore:

```bash
export HEAD_DEVELOPER_STATE_STORE=firestore
export FIRESTORE_PROJECT_ID="${GCP_PROJECT_ID}"
export FIRESTORE_DATABASE_ID="(default)"
export FIRESTORE_COLLECTION_PREFIX="head_developer_prod"
```

Cloud Run also defaults to Firestore automatically when `K_SERVICE` is present. Set the variables above explicitly anyway so deployments are auditable and staging/prod prefixes stay separate.

Build and push the API and worker images:

```bash
scripts/gcp/build-and-push-images.sh
```

The build script defaults to `HEAD_DEVELOPER_IMAGE_PLATFORM=linux/amd64`, which is required for Cloud Run and GKE workers when building from Apple Silicon hosts.

Configure GCP VM Codex auth before assigning real Codex work. The primary path is a dedicated ChatGPT-login Codex home bundle, not an OpenAI API key:

```bash
export HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle
export HEAD_DEVELOPER_CODEX_HOME=/codex-home
export HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET=codex-vm-home-bundle
scripts/gcp/create-codex-vm-home-bundle.sh
scripts/gcp/create-service-accounts.sh
```

The setup script creates `.codex-vm-home/`, instructs the operator to run `CODEX_HOME=.codex-vm-home codex login` if needed, verifies `codex login status`, runs a local nonce smoke, packages the dedicated home, uploads the sensitive bundle to Secret Manager or restricted GCS, grants only `worker-vm-sa` read access, and deletes the temporary unencrypted bundle file. It never prints auth file contents, tokens, cookies, or API keys.

The worker VM fetches the bundle at runtime, extracts it into `/codex-home`, validates with `CODEX_HOME=/codex-home codex login status`, and records only auth method/status/resource metadata. `secret_manager_api_key` remains a fallback-only method and is not used by the live VM Codex smoke unless explicitly approved.

OpenClaw is not required for this auth path. It could orchestrate Codex CLI through an extra gateway/skills runtime, but it does not remove the need for Codex CLI authentication and is not the primary solution.

Deploy Cloud Run only with an authenticated service:

```bash
export HEAD_DEVELOPER_API_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/REPO/api:TAG
export HEAD_DEVELOPER_WORKER_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/REPO/worker:TAG
scripts/gcp/deploy-cloud-run.sh
```

Launch a worker VM smoke test:

```bash
export HEAD_DEVELOPER_WORKER_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/head-developer/worker:TAG
export HEAD_DEVELOPER_API_CALLBACK_URL=https://your-authenticated-control-plane
scripts/gcp/create-worker-vm-smoke.sh
```

Run a real Codex nonce smoke after Cloud Run and the worker image are configured:

```bash
export WORKER_CALLBACK_URL=https://your-authenticated-control-plane
export HEAD_DEVELOPER_WORKER_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/head-developer/worker:TAG
export HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle
export HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET=codex-vm-home-bundle
scripts/gcp/run-codex-home-bundle-smoke.sh
```

## GKE Job worker prototype

`gke_job` is a prototype alternative to raw `gcp_vm` workers. It does not replace `gcp_vm`. Each worker assignment is launched as one Kubernetes Job on GKE Autopilot, using the same worker image and the same `codex_home_bundle` auth path.

Required config:

```bash
export GCP_PROJECT_ID=teamtiffy1729
export GCP_REGION=us-central1
export HEAD_DEVELOPER_WORKER_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/head-developer/worker:TAG
export HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle
export HEAD_DEVELOPER_CODEX_HOME=/codex-home
export HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI=gs://BUCKET/codex-auth/codex-vm-home-bundle.tgz
export HEAD_DEVELOPER_GKE_CLUSTER_NAME=head-developer-workers
export HEAD_DEVELOPER_GKE_LOCATION=us-central1
export HEAD_DEVELOPER_GKE_NAMESPACE=head-developer-workers
export HEAD_DEVELOPER_GKE_KSA=head-developer-worker
export HEAD_DEVELOPER_GKE_GSA=gke-worker-sa@teamtiffy1729.iam.gserviceaccount.com
```

The smoke script creates or selects the Autopilot cluster, creates namespace/service account, maps the Kubernetes service account to the Google service account with Workload Identity Federation, grants restricted bundle read, Cloud Run invoker, logging, and Artifact Registry reader permissions, then creates a single `gke_job` task:

```bash
export WORKER_CALLBACK_URL=https://your-authenticated-control-plane
scripts/gcp/run-gke-job-codex-home-smoke.sh
```

Expected proof: cluster, namespace, Job, Pod, worker image, Workload Identity mapping, GCS bundle URI, Codex login evidence, Codex command event ID, generated files, nonce evidence, validation result, and cleanup showing no leftover Job/Pod for the worker ID. Do not make Cloud Run public and do not make the bundle public. If private nodes are used, Cloud NAT or equivalent external egress is required for Codex CLI network calls; Private Google Access alone is not enough for non-Google endpoints.

List and clean temporary workers:

```bash
scripts/gcp/list-workers.sh
ACTION=stop scripts/gcp/cleanup-workers.sh
ACTION=delete scripts/gcp/cleanup-workers.sh
```

## Verification

```bash
npm run typecheck
npm test
npm run build
docker compose -f docker/docker-compose.local.yml config
```

## Vertex Planner Smoke

Run this without `CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL` and without launching workers. Use a selected project/session and send:

```text
Build a static SaaS dashboard with landing, login, dashboard, and settings.
```

Expected:
- `provider=vertex`.
- `planner_model` starts with `vertex:`.
- Decision type is a planning/proposal decision such as `propose_task_split`.
- `requires_user_approval=true`.
- `execution_allowed=false`.
- No task graph is created before approval.
- The user-facing response asks for approval and does not contain raw JSON.

## Smoke Harness

The repeatable smoke scripts live under `scripts/smoke/` and have npm aliases:

```bash
npm run smoke:docker-single-worker-app
npm run smoke:docker-two-worker-static-dashboard
npm run smoke:preview
npm run smoke:codex-history
npm run smoke:gcp-vm-safe-command
```

Docker Local smokes default to `http://127.0.0.1:4317` and will start Docker Compose unless `SMOKE_SKIP_COMPOSE=1` or `SMOKE_COMPOSE_UP=0` is set. They print exact session, project, task, worker, command, graph, and preview IDs. They do not print environment secrets.

`docker-single-worker-app-smoke` creates a disposable project under `tmp/smoke/`, asks one Docker Local worker to build a static landing page with `index.html`, `styles.css`, and `script.js`, verifies those files, runs `node --check script.js`, starts a preview when possible, and records `tmp/smoke/latest-app-smoke.latest.json`.

`docker-two-worker-static-dashboard-smoke` creates a disposable static SaaS dashboard shell graph with the prompt: “Build a static SaaS dashboard shell with landing page, login page, dashboard page, and settings page. Static HTML/CSS/JS only. No billing. No backend. No package installs.” It verifies two worker assignments, two isolated worktrees, no duplicate active Codex command per task during polling, materialization commands, output contracts, app validation commands, and final graph/flowchart status.

`preview-smoke` previews the latest completed app from `tmp/smoke/latest-app-smoke.latest.json` or `SMOKE_SESSION_ID`, checks the page is nonblank, checks recorded console errors, and saves a screenshot when the optional `playwright` package is available.

`codex-history-smoke` checks `.codex-worker-home/sessions` rollout JSONL evidence, verifies matching command event metadata, and prints a safe `codex exec resume ...` command only when Codex emitted a real session id.

`gcp-vm-safe-command-smoke` launches one disposable GCP VM and runs the worker image with safe commands only: `pwd` and `node --version`. It verifies callback command events through the API/flowchart and deletes the VM before exiting. Required environment:

```bash
export GCP_PROJECT_ID=your-project
export GCP_REGION=us-central1
export GCP_ZONE=us-central1-a
export HEAD_DEVELOPER_WORKER_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/head-developer/worker:TAG
export HEAD_DEVELOPER_API_CALLBACK_URL=https://your-control-plane
```

For authenticated callback inspection from the coordinator, set `SMOKE_API_BEARER_TOKEN` or `SMOKE_API_ID_TOKEN_AUDIENCE`.

Firestore adapter unit coverage uses a mocked transport. A real GCP smoke requires:

```bash
HEAD_DEVELOPER_STATE_STORE=firestore \
FIRESTORE_PROJECT_ID="${GCP_PROJECT_ID}" \
FIRESTORE_COLLECTION_PREFIX="head_developer_smoke" \
npm run dev:backend
```

Then restart the backend and confirm `/sessions`, `/projects`, `/tasks`, and `/orchestrator/flowchart` still show records created before restart.

## Common Failures

`SESSION_NOT_FOUND`: the frontend should clear local session state and show “Session expired. Start a new session.”

Codex app creation fails: verify `CODEX_PHONE_SUPERVISOR_CODEX_COMMAND`, `CODEX_HOME`, and that Codex can run in the selected workspace.

Worker VM has no heartbeat: check Cloud Logging for the VM startup script and confirm the VM service account can pull Artifact Registry images.

Firestore state errors: confirm the Cloud Run service account has Firestore read/write access for the target project and that `FIRESTORE_COLLECTION_PREFIX` is correct for the environment.
