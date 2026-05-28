import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { appendOrchestratorEvent, getOrchestratorSettings, getWorker, listWorkers, upsertTask, upsertWorker, getTask } from "./store.js";
import type { CommandEventRecord, TaskRecord, WorkerRecord, WorkerType } from "./types.js";

export interface WorkerRuntimeMetadata {
  task_id?: string;
  project_id?: string;
  worker_type?: WorkerType;
  actual_worker_mode?: WorkerType;
  recorded_image_uri?: string;
  image_uri?: string;
  actual_worker_image_uri?: string;
  actual_image_uri?: string;
  runtime_image_uri?: string;
  actual_worker_image_digest?: string;
  actual_image_digest?: string;
  image_digest?: string;
  runtime_image_digest?: string;
  recorded_vm_name?: string;
  actual_vm_name?: string;
  vm_name?: string;
  runtime_vm_name?: string;
  machine_type?: string;
  startup_attempt_id?: string;
  run_attempt_id?: string;
  container_started_at?: string;
  worker_runtime_version?: string;
  codex_home?: string;
  codex_home_host_path?: string;
  codex_history_sessions_path?: string;
  codex_auth_method?: string;
  codex_auth_secret_resource?: string;
  codex_auth_validated_at?: string;
  codex_auth_validation_status?: "validated" | "not_configured" | "failed";
  docker_container_id?: string;
  docker_container_name?: string;
}

export interface WorkerManager {
  createWorker(task_id: string, project_id: string, worker_type: WorkerType): Promise<WorkerRecord>;
  assignTask(worker_id: string, task_id: string): Promise<WorkerRecord>;
  getWorker(worker_id: string): Promise<WorkerRecord | null>;
  stopWorker(worker_id: string): Promise<WorkerRecord>;
  deleteWorker(worker_id: string): Promise<WorkerRecord>;
  listActiveWorkers(): Promise<WorkerRecord[]>;
  enforceWorkerLimits(): Promise<void>;
  handleHeartbeat(worker_id: string, runtime?: WorkerRuntimeMetadata): Promise<WorkerRecord>;
  handleWorkerEvent(event: CommandEventRecord): Promise<void>;
  handleTaskResult(result: { task_id: string; status: TaskRecord["status"]; summary?: string; next_steps?: string[] }): Promise<TaskRecord | null>;
}

function expiresAt() {
  return new Date(Date.now() + config.orchestrator.maxWorkerLifetimeMs).toISOString();
}

function baseWorker(task_id: string, project_id: string, worker_type: WorkerType): WorkerRecord {
  const now = new Date().toISOString();
  const imageUri = config.orchestrator.workerImageUri || "local-dev-worker";
  return {
    worker_id: `worker_${randomUUID()}`,
    type: worker_type,
    status: "starting",
    image_uri: imageUri,
    recorded_image_uri: imageUri,
    project_id,
    task_id,
    heartbeat_at: null,
    created_at: now,
    expires_at: expiresAt(),
  };
}

function optionalString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function digestFromImageRef(imageUri: string | undefined) {
  const digest = imageUri?.match(/@sha256:[a-f0-9]+$/i)?.[0];
  return digest ? digest.slice(1) : undefined;
}

