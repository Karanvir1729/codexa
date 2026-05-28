# Validation Log

## Firestore production hardening on 2026-05-28 UTC

| Evidence | Result |
| --- | --- |
| Firestore direct transport smoke | Passed. Created and queried a project by `workspace_path` against `teamtiffy1729` using prefix `head_developer_direct_karanvirkhanna_20260527233030`. |
| Cloud Run revision | `head-developer-api-00043-m44` |
| State store | `HEAD_DEVELOPER_STATE_STORE=firestore` |
| Firestore prefix | `head_developer_firestore_hardening_20260527234915` |
| Bounded POST smoke | Passed. `/sessions`, `/projects`, `/tasks`, and `/task-graphs` all returned within the 30 second per-request bound. |
| GKE full-stack Firestore smoke | Passed. Graph `task_graph_a314e396-6dd3-42cb-bea4-1880e5774a1b` completed under Firestore-backed Cloud Run. |
| Worker auth | Codex CLI with `codex_home_bundle`; Pod logs reported `Codex auth validated with method codex_home_bundle`. |
| Nonce proof | `NONCE-FULLSTACK-GKE-JOB-1779940016097-516` in `SMOKE_PROOF_nonce-fullstack-gke-job-1779940016097-516.txt`. |
| Generated files | `.head-developer/API_SURFACE.md`, `.head-developer/CODE_INDEX.md`, `.head-developer/FUNCTIONS.md`, `.head-developer/STATE_MODEL.md`, `.head-developer/VALIDATION.md`, `.head-developer/VARIABLES.md`, `.head-developer/WORKER_HANDOFFS.md`, `SMOKE_PROOF_nonce-fullstack-gke-job-1779940016097-516.txt`, `package.json`, `server.js`, `public/index.html`, `public/styles.css`, `public/app.js`. |
| Command evidence | Setup Codex `5967ca09-ecce-421a-8d73-20d0de66c5bf`; backend Codex `c10237e4-aea4-49e5-b082-5e05efa80c7e`; frontend Codex `d4df1cd8-d4ab-49fe-b4af-9e7c6d2ba6fa`. |
| Validation evidence | `node --check server.js` command `84f44b64-20f1-4f27-9582-fef280c2bfb6` exited `0`; `node --check public/app.js` command `e7877790-542e-4a8c-8978-f093a0dca04e` exited `0`. |
| Flowchart evidence | Smoke asserted planner decision, task graph, worker, and command nodes were present. |
| Cleanup | Passed after explicit wait. `kubectl get jobs,pods -n head-developer-workers -l app=head-developer -o name` returned no resources. |
| Final verification | `npm run typecheck` passed; `npm test` passed with 160 passed / 1 skipped; `npm run build` passed; `docker compose -f docker/docker-compose.local.yml config` passed. |

Focused tests added/updated:
- `codex-phone-supervisor/tests/state-store.test.ts`: Firestore hot path lookups use targeted `get`/`query` operations for project lookup, task lists, graph lookup, worker callbacks, runtime command requests, command events, and session linkage; no full collection `list` is used in those hot paths.
- `codex-phone-supervisor/tests/gke-job-worker.test.ts`: GKE task graph creation skips synchronous API-side git prep because current GKE workers use Pod-local workspaces.

Quota finding:
- Exact blocking metric from Cloud Logging: `SSD_TOTAL_GB` in `us-central1`.
- Current limit/usage from `gcloud compute regions describe us-central1`: limit `250`, usage `200`.
- GKE scale-up logs showed `OutOfResource.QUOTA_EXCEEDED` for `SSD_TOTAL_GB` in `us-central1-a`, `us-central1-b`, and `us-central1-f`.
- Recommended targeted request: raise `SSD_TOTAL_GB` in `us-central1` to at least `500`, or keep GKE worker concurrency low as the cheapest workaround.

## Full-stack conversation smokes on 2026-05-28 UTC

