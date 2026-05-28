import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { validateAppOutput } from "./app-output-validation.js";
import { redactSensitiveText } from "./redaction.js";
import type { CommandEventRecord, TaskRecord, WorkerRecord, WorkerType } from "./types.js";

const workerId = process.env.HEAD_DEVELOPER_WORKER_ID || "local-worker";
const workerType = (process.env.HEAD_DEVELOPER_WORKER_TYPE || "docker_local") as WorkerType;
const taskId = process.env.HEAD_DEVELOPER_TASK_ID || "local-task";
const projectId = process.env.HEAD_DEVELOPER_PROJECT_ID || "local-project";
const apiCallbackUrl = process.env.WORKER_CALLBACK_URL || process.env.HEAD_DEVELOPER_API_CALLBACK_URL || "";
const apiCallbackAuth = process.env.WORKER_CALLBACK_AUTH || "";
const apiCallbackAudience =
  process.env.WORKER_CALLBACK_AUDIENCE ||
  process.env.HEAD_DEVELOPER_API_CALLBACK_ID_TOKEN_AUDIENCE ||
  apiCallbackUrl;
const workspacePath = process.env.HEAD_DEVELOPER_WORKSPACE_PATH || process.cwd();
const command = process.env.HEAD_DEVELOPER_WORKER_COMMAND || "";
const pollForTasks = process.env.HEAD_DEVELOPER_WORKER_POLL === "1" || process.env.HEAD_DEVELOPER_WORKER_POLL?.toLowerCase() === "true";
const mountedCodexHome = process.env.HEAD_DEVELOPER_MOUNTED_CODEX_HOME || "/codex-home-host";
const workerCodexHomeHostPath = process.env.HEAD_DEVELOPER_WORKER_CODEX_HOME_HOST_PATH || "";
const workerProcessStartedAt = new Date().toISOString();
const workerProcessStartedAtStamp = workerProcessStartedAt.replace(/[^0-9]/g, "").slice(0, 14);
const workerContainerStartedAt = process.env.HEAD_DEVELOPER_WORKER_CONTAINER_STARTED_AT || workerProcessStartedAt;
let cachedDockerContainerId: string | undefined;
let cachedStartupAttemptId: string | undefined;
let codexAuthState: {
  method: string;
  secretResource?: string;
  status: "validated" | "not_configured" | "failed";
  validatedAt?: string;
} | null = null;

type TaskPayload = {
  task: TaskRecord;
};

type ProjectPayload = {
  project: {
    project_id: string;
    display_name?: string;
    name?: string;
    workspace_path?: string;
    workspace_uri?: string;
  };
};

type WorkerContextPayload = {
  packet: import("./types.js").WorkerContextPacket;
};

type WorkersPayload = {
  workers: Array<{
    worker_id: string;
    type: WorkerType;
    status: WorkerRecord["status"];
    project_id?: string;
    task_id?: string;
  }>;
};

type ClaimTaskPayload = {
  decision: "claimed" | "claimed_after_abandoning_previous" | "already_running" | "blocked_by_active_command" | "skipped_terminal_task" | "skipped_worker_status";
  reason: string;
};

type RunnableAssignedWorker = {
  worker: WorkersPayload["workers"][number];
  task: TaskRecord;
  pollKey: string;
};

type RuntimeCommandRequestPayload = {
  request: import("./types.js").WorkerRuntimeCommandRequest | null;
};

function setDefaultEnv(name: string, value: string) {
  if (!process.env[name]) process.env[name] = value;
}

function setWorkerRuntimeDefaults() {
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_HOST", "0.0.0.0");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_PORT", "4319");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS", "http://127.0.0.1:4318,http://localhost:4318");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_CODEX_COMMAND", "codex");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_CODEX_HOME", process.env.HEAD_DEVELOPER_CODEX_HOME || "/codex-home");
  setDefaultEnv("CODEX_HOME", process.env.HEAD_DEVELOPER_CODEX_HOME || process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME || "/codex-home");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH", workspacePath);
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT", workspacePath);
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS", workspacePath);
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED", "0");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED", "0");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_STORE_DIR", "/state");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR", "/worker/codex-phone-supervisor/frontend/dist");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS", "5000");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS", "25");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL", "");
  setDefaultEnv("CODEX_PHONE_SUPERVISOR_TEST_MODE", "0");
  setDefaultEnv("SUPERVISOR_MODEL_PROVIDER", "vertex");
  setDefaultEnv("TWILIO_CONVERSATION_RELAY_WS_URL", "");
  setDefaultEnv("TWILIO_SMS_ENABLED", "0");
  setDefaultEnv("TWILIO_VOICE_ENABLED", "0");
  setDefaultEnv("TWILIO_VALIDATE_SIGNATURES", "0");
  setDefaultEnv("TWILIO_AUTH_TOKEN", "");
}

function imageDigestFromReference(imageUri: string) {
  const digest = imageUri.match(/@sha256:[a-f0-9]+$/i)?.[0];
  return digest ? digest.slice(1) : "";
}

function workerRuntimeVersion() {
  if (process.env.HEAD_DEVELOPER_WORKER_RUNTIME_VERSION) return process.env.HEAD_DEVELOPER_WORKER_RUNTIME_VERSION;
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return packageJson.version || undefined;
  } catch {
    return undefined;
  }
}

function dockerContainerId() {
  if (cachedDockerContainerId) return cachedDockerContainerId;
  if (process.env.HEAD_DEVELOPER_WORKER_CONTAINER_ID) return process.env.HEAD_DEVELOPER_WORKER_CONTAINER_ID;
  if (process.env.HOSTNAME) return process.env.HOSTNAME;
  try {
    cachedDockerContainerId = fs.readFileSync("/etc/hostname", "utf8").trim() || undefined;
    return cachedDockerContainerId;
  } catch {
    return undefined;
  }
}

function currentWorkerStartupAttemptId() {
  if (process.env.HEAD_DEVELOPER_WORKER_STARTUP_ATTEMPT_ID) return process.env.HEAD_DEVELOPER_WORKER_STARTUP_ATTEMPT_ID;
  if (!cachedStartupAttemptId) {
    cachedStartupAttemptId = `${workerId}-${dockerContainerId() || "process"}-${workerProcessStartedAtStamp}`;
  }
  return cachedStartupAttemptId;
}

