import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { vertexSupervisorConfigurationError } from "./model-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(prototypeRoot, "..");
const initialEnvKeys = new Set(Object.keys(process.env));

function loadEnvFile(filePath: string, options: { override?: boolean } = {}) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    if (!key) continue;
    if (initialEnvKeys.has(key)) continue;
    if (!options.override && process.env[key] !== undefined) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

if (process.env.CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES !== "1") {
  loadEnvFile(path.join(repoRoot, ".env"));
  loadEnvFile(path.join(repoRoot, ".env.codex-phone-supervisor"), { override: true });
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Set it in .env or the process environment.`);
  return value;
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() ?? "";
}

function requireNumberEnv(name: string) {
  const raw = requireEnv(name);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function requireBooleanEnv(name: string) {
  const raw = requireEnv(name).toLowerCase();
  if (["1", "true"].includes(raw)) return true;
  if (["0", "false"].includes(raw)) return false;
  throw new Error(`${name} must be one of: 1, 0, true, false.`);
}

function resolveFromRepo(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const storeDir = resolveFromRepo(requireEnv("CODEX_PHONE_SUPERVISOR_STORE_DIR"));
const testMode = requireBooleanEnv("CODEX_PHONE_SUPERVISOR_TEST_MODE");
const validateTwilioSignatures = requireBooleanEnv("TWILIO_VALIDATE_SIGNATURES");
const twilioSmsEnabled = requireBooleanEnv("TWILIO_SMS_ENABLED");
const twilioVoiceEnabled = requireBooleanEnv("TWILIO_VOICE_ENABLED");
const twilioAuthToken = optionalEnv("TWILIO_AUTH_TOKEN");
const twilioAccountSid = optionalEnv("TWILIO_ACCOUNT_SID");
const twilioMessagingServiceSid = optionalEnv("TWILIO_MESSAGING_SERVICE_SID");
const twilioFromNumber = optionalEnv("TWILIO_FROM_NUMBER");
const publicBaseUrl = optionalEnv("CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL");
const conversationRelayWsUrl = optionalEnv("TWILIO_CONVERSATION_RELAY_WS_URL");
const supervisorModelProvider = optionalEnv("SUPERVISOR_MODEL_PROVIDER") || "vertex";
const testSupervisorModelDouble = optionalEnv("CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL");
const defaultWorkspacePath = resolveFromRepo(requireEnv("CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH"));
const newProjectsRoot = resolveFromRepo(requireEnv("CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT"));
const terminalEnabled = requireBooleanEnv("CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED");
const desktopTerminalEnabled = requireBooleanEnv("CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED");
const projectRoots = requireEnv("CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS")
  .split(",")
  .map((root) => resolveFromRepo(root.trim()))
  .filter(Boolean);
const allowedOrigins = requireEnv("CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function workerModeEnv(name: string, fallback: "local" | "docker_local" | "gcp_vm" | "gke_job") {
  const value = optionalEnv(name);
  if (!value) return fallback;
  if (value === "local" || value === "docker_local" || value === "gcp_vm" || value === "gke_job") return value;
  throw new Error(`${name} must be one of: local, docker_local, gcp_vm, gke_job.`);
}

function optionalBooleanEnv(name: string, fallback: boolean) {
  const raw = optionalEnv(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true"].includes(raw)) return true;
  if (["0", "false"].includes(raw)) return false;
  throw new Error(`${name} must be one of: 1, 0, true, false.`);
}

function optionalNumberEnv(name: string, fallback: number) {
  const raw = optionalEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number.`);
  return value;
}

function stateStoreTypeEnv() {
  const value = optionalEnv("HEAD_DEVELOPER_STATE_STORE") || optionalEnv("STATE_STORE");
  if (!value) return optionalEnv("K_SERVICE") ? "firestore" : "file";
  if (value === "file" || value === "memory" || value === "firestore") return value;
  throw new Error("HEAD_DEVELOPER_STATE_STORE must be one of: file, memory, firestore.");
}

function codexAuthMethodEnv() {
  const value = optionalEnv("HEAD_DEVELOPER_CODEX_AUTH_METHOD");
  if (!value) return "none";
  if (["none", "codex_home_bundle", "secret_manager_api_key"].includes(value)) return value;
  throw new Error("HEAD_DEVELOPER_CODEX_AUTH_METHOD must be one of: none, codex_home_bundle, secret_manager_api_key.");
}

if (validateTwilioSignatures && !twilioAuthToken) {
  throw new Error("TWILIO_AUTH_TOKEN is required when TWILIO_VALIDATE_SIGNATURES is enabled.");
}