function applyRuntimeMetadata(worker: WorkerRecord, runtime: WorkerRuntimeMetadata = {}) {
  const now = new Date().toISOString();
  const recordedImageUri = optionalString(runtime.recorded_image_uri) ?? worker.recorded_image_uri ?? worker.image_uri;
  const actualImageUri =
    optionalString(runtime.actual_image_uri) ??
    optionalString(runtime.actual_worker_image_uri) ??
    optionalString(runtime.runtime_image_uri) ??
    optionalString(runtime.image_uri);
  const actualDigest =
    optionalString(runtime.actual_image_digest) ??
    optionalString(runtime.actual_worker_image_digest) ??
    optionalString(runtime.runtime_image_digest) ??
    optionalString(runtime.image_digest) ??
    digestFromImageRef(actualImageUri);
  const recordedVmName = optionalString(runtime.recorded_vm_name) ?? worker.recorded_vm_name ?? worker.vm_name;
  const actualVmName =
    optionalString(runtime.actual_vm_name) ??
    optionalString(runtime.runtime_vm_name) ??
    optionalString(runtime.vm_name);
  const actualWorkerMode = runtime.actual_worker_mode ?? runtime.worker_type ?? worker.type;
  const machineType = optionalString(runtime.machine_type);
  const startupAttemptId = optionalString(runtime.startup_attempt_id);
  const runAttemptId = optionalString(runtime.run_attempt_id) ?? startupAttemptId;
  const containerStartedAt = optionalString(runtime.container_started_at);
  const workerRuntimeVersion = optionalString(runtime.worker_runtime_version);
  const codexHome = optionalString(runtime.codex_home);
  const codexHomeHostPath = optionalString(runtime.codex_home_host_path);
  const codexHistorySessionsPath = optionalString(runtime.codex_history_sessions_path);
  const codexAuthMethod = optionalString(runtime.codex_auth_method);
  const codexAuthSecretResource = optionalString(runtime.codex_auth_secret_resource);
  const codexAuthValidatedAt = optionalString(runtime.codex_auth_validated_at);
  const codexAuthValidationStatus = runtime.codex_auth_validation_status;
  const dockerContainerId = optionalString(runtime.docker_container_id);
  const dockerContainerName = optionalString(runtime.docker_container_name);
  const taskId = optionalString(runtime.task_id);
  const projectId = optionalString(runtime.project_id);

  if (taskId) worker.task_id = taskId;
  if (projectId) worker.project_id = projectId;
  if (!worker.recorded_image_uri) worker.recorded_image_uri = recordedImageUri;
  if (actualImageUri) {
    worker.actual_image_uri = actualImageUri;
    worker.runtime_image_uri = actualImageUri;
  }
  if (actualDigest) {
    worker.actual_image_digest = actualDigest;
    worker.runtime_image_digest = actualDigest;
  }
  if (recordedVmName && !worker.recorded_vm_name) worker.recorded_vm_name = recordedVmName;
  if (actualVmName) {
    worker.actual_vm_name = actualVmName;
    worker.runtime_vm_name = actualVmName;
    worker.vm_name = actualVmName;
  }
  if (actualWorkerMode) worker.actual_worker_mode = actualWorkerMode;
  if (machineType) worker.machine_type = machineType;
  if (startupAttemptId) worker.startup_attempt_id = startupAttemptId;
  if (runAttemptId) worker.run_attempt_id = runAttemptId;
  if (containerStartedAt) worker.container_started_at = containerStartedAt;
  if (workerRuntimeVersion) worker.worker_runtime_version = workerRuntimeVersion;
  if (codexHome) worker.codex_home = codexHome;
  if (codexHomeHostPath) worker.codex_home_host_path = codexHomeHostPath;
  if (codexHistorySessionsPath) worker.codex_history_sessions_path = codexHistorySessionsPath;
  if (codexAuthMethod) worker.codex_auth_method = codexAuthMethod;
  if (codexAuthSecretResource) worker.codex_auth_secret_resource = codexAuthSecretResource;
  if (codexAuthValidatedAt) worker.codex_auth_validated_at = codexAuthValidatedAt;
  if (codexAuthValidationStatus) worker.codex_auth_validation_status = codexAuthValidationStatus;
  if (dockerContainerId) worker.docker_container_id = dockerContainerId;
  if (dockerContainerName) worker.docker_container_name = dockerContainerName;
  if (actualImageUri || actualDigest || actualVmName || actualWorkerMode || machineType || startupAttemptId || runAttemptId || containerStartedAt || workerRuntimeVersion || codexHome || codexHomeHostPath || codexHistorySessionsPath || codexAuthMethod || codexAuthSecretResource || codexAuthValidatedAt || codexAuthValidationStatus || dockerContainerId || dockerContainerName) {
    worker.last_runtime_report_at = now;
    worker.runtime_metadata_updated_at = now;
    worker.metadata_verified_from_runtime = true;
    worker.metadata = {
      ...(worker.metadata ?? {}),
      runtime: {
        actual_worker_mode: actualWorkerMode ?? worker.actual_worker_mode ?? worker.type,
        recorded_image_uri: worker.recorded_image_uri ?? worker.image_uri,
        actual_image_uri: actualImageUri ?? worker.actual_image_uri ?? null,
        actual_image_digest: actualDigest ?? worker.actual_image_digest ?? null,
        actual_vm_name: actualVmName ?? worker.actual_vm_name ?? null,
        machine_type: machineType ?? worker.machine_type ?? null,
        startup_attempt_id: startupAttemptId ?? worker.startup_attempt_id ?? null,
        run_attempt_id: runAttemptId ?? worker.run_attempt_id ?? null,
        container_started_at: containerStartedAt ?? worker.container_started_at ?? null,
        worker_runtime_version: workerRuntimeVersion ?? worker.worker_runtime_version ?? null,
        codex_home: codexHome ?? worker.codex_home ?? null,
        codex_home_host_path: codexHomeHostPath ?? worker.codex_home_host_path ?? null,
        codex_history_sessions_path: codexHistorySessionsPath ?? worker.codex_history_sessions_path ?? null,
        codex_auth_method: codexAuthMethod ?? worker.codex_auth_method ?? null,
        codex_auth_secret_resource: codexAuthSecretResource ?? worker.codex_auth_secret_resource ?? null,
        codex_auth_validated_at: codexAuthValidatedAt ?? worker.codex_auth_validated_at ?? null,
        codex_auth_validation_status: codexAuthValidationStatus ?? worker.codex_auth_validation_status ?? null,
        docker_container_id: dockerContainerId ?? worker.docker_container_id ?? null,
        docker_container_name: dockerContainerName ?? worker.docker_container_name ?? null,
        reported_at: now,
      },
      image_mismatch: Boolean((actualImageUri ?? worker.actual_image_uri) && (actualImageUri ?? worker.actual_image_uri) !== (worker.recorded_image_uri ?? worker.image_uri)),
      vm_name_mismatch: Boolean((actualVmName ?? worker.actual_vm_name) && worker.recorded_vm_name && (actualVmName ?? worker.actual_vm_name) !== worker.recorded_vm_name),
    };
  }
  return worker;
}