function workerRuntimeMetadata(task_id: string, project_id: string) {
  const codexHome = codexHomePath();
  const runtimeImageUri =
    process.env.HEAD_DEVELOPER_ACTUAL_WORKER_IMAGE_URI ||
    process.env.HEAD_DEVELOPER_WORKER_RUNTIME_IMAGE_URI ||
    process.env.HEAD_DEVELOPER_WORKER_IMAGE_URI ||
    "local-dev-worker";
  const runtimeImageDigest =
    process.env.HEAD_DEVELOPER_ACTUAL_WORKER_IMAGE_DIGEST ||
    process.env.HEAD_DEVELOPER_WORKER_IMAGE_DIGEST ||
    process.env.HEAD_DEVELOPER_WORKER_RUNTIME_IMAGE_DIGEST ||
    imageDigestFromReference(runtimeImageUri);
  const actualVmName = process.env.HEAD_DEVELOPER_ACTUAL_VM_NAME || process.env.HEAD_DEVELOPER_WORKER_VM_NAME || process.env.GCE_INSTANCE_NAME || undefined;
  const runtimeVersion = workerRuntimeVersion();
  const containerId = dockerContainerId();
  return {
    task_id,
    project_id,
    worker_type: workerType,
    actual_worker_mode: workerType,
    recorded_image_uri: process.env.HEAD_DEVELOPER_RECORDED_WORKER_IMAGE_URI || process.env.HEAD_DEVELOPER_WORKER_IMAGE_URI || runtimeImageUri,
    image_uri: process.env.HEAD_DEVELOPER_WORKER_IMAGE_URI || runtimeImageUri,
    actual_worker_image_uri: runtimeImageUri,
    actual_image_uri: runtimeImageUri,
    runtime_image_uri: runtimeImageUri,
    actual_worker_image_digest: runtimeImageDigest || undefined,
    actual_image_digest: runtimeImageDigest || undefined,
    image_digest: runtimeImageDigest || undefined,
    runtime_image_digest: runtimeImageDigest || undefined,
    actual_vm_name: actualVmName,
    vm_name: actualVmName,
    runtime_vm_name: actualVmName,
    machine_type: process.env.HEAD_DEVELOPER_WORKER_MACHINE_TYPE || undefined,
    startup_attempt_id: currentWorkerStartupAttemptId(),
    run_attempt_id: process.env.HEAD_DEVELOPER_WORKER_RUN_ATTEMPT_ID || currentWorkerStartupAttemptId(),
    container_started_at: workerContainerStartedAt,
    worker_runtime_version: runtimeVersion,
    codex_home: codexHome,
    codex_home_host_path: workerCodexHomeHostPath || undefined,
    codex_history_sessions_path: path.join(codexHome, "sessions"),
    codex_auth_method: codexAuthState?.method || process.env.HEAD_DEVELOPER_CODEX_AUTH_METHOD || undefined,
    codex_auth_secret_resource: codexAuthState?.secretResource,
    codex_auth_validated_at: codexAuthState?.validatedAt,
    codex_auth_validation_status: codexAuthState?.status,
    docker_container_id: containerId,
    docker_container_name: process.env.HEAD_DEVELOPER_WORKER_CONTAINER_NAME || undefined,
  };
}

function commandRuntimeFields(runtime: ReturnType<typeof workerRuntimeMetadata>) {
  return {
    worker_mode: runtime.actual_worker_mode,
    actual_image_uri: runtime.actual_image_uri,
    actual_image_digest: runtime.actual_image_digest,
    vm_name: runtime.actual_vm_name,
    startup_attempt_id: runtime.startup_attempt_id,
    run_attempt_id: runtime.run_attempt_id,
    container_started_at: runtime.container_started_at,
    worker_runtime_version: runtime.worker_runtime_version,
    codex_auth_method: runtime.codex_auth_method,
    codex_auth_secret_resource: runtime.codex_auth_secret_resource,
    codex_auth_validated_at: runtime.codex_auth_validated_at,
    codex_auth_validation_status: runtime.codex_auth_validation_status,
    docker_container_id: runtime.docker_container_id,
    docker_container_name: runtime.docker_container_name,
    runtime_metadata_verified: true,
  };
}

async function attachCodexHistoryMetadata(
  event: import("./types.js").CommandEventRecord,
  prompt: string,
) {
  const codexHome = codexHomePath();
  const { detectCodexHistory, buildVisibilityMirrorPrompt } = await import("./codex-history.js");
  Object.assign(event, detectCodexHistory({
    commandEvent: event,
    codexHome,
    hostCodexHomePath: workerCodexHomeHostPath || undefined,
    prompt,
    commandStartedAt: event.started_at,
    commandCompletedAt: event.ended_at,
  }));
  if (process.env.CODEX_VISIBILITY_MIRROR?.toLowerCase() === "true" || process.env.CODEX_VISIBILITY_MIRROR === "1") {
    event.codex_visibility_mirror_prompt = buildVisibilityMirrorPrompt({
      sessionId: event.codex_session_id,
      rolloutPath: event.codex_rollout_relative_path || event.codex_rollout_path,
      taskId: event.task_id,
      commandEventId: event.event_id,
      summary: event.summary,
    });
    event.codex_visibility_mirror_created = false;
  }
  return event;
}

function prepareWritableCodexHome() {
  const target = codexHomePath();
  fs.mkdirSync(target, { recursive: true });
  if (!fs.existsSync(mountedCodexHome)) return;
  const copyHostConfig = process.env.HEAD_DEVELOPER_COPY_CODEX_CONFIG === "1" || process.env.HEAD_DEVELOPER_COPY_CODEX_CONFIG?.toLowerCase() === "true";
  if (!copyHostConfig) {
    fs.rmSync(path.join(target, "config.toml"), { force: true });
  }
  const filesToCopy = copyHostConfig
    ? ["auth.json", "config.toml", "version.json", "models_cache.json"]
    : ["auth.json", "version.json", "models_cache.json"];
  for (const name of filesToCopy) {
    const source = path.join(mountedCodexHome, name);
    const destination = path.join(target, name);
    if (fs.existsSync(source) && !fs.existsSync(destination)) {
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o600);
    }
  }
}

function codexHomePath() {
  return process.env.CODEX_HOME || process.env.HEAD_DEVELOPER_CODEX_HOME || process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME || "/codex-home";
}

function codexAuthMethod() {
  return (process.env.HEAD_DEVELOPER_CODEX_AUTH_METHOD || "").trim();
}

