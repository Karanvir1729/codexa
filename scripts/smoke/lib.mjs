import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const smokeDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(smokeDir, "..", "..");
export const composeFile = path.join(repoRoot, "docker", "docker-compose.local.yml");
export const smokeStateDir = path.join(repoRoot, "tmp", "smoke");
export const defaultApiBase = process.env.SMOKE_API_BASE || "http://127.0.0.1:4317";
export const containerWorkspaceRoot = process.env.SMOKE_CONTAINER_WORKSPACE_ROOT || "/workspace";

let cachedAuthHeaders = null;

export function log(message) {
  process.stdout.write(`${message}\n`);
}

export function fail(message) {
  throw new Error(message);
}

export function assertSmoke(condition, message) {
  if (!condition) fail(message);
}

export function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export function uniqueSmokeName(prefix) {
  return `${prefix}-${timestampId()}-${randomUUID().slice(0, 8)}`;
}

export function sanitizeLabel(value, max = 63) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "smoke";
}

export function createSmokeWorkspace(prefix) {
  const name = uniqueSmokeName(prefix);
  const hostPath = path.join(smokeStateDir, name);
  fs.mkdirSync(hostPath, { recursive: true });
  return {
    name,
    hostPath,
    containerPath: hostToContainerPath(hostPath),
  };
}

export function hostToContainerPath(hostPath) {
  const relative = path.relative(repoRoot, path.resolve(hostPath)).replace(/\\/g, "/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`Host path is outside repo root and cannot be mapped into Docker workspace: ${hostPath}`);
  }
  return path.posix.join(containerWorkspaceRoot, relative);
}

export function containerToHostPath(containerPath) {
  const normalizedRoot = containerWorkspaceRoot.replace(/\/+$/, "");
  const normalized = String(containerPath).replace(/\\/g, "/");
  if (!normalized.startsWith(`${normalizedRoot}/`) && normalized !== normalizedRoot) {
    return null;
  }
  return path.join(repoRoot, path.posix.relative(normalizedRoot, normalized));
}

export function redact(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "sk-***")
    .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, "$1=***");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCommand(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const cwd = options.cwd ?? repoRoot;
  const stdio = options.stdio ?? "pipe";
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    }
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = { code, stdout, stderr, timedOut };
      if (code === 0 && !timedOut) resolve(result);
      else {
        const rendered = [command, ...args].join(" ");
        reject(new Error(`${rendered} failed with ${timedOut ? "timeout" : `exit ${code}`}\n${redact(stderr || stdout).slice(0, 4000)}`));
      }
    });
  });
}

async function apiAuthHeaders() {
  if (cachedAuthHeaders) return cachedAuthHeaders;
  if (process.env.SMOKE_API_BEARER_TOKEN) {
    cachedAuthHeaders = { Authorization: `Bearer ${process.env.SMOKE_API_BEARER_TOKEN}` };
    return cachedAuthHeaders;
  }
  const audience = process.env.SMOKE_API_ID_TOKEN_AUDIENCE || "";
  if (!audience) {
    cachedAuthHeaders = {};
    return cachedAuthHeaders;
  }
  let token;
  try {
    token = await runCommand("gcloud", ["auth", "print-identity-token", `--audiences=${audience}`], { timeoutMs: 30_000 });
  } catch {
    token = await runCommand("gcloud", ["auth", "print-identity-token"], { timeoutMs: 30_000 });
  }
  cachedAuthHeaders = { Authorization: `Bearer ${token.stdout.trim()}` };
  return cachedAuthHeaders;
}