export class LocalWorkerManager implements WorkerManager {
  protected managedType: WorkerType = "local";

  async createWorker(task_id: string, project_id: string, worker_type: WorkerType = "local") {
    const worker = baseWorker(task_id, project_id, worker_type);
    worker.status = "idle";
    upsertWorker(worker);
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: worker.worker_id,
      type: "worker.created",
      message: `Created ${worker.type} worker ${worker.worker_id}.`,
      data: worker,
    });
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: worker.worker_id,
      type: "worker.started",
      message: `${worker.type} worker ${worker.worker_id} is ${worker.status}.`,
      data: worker,
    });
    return worker;
  }

  async assignTask(worker_id: string, task_id: string) {
    const worker = getWorker(worker_id);
    if (!worker) throw new Error(`Worker not found: ${worker_id}`);
    worker.task_id = task_id;
    worker.status = "running";
    upsertWorker(worker);
    const task = getTask(task_id);
    if (task) {
      task.worker_id = worker_id;
      task.status = "running";
      task.updated_at = new Date().toISOString();
      upsertTask(task);
    }
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: worker.worker_id,
      type: "worker.assigned",
      message: `Assigned task ${task_id} to worker ${worker_id}.`,
    });
    return worker;
  }

  async getWorker(worker_id: string) {
    return getWorker(worker_id);
  }

  async stopWorker(worker_id: string) {
    const worker = getWorker(worker_id);
    if (!worker) throw new Error(`Worker not found: ${worker_id}`);
    worker.status = "stopped";
    upsertWorker(worker);
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: worker.worker_id,
      type: "worker.stopped",
      message: `Stopped worker ${worker_id}.`,
    });
    return worker;
  }

  async deleteWorker(worker_id: string) {
    const worker = await this.stopWorker(worker_id);
    worker.status = "expired";
    upsertWorker(worker);
    return worker;
  }

  async listActiveWorkers() {
    return listWorkers({ type: this.managedType, active: true, limit: config.orchestrator.maxActiveWorkers + 20 });
  }

  async enforceWorkerLimits() {
    const active = await this.listActiveWorkers();
    const settings = getOrchestratorSettings();
    const modeLimit = this.managedType === "gcp_vm"
      ? settings.max_gcp_vm_workers
      : this.managedType === "gke_job"
        ? settings.max_gke_job_workers
        : this.managedType === "docker_local"
          ? settings.max_docker_local_workers
          : settings.max_local_workers;
    const limit = Math.min(config.orchestrator.maxActiveWorkers, modeLimit);
    const managedActive = active.filter((worker) => worker.type === this.managedType);
    if (managedActive.length <= limit) return;
    for (const worker of managedActive.slice(limit)) {
      worker.status = "expired";
      upsertWorker(worker);
    }
  }

  async handleHeartbeat(worker_id: string, runtime: WorkerRuntimeMetadata = {}) {
    const worker = getWorker(worker_id);
    if (!worker) throw new Error(`Worker not found: ${worker_id}`);
    applyRuntimeMetadata(worker, runtime);
    worker.heartbeat_at = new Date().toISOString();
    if (worker.status === "starting") worker.status = "idle";
    upsertWorker(worker);
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: worker.worker_id,
      type: "worker.heartbeat",
      message: `Heartbeat from ${worker.worker_id}.`,
      data: worker,
    });
    return worker;
  }

  async handleWorkerEvent(event: CommandEventRecord) {
    appendOrchestratorEvent({
      scope: "command",
      scope_id: event.event_id,
      type: "command.event",
      message: `${event.command}: ${event.summary}`,
      data: event,
    });
  }

  async handleTaskResult(result: { task_id: string; status: TaskRecord["status"]; summary?: string; next_steps?: string[] }) {
    const task = getTask(result.task_id);
    if (!task) return null;
    task.status = result.status;
    task.latest_summary = result.summary ?? task.latest_summary;
    task.next_steps = result.next_steps ?? task.next_steps;
    task.updated_at = new Date().toISOString();
    const saved = upsertTask(task);
    if (task.worker_id) {
      const worker = getWorker(task.worker_id);
      if (worker && result.status === "failed") {
        worker.status = "failed";
        upsertWorker(worker);
        appendOrchestratorEvent({
          scope: "worker",
          scope_id: worker.worker_id,
          type: "worker.failed",
          message: `Worker ${worker.worker_id} reported failed task ${task.task_id}.`,
          data: worker,
        });
      } else if (worker && result.status === "completed") {
        worker.status = "idle";
        upsertWorker(worker);
      }
    }
    return saved;
  }
}

export class DockerLocalWorkerManager extends LocalWorkerManager {
  protected override managedType: WorkerType = "docker_local";

  override async createWorker(task_id: string, project_id: string) {
    const worker = await super.createWorker(task_id, project_id, "docker_local");
    worker.status = "starting";
    worker.metadata = {
      compose_service: "worker",
      note: "Docker Compose starts the local worker container; this manager records lifecycle state.",
    };
    upsertWorker(worker);
    return worker;
  }
}