function codexApiKeySecretResource() {
  const secret = (process.env.HEAD_DEVELOPER_CODEX_API_KEY_SECRET || "").trim();
  if (!secret) return "";
  if (secret.startsWith("projects/") && secret.includes("/versions/")) return secret;
  const version = (process.env.HEAD_DEVELOPER_CODEX_API_KEY_SECRET_VERSION || "latest").trim() || "latest";
  if (secret.startsWith("projects/")) return `${secret.replace(/\/$/, "")}/versions/${version}`;
  const project =
    (process.env.HEAD_DEVELOPER_CODEX_API_KEY_SECRET_PROJECT || "").trim() ||
    (process.env.GOOGLE_CLOUD_PROJECT || "").trim() ||
    (process.env.GCP_PROJECT_ID || "").trim();
  if (!project) return "";
  return `projects/${project}/secrets/${secret}/versions/${version}`;
}

function codexHomeBundleSecretResource() {
  const secret = (process.env.HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET || "").trim();
  if (!secret) return "";
  if (secret.startsWith("projects/") && secret.includes("/versions/")) return secret;
  const version = (process.env.HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_VERSION || "latest").trim() || "latest";
  if (secret.startsWith("projects/")) return `${secret.replace(/\/$/, "")}/versions/${version}`;
  const project =
    (process.env.HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_PROJECT || "").trim() ||
    (process.env.GOOGLE_CLOUD_PROJECT || "").trim() ||
    (process.env.GCP_PROJECT_ID || "").trim();
  if (!project) return "";
  return `projects/${project}/secrets/${secret}/versions/${version}`;
}

function parseGcsUri(uri: string) {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI must use gs://bucket/object format.");
  return { bucket: match[1], object: match[2] };
}

async function metadataAccessToken() {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) throw new Error(`Could not fetch worker access token for Google APIs: ${response.status}`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("Worker metadata token response did not include an access token.");
  return payload.access_token;
}

async function fetchSecretManagerPayloadBuffer(resource: string) {
  const accessToken = await metadataAccessToken();
  const response = await fetch(`https://secretmanager.googleapis.com/v1/${resource}:access`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Secret Manager access failed for ${resource}: ${response.status}`);
  const payload = await response.json() as { payload?: { data?: string } };
  const encoded = payload.payload?.data;
  if (!encoded) throw new Error(`Secret Manager payload was empty for ${resource}.`);
  return Buffer.from(encoded, "base64");
}

async function fetchSecretManagerPayload(resource: string) {
  return (await fetchSecretManagerPayloadBuffer(resource)).toString("utf8").trim();
}

async function fetchGcsObjectBuffer(uri: string) {
  const { bucket, object } = parseGcsUri(uri);
  const accessToken = await metadataAccessToken();
  const response = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) throw new Error(`GCS Codex home bundle access failed for ${uri}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function runCodexCliQuiet(args: string[], stdin?: string) {
  const commandPath = process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND || "codex";
  const env = {
    ...process.env,
    CODEX_HOME: codexHomePath(),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(commandPath, args, {
      cwd: workspacePath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin.endsWith("\n") ? stdin : `${stdin}\n`);
    else child.stdin.end();
  });
}

async function runProcessQuiet(commandPath: string, args: string[]) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(commandPath, args, {
      cwd: workspacePath,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function requireSecretManagerAuthConfig() {
  const resource = codexApiKeySecretResource();
  if (!resource) {
    codexAuthState = {
      method: "secret_manager_api_key",
      status: "not_configured",
    };
    throw new Error("GCP VM Codex auth is not configured. Set HEAD_DEVELOPER_CODEX_API_KEY_SECRET to a Secret Manager secret name or resource.");
  }
  return resource;
}

function requireCodexHomeBundleAuthConfig() {
  const secretResource = codexHomeBundleSecretResource();
  const gcsUri = (process.env.HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI || "").trim();
  if (secretResource) return { kind: "secret_manager", resource: secretResource };
  if (gcsUri) return { kind: "gcs", resource: gcsUri };
  codexAuthState = {
    method: "codex_home_bundle",
    status: "not_configured",
  };
  throw new Error("Codex home bundle auth is not configured. Set HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET or HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI.");
}

function emptyDirectoryContents(target: string) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(target)) {
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
}

async function validateCodexHomeBundleAuth() {
  const source = requireCodexHomeBundleAuthConfig();
  const target = codexHomePath();
  const tempBundlePath = path.join("/tmp", `codex-home-bundle-${process.pid}-${Date.now()}.tgz`);
  try {
    const bundle =
      source.kind === "secret_manager"
        ? await fetchSecretManagerPayloadBuffer(source.resource)
        : await fetchGcsObjectBuffer(source.resource);
    if (!bundle.length) throw new Error(`Codex home bundle was empty from ${source.resource}.`);
    fs.writeFileSync(tempBundlePath, bundle, { mode: 0o600 });
    emptyDirectoryContents(target);
    const extracted = await runProcessQuiet("tar", ["-xzf", tempBundlePath, "-C", target]);
    if (extracted.code !== 0) {
      throw new Error(`Codex home bundle extraction failed with exit ${extracted.code ?? "null"}: ${redactSensitiveText(extracted.stderr || extracted.stdout).slice(-500)}`);
    }
    const status = await runCodexCliQuiet(["login", "status"]);
    if (status.code !== 0) {
      throw new Error(`codex login status failed with exit ${status.code ?? "null"}: ${redactSensitiveText(status.stderr || status.stdout).slice(-500)}`);
    }
    codexAuthState = {
      method: "codex_home_bundle",
      secretResource: source.resource,
      status: "validated",
      validatedAt: new Date().toISOString(),
    };
    process.stdout.write(`Codex auth validated with method codex_home_bundle using ${source.kind} bundle resource ${source.resource}.\n`);
    return codexAuthState;
  } catch (error) {
    codexAuthState = {
      method: "codex_home_bundle",
      secretResource: source.resource,
      status: "failed",
    };
    throw error;
  } finally {
    fs.rmSync(tempBundlePath, { force: true });
  }
}

async function validateCodexAuth() {
  if (codexAuthState?.status === "validated") return codexAuthState;
  const method = codexAuthMethod();
  if (!method || method === "none") {
    codexAuthState = {
      method: method || "none",
      status: "not_configured",
    };
    if (workerType === "gcp_vm" || workerType === "gke_job") {
      throw new Error("Remote worker Codex auth is not configured. Set HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle.");
    }
    return codexAuthState;
  }
  if (method === "codex_home_bundle") return await validateCodexHomeBundleAuth();

  if (method !== "secret_manager_api_key") {
    codexAuthState = {
      method,
      status: "failed",
    };
    throw new Error(`Unsupported Codex auth method for worker: ${method}`);
  }

  const resource = requireSecretManagerAuthConfig();
  try {
    fs.mkdirSync(codexHomePath(), { recursive: true });
    const apiKey = await fetchSecretManagerPayload(resource);
    if (!apiKey) throw new Error(`Secret Manager payload was empty for ${resource}.`);
    const login = await runCodexCliQuiet(["login", "--with-api-key"], apiKey);
    if (login.code !== 0) {
      throw new Error(`codex login --with-api-key failed with exit ${login.code ?? "null"}: ${redactSensitiveText(login.stderr || login.stdout).slice(-500)}`);
    }
    const status = await runCodexCliQuiet(["login", "status"]);
    if (status.code !== 0) {
      throw new Error(`codex login status failed with exit ${status.code ?? "null"}: ${redactSensitiveText(status.stderr || status.stdout).slice(-500)}`);
    }
    codexAuthState = {
      method,
      secretResource: resource,
      status: "validated",
      validatedAt: new Date().toISOString(),
    };
    process.stdout.write(`Codex auth validated with method ${method} using Secret Manager resource ${resource}.\n`);
    return codexAuthState;
  } catch (error) {
    codexAuthState = {
      method,
      secretResource: resource,
      status: "failed",
    };
    throw error;
  }
}

async function validateCodexAuthForCommand(commandName: string) {
  if (commandName === "codex" || commandName.endsWith("/codex") || commandName === (process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND || "")) {
    await validateCodexAuth();
  }
}

async function googleIdentityToken() {
  if (apiCallbackAuth !== "google_id_token") return "";
  if (!apiCallbackAudience) throw new Error("WORKER_CALLBACK_AUDIENCE is required for google_id_token callback auth.");
  const audience = encodeURIComponent(apiCallbackAudience);
  const response = await fetch(
    `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${audience}&format=full`,
    { headers: { "Metadata-Flavor": "Google" } },
  );
  if (!response.ok) throw new Error(`Could not fetch worker identity token: ${response.status}`);
  process.stdout.write(`Fetched Google ID token for callback audience ${apiCallbackAudience}.\n`);
  return response.text();
}

async function request(path: string, init: RequestInit = {}) {
  if (!apiCallbackUrl) return;
  const attempts = Number(process.env.HEAD_DEVELOPER_WORKER_CALLBACK_ATTEMPTS || "3");
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const token = await googleIdentityToken();
      const response = await fetch(`${apiCallbackUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: token
          ? { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
          : { "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Callback ${path} failed with ${response.status}: ${text.slice(0, 500)}`);
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

async function get<T>(path: string): Promise<T> {
  return await request(path, { method: "GET" }) as T;
}

async function post(path: string, body: unknown) {
  return await request(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function buildWorkerSchemaFile(taskId: string) {
  const dir = process.env.CODEX_PHONE_SUPERVISOR_RUNTIME_DIR || "/state/runtime";
  fs.mkdirSync(dir, { recursive: true });
  const schemaPath = path.join(dir, `${taskId}.worker-output.schema.json`);
  fs.writeFileSync(schemaPath, JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "status",
      "latest_codex_message",
      "files_read",
      "files_modified",
      "commands_requested",
      "commands_completed",
      "commands_failed",
      "test_results",
      "errors",
      "approval_requests",
      "files_to_write",
    ],
    properties: {
      summary: { type: "string" },
      status: { type: "string", enum: ["completed", "failed", "needs_approval", "running"] },
      latest_codex_message: { type: "string" },
      files_read: { type: "array", items: { type: "string" } },
      files_modified: { type: "array", items: { type: "string" } },
      commands_requested: { type: "array", items: { type: "string" } },
      commands_completed: { type: "array", items: { type: "string" } },
      commands_failed: { type: "array", items: { type: "string" } },
      test_results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "status", "details"],
          properties: {
            name: { type: "string" },
            status: { type: "string", enum: ["passed", "failed", "skipped", "unknown"] },
            details: { type: ["string", "null"] },
          },
        },
      },
      errors: { type: "array", items: { type: "string" } },
      files_to_write: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
      },
      approval_requests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "command", "reason", "risk"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "shell",
                "network",
                "install",
                "delete",
                "deploy",
                "git_push",
                "secret_access",
                "external_repo",
                "gcp_resource",
                "twilio_mutation",
                "payment_or_billing",
              ],
            },
            command: { type: "string" },
            reason: { type: "string" },
            risk: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
      },
    },
  }, null, 2));
  return schemaPath;
}

