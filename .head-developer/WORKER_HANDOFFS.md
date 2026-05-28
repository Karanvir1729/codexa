# Worker Handoffs

## Coordinator TODO Board - 2026-05-26 EDT

Current phase status:

| Item | Status | Notes |
| --- | --- | --- |
| Multi-worker output contracts | Done | Contracts are on graph nodes and worker context packets. |
| Docs-only app output rejection | Done | App nodes fail when only `.head-developer` docs are produced. |
| Weak validation rejection | Done | `ls`/`git status` style evidence is not sufficient for app output. |
| Truthful summaries | Done | Worker-result summaries reload gated task state before reporting. |
| Deterministic Codex materialization | Done | Codex returns `files_to_write`; worker materializes through logged command events. |
| Agentic planning controller | Done | Model-driven planner decisions, approval/revision flow, planner state, worker context, and flowchart nodes are implemented and tested. |
| Runtime Vertex/Gemini supervisor | Done | Runtime defaults to Vertex/Gemini; `SUPERVISOR_MODEL_PROVIDER=mock` is rejected; Docker Local no longer sets mock; provider indicators expose supervisor/planner/worker-code model labels. |
| Firestore-backed Cloud Run state | Fixed, smoke passed | Firestore hot paths now use targeted gets/queries and bounded lists. Cloud Run revision `head-developer-api-00043-m44` passed bounded `/sessions`, `/projects`, `/tasks`, `/task-graphs`, worker callback, command-event, and GKE full-stack smokes with `HEAD_DEVELOPER_STATE_STORE=firestore`. |
| Docker Local two-worker smoke | Done | `task_graph_cdc40b63-b53f-4779-805f-7249fa11e8e8` completed with two real app workers and validation. |
| Conversation-only planner smoke | Done | Static SaaS dashboard prompt proposed 2 workers, waited for approval, created approved graph `task_graph_c2fbb5a8-c5af-4c12-a761-09787431d85e`, assigned 2 Docker Local workers, and showed planner/approval/execution flowchart nodes. |
| Verification suite | Done | Latest documented pass: `npm run typecheck`, `npm test` with 164 passed / 1 skipped, `npm run build`, and Docker Compose config. |
| Env staging risk | Done | `.env.codex-phone-supervisor` was removed from the git index and remains ignored/local-only as of 2026-05-26 21:10 EDT. |
| GCP VM real Codex app build | In progress | Primary auth path is now the dedicated `codex_home_bundle` design. API-key auth is fallback-only. Local bundle creation and GCP VM Codex smoke still need proof from this branch. |
| GKE Job worker backend | Firestore full-stack smoke passed with caveats | `gke_job` mode, manager, manifest generator, setup/smoke script, tests, Codex-home bundle auth, authenticated Cloud Run callbacks, and Firestore-backed full-stack conversation smoke passed in `teamtiffy1729`. GKE outputs are still Pod-local evidence, not durable repo branches. |
| Full-stack local/GKE app smokes | Done with caveats | Docker Local and GKE Job both completed real Vertex-planned Wordle-style full-stack smokes. The latest GKE run used Firestore state and passed with graph `task_graph_a314e396-6dd3-42cb-bea4-1880e5774a1b`. |
| Cloud Run deployment | Done | Production URL `https://head-developer-api-jq6oo2ormq-uc.a.run.app` is on revision `head-developer-api-00046-xp5` with Firestore state, Vertex/Gemini provider indicators, amd64 API/worker images, and public `allUsers` invoker access per user approval. |
| Git repo / PR orchestration | Design documented, implementation gap | Local git init, Docker worker branches, and worktrees exist. Durable GKE output artifacts, remote repo creation, branch push, PR creation, conflict resolution, and approval-gated merge remain unimplemented. |

Active branch/chat visibility:

| Source | Status | Coordination note |
| --- | --- | --- |
| Current repo branch | Active | `karan-changes` tracks `origin/karan-changes` at `227b8da`; working tree has broad uncommitted restructuring and cleanup changes. |
| Git worktrees | None known | `git worktree list` shows only the main checkout. |
| Parallel Codex chats | Unknown | Treat any incoming patch as external until its diff, tests, docs, architecture path, and secret handling are reviewed. |

Acceptance gate for any external chat changes:

| Gate | Required before accepting |
| --- | --- |
| Diff inspection | Identify product code, docs, generated artifacts, env/config, deletions, and any architecture bypasses. |
| Tests | Run focused tests for touched areas, then typecheck/full tests/build/compose config when behavior or infra changes. |
| Docs | Update `.head-developer/*` and relevant root docs when code paths, state, API, validation, or runbooks change. |
| Architecture | Keep completion gates, output contracts, materializer command policy, truthful summaries, and worker context docs intact. |
| Secrets | Do not print, commit, copy, rotate, or provision credentials. `.env.codex-phone-supervisor` must remain uncommitted. |
| Repo hygiene | Do not touch `.codex-worker-home`; do not delete files unless stale status is documented and references are checked. |

Recommended merge order:

1. Land/commit the completed multi-worker output-contract, deterministic materialization, and agentic planning phase together after rechecking that `.env.codex-phone-supervisor` remains untracked and ignored.
2. Merge cleanup/docs-only artifact removals only after confirming they are already documented stale files and tests still pass.
3. Merge GCP VM Codex-home auth only after the local bundle smoke, real VM smoke, docs, and full verification suite pass without printing secrets.

Next implementation priorities:

1. Implement durable repo/branch/PR lifecycle for GKE and cloud workers: artifact upload, branch materialization, conflict detection, integration validation, PR creation, and approval-gated push/merge.
2. Request or work around the exact GKE scale-up quota: `SSD_TOTAL_GB` in `us-central1`, current limit `250`, current usage `200`; request at least `500` to allow several Autopilot worker nodes.
3. Fix worker process exit semantics for GKE Jobs so Kubernetes Job status matches orchestrator completion; the latest smoke passed in orchestrator state while completed worker Jobs still ended as `BackoffLimitExceeded`.

Git/PR orchestration requirements to add before claiming production multi-worker development:
- Planner should decide when a new repo is needed, initialize it before worker launch, and record the repo/remote metadata on the project.
- Each worker task should use an isolated branch/worktree and an output contract that includes expected file ownership.
- The orchestrator should detect overlapping file claims before parallel launch and either revise the split or force sequential execution.
- After worker completion and validation, the orchestrator should commit each worker branch, push it to the remote, create a pull request, and record PR URL/status/checks.
- A merge coordinator should review diffs, detect conflicts, run integration validation, merge in dependency order, and ask for approval before risky pushes or destructive conflict resolution.
- Direct pushes to `main`/`master` must remain approval-gated; secrets must not be printed in PR bodies, logs, or command events.

## 2026-05-28 - Docker Local browser cleanup and small full-stack notes smoke

Scope:
- Cleared Docker Local browser project clutter by isolating product project discovery to `/generated-projects`, backed by host `tmp/codex-phone-supervisor-projects`.
- Added discovery/list filtering so an empty generated-projects container root is not shown as a selectable project.
- Ran a real browser-originated conversation through the Vertex/Gemini supervisor/planner to build a small full-stack notes app with Docker Local workers.
- Did not touch `.codex-worker-home`, did not print `.env.codex-phone-supervisor`, and did not add product features outside the smoke blockers.

Smoke evidence:
- Session: `10118b96-e973-46ca-822d-f645558d97e3`.
- Project: `project_5714488b9cfee3f0`, `Small Full Stack Notes Website`, workspace `/generated-projects/small-full-stack-notes-website`.
- Planner decision: `planning_29071796-ad11-4982-8b9a-7deb78fb1750`, provider `vertex`, decision `propose_task_split`, worker mode `docker_local`, approved by user.
- Task graph: `task_graph_6fd69cc1-0066-40cd-b444-5178f93d7706`, status `completed`.
- Generated app files include `backend/server.js`, `backend/notes.js`, `frontend/index.html`, `frontend/script.js`, `frontend/style.css`, `Dockerfile`, and `docker-compose.yml`.
- Host HTTP smoke passed: `GET /health` returned `{ ok: true }`, `POST /notes` returned `201`, and subsequent `GET /notes` returned `Host smoke note via HTTP`.
- After cleanup patch, `/projects` returns only the generated notes app, not the `/generated-projects` container root.
- Verification after fixes: `npm run typecheck`, `npm test` with 164 passed / 1 skipped, `npm run build`, and `docker compose --env-file .env.codex-phone-supervisor -f docker/docker-compose.local.yml config` all passed.

Fixes made while running the smoke:
- Documentation-only setup nodes no longer fail completion gates for app-output evidence when only documentation files are required.
- Repair-node completion now clears the original `needs_repair` graph node/task.
- Worker completion evidence now includes Codex-reported modified files and `git status --short` files, so direct edits from validation/integration nodes can count without a materializer command.
- Operator retry resets graph-node state and passes `approved_by_user` through the HTTP route.
- Docker worker pollers key skipped/completed work by worker/task/update/status, so a retried task id is not ignored for the process lifetime.
- Added regression coverage for Docker compose project isolation, project root filtering, route-level approved operator actions, completion-gate setup nodes, and repair-node clearing.

Remaining risks:
- The generated notes app stores notes in memory; that matches the no-external-services MVP smoke but is not durable across server restarts.
- Progress events can still be verbose for long `codex exec` prompts; they are grounded in command events, but the UI could use a display truncation pass later.

## 2026-05-28 - Human-style planner confirmation pass

Scope:
- Adjusted planner instructions and approval rendering so complex plans read like an engineering lead confirming requirements, assumptions, technical direction, task split, validation, and approval/revision options.
- Added regression coverage that multi-step planner responses include `Before I start`, `Technical direction`, `Assumptions`, and `Does this match what you want? Reply approve ... or tell me what to change.`

Conversation-only evidence:
- Prompt: `Build a static SaaS dashboard with landing, login, dashboard, and settings.`
- Response now confirms the understood dashboard shell, states static HTML/CSS/JS assumptions, proposes two Docker Local workers, lists outputs and validation, and asks the user to approve or revise.
- Revision prompt `Use one worker instead.` returns a revised one-worker plan and waits for approval.

Validation:
- `npm run typecheck` passed.
- `npx tsx --test --test-concurrency=1 codex-phone-supervisor/tests/agentic-planning.test.ts` passed with 2 tests.
- Full `npm test` passed with 164 passed / 1 skipped after updating stale wording assertions.
- `npm run build` passed.

## 2026-05-28 - Cloud Run release cleanup and deployment

Scope:
- Prepared and deployed the authenticated Cloud Run production service from branch `karan-changes`.
- Removed the untracked generated fixture `playing-chess-on-browser-website/` after confirming it was not referenced by product code or docs and documenting it in `KEEP_DELETE_PLAN.md`.
- Updated the GCP image build script so the release path builds and pushes both API and worker images; the Cloud Run deploy script still requires authentication and now carries Vertex/provider and worker-mode envs when provided.
- Added `.dockerignore` so local env files, Codex auth homes, tmp state, and generated smoke apps are not sent in Docker build contexts.
- First release image push from Docker Desktop produced an ARM/OCI image index that Cloud Run rejected. The build script now publishes explicit `linux/amd64` images with `docker buildx --push`.
- Reconfirmed `.env.codex-phone-supervisor`, `.codex-worker-home/`, `.codex-vm-home/`, and `tmp/` are ignored; no secret values were printed.