function runDetached(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}

function k8sName(value: string, fallback = "head-developer-worker") {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || fallback;
}

function k8sLabelValue(value: string, fallback = "unknown") {
  return value
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 63) || fallback;
}

function env(name: string, value: string) {
  return { name, value };
}

function fieldEnv(name: string, fieldPath: string) {
  return { name, valueFrom: { fieldRef: { fieldPath } } };
}

function gkeWorkerImageUri() {
  return config.orchestrator.workerImageUri || `${config.gcp.region}-docker.pkg.dev/${config.gcp.projectId}/head-developer/worker:dev`;
}

export function gkeJobNameForWorker(workerId: string) {
  return k8sName(`hd-worker-${workerId.replace(/^worker_/, "").slice(0, 8)}`);
}

export function gkeJobLabels(input: { workerId: string; taskId: string; projectId: string }) {
  return {
    app: "head-developer",
    worker_id: k8sLabelValue(input.workerId),
    task_id: k8sLabelValue(input.taskId),
    project_id: k8sLabelValue(input.projectId),
  };
}

export function gkeJobLabelSelector(input: { workerId: string; taskId?: string; projectId?: string }) {
  const labels = {
    app: "head-developer",
    worker_id: k8sLabelValue(input.workerId),
    ...(input.taskId ? { task_id: k8sLabelValue(input.taskId) } : {}),
    ...(input.projectId ? { project_id: k8sLabelValue(input.projectId) } : {}),
  };
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",");
}

export interface GkeJobManifestOptions {
  namespace?: string;
  serviceAccountName?: string;
  imageUri?: string;
  callbackUrl?: string;
  callbackAudience?: string;
  gcpProjectId?: string;
  vertexProjectId?: string;
  vertexLocation?: string;
  vertexModel?: string;
  codexHome?: string;
  codexHomeBundleGcsUri?: string;
  codexHomeBundleSecret?: string;
  codexHomeBundleSecretProject?: string;
  codexHomeBundleSecretVersion?: string;
  ttlSecondsAfterFinished?: number;
  activeDeadlineSeconds?: number;
}

export function buildGkeJobManifest(worker: WorkerRecord, options: GkeJobManifestOptions = {}) {
  const namespace = options.namespace ?? config.gke.namespace;
  const serviceAccountName = options.serviceAccountName ?? config.gke.kubernetesServiceAccount;
  const imageUri = options.imageUri ?? worker.image_uri ?? gkeWorkerImageUri();
  const callbackUrl = options.callbackUrl ?? config.orchestrator.apiCallbackUrl;
  const callbackAudience = options.callbackAudience ?? callbackUrl;
  const gcpProjectId = options.gcpProjectId ?? config.gcp.projectId;
  const codexHome = options.codexHome ?? config.codexAuth.homePath;
  const codexHomeBundleGcsUri = options.codexHomeBundleGcsUri ?? config.codexAuth.homeBundleGcsUri;
  const codexHomeBundleSecret = options.codexHomeBundleSecret ?? "";
  const codexHomeBundleSecretProject = options.codexHomeBundleSecretProject ?? (config.codexAuth.homeBundleSecretProject || config.gcp.projectId);
  const codexHomeBundleSecretVersion = options.codexHomeBundleSecretVersion ?? config.codexAuth.homeBundleSecretVersion;
  const labels = gkeJobLabels({ workerId: worker.worker_id, taskId: worker.task_id ?? "", projectId: worker.project_id ?? "" });
  const envVars = [
    env("HEAD_DEVELOPER_WORKER_ID", worker.worker_id),
    env("HEAD_DEVELOPER_WORKER_TYPE", "gke_job"),
    env("HEAD_DEVELOPER_WORKER_POLL", "1"),
    env("HEAD_DEVELOPER_TASK_ID", worker.task_id ?? ""),
    env("HEAD_DEVELOPER_PROJECT_ID", worker.project_id ?? ""),
    env("HEAD_DEVELOPER_WORKSPACE_PATH", "/workspace"),
    env("HEAD_DEVELOPER_RECORDED_WORKER_IMAGE_URI", imageUri),
    env("HEAD_DEVELOPER_WORKER_IMAGE_URI", imageUri),
    env("HEAD_DEVELOPER_WORKER_RUNTIME_IMAGE_URI", imageUri),
    env("HEAD_DEVELOPER_WORKER_K8S_JOB_NAME", gkeJobNameForWorker(worker.worker_id)),
    env("HEAD_DEVELOPER_WORKER_K8S_NAMESPACE", namespace),
    fieldEnv("HEAD_DEVELOPER_WORKER_K8S_POD_NAME", "metadata.name"),
    fieldEnv("HEAD_DEVELOPER_WORKER_K8S_POD_NAMESPACE", "metadata.namespace"),
    env("WORKER_CALLBACK_URL", callbackUrl),
    env("WORKER_CALLBACK_AUTH", "google_id_token"),
    env("WORKER_CALLBACK_AUDIENCE", callbackAudience),
    env("GCP_PROJECT_ID", gcpProjectId),
    env("GOOGLE_CLOUD_PROJECT", gcpProjectId),
    env("SUPERVISOR_MODEL_PROVIDER", config.supervisorModelProvider),
    env("VERTEX_PROJECT_ID", options.vertexProjectId ?? config.vertex.projectId),
    env("VERTEX_LOCATION", options.vertexLocation ?? config.vertex.location),
    env("VERTEX_MODEL", options.vertexModel ?? config.vertex.model),
    env("CODEX_HOME", codexHome),
    env("HEAD_DEVELOPER_CODEX_AUTH_METHOD", "codex_home_bundle"),
    env("HEAD_DEVELOPER_CODEX_HOME", codexHome),
    env("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI", codexHomeBundleGcsUri),
    env("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_VERSION", codexHomeBundleSecretVersion),
  ];
  if (codexHomeBundleSecret) {
    envVars.push(
      env("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET", codexHomeBundleSecret),
      env("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_PROJECT", codexHomeBundleSecretProject),
    );
  }
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: gkeJobNameForWorker(worker.worker_id),
      namespace,
      labels,
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: options.ttlSecondsAfterFinished ?? config.gke.jobTtlSecondsAfterFinished,
      activeDeadlineSeconds: options.activeDeadlineSeconds ?? config.gke.jobActiveDeadlineSeconds,
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName,
          restartPolicy: "Never",
          containers: [
            {
              name: "head-developer-worker",
              image: imageUri,
              imagePullPolicy: "IfNotPresent",
              env: envVars,
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "state", mountPath: "/state" },
                { name: "codex-home", mountPath: "/codex-home" },
              ],
              resources: {
                requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi" },
                limits: { cpu: "1", memory: "2Gi", "ephemeral-storage": "2Gi" },
              },
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "state", emptyDir: {} },
            { name: "codex-home", emptyDir: {} },
          ],
        },
      },
    },
  };
}