export function renderCodexPrompt(
  task: TaskPayload["task"],
  project: ProjectPayload["project"],
  context: import("./types.js").WorkerContextPacket | null,
) {
  const projectName = project.display_name || project.name || project.project_id;
  const docsText = context
    ? Object.entries(context.relevant_docs)
      .map(([name, text]) => `## ${name}\n${text.slice(0, 500)}`)
      .join("\n\n")
    : "";
  const outputContract = context?.output_contract;
  const outputContractText = outputContract
    ? [
      "Output contract:",
      `- Required app files/patterns: ${outputContract.required_app_files.length ? outputContract.required_app_files.join(", ") : "none"}`,
      `- Allowed documentation files: ${outputContract.allowed_doc_files.join(", ")}`,
      `- Expected user-visible output: ${outputContract.expected_user_visible_output.join(" | ")}`,
      `- Validation commands: ${outputContract.validation_commands.join(" | ")}`,
      `- Acceptance checks: ${outputContract.acceptance_checks.join(" | ")}`,
      `- Completion criteria: ${outputContract.completion_criteria.join(" | ")}`,
      `- Docs-only completion allowed: ${outputContract.docs_only_is_insufficient ? "no" : "yes"}`,
    ].join("\n")
    : "";
  return [
    "You are the Cloud Orchestrator worker running Codex for a real user task.",
    `Project: ${projectName}`,
    `Task: ${task.user_goal}`,
    context ? `Task graph node: ${context.task_graph_node.title} (${context.node_id})` : "",
    context?.requirement_summary ? `Approved requirements summary: ${context.requirement_summary}` : "",
    context?.approved_plan ? `Approved plan: ${context.approved_plan.proposed_task_split.map((item) => `${item.title}: ${item.goal}`).join(" | ")}` : "",
    context?.planning_decision_id ? `Planning decision id: ${context.planning_decision_id}` : "",
    context?.user_approved_worker_count ? `User-approved worker count: ${context.user_approved_worker_count}` : "",
    context?.user_approved_worker_mode ? `User-approved worker mode: ${context.user_approved_worker_mode}` : "",
    context ? `Assigned branch/worktree: ${context.worktree_path || "main project repo"}` : "",
    context ? `Allowed roots: ${context.allowed_roots.join(", ")}` : "",
    context ? `Expected files: ${context.expected_files.join(", ")}` : "",
    context ? `Expected output: ${context.expected_output.join(" | ")}` : "",
    context ? `Validation commands: ${context.validation_commands.join(" | ")}` : "",
    context ? `Validation expectations: ${context.validation_expectations.join(" | ")}` : "",
    context ? `Handoff requirements: ${context.handoff_instructions.join(" | ")}` : "",
    outputContractText,
    outputContract?.docs_only_is_insufficient
      ? [
        "Required execution order:",
        "1. Put exact app file contents in files_to_write first. Include every required app file.",
        `2. Required app files: ${outputContract.required_app_files.join(", ") || "none"}.`,
        "3. Do not use apply_patch in Docker worker runs; nested apply_patch is unreliable here.",
        "4. Avoid tool calls unless absolutely needed. If you use exec_command, do not set a shell option.",
        "5. Keep handoff documentation concise. Updating docs alone is never sufficient for this node.",
        "6. Return final JSON immediately after files_to_write, file list, validation recommendations, and short handoff notes are complete.",
      ].join("\n")
      : "",
    context ? `Shared project docs:\n\n${docsText}` : "",
    "Read shared docs first when they exist.",
    "Use CODE_INDEX.md, FUNCTIONS.md, VARIABLES.md, and STATE_MODEL.md to understand existing files, functions, variables, routes, and persisted state before changing code.",
    "Work only inside the current project workspace or assigned worktree.",
    "Build the requested app or website as a real, usable MVP, not a placeholder.",
    "Updating .head-developer docs alone is not sufficient for app-building tasks; create or modify the required app/source files or report the task incomplete.",
    "For a simple landing page, use static HTML, CSS, and JavaScript unless the repository already indicates another stack.",
    "Create actual local files. Include concrete content, layout, and interaction appropriate to the user's request.",
    "Update .head-developer/WORKER_HANDOFFS.md and .head-developer/VALIDATION.md when those docs are present.",
    "Update CODE_INDEX.md, FUNCTIONS.md, VARIABLES.md, API_SURFACE.md, or STATE_MODEL.md when your changed files/functions/config/routes/state require it.",
    "Do not install packages, run network commands, deploy, delete files, read secrets, or write outside the project workspace.",
    "At the end, return only JSON matching the provided schema. Always include files_to_write; use an empty array only for non-file tasks.",
    "Report files modified and any validation command you recommend or completed.",
  ].filter(Boolean).join("\n\n");
}