export async function fetchJson(apiBase, requestPath, options = {}) {
  const url = requestPath.startsWith("http://") || requestPath.startsWith("https://")
    ? requestPath
    : `${apiBase.replace(/\/$/, "")}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`;
  const auth = await apiAuthHeaders();
  const headers = {
    "Content-Type": "application/json",
    ...auth,
    ...(options.headers ?? {}),
  };
  const method = String(options.method ?? "GET").toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  const attempts = mutation && process.env.SMOKE_API_RETRY_MUTATIONS !== "1"
    ? 1
    : Number(process.env.SMOKE_API_FETCH_ATTEMPTS || "3");
  let response;
  let text = "";
  let lastError = "";
  const requestTimeoutMs = Number(process.env.SMOKE_API_REQUEST_TIMEOUT_MS || "60000");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = requestTimeoutMs > 0 ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;
    try {
      response = await fetch(url, { ...options, headers, signal: controller.signal });
      text = await response.text();
      if (response.ok) break;
      lastError = `${response.status}: ${redact(text).slice(0, 1200)}`;
      if (attempt >= attempts) {
        fail(`${method} ${url} failed with ${lastError}`);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts) {
        fail(`${method} ${url} failed: ${redact(lastError).slice(0, 1200)}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    await sleep(500 * attempt);
  }
  if (!response?.ok) fail(`${method} ${url} failed: ${redact(lastError).slice(0, 1200)}`);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    fail(`${method} ${url} returned non-JSON: ${redact(text).slice(0, 1200)}`);
  }
}

export function apiGet(apiBase, requestPath) {
  return fetchJson(apiBase, requestPath, { method: "GET" });
}

export function apiPost(apiBase, requestPath, body = {}) {
  return fetchJson(apiBase, requestPath, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function waitForApi(apiBase = defaultApiBase, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await apiGet(apiBase, "/health");
      if (health?.ok) return health;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000);
  }
  fail(`API did not become healthy at ${apiBase}. Last error: ${redact(lastError)}`);
}

export async function ensureDockerCompose(workerCount) {
  if (process.env.SMOKE_SKIP_COMPOSE === "1" || process.env.SMOKE_COMPOSE_UP === "0") {
    log("Skipping docker compose startup because SMOKE_SKIP_COMPOSE=1 or SMOKE_COMPOSE_UP=0.");
    return;
  }
  if (process.env.SMOKE_RESET_COMPOSE_STATE === "1") {
    log("Resetting Docker Local compose state for an isolated smoke run...");
    await runCommand("docker", [
      "compose",
      "-f",
      composeFile,
      "down",
      "-v",
      "--remove-orphans",
    ], { stdio: "inherit", timeoutMs: Number(process.env.SMOKE_COMPOSE_TIMEOUT_MS || "600000") });
  }
  log(`Starting Docker Local stack with ${workerCount} worker container(s)...`);
  await runCommand("docker", [
    "compose",
    "-f",
    composeFile,
    "up",
    "-d",
    "--build",
    "--scale",
    `worker=${workerCount}`,
    "api",
    "frontend",
    "worker",
  ], { stdio: "inherit", timeoutMs: Number(process.env.SMOKE_COMPOSE_TIMEOUT_MS || "600000") });
}

export async function waitForTask(apiBase, taskId, options = {}) {
  const timeoutMs = options.timeoutMs ?? Number(process.env.SMOKE_TASK_TIMEOUT_MS || "900000");
  const intervalMs = options.intervalMs ?? 5000;
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    const payload = await apiGet(apiBase, `/tasks/${encodeURIComponent(taskId)}`);
    const task = payload?.task;
    if (!task) fail(`Task ${taskId} was not returned by API.`);
    if (task.status !== lastStatus) {
      log(`Task ${taskId}: ${task.status}`);
      lastStatus = task.status;
    }
    await options.onPoll?.(payload);
    if (["completed", "failed", "cancelled"].includes(task.status)) return payload;
    await sleep(intervalMs);
  }
  fail(`Timed out waiting for task ${taskId} to finish.`);
}

export async function waitForGraph(apiBase, graphId, options = {}) {
  const timeoutMs = options.timeoutMs ?? Number(process.env.SMOKE_GRAPH_TIMEOUT_MS || "1200000");
  const intervalMs = options.intervalMs ?? 5000;
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    const payload = await apiGet(apiBase, `/task-graphs/${encodeURIComponent(graphId)}`);
    const graph = payload?.task_graph;
    if (!graph) fail(`Task graph ${graphId} was not returned by API.`);
    if (graph.status !== lastStatus) {
      log(`Task graph ${graphId}: ${graph.status}`);
      lastStatus = graph.status;
    }
    await options.onPoll?.(payload);
    if (["completed", "failed", "cancelled"].includes(graph.status)) return payload;
    await sleep(intervalMs);
  }
  fail(`Timed out waiting for task graph ${graphId} to finish.`);
}

export async function taskCommands(apiBase, taskId) {
  const payload = await apiGet(apiBase, `/tasks/${encodeURIComponent(taskId)}/commands`);
  return payload?.commands ?? [];
}

export async function projectTasks(apiBase, projectId) {
  const payload = await apiGet(apiBase, `/projects/${encodeURIComponent(projectId)}/tasks`);
  return payload?.tasks ?? [];
}

export async function flowchart(apiBase) {
  return apiGet(apiBase, "/orchestrator/flowchart");
}

export function activeCodexCommands(commands) {
  return commands.filter((command) => command.exit_code === null && /\bcodex\s+exec\b/.test(command.command));
}

export async function assertNoDuplicateActiveCodex(apiBase, taskIds, observedMax = new Map()) {
  for (const taskId of taskIds) {
    const commands = await taskCommands(apiBase, taskId);
    const active = activeCodexCommands(commands);
    observedMax.set(taskId, Math.max(observedMax.get(taskId) ?? 0, active.length));
    assertSmoke(active.length <= 1, `Task ${taskId} has ${active.length} active Codex commands: ${active.map((item) => item.event_id).join(", ")}`);
  }
  return observedMax;
}

export function requireFiles(root, files) {
  for (const file of files) {
    const target = path.join(root, file);
    assertSmoke(fs.existsSync(target) && fs.statSync(target).isFile(), `Required file is missing: ${target}`);
  }
}

export async function nodeCheck(root, jsFile) {
  await runCommand(process.execPath, ["--check", jsFile], { cwd: root, timeoutMs: 60_000 });
}

export function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchText(url) {
  const auth = await apiAuthHeaders();
  const response = await fetch(url, { headers: auth });
  const text = await response.text();
  if (!response.ok) fail(`GET ${url} failed with ${response.status}: ${redact(text).slice(0, 1200)}`);
  return text;
}

export function writeLatestResult(name, payload) {
  fs.mkdirSync(smokeStateDir, { recursive: true });
  const target = path.join(smokeStateDir, `${name}.latest.json`);
  fs.writeFileSync(target, JSON.stringify(payload, null, 2));
  return target;
}

export function readLatestResult(name) {
  const target = path.join(smokeStateDir, `${name}.latest.json`);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

export function commandIdSummary(commands) {
  return commands.map((command) => ({
    command_id: command.event_id,
    task_id: command.task_id,
    worker_id: command.worker_id,
    command: command.command,
    exit_code: command.exit_code,
  }));
}

export function printJsonSummary(title, payload) {
  log(title);
  log(JSON.stringify(payload, null, 2));
}

export function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing required env: ${name}`);
  return value;
}