function manifestEnvNames(manifest: ReturnType<typeof buildGkeJobManifest>) {
  const containers = manifest.spec.template.spec.containers;
  return containers.flatMap((container) => container.env.map((item: { name: string }) => item.name));
}

function runSync(command: string, args: string[], timeoutMs = 120_000, options: { env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, env: options.env ?? process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stderr || ""}\n${result.stdout || ""}`.trim().slice(-1000);
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}: ${output}`);
  }
  return result.stdout || "";
}

function writeTempManifest(manifest: ReturnType<typeof buildGkeJobManifest>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "head-developer-gke-job-"));
  const file = path.join(dir, "job.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { dir, file };
}

function startupScript(worker: WorkerRecord) {
  const imageUri = worker.image_uri;
  const callbackUrl = config.orchestrator.apiCallbackUrl;
  const codexHomeBundleSecretProject = config.codexAuth.homeBundleSecretProject || config.gcp.projectId;
  const codexAuthSecretProject = config.codexAuth.apiKeySecretProject || config.gcp.projectId;
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "exec > >(tee -a /tmp/head-developer-worker-startup.log /dev/console) 2>&1",
    "echo '[startup] head-developer worker VM startup begin'",
    "export HOME=/tmp/cos-docker-home",
    "export DOCKER_CONFIG=/tmp/cos-docker-home/.docker",
    "mkdir -p \"$HOME\"",
    "mkdir -p \"$DOCKER_CONFIG\"",
    "if ! command -v docker >/dev/null 2>&1; then",
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    apt-get update",
    "    apt-get install -y docker.io",
    "    systemctl enable --now docker || true",
    "  else",
    "    echo 'Docker is required on the worker VM image but was not found.' >&2",
    "    exit 1",
    "  fi",
    "fi",
    "echo '[startup] fetching VM metadata token'",
    `TOKEN_JSON="$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token)"`,
    `ACCESS_TOKEN="$(printf '%s' "$TOKEN_JSON" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"`,
    `VM_NAME="$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/name || true)"`,
    `MACHINE_TYPE_FULL="$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/machine-type || true)"`,
    "MACHINE_TYPE=\"${MACHINE_TYPE_FULL##*/}\"",
    `STARTUP_ATTEMPT_ID="${worker.worker_id}-$(date -u +%Y%m%d%H%M%S)"`,
    "echo '[startup] authenticating Docker to Artifact Registry'",
    `printf '%s' "$ACCESS_TOKEN" | docker login -u oauth2accesstoken --password-stdin https://${config.gcp.region}-docker.pkg.dev >/dev/null`,
    "echo '[startup] pulling worker image'",
    `docker pull ${imageUri}`,
    `IMAGE_DIGEST_REF="$(docker image inspect --format='{{index .RepoDigests 0}}' ${imageUri} 2>/dev/null || true)"`,
    "IMAGE_DIGEST=\"${IMAGE_DIGEST_REF##*@}\"",
    "echo \"[startup] worker image digest ${IMAGE_DIGEST:-unknown}\"",
    "echo '[startup] starting worker container'",
    "docker run --rm --name head-developer-worker \\",
    `  -e HEAD_DEVELOPER_WORKER_ID=${worker.worker_id} \\`,
    "  -e HEAD_DEVELOPER_WORKER_TYPE=gcp_vm \\",
    "  -e HEAD_DEVELOPER_WORKER_POLL=1 \\",
    `  -e HEAD_DEVELOPER_TASK_ID=${worker.task_id ?? ""} \\`,
    `  -e HEAD_DEVELOPER_PROJECT_ID=${worker.project_id ?? ""} \\`,
    `  -e HEAD_DEVELOPER_RECORDED_WORKER_IMAGE_URI=${imageUri} \\`,
    `  -e HEAD_DEVELOPER_WORKER_IMAGE_URI=${imageUri} \\`,
    `  -e HEAD_DEVELOPER_ACTUAL_WORKER_IMAGE_URI=${imageUri} \\`,
    `  -e HEAD_DEVELOPER_WORKER_RUNTIME_IMAGE_URI=${imageUri} \\`,
    `  -e HEAD_DEVELOPER_ACTUAL_WORKER_IMAGE_DIGEST="$IMAGE_DIGEST" \\`,
    `  -e HEAD_DEVELOPER_WORKER_IMAGE_DIGEST="$IMAGE_DIGEST" \\`,
    `  -e HEAD_DEVELOPER_ACTUAL_VM_NAME="$VM_NAME" \\`,
    `  -e HEAD_DEVELOPER_WORKER_VM_NAME="$VM_NAME" \\`,
    `  -e HEAD_DEVELOPER_WORKER_MACHINE_TYPE="$MACHINE_TYPE" \\`,
    `  -e HEAD_DEVELOPER_WORKER_STARTUP_ATTEMPT_ID="$STARTUP_ATTEMPT_ID" \\`,
    `  -e WORKER_CALLBACK_URL=${callbackUrl} \\`,
    "  -e WORKER_CALLBACK_AUTH=google_id_token \\",
    `  -e WORKER_CALLBACK_AUDIENCE=${callbackUrl} \\`,
    `  -e GCP_PROJECT_ID=${config.gcp.projectId} \\`,
    `  -e GOOGLE_CLOUD_PROJECT=${config.gcp.projectId} \\`,
    `  -e SUPERVISOR_MODEL_PROVIDER=${config.supervisorModelProvider} \\`,
    `  -e VERTEX_PROJECT_ID=${config.vertex.projectId} \\`,
    `  -e VERTEX_LOCATION=${config.vertex.location} \\`,
    `  -e VERTEX_MODEL=${config.vertex.model} \\`,
    `  -e CODEX_HOME=${config.codexAuth.homePath} \\`,
    `  -e HEAD_DEVELOPER_CODEX_AUTH_METHOD=${config.codexAuth.method} \\`,
    `  -e HEAD_DEVELOPER_CODEX_HOME=${config.codexAuth.homePath} \\`,
    `  -e HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET=${config.codexAuth.homeBundleSecret} \\`,
    `  -e HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_PROJECT=${codexHomeBundleSecretProject} \\`,
    `  -e HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_VERSION=${config.codexAuth.homeBundleSecretVersion} \\`,
    `  -e HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI=${config.codexAuth.homeBundleGcsUri} \\`,
    `  -e HEAD_DEVELOPER_CODEX_API_KEY_SECRET=${config.codexAuth.apiKeySecret} \\`,
    `  -e HEAD_DEVELOPER_CODEX_API_KEY_SECRET_PROJECT=${codexAuthSecretProject} \\`,
    `  -e HEAD_DEVELOPER_CODEX_API_KEY_SECRET_VERSION=${config.codexAuth.apiKeySecretVersion} \\`,
    `  ${imageUri}`,
    "echo '[startup] worker container exited'",
  ].join("\n");
}