| Evidence | Docker Local result | GKE Job result |
| --- | --- | --- |
| Worker mode/count | `docker_local`, `2` | `gke_job`, requested `2`; approved plan produced 3 task nodes/workers |
| Planner/supervisor | Vertex/Gemini | Vertex/Gemini |
| Worker code model/auth | Codex CLI with local Codex home | Codex CLI with `codex_home_bundle` |
| Session | `15a21b5c-3faa-4590-a17b-0cde2d1b2d47` | `62ecd327-843d-4521-bc15-81e1c103ca81` |
| Project | `project_6f7b8bd3c97c4955` | `project_3fd6fafea9e72918` |
| Task graph | `task_graph_0c238dec-27fd-41d7-84b8-cf0d24b2bf24` | `task_graph_e0f864d2-5103-4033-8403-1e890c62e93d` |
| Graph status | `completed` | `completed` |
| Nonce | `NONCE-FULLSTACK-DOCKER-LOCAL-1779929686796-2398` | `NONCE-FULLSTACK-GKE-JOB-1779934599957-5466` |
| Proof file | `SMOKE_PROOF_nonce-fullstack-docker-local-1779929686796-2398.txt` | `SMOKE_PROOF_nonce-fullstack-gke-job-1779934599957-5466.txt` |
| Generated app files | `package.json`, `server.js`, `public/index.html`, `public/styles.css`, `public/app.js`, proof/doc files | `package.json`, `server.js`, `public/index.html`, `public/styles.css`, `public/app.js`, proof/doc files |
| Validation | graph completed with worker validation/handoff | `node --check server.js` exited `0`; `node --check public/app.js` exited `0`; graph completed |
| Cleanup | Docker compose smoke cleanup completed | No remaining `app=head-developer` Jobs/Pods after `kubectl wait` and `kubectl get` |

GKE smoke details:
- Cloud Run revision: `head-developer-api-00039-c4g`.
- API image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/api:fullstack-smoke-amd64-20260528015736`.
- Worker image: `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:fullstack-smoke-amd64-20260528015736`.
- Cluster/namespace: `head-developer-workers` / `head-developer-workers`.
- Workload Identity: `head-developer-workers/head-developer-worker -> gke-worker-sa@teamtiffy1729.iam.gserviceaccount.com`.
- Cloud Run state mode for the passing smoke: `HEAD_DEVELOPER_STATE_STORE=file`, single min/max instance. This was a temporary smoke setting because the Firestore-backed Cloud Run POST path hangs.
- Computer Use evidence: the browser Cloud Console showed project `Team Tiffy` (`teamtiffy1729`), GKE cluster `head-developer-workers`, status OK, and a node scale-up quota warning.
- GKE events included `FailedScaleUp: GCE quota exceeded`; the Console details did not name a specific metric, only that CPU or Disk quota can block new resources. The workload still scheduled and completed, but larger parallel workloads need targeted quota investigation/increase.

Honest limitations:
- The GKE smoke validates worker output through Pod command/materialization evidence, not a durable merged repository.
- GKE Pods currently use Pod-local `/workspace`; `git status --short .` exits `128` inside the Pod and should be cleaned up before production-grade PR orchestration.
- The orchestrator does not yet create remote repositories, push worker branches, open PRs, or perform merge-conflict resolution end to end.

Verification after full-stack smoke documentation and deploy-script state-store pass-through:

| Command | Result | Notes |
| --- | --- | --- |
| `npx tsx --test codex-phone-supervisor/tests/gcp-scripts.test.ts codex-phone-supervisor/tests/smoke-scripts.test.ts` | passed | 10 passed. Covers GCP script wiring and smoke harness structure. |
| `npm run typecheck` | passed | Fixed optional output-contract access and stale test fixtures before rerun. |
| `npm test` | passed | 158 passed, 1 skipped. |
| `npm run build` | passed | Vite frontend production build completed. |
| `docker compose -f docker/docker-compose.local.yml config` | passed | Compose renders Vertex provider defaults, ADC bind mounts, Docker Local worker config, and `HEAD_DEVELOPER_STATE_STORE=file`. |
| Secret/env staging check | passed | No staged files; `.env.codex-phone-supervisor` exists locally, is ignored by `.gitignore`, and is not tracked/staged. Tracked secret/auth filename scan returned no credential/auth/token/key material. |

## GKE Job Codex home bundle prototype smoke on 2026-05-27 UTC

| Evidence | Result |
| --- | --- |
| Target project | `teamtiffy1729` |
| Cluster / namespace | `head-developer-workers` / `head-developer-workers` |
| Kubernetes Job / Pod | `hd-worker-8bbeb3fa` / `hd-worker-8bbeb3fa-6vpfv` |
| Worker image | `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:gke-job-amd64-20260527184320` |
| API image | `us-central1-docker.pkg.dev/teamtiffy1729/head-developer/api:gke-job-amd64-20260527190636` |
| Workload Identity | `head-developer-workers/head-developer-worker -> gke-worker-sa@teamtiffy1729.iam.gserviceaccount.com` |
| Codex bundle | `gs://teamtiffy1729-head-developer-artifacts/codex-auth/codex-vm-home-bundle.tgz` |
| Cloud Run callback URL/audience | `https://head-developer-api-jq6oo2ormq-uc.a.run.app` |
| Network | Cloud NAT detected: `head-developer-nat`; private nodes reported as `unknown` by the script |
| Codex login status | Pod log reported `Codex auth validated with method codex_home_bundle` |
| Codex command event | `84058570-a1d7-4492-be2b-cd61af1cd580` |
| Prompt nonce | `NONCE-GKE-CODEX-HOME-1779924298-8174` |
| Generated files | `index.html`, `styles.css`, `script.js`, `CODE_INDEX.md`, `FUNCTIONS.md`, `VARIABLES.md`, `STATE_MODEL.md`, `API_SURFACE.md`, `.head-developer/WORKER_HANDOFFS.md`, `.head-developer/VALIDATION.md` |
| Nonce file proof | `.head-developer/VALIDATION.md`, `.head-developer/WORKER_HANDOFFS.md`, `index.html` |
| Validation result | `completed` |
| Cleanup | Job deleted by worker label; remaining Jobs `0`, remaining Pods `0` |