type WorkerOutputFile = {
  path: string;
  content: string;
};

function commandStdout(event: CommandEventRecord) {
  if (event.stdout_ref && fs.existsSync(event.stdout_ref)) {
    return fs.readFileSync(event.stdout_ref, "utf8");
  }
  return event.stdout_preview ?? "";
}

function extractFinalWorkerJson(stdout: string) {
  let finalText = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: string } };
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
        finalText = parsed.item.text;
      }
    } catch {
      // Ignore non-Codex JSON lines.
    }
  }
  if (!finalText) return null;
  try {
    return JSON.parse(finalText) as { files_modified?: string[]; files_to_write?: WorkerOutputFile[] };
  } catch {
    return null;
  }
}

function normalizeRelativePath(value: string, workspaceRoot: string) {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!trimmed || path.isAbsolute(trimmed) || trimmed.includes("\0")) return null;
  const absolute = path.resolve(workspaceRoot, trimmed);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, "/");
}

function safeReportedFiles(value: unknown, workspaceRoot: string) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeRelativePath(item, workspaceRoot))
    .filter((item): item is string => Boolean(item)))].sort();
}

function extractGitStatusFiles(event: CommandEventRecord, workspaceRoot: string) {
  const output = `${commandStdout(event)}\n${event.summary ?? ""}`;
  return [...new Set([...output.matchAll(/^\s*(?:\?\?|[AMDRC?!]{1,2})\s+(.+)$/gm)]
    .map((match) => normalizeRelativePath(match[1].trim(), workspaceRoot))
    .filter((item): item is string => Boolean(item)))].sort();
}

function safeOutputFiles(value: unknown, workspaceRoot: string) {
  if (!Array.isArray(value)) return [];
  const files: WorkerOutputFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const filePath = typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path.trim() : "";
    const content = typeof (item as { content?: unknown }).content === "string" ? (item as { content: string }).content : "";
    if (!filePath || path.isAbsolute(filePath) || filePath.includes("\0")) continue;
    const absolute = path.resolve(workspaceRoot, filePath);
    const relative = path.relative(workspaceRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    files.push({ path: relative.replace(/\\/g, "/"), content });
  }
  return files;
}

function materializerScriptPath() {
  const dir = process.env.CODEX_PHONE_SUPERVISOR_RUNTIME_DIR || "/state/runtime";
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, "materialize-codex-files.mjs");
  if (!fs.existsSync(scriptPath)) {
    fs.writeFileSync(scriptPath, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const [,, planPath] = process.argv;",
      "if (!planPath) throw new Error('plan path is required');",
      "const workspace = process.cwd();",
      "const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));",
      "for (const file of plan.files || []) {",
      "  const target = path.resolve(workspace, file.path);",
      "  const relative = path.relative(workspace, target);",
      "  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Refusing to write outside workspace: ${file.path}`);",
      "  fs.mkdirSync(path.dirname(target), { recursive: true });",
      "  fs.writeFileSync(target, file.content);",
      "  console.log(`created: ${relative.replace(/\\\\/g, '/')}`);",
      "}",
    ].join("\n"));
  }
  return scriptPath;
}