export class GcpVmWorkerManager extends LocalWorkerManager {
  protected override managedType: WorkerType = "gcp_vm";

  override async createWorker(task_id: string, project_id: string) {
    const worker = baseWorker(task_id, project_id, "gcp_vm");
    worker.vm_name = `hd-worker-${worker.worker_id.slice(7, 15)}`;
    worker.recorded_vm_name = worker.vm_name;
    worker.machine_type = config.gcp.workerMachineType;
    worker.status = "starting";
    worker.image_uri = config.orchestrator.workerImageUri || `${config.gcp.region}-docker.pkg.dev/${config.gcp.projectId}/head-developer/worker:dev`;
    worker.recorded_image_uri = worker.image_uri;
    worker.metadata = { dry_run: config.orchestrator.gcpVmDryRun || !config.gcp.projectId };
    upsertWorker(worker);

    if (worker.metadata.dry_run) {
      appendOrchestratorEvent({
        scope: "worker",
        scope_id: worker.worker_id,
        type: "worker.gcp_vm.dry_run",
        message: `Prepared dry-run GCP VM worker ${worker.vm_name}.`,
        data: { worker, startup_script: startupScript(worker) },
      });
      appendOrchestratorEvent({
        scope: "worker",
        scope_id: worker.worker_id,
        type: "worker.started",
        message: `GCP VM worker ${worker.vm_name} is prepared.`,
        data: worker,
      });
      return worker;
    }

    const labels = [
      "app=head-developer",
      `env=${config.orchestrator.environment}`,
      `project_id=${project_id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60)}`,
      `task_id=${task_id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60)}`,
      `worker_id=${worker.worker_id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60)}`,
    ].join(",");
    const metadata = `startup-script=${startupScript(worker)}`;
    const args = [
      "compute",
      "instances",
      "create",
      worker.vm_name!,
      `--project=${config.gcp.projectId}`,
      `--zone=${config.gcp.zone}`,
      `--machine-type=${worker.machine_type}`,
      "--no-address",
      `--image-family=${config.gcp.workerImageFamily}`,
      `--image-project=${config.gcp.workerImageProject}`,
      `--network=${config.gcp.network}`,
      "--scopes=https://www.googleapis.com/auth/cloud-platform",
      `--labels=${labels}`,
      `--metadata=${metadata}`,
    ];
    if (config.gcp.subnetwork) args.push(`--subnet=${config.gcp.subnetwork}`);
    if (config.gcp.workerServiceAccountEmail) args.push(`--service-account=${config.gcp.workerServiceAccountEmail}`);
    runDetached("gcloud", args);

    appendOrchestratorEvent({
      scope: "worker",
      scope_id: worker.worker_id,
      type: "worker.gcp_vm.create_requested",
      message: `Requested GCP VM worker ${worker.vm_name}.`,
      data: { worker },
    });
    return worker;
  }

