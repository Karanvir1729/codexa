import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  ensureNewProjectDirectory,
  getProject,
  projectRecordForWorkspace,
  upsertProject,
} from "../../../codex-phone-supervisor/backend/src/project-store.js";
import { cloudOrchestrator } from "../../../codex-phone-supervisor/backend/src/cloud-orchestrator.js";
import { CommandRunner } from "../../../codex-phone-supervisor/backend/src/command-runner.js";
import { generateRunSummary } from "../../../codex-phone-supervisor/backend/src/summary.js";
import { workerManagerFor } from "../../../codex-phone-supervisor/backend/src/workers.js";
import {
  appendOrchestratorEvent,
  getRunSummary,
  getSession,
  getTask,
  getWorker,
  listCommandEvents,
  listMcpToolCalls,
  listSessions,
  listWorkers,
  upsertApprovalRequest,
  upsertMcpToolCall,
  upsertSession,
  upsertTask,
} from "../../../codex-phone-supervisor/backend/src/store.js";
import { actionRouter } from "../../../codex-phone-supervisor/backend/src/action-router.js";
import type {
  CommandRiskLevel,
  McpToolCallRecord,
  TaskStatus,
  WorkerType,
} from "../../../codex-phone-supervisor/backend/src/types.js";

const DEFAULT_MCP_SERVER = "head-developer-product-mcp";

type ToolContext = {
  mcpServer?: string;
  taskId?: string;
  projectId?: string;
  sessionId?: string;
  workerId?: string;
};

function normalizeGoal(goal: string) {
  return goal.trim().toLowerCase().replace(/\s+/g, " ");
}

function truncate(value: string, max = 500) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (/secret|token|password|credential|api[_-]?key|authorization/i.test(key)) return [key, "[redacted]"];
    return [key, redact(entry)];
  }));
}

function summarize(value: unknown) {
  try {
    return truncate(JSON.stringify(redact(value)));
  } catch {
    return truncate(String(value));
  }
}

function splitCommand(command: string) {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return { bin: parts[0] || "pwd", args: parts.slice(1) };
}

function output<T extends Record<string, unknown>>(value: T) {
  return value;
}

function resolveSessionId(sessionId?: string) {
  if (sessionId) return sessionId;
  return listSessions()[0]?.session_id ?? "";
}