async function materializeCodexFiles(input: {
  taskId: string;
  projectId: string;
  workerId: string;
  projectWorkspace: string;
  runtimeMetadata: ReturnType<typeof workerRuntimeMetadata>;
  codexEvent: CommandEventRecord;
}) {
  const parsed = extractFinalWorkerJson(commandStdout(input.codexEvent));
  const files = safeOutputFiles(parsed?.files_to_write, input.projectWorkspace);
  if (!files.length) return null;
  const dir = process.env.CODEX_PHONE_SUPERVISOR_RUNTIME_DIR || "/state/runtime";
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, `${input.taskId}.files-to-write.json`);
  fs.writeFileSync(planPath, JSON.stringify({ files }, null, 2));
  const { CommandRunner } = await import("./command-runner.js");
  const runner = new CommandRunner();
  const event = await runner.run({
    task_id: input.taskId,
    project_id: input.projectId,
    worker_id: input.workerId,
    ...commandRuntimeFields(input.runtimeMetadata),
    command: "node",
    args: [materializerScriptPath(), planPath],
    cwd: input.projectWorkspace,
    workspace_path: input.projectWorkspace,
    timeout_ms: 60_000,
  });
  event.summary = files.map((file) => `created: ${file.path}`).join("\n");
  await post(`/workers/${encodeURIComponent(input.workerId)}/events`, event);
  process.stdout.write(`Codex file materialization event ${event.event_id} posted successfully.\n`);
  return event;
}

async function loadWorkerContext(task: TaskPayload["task"]) {
  return task.worker_context_packet_id
    ? await get<WorkerContextPayload>(`/worker-context/${encodeURIComponent(task.worker_context_packet_id)}`).then((payload) => payload.packet).catch(() => null)
    : null;
}

async function buildCodexPrompt(task: TaskPayload["task"], project: ProjectPayload["project"]) {
  const context = await loadWorkerContext(task);
  return renderCodexPrompt(task, project, context);
}

function listProjectFiles(root: string) {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return files.sort();
}

function isArtifactFile(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) return false;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".git" || part === "node_modules" || part === ".codex-vm-home" || part === ".codex-worker-home")) return false;
  if (parts[0]?.startsWith(".") && parts[0] !== ".well-known") return false;
  return /\.(html|css|js|mjs|cjs|json|svg|png|jpe?g|webp|ico|txt|md)$/i.test(normalized);
}