Deployment evidence:
- Cloud Run service: `head-developer-api`, project `teamtiffy1729`, region `us-central1`.
- Production URL: `https://head-developer-api-jq6oo2ormq-uc.a.run.app`.
- Latest ready revision: `head-developer-api-00046-xp5`.
- API image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/api:karan-cloudrun-amd64-prod-20260528141254`.
- Worker image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:karan-cloudrun-amd64-prod-20260528141254`.
- Runtime state: `HEAD_DEVELOPER_STATE_STORE=firestore`, Firestore project `teamtiffy1729`, production prefix from deployment env.
- Provider indicator from `/ready`: `Supervisor: Vertex/Gemini`, `Planner: Vertex/Gemini`, `Worker code model: Codex CLI`.
- Initial deployment kept Cloud Run authenticated. On 2026-05-28, user explicitly approved public access; `allUsers` now has `roles/run.invoker` on `head-developer-api`.
- Current invokers are `allUsers`, `gke-worker-sa@teamtiffy1729.iam.gserviceaccount.com`, `worker-vm-sa@teamtiffy1729.iam.gserviceaccount.com`, and `teamtiffy1729@gmail.com`.
- Authenticated smoke passed: `/ready` returned `ok=true`, `/` returned HTTP 200, frontend bundle contains the Cloud Run API base rather than localhost, `POST /sessions` created session `a2ac28f8-0db5-48a5-b9a2-b20c988778d3`, and `GET /projects` returned quickly with a bounded empty list.
- Public unauthenticated smoke passed: `/` returned HTTP 200 and `/ready` returned `ok=true` with provider indicators `Vertex/Gemini` and `Codex CLI`.

Release pass status:
- Deployment implementation was committed and pushed in `95c298b`.
- Public Cloud Run access was applied after explicit user approval and is documented in the follow-up repo change.

## 2026-05-28 - Firestore production hardening and GKE full-stack smoke

Scope:
- Reworked Firestore state access so hot paths use direct document reads, indexed single-field queries, and bounded list fallbacks instead of whole-state scans.
- Added Firestore transport `runQuery` support, fixed the REST `documents:runQuery` path, added operation timeouts, and surfaced clear `STATE_STORE_TIMEOUT` / `STATE_STORE_ERROR` API responses.
- Passed Firestore-backed Cloud Run bounded POST checks and one full-stack GKE Job conversation smoke without switching Cloud Run back to file state.
- Did not touch `.codex-worker-home`, did not print credential contents, did not make Cloud Run public, and did not make the Codex home bundle public.

Firestore smoke evidence:
- Cloud Run revision: `head-developer-api-00043-m44`.
- API image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/api:firestore-hardening-amd64-plain-20260527234915`.
- Worker image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:firestore-hardening-amd64-plain-20260527234242`.
- Firestore collection prefix: `head_developer_firestore_hardening_20260527234915`.
- Bounded POST smoke: `/sessions`, `/projects`, `/tasks`, and `/task-graphs` all returned within 30 seconds; the slower `/task-graphs` result was still bounded after removing GKE API-side git prep from the non-durable GKE path.
- Full-stack GKE smoke: session `46d87f57-0470-4e88-a16e-c1147df84cd2`, project `project_3f392cd2b7c962fd`, task graph `task_graph_a314e396-6dd3-42cb-bea4-1880e5774a1b`, status `completed`.
- Nonce proof: `NONCE-FULLSTACK-GKE-JOB-1779940016097-516` in generated file `SMOKE_PROOF_nonce-fullstack-gke-job-1779940016097-516.txt`.
- Worker command evidence: setup Codex `5967ca09-ecce-421a-8d73-20d0de66c5bf`, backend Codex `c10237e4-aea4-49e5-b082-5e05efa80c7e`, frontend Codex `d4df1cd8-d4ab-49fe-b4af-9e7c6d2ba6fa`.
- Validation evidence: backend `node --check server.js` command `84f44b64-20f1-4f27-9582-fef280c2bfb6` exited `0`; frontend `node --check public/app.js` command `e7877790-542e-4a8c-8978-f093a0dca04e` exited `0`.
- Cleanup evidence: `kubectl wait --for=delete pod -n head-developer-workers -l app=head-developer --timeout=180s` completed and `kubectl get jobs,pods -n head-developer-workers -l app=head-developer -o name` returned no resources.

GKE quota finding:
- Exact metric: Compute Engine `SSD_TOTAL_GB` in `us-central1`.
- Current limit: `250`.
- Current usage during/after investigation: `200`.
- Blocking evidence: Cloud Logging reported `OutOfResource.QUOTA_EXCEEDED` and `Quota 'SSD_TOTAL_GB' exceeded. Limit: 250.0 in region us-central1` for Autopilot instance group scale-up attempts in `us-central1-a`, `us-central1-b`, and `us-central1-f`.
- Cheapest workaround: reduce `MAX_GKE_JOB_WORKERS` / approved worker count to run fewer Pods concurrently, or wait for existing Autopilot nodes to reuse capacity.
- Targeted quota request: raise `SSD_TOTAL_GB` in `us-central1` to at least `500` so two existing 100GB nodes plus several additional Autopilot worker nodes can scale without hitting the disk quota.

Repo/PR lifecycle design status:
- Design is documented in `PRODUCT_ARCHITECTURE.md`.
- Implementation is intentionally deferred until Firestore state remains stable under production load.
- Current GKE worker outputs are validated through command/materialization evidence inside Pods and are not persisted into durable repo branches.

