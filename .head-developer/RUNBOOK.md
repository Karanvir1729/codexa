# Cloud Orchestrator Multi-Worker Runbook

## Local verification

Run:

```bash
npm run typecheck
npm test
npm run build
docker compose -f docker/docker-compose.local.yml config
```

Expected:
- Typecheck passes.
- `npm test` runs serially and reports 141 passed, 1 skipped at this checkpoint.
- Vite build emits `codex-phone-supervisor/frontend/dist`.
- Docker Compose config renders API, frontend, and Docker Local worker.

## Vertex/Gemini runtime configuration

Runtime supervisor/planner config defaults to Vertex/Gemini. Do not set `SUPERVISOR_MODEL_PROVIDER=mock`; config rejects it.

Required env vars:

```bash
export SUPERVISOR_MODEL_PROVIDER=vertex
export VERTEX_PROJECT_ID=your-gcp-project-id
export VERTEX_LOCATION=us-central1
export VERTEX_MODEL=gemini-2.5-flash
```

If the config is missing, startup or model routing must fail with:

```text
Vertex/Gemini supervisor is not configured. Set required GCP/Vertex env vars.
```

Provider indicator evidence should show:

```text
Supervisor: Vertex/Gemini
Planner: Vertex/Gemini
Worker code model: Codex CLI
```

## Agentic planning checks

Focused planner regression command:

```bash
npx tsx --test codex-phone-supervisor/tests/agentic-planning.test.ts
```

Expected:
- Vague requests ask a focused clarification and do not create workers.
- Simple static landing-page requests start the one-worker path.
- Static SaaS dashboard requests propose the two-worker split and wait for approval.
- `approve` creates a task graph matching the proposal and starts workers.
- Plan revisions such as `use one worker` update the pending decision before approval.
- GCP worker and risky deploy/security requests require approval.
- User-facing responses do not expose raw planner JSON.

## Real Vertex planner smoke

Run with real Vertex env and no `CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL`. Do not approve the plan and do not run workers.

Prompt:

```text
Build a static SaaS dashboard with landing, login, dashboard, and settings.
```

Expected:
- Real Vertex/Gemini returns a structured planner decision.
- `planner_model` starts with `vertex:`.
- A task split is proposed.
- `requires_user_approval=true`.
- `execution_allowed=false`.
- No task graph is created before approval.
- User-facing response asks for approval and contains no raw JSON.

## Focused validation commands

Use this when working on the output-contract/completion-gate layer:

```bash
npx tsx --test \
  codex-phone-supervisor/tests/completion-gate.test.ts \
  codex-phone-supervisor/tests/app-output-validation.test.ts \
  codex-phone-supervisor/tests/multi-worker.test.ts \
  codex-phone-supervisor/tests/summary-truthfulness.test.ts
```

## Smoke harness scripts

Run the repeatable smoke harnesses instead of pasting long Node snippets:

```bash
npm run smoke:docker-single-worker-app
npm run smoke:docker-two-worker-static-dashboard
npm run smoke:preview
npm run smoke:codex-history
npm run smoke:gcp-vm-safe-command
```

The scripts live in `scripts/smoke/`. Docker Local smokes start Compose by default and can use `SMOKE_SKIP_COMPOSE=1` when the stack is already running. Each smoke prints exact session, project, task, worker, command, graph, or preview IDs and avoids printing secrets.

For interactive Docker Local browser testing, start the app with:

```bash
docker compose --env-file .env.codex-phone-supervisor -f docker/docker-compose.local.yml up --build --scale worker=2
```

The local product UI should show generated projects from `/generated-projects` only. That container path maps to host `tmp/codex-phone-supervisor-projects`, so old repo folders and smoke fixtures should not clutter the project list.

The GCP safe-command smoke requires `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ZONE`, `HEAD_DEVELOPER_WORKER_IMAGE_URI`, and `HEAD_DEVELOPER_API_CALLBACK_URL`. It runs only `pwd` and `node --version`, verifies callbacks, and deletes the disposable VM.

Build and push Cloud Run API plus worker images before deployment:

```bash
scripts/gcp/build-and-push-images.sh
```