async function restoreProjectArtifacts(projectId: string, projectWorkspace: string) {
  if (workerType !== "gke_job") return 0;
  const payload = await get<{ files?: Array<{ path: string; content_base64: string }> }>(`/projects/${encodeURIComponent(projectId)}/artifacts/files?source=persisted`).catch((error) => {
    process.stderr.write(`Project artifact restore skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  });
  const files = payload?.files ?? [];
  let restored = 0;
  for (const file of files) {
    if (!isArtifactFile(file.path)) continue;
    const target = path.resolve(projectWorkspace, file.path);
    const root = path.resolve(projectWorkspace);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.content_base64, "base64"));
    restored += 1;
  }
  if (restored) process.stdout.write(`Restored ${restored} project artifact file(s) into ${projectWorkspace}.\n`);
  return restored;
}

function collectProjectArtifacts(projectWorkspace: string, candidateFiles: string[]) {
  const selected = [...new Set(candidateFiles.filter(isArtifactFile))].slice(0, 100);
  const files: Array<{ path: string; content_base64: string; size_bytes: number }> = [];
  let totalBytes = 0;
  const maxBytes = 2 * 1024 * 1024;
  for (const relativePath of selected) {
    const absolute = path.resolve(projectWorkspace, relativePath);
    const root = path.resolve(projectWorkspace);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const data = fs.readFileSync(absolute);
    if (totalBytes + data.length > maxBytes) continue;
    totalBytes += data.length;
    files.push({ path: relativePath, content_base64: data.toString("base64"), size_bytes: data.length });
  }
  return files;
}

async function persistProjectArtifacts(input: { workerId: string; taskId: string; projectId: string; projectWorkspace: string; changedFiles: string[]; allFiles: string[] }) {
  if (workerType !== "gke_job") return { uploaded: 0, skipped: true };
  const candidates = input.changedFiles.length ? input.changedFiles : input.allFiles;
  const files = collectProjectArtifacts(input.projectWorkspace, candidates);
  if (!files.length) return { uploaded: 0, skipped: true };
  const payload = await post(`/workers/${encodeURIComponent(input.workerId)}/artifacts/files`, {
    task_id: input.taskId,
    project_id: input.projectId,
    files,
  }) as { artifact?: { files?: string[] } } | undefined;
  const uploaded = payload?.artifact?.files?.length ?? files.length;
  process.stdout.write(`Uploaded ${uploaded} project artifact file(s) for task ${input.taskId}.\n`);
  return { uploaded, skipped: false };
}

async function runRuntimeCommandRequest(request: import("./types.js").WorkerRuntimeCommandRequest) {
  const runtimeMetadata = workerRuntimeMetadata(request.task_id, request.project_id);
  const { CommandRunner } = await import("./command-runner.js");
  const runner = new CommandRunner();
  const [bin, ...args] = request.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) ?? ["pwd"];
  const event = await runner.run({
    task_id: request.task_id,
    project_id: request.project_id,
    worker_id: request.worker_id,
    ...commandRuntimeFields(runtimeMetadata),
    command: bin || "pwd",
    args,
    cwd: request.cwd,
    workspace_path: request.workspace_path,
    approved_by_user: request.approved_by_user,
    timeout_ms: 120_000,
  });
  await post(`/workers/${encodeURIComponent(request.worker_id)}/events`, event);
  await post(`/workers/${encodeURIComponent(request.worker_id)}/runtime-command-requests/${encodeURIComponent(request.request_id)}/result`, {
    status: event.exit_code === 0 ? "completed" : "failed",
    command_event_id: event.event_id,
    error: event.exit_code === 0 ? null : event.stderr_preview || event.stdout_preview || event.summary,
  });
  process.stdout.write(`Runtime command request ${request.request_id} completed with event ${event.event_id}.\n`);
}

async function runAssignedTask(assignedWorkerId: string, assignedTaskId: string, assignedProjectId: string) {
  const runtimeMetadata = workerRuntimeMetadata(assignedTaskId, assignedProjectId);
  const claim = await post(`/workers/${encodeURIComponent(assignedWorkerId)}/claim-task`, runtimeMetadata) as ClaimTaskPayload | undefined;
  if (claim && !["claimed", "claimed_after_abandoning_previous", "already_running"].includes(claim.decision)) {
    process.stdout.write(`Worker ${assignedWorkerId} did not start task ${assignedTaskId}: ${claim.reason}\n`);
    return;
  }
  if (claim?.decision === "already_running") {
    process.stdout.write(`Worker ${assignedWorkerId} is continuing already claimed task ${assignedTaskId}: ${claim.reason}\n`);
  }
  await post(`/workers/${encodeURIComponent(assignedWorkerId)}/heartbeat`, runtimeMetadata);
  process.stdout.write(`Heartbeat posted successfully for claimed worker ${assignedWorkerId}.\n`);

  const [{ task }, { project }] = await Promise.all([
    get<TaskPayload>(`/tasks/${encodeURIComponent(assignedTaskId)}`),
    get<ProjectPayload>(`/projects/${encodeURIComponent(assignedProjectId)}`),
  ]);
  const projectWorkspace = task.worktree_path || project.workspace_path || project.workspace_uri || workspacePath;
  await restoreProjectArtifacts(assignedProjectId, projectWorkspace);
  const beforeFiles = new Set(listProjectFiles(projectWorkspace));
  const context = await loadWorkerContext(task);
  const { CommandRunner } = await import("./command-runner.js");
  const runner = new CommandRunner();

  const schemaPath = buildWorkerSchemaFile(assignedTaskId);
  const codexPrompt = await buildCodexPrompt(task, project);
  await validateCodexAuthForCommand(process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND || "codex");
  const codexEvent = await runner.run({
    task_id: assignedTaskId,
    project_id: assignedProjectId,
    worker_id: assignedWorkerId,
    ...commandRuntimeFields(runtimeMetadata),
    command: process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND || "codex",
    args: [
      "exec",
      "--json",
      "--output-schema",
      schemaPath,
      "-C",
      projectWorkspace,
      "--skip-git-repo-check",
      "-s",
      "workspace-write",
      codexPrompt,
    ],
    cwd: projectWorkspace,
    workspace_path: projectWorkspace,
    timeout_ms: Number(process.env.HEAD_DEVELOPER_CODEX_TIMEOUT_MS || "600000"),
  });
  await attachCodexHistoryMetadata(codexEvent, codexPrompt);
  await post(`/workers/${encodeURIComponent(assignedWorkerId)}/events`, codexEvent);
  process.stdout.write(`Codex command event ${codexEvent.event_id} posted successfully.\n`);
  const materializeEvent = await materializeCodexFiles({
    taskId: assignedTaskId,
    projectId: assignedProjectId,
    workerId: assignedWorkerId,
    projectWorkspace,
    runtimeMetadata,
    codexEvent,
  });
  if (materializeEvent && materializeEvent.exit_code !== 0) {
    process.stdout.write(`Codex file materialization failed with event ${materializeEvent.event_id}.\n`);
  }

  const afterFiles = listProjectFiles(projectWorkspace);
  const createdFiles = afterFiles.filter((file) => !beforeFiles.has(file));
  const hasGitRepository = fs.existsSync(path.join(projectWorkspace, ".git"));
  const gitStatusEvent = await runner.run({
    task_id: assignedTaskId,
    project_id: assignedProjectId,
    worker_id: assignedWorkerId,
    ...commandRuntimeFields(runtimeMetadata),
    command: hasGitRepository ? "git" : "node",
    args: hasGitRepository
      ? ["status", "--short", "."]
      : ["--version"],
    cwd: projectWorkspace,
    workspace_path: projectWorkspace,
    timeout_ms: 60_000,
  });
  const reportedFiles = safeReportedFiles(extractFinalWorkerJson(commandStdout(codexEvent))?.files_modified, projectWorkspace);
  const gitStatusFiles = hasGitRepository ? extractGitStatusFiles(gitStatusEvent, projectWorkspace) : [];
  const changedFiles = [...new Set([...createdFiles, ...reportedFiles, ...gitStatusFiles])].sort();
  if (changedFiles.length) gitStatusEvent.summary = changedFiles.map((file) => `created: ${file}`).join("\n");
  await post(`/workers/${encodeURIComponent(assignedWorkerId)}/events`, gitStatusEvent);
  process.stdout.write(`File status command event ${gitStatusEvent.event_id} posted successfully.\n`);

  const jsFiles = afterFiles.filter((file) => /\.(js|mjs|cjs)$/i.test(file));
  const validationEvents = [];
  for (const jsFile of jsFiles.length ? jsFiles : []) {
    const event = await runner.run({
      task_id: assignedTaskId,
      project_id: assignedProjectId,
      worker_id: assignedWorkerId,
      ...commandRuntimeFields(runtimeMetadata),
      command: "node",
      args: ["--check", jsFile],
      cwd: projectWorkspace,
      workspace_path: projectWorkspace,
      timeout_ms: 60_000,
    });
    await post(`/workers/${encodeURIComponent(assignedWorkerId)}/events`, event);
    validationEvents.push(event);
    process.stdout.write(`Validation command event ${event.event_id} posted successfully.\n`);
  }

  const outputValidation = validateAppOutput({
    workspacePath: projectWorkspace,
    allFiles: afterFiles,
    changedFiles,
    taskGoal: task.user_goal,
    context,
    validationEvents,
  });
  const failedValidation = validationEvents.find((event) => event.exit_code !== 0);
  const materializationSummary = materializeEvent
    ? `materialization command ${materializeEvent.event_id} exit ${materializeEvent.exit_code}`
    : "no materialization command was produced";
  const materializationPassed = Boolean(materializeEvent && materializeEvent.exit_code === 0);
  const directWritePassed = !materializeEvent && changedFiles.length > 0;
  const outputWritesPassed = materializationPassed || directWritePassed;
  const initialStatus = codexEvent.exit_code === 0 && outputWritesPassed && !failedValidation && outputValidation.passed && afterFiles.length > 0 ? "completed" : "failed";
  let artifactResult: Awaited<ReturnType<typeof persistProjectArtifacts>> = { uploaded: 0, skipped: true };
  if (initialStatus === "completed") {
    artifactResult = await persistProjectArtifacts({
      workerId: assignedWorkerId,
      taskId: assignedTaskId,
      projectId: assignedProjectId,
      projectWorkspace,
      changedFiles,
      allFiles: afterFiles,
    }).catch((error) => {
      process.stderr.write(`Project artifact upload failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return { uploaded: 0, skipped: false };
    });
  }
  const status = initialStatus === "completed" && workerType === "gke_job" && !artifactResult.skipped && artifactResult.uploaded <= 0 ? "failed" : initialStatus;
  const artifactSummary = workerType === "gke_job"
    ? artifactResult.skipped
      ? "No project artifacts were uploaded."
      : `Uploaded ${artifactResult.uploaded} project artifact file(s).`
    : "";
  const summary = status === "completed"
    ? directWritePassed
      ? `Codex wrote files directly for ${task.user_goal}; no materialization command was produced, but changed files were observed and validation passed. Changed files: ${changedFiles.join(", ")}. ${outputValidation.summary} ${artifactSummary}`.trim()
      : `Codex produced structured file contents for ${task.user_goal}; the worker materialized those contents through logged ${materializationSummary}. Changed files: ${(changedFiles.length ? changedFiles : afterFiles).join(", ")}. ${outputValidation.summary} ${artifactSummary}`.trim()
    : `Codex/materialization did not complete cleanly. Codex command ${codexEvent.event_id} exit: ${codexEvent.exit_code}; ${materializationSummary}; validation exit: ${failedValidation?.exit_code ?? "none"}; files: ${afterFiles.length}. ${outputValidation.summary} ${artifactSummary}`.trim();
  await post(`/workers/${encodeURIComponent(assignedWorkerId)}/heartbeat`, {
    ...workerRuntimeMetadata(assignedTaskId, assignedProjectId),
  });
  await post(`/workers/${encodeURIComponent(assignedWorkerId)}/result`, {
    ...workerRuntimeMetadata(assignedTaskId, assignedProjectId),
    task_id: assignedTaskId,
    status,
    summary,
    next_steps: status === "completed"
      ? ["Preview the generated landing page.", "Deploy after approval if the user wants it public."]
      : ["Inspect the failed command output.", "Retry the task after fixing the blocker."],
  });
  process.stdout.write(`Task result posted successfully for task ${assignedTaskId}.\n`);
}

