import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import express from "express";
import http from "node:http";
import { config } from "./config.js";
import { createSession } from "./session.js";
import {
  appendAuditEvent,
  appendOrchestratorEvent,
  claimWorkerTask,
  getApprovalRequest,
  getOrchestratorSettings,
  getRunSummary,
  getSession,
  getTask,
  getTaskGraph,
  getWorkerContextPacket,
  getWorkerRuntimeCommandRequest,
  getWorker,
  listOperatorActions,
  listApprovalRequests,
  listCommandEvents,
  listOrchestratorEvents,
  listProjectArtifactFiles,
  listSessions,
  listTaskGraphs,
  listTasks,
  listWorkerContextPackets,
  listWorkerRuntimeCommandRequests,
  listWorkers,
  stateStoreKind,
  upsertApprovalRequest,
  upsertCommandEvent,
  upsertProjectArtifactFile,
  upsertWorkerRuntimeCommandRequest,
  updateOrchestratorSettings,
  upsertSession,
  upsertTask,
  upsertWorker,
} from "./store.js";
import { actionRouter, approveOperatorAction, rejectOperatorAction } from "./action-router.js";
import { runCodexSession } from "./codex.js";
import { AgentRequestError, handleUserMessage, isChannel } from "./agent-core.js";
import { findProjectByWorkspace, getProject, listProjects, projectRecordForWorkspace, upsertProject } from "./project-store.js";
import { cloudOrchestrator } from "./cloud-orchestrator.js";
import { multiWorkerCoordinator } from "./multi-worker-coordinator.js";
import { buildFlowchartState } from "./flowchart.js";
import { workerManagerFor, type WorkerRuntimeMetadata } from "./workers.js";
import {
  get_codex_access_summary,
  get_codex_events,
  get_codex_summary,
  get_codex_status,
  handleSupervisorMessage,
  list_projects,
  respond_to_approval,
  select_project,
  send_codex_instruction,
} from "./supervisor-tools.js";
import { setupTwilioTelephony } from "./telephony.js";
import { setupTerminalWebSocket } from "./terminal.js";
import { startProgressBroadcaster } from "./progress-broadcaster.js";
import { DesktopTerminalLaunchDisabledError, launchCodexInDesktopTerminal } from "./desktop-terminal.js";
import { recordPreviewReport, servePreviewAsset, startPreviewForSession } from "./preview.js";
import type { Channel, TaskStatus, WorkerType } from "./types.js";

