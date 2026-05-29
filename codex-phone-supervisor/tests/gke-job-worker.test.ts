import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tsxLoader = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;

function baseEnv(extra: Record<string, string> = {}) {
  const root = process.cwd();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "gke-job-worker-test-"));
  return {
    ...process.env,
    CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1",
    CODEX_PHONE_SUPERVISOR_STORE_DIR: store,
    CODEX_PHONE_SUPERVISOR_HOST: "127.0.0.1",
    CODEX_PHONE_SUPERVISOR_PORT: "0",
    CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS: "http://127.0.0.1:4318",
    CODEX_PHONE_SUPERVISOR_CODEX_COMMAND: process.execPath,
    CODEX_PHONE_SUPERVISOR_CODEX_HOME: root,
    CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH: root,
    CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT: root,
    CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS: root,
    CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
    CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
    CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
    CODEX_PHONE_SUPERVISOR_TEST_MODE: "1",
    CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL: "deterministic",
    CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
    CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
    SUPERVISOR_MODEL_PROVIDER: "codex_cli",
    TWILIO_SMS_ENABLED: "0",
    TWILIO_VOICE_ENABLED: "0",
    TWILIO_VALIDATE_SIGNATURES: "0",
    TWILIO_AUTH_TOKEN: "",
    GCP_PROJECT_ID: "teamtiffy1729",
    GCP_REGION: "us-central1",
    HEAD_DEVELOPER_API_CALLBACK_URL: "https://head-developer-api.example.run.app",
    HEAD_DEVELOPER_WORKER_IMAGE_URI: "us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:test",
    HEAD_DEVELOPER_CODEX_AUTH_METHOD: "codex_home_bundle",
    HEAD_DEVELOPER_CODEX_HOME: "/codex-home",
    HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI: "gs://teamtiffy1729-head-developer-artifacts/codex-auth/codex-vm-home-bundle.tgz",
    HEAD_DEVELOPER_GKE_CLUSTER_NAME: "head-developer-workers",
    HEAD_DEVELOPER_GKE_LOCATION: "us-central1",
    HEAD_DEVELOPER_GKE_NAMESPACE: "head-developer-workers",
    HEAD_DEVELOPER_GKE_KSA: "head-developer-worker",
    HEAD_DEVELOPER_GKE_GSA: "gke-worker-sa@teamtiffy1729.iam.gserviceaccount.com",
    HEAD_DEVELOPER_GKE_JOB_DRY_RUN: "1",
    ...extra,
  };
}