Verification after GKE prototype/fix:

| Command | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | passed | TypeScript compile check passed after the GKE smoke and Firestore active Codex lock fix. |
| `npx tsx --test codex-phone-supervisor/tests/state-store.test.ts` | passed | 6 passed; covers Firestore duplicate active `codex exec` rejection. |
| `npm test` | passed | 151 passed, 1 skipped. |
| `npm run build` | passed | Vite frontend production build completed. |
| `docker compose -f docker/docker-compose.local.yml config` | passed | Compose config renders API, frontend, worker, Vertex provider defaults, and GKE prototype env keys. |

Notes:
- The first GKE smoke completed task validation but the script only searched command summaries/previews for the nonce; the smoke script now checks generated `/workspace` file contents before cleanup.
- A second rerun proved nonce files but exited before terminal task status; the smoke script now requires terminal `completed`/`failed` status before cleanup.
- The final run passed with terminal `completed` status, nonce file proof, command event evidence, and clean Job/Pod cleanup.

## Vertex/Gemini runtime supervisor verification on 2026-05-27 UTC

| Command | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | passed | TypeScript compile check passed after removing runtime mock provider selection and adding provider indicators. |
| `npx tsx --test codex-phone-supervisor/tests/agentic-planning.test.ts codex-phone-supervisor/tests/model-provider.test.ts codex-phone-supervisor/tests/config-failure.test.ts` | passed | Covers test-only deterministic double, runtime mock rejection, default Vertex provider, missing Vertex config error, and planner approval behavior. |
| `npm test` | passed | 141 passed, 1 skipped. |
| `npm run build` | passed | Vite frontend production build completed. |
| `docker compose -f docker/docker-compose.local.yml config` | passed | Compose config showed `SUPERVISOR_MODEL_PROVIDER: vertex` and Vertex env pass-through keys; no mock supervisor provider. |

Real Vertex planner smoke:

| Evidence | Result |
| --- | --- |
| Prompt | `Build a static SaaS dashboard with landing, login, dashboard, and settings.` |
| Provider | `vertex` |
| Provider indicators | `supervisor_model_provider=Vertex/Gemini`, `planner_model_provider=Vertex/Gemini`, `worker_code_model=Codex CLI` |
| Planner model | `vertex:gemini-2.5-flash` |
| Decision type | `propose_task_split` |
| Approval | `requires_user_approval=true`, `execution_allowed=false` |
| Worker recommendation | `recommended_worker_mode=docker_local`, `recommended_worker_count=2` |
| Proposed split | 6 tasks: setup/docs, landing page, auth pages, dashboard, settings, validation/review |
| Graphs/workers | `graphCount=0`; no approval was sent and no workers were launched |
| Chat response | Asked for approval and contained no raw JSON |

Runtime mock removal evidence:
- `.env.example` uses `SUPERVISOR_MODEL_PROVIDER=vertex`.
- `docker/docker-compose.local.yml` no longer sets `SUPERVISOR_MODEL_PROVIDER=mock`; it defaults to `${SUPERVISOR_MODEL_PROVIDER:-vertex}` and passes through Vertex env vars.
- Config validation rejects `SUPERVISOR_MODEL_PROVIDER=mock`.
- Missing Vertex env fails with `Vertex/Gemini supervisor is not configured. Set required GCP/Vertex env vars.`

## Agentic planning verification on 2026-05-27 UTC

| Command | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | passed | TypeScript compile check passed after planner/redaction/docs updates. |
| `npx tsx --test codex-phone-supervisor/tests/agentic-planning.test.ts` | passed | 2 tests passed. Covers parser validation/fallback, vague clarification, simple one-worker start, multi-worker proposal/approval, plan revision, GCP approval, risky deploy approval, flowchart planner nodes, and no raw JSON responses. |
| `npm test` | passed | 136 passed, 1 skipped. |
| `npm run build` | passed | Vite frontend production build completed. |
| `docker compose -f docker/docker-compose.local.yml config` | passed | Compose config renders API, frontend, and Docker Local worker services. Config references `.codex-worker-home`; no runtime smoke was started from this command. |

Conversation-only planner smoke:

| Evidence | Result |
| --- | --- |
| User prompt | `Build a static SaaS dashboard with landing, login, dashboard, and settings.` |
| Planner response | Summarized the requirement, proposed 2 `docker_local` workers, listed landing/login and dashboard/settings tasks, expected files, validation commands, and asked approval. |
| Before approval | `pending_action=approve_task_split`; task graph count remained `0`. |
| Approval prompt | `approve` |
| Approved graph | `task_graph_c2fbb5a8-c5af-4c12-a761-09787431d85e`, status `running`, `recommended_worker_count=2`, `execution_strategy=parallel_worktrees`, `approval_status=approved`. |
| Graph nodes | `Landing and login pages`; `Dashboard and settings pages`. |
| Output contracts | Landing/login required `index.html`, `login.html`, `styles/public.css`, `scripts/public.js`; dashboard/settings required `dashboard.html`, `settings.html`, `styles/app.css`, `scripts/app.js`; both had `docs_only_is_insufficient=true`. |
| Worker records | Two `docker_local` worker records moved to `running` with assigned task IDs. |
| Worker context | Context packets included the approved requirements summary, both approved plan task titles, and node-specific output contracts. |
| Event log | Included `planner.execution.routed`, `task_graph.created`, `multi_worker.plan.created`, `worker.created`, `worker.started`, `worker.assigned`, `task_graph.node.assigned`, and `multi_worker.execution.started`. |
| Flowchart | Included `requirement_summary`, `planner_decision`, `task_split_proposal`, `user_approval`, `approved_plan`, `execution_start`, and an edge from execution start to the task graph. |

Honest limitation: this was a conversation-only planner smoke, so it stopped after task graph creation and worker assignment. It did not run real Codex generation, file materialization, validation commands, or final summaries. The current real Docker Local materialization/validation evidence remains the earlier completed two-worker smoke `task_graph_cdc40b63-b53f-4779-805f-7249fa11e8e8`; GCP VM real Codex app build remains blocked on secure Codex auth.