if (validateTwilioSignatures && !publicBaseUrl) {
  throw new Error("CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL is required when TWILIO_VALIDATE_SIGNATURES is enabled.");
}

if (twilioVoiceEnabled && !conversationRelayWsUrl) {
  throw new Error("TWILIO_CONVERSATION_RELAY_WS_URL is required when TWILIO_VOICE_ENABLED is enabled.");
}

if (conversationRelayWsUrl) {
  const relayUrl = new URL(conversationRelayWsUrl);
  const allowedProtocols = testMode ? ["ws:", "wss:"] : ["wss:"];
  if (!allowedProtocols.includes(relayUrl.protocol)) {
    throw new Error(testMode ? "TWILIO_CONVERSATION_RELAY_WS_URL must use ws:// or wss://." : "TWILIO_CONVERSATION_RELAY_WS_URL must use wss:// outside test mode.");
  }
}

if (!allowedOrigins.length) {
  throw new Error("CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS must include at least one origin.");
}

if (!projectRoots.length) {
  throw new Error("CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS must include at least one root.");
}

if (!["vertex", "gcp_conversation_ai", "nvidia_nim", "openai"].includes(supervisorModelProvider)) {
  throw new Error("SUPERVISOR_MODEL_PROVIDER must be one of: vertex, gcp_conversation_ai, nvidia_nim, openai.");
}

if (testSupervisorModelDouble) {
  if (!testMode) throw new Error("CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL requires CODEX_PHONE_SUPERVISOR_TEST_MODE=1.");
  if (testSupervisorModelDouble !== "deterministic") throw new Error("CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL must be deterministic when set.");
}

if (supervisorModelProvider === "vertex") {
  for (const name of ["VERTEX_PROJECT_ID", "VERTEX_LOCATION", "VERTEX_MODEL"]) {
    if (!testSupervisorModelDouble) {
      const value = optionalEnv(name);
      if (!value) throw new Error(vertexSupervisorConfigurationError);
    }
  }
}

if (supervisorModelProvider === "gcp_conversation_ai") {
  for (const name of [
    "GCP_CONVERSATION_PROJECT_ID",
    "GCP_CONVERSATION_LOCATION",
    "GCP_CONVERSATION_AGENT_ID",
    "GCP_CONVERSATION_LANGUAGE_CODE",
    "GCP_CONVERSATION_API_ENDPOINT",
  ]) {
    requireEnv(name);
  }
}

if (supervisorModelProvider === "nvidia_nim") {
  for (const name of ["NVIDIA_NIM_BASE_URL", "NVIDIA_NIM_MODEL", "NVIDIA_NIM_API_KEY"]) {
    requireEnv(name);
  }
  const nimBaseUrl = new URL(requireEnv("NVIDIA_NIM_BASE_URL"));
  if (nimBaseUrl.protocol === "http:" && !requireBooleanEnv("NVIDIA_NIM_ALLOW_INSECURE_HTTP")) {
    throw new Error("NVIDIA_NIM_ALLOW_INSECURE_HTTP=1 is required when NVIDIA_NIM_BASE_URL uses http://.");
  }
  if (nimBaseUrl.protocol !== "http:" && nimBaseUrl.protocol !== "https:") {
    throw new Error("NVIDIA_NIM_BASE_URL must use http:// or https://.");
  }
}

if (supervisorModelProvider === "openai") {
  for (const name of ["OPENAI_API_KEY", "OPENAI_MODEL"]) {
    requireEnv(name);
  }
}

const stateStoreType = stateStoreTypeEnv();
const firestoreProjectId = optionalEnv("FIRESTORE_PROJECT_ID") || optionalEnv("GOOGLE_CLOUD_PROJECT") || optionalEnv("GCP_PROJECT_ID");
if (stateStoreType === "firestore" && !firestoreProjectId) {
  throw new Error("FIRESTORE_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GCP_PROJECT_ID is required when HEAD_DEVELOPER_STATE_STORE=firestore.");
}

function splitArgs(value: string) {
  if (!value.trim()) return [];
  return value.split(" ").map((item) => item.trim()).filter(Boolean);
}

function isLoopbackHost(value: string) {
  return ["127.0.0.1", "localhost", "::1"].includes(value);
}