  override async stopWorker(worker_id: string) {
    const worker = getWorker(worker_id);
    if (!worker) throw new Error(`Worker not found: ${worker_id}`);
    worker.status = "stopping";
    upsertWorker(worker);
    if (worker.vm_name && config.gcp.projectId && !config.orchestrator.gcpVmDryRun) {
      runDetached("gcloud", ["compute", "instances", "stop", worker.vm_name, `--project=${config.gcp.projectId}`, `--zone=${config.gcp.zone}`]);
    }
    worker.status = "stopped";
    upsertWorker(worker);
    return worker;
  }
}

export class GkeJobWorkerManager extends LocalWorkerManager {
  protected override managedType: WorkerType = "gke_job";

  private commandEnv(): NodeJS.ProcessEnv {
    const baseDir = path.join(os.tmpdir(), "head-developer-gke");
    const gcloudConfig = path.join(baseDir, "gcloud");
    fs.mkdirSync(gcloudConfig, { recursive: true });
    return {
      ...process.env,
      CLOUDSDK_CONFIG: gcloudConfig,
      KUBECONFIG: path.join(baseDir, "kubeconfig"),
      HOME: baseDir,
      USE_GKE_GCLOUD_AUTH_PLUGIN: "True",
    };
  }

  private ensureCredentials() {
    if (!config.gcp.projectId) throw new Error("GKE Job worker mode requires GCP_PROJECT_ID.");
    console.log(`Preparing GKE credentials for ${config.gke.clusterName} in ${config.gke.location}.`);
    runSync("gcloud", [
      "container",
      "clusters",
      "get-credentials",
      config.gke.clusterName,
      `--project=${config.gcp.projectId}`,
      `--location=${config.gke.location}`,
    ], 60_000, { env: this.commandEnv() });
  }

  private kubectl(args: string[], timeoutMs = 120_000) {
    return runSync("kubectl", ["-n", config.gke.namespace, ...args], timeoutMs, { env: this.commandEnv() });
  }

  private deleteJobForWorker(worker: WorkerRecord) {
    const selector = gkeJobLabelSelector({
      workerId: worker.worker_id,
      taskId: worker.task_id,
      projectId: worker.project_id,
    });
    return this.kubectl(["delete", "job", "-l", selector, "--ignore-not-found=true"], 120_000);
  }

  override async enforceWorkerLimits() {
    if (config.gke.dryRun || !config.gcp.projectId) return;
    const limit = Math.min(config.orchestrator.maxActiveWorkers, config.orchestrator.maxGkeJobWorkers);
    this.ensureCredentials();
    const output = this.kubectl(["get", "jobs", "-l", "app=head-developer", "-o", "json"], 60_000);
    const payload = JSON.parse(output || "{}") as { items?: Array<{ metadata?: { name?: string }; status?: { completionTime?: string; failed?: number; succeeded?: number } }> };
    const activeJobs = (payload.items ?? []).filter((job) => !job.status?.completionTime && !job.status?.failed && !job.status?.succeeded);
    if (activeJobs.length >= limit) {
      throw new Error(`GKE Job worker limit reached: ${activeJobs.length}/${limit} active Kubernetes Jobs.`);
    }
  }