## TestAppCleanup verification on 2026-05-26

| Command | Result | Notes |
| --- | --- | --- |
| `git status --short` | inspected before cleanup | Worktree already contained unrelated product deletions/modifications and untracked current product files; cleanup did not revert or modify those unrelated changes. |
| `rg` reference checks for generated app/smoke names | passed | Found only slug/anti-hardcoding test references, not dependencies on generated artifact directories. |
| `npm run typecheck` | passed | TypeScript compile check passed after cleanup. |
| `npm test` | passed | 117 passed, 1 skipped. The removed smoke artifacts were not required by tests. |
| `npm run build` | passed | Vite frontend build completed. |
| `docker compose -f docker/docker-compose.local.yml config` | passed | Compose config renders API, frontend, and worker services. |

Cleanup notes:
- Removed stale generated standalone app folders, prior acme Orbit smoke workspaces, the empty prior static SaaS smoke folder, root smoke screenshots, `data/smoke-artifacts/`, and stale repo-local `tmp/*-test-*` directories.
- Kept current/useful evidence: `static-saas-dashboard-shell-smoke-20260526231422/`, `static-saas-dashboard-shell-smoke-20260526231422.worktrees/`, and `codex-auth-docker-smoke-NONCE-CODEX-AUTH-DOCKER-20260526184728-548/`.
- Kept ambiguous local state and auth/browser history areas: `.codex-worker-home/`, `.playwright-mcp/`, `data/voice_agent.sqlite3`, `tmp/browser-flowchart/`, `tmp/browser-progress-smoke-61346/`, `tmp/codex-phone-supervisor-store/`, `tmp/codex-phone-supervisor-projects/`, and `tmp/manual-smoke/`.

## Main-thread verification on 2026-05-26

| Command | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | passed | TypeScript compile check passed after resolving duplicate `staticSaasShell` declaration. |
| `npx tsx --test codex-phone-supervisor/tests/completion-gate.test.ts codex-phone-supervisor/tests/app-output-validation.test.ts codex-phone-supervisor/tests/multi-worker.test.ts codex-phone-supervisor/tests/summary-truthfulness.test.ts` | passed | 12 tests passed. Covers completion gate, validation, worker context/prompt, and truthful summaries. |
| `npm test` | passed | 117 passed, 1 skipped with `--test-concurrency=1`. Serial execution is test determinism for backend subprocess health checks. |
| `npm run build` | passed | Vite frontend build completed. |
| `docker compose -f docker/docker-compose.local.yml config` | passed | Compose config renders API, frontend, and worker services including Docker Local Codex home bind mount. |

## Known failed attempt

`npm test` without serialized test concurrency previously produced 8 backend subprocess health failures (`fetch failed`) while the same files passed focused. This was test runner startup contention, not product runtime behavior. The package test script now runs the full suite serially.

## Deterministic materialization verification on 2026-05-26 / 2026-05-27 UTC

Static two-worker Docker Local smoke completed after the deterministic `files_to_write` materialization fix.

| Evidence | Result |
| --- | --- |
| Project | `project_4567a1bcc84c5617` |
| Task graph | `task_graph_cdc40b63-b53f-4779-805f-7249fa11e8e8`, status `completed` |
| Prompt | `Build a static SaaS dashboard shell with landing page, login page, dashboard page, and settings page. Static HTML/CSS/JS only. No billing. No backend. No package installs.` |
| Compose runtime | `docker-api-1`, `docker-frontend-1`, `docker-worker-1`, and `docker-worker-2` running |
| API health | `GET http://127.0.0.1:4317/health` returned `{"ok":true}` |

### Landing/login node

