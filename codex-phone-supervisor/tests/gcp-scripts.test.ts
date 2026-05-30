import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tsxLoader = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;

test("GCP readiness script fails clearly when required env is missing", () => {
  const result = spawnSync("bash", ["infra/gcp/readiness.sh"], {
    cwd: process.cwd(),
    env: {},
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Missing required env: GCP_PROJECT_ID/);
});

test("cloud orchestrator GCP scripts are present and executable", () => {
  const required = [
    "enable-apis.sh",
    "create-artifact-registry.sh",
    "create-service-accounts.sh",
    "create-storage.sh",
    "create-pubsub-or-tasks.sh",
    "create-firestore-or-db.sh",
    "build-and-push-images.sh",
    "deploy-cloud-run.sh",
    "create-codex-vm-home-bundle.sh",
    "create-worker-vm-smoke.sh",
    "run-gke-job-codex-home-smoke.sh",
    "run-codex-home-bundle-smoke.sh",
    "run-codex-auth-smoke.sh",
    "cleanup-workers.sh",
    "list-workers.sh",
  ];
  for (const script of required) {
    const scriptPath = path.join(process.cwd(), "scripts", "gcp", script);
    const stat = fs.statSync(scriptPath);
    assert.ok(stat.isFile(), `${script} should exist`);
    assert.ok((stat.mode & 0o111) !== 0, `${script} should be executable`);
  }
});

test("GCP scripts wire Codex home bundle auth without broad IAM or public Cloud Run", () => {
  const createSa = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "create-service-accounts.sh"), "utf8");
  assert.match(createSa, /HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET/);
  assert.match(createSa, /roles\/secretmanager\.secretAccessor/);
  assert.match(createSa, /roles\/storage\.objectViewer/);
  assert.doesNotMatch(createSa, /roles\/owner|roles\/editor/i);

  const deploy = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "deploy-cloud-run.sh"), "utf8");
  assert.match(deploy, /--no-allow-unauthenticated/);
  assert.match(deploy, /HEAD_DEVELOPER_CODEX_AUTH_METHOD/);
  assert.match(deploy, /HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET/);
  assert.match(deploy, /HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI/);
  assert.match(deploy, /SUPERVISOR_MODEL_PROVIDER/);
  assert.match(deploy, /DEFAULT_WORKER_MODE/);
  assert.match(deploy, /HEAD_DEVELOPER_STATE_STORE/);
  assert.match(deploy, /FIRESTORE_PROJECT_ID/);
  assert.match(deploy, /FIRESTORE_COLLECTION_PREFIX/);
  assert.match(deploy, /FIRESTORE_STATE_OPERATION_TIMEOUT_MS/);
  assert.match(deploy, /HEAD_DEVELOPER_CLOUD_RUN_MIN_INSTANCES:-1/);
  assert.match(deploy, /HEAD_DEVELOPER_CLOUD_RUN_MAX_INSTANCES:-5/);
  assert.match(deploy, /HEAD_DEVELOPER_CLOUD_RUN_CONCURRENCY:-1/);
  assert.match(deploy, /--min-instances="\$\{MIN_INSTANCES\}"/);
  assert.match(deploy, /--max-instances="\$\{MAX_INSTANCES\}"/);
  assert.match(deploy, /--concurrency="\$\{CONCURRENCY\}"/);

  const buildImages = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "build-and-push-images.sh"), "utf8");
  assert.match(buildImages, /npm --prefix "\$\{ROOT_DIR\}" run build/);
  assert.match(buildImages, /docker_helper_configured/);
  assert.match(buildImages, /Timed out configuring Docker credential helper/);
  assert.match(buildImages, /HEAD_DEVELOPER_IMAGE_PLATFORM/);
  assert.match(buildImages, /linux\/amd64/);
  assert.match(buildImages, /docker buildx build --platform "\$\{IMAGE_PLATFORM\}"/);
  assert.match(buildImages, /Dockerfile\.api/);
  assert.match(buildImages, /Dockerfile\.worker/);
  assert.match(buildImages, /HEAD_DEVELOPER_API_IMAGE_URI/);
  assert.match(buildImages, /HEAD_DEVELOPER_WORKER_IMAGE_URI/);

  const apiDockerfile = fs.readFileSync(path.join(process.cwd(), "docker", "Dockerfile.api"), "utf8");
  assert.match(apiDockerfile, /google-cloud-cli/);

  const gitignore = fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
  assert.match(gitignore, /^\.codex-vm-home\/$/m);

  const dockerignore = fs.readFileSync(path.join(process.cwd(), ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\.env\.\*$/m);
  assert.match(dockerignore, /^\.codex-worker-home\/$/m);
  assert.match(dockerignore, /^\.codex-vm-home\/$/m);
  assert.match(dockerignore, /^tmp\/$/m);

  const bundle = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "create-codex-vm-home-bundle.sh"), "utf8");
  assert.match(bundle, /CODEX_HOME=.*codex login status/);
  assert.match(bundle, /codex exec/);
  assert.match(bundle, /NONCE-CODEX-VM-HOME/);
  assert.match(bundle, /gcloud secrets versions add|gcloud storage cp/);
  assert.match(bundle, /rm -f "\$\{BUNDLE_FILE\}"/);
  assert.doesNotMatch(bundle, /cat .*auth\.json|printenv/i);

  const homeSmoke = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "run-codex-home-bundle-smoke.sh"), "utf8");
  assert.match(homeSmoke, /NONCE-GCP-CODEX-HOME/);
  assert.match(homeSmoke, /codex_home_bundle/);
  assert.match(homeSmoke, /PROJECT_API_TIMEOUT_SECONDS="\$\{PROJECT_API_TIMEOUT_SECONDS:-30\}"/);
  assert.match(homeSmoke, /--max-time "\$\{timeout\}"/);
  assert.match(homeSmoke, /POST \/projects/);
  assert.doesNotMatch(homeSmoke, /api GET \/projects/);
  assert.match(homeSmoke, /get-serial-port-output/);
  assert.match(homeSmoke, /VM .* was not created within/);
  assert.match(homeSmoke, /stdout_preview,c\.stderr_preview/);
  assert.match(homeSmoke, /HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET|HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI/);
  assert.doesNotMatch(homeSmoke, /HEAD_DEVELOPER_CODEX_API_KEY_SECRET|secret_manager_api_key/);
  assert.doesNotMatch(homeSmoke, /printenv|cat .*auth\.json/i);

  const gkeSmoke = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "run-gke-job-codex-home-smoke.sh"), "utf8");
  assert.match(gkeSmoke, /NONCE-GKE-CODEX-HOME/);
  assert.match(gkeSmoke, /codex_home_bundle/);
  assert.match(gkeSmoke, /gcloud container clusters create-auto/);
  assert.match(gkeSmoke, /roles\/iam\.workloadIdentityUser/);
  assert.match(gkeSmoke, /roles\/run\.invoker/);
  assert.match(gkeSmoke, /roles\/storage\.objectViewer/);
  assert.match(gkeSmoke, /worker_type:"gke_job"/);
  assert.match(gkeSmoke, /kubectl delete job -n "\$\{GKE_NAMESPACE\}"/);
  assert.doesNotMatch(gkeSmoke, /HEAD_DEVELOPER_CODEX_API_KEY_SECRET|secret_manager_api_key/);
  assert.doesNotMatch(gkeSmoke, /printenv|cat .*auth\.json/i);

  const smoke = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "run-codex-auth-smoke.sh"), "utf8");
  assert.match(smoke, /NONCE-GCP-CODEX-AUTH/);
  assert.match(smoke, /secret_manager_api_key/);
  assert.match(smoke, /SMOKE_API_BEARER_TOKEN/);
  assert.doesNotMatch(smoke, /printenv|cat .*auth\.json/i);
});