  override async createWorker(task_id: string, project_id: string) {
    const worker = baseWorker(task_id, project_id, "gke_job");
    worker.status = "starting";
    worker.image_uri = gkeWorkerImageUri();
    worker.recorded_image_uri = worker.image_uri;
    const jobName = gkeJobNameForWorker(worker.worker_id);
    const labels = gkeJobLabels({ workerId: worker.worker_id, taskId: task_id, projectId: project_id });
    worker.metadata = {
      dry_run: config.gke.dryRun || !config.gcp.projectId,
      kubernetes_cluster: config.gke.clusterName,
      kubernetes_location: config.gke.location,
      kubernetes_namespace: config.gke.namespace,
      kubernetes_job_name: jobName,
      kubernetes_service_account: config.gke.kubernetesServiceAccount,
      google_service_account: config.gke.googleServiceAccount ?? null,
      workload_identity: config.gke.googleServiceAccount
        ? `${config.gcp.projectId}.svc.id.goog[${config.gke.namespace}/${config.gke.kubernetesServiceAccount}] -> ${config.gke.googleServiceAccount}`
        : null,
      labels,
      codex_auth_method: "codex_home_bundle",
      codex_home: config.codexAuth.homePath,
      codex_home_bundle_gcs_uri: config.codexAuth.homeBundleGcsUri || null,
    };
    upsertWorker(worker);

    const manifest = buildGkeJobManifest(worker);
    if (worker.metadata.dry_run) {
      appendOrchestratorEvent({
        scope: "worker",
        scope_id: worker.worker_id,
        type: "worker.gke_job.dry_run",
        message: `Prepared dry-run GKE Job worker ${jobName}.`,
        data: {
          worker_id: worker.worker_id,
          job_name: jobName,
          namespace: config.gke.namespace,
          labels,
          manifest_env_names: manifestEnvNames(manifest),
        },
      });
      appendOrchestratorEvent({
        scope: "worker",
        scope_id: worker.worker_id,
        type: "worker.started",
        message: `GKE Job worker ${jobName} is prepared.`,
        data: worker,
      });
      return worker;
    }

    if (!config.codexAuth.homeBundleGcsUri && !config.codexAuth.homeBundleSecret) {
      worker.status = "failed";
      upsertWorker(worker);
      throw new Error("GKE Job Codex auth is not configured. Set HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI or HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET.");
    }
    const { dir, file } = writeTempManifest(manifest);
    try {
      this.ensureCredentials();
      console.log(`Applying GKE Job manifest ${jobName} in namespace ${config.gke.namespace}.`);
      runSync("kubectl", ["apply", "-f", file], 60_000, { env: this.commandEnv() });
    } catch (error) {
      worker.status = "failed";
      upsertWorker(worker);
      appendOrchestratorEvent({
        scope: "worker",
        scope_id: worker.worker_id,
        type: "worker.gke_job.create_failed",
        message: `Failed to create GKE Job worker ${jobName}.`,
        data: { worker_id: worker.worker_id, job_name: jobName, namespace: config.gke.namespace, error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    appendOrchestratorEvent({
      scope: "worker",
      scope_id: worker.worker_id,
      type: "worker.gke_job.create_requested",
      message: `Created Kubernetes Job ${jobName} for worker ${worker.worker_id}.`,
      data: {
        worker_id: worker.worker_id,
        job_name: jobName,
        namespace: config.gke.namespace,
        cluster: config.gke.clusterName,
        location: config.gke.location,
        labels,
        manifest_env_names: manifestEnvNames(manifest),
      },
    });
    return worker;
  }

  async getJobStatus(worker_id: string) {
    const worker = getWorker(worker_id);
    if (!worker) throw new Error(`Worker not found: ${worker_id}`);
    this.ensureCredentials();
    const name = String(worker.metadata?.kubernetes_job_name || gkeJobNameForWorker(worker.worker_id));
    return JSON.parse(this.kubectl(["get", "job", name, "-o", "json"], 60_000));
  }

  async fetchPodLogs(worker_id: string, tailLines = 200) {
    const worker = getWorker(worker_id);
    if (!worker) throw new Error(`Worker not found: ${worker_id}`);
    this.ensureCredentials();
    const selector = gkeJobLabelSelector({ workerId: worker.worker_id, taskId: worker.task_id, projectId: worker.project_id });
    return this.kubectl(["logs", "-l", selector, "--tail", String(tailLines)], 60_000);
  }

  override async stopWorker(worker_id: string) {
    const worker = getWorker(worker_id);
    if (!worker) throw new Error(`Worker not found: ${worker_id}`);
    worker.status = "stopping";
    upsertWorker(worker);
    if (!config.gke.dryRun && config.gcp.projectId) {
      this.ensureCredentials();
      this.deleteJobForWorker(worker);
    }
    worker.status = "stopped";
    upsertWorker(worker);
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: worker.worker_id,
      type: "worker.gke_job.deleted",
      message: `Deleted GKE Job for worker ${worker.worker_id}.`,
      data: {
        worker_id: worker.worker_id,
        job_name: worker.metadata?.kubernetes_job_name ?? null,
        namespace: config.gke.namespace,
        label_selector: gkeJobLabelSelector({ workerId: worker.worker_id, taskId: worker.task_id, projectId: worker.project_id }),
      },
    });
    return worker;
  }
}

export function workerManagerFor(type: WorkerType): WorkerManager {
  if (type === "docker_local") return new DockerLocalWorkerManager();
  if (type === "gcp_vm") return new GcpVmWorkerManager();
  if (type === "gke_job") return new GkeJobWorkerManager();
  return new LocalWorkerManager();
}