| Evidence | Result |
| --- | --- |
| Task | `task_bc1cbae7-9603-4a10-9f0e-42924ea906ae` |
| Worker | `worker_8d330b79-d3a2-4828-8000-61bc5b7564cd` |
| Worktree | `/workspace/static-saas-dashboard-shell-smoke-20260526201914.worktrees/landing-and-login-pages-bc1cbae7` |
| Codex command | `994d553d-4dc4-4842-a485-7d1a994acbeb`, exit `0` |
| Materializer command | `5aad22b0-d14e-419f-b090-af8100720ec5`, exit `0` |
| Validation command | `f36dd2a8-36fd-4a3d-8c40-cbf4e5920323`, `node --check scripts/public.js`, exit `0` |
| Required files present | `index.html`, `login.html`, `styles/public.css`, `scripts/public.js` |
| Completion gate | `passed` |

Materializer summary:

```text
created: index.html
created: login.html
created: styles/public.css
created: scripts/public.js
```

### Dashboard/settings node

| Evidence | Result |
| --- | --- |
| Task | `task_1e593c7d-41c8-4484-842b-7ca491f86111` |
| Worker | `worker_1671608b-935d-4c3c-b076-4d8fbab1a293` |
| Worktree | `/workspace/static-saas-dashboard-shell-smoke-20260526201914.worktrees/dashboard-and-settings-pages-1e593c7d` |
| Codex command | `6ba33662-ec58-42cf-97e9-db1a5b81def6`, exit `0` |
| Materializer command | `cb39cac0-f66f-4c34-b98a-10c1775e4207`, exit `0` |
| Validation command | `fe98667f-b5c9-416d-bf09-9992eee8252d`, `node --check scripts/app.js`, exit `0` |
| Required files present | `dashboard.html`, `settings.html`, `styles/app.css`, `scripts/app.js` |
| Completion gate | `passed` |

Materializer summary:

```text
created: dashboard.html
created: settings.html
created: styles/app.css
created: scripts/app.js
```

### Validation/review node

| Evidence | Result |
| --- | --- |
| Task | `task_e1c4e6aa-fb49-4ffe-b730-5ae8b6336269` |
| Worker | `worker_edb0d2f2-649e-44ff-8f80-07fd828303dd` |
| Materializer command | `7b350049-79fd-44a3-b5d1-e0163d453a40`, exit `0` |
| Output | `.head-developer/VALIDATION.md`, `.head-developer/WORKER_HANDOFFS.md` |

### Flowchart evidence

`GET /orchestrator/flowchart` returned:

- task graph node `task_graph:task_graph_cdc40b63-b53f-4779-805f-7249fa11e8e8` with status `completed`.
- worker nodes `worker:worker_8d330b79-d3a2-4828-8000-61bc5b7564cd` and `worker:worker_1671608b-935d-4c3c-b076-4d8fbab1a293`.
- Codex command nodes `command:994d553d-4dc4-4842-a485-7d1a994acbeb` and `command:6ba33662-ec58-42cf-97e9-db1a5b81def6`.
- materializer command nodes `command:5aad22b0-d14e-419f-b090-af8100720ec5` and `command:cb39cac0-f66f-4c34-b98a-10c1775e4207`.
- validation command nodes `command:f36dd2a8-36fd-4a3d-8c40-cbf4e5920323` and `command:fe98667f-b5c9-416d-bf09-9992eee8252d`.
- edges from task graph nodes to workers, workers to commands, commands to artifacts, and tasks to summaries.

### Honest limitations

- The two app workers produced app files and validation passed. The validation/review node only updated docs, which is allowed because its output contract is documentation/validation, not app files.
- This smoke proves Docker Local two-worker execution with materialized Codex output. It does not prove GCP Codex auth or public deployment.

## CleanupDocs verification after materialization docs consolidation

| Command | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` | passed | TypeScript compile check passed after docs consolidation. |
| `npm test` | passed | 120 passed, 1 skipped. |
| `npm run build` | passed | Vite frontend production build completed. |
| `docker compose -f docker/docker-compose.local.yml config` | passed | Compose config renders API, frontend, and Docker Local worker services with host-visible `.codex-worker-home` bind mount. |

Docs freshness result: `docs_fresh=true` for the deterministic materialization fix and fresh two-worker smoke evidence. Remaining docs risk is future parser behavior: `extractFinalWorkerJson` has smoke evidence and should get focused parser unit tests if it is changed.