function runSnippet(source: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", tsxLoader, "-e", source], {
    cwd: process.cwd(),
    env: baseEnv(extraEnv),
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("gke_job worker mode config is accepted", () => {
  const configUrl = pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/config.ts")).href;
  const result = runSnippet(
    `const { config } = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ workerMode: config.orchestrator.workerMode, defaultWorkerType: config.orchestrator.defaultWorkerType, maxGkeJobWorkers: config.orchestrator.maxGkeJobWorkers }));`,
    { WORKER_MODE: "gke_job", DEFAULT_WORKER_MODE: "gke_job", MAX_GKE_JOB_WORKERS: "2" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    workerMode: "gke_job",
    defaultWorkerType: "gke_job",
    maxGkeJobWorkers: 2,
  });
});

test("GKE Job manifest includes required labels, env vars, callback auth, and no API-key secrets", () => {
  const workersUrl = pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/workers.ts")).href;
  const result = runSnippet(`
    const { buildGkeJobManifest } = await import(${JSON.stringify(workersUrl)});
    const worker = {
      worker_id: "worker_12345678-1234-1234-1234-123456789abc",
      type: "gke_job",
      status: "starting",
      image_uri: "us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:test",
      project_id: "project_demo",
      task_id: "task_demo",
      heartbeat_at: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    console.log(JSON.stringify(buildGkeJobManifest(worker)));
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(result.stdout) as {
    metadata: { namespace: string; labels: Record<string, string> };
    spec: { backoffLimit: number; ttlSecondsAfterFinished: number; podFailurePolicy?: { rules: Array<{ action: string; onPodConditions?: Array<{ type: string }> }> }; template: { spec: { serviceAccountName: string; containers: Array<{ env: Array<{ name: string; value?: string }>; volumeMounts: Array<{ mountPath: string }> }>; volumes: Array<{ name: string; emptyDir?: Record<string, never> }> } } };
  };
  assert.equal(manifest.metadata.namespace, "head-developer-workers");
  assert.equal(manifest.metadata.labels.app, "head-developer");
  assert.equal(manifest.metadata.labels.worker_id, "worker_12345678-1234-1234-1234-123456789abc".slice(0, 63));
  assert.equal(manifest.metadata.labels.task_id, "task_demo");
  assert.equal(manifest.metadata.labels.project_id, "project_demo");
  assert.equal(manifest.spec.backoffLimit, 0);
  assert.equal(manifest.spec.podFailurePolicy?.rules[0]?.action, "Ignore");
  assert.equal(manifest.spec.podFailurePolicy?.rules[0]?.onPodConditions?.[0]?.type, "DisruptionTarget");
  assert.ok(manifest.spec.ttlSecondsAfterFinished > 0);
  assert.equal(manifest.spec.template.spec.serviceAccountName, "head-developer-worker");
  const container = manifest.spec.template.spec.containers[0];
  const envNames = new Set(container.env.map((item) => item.name));
  for (const name of [
    "HEAD_DEVELOPER_WORKER_ID",
    "HEAD_DEVELOPER_WORKER_TYPE",
    "HEAD_DEVELOPER_WORKER_POLL",
    "HEAD_DEVELOPER_TASK_ID",
    "HEAD_DEVELOPER_PROJECT_ID",
    "WORKER_CALLBACK_URL",
    "WORKER_CALLBACK_AUTH",
    "WORKER_CALLBACK_AUDIENCE",
    "HEAD_DEVELOPER_CODEX_AUTH_METHOD",
    "HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI",
    "CODEX_HOME",
  ]) {
    assert.ok(envNames.has(name), `${name} should be present`);
  }
  assert.equal(container.env.find((item) => item.name === "WORKER_CALLBACK_AUTH")?.value, "google_id_token");
  assert.equal(container.env.find((item) => item.name === "HEAD_DEVELOPER_WORKER_POLL")?.value, "0");
  assert.equal(container.env.find((item) => item.name === "HEAD_DEVELOPER_CODEX_AUTH_METHOD")?.value, "codex_home_bundle");
  assert.deepEqual(container.volumeMounts.map((item) => item.mountPath).sort(), ["/codex-home", "/state", "/workspace"]);
  assert.deepEqual(manifest.spec.template.spec.volumes.map((item) => item.name).sort(), ["codex-home", "state", "workspace"]);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /HEAD_DEVELOPER_CODEX_API_KEY_SECRET|OPENAI_API_KEY|sk-[A-Za-z0-9]/);
});

test("GKE Job cleanup uses a worker label selector and scripts are present", () => {
  const workers = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "workers.ts"), "utf8");
  assert.match(workers, /kubectl", \["-n", config\.gke\.namespace/);
  assert.match(workers, /"delete", "job", "-l", selector, "--ignore-not-found=true"/);
  assert.match(workers, /gkeJobLabelSelector/);
  assert.match(workers, /worker\.gke_job\.completed/);

  const workerEntry = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "worker-entry.ts"), "utf8");
  assert.match(workerEntry, /restoreProjectArtifacts/);
  assert.match(workerEntry, /persistProjectArtifacts/);
  assert.match(workerEntry, /\/artifacts\/files/);
  assert.match(workerEntry, /workerType === "gcp_vm" \|\| workerType === "gke_job"/);
  assert.match(workerEntry, /process\.exit\(0\)/);

  const script = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "run-gke-job-codex-home-smoke.sh"), "utf8");
  assert.match(script, /gcloud container clusters create-auto/);
  assert.match(script, /roles\/iam\.workloadIdentityUser/);
  assert.match(script, /roles\/run\.invoker/);
  assert.match(script, /roles\/storage\.objectViewer/);
  assert.match(script, /roles\/artifactregistry\.reader/);
  assert.match(script, /roles\/container\.developer/);
  assert.match(script, /create rolebinding head-developer-api-job-admin/);
  assert.match(script, /worker_type:"gke_job"/);
  assert.match(script, /NONCE-GKE-CODEX-HOME/);
  assert.doesNotMatch(script, /HEAD_DEVELOPER_CODEX_API_KEY_SECRET|secret_manager_api_key|printenv|cat .*auth\.json/i);
});

test("gke_job task graph assignments use pod-local workspace instead of API-side worktrees", () => {
  const projectStoreUrl = pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/project-store.ts")).href;
  const coordinatorUrl = pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/multi-worker-coordinator.ts")).href;
  const storeUrl = pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/store.ts")).href;
  const result = runSnippet(`
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { projectRecordForWorkspace, upsertProject } = await import(${JSON.stringify(projectStoreUrl)});
    const { multiWorkerCoordinator } = await import(${JSON.stringify(coordinatorUrl)});
    const { getTask, listWorkerContextPackets, listWorkers } = await import(${JSON.stringify(storeUrl)});
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gke-graph-workspace-"));
    const project = projectRecordForWorkspace(workspace);
    project.display_name = "GKE graph assignment";
    upsertProject(project);
    const decision = {
      complexity: "complex",
      should_split: true,
      recommended_worker_count: 2,
      parallelizable: true,
      approval_needed: false,
      reason: "test",
      suggested_subtasks: [
        { title: "Backend", goal: "Create backend server.", dependencies: [], outputs_expected: ["Backend"], files_expected: ["server.js"] },
        { title: "Frontend", goal: "Create frontend.", dependencies: [], outputs_expected: ["Frontend"], files_expected: ["public/index.html", "public/app.js"] }
      ],
      dependency_graph: []
    };
    const graph = multiWorkerCoordinator.createTaskGraph(project, "Build a full-stack app.", "gke_job", { decision });
    const started = await multiWorkerCoordinator.startReadyWork(graph.task_graph_id, "gke_job", 2);
    const contexts = listWorkerContextPackets({ taskGraphId: graph.task_graph_id });
    console.log(JSON.stringify({
      assignments: started.assignments.length,
      nodeWorktrees: started.assignments.map((item) => item.node.worktree_path),
      taskWorktrees: started.assignments.map((item) => getTask(item.task.task_id)?.worktree_path),
      branches: started.assignments.map((item) => getTask(item.task.task_id)?.branch_name ?? null),
      contextRoots: contexts.map((item) => item.allowed_roots),
      dryRunWorkers: listWorkers().every((worker) => worker.type === "gke_job" && worker.metadata?.dry_run === true)
    }));
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as {
    assignments: number;
    nodeWorktrees: string[];
    taskWorktrees: string[];
    branches: Array<string | null>;
    contextRoots: string[][];
    dryRunWorkers: boolean;
  };
  assert.equal(payload.assignments, 2);
  assert.deepEqual(payload.nodeWorktrees, ["/workspace", "/workspace"]);
  assert.deepEqual(payload.taskWorktrees, ["/workspace", "/workspace"]);
  assert.deepEqual(payload.branches, [null, null]);
  assert.deepEqual(payload.contextRoots, [["/workspace"], ["/workspace"]]);
  assert.equal(payload.dryRunWorkers, true);
});

test("gke_job task graph creation skips synchronous API-side git prep", () => {
  const projectStoreUrl = pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/project-store.ts")).href;
  const coordinatorUrl = pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/multi-worker-coordinator.ts")).href;
  const storeUrl = pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/store.ts")).href;
  const result = runSnippet(`
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { projectRecordForWorkspace, upsertProject, getProject } = await import(${JSON.stringify(projectStoreUrl)});
    const { multiWorkerCoordinator } = await import(${JSON.stringify(coordinatorUrl)});
    const { listCommandEvents } = await import(${JSON.stringify(storeUrl)});
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "gke-graph-create-workspace-"));
    const project = projectRecordForWorkspace(workspace);
    project.display_name = "GKE graph creation";
    upsertProject(project);
    const created = await multiWorkerCoordinator.createAndMaybeStart(project, "Build a full-stack app.", "gke_job", { autoStart: false });
    const storedProject = getProject(project.project_id);
    console.log(JSON.stringify({
      graphStatus: created.graph.status,
      graphNodes: created.graph.nodes.length,
      assignments: created.assignments.length,
      gitInitialized: Boolean(storedProject?.git_initialized),
      latestCommitRecorded: Boolean(storedProject?.latest_commit_hash),
      commandEvents: listCommandEvents({ projectId: project.project_id }).length
    }));
  `);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim()) as {
    graphStatus: string;
    graphNodes: number;
    assignments: number;
    gitInitialized: boolean;
    latestCommitRecorded: boolean;
    commandEvents: number;
  };
  assert.ok(["queued", "proposed"].includes(payload.graphStatus));
  assert.ok(payload.graphNodes > 0);
  assert.equal(payload.assignments, 0);
  assert.equal(payload.gitInitialized, false);
  assert.equal(payload.latestCommitRecorded, false);
  assert.equal(payload.commandEvents, 0);
});