The script prints the non-secret `HEAD_DEVELOPER_API_IMAGE_URI` and `HEAD_DEVELOPER_WORKER_IMAGE_URI` exports to use with `scripts/gcp/deploy-cloud-run.sh`.
It defaults to `HEAD_DEVELOPER_IMAGE_PLATFORM=linux/amd64` so images built from Apple Silicon hosts are accepted by Cloud Run and GKE.

## GCP VM Codex home bundle auth

Primary GCP VM Codex auth uses a dedicated ChatGPT-login Codex home bundle. Do not use OpenClaw as the primary auth solution, and do not use the OpenAI API-key path for live VM Codex smokes unless explicitly approved.

Setup:

```bash
export HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle
export HEAD_DEVELOPER_CODEX_HOME=/codex-home
export HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET=codex-vm-home-bundle
scripts/gcp/create-codex-vm-home-bundle.sh
```

The script creates `.codex-vm-home/`, verifies `CODEX_HOME=.codex-vm-home codex login status`, runs a local nonce `codex exec` smoke, packages the home without sessions/logs, uploads it to Secret Manager or restricted GCS, grants only `worker-vm-sa` access, and deletes the temporary unencrypted bundle file.

GCP smoke:

```bash
export WORKER_CALLBACK_URL=https://your-authenticated-control-plane
export HEAD_DEVELOPER_WORKER_IMAGE_URI=REGION-docker.pkg.dev/PROJECT/head-developer/worker:TAG
scripts/gcp/run-codex-home-bundle-smoke.sh
```

Expected: the VM fetches the bundle, `codex login status` passes inside `/codex-home`, `codex exec` creates the glassblowing studio nonce app, command and Codex history metadata are recorded, flowchart evidence includes a `gcp_vm` Codex command, and VM cleanup leaves no matching worker VM.

## GKE Job worker prototype

`gke_job` is an approved prototype backend and does not replace `gcp_vm`. It uses GKE Autopilot Jobs, Workload Identity Federation, the existing worker image, and the same `codex_home_bundle` auth path.

Config:

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

Smoke:

```bash
export WORKER_CALLBACK_URL=https://your-authenticated-control-plane
scripts/gcp/run-gke-job-codex-home-smoke.sh
```

Expected: the script creates or selects the Autopilot cluster, configures namespace/KSA/WIF/IAM, launches one Kubernetes Job, verifies `codex_home_bundle` auth and Codex execution inside the Pod, records command/validation events through authenticated Cloud Run callbacks, and deletes the Job. Private nodes still need Cloud NAT or equivalent external egress for Codex CLI network calls.

## Two-worker smoke still required

Prompt:

```text
Build a static SaaS dashboard shell with landing page, login page, dashboard page, and settings page. Static HTML/CSS/JS only. No billing. No backend. No package installs.
```

Expected:
- Task graph uses setup docs, landing/login, dashboard/settings, and validation/review nodes.
- At least two Docker Local workers run distinct app subtasks when safe.
- Each worker has a distinct worktree.
- No task has duplicate active Codex commands.
- Landing/login node produces real app files.
- Dashboard/settings node produces real app files.
- Validation commands run and are logged.
- Completion gates pass only for real app output.
- Flowchart shows task graph, two workers, worktrees, commands, docs, and summary.

## Documentation freshness

Repo docs live under `.head-developer/`. Generated project docs are written by `DocumentationIndexer` under each project repo's `.head-developer/` directory.

Docs-only changes do not satisfy app-building task completion. If docs are stale, create a documentation follow-up task, but keep app task state honest.

## Conversation-only planner smoke

Use a selected project/session in Docker Local test mode and send:

```text
Build a static SaaS dashboard with landing, login, dashboard, and settings.
approve
```

Expected:
- First response summarizes requirements, proposes a two-worker split, lists expected files/validation, and asks approval.
- No task graph exists before approval.
- Approval creates a graph with landing/login and dashboard/settings nodes.
- Graph nodes include output contracts and docs-only rejection.
- Worker records and worker context packets include the approved requirements and plan metadata.
- Flowchart includes requirement summary, planner decision, task split proposal, user approval, approved plan, execution start, task graph, and worker nodes.