Remaining blockers:
- GKE worker processes can complete orchestrator tasks but still exit nonzero, leaving Kubernetes Jobs marked `BackoffLimitExceeded`; cleanup works, but Job status should match orchestrator completion before production.
- Durable artifact upload, branch materialization, PR creation, conflict detection, and approval-gated merge are not yet implemented.
- `SSD_TOTAL_GB` quota should be raised or concurrency should stay low before larger GKE workloads.

## 2026-05-28 - Full-stack Docker Local and GKE Job conversation smokes

Scope:
- Ran the real conversation path for a complex full-stack Wordle-style vocabulary app with Vertex/Gemini planning and Codex CLI workers.
- Used Computer Use to verify the Cloud Console browser was on project `teamtiffy1729` and showed cluster `head-developer-workers` in `us-central1`.
- Reconfirmed with `kubectl` after cleanup that there are no remaining `app=head-developer` Jobs or Pods.
- Did not use OpenAI API-key auth as the primary path; GKE workers used the existing `codex_home_bundle` path.

Docker Local smoke result:
- Worker mode/count: `docker_local`, `2`.
- Session: `15a21b5c-3faa-4590-a17b-0cde2d1b2d47`.
- Project: `project_6f7b8bd3c97c4955`.
- Task graph: `task_graph_0c238dec-27fd-41d7-84b8-cf0d24b2bf24`, completed.
- Nonce proof: `NONCE-FULLSTACK-DOCKER-LOCAL-1779929686796-2398`.
- Generated proof file: `SMOKE_PROOF_nonce-fullstack-docker-local-1779929686796-2398.txt`.
- Nodes completed: project setup/initial files, backend API development, frontend UI development, validation/handoff.

GKE Job smoke result:
- Worker mode/count: `gke_job`, requested `2`; the approved plan produced 3 task graph nodes and ran 3 worker Jobs.
- Cloud Run revision: `head-developer-api-00039-c4g`.
- Cloud Run state mode during the successful smoke: `HEAD_DEVELOPER_STATE_STORE=file`, `minScale=1`, `maxScale=1`.
- API image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/api:fullstack-smoke-amd64-20260528015736`.
- Worker image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:fullstack-smoke-amd64-20260528015736`.
- Session: `62ecd327-843d-4521-bc15-81e1c103ca81`.
- Project: `project_3fd6fafea9e72918`.
- Initial project before unique-app-name reroute: `project_c52ddf65534b7b46`.
- Task graph: `task_graph_e0f864d2-5103-4033-8403-1e890c62e93d`, completed.
- Nonce proof: `NONCE-FULLSTACK-GKE-JOB-1779934599957-5466`.
- Generated proof file: `SMOKE_PROOF_nonce-fullstack-gke-job-1779934599957-5466.txt`.
- Generated files: `.head-developer/VALIDATION.md`, `.head-developer/WORKER_HANDOFFS.md`, `SMOKE_PROOF_nonce-fullstack-gke-job-1779934599957-5466.txt`, `package.json`, `public/app.js`, `public/index.html`, `public/styles.css`, `server.js`.
- Task nodes/workers: project setup and documentation (`worker_e58da801-6ec5-4abc-9967-241fd262e21f`), backend server development (`worker_6eba586d-f095-4733-9bdc-f8cecf326caf`), frontend application development (`worker_9630e13c-25f4-4d42-aee0-6cfb6025972c`).
- Codex auth evidence: frontend command recorded `codex_auth_method=codex_home_bundle`, `codex_auth_validation_status=validated`, Codex session `019e6c61-9d72-7cc1-abe3-0ea5e327d690`.
- Command event examples: backend Codex `3b1e2633-93c4-4811-9120-a3af0cbd0d35`, backend materializer `0442811d-0c75-426d-9bb4-756b233d717b`, frontend Codex `68fc27ae-0d78-46c4-9afd-2e4dc5a05888`, frontend materializer `e771eb25-4e52-4243-abd8-8f3611ca4294`.
- Validation evidence: `node --check server.js` command `3634163e-7a4e-4691-8097-5bd4d44a10d1` exited `0`; `node --check public/app.js` command `ade3393a-9a93-41ba-b51a-24cc46e7fc6d` exited `0`.
- Cleanup: smoke script deleted Jobs by worker label; `kubectl wait --for=delete pod -n head-developer-workers -l project_id=project_3fd6fafea9e72918 --timeout=180s` completed, and `kubectl get jobs,pods -n head-developer-workers -l app=head-developer -o name` returned no resources.

Cloud/GKE evidence:
- Browser/Computer Use evidence: Cloud Console URL `console.cloud.google.com/kubernetes/list/overview?authuser=3&project=teamtiffy1729`, project label `Team Tiffy`, cluster `head-developer-workers`, status OK.
- Cluster: GKE Autopilot `head-developer-workers`, location `us-central1`, version `1.35.3-gke.1389000`, Workload Identity pool `teamtiffy1729.svc.id.goog`, node image `COS_CONTAINERD`.
- Namespace/KSA/GSA: `head-developer-workers/head-developer-worker -> gke-worker-sa@teamtiffy1729.iam.gserviceaccount.com`.
- Codex bundle: `gs://teamtiffy1729-head-developer-artifacts/codex-auth/codex-vm-home-bundle.tgz`.
- Cloud NAT exists: router `head-developer-nat-router`, NAT `head-developer-nat`.
- Quota risk: Cloud Console showed `Can't scale up nodes`; Kubernetes events included `FailedScaleUp: GCE quota exceeded`. The Console details did not name a specific metric, only that new resources such as CPU or Disk can fail when quota is exceeded. The smoke still scheduled and completed after Autopilot scale-up, but larger workloads need a targeted quota investigation/request.