test("GCP worker VM smokes use a container-ready VM image by default", () => {
  const safeSmoke = fs.readFileSync(path.join(process.cwd(), "scripts", "smoke", "gcp-vm-safe-command-smoke"), "utf8");
  assert.match(safeSmoke, /cos-stable/);
  assert.match(safeSmoke, /cos-cloud/);
  assert.match(safeSmoke, /--image-family/);
  assert.match(safeSmoke, /HOME=\/tmp\/cos-docker-home/);
  assert.match(safeSmoke, /DOCKER_CONFIG=\/tmp\/cos-docker-home\/\.docker/);
  assert.match(safeSmoke, /Docker is required on the worker VM image/);

  const vmSmoke = fs.readFileSync(path.join(process.cwd(), "scripts", "gcp", "create-worker-vm-smoke.sh"), "utf8");
  assert.match(vmSmoke, /cos-stable/);
  assert.match(vmSmoke, /cos-cloud/);
  assert.match(vmSmoke, /--image-family/);
  assert.match(vmSmoke, /HOME=\/tmp\/cos-docker-home/);
  assert.match(vmSmoke, /DOCKER_CONFIG=\/tmp\/cos-docker-home\/\.docker/);
});

test("GCP VM codex_home_bundle auth fails clearly when bundle source is missing", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "codex-phone-supervisor/backend/src/worker-entry.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HEAD_DEVELOPER_WORKER_TYPE: "gcp_vm",
        HEAD_DEVELOPER_WORKER_POLL: "1",
        HEAD_DEVELOPER_CODEX_AUTH_METHOD: "codex_home_bundle",
        HEAD_DEVELOPER_CODEX_HOME: path.join(process.cwd(), "tmp", "missing-bundle-codex-home"),
        CODEX_HOME: path.join(process.cwd(), "tmp", "missing-bundle-codex-home"),
        WORKER_CALLBACK_URL: "",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Set HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET or HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI/);
  assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /auth\.json|OPENAI_API_KEY|sk-/i);
});

test("worker Codex exec allows non-git VM workspaces", () => {
  const workerEntry = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "worker-entry.ts"), "utf8");
  assert.match(workerEntry, /"--skip-git-repo-check"/);
  assert.match(workerEntry, /"-s",\s*"workspace-write"/);
  assert.match(workerEntry, /hasGitRepository \? "git" : "node"/);
  assert.match(workerEntry, /\? \["status", "--short", "\."\]/);
  assert.match(workerEntry, /: \["--version"\]/);
  assert.match(workerEntry, /fs\.existsSync\(path\.join\(projectWorkspace, "\.git"\)\)/);
});