const app = express();
startProgressBroadcaster();
app.set("trust proxy", true);
app.use((req, res, next) => {
  const origin = req.get("origin") || "";
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

function serializeSession(sessionId?: string) {
  if (sessionId) {
    const session = getSession(sessionId);
    return session ? { session } : { error: "Session not found.", code: "SESSION_NOT_FOUND" };
  }
  return { sessions: listSessions() };
}

function apiError(code: string, message: string, details?: unknown) {
  return { error: { code, message, details } };
}

function sendToolError(res: express.Response, result: { error: unknown; code?: unknown }) {
  const code = typeof result.code === "string" ? result.code : "REQUEST_FAILED";
  const message = typeof result.error === "string" ? result.error : "Request failed.";
  const status = code === "SESSION_NOT_FOUND" || code === "PROJECT_NOT_FOUND" ? 404 : code === "SESSION_ID_REQUIRED" ? 400 : 409;
  res.status(status).json(apiError(code, message));
}

function hasToolError(result: unknown): result is { error: unknown; code?: unknown } {
  return Boolean(result && typeof result === "object" && "error" in result && (result as { error?: unknown }).error);
}

function parseWorkerType(value: unknown): WorkerType {
  const type = String(value || getOrchestratorSettings().default_worker_mode || config.orchestrator.defaultWorkerType || "local");
  return type === "docker_local" || type === "gcp_vm" || type === "gke_job" ? type : "local";
}

function optionalBodyString(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

const artifactExtensions = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
  ".txt",
  ".md",
]);

function normalizeArtifactRelativePath(value: unknown) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  const normalized = path.posix.normalize(raw);
  if (!raw || normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid artifact path: ${raw || "(empty)"}`);
  }
  return normalized;
}

function isPersistableArtifactPath(relativePath: string) {
  const parts = relativePath.split("/");
  if (parts.some((part) => part === ".git" || part === "node_modules" || part === ".codex-vm-home" || part === ".codex-worker-home")) return false;
  if (parts[0]?.startsWith(".") && parts[0] !== ".well-known") return false;
  return artifactExtensions.has(path.extname(relativePath).toLowerCase());
}

function artifactWorkspaceForProject(projectId: string) {
  const project = getProject(projectId);
  if (!project) return null;
  return { project, workspacePath: project.workspace_path };
}

function artifactIdFor(projectId: string, relativePath: string) {
  const digest = createHash("sha256").update(`${projectId}:${relativePath}`).digest("hex").slice(0, 32);
  return `artifact_${digest}`;
}

function listArtifactFiles(workspacePath: string, projectId?: string) {
  const byPath = new Map<string, { path: string; content_base64: string; size_bytes: number }>();
  if (projectId) {
    for (const record of listProjectArtifactFiles(projectId)) {
      if (!isPersistableArtifactPath(record.path)) continue;
      byPath.set(record.path, {
        path: record.path,
        content_base64: record.content_base64,
        size_bytes: record.size_bytes,
      });
    }
  }
  const maxFiles = 100;
  const maxBytes = 2 * 1024 * 1024;
  let totalBytes = [...byPath.values()].reduce((sum, file) => sum + file.size_bytes, 0);
  function walk(dir: string) {
    if (byPath.size >= maxFiles || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(workspacePath, absolute).replace(/\\/g, "/");
      if (!relative || relative.startsWith("..")) continue;
      if (entry.isDirectory()) {
        if (isPersistableArtifactPath(`${relative}/placeholder.txt`) || (!relative.startsWith(".") && !relative.includes("node_modules") && !relative.includes(".git"))) walk(absolute);
        continue;
      }
      if (!entry.isFile() || !isPersistableArtifactPath(relative)) continue;
      const data = fs.readFileSync(absolute);
      if (totalBytes + data.length > maxBytes) continue;
      totalBytes += data.length;
      byPath.set(relative, { path: relative, content_base64: data.toString("base64"), size_bytes: data.length });
      if (byPath.size >= maxFiles) break;
    }
  }
  walk(workspacePath);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function listPersistedArtifactFiles(projectId: string) {
  return listProjectArtifactFiles(projectId)
    .filter((record) => isPersistableArtifactPath(record.path))
    .map((record) => ({
      path: record.path,
      content_base64: record.content_base64,
      size_bytes: record.size_bytes,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function writeFileIfChanged(filePath: string, data: Buffer) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const current = fs.readFileSync(filePath);
    if (current.length === data.length && current.equals(data)) return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
  return true;
}

function workerRuntimeMetadataFromBody(body: Record<string, unknown>): WorkerRuntimeMetadata {
  return {
    task_id: optionalBodyString(body.task_id),
    project_id: optionalBodyString(body.project_id),
    worker_type: parseWorkerType(body.worker_type),
    actual_worker_mode: parseWorkerType(body.actual_worker_mode),
    recorded_image_uri: optionalBodyString(body.recorded_image_uri) ?? optionalBodyString(body.requested_image_uri),
    image_uri: optionalBodyString(body.image_uri),
    actual_worker_image_uri: optionalBodyString(body.actual_worker_image_uri),
    actual_image_uri: optionalBodyString(body.actual_image_uri),
    runtime_image_uri: optionalBodyString(body.runtime_image_uri),
    actual_worker_image_digest: optionalBodyString(body.actual_worker_image_digest),
    actual_image_digest: optionalBodyString(body.actual_image_digest),
    image_digest: optionalBodyString(body.image_digest),
    runtime_image_digest: optionalBodyString(body.runtime_image_digest),
    recorded_vm_name: optionalBodyString(body.recorded_vm_name),
    actual_vm_name: optionalBodyString(body.actual_vm_name),
    vm_name: optionalBodyString(body.vm_name),
    runtime_vm_name: optionalBodyString(body.runtime_vm_name),
    machine_type: optionalBodyString(body.machine_type),
    startup_attempt_id: optionalBodyString(body.startup_attempt_id),
    run_attempt_id: optionalBodyString(body.run_attempt_id),
    container_started_at: optionalBodyString(body.container_started_at),
    worker_runtime_version: optionalBodyString(body.worker_runtime_version),
    codex_home: optionalBodyString(body.codex_home),
    codex_home_host_path: optionalBodyString(body.codex_home_host_path),
    codex_history_sessions_path: optionalBodyString(body.codex_history_sessions_path),
    codex_auth_method: optionalBodyString(body.codex_auth_method),
    codex_auth_secret_resource: optionalBodyString(body.codex_auth_secret_resource),
    codex_auth_validated_at: optionalBodyString(body.codex_auth_validated_at),
    codex_auth_validation_status: optionalBodyString(body.codex_auth_validation_status) as WorkerRuntimeMetadata["codex_auth_validation_status"],
    docker_container_id: optionalBodyString(body.docker_container_id),
    docker_container_name: optionalBodyString(body.docker_container_name),
  };
}

function commandEventWithWorkerRuntime(
  event: import("./types.js").CommandEventRecord,
  worker: import("./types.js").WorkerRecord,
) {
  return {
    ...event,
    worker_mode: event.worker_mode ?? worker.actual_worker_mode ?? worker.type,
    actual_image_uri: event.actual_image_uri ?? worker.actual_image_uri ?? worker.runtime_image_uri ?? worker.image_uri,
    actual_image_digest: event.actual_image_digest ?? worker.actual_image_digest ?? worker.runtime_image_digest,
    vm_name: event.vm_name ?? worker.actual_vm_name ?? worker.runtime_vm_name ?? worker.vm_name,
    startup_attempt_id: event.startup_attempt_id ?? worker.startup_attempt_id,
    run_attempt_id: event.run_attempt_id ?? worker.run_attempt_id ?? worker.startup_attempt_id,
    container_started_at: event.container_started_at ?? worker.container_started_at,
    worker_runtime_version: event.worker_runtime_version ?? worker.worker_runtime_version,
    codex_auth_method: event.codex_auth_method ?? worker.codex_auth_method ?? null,
    codex_auth_secret_resource: event.codex_auth_secret_resource ?? worker.codex_auth_secret_resource ?? null,
    codex_auth_validated_at: event.codex_auth_validated_at ?? worker.codex_auth_validated_at ?? null,
    codex_auth_validation_status: event.codex_auth_validation_status ?? worker.codex_auth_validation_status ?? null,
    docker_container_id: event.docker_container_id ?? worker.docker_container_id,
    docker_container_name: event.docker_container_name ?? worker.docker_container_name,
    runtime_metadata_verified: event.runtime_metadata_verified ?? Boolean(worker.metadata_verified_from_runtime),
  };
}

function parseTaskStatus(value: unknown): TaskStatus {
  const status = String(value || "completed");
  const allowed: TaskStatus[] = ["queued", "planning", "running", "waiting_for_approval", "failed", "completed", "cancelled"];
  return allowed.includes(status as TaskStatus) ? status as TaskStatus : "failed";
}

function sessionForWorker(workerId: string, fallback?: string) {
  if (fallback) return fallback;
  const worker = getWorker(workerId);
  const linked = listSessions({ workerId, taskId: worker?.task_id ?? undefined, limit: 5 })[0];
  return linked?.session_id ?? listSessions({ limit: 1 })[0]?.session_id ?? "";
}

function sessionForTask(taskId: string, fallback?: string) {
  if (fallback) return fallback;
  const linked = listSessions({ taskId, limit: 1 })[0];
  return linked?.session_id ?? listSessions({ limit: 1 })[0]?.session_id ?? "";
}

function ensureBodyChannel(value: unknown, fallback: Channel = "web_text") {
  const channel = String(value || fallback);
  return isChannel(channel) ? channel : fallback;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/ready", (_req, res) => {
  res.json({
    ok: true,
    store: fs.existsSync(config.storePath),
    codex_command: config.codexCommand,
    worker_image_uri: config.orchestrator.workerImageUri || null,
    worker_settings: getOrchestratorSettings(),
    model_providers: config.modelProviders,
  });
});

app.get("/orchestrator/flowchart", (_req, res) => {
  res.json(buildFlowchartState());
});

app.post("/sessions/:session_id/preview", async (req, res) => {
  const result = await startPreviewForSession(req.params.session_id);
  if (!result.ok) {
    res.status(result.status).json(apiError(result.code, result.message));
    return;
  }
  res.status(result.reused ? 200 : 201).json({
    preview: result.preview,
    task: result.task,
    project: result.project,
    reused: result.reused,
  });
});

app.get("/orchestrator/worker-mode", (_req, res) => {
  res.json({ settings: getOrchestratorSettings() });
});

app.post("/orchestrator/worker-mode", (req, res) => {
  const current = getOrchestratorSettings();
  if (!current.allow_worker_mode_switch) {
    res.status(409).json(apiError("WORKER_MODE_SWITCH_DISABLED", "Worker mode switching is disabled."));
    return;
  }
  const mode = parseWorkerType(req.body?.worker_mode || req.body?.default_worker_mode);
  const settings = updateOrchestratorSettings({ default_worker_mode: mode });
  appendOrchestratorEvent({
    scope: "worker",
    scope_id: "worker-mode",
    type: "worker.mode.selected",
    message: `Default worker mode changed to ${mode} for future tasks.`,
    data: settings,
  });
  res.json({ settings });
});

app.post("/sessions", (req, res) => {
  const label = String(req.body?.label || "Cloud orchestrator session").trim();
  const workspacePath = String(req.body?.workspace_path || config.defaultWorkspacePath);
  const channel = ensureBodyChannel(req.body?.channel, "web_text");
  const session = createSession(label, workspacePath);
  session.user_id = String(req.body?.user_id || req.body?.userId || "").trim() || null;
  session.channel = channel;
  session.status = session.current_status;
  upsertSession(session);
  appendAuditEvent({
    session_id: session.session_id,
    ts: new Date().toISOString(),
    source: "system",
    type: "session.created",
    message: `Created ${channel} session.`,
    data: { channel, user_id: session.user_id },
  });
  appendOrchestratorEvent({
    scope: "session",
    scope_id: session.session_id,
    type: "session.created",
    message: `Created ${channel} session.`,
    data: { session },
  });
  res.status(201).json({ session });
});

app.get("/sessions/:session_id", (req, res) => {
  const session = getSession(req.params.session_id);
  if (!session) return res.status(404).json(apiError("SESSION_NOT_FOUND", "Session not found."));
  res.json({ session });
});

app.post("/sessions/:session_id/message", async (req, res) => {
  const session = getSession(req.params.session_id);
  if (!session) return res.status(404).json(apiError("SESSION_NOT_FOUND", "Session not found."));
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json(apiError("TEXT_REQUIRED", "text is required."));
  const channel = ensureBodyChannel(req.body?.channel, session.channel ?? "web_text");
  const result = await handleSupervisorMessage(session.session_id, text, channel);
  res.json(result);
});

app.get("/sessions/:session_id/events", (req, res) => {
  const session = getSession(req.params.session_id);
  if (!session) return res.status(404).json(apiError("SESSION_NOT_FOUND", "Session not found."));
  res.json({ session_id: session.session_id, events: session.raw_events, orchestrator_events: listOrchestratorEvents(session.session_id) });
});

app.get("/sessions/:session_id/summary", (req, res) => {
  const result = get_codex_summary(req.params.session_id);
  if (hasToolError(result)) return sendToolError(res, result);
  res.json(result);
});

app.post("/codex/start", async (req, res) => {
  const task = String(req.body?.task || "").trim();
  const workspacePath = String(req.body?.workspace_path || config.defaultWorkspacePath);
  if (!task) {
    res.status(400).json({ error: "Missing task." });
    return;
  }
  const session = createSession(task, workspacePath);
  session.project_discovery = {
    status: "selected",
    selected_workspace_path: workspacePath,
    selected_project_name: path.basename(workspacePath),
    confidence: "high",
    reason: "Direct task start supplied the workspace path.",
    last_question: "",
    conversation: [],
  };
  const existingProject = findProjectByWorkspace(workspacePath);
  const project = upsertProject(projectRecordForWorkspace(workspacePath, existingProject ?? undefined));
  project.last_active_session_id = session.session_id;
  project.updated_at = new Date().toISOString();
  upsertProject(project);
  session.project_id = project.project_id;
  session.instruction_history.push({ ts: new Date().toISOString(), text: task, source: "start" });
  upsertSession(session);
  appendAuditEvent({
    session_id: session.session_id,
    ts: new Date().toISOString(),
    source: "user",
    type: "codex.start",
    message: task,
    data: req.body,
  });
  void runCodexSession(session.session_id, task).catch((error) => {
    const failed = getSession(session.session_id);
    if (!failed) return;
    failed.current_status = "failed";
    failed.errors.push(error instanceof Error ? error.message : String(error));
    upsertSession(failed);
  });
  res.status(202).json({ session_id: session.session_id, status: session.current_status });
});

app.post("/supervisor/session", (req, res) => {
  const label = String(req.body?.label || "").trim();
  const workspacePath = String(req.body?.workspace_path || config.defaultWorkspacePath);
  if (!label) {
    res.status(400).json({ error: "Missing label." });
    return;
  }
  const session = createSession(label, workspacePath);
  session.current_status = "idle";
  session.active_task = "Project discovery";
  session.summary_text = "Project discovery is waiting for the user to identify the workspace.";
  session.latest_codex_message = session.project_discovery.last_question;
  upsertSession(session);
  appendAuditEvent({
    session_id: session.session_id,
    ts: new Date().toISOString(),
    source: "system",
    type: "supervisor.session.created",
    message: label,
    data: { workspace_path: workspacePath },
  });
  appendOrchestratorEvent({
    scope: "session",
    scope_id: session.session_id,
    type: "session.created",
    message: label,
    data: { session },
  });
  res.status(201).json({ session_id: session.session_id, status: session.current_status });
});

app.post("/projects", (req, res) => {
  const workspaceUri = String(req.body?.workspace_uri || req.body?.workspace_path || "").trim();
  if (!workspaceUri) {
    res.status(400).json(apiError("WORKSPACE_URI_REQUIRED", "workspace_uri is required. App creation requests should go through /agent/chat so Codex creates real files."));
    return;
  }
  if (!fs.existsSync(workspaceUri) || !fs.statSync(workspaceUri).isDirectory()) {
    res.status(400).json(apiError("WORKSPACE_NOT_FOUND", "workspace_uri must point to an existing directory."));
    return;
  }
  const project = upsertProject(projectRecordForWorkspace(workspaceUri));
  res.status(201).json({ project });
});

app.get("/projects", (_req, res) => {
  res.json(list_projects());
});

app.get("/projects/:project_id", (req, res) => {
  const project = getProject(req.params.project_id);
  if (!project) return res.status(404).json(apiError("PROJECT_NOT_FOUND", "Project not found."));
  res.json({ project });
});

app.get("/projects/:project_id/tasks", (req, res) => {
  const project = getProject(req.params.project_id);
  if (!project) return res.status(404).json(apiError("PROJECT_NOT_FOUND", "Project not found."));
  res.json({ tasks: listTasks(project.project_id) });
});

app.get("/projects/:project_id/summary", (req, res) => {
  const project = getProject(req.params.project_id);
  if (!project) return res.status(404).json(apiError("PROJECT_NOT_FOUND", "Project not found."));
  const latestTask = listTasks(project.project_id)[0] ?? null;
  res.json({
    project_id: project.project_id,
    latest_summary: latestTask?.latest_summary ?? "",
    latest_plan: latestTask?.plan ?? [],
    latest_task_id: latestTask?.task_id ?? null,
  });
});

app.post("/projects/select", (req, res) => {
  const projectId = String(req.body?.project_id || "").trim();
  const sessionId = String(req.body?.session_id || "").trim();
  if (!projectId || !sessionId) return res.status(400).json({ error: "project_id and session_id are required." });
  const result = select_project(projectId, sessionId);
  if ("error" in result) return res.status(404).json(result);
  res.json(result);
});

app.post("/codex/instruct", async (req, res) => {
  const sessionId = String(req.body?.session_id || "").trim();
  const instruction = String(req.body?.instruction || "").trim();
  const session = getSession(sessionId);
  if (!session) return res.status(404).json(apiError("SESSION_NOT_FOUND", "Session not found."));
  if (!instruction) return res.status(400).json({ error: "Missing instruction." });
  const result = send_codex_instruction(sessionId, instruction);
  if (hasToolError(result)) return sendToolError(res, result);
  res.status(202).json(result);
});

app.get("/codex/status", (req, res) => {
  const sessionId = String(req.query.session_id || "");
  const result = sessionId ? get_codex_status(sessionId) : serializeSession("");
  if (hasToolError(result)) return sendToolError(res, result);
  res.json(result);
});

app.get("/codex/events", (req, res) => {
  const result = get_codex_events(String(req.query.session_id || ""));
  if (hasToolError(result)) return sendToolError(res, result);
  res.json(result);
});

app.get("/codex/summary", (req, res) => {
  const result = get_codex_summary(String(req.query.session_id || ""));
  if (hasToolError(result)) return sendToolError(res, result);
  res.json(result);
});

app.get("/codex/access", (req, res) => {
  res.json(get_codex_access_summary(String(req.query.session_id || "")));
});

app.post("/approval/respond", async (req, res) => {
  const sessionId = String(req.body?.session_id || "").trim();
  const approvalId = String(req.body?.approval_id || "").trim();
  const decision = String(req.body?.decision || "").trim().toLowerCase();
  const channel = String(req.body?.channel || "").trim();
  if (decision !== "approved" && decision !== "denied") return res.status(400).json({ error: "Decision must be approved or denied." });
  if (!isChannel(channel)) return res.status(400).json({ error: "channel is required and must be supported." });
  const result = respond_to_approval(sessionId, approvalId, decision, channel);
  if (hasToolError(result)) return sendToolError(res, result);
  appendOrchestratorEvent({
    scope: "approval",
    scope_id: approvalId,
    type: "approval.resolved",
    message: `${decision}: ${approvalId}`,
    data: { session_id: sessionId, approval_id: approvalId, decision },
  });
  res.json(result);
});

app.post("/call/message", async (req, res) => {
  const userId = String(req.body?.user_id || req.body?.userId || "").trim();
  const channel = String(req.body?.channel || "").trim();
  const text = String(req.body?.text || "").trim();
  const timestamp = String(req.body?.timestamp || "").trim();
  if (!userId || !channel || !text || !timestamp) return res.status(400).json({ error: "user_id, channel, text, and timestamp are required." });
  if (!isChannel(channel)) return res.status(400).json({ error: "Unsupported channel." });
  const inboundSessionId = String(req.body?.session_id || req.body?.sessionId || "").trim() || "new-session";
  appendOrchestratorEvent({
    scope: "session",
    scope_id: inboundSessionId,
    type: "session.message.received",
    message: text,
    data: { user_id: userId, channel, session_id: inboundSessionId },
  });
  try {
    res.json(
      await handleUserMessage({
        userId,
        channel,
        text,
        timestamp,
        sessionId: inboundSessionId === "new-session" ? undefined : inboundSessionId,
        projectId: String(req.body?.project_id || req.body?.projectId || "").trim() || undefined,
        externalConversationId: String(req.body?.external_conversation_id || req.body?.externalConversationId || "").trim() || undefined,
      }),
    );
  } catch (error) {
    if (error instanceof AgentRequestError) {
      res.status(error.status).json(apiError(error.code, error.message));
      return;
    }
    res.status(400).json(apiError("MESSAGE_FAILED", "The supervisor could not handle that message."));
  }
});

app.post("/tasks", async (req, res) => {
  const projectId = String(req.body?.project_id || "").trim();
  const userGoal = String(req.body?.user_goal || req.body?.goal || "").trim();
  const sessionId = String(req.body?.session_id || req.body?.sessionId || "").trim();
  if (!projectId || !userGoal) return res.status(400).json(apiError("TASK_INPUT_REQUIRED", "project_id and user_goal are required."));
  if (!getProject(projectId)) return res.status(404).json(apiError("PROJECT_NOT_FOUND", "Project not found."));
  const task = cloudOrchestrator.createTask(projectId, userGoal);
  if (sessionId) {
    const session = getSession(sessionId);
    if (session) {
      session.active_task_id = task.task_id;
      session.current_project_id = projectId;
      session.project_id = session.project_id ?? projectId;
      session.latest_plan = task.plan;
      session.latest_summary = task.latest_summary;
      session.active_task = task.user_goal;
      session.last_updated = new Date().toISOString();
      upsertSession(session);
      appendOrchestratorEvent({
        scope: "session",
        scope_id: session.session_id,
        type: "task.created",
        message: `Conversation session attached to task ${task.task_id}.`,
        data: { session_id: session.session_id, task_id: task.task_id, project_id: projectId },
      });
    }
  }
  if (req.body?.assign_worker) {
    const assigned = await cloudOrchestrator.assignWorker(task.task_id, req.body?.worker_type ? parseWorkerType(req.body?.worker_type) : undefined, task);
    if (sessionId) {
      const session = getSession(sessionId);
      if (session) {
        session.active_task_id = assigned.task.task_id;
        session.active_worker_id = assigned.worker.worker_id;
        session.current_project_id = projectId;
        session.latest_plan = assigned.task.plan;
        session.latest_summary = assigned.task.latest_summary;
        session.active_task = assigned.task.user_goal;
        session.last_updated = new Date().toISOString();
        upsertSession(session);
      }
    }
    res.status(201).json(assigned);
    return;
  }
  res.status(201).json({ task });
});

app.get("/tasks/:task_id", (req, res) => {
  const status = cloudOrchestrator.status(req.params.task_id);
  if (!status) return res.status(404).json(apiError("TASK_NOT_FOUND", "Task not found."));
  res.json(status);
});

app.get("/tasks/:task_id/events", (req, res) => {
  const task = getTask(req.params.task_id);
  if (!task) return res.status(404).json(apiError("TASK_NOT_FOUND", "Task not found."));
  res.json({ events: listOrchestratorEvents(task.task_id) });
});

app.get("/tasks/:task_id/commands", (req, res) => {
  const task = getTask(req.params.task_id);
  if (!task) return res.status(404).json(apiError("TASK_NOT_FOUND", "Task not found."));
  res.json({ commands: listCommandEvents({ taskId: task.task_id }) });
});

app.get("/tasks/:task_id/summary", (req, res) => {
  const task = getTask(req.params.task_id);
  if (!task) return res.status(404).json(apiError("TASK_NOT_FOUND", "Task not found."));
  const summary = getRunSummary(task.task_id) ?? cloudOrchestrator.completeTask(task.task_id, task.status)?.summary;
  res.json({ summary });
});

app.post("/tasks/:task_id/cancel", (req, res) => {
  const task = getTask(req.params.task_id);
  if (!task) return res.status(404).json(apiError("TASK_NOT_FOUND", "Task not found."));
  task.status = "cancelled";
  task.updated_at = new Date().toISOString();
  upsertTask(task);
  res.json({ task });
});

app.get("/task-graphs", (req, res) => {
  res.json({ task_graphs: listTaskGraphs(optionalBodyString(req.query.project_id)) });
});

app.post("/task-graphs", async (req, res) => {
  const projectId = optionalBodyString(req.body?.project_id);
  const goal = optionalBodyString(req.body?.root_user_goal) ?? optionalBodyString(req.body?.user_goal);
  if (!projectId || !goal) return res.status(400).json(apiError("TASK_GRAPH_INPUT_REQUIRED", "project_id and root_user_goal are required."));
  const project = getProject(projectId);
  if (!project) return res.status(404).json(apiError("PROJECT_NOT_FOUND", "Project not found."));
  const workerMode = parseWorkerType(req.body?.worker_mode);
  const result = await multiWorkerCoordinator.createAndMaybeStart(project, goal, workerMode, {
    autoStart: Boolean(req.body?.auto_start),
    workers: Number(req.body?.workers || "0") || undefined,
  });
  res.status(201).json(result);
});

app.get("/task-graphs/:task_graph_id", (req, res) => {
  const graph = getTaskGraph(req.params.task_graph_id);
  if (!graph) return res.status(404).json(apiError("TASK_GRAPH_NOT_FOUND", "Task graph not found."));
  res.json({ task_graph: graph });
});

app.post("/task-graphs/:task_graph_id/start", async (req, res) => {
  try {
    const workerMode = parseWorkerType(req.body?.worker_mode);
    res.json(await multiWorkerCoordinator.startReadyWork(req.params.task_graph_id, workerMode, Number(req.body?.workers || "0") || undefined));
  } catch (error) {
    res.status(400).json(apiError("TASK_GRAPH_START_FAILED", error instanceof Error ? error.message : String(error)));
  }
});

app.get("/worker-context/:context_packet_id", (req, res) => {
  const packet = getWorkerContextPacket(req.params.context_packet_id);
  if (!packet) return res.status(404).json(apiError("WORKER_CONTEXT_NOT_FOUND", "Worker context packet not found."));
  res.json({ packet });
});

app.get("/worker-context", (req, res) => {
  res.json({ packets: listWorkerContextPackets({
    taskGraphId: optionalBodyString(req.query.task_graph_id),
    taskId: optionalBodyString(req.query.task_id),
    workerId: optionalBodyString(req.query.worker_id),
  }) });
});

app.get("/operator/actions", (req, res) => {
  res.json({
    actions: listOperatorActions({
      sessionId: optionalBodyString(req.query.session_id),
      taskId: optionalBodyString(req.query.task_id),
      projectId: optionalBodyString(req.query.project_id),
      workerId: optionalBodyString(req.query.worker_id),
    }),
  });
});

app.post("/operator/actions", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const sessionId = optionalBodyString(body.session_id);
  if (!sessionId) return res.status(400).json(apiError("SESSION_ID_REQUIRED", "session_id is required."));
  const message = optionalBodyString(body.text) ?? optionalBodyString(body.message);
  try {
    const result = message && !body.action_type
      ? await actionRouter.executeParsed(sessionId, message)
      : await actionRouter.execute({
          session_id: sessionId,
          action_type: String(body.action_type || "summarize_current_state") as import("./types.js").OperatorActionType,
          user_goal: message ?? optionalBodyString(body.user_goal) ?? String(body.action_type || "operator action"),
          input: body.input && typeof body.input === "object" ? body.input as Record<string, unknown> : body,
          project_id: optionalBodyString(body.project_id),
          task_id: optionalBodyString(body.task_id),
          worker_id: optionalBodyString(body.worker_id),
          command_id: optionalBodyString(body.command_id),
          approved_by_user: Boolean(body.approved_by_user),
        });
    if (!result) return res.status(400).json(apiError("ACTION_NOT_RECOGNIZED", "No operator action matched the request."));
    res.status(result.action.status === "waiting_for_approval" ? 202 : 200).json(result);
  } catch (error) {
    res.status(400).json(apiError("OPERATOR_ACTION_FAILED", error instanceof Error ? error.message : String(error)));
  }
});

app.get("/operator/actions/:action_id", (req, res) => {
  const action = listOperatorActions().find((item) => item.action_id === req.params.action_id);
  if (!action) return res.status(404).json(apiError("ACTION_NOT_FOUND", "Operator action not found."));
  res.json({ action });
});

app.post("/operator/actions/:action_id/approve", async (req, res) => {
  try {
    res.json(await approveOperatorAction(req.params.action_id));
  } catch (error) {
    res.status(400).json(apiError("OPERATOR_APPROVAL_FAILED", error instanceof Error ? error.message : String(error)));
  }
});

app.post("/operator/actions/:action_id/reject", (req, res) => {
  try {
    res.json(rejectOperatorAction(req.params.action_id));
  } catch (error) {
    res.status(400).json(apiError("OPERATOR_REJECTION_FAILED", error instanceof Error ? error.message : String(error)));
  }
});

app.post("/workers", async (req, res) => {
  const taskId = String(req.body?.task_id || "").trim();
  const projectId = String(req.body?.project_id || "").trim();
  const workerType = parseWorkerType(req.body?.worker_type);
  if (!taskId || !projectId) return res.status(400).json(apiError("WORKER_INPUT_REQUIRED", "task_id and project_id are required."));
  const worker = await workerManagerFor(workerType).createWorker(taskId, projectId, workerType);
  res.status(201).json({ worker });
});

app.get("/workers", (_req, res) => {
  res.json({ workers: listWorkers() });
});

app.get("/workers/:worker_id", (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  res.json({ worker });
});

app.get("/workers/:worker_id/logs", async (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const sessionId = sessionForWorker(worker.worker_id, optionalBodyString(req.query.session_id));
  if (!sessionId) return res.status(400).json(apiError("SESSION_ID_REQUIRED", "session_id is required."));
  const result = await actionRouter.execute({
    session_id: sessionId,
    action_type: "tail_worker_logs",
    user_goal: "tail worker logs",
    worker_id: worker.worker_id,
    task_id: worker.task_id,
    project_id: worker.project_id,
    input: { lines: Number(req.query.lines || "20") },
  });
  res.json(result);
});

app.post("/workers/:worker_id/stop", async (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const sessionId = sessionForWorker(worker.worker_id, optionalBodyString(req.body?.session_id));
  if (!sessionId) return res.status(400).json(apiError("SESSION_ID_REQUIRED", "session_id is required."));
  res.json(await actionRouter.execute({
    session_id: sessionId,
    action_type: "stop_worker",
    user_goal: "stop worker",
    worker_id: worker.worker_id,
    task_id: worker.task_id,
    project_id: worker.project_id,
  }));
});

app.post("/workers/:worker_id/restart", async (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const sessionId = sessionForWorker(worker.worker_id, optionalBodyString(req.body?.session_id));
  if (!sessionId) return res.status(400).json(apiError("SESSION_ID_REQUIRED", "session_id is required."));
  res.json(await actionRouter.execute({
    session_id: sessionId,
    action_type: "restart_worker",
    user_goal: "restart worker",
    worker_id: worker.worker_id,
    task_id: worker.task_id,
    project_id: worker.project_id,
  }));
});

app.post("/workers/:worker_id/commands", async (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const sessionId = sessionForWorker(worker.worker_id, optionalBodyString(req.body?.session_id));
  if (!sessionId) return res.status(400).json(apiError("SESSION_ID_REQUIRED", "session_id is required."));
  const command = optionalBodyString(req.body?.command);
  if (!command) return res.status(400).json(apiError("COMMAND_REQUIRED", "command is required."));
  const result = await actionRouter.execute({
    session_id: sessionId,
    action_type: "run_worker_command",
    user_goal: `run ${command}`,
    worker_id: worker.worker_id,
    task_id: worker.task_id,
    project_id: worker.project_id,
    input: { command, cwd: optionalBodyString(req.body?.cwd), timeout_ms: req.body?.timeout_ms },
  });
  res.status(result.action.status === "waiting_for_approval" ? 202 : 200).json(result);
});

app.post("/workers/:worker_id/runtime-command-requests/next", async (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const runtime = workerRuntimeMetadataFromBody(body);
  await workerManagerFor(worker.type).handleHeartbeat(worker.worker_id, runtime);
  const request = listWorkerRuntimeCommandRequests({ workerId: worker.worker_id, status: "queued" })
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
  if (!request) return res.json({ request: null });
  request.status = "running";
  request.claimed_at = new Date().toISOString();
  request.claimed_by_attempt_id = runtime.run_attempt_id ?? runtime.startup_attempt_id ?? worker.run_attempt_id ?? worker.startup_attempt_id ?? null;
  upsertWorkerRuntimeCommandRequest(request);
  appendOrchestratorEvent({
    scope: "worker",
    scope_id: worker.worker_id,
    type: "worker.runtime_command.claimed",
    message: `Worker ${worker.worker_id} claimed runtime command ${request.command}.`,
    data: { request, runtime },
  });
  res.json({ request });
});

app.post("/workers/:worker_id/runtime-command-requests/:request_id/result", (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const request = getWorkerRuntimeCommandRequest(req.params.request_id);
  if (!request || request.worker_id !== worker.worker_id) return res.status(404).json(apiError("RUNTIME_COMMAND_REQUEST_NOT_FOUND", "Runtime command request not found."));
  const status = String(req.body?.status || "").trim();
  request.status = status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "completed";
  request.completed_at = new Date().toISOString();
  request.command_event_id = optionalBodyString(req.body?.command_event_id) ?? request.command_event_id ?? null;
  request.error = optionalBodyString(req.body?.error) ?? null;
  upsertWorkerRuntimeCommandRequest(request);
  appendOrchestratorEvent({
    scope: "worker",
    scope_id: worker.worker_id,
    type: request.status === "completed" ? "worker.runtime_command.completed" : "worker.runtime_command.failed",
    message: `Runtime command ${request.command} ${request.status}.`,
    data: request,
  });
  res.json({ request });
});

app.post("/workers/cleanup-idle", async (req, res) => {
  const sessionId = optionalBodyString(req.body?.session_id) ?? listSessions({ limit: 1 })[0]?.session_id;
  if (!sessionId) return res.status(400).json(apiError("SESSION_ID_REQUIRED", "session_id is required."));
  res.json(await actionRouter.execute({
    session_id: sessionId,
    action_type: "cleanup_idle_workers",
    user_goal: "cleanup idle workers",
  }));
});

app.post("/workers/:worker_id/delete", async (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  res.json({ worker: await workerManagerFor(worker.type).deleteWorker(worker.worker_id) });
});

app.post("/workers/:worker_id/heartbeat", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const runtime = workerRuntimeMetadataFromBody(body);
  let worker = getWorker(req.params.worker_id);
  if (!worker) {
    const now = new Date().toISOString();
    worker = {
      worker_id: req.params.worker_id,
      type: runtime.worker_type ?? parseWorkerType(body.worker_type),
      status: "starting",
      image_uri: runtime.recorded_image_uri ?? runtime.actual_image_uri ?? runtime.actual_worker_image_uri ?? runtime.runtime_image_uri ?? runtime.image_uri ?? config.orchestrator.workerImageUri ?? "local-dev-worker",
      recorded_image_uri: runtime.recorded_image_uri ?? runtime.image_uri ?? runtime.actual_image_uri ?? runtime.actual_worker_image_uri ?? runtime.runtime_image_uri ?? config.orchestrator.workerImageUri ?? "local-dev-worker",
      project_id: runtime.project_id,
      task_id: runtime.task_id,
      heartbeat_at: null,
      created_at: now,
      expires_at: new Date(Date.now() + config.orchestrator.maxWorkerLifetimeMs).toISOString(),
    };
    upsertWorker(worker);
  }
  res.json({ worker: await workerManagerFor(worker.type).handleHeartbeat(worker.worker_id, runtime) });
});

app.post("/workers/:worker_id/claim-task", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const runtime = workerRuntimeMetadataFromBody(body);
  let worker = runtime.task_id && runtime.project_id ? null : getWorker(req.params.worker_id);
  const taskId = optionalBodyString(body.task_id) ?? runtime.task_id ?? worker?.task_id;
  if (!taskId) return res.status(400).json(apiError("TASK_ID_REQUIRED", "A task_id is required to claim work."));
  if (!worker && runtime.project_id) {
    const now = new Date().toISOString();
    worker = upsertWorker({
      worker_id: req.params.worker_id,
      type: runtime.worker_type ?? parseWorkerType(body.worker_type),
      status: "starting",
      image_uri: runtime.recorded_image_uri ?? runtime.actual_image_uri ?? runtime.actual_worker_image_uri ?? runtime.runtime_image_uri ?? runtime.image_uri ?? config.orchestrator.workerImageUri ?? "local-dev-worker",
      recorded_image_uri: runtime.recorded_image_uri ?? runtime.image_uri ?? runtime.actual_image_uri ?? runtime.actual_worker_image_uri ?? runtime.runtime_image_uri ?? config.orchestrator.workerImageUri ?? "local-dev-worker",
      project_id: runtime.project_id,
      task_id: taskId,
      heartbeat_at: null,
      created_at: now,
      expires_at: new Date(Date.now() + config.orchestrator.maxWorkerLifetimeMs).toISOString(),
    });
  }
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  if (runtime.worker_type === "gke_job" && runtime.project_id && runtime.task_id) {
    worker.status = "running";
    worker.project_id = runtime.project_id;
    worker.task_id = runtime.task_id;
    upsertWorker(worker);
    res.json({
      decision: "claimed",
      reason: `GKE Job worker ${worker.worker_id} claimed task ${runtime.task_id} from runtime metadata.`,
      task: null,
      worker,
      abandoned_commands: [],
    });
    return;
  }
  const leaseTtlMs = Number(process.env.HEAD_DEVELOPER_COMMAND_LEASE_TTL_MS || "900000");
  const decision = claimWorkerTask({
    worker_id: worker.worker_id,
    task_id: taskId,
    runtime,
    now_iso: new Date().toISOString(),
    lease_ttl_ms: leaseTtlMs,
  });
  if (decision.error_code === "WORKER_NOT_FOUND") return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  if (decision.error_code === "TASK_NOT_FOUND") return res.status(404).json(apiError("TASK_NOT_FOUND", "Task not found."));

  for (const abandoned of decision.abandoned_commands) {
    cloudOrchestrator.handleWorkerEvent(abandoned);
    appendOrchestratorEvent({
      scope: "command",
      scope_id: abandoned.event_id,
      type: "command.abandoned",
      message: abandoned.summary,
      data: abandoned,
    });
  }

  if (decision.decision === "claimed" || decision.decision === "claimed_after_abandoning_previous") {
    appendOrchestratorEvent({
      scope: "task",
      scope_id: taskId,
      type: "task.claimed",
      message: decision.reason,
      data: { task_id: taskId, worker_id: worker.worker_id, decision: decision.decision, lease_id: decision.lease_id },
    });
  }

  res.json({ decision: decision.decision, reason: decision.reason, task: decision.task, worker: decision.worker, abandoned_commands: decision.abandoned_commands });
});

app.post("/workers/:worker_id/events", async (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const event = req.body as Partial<import("./types.js").CommandEventRecord>;
  if (!event.event_id || !event.task_id || !event.project_id || !event.command) {
    return res.status(400).json(apiError("COMMAND_EVENT_INVALID", "A complete command event is required."));
  }
  const stored = upsertCommandEvent(commandEventWithWorkerRuntime(event as import("./types.js").CommandEventRecord, worker));
  const taskForCodexHistory = getTask(stored.task_id);
  if (taskForCodexHistory && stored.codex_history_kind) {
    taskForCodexHistory.codex_session_id = stored.codex_session_id ?? taskForCodexHistory.codex_session_id ?? null;
    taskForCodexHistory.codex_rollout_path = stored.codex_rollout_path ?? taskForCodexHistory.codex_rollout_path ?? null;
    taskForCodexHistory.codex_rollout_host_path = stored.codex_rollout_host_path ?? taskForCodexHistory.codex_rollout_host_path ?? null;
    taskForCodexHistory.codex_rollout_relative_path = stored.codex_rollout_relative_path ?? taskForCodexHistory.codex_rollout_relative_path ?? null;
    taskForCodexHistory.codex_home = stored.codex_home ?? taskForCodexHistory.codex_home ?? null;
    taskForCodexHistory.codex_home_host_path = stored.codex_home_host_path ?? taskForCodexHistory.codex_home_host_path ?? null;
    taskForCodexHistory.codex_history_kind = stored.codex_history_kind ?? taskForCodexHistory.codex_history_kind ?? null;
    taskForCodexHistory.codex_resume_command = stored.codex_resume_command ?? taskForCodexHistory.codex_resume_command ?? null;
    taskForCodexHistory.codex_prompt_excerpt = stored.codex_prompt_excerpt ?? taskForCodexHistory.codex_prompt_excerpt ?? null;
    taskForCodexHistory.codex_model = stored.codex_model ?? taskForCodexHistory.codex_model ?? null;
    taskForCodexHistory.codex_started_at = stored.codex_started_at ?? taskForCodexHistory.codex_started_at ?? null;
    taskForCodexHistory.codex_completed_at = stored.codex_completed_at ?? taskForCodexHistory.codex_completed_at ?? null;
    taskForCodexHistory.codex_history_confidence = stored.codex_history_confidence ?? taskForCodexHistory.codex_history_confidence ?? null;
    taskForCodexHistory.codex_history_verification_command = stored.codex_history_verification_command ?? taskForCodexHistory.codex_history_verification_command ?? null;
    taskForCodexHistory.codex_run_id = taskForCodexHistory.codex_run_id ?? stored.codex_session_id ?? null;
    taskForCodexHistory.updated_at = new Date().toISOString();
    upsertTask(taskForCodexHistory);
  }
  cloudOrchestrator.handleWorkerEvent(stored);
  await workerManagerFor(worker.type).handleWorkerEvent(stored);
  for (const session of listSessions({ taskId: stored.task_id, workerId: stored.worker_id, limit: 20 })) {
    session.active_task_id = stored.task_id;
    session.active_worker_id = stored.worker_id;
    session.latest_codex_message = stored.exit_code === null
      ? `Running command: ${stored.command}`
      : `Command ${stored.command} finished with exit ${stored.exit_code}.`;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
  }
  res.status(202).json({ event: stored });
});

app.get("/projects/:project_id/artifacts/files", (req, res) => {
  const target = artifactWorkspaceForProject(req.params.project_id);
  if (!target) return res.status(404).json(apiError("PROJECT_NOT_FOUND", "Project not found."));
  const source = optionalBodyString(req.query.source);
  const persistedOnly = source === "persisted" || req.query.persisted_only === "1";
  const files = persistedOnly
    ? listPersistedArtifactFiles(target.project.project_id)
    : listArtifactFiles(target.workspacePath, target.project.project_id);
  res.json({ project_id: target.project.project_id, files });
});

app.post("/workers/:worker_id/artifacts/files", (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const taskId = String(body.task_id || worker.task_id || "").trim();
  const projectId = String(body.project_id || worker.project_id || "").trim();
  if (!taskId || !projectId || taskId !== worker.task_id || projectId !== worker.project_id) {
    return res.status(400).json(apiError("ARTIFACT_SCOPE_INVALID", "Artifact upload must match the assigned worker task and project."));
  }
  const task = getTask(taskId);
  const target = artifactWorkspaceForProject(projectId);
  if (!task || !target) return res.status(404).json(apiError("ARTIFACT_TARGET_NOT_FOUND", "Artifact task or project not found."));
  const rawFiles = Array.isArray(body.files) ? body.files : [];
  if (!rawFiles.length) return res.status(400).json(apiError("ARTIFACT_FILES_REQUIRED", "At least one artifact file is required."));

  const savedFiles: string[] = [];
  let totalBytes = 0;
  const maxBytes = 2 * 1024 * 1024;
  const maxFileBytes = 512 * 1024;
  fs.mkdirSync(target.workspacePath, { recursive: true });
  const existingArtifacts = new Map(listProjectArtifactFiles(target.project.project_id).map((artifact) => [artifact.artifact_id, artifact]));
  for (const item of rawFiles) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const relativePath = normalizeArtifactRelativePath(record.path);
    if (!isPersistableArtifactPath(relativePath)) continue;
    const contentBase64 = String(record.content_base64 || "");
    const data = Buffer.from(contentBase64, "base64");
    if (!data.length) continue;
    if (data.length > maxFileBytes) return res.status(413).json(apiError("ARTIFACT_FILE_TOO_LARGE", "A single artifact file is too large."));
    totalBytes += data.length;
    if (totalBytes > maxBytes) return res.status(413).json(apiError("ARTIFACT_TOO_LARGE", "Artifact upload is too large."));
    const targetFile = path.join(target.workspacePath, relativePath);
    const resolved = path.resolve(targetFile);
    const resolvedRoot = path.resolve(target.workspacePath);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      return res.status(400).json(apiError("ARTIFACT_PATH_INVALID", "Artifact path must stay inside the project workspace."));
    }
    writeFileIfChanged(targetFile, data);
    const now = new Date().toISOString();
    const artifactId = artifactIdFor(target.project.project_id, relativePath);
    const previous = existingArtifacts.get(artifactId);
    const nextArtifact = upsertProjectArtifactFile({
      artifact_id: artifactId,
      project_id: target.project.project_id,
      task_id: task.task_id,
      worker_id: worker.worker_id,
      path: relativePath,
      content_base64: data.toString("base64"),
      size_bytes: data.length,
      created_at: previous?.created_at ?? now,
      updated_at: now,
    });
    existingArtifacts.set(artifactId, nextArtifact);
    savedFiles.push(relativePath);
  }

  target.project.updated_at = new Date().toISOString();
  upsertProject(target.project);
  appendOrchestratorEvent({
    scope: "worker",
    scope_id: worker.worker_id,
    type: "worker.artifacts.persisted",
    message: `Persisted ${savedFiles.length} artifact file(s) for task ${task.task_id}.`,
    data: { worker_id: worker.worker_id, task_id: task.task_id, project_id: target.project.project_id, files: savedFiles },
  });
  res.status(202).json({ artifact: { project_id: target.project.project_id, task_id: task.task_id, worker_id: worker.worker_id, files: savedFiles } });
});

app.post("/workers/:worker_id/result", async (req, res) => {
  const worker = getWorker(req.params.worker_id);
  if (!worker) return res.status(404).json(apiError("WORKER_NOT_FOUND", "Worker not found."));
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const runtime = workerRuntimeMetadataFromBody(body);
  await workerManagerFor(worker.type).handleHeartbeat(worker.worker_id, runtime);
  const result = {
    task_id: String(body.task_id || worker.task_id || "").trim(),
    status: parseTaskStatus(body.status),
    summary: String(body.summary || "").trim() || undefined,
    next_steps: Array.isArray(body.next_steps) ? body.next_steps.map(String) : undefined,
  };
  let task = await workerManagerFor(worker.type).handleTaskResult(result);
  if (task) {
    task.in_flight_action = null;
    task.active_command_event_id = null;
    task.command_lease_id = null;
    task.command_lease_owner = null;
    task.command_lease_attempt_id = null;
    task.command_lease_acquired_at = null;
    task.command_lease_expires_at = null;
    upsertTask(task);
    const advanced = await multiWorkerCoordinator.advanceAfterTaskResult(task, worker.type);
    const gatedTask = getTask(task.task_id) ?? task;
    task = gatedTask;
    const completed = cloudOrchestrator.completeTask(gatedTask.task_id, gatedTask.status, gatedTask.latest_summary);
    for (const session of listSessions({ taskId: gatedTask.task_id, limit: 20 })) {
      session.current_status = gatedTask.status === "failed" ? "failed" : gatedTask.status === "completed" ? "completed" : session.current_status;
      session.status = session.current_status;
      session.latest_summary = completed?.summary.executive_summary ?? gatedTask.latest_summary;
      session.latest_plan = completed?.summary.next_plan ?? gatedTask.next_steps;
      session.latest_codex_message = completed?.summary.executive_summary ?? gatedTask.latest_summary;
      session.last_updated = new Date().toISOString();
      upsertSession(session);
    }
    if (advanced.assignments.length) {
      for (const session of listSessions({ projectId: gatedTask.project_id, limit: 20 })) {
        const first = advanced.assignments[0];
        session.active_task_id = first.task.task_id;
        session.active_worker_id = first.worker.worker_id;
        session.current_status = "running";
        session.status = "running";
        session.latest_codex_message = `Advanced task graph ${gatedTask.task_graph_id}; started ${advanced.assignments.length} next worker assignment(s).`;
        session.last_updated = new Date().toISOString();
        upsertSession(session);
      }
    }
  }
  res.json({ task });
});

app.get("/approvals", (_req, res) => {
  res.json({ approvals: listApprovalRequests() });
});

app.get("/approvals/:approval_id", (req, res) => {
  const approval = getApprovalRequest(req.params.approval_id);
  if (!approval) return res.status(404).json(apiError("APPROVAL_NOT_FOUND", "Approval not found."));
  res.json({ approval });
});

app.post("/approvals/:approval_id/approve", (req, res) => {
  const approval = getApprovalRequest(req.params.approval_id);
  if (!approval) return res.status(404).json(apiError("APPROVAL_NOT_FOUND", "Approval not found."));
  approval.status = "approved";
  approval.resolved_at = new Date().toISOString();
  upsertApprovalRequest(approval);
  appendOrchestratorEvent({
    scope: "approval",
    scope_id: approval.approval_id,
    type: "approval.resolved",
    message: `Approved ${approval.requested_action}.`,
    data: approval,
  });
  res.json({ approval });
});

app.post("/approvals/:approval_id/reject", (req, res) => {
  const approval = getApprovalRequest(req.params.approval_id);
  if (!approval) return res.status(404).json(apiError("APPROVAL_NOT_FOUND", "Approval not found."));
  approval.status = "rejected";
  approval.resolved_at = new Date().toISOString();
  upsertApprovalRequest(approval);
  appendOrchestratorEvent({
    scope: "approval",
    scope_id: approval.approval_id,
    type: "approval.resolved",
    message: `Rejected ${approval.requested_action}.`,
    data: approval,
  });
  res.json({ approval });
});

app.post("/agent/chat", async (req, res) => {
  try {
    const result = await handleUserMessage({
      userId: String(req.body?.user_id || req.body?.userId || "web-user").trim(),
      channel: ensureBodyChannel(req.body?.channel, "web_text"),
      text: String(req.body?.text || "").trim(),
      timestamp: String(req.body?.timestamp || new Date().toISOString()),
      sessionId: String(req.body?.session_id || req.body?.sessionId || "").trim() || undefined,
      projectId: String(req.body?.project_id || req.body?.projectId || "").trim() || undefined,
      externalConversationId: String(req.body?.external_conversation_id || req.body?.externalConversationId || "").trim() || undefined,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof AgentRequestError) return res.status(error.status).json(apiError(error.code, error.message));
    res.status(400).json(apiError("AGENT_CHAT_FAILED", "The agent could not handle that chat message."));
  }
});

app.post("/agent/voice-summary", (req, res) => {
  const taskId = String(req.body?.task_id || "").trim();
  const task = taskId ? getTask(taskId) : null;
  if (!task) return res.status(404).json(apiError("TASK_NOT_FOUND", "task_id is required and must identify an existing task."));
  const summary = getRunSummary(task.task_id) ?? cloudOrchestrator.completeTask(task.task_id, task.status)?.summary;
  if (!summary) return res.status(404).json(apiError("SUMMARY_NOT_FOUND", "No summary is available for this task."));
  res.json({
    task_id: task.task_id,
    text: `${summary.executive_summary} Current status is ${summary.current_state}. Next action is ${summary.next_plan[0] ?? "to continue the plan"}.`,
  });
});

app.post("/previews/:preview_id/report", (req, res) => {
  const preview = recordPreviewReport(req.params.preview_id, req.body ?? {});
  if (!preview) {
    res.status(404).json(apiError("PREVIEW_NOT_FOUND", "Preview not found."));
    return;
  }
  res.json({ preview });
});

app.get(/^\/previews\/([^/]+)\/?(.*)$/, (req, res) => {
  const previewId = String(req.params[0] || "");
  const assetPath = String(req.params[1] || "");
  servePreviewAsset(previewId, assetPath, res);
});

app.post("/terminal/launch-codex", (req, res) => {
  try {
    const workspacePath = String(req.body?.workspace_path || "").trim() || undefined;
    res.status(202).json(launchCodexInDesktopTerminal(workspacePath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof DesktopTerminalLaunchDisabledError) {
      res.status(409).json({ error: message });
      return;
    }
    if (message.includes("Terminal workspace")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  if (stateStoreKind() === "firestore" || /Firestore state operation/i.test(message)) {
    const timedOut = /timed out/i.test(message);
    res.status(503).json(apiError(
      timedOut ? "STATE_STORE_TIMEOUT" : "STATE_STORE_ERROR",
      timedOut
        ? "Firestore state operation timed out. Retry the request or check Firestore/Cloud Run connectivity."
        : "Firestore state operation failed. Check Firestore configuration and permissions.",
    ));
    return;
  }
  next(error);
});

const frontendIndex = path.join(config.frontendDistDir, "index.html");
if (fs.existsSync(frontendIndex)) {
  app.use(express.static(config.frontendDistDir));
  app.use((req, res, next) => {
    if (
      req.path.startsWith("/codex") ||
      req.path.startsWith("/supervisor") ||
      req.path.startsWith("/call") ||
      req.path.startsWith("/approval") ||
      req.path.startsWith("/twilio") ||
      req.path.startsWith("/terminal") ||
      req.path.startsWith("/previews") ||
      req.path.startsWith("/health")
    ) {
      next();
      return;
    }
    res.sendFile(frontendIndex);
  });
}

const server = http.createServer(app);
setupTerminalWebSocket(server);
setupTwilioTelephony(app, server);

server.listen(config.port, config.host, () => {
  console.log(`Codex Phone Supervisor backend listening on ${config.host}:${config.port}`);
});