Production blockers still open:
- Firestore-backed Cloud Run POSTs (`/sessions`, `/projects`) hung under the deployed service. The successful GKE full-stack smoke used a temporary single-instance file-backed Cloud Run state mode.
- GKE worker Pods use Pod-local `/workspace`, not a durable repo checkout. `git status --short .` inside the Pod exits `128`; completion still passed through materialized file evidence and validation commands.
- The orchestrator does not yet create remote repositories, push worker branches, create PRs, or merge conflict-free outputs end to end.

## 2026-05-27 - Karan branch and GCP VM Codex auth blocker

Scope:
- Created local branch `karan-changes` from the current checkpoint and pushed it to `origin/karan-changes`.
- No dirty working-tree changes were staged or committed for this branch push.
- Rechecked GCP VM Codex auth implementation, setup scripts, and smoke scripts without changing IAM, secrets, or `.codex-worker-home`.

Findings:
- VM workers pass `HEAD_DEVELOPER_CODEX_AUTH_METHOD`, `HEAD_DEVELOPER_CODEX_API_KEY_SECRET`, `HEAD_DEVELOPER_CODEX_API_KEY_SECRET_PROJECT`, and `HEAD_DEVELOPER_CODEX_API_KEY_SECRET_VERSION` into the worker container.
- Real `codex` commands on `gcp_vm` fail closed when `HEAD_DEVELOPER_CODEX_AUTH_METHOD=secret_manager_api_key` or the Secret Manager resource is missing.
- The worker fetches the secret at runtime using the VM metadata token, pipes it to `codex login --with-api-key`, then validates with `codex login status`.
- The safe VM smoke only runs shell commands such as `pwd`; it does not prove Codex auth.
- The real auth proof harness is `scripts/gcp/run-codex-auth-smoke.sh`, which creates a `gcp_vm` Codex task and reports only method/resource metadata, command IDs, generated files, nonce evidence, status, and cleanup.
- Current shell env has required GCP/Vertex/Codex auth variables unset, including `GCP_PROJECT_ID`, `HEAD_DEVELOPER_WORKER_IMAGE_URI`, `WORKER_CALLBACK_URL`, `HEAD_DEVELOPER_CODEX_AUTH_METHOD`, `HEAD_DEVELOPER_CODEX_API_KEY_SECRET`, `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, and `VERTEX_MODEL`.

Risk:
- `scripts/gcp/create-service-accounts.sh` grants Secret Manager access in `GCP_PROJECT_ID` after extracting the secret name from a full `projects/*/secrets/*` resource. If the Codex API key secret lives in a different project, IAM will be granted to the wrong project unless handled manually or fixed.

## 2026-05-27 - Codex home bundle auth pivot

Scope:
- Stopped the OpenAI API-key VM Codex smoke path and left `secret_manager_api_key` as fallback-only.
- Added `.codex-vm-home/` to `.gitignore`; `.codex-worker-home` was not touched.
- Added `scripts/gcp/create-codex-vm-home-bundle.sh` for the dedicated ChatGPT-login Codex home bundle workflow.
- Added `scripts/gcp/run-codex-home-bundle-smoke.sh` for the glassblowing studio nonce VM smoke.
- Added `HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle` config, bundle Secret Manager/GCS envs, VM startup env pass-through, bundle fetch/extract validation, and Codex auth path redaction.
- Updated docs to state OpenClaw is not needed for auth and is not the primary solution.

Pending:
- Run local `.codex-vm-home` login/status and nonce smoke.
- Upload the bundle to Secret Manager or restricted GCS and verify `worker-vm-sa` read access.
- Rebuild/deploy worker/API images with the new startup/runtime code.
- Run the real GCP VM Codex home bundle smoke and verify no worker VM remains.

## 2026-05-27 - GKE Job worker backend investigation

Scope:
- Phase 2 prototype approved for target project `teamtiffy1729`.
- Added `gke_job` as a worker mode and `GkeJobWorkerManager` as a prototype backend.
- Existing `gcp_vm`, `docker_local`, and `local` backends remain in place.
- GKE Autopilot plus Kubernetes Jobs is used for disposable workers, provided Workload Identity Federation, private bundle access, Cloud Run callback auth, and external egress are configured.

Implemented:
- Worker mode config accepts `gke_job`; Docker Local/VM modes still parse normally.
- `GkeJobWorkerManager` builds a Kubernetes Job manifest with required labels, emptyDir volumes, Codex home bundle env, and authenticated Cloud Run callback env.
- API image now installs `kubectl` and `google-cloud-cli-gke-gcloud-auth-plugin` so Cloud Run can create Jobs.
- `scripts/gcp/run-gke-job-codex-home-smoke.sh` creates/selects the Autopilot cluster, configures namespace/KSA/WIF/IAM, launches one smoke Job, polls API/Job evidence, and deletes the Job by labels.
- Tests cover config acceptance, manifest env/labels/callback auth/no API-key secrets, cleanup-by-label shape, and script presence.

Live smoke result:
- Target project: `teamtiffy1729`.
- Cluster/namespace: `head-developer-workers` / `head-developer-workers`.
- Kubernetes Job/Pod: `hd-worker-8bbeb3fa` / `hd-worker-8bbeb3fa-6vpfv`.
- Worker identity: KSA `head-developer-workers/head-developer-worker` mapped to GSA `gke-worker-sa@teamtiffy1729.iam.gserviceaccount.com`.
- Worker image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:gke-job-amd64-20260527184320`.
- API image deployed for the smoke: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/api:gke-job-amd64-20260527190636`.
- Cloud Run URL/audience: `https://head-developer-api-jq6oo2ormq-uc.a.run.app`.
- Codex bundle: `gs://teamtiffy1729-head-developer-artifacts/codex-auth/codex-vm-home-bundle.tgz`.
- Codex auth evidence: Pod log reported `Codex auth validated with method codex_home_bundle`.
- Codex command event: `84058570-a1d7-4492-be2b-cd61af1cd580`.
- Generated files: `index.html`, `styles.css`, `script.js`, `CODE_INDEX.md`, `FUNCTIONS.md`, `VARIABLES.md`, `STATE_MODEL.md`, `API_SURFACE.md`, `.head-developer/WORKER_HANDOFFS.md`, `.head-developer/VALIDATION.md`.
- Nonce proof: `NONCE-GKE-CODEX-HOME-1779924298-8174` appeared in `.head-developer/VALIDATION.md`, `.head-developer/WORKER_HANDOFFS.md`, and `index.html`.
- Validation result: `completed`.
- Cleanup: Job deleted by `app=head-developer,worker_id=worker_8bbeb3fa-1643-4f44-8d47-568ab98cbb30`; remaining Jobs `0`, remaining Pods `0`.

Remaining before production use:
- Replace the prototype Firestore/Cloud Run latency mitigations with a cleaner state access path before large multi-worker GKE workloads.
- Decide whether Cloud Run should remain pinned to one instance for state consistency during GKE prototype runs or move to a proper multi-instance-safe state model.
- Keep Codex home bundle auth primary; do not use OpenAI API-key auth or public bundle access.
- Add orchestrator-owned branch/PR lifecycle before claiming end-to-end parallel development with conflict-free merges.

Prototype acceptance target after approval:
- One Kubernetes Job per worker/task assignment using the existing worker image.
- Pod uses a dedicated Kubernetes service account mapped to a Google service account through Workload Identity Federation.
- Pod fetches the restricted Codex home bundle, extracts to `/codex-home`, validates `codex login status`, runs `codex exec`, posts authenticated callbacks to Cloud Run, records command events/validation/summary, and cleans up Jobs/Pods.

## 2026-05-27 - Agentic planning phase

Scope:
- Added a model-driven `AgenticPlanningController` with structured planner decisions and a GCP/Gemini-backed `PlannerModel` interface.
- Added a conservative deterministic fallback planner for tests/offline mode.
- Routed build requests through planning where appropriate without turning planning into a fixed checklist.
- Added approval/revision handling for multi-worker splits, GCP workers, and risky actions.
- Stored redacted planning state on sessions, projects, task graphs, and worker context packets.
- Added flowchart nodes for requirement summaries, planner decisions, task split proposals, user approvals, approved plans, and execution start.
- Hardened redaction for bare `token=...` assignments and existing audit log tails.

Conversation behavior covered:
- Vague `Build a game.` asks a focused clarification and creates no workers.
- Clear simple `Build a landing page for a chai shop.` starts a one-worker Docker Local path.
- Clear multi-page SaaS dashboard request proposes a two-worker split and waits for approval.
- `approve` creates a task graph matching the proposal and starts worker assignments.
- `Use one worker instead.` revises the pending split before approval.
- `Run this on GCP workers.` waits for GCP VM approval.
- Risky deploy/security actions wait for approval.

Verification:
- `npm run typecheck` passed.
- `npx tsx --test codex-phone-supervisor/tests/agentic-planning.test.ts` passed: 2 tests.
- `npm test` passed: 136 passed, 1 skipped.
- `npm run build` passed.
- `docker compose -f docker/docker-compose.local.yml config` passed.

Smoke:
- Conversation-only planner smoke created approved graph `task_graph_c2fbb5a8-c5af-4c12-a761-09787431d85e` from the approved two-worker split and assigned two Docker Local worker records.
- Output contracts and approved plan metadata were present in worker context packets.
- Flowchart showed planner/approval/execution nodes and the execution-start edge into the task graph.
- This smoke did not run real Codex materialization/validation; existing real Docker Local evidence remains `task_graph_cdc40b63-b53f-4779-805f-7249fa11e8e8`.

Env/security recheck after this phase:
- `git status --short -- .env.codex-phone-supervisor` returned no entry; the file is not staged.
- `test -f .env.codex-phone-supervisor` confirmed the local file still exists.
- `git check-ignore -v .env.codex-phone-supervisor` confirmed `.gitignore` line 2 covers it.
- Staged secret/auth filename scan returned no matches.
- Tracked secret/auth filename scan returned no matches for credential/auth/token/key material; `.env.example` remains a placeholder template, not a credential file.

## 2026-05-27 - Vertex/Gemini runtime supervisor

Scope:
- Removed `mock` from normal supervisor provider config.
- Runtime now defaults `SUPERVISOR_MODEL_PROVIDER` to `vertex`.
- `.env.example` now documents Vertex/Gemini as the runtime default and provides placeholder Vertex env vars.
- Docker Local no longer sets `SUPERVISOR_MODEL_PROVIDER=mock`; it defaults to `vertex` and passes through `VERTEX_PROJECT_ID`, `VERTEX_LOCATION`, and `VERTEX_MODEL`.
- Worker runtime defaults also use `SUPERVISOR_MODEL_PROVIDER=vertex`.
- Deterministic fake supervisor/planner behavior remains test-only behind `CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL=deterministic` and `CODEX_PHONE_SUPERVISOR_TEST_MODE=1`; it is not selectable through `SUPERVISOR_MODEL_PROVIDER`.
- Provider indicators are exposed as `supervisor_model_provider`, `planner_model_provider`, and `worker_code_model`, showing `Vertex/Gemini`, `Vertex/Gemini`, and `Codex CLI` without secrets.
- Missing Vertex config fails with: `Vertex/Gemini supervisor is not configured. Set required GCP/Vertex env vars.`

Real Vertex planner smoke:
- Prompt: `Build a static SaaS dashboard with landing, login, dashboard, and settings.`
- Provider: `vertex`.
- Planner model recorded: `vertex:gemini-2.5-flash`.
- Decision type: `propose_task_split`.
- Required approval: `true`.
- Execution allowed: `false`.
- Recommended worker mode/count: `docker_local`, `2`.
- Proposed split count: `6` (`Project Setup and Documentation`, `Landing Page Development`, `Authentication Pages Development`, `Dashboard Page Development`, `Settings Page Development`, `Validation and Review`).
- Graph count before approval: `0`; no workers were launched.
- User-visible response asked for approval and contained no raw JSON.

Focused verification already passed:
- `npm run typecheck`.
- `npx tsx --test codex-phone-supervisor/tests/agentic-planning.test.ts codex-phone-supervisor/tests/model-provider.test.ts codex-phone-supervisor/tests/config-failure.test.ts`.
- Full `npm test` passed: 141 passed, 1 skipped.
- `npm run build` passed.
- `docker compose -f docker/docker-compose.local.yml config` passed and showed `SUPERVISOR_MODEL_PROVIDER: vertex`.

## 2026-05-26 - Env staging cleanup

Scope:
- Cleaned the staged env-file risk only.
- No product logic or feature code was changed.
- `.codex-worker-home` was not touched.

Commands and results:
- `git status --short` initially showed `AM .env.codex-phone-supervisor`.
- `git diff --cached --name-status -- .env.codex-phone-supervisor` confirmed the env file was staged as an added file.
- `git rm --cached .env.codex-phone-supervisor` was attempted first and refused because the staged snapshot differed from the local file.
- Removed a stale, unowned `.git/index.lock`, then ran `git rm --cached -f .env.codex-phone-supervisor`; this removed only the index entry and left the local file on disk.
- `git status --short -- .env.codex-phone-supervisor` returned no entry after cleanup.
- `test -f .env.codex-phone-supervisor` confirmed the local env file still exists.
- `git check-ignore -v .env.codex-phone-supervisor` confirmed `.gitignore` line 2 ignores it.
- Staged secret/auth filename scan found no matches.
- Tracked secret/auth filename scan found only `.env.example`, which is the placeholder template and not a committed credential file.

Verification after cleanup:
- `npm run typecheck` passed.
- `npm test` passed: 123 passed, 1 skipped.
- `npm run build` passed.
- `docker compose -f docker/docker-compose.local.yml config` passed.

## 2026-05-26 - TestAppCleanup checkpoint

Scope:
- Cleaned only generated smoke/test apps, stale smoke screenshots, stale smoke workspaces, and repo-local test temp directories.
- Left product source, tests, Docker/GCP/MCP tooling, state-store/orchestration modules, `.codex-worker-home`, auth files, and current acceptance evidence untouched.

Classification and reference check:
- Product source code kept: `codex-phone-supervisor/`, `apps/mcp-server/`, `packages/mcp-tools/`, `docker/`, `infra/gcp/`, and `scripts/gcp/`.
- Product test code kept: `codex-phone-supervisor/tests/`.
- Current/useful evidence kept: `static-saas-dashboard-shell-smoke-20260526231422/`, `static-saas-dashboard-shell-smoke-20260526231422.worktrees/`, and `codex-auth-docker-smoke-NONCE-CODEX-AUTH-DOCKER-20260526184728-548/`.
- Temporary local state kept where safety was ambiguous: `.codex-worker-home/`, `data/voice_agent.sqlite3`, `.playwright-mcp/`, and local `tmp/` state that may be tied to live browser/supervisor sessions.
- Generated smoke artifacts selected for removal after `rg` reference checks found no product/test dependency on the artifact directories: prior generated app folders, old acme Orbit smoke folders/worktrees, the empty `static-saas-dashboard-shell-smoke-20260526231323/`, root smoke screenshots, `data/smoke-artifacts/`, and old `tmp/*-test-*` style test directories.
- Root screenshots removed by this cleanup were visual smoke evidence from earlier checks; their validation status is already summarized in `.head-developer/VALIDATION.md` and this handoff.
- Cleanup validation passed: `npm run typecheck`, `npm test` (117 passed, 1 skipped), `npm run build`, and `docker compose -f docker/docker-compose.local.yml config`.

Do not mark the broader multi-worker phase complete from this cleanup. The fresh two-worker smoke still needs a separate acceptance result.

## 2026-05-26 - Multi-worker output-contract cleanup

What changed:
- Added/verified output contracts on task graph nodes and worker context packets.
- Hardened worker validation so app-building tasks cannot pass with only `.head-developer` docs or weak `ls`/`git status` evidence.
- Made summaries report incomplete/docs-only app nodes honestly.
- Added static SaaS shell splitting for no-billing/no-backend prompts.
- Added repair-node creation when a worker reports completion but the completion gate rejects app output.
- Reloaded gated task state before worker-result summary generation.
- Documented project documentation indexing and docs freshness integration.
- Serialized the full test runner with `--test-concurrency=1` to remove backend subprocess health-check flakes under parallel suite load.

Files touched by this phase:
- `codex-phone-supervisor/backend/src/task-complexity.ts`
- `codex-phone-supervisor/backend/src/multi-worker-coordinator.ts`
- `codex-phone-supervisor/backend/src/completion-gate.ts`
- `codex-phone-supervisor/backend/src/app-output-validation.ts`
- `codex-phone-supervisor/backend/src/worker-entry.ts`
- `codex-phone-supervisor/backend/src/summary.ts`
- `codex-phone-supervisor/backend/src/documentation-indexer.ts`
- `codex-phone-supervisor/backend/src/git-project-manager.ts`
- `codex-phone-supervisor/backend/src/action-router.ts`
- `codex-phone-supervisor/backend/src/flowchart.ts`
- `codex-phone-supervisor/backend/src/index.ts`
- `codex-phone-supervisor/backend/src/types.ts`
- `codex-phone-supervisor/backend/src/project-store.ts`
- `codex-phone-supervisor/tests/*.test.ts` related to completion gates, validation, summaries, docs, and multi-worker context.
- `package.json`
- Audit smoke artifact observed: `codex-auth-docker-smoke-NONCE-CODEX-AUTH-DOCKER-20260526184728-548/codex-auth-docker-smoke.txt`. It is a nonce-only Codex auth audit artifact and contains no printed secret value.

Commands run by main agent:
- `npm run typecheck`
- `npx tsx --test codex-phone-supervisor/tests/completion-gate.test.ts codex-phone-supervisor/tests/app-output-validation.test.ts codex-phone-supervisor/tests/multi-worker.test.ts codex-phone-supervisor/tests/summary-truthfulness.test.ts`
- `npm test`
- `npm run build`
- `docker compose -f docker/docker-compose.local.yml config`

Remaining risks:
- Completion gates infer changed files from command event text; workers must continue logging changed files accurately.
- Fresh two-worker live Codex smoke still needs to prove both workers produce real app files, not docs-only output.
- CleanupDocs CLI subagent attempted to run but exited without report/docs; this main-thread docs pass replaces it for this checkpoint, but it is not a successful CleanupDocs subagent report.
- CodexAuthAudit was behavior-neutral. Do not delete or rotate credentials based on this pass.

Next suggested task:
- Run the fresh small two-worker Docker Local smoke for the static SaaS shell prompt and verify two worktrees, app files from both workers, validation, flowchart, and summary truthfulness.

## 2026-05-26 - Deterministic Codex materialization consolidation

What changed:
- Worker Codex prompts now require `files_to_write` with exact app file contents.
- The worker parses Codex JSONL stdout, validates relative output paths, and writes the exact returned files through a logged materializer command.
- The command policy allows only the internal `node /state/runtime/materialize-codex-files.mjs ...` command for this write path.
- `CommandRunner` records timeouts as exit code `124` and emits failed command events.
- Worker task summaries now separate Codex-generated content from worker materialization, so a Codex exit `0` alone does not imply app files were created.

Files inspected:
- `codex-phone-supervisor/backend/src/worker-entry.ts`
- `codex-phone-supervisor/backend/src/command-policy.ts`
- `codex-phone-supervisor/backend/src/command-runner.ts`
- `codex-phone-supervisor/backend/src/app-output-validation.ts`
- `codex-phone-supervisor/tests/command-policy.test.ts`
- `codex-phone-supervisor/tests/command-runner.test.ts`
- `codex-phone-supervisor/tests/app-output-validation.test.ts`
- `codex-phone-supervisor/tests/multi-worker.test.ts`
- `.head-developer/*`

Fresh smoke result:
- Project `project_4567a1bcc84c5617`.
- Task graph `task_graph_cdc40b63-b53f-4779-805f-7249fa11e8e8` completed.
- Landing/login task `task_bc1cbae7-9603-4a10-9f0e-42924ea906ae` ran on worker `worker_8d330b79-d3a2-4828-8000-61bc5b7564cd` in worktree `/workspace/static-saas-dashboard-shell-smoke-20260526201914.worktrees/landing-and-login-pages-bc1cbae7`.
- Dashboard/settings task `task_1e593c7d-41c8-4484-842b-7ca491f86111` ran on worker `worker_1671608b-935d-4c3c-b076-4d8fbab1a293` in worktree `/workspace/static-saas-dashboard-shell-smoke-20260526201914.worktrees/dashboard-and-settings-pages-1e593c7d`.
- Codex command events were `994d553d-4dc4-4842-a485-7d1a994acbeb` and `6ba33662-ec58-42cf-97e9-db1a5b81def6`, both exit `0`.
- Materializer command events were `5aad22b0-d14e-419f-b090-af8100720ec5` and `cb39cac0-f66f-4c34-b98a-10c1775e4207`, both exit `0`.
- Validation command events were `f36dd2a8-36fd-4a3d-8c40-cbf4e5920323` and `fe98667f-b5c9-416d-bf09-9992eee8252d`, both exit `0`.
- Required files exist: `index.html`, `login.html`, `styles/public.css`, `scripts/public.js`, `dashboard.html`, `settings.html`, `styles/app.css`, `scripts/app.js`.
- Flowchart shows the completed task graph, two Docker worker nodes, Codex command nodes, materializer command nodes, validation command nodes, artifacts, and summaries.

Cleanup/docs actions:
- Updated repo-level `CODE_INDEX.md`, `FUNCTIONS.md`, `VARIABLES.md`, `STATE_MODEL.md`, `API_SURFACE.md`, `DECISIONS.md`, `WORKER_HANDOFFS.md`, and `VALIDATION.md` to document the deterministic materialization path and smoke evidence.
- No dead product code was removed in this pass.
- No worker assignment, scheduling, Codex execution, or test behavior was changed during this cleanup/docs consolidation.

Remaining risks:
- `extractFinalWorkerJson` currently has smoke coverage but should get focused parser unit coverage if its behavior changes.
- Completion gates still depend on command event summaries for changed-file evidence; the materializer path now emits deterministic `created:` lines, but other future worker write paths must do the same.
- GCP Codex app builds remain out of scope until secure GCP Codex auth is implemented.