async function loggedTool<T>(
  toolName: string,
  input: unknown,
  context: ToolContext,
  action: () => Promise<T> | T,
) {
  const startedAt = new Date().toISOString();
  const call: McpToolCallRecord = {
    mcp_call_id: `mcp_${randomUUID()}`,
    mcp_server: context.mcpServer ?? DEFAULT_MCP_SERVER,
    tool_name: toolName,
    input_summary: summarize(input),
    started_at: startedAt,
    ended_at: null,
    status: "running",
    result_summary: "",
    error: null,
    task_id: context.taskId,
    project_id: context.projectId,
    session_id: context.sessionId,
    worker_id: context.workerId,
  };
  upsertMcpToolCall(call);
  appendOrchestratorEvent({
    scope: "mcp",
    scope_id: call.mcp_call_id,
    type: "mcp.tool.started",
    message: `${call.mcp_server}.${toolName} started.`,
    data: call,
  });

  try {
    const result = await action();
    call.status = "completed";
    call.ended_at = new Date().toISOString();
    call.result_summary = summarize(result);
    upsertMcpToolCall(call);
    appendOrchestratorEvent({
      scope: "mcp",
      scope_id: call.mcp_call_id,
      type: "mcp.tool.completed",
      message: `${call.mcp_server}.${toolName} completed.`,
      data: call,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    call.status = "failed";
    call.ended_at = new Date().toISOString();
    call.error = truncate(message);
    call.result_summary = "failed";
    upsertMcpToolCall(call);
    appendOrchestratorEvent({
      scope: "mcp",
      scope_id: call.mcp_call_id,
      type: "mcp.tool.failed",
      message: `${call.mcp_server}.${toolName} failed: ${truncate(message)}`,
      data: call,
    });
    throw error;
  }
}

export async function createProjectViaMcp(input: {
  session_id: string;
  name: string;
  description: string;
  repo_url?: string;
}) {
  return loggedTool("create_project", input, { sessionId: input.session_id }, () => {
    const workspace = ensureNewProjectDirectory(input.name);
    const project = projectRecordForWorkspace(workspace.workspacePath);
    project.display_name = input.name;
    project.updated_at = new Date().toISOString();
    upsertProject(project);

    const session = getSession(input.session_id);
    if (session) {
      session.current_project_id = project.project_id;
      session.project_id = project.project_id;
      session.workspace_path = project.workspace_path;
      session.project_discovery.status = "selected";
      session.project_discovery.selected_workspace_path = project.workspace_path;
      session.project_discovery.selected_project_name = project.display_name;
      session.project_discovery.confidence = "high";
      session.project_discovery.reason = "Project was created through the Cloud Orchestrator MCP layer.";
      session.last_updated = new Date().toISOString();
      upsertSession(session);
    }

    appendOrchestratorEvent({
      scope: "project",
      scope_id: project.project_id,
      type: "project.created",
      message: `Created project ${project.display_name} through MCP.`,
      data: { project, description: input.description, repo_url: input.repo_url ?? null },
    });

    return output({
      project_id: project.project_id,
      workspace_uri: project.workspace_path,
      status: "created",
    });
  });
}

export async function createTaskViaMcp(input: {
  project_id: string;
  user_goal: string;
  normalized_goal?: string;
}) {
  return loggedTool("create_task", input, { projectId: input.project_id }, () => {
    const task = cloudOrchestrator.createTask(input.project_id, input.user_goal);
    task.normalized_goal = input.normalized_goal?.trim() || normalizeGoal(input.user_goal);
    upsertTask(task);
    return output({ task_id: task.task_id, status: task.status });
  });
}

export async function launchWorkerViaMcp(input: {
  task_id: string;
  project_id: string;
  worker_mode: WorkerType;
}) {
  return loggedTool("launch_worker", input, { taskId: input.task_id, projectId: input.project_id }, async () => {
    const assigned = await cloudOrchestrator.assignWorker(input.task_id, input.worker_mode);
    const worker = assigned.worker;
    return output({
      worker_id: worker.worker_id,
      worker_status: worker.status,
      vm_name: worker.vm_name ?? null,
    });
  });
}

export async function runCodexTaskViaMcp(input: {
  task_id: string;
  project_id: string;
  worker_id: string;
  prompt: string;
  workspace_path: string;
  timeout: number;
}) {
  return loggedTool("run_codex_task", input, {
    taskId: input.task_id,
    projectId: input.project_id,
    workerId: input.worker_id,
  }, async () => {
    const runner = new CommandRunner();
    const event = await runner.run({
      task_id: input.task_id,
      project_id: input.project_id,
      worker_id: input.worker_id,
      command: "codex",
      args: ["exec", "--json", "-C", input.workspace_path, input.prompt],
      cwd: input.workspace_path,
      workspace_path: input.workspace_path,
      timeout_ms: Math.max(1, input.timeout) * 1000,
    });
    const task = getTask(input.task_id);
    if (task) {
      task.codex_run_id = `codex_${event.event_id}`;
      task.status = event.exit_code === 0 ? "completed" : "failed";
      task.latest_summary = event.summary;
      task.updated_at = new Date().toISOString();
      upsertTask(task);
    }
    return output({
      codex_run_id: `codex_${event.event_id}`,
      status: event.exit_code === 0 ? "completed" : "failed",
    });
  });
}

export async function runCommandViaMcp(input: {
  task_id: string;
  project_id: string;
  worker_id: string;
  command: string;
  cwd: string;
  risk_level?: CommandRiskLevel;
}) {
  return loggedTool("run_command", input, {
    taskId: input.task_id,
    projectId: input.project_id,
    workerId: input.worker_id,
  }, async () => {
    const project = getProject(input.project_id);
    const workspacePath = project?.workspace_path ?? input.cwd;
    const { bin, args } = splitCommand(input.command);
    const event = await new CommandRunner().run({
      task_id: input.task_id,
      project_id: input.project_id,
      worker_id: input.worker_id,
      command: bin,
      args,
      cwd: input.cwd,
      workspace_path: workspacePath,
      timeout_ms: 120_000,
    });
    return output({
      command_event_id: event.event_id,
      exit_code: event.exit_code,
      stdout_preview: event.stdout_preview,
      stderr_preview: event.stderr_preview,
    });
  });
}

export async function inspectTaskStateViaMcp(input: { task_id: string }) {
  return loggedTool("inspect_task_state", input, { taskId: input.task_id }, () => {
    const task = getTask(input.task_id);
    if (!task) throw new Error(`Task not found: ${input.task_id}`);
    const commands = listCommandEvents({ taskId: input.task_id });
    const worker = task.worker_id ? getWorker(task.worker_id) : commands.at(-1)?.worker_id ? getWorker(commands.at(-1)!.worker_id) : null;
    const summary = getRunSummary(input.task_id);
    return output({
      task_status: task.status,
      commands,
      worker_status: worker?.status ?? null,
      files_changed: summary?.files_changed ?? [],
      latest_summary: summary ?? task.latest_summary,
    });
  });
}

export async function inspectWorkerViaMcp(input: { worker_id: string }) {
  return loggedTool("inspect_worker", input, { workerId: input.worker_id }, () => {
    const worker = getWorker(input.worker_id);
    if (!worker) throw new Error(`Worker not found: ${input.worker_id}`);
    const commands = listCommandEvents({ workerId: worker.worker_id });
    const active = commands.find((event) => event.exit_code === null) ?? null;
    return output({
      mode: worker.type,
      status: worker.status,
      heartbeat: worker.heartbeat_at,
      active_command: active?.command ?? null,
      logs: commands.map((event) => event.summary),
    });
  });
}

export async function stopWorkerViaMcp(input: { worker_id: string; session_id?: string }) {
  return operatorActionViaMcp("stop_worker", input, "stop_worker", "stop worker");
}

async function operatorActionViaMcp(
  toolName: string,
  input: Record<string, unknown> & { session_id?: string; worker_id?: string; task_id?: string; project_id?: string; command_id?: string },
  actionType: import("../../../codex-phone-supervisor/backend/src/types.js").OperatorActionType,
  userGoal: string,
) {
  return loggedTool(toolName, input, {
    sessionId: input.session_id,
    taskId: input.task_id,
    projectId: input.project_id,
    workerId: input.worker_id,
  }, async () => {
    const sessionId = resolveSessionId(input.session_id);
    if (!sessionId) throw new Error("session_id is required when no sessions exist.");
    const result = await actionRouter.execute({
      session_id: sessionId,
      action_type: actionType,
      user_goal: userGoal,
      input,
      project_id: input.project_id,
      task_id: input.task_id,
      worker_id: input.worker_id,
      command_id: input.command_id,
    });
    return output({
      action_id: result.action.action_id,
      status: result.action.status,
      response: result.response,
      result: result.action.result,
      approval_id: result.action.approval_id ?? null,
    });
  });
}

export async function listWorkersViaMcp(input: { session_id?: string } = {}) {
  return operatorActionViaMcp("list_workers", input, "list_workers", "list workers");
}

export async function startWorkerViaMcp(input: { session_id?: string; task_id?: string; project_id?: string; worker_mode?: WorkerType } = {}) {
  return operatorActionViaMcp("start_worker", input, "start_worker", "start worker");
}

export async function restartWorkerViaMcp(input: { session_id?: string; worker_id: string }) {
  return operatorActionViaMcp("restart_worker", input, "restart_worker", "restart worker");
}

export async function runWorkerCommandViaMcp(input: { session_id?: string; task_id?: string; project_id?: string; worker_id?: string; command: string; cwd?: string }) {
  return operatorActionViaMcp("run_worker_command", input, "run_worker_command", `run ${input.command}`);
}

export async function inspectCommandViaMcp(input: { session_id?: string; task_id?: string; command_id?: string } = {}) {
  return operatorActionViaMcp("inspect_command", input, "inspect_command", "inspect command");
}

export async function tailLogsViaMcp(input: { session_id?: string; task_id?: string; worker_id?: string; lines?: number; kind?: "worker" | "task" | "api" } = {}) {
  const type = input.kind === "api" ? "tail_api_logs" : input.kind === "task" ? "tail_task_logs" : "tail_worker_logs";
  return operatorActionViaMcp("tail_logs", input, type, "tail logs");
}

export async function cleanupIdleWorkersViaMcp(input: { session_id?: string } = {}) {
  return operatorActionViaMcp("cleanup_idle_workers", input, "cleanup_idle_workers", "cleanup idle workers");
}

export async function inspectCodexHistoryViaMcp(input: { session_id?: string; task_id?: string; command_id?: string } = {}) {
  return operatorActionViaMcp("inspect_codex_history", input, "inspect_codex_history", "inspect Codex history");
}

export async function generateTaskSummaryViaMcp(input: { task_id: string }) {
  return loggedTool("generate_task_summary", input, { taskId: input.task_id }, () => {
    const summary = generateRunSummary(input.task_id);
    return output({
      executive_summary: summary.executive_summary,
      technical_summary: summary.technical_summary,
      files_changed: summary.files_changed,
      commands_run: summary.commands_run,
      failures: summary.failures,
      next_plan: summary.next_plan,
    });
  });
}

export async function requestApprovalViaMcp(input: {
  task_id: string;
  action: string;
  reason: string;
  risk_level: CommandRiskLevel;
}) {
  return loggedTool("request_approval", input, { taskId: input.task_id }, () => {
    const task = getTask(input.task_id);
    if (!task) throw new Error(`Task not found: ${input.task_id}`);
    const approval = upsertApprovalRequest({
      approval_id: `approval_${randomUUID()}`,
      task_id: task.task_id,
      project_id: task.project_id,
      requested_action: input.action,
      reason: input.reason,
      risk_level: input.risk_level,
      status: "pending",
      created_at: new Date().toISOString(),
      resolved_at: null,
    });
    appendOrchestratorEvent({
      scope: "approval",
      scope_id: approval.approval_id,
      type: "approval.requested",
      message: `Approval requested for ${input.action}.`,
      data: approval,
    });
    return output({ approval_id: approval.approval_id, status: approval.status });
  });
}

function parseGcloudInstances(stdout: string) {
  try {
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return parsed.map((item) => ({
      name: String(item.name ?? ""),
      zone: String(item.zone ?? "").split("/").at(-1) ?? "",
      status: String(item.status ?? ""),
      labels: item.labels ?? {},
      creation_timestamp: String(item.creationTimestamp ?? ""),
    }));
  } catch {
    return [];
  }
}

export async function listGcpWorkersViaMcp(input: { env: string }) {
  return loggedTool("list_gcp_workers", input, {}, () => {
    const storeWorkers = listWorkers()
      .filter((worker) => worker.type === "gcp_vm")
      .filter((worker) => !["stopped", "expired"].includes(worker.status))
      .map((worker) => ({
        source: "orchestrator_store",
        worker_id: worker.worker_id,
        vm_name: worker.vm_name ?? null,
        status: worker.status,
        labels: { app: "head-developer", env: input.env, worker_id: worker.worker_id, task_id: worker.task_id ?? "" },
        uptime_ms: Math.max(0, Date.now() - Date.parse(worker.created_at)),
      }));

    const project = process.env.GCP_PROJECT_ID;
    const zone = process.env.GCP_ZONE || "us-central1-a";
    const gcloud = project
      ? spawnSync("gcloud", [
          "compute",
          "instances",
          "list",
          `--project=${project}`,
          `--zones=${zone}`,
          `--filter=labels.app=head-developer AND labels.env=${input.env}`,
          "--format=json",
        ], { encoding: "utf8" })
      : null;
    const gcloudWorkers = gcloud?.status === 0 ? parseGcloudInstances(gcloud.stdout) : [];

    return output({
      active_vm_workers: [...storeWorkers, ...gcloudWorkers.map((worker) => ({ source: "gcloud_read", ...worker }))],
    });
  });
}

export async function cleanupExpiredWorkersViaMcp(input: { max_age_minutes: number }) {
  return loggedTool("cleanup_expired_workers", input, {}, async () => {
    const cutoffMs = Math.max(1, input.max_age_minutes) * 60_000;
    const expired = listWorkers().filter((worker) => {
      if (["stopped", "expired"].includes(worker.status)) return false;
      const ageMs = Date.now() - Date.parse(worker.created_at);
      const lifetimeExpired = Date.parse(worker.expires_at) <= Date.now();
      return lifetimeExpired || ageMs >= cutoffMs;
    });

    const stopped: string[] = [];
    for (const worker of expired) {
      const result = await workerManagerFor(worker.type).stopWorker(worker.worker_id);
      stopped.push(result.worker_id);
    }

    return output({
      workers_stopped: stopped,
      workers_deleted: [],
    });
  });
}

export function listMcpActions() {
  return listMcpToolCalls();
}