async function runSingleCommand() {
  await post(`/workers/${encodeURIComponent(workerId)}/heartbeat`, {
    ...workerRuntimeMetadata(taskId, projectId),
  });
  process.stdout.write(`Heartbeat posted successfully for worker ${workerId}.\n`);
  const { CommandRunner } = await import("./command-runner.js");
  const runner = new CommandRunner();
  const [bin, ...args] = command.split(/\s+/).filter(Boolean);
  await validateCodexAuthForCommand(bin || "pwd");
  const event = await runner.run({
    task_id: taskId,
    project_id: projectId,
    worker_id: workerId,
    ...commandRuntimeFields(workerRuntimeMetadata(taskId, projectId)),
    command: bin || "pwd",
    args,
    cwd: workspacePath,
    workspace_path: workspacePath,
    timeout_ms: 120_000,
  });
  await post(`/workers/${encodeURIComponent(workerId)}/events`, event);
  process.stdout.write(`Command event ${event.event_id} posted successfully.\n`);
  await post(`/workers/${encodeURIComponent(workerId)}/result`, {
    ...workerRuntimeMetadata(taskId, projectId),
    task_id: taskId,
    status: event.exit_code === 0 ? "completed" : "failed",
    summary: event.summary,
  });
  process.stdout.write(`Task result posted successfully for task ${taskId}.\n`);
}

function assignedWorkerPollKey(worker: WorkersPayload["workers"][number], task: TaskRecord) {
  return `${worker.worker_id}:${worker.task_id ?? ""}:${task.updated_at || task.created_at || ""}:${task.status}`;
}

async function findRunnableAssignedWorker(workers: WorkersPayload["workers"], completed: Set<string>): Promise<RunnableAssignedWorker | null> {
  const { shouldPollWorkerForTask } = await import("./worker-task-guard.js");
  const pinnedWorkerId = process.env.HEAD_DEVELOPER_WORKER_ID && process.env.HEAD_DEVELOPER_WORKER_ID !== "local-worker"
    ? process.env.HEAD_DEVELOPER_WORKER_ID
    : "";
  for (const item of workers) {
    if (item.type !== workerType) continue;
    if (pinnedWorkerId && item.worker_id !== pinnedWorkerId) continue;
    if (!item.task_id || !item.project_id) continue;
    const payload = await get<TaskPayload>(`/tasks/${encodeURIComponent(item.task_id)}`).catch((error) => {
      process.stderr.write(`Task inspection failed for ${item.task_id}: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    });
    if (!payload?.task) {
      completed.add(`${item.worker_id}:${item.task_id}:missing`);
      continue;
    }
    const pollKey = assignedWorkerPollKey(item, payload.task);
    if (completed.has(pollKey)) continue;
    if (!shouldPollWorkerForTask(item as WorkerRecord, payload?.task ?? null)) {
      completed.add(pollKey);
      continue;
    }
    return { worker: item, task: payload.task, pollKey };
  }
  return null;
}

async function pollForAssignedTasks() {
  const completed = new Set<string>();
  process.stdout.write("Docker local worker poller is waiting for assigned tasks.\n");
  while (true) {
    if (workerId !== "local-worker") {
      const runtimeRequest = await post(`/workers/${encodeURIComponent(workerId)}/runtime-command-requests/next`, {
        ...workerRuntimeMetadata(taskId, projectId),
      }).catch((error) => {
        process.stderr.write(`Runtime command request poll failed for ${workerId}: ${error instanceof Error ? error.message : String(error)}\n`);
        return null;
      }) as RuntimeCommandRequestPayload | null;
      if (runtimeRequest?.request) {
        await runRuntimeCommandRequest(runtimeRequest.request).catch((error) => {
          process.stderr.write(`Runtime command request ${runtimeRequest.request?.request_id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
    }
    const payload = await get<WorkersPayload>("/workers").catch((error) => {
      process.stderr.write(`Worker poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return { workers: [] };
    });
    const runnable = await findRunnableAssignedWorker(payload.workers, completed);
    const worker = runnable?.worker;
    if (worker?.task_id && worker.project_id && runnable) {
      completed.add(runnable.pollKey);
      try {
        await runAssignedTask(worker.worker_id, worker.task_id, worker.project_id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        await post(`/workers/${encodeURIComponent(worker.worker_id)}/result`, {
          ...workerRuntimeMetadata(worker.task_id, worker.project_id),
          task_id: worker.task_id,
          status: "failed",
          summary: message,
        }).catch(() => undefined);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function main() {
  setWorkerRuntimeDefaults();
  prepareWritableCodexHome();
  if (pollForTasks) {
    if (workerType === "gcp_vm" || workerType === "gke_job") await validateCodexAuth();
    await pollForAssignedTasks();
    return;
  }
  if (command) {
    await runSingleCommand();
    return;
  }
  await runAssignedTask(workerId, taskId, projectId);
  if (workerType === "gcp_vm" || workerType === "gke_job") process.exit(0);
}

const isMainModule = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMainModule) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    void post(`/workers/${encodeURIComponent(workerId)}/result`, {
      ...workerRuntimeMetadata(taskId, projectId),
      task_id: taskId,
      status: "failed",
      summary: message,
    }).catch(() => undefined).finally(() => {
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
  });
}