for (const directory of [defaultWorkspacePath, ...projectRoots]) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Configured workspace/project root is not an existing directory: ${directory}`);
  }
}

if (!fs.existsSync(newProjectsRoot) || !fs.statSync(newProjectsRoot).isDirectory()) {
  throw new Error(`CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT is not an existing directory: ${newProjectsRoot}`);
}

const realDefaultWorkspacePath = fs.realpathSync(defaultWorkspacePath);
const realNewProjectsRoot = fs.realpathSync(newProjectsRoot);
if (!isWithinDirectory(realNewProjectsRoot, realDefaultWorkspacePath)) {
  throw new Error("CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT must be inside CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH.");
}

const terminal = terminalEnabled
  ? {
      enabled: true,
      shell: requireEnv("CODEX_PHONE_SUPERVISOR_TERMINAL_SHELL"),
      shellArgs: splitArgs(optionalEnv("CODEX_PHONE_SUPERVISOR_TERMINAL_SHELL_ARGS")),
      cwd: resolveFromRepo(requireEnv("CODEX_PHONE_SUPERVISOR_TERMINAL_CWD")),
      path: requireEnv("CODEX_PHONE_SUPERVISOR_TERMINAL_PATH"),
      wsPath: requireEnv("CODEX_PHONE_SUPERVISOR_TERMINAL_WS_PATH"),
      allowRemote: requireBooleanEnv("CODEX_PHONE_SUPERVISOR_TERMINAL_ALLOW_REMOTE"),
    }
  : {
      enabled: false,
      shell: "",
      shellArgs: [] as string[],
      cwd: "",
      path: "",
      wsPath: "",
      allowRemote: false,
    };

if (terminal.enabled) {
  if (!fs.existsSync(terminal.shell) || !fs.statSync(terminal.shell).isFile()) {
    throw new Error(`CODEX_PHONE_SUPERVISOR_TERMINAL_SHELL is not an existing file: ${terminal.shell}`);
  }
  if (!fs.existsSync(terminal.cwd) || !fs.statSync(terminal.cwd).isDirectory()) {
    throw new Error(`CODEX_PHONE_SUPERVISOR_TERMINAL_CWD is not an existing directory: ${terminal.cwd}`);
  }
  if (!isWithinDirectory(fs.realpathSync(terminal.cwd), realDefaultWorkspacePath)) {
    throw new Error("CODEX_PHONE_SUPERVISOR_TERMINAL_CWD must be inside CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH.");
  }
  if (!terminal.wsPath.startsWith("/")) {
    throw new Error("CODEX_PHONE_SUPERVISOR_TERMINAL_WS_PATH must start with '/'.");
  }
  if (!terminal.allowRemote && !isLoopbackHost(requireEnv("CODEX_PHONE_SUPERVISOR_HOST"))) {
    throw new Error("CODEX_PHONE_SUPERVISOR_TERMINAL_ALLOW_REMOTE=1 is required when terminal is enabled on a non-loopback host.");
  }
}

const desktopTerminal = desktopTerminalEnabled
  ? {
      enabled: true,
      osascriptCommand: requireEnv("CODEX_PHONE_SUPERVISOR_OSASCRIPT_COMMAND"),
      appId: requireEnv("CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_APP_ID"),
      path: requireEnv("CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_PATH"),
      launchTimeoutMs: requireNumberEnv("CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_LAUNCH_TIMEOUT_MS"),
    }
  : {
      enabled: false,
      osascriptCommand: "",
      appId: "",
      path: "",
      launchTimeoutMs: 0,
    };

if (desktopTerminal.enabled) {
  if (!fs.existsSync(desktopTerminal.osascriptCommand) || !fs.statSync(desktopTerminal.osascriptCommand).isFile()) {
    throw new Error(`CODEX_PHONE_SUPERVISOR_OSASCRIPT_COMMAND is not an existing file: ${desktopTerminal.osascriptCommand}`);
  }
  if (!desktopTerminal.appId.trim()) {
    throw new Error("CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_APP_ID is required when desktop terminal launch is enabled.");
  }
  if (desktopTerminal.launchTimeoutMs <= 0) {
    throw new Error("CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_LAUNCH_TIMEOUT_MS must be greater than 0.");
  }
  if (!isLoopbackHost(requireEnv("CODEX_PHONE_SUPERVISOR_HOST"))) {
    throw new Error("Desktop terminal launch is only allowed when CODEX_PHONE_SUPERVISOR_HOST is loopback.");
  }
}

export const config = {
  prototypeRoot,
  repoRoot,
  host: requireEnv("CODEX_PHONE_SUPERVISOR_HOST"),
  port: requireNumberEnv("CODEX_PHONE_SUPERVISOR_PORT"),
  defaultWorkspacePath,
  newProjectsRoot,
  projectRoots,
  codexCommand: requireEnv("CODEX_PHONE_SUPERVISOR_CODEX_COMMAND"),
  codexHome: requireEnv("CODEX_PHONE_SUPERVISOR_CODEX_HOME"),
  storePath: path.join(storeDir, "sessions.json"),
  telephonyStorePath: path.join(storeDir, "telephony.json"),
  auditLogPath: path.join(storeDir, "audit-log.jsonl"),
  runtimeDir: path.join(storeDir, "runtime"),
  artifactsDir: path.join(storeDir, "artifacts"),
  stateStore: {
    type: stateStoreType,
    firestoreProjectId,
    firestoreDatabaseId: optionalEnv("FIRESTORE_DATABASE_ID") || optionalEnv("FIRESTORE_DATABASE") || "(default)",
    firestoreCollectionPrefix: optionalEnv("FIRESTORE_COLLECTION_PREFIX") || `head_developer_${optionalEnv("HEAD_DEVELOPER_ENV") || (testMode ? "dev" : "prod")}`,
  },
  storeLockTimeoutMs: requireNumberEnv("CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS"),
  storeLockRetryMs: requireNumberEnv("CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS"),
  frontendDistDir: resolveFromRepo(requireEnv("CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR")),
  allowedOrigins,
  publicBaseUrl,
  conversationRelayWsUrl,
  twilioSmsEnabled,
  twilioVoiceEnabled,
  validateTwilioSignatures,
  twilioAuthToken,
  twilioAccountSid,
  twilioMessagingServiceSid,
  twilioFromNumber,
  terminal,
  desktopTerminal,
  testMode,
  supervisorModelProvider,
  testSupervisorModelDouble: testSupervisorModelDouble || null,
  gcpConversationAi: {
    projectId: optionalEnv("GCP_CONVERSATION_PROJECT_ID"),
    location: optionalEnv("GCP_CONVERSATION_LOCATION"),
    agentId: optionalEnv("GCP_CONVERSATION_AGENT_ID"),
    languageCode: optionalEnv("GCP_CONVERSATION_LANGUAGE_CODE"),
    apiEndpoint: optionalEnv("GCP_CONVERSATION_API_ENDPOINT"),
    environmentId: optionalEnv("GCP_CONVERSATION_ENVIRONMENT_ID"),
  },
  nvidiaNim: {
    baseUrl: optionalEnv("NVIDIA_NIM_BASE_URL"),
    model: optionalEnv("NVIDIA_NIM_MODEL"),
    apiKeyPresent: Boolean(optionalEnv("NVIDIA_NIM_API_KEY")),
    apiKey: optionalEnv("NVIDIA_NIM_API_KEY"),
    allowInsecureHttp: optionalEnv("NVIDIA_NIM_ALLOW_INSECURE_HTTP") === "1" || optionalEnv("NVIDIA_NIM_ALLOW_INSECURE_HTTP").toLowerCase() === "true",
  },
  vertex: {
    projectId: optionalEnv("VERTEX_PROJECT_ID"),
    location: optionalEnv("VERTEX_LOCATION"),
    model: optionalEnv("VERTEX_MODEL"),
  },
  openai: {
    model: optionalEnv("OPENAI_MODEL"),
    apiKeyPresent: Boolean(optionalEnv("OPENAI_API_KEY")),
  },
  modelProviders: {
    supervisor_model_provider: supervisorModelProvider === "vertex" ? "Vertex/Gemini" : supervisorModelProvider,
    planner_model_provider: supervisorModelProvider === "vertex" ? "Vertex/Gemini" : supervisorModelProvider,
    worker_code_model: "Codex CLI",
  },
  orchestrator: {
    environment: optionalEnv("HEAD_DEVELOPER_ENV") || (testMode ? "dev" : "prod"),
    workerMode: workerModeEnv("WORKER_MODE", workerModeEnv("HEAD_DEVELOPER_WORKER_MODE", "local")),
    defaultWorkerType: workerModeEnv("DEFAULT_WORKER_MODE", workerModeEnv("HEAD_DEVELOPER_DEFAULT_WORKER_TYPE", "local")),
    allowWorkerModeSwitch: optionalBooleanEnv("ALLOW_WORKER_MODE_SWITCH", true),
    maxLocalWorkers: optionalNumberEnv("MAX_LOCAL_WORKERS", 1),
    maxDockerLocalWorkers: optionalNumberEnv("MAX_DOCKER_LOCAL_WORKERS", 3),
    maxGcpVmWorkers: optionalNumberEnv("MAX_GCP_VM_WORKERS", 10),
    maxGkeJobWorkers: optionalNumberEnv("MAX_GKE_JOB_WORKERS", 5),
    maxParallelWorkers: optionalNumberEnv("MAX_PARALLEL_WORKERS", 3),
    defaultComplexTaskWorkers: optionalNumberEnv("DEFAULT_COMPLEX_TASK_WORKERS", 2),
    allowParallelWorkers: optionalBooleanEnv("ALLOW_PARALLEL_WORKERS", true),
    requireApprovalForGcpMultiWorker: optionalBooleanEnv("REQUIRE_APPROVAL_FOR_GCP_MULTI_WORKER", true),
    maxActiveWorkers: Number(optionalEnv("HEAD_DEVELOPER_MAX_ACTIVE_WORKERS") || "5"),
    maxWorkerLifetimeMs: Number(optionalEnv("HEAD_DEVELOPER_MAX_WORKER_LIFETIME_MS") || String(60 * 60 * 1000)),
    workerImageUri: optionalEnv("HEAD_DEVELOPER_WORKER_IMAGE_URI"),
    apiCallbackUrl: optionalEnv("HEAD_DEVELOPER_API_CALLBACK_URL") || publicBaseUrl,
    gcpVmDryRun: optionalEnv("HEAD_DEVELOPER_GCP_VM_DRY_RUN") === "1" || optionalEnv("HEAD_DEVELOPER_GCP_VM_DRY_RUN").toLowerCase() === "true",
  },
  codexAuth: {
    method: codexAuthMethodEnv(),
    homePath: optionalEnv("HEAD_DEVELOPER_CODEX_HOME") || "/codex-home",
    homeBundleSecret: optionalEnv("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET"),
    homeBundleSecretProject: optionalEnv("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_PROJECT"),
    homeBundleSecretVersion: optionalEnv("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_VERSION") || "latest",
    homeBundleGcsUri: optionalEnv("HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI"),
    apiKeySecret: optionalEnv("HEAD_DEVELOPER_CODEX_API_KEY_SECRET"),
    apiKeySecretProject: optionalEnv("HEAD_DEVELOPER_CODEX_API_KEY_SECRET_PROJECT"),
    apiKeySecretVersion: optionalEnv("HEAD_DEVELOPER_CODEX_API_KEY_SECRET_VERSION") || "latest",
  },
  gcp: {
    projectId: optionalEnv("GCP_PROJECT_ID"),
    region: optionalEnv("GCP_REGION") || "us-central1",
    zone: optionalEnv("GCP_ZONE") || "us-central1-a",
    workerMachineType: optionalEnv("HEAD_DEVELOPER_GCP_WORKER_MACHINE_TYPE") || "e2-standard-2",
    workerImageFamily: optionalEnv("HEAD_DEVELOPER_GCP_WORKER_IMAGE_FAMILY") || "cos-stable",
    workerImageProject: optionalEnv("HEAD_DEVELOPER_GCP_WORKER_IMAGE_PROJECT") || "cos-cloud",
    workerServiceAccountEmail:
      optionalEnv("HEAD_DEVELOPER_WORKER_SERVICE_ACCOUNT_EMAIL") ||
      (optionalEnv("GCP_PROJECT_ID") ? `worker-vm-sa@${optionalEnv("GCP_PROJECT_ID")}.iam.gserviceaccount.com` : undefined),
    network: optionalEnv("HEAD_DEVELOPER_GCP_NETWORK") || "default",
    subnetwork: optionalEnv("HEAD_DEVELOPER_GCP_SUBNETWORK"),
  },
  gke: {
    clusterName: optionalEnv("HEAD_DEVELOPER_GKE_CLUSTER_NAME") || "head-developer-workers",
    location: optionalEnv("HEAD_DEVELOPER_GKE_LOCATION") || optionalEnv("GCP_REGION") || "us-central1",
    namespace: optionalEnv("HEAD_DEVELOPER_GKE_NAMESPACE") || "head-developer-workers",
    kubernetesServiceAccount: optionalEnv("HEAD_DEVELOPER_GKE_KSA") || "head-developer-worker",
    googleServiceAccount:
      optionalEnv("HEAD_DEVELOPER_GKE_GSA") ||
      (optionalEnv("GCP_PROJECT_ID") ? `gke-worker-sa@${optionalEnv("GCP_PROJECT_ID")}.iam.gserviceaccount.com` : undefined),
    jobTtlSecondsAfterFinished: optionalNumberEnv("HEAD_DEVELOPER_GKE_JOB_TTL_SECONDS", 900),
    jobActiveDeadlineSeconds: optionalNumberEnv("HEAD_DEVELOPER_GKE_JOB_ACTIVE_DEADLINE_SECONDS", 3600),
    dryRun: optionalEnv("HEAD_DEVELOPER_GKE_JOB_DRY_RUN") === "1" || optionalEnv("HEAD_DEVELOPER_GKE_JOB_DRY_RUN").toLowerCase() === "true",
  },
};
