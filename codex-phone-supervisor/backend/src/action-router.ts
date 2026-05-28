import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyCommand } from "./command-policy.js";
import { CommandRunner } from "./command-runner.js";
import { documentationIndexer, DOCUMENTATION_INDEX_FILES } from "./documentation-indexer.js";
import { dockerExec } from "./docker-exec.js";
import { startPreviewForSession } from "./preview.js";
import { getProject } from "./project-store.js";
import { redactSensitiveText } from "./redaction.js";
import { isActiveCodexCommand } from "./worker-task-guard.js";
import {
  appendOrchestratorEvent,
  getApprovalRequest,
  getCommandEvent,
  getOperatorAction,
  getRunSummary,
  getSession,
  getTask,
  getTaskGraph,
  getWorker,
  listCommandEvents,
  listOrchestratorEvents,
  listOperatorActions,
  listSessions,
  listTasks,
  listWorkers,
  upsertApprovalRequest,
  upsertOperatorAction,
  upsertSession,
  upsertTask,
  upsertTaskGraph,
  upsertWorkerRuntimeCommandRequest,
} from "./store.js";
import { workerManagerFor } from "./workers.js";
import type {
  CommandEventRecord,
  CommandRiskLevel,
  OperatorActionRecord,
  OperatorActionType,
  SessionState,
  TaskRecord,
  WorkerRecord,
  WorkerType,
} from "./types.js";

export interface OperatorActionRequest {
  session_id: string;
  action_type: OperatorActionType;
  user_goal?: string;
  input?: Record<string, unknown>;
  project_id?: string | null;
  task_id?: string | null;
  worker_id?: string | null;
  command_id?: string | null;
  approved_by_user?: boolean;
}

export interface ParsedOperatorIntent {
  action_type: OperatorActionType;
  input: Record<string, unknown>;
  normalized_intent: string;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function latestByUpdatedAt<T extends { updated_at?: string; created_at?: string }>(items: T[]) {
  return [...items].sort((a, b) => (b.updated_at ?? b.created_at ?? "").localeCompare(a.updated_at ?? a.created_at ?? ""))[0] ?? null;
}

function activeTaskForSession(session: SessionState | null): TaskRecord | null {
  if (!session) return null;
  if (session.active_task_id) return getTask(session.active_task_id);
  if (session.project_id || session.current_project_id) {
    return latestByUpdatedAt(listTasks(session.project_id ?? session.current_project_id ?? undefined));
  }
  return null;
}

function activeWorkerForSession(session: SessionState | null): WorkerRecord | null {
  if (!session) return null;
  if (session.active_worker_id) return getWorker(session.active_worker_id);
  const task = activeTaskForSession(session);
  if (task?.worker_id) return getWorker(task.worker_id);
  return null;
}

function resolveTask(session: SessionState | null, explicitTaskId?: string | null) {
  if (explicitTaskId) return getTask(explicitTaskId);
  return activeTaskForSession(session);
}

function resolveWorker(session: SessionState | null, explicitWorkerId?: string | null) {
  if (explicitWorkerId) return getWorker(explicitWorkerId);
  return activeWorkerForSession(session);
}

function splitCommand(command: string) {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const parts = matches.map((part) => part.replace(/^["']|["']$/g, ""));
  return { bin: parts[0] || "pwd", args: parts.slice(1) };
}

function normalizeIntent(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function truncate(value: string, max = 2000) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function compact(value: string | null | undefined, max = 160) {
  return value?.trim() ? truncate(value, max) : "";
}

function redactSecrets(value: string) {
  return redactSensitiveText(value);
}

function actionNodeKind(actionType: OperatorActionType) {
  if (["start_worker", "stop_worker", "restart_worker", "cleanup_idle_workers", "assign_worker"].includes(actionType)) return "worker_control";
  if (["run_worker_command", "run_project_command", "inspect_command"].includes(actionType)) return "command_action";
  if (["tail_worker_logs", "tail_task_logs", "tail_api_logs"].includes(actionType)) return "log_inspection";
  if (actionType === "inspect_codex_history") return "codex_history";
  return "operator_action";
}

function activeTaskStatuses(status: TaskRecord["status"]) {
  return status === "queued" || status === "planning" || status === "running" || status === "waiting_for_approval";
}

function workerHasActiveTask(worker: WorkerRecord) {
  const task = worker.task_id ? getTask(worker.task_id) : null;
  return Boolean(task && activeTaskStatuses(task.status) && ["starting", "assigned", "running"].includes(worker.status));
}

function resultText(result: Record<string, unknown> | null) {
  if (!result) return "";
  if (typeof result.message === "string") return result.message;
  if (typeof result.summary === "string") return result.summary;
  return "Action completed. Details are available in the operator side panel.";
}

function commandFromInput(input: Record<string, unknown>) {
  return text(input.command || input.shell || input.text || input.query);
}

function commandWorkspace(task: TaskRecord | null, projectId: string | null | undefined, cwdInput: unknown) {
  const project = projectId ? getProject(projectId) : task?.project_id ? getProject(task.project_id) : null;
  const workspace = project?.workspace_path || text(cwdInput) || process.cwd();
  const cwd = text(cwdInput) || workspace;
  return { workspace, cwd, project };
}

function commandRuntime(worker: WorkerRecord | null) {
  return {
    worker_mode: worker?.actual_worker_mode ?? worker?.type,
    actual_image_uri: worker?.actual_image_uri ?? worker?.runtime_image_uri,
    actual_image_digest: worker?.actual_image_digest ?? worker?.runtime_image_digest,
    vm_name: worker?.actual_vm_name ?? worker?.runtime_vm_name ?? worker?.vm_name,
    startup_attempt_id: worker?.startup_attempt_id,
    run_attempt_id: worker?.run_attempt_id,
    container_started_at: worker?.container_started_at,
    worker_runtime_version: worker?.worker_runtime_version,
    docker_container_id: worker?.docker_container_id,
    docker_container_name: worker?.docker_container_name,
    runtime_metadata_verified: Boolean(worker?.metadata_verified_from_runtime),
  };
}

function latestCommandForTask(taskId: string) {
  return listCommandEvents({ taskId }).sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

function latestCommandForWorker(workerId: string) {
  return listCommandEvents({ workerId }).sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

function activeCommandForWorker(workerId: string) {
  return listCommandEvents({ workerId })
    .filter((event) => event.exit_code === null)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

function latestCodexCommand(taskId: string) {
  return listCommandEvents({ taskId })
    .filter((event) => /\bcodex\s+exec\b/i.test(event.command) || event.codex_history_kind)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

function inspectWorkerResult(worker: WorkerRecord) {
  const task = worker.task_id ? getTask(worker.task_id) : null;
  const commands = listCommandEvents({ workerId: worker.worker_id });
  const activeCommand = commands.find((event) => event.exit_code === null) ?? null;
  const recentEvents = listOrchestratorEvents(worker.worker_id).slice(-20);
  const logs = commands.slice(-20).map((event) => redactSecrets(`${event.command}: ${event.summary} ${event.stderr_preview || event.stdout_preview}`));
  return {
    worker_id: worker.worker_id,
    mode: worker.actual_worker_mode ?? worker.type,
    status: worker.status,
    active_task: task?.task_id ?? null,
    active_command: activeCommand,
    heartbeat: worker.heartbeat_at,
    uptime_ms: Math.max(0, Date.now() - Date.parse(worker.created_at)),
    actual_runtime_image: worker.actual_image_uri ?? worker.runtime_image_uri ?? null,
    image_digest: worker.actual_image_digest ?? worker.runtime_image_digest ?? null,
    vm_name: worker.actual_vm_name ?? worker.runtime_vm_name ?? worker.vm_name ?? null,
    docker_container: worker.docker_container_name ?? worker.docker_container_id ?? (typeof worker.metadata?.compose_service === "string" ? worker.metadata.compose_service : null),
    codex_history: {
      codex_home: worker.codex_home ?? null,
      codex_home_host_path: worker.codex_home_host_path ?? null,
      sessions_path: worker.codex_history_sessions_path ?? null,
    },
    last_20_events: recentEvents,
    last_20_log_lines: logs,
    stop_eligibility: workerHasActiveTask(worker) ? "requires_approval" : "allowed",
    restart_eligibility: workerHasActiveTask(worker) ? "requires_approval" : "allowed",
  };
}

function workerModeLabel(mode: WorkerType | string | null | undefined) {
  if (mode === "docker_local") return "Docker Local";
  if (mode === "gcp_vm") return "GCP VM";
  if (mode === "gke_job") return "GKE Job";
  if (mode === "local") return "local";
  return mode || "unknown";
}

function isActiveWorker(worker: WorkerRecord) {
  return !["failed", "stopped", "expired"].includes(worker.status);
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function commandStatus(command: CommandEventRecord | null) {
  if (!command) return "no command event is recorded";
  return command.exit_code === null
    ? `running ${command.command}`
    : `${command.command} exited ${command.exit_code}`;
}

function taskStatus(task: TaskRecord | null) {
  if (!task) return "no task attached";
  return `task ${task.task_id} is ${task.status}${task.user_goal ? `: ${compact(task.user_goal, 110)}` : ""}`;
}

function worktreeStatus(task: TaskRecord | null) {
  return task?.worktree_path ? ` Worktree: ${task.worktree_path}.` : "";
}

function duplicateCodexStatus() {
  const activeCodexCommands = listCommandEvents().filter(isActiveCodexCommand);
  const byTask = new Map<string, CommandEventRecord[]>();
  for (const command of activeCodexCommands) {
    byTask.set(command.task_id, [...(byTask.get(command.task_id) ?? []), command]);
  }
  const duplicates = [...byTask.entries()].filter(([, commands]) => commands.length > 1);
  if (!duplicates.length) return "No duplicate Codex commands are active.";
  return `Duplicate active Codex commands are recorded for ${duplicates.map(([taskId, commands]) => `${taskId} on ${commands.map((command) => command.worker_id).join(", ")}`).join("; ")}.`;
}

function workerLine(worker: WorkerRecord) {
  const task = worker.task_id ? getTask(worker.task_id) : null;
  const activeCommand = activeCommandForWorker(worker.worker_id);
  const latestCommand = activeCommand ?? latestCommandForWorker(worker.worker_id);
  return [
    `Worker ${worker.worker_id}: ${workerModeLabel(worker.actual_worker_mode ?? worker.type)}, ${worker.status};`,
    `${taskStatus(task)};`,
    `command status: ${commandStatus(latestCommand)}.`,
    worktreeStatus(task),
  ].join(" ").replace(/\s+/g, " ").trim();
}

function listWorkersMessage(workers: WorkerRecord[]) {
  if (!workers.length) return "No workers are recorded.";
  const active = workers.filter(isActiveWorker);
  const modeCounts = active.reduce<Record<string, number>>((counts, worker) => {
    const label = workerModeLabel(worker.actual_worker_mode ?? worker.type);
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const modeText = Object.entries(modeCounts).map(([mode, count]) => `${count} ${mode}`).join(", ") || "0 active";
  const shown = workers.slice(0, 5).map(workerLine);
  const hidden = workers.length > shown.length ? ` ${countLabel(workers.length - shown.length, "additional worker")} not shown in chat.` : "";
  return [
    `${countLabel(active.length, "worker")} active (${modeText}); ${countLabel(workers.length, "worker")} recorded.`,
    ...shown,
    `${duplicateCodexStatus()}${hidden}`,
  ].join(" ");
}

function inspectWorkerMessage(worker: WorkerRecord) {
  const task = worker.task_id ? getTask(worker.task_id) : null;
  const activeCommand = activeCommandForWorker(worker.worker_id);
  const latestCommand = activeCommand ?? latestCommandForWorker(worker.worker_id);
  const heartbeat = worker.heartbeat_at ? ` Last heartbeat: ${worker.heartbeat_at}.` : " No heartbeat has been recorded yet.";
  return [
    `Worker ${worker.worker_id} is ${worker.status} in ${workerModeLabel(worker.actual_worker_mode ?? worker.type)} mode.`,
    `${taskStatus(task)}.`,
    `Command status: ${commandStatus(latestCommand)}.`,
    worktreeStatus(task),
    heartbeat,
  ].join(" ").replace(/\s+/g, " ").trim();
}

function commandMessage(command: CommandEventRecord, task: TaskRecord | null) {
  const workerText = command.worker_id ? ` on worker ${command.worker_id}` : "";
  const taskText = task ? ` Task ${task.task_id} is ${task.status}.` : "";
  return command.exit_code === null
    ? `Running command${workerText}: ${command.command}.${taskText}`
    : `Latest command${workerText}: ${command.command} exited ${command.exit_code}.${taskText}`;
}

function approvalPrompt(action: OperatorActionRecord) {
  const worker = action.worker_id ? getWorker(action.worker_id) : null;
  const task = action.task_id ? getTask(action.task_id) : worker?.task_id ? getTask(worker.task_id) : null;
  const reason = typeof action.result?.reason === "string" ? action.result.reason : "this can change active worker or task state";
  const target = worker ? `worker ${worker.worker_id}` : task ? `task ${task.task_id}` : "this action";
  if (action.action_type === "stop_worker") {
    return `Approval needed before stopping ${target}. ${task ? `Task ${task.task_id} is ${task.status}. ` : ""}${reason} Say "approve" to continue or "reject" to leave it running.`;
  }
  if (action.action_type === "restart_worker") {
    return `Approval needed before restarting ${target}. ${task ? `Task ${task.task_id} is ${task.status}. ` : ""}${reason} Say "approve" to continue or "reject" to leave it running.`;
  }
  if (action.action_type === "run_worker_command" || action.action_type === "run_project_command") {
    const command = commandFromInput(action.input);
    return `Approval needed before running ${command || "that command"}. ${reason}`;
  }
  return resultText(action.result) || `${action.action_type} requires approval.`;
}

function createApprovalForAction(action: OperatorActionRecord, reason: string, risk: CommandRiskLevel) {
  const task = action.task_id ? getTask(action.task_id) : null;
  const approval = upsertApprovalRequest({
    approval_id: `approval_${randomUUID()}`,
    task_id: action.task_id ?? task?.task_id ?? "operator_action",
    project_id: action.project_id ?? task?.project_id ?? "operator_action",
    requested_action: `${action.action_type}: ${action.user_goal}`,
    reason,
    risk_level: risk,
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
  });
  action.approval_id = approval.approval_id;
  action.risk_level = risk;
  action.requires_approval = true;
  action.status = "waiting_for_approval";
  action.result = { approval_id: approval.approval_id, status: approval.status, reason };
  upsertOperatorAction(action);
  const session = getSession(action.session_id);
  if (session) {
    session.pending_action = {
      type: "approve_operator_action",
      original_user_goal: action.user_goal,
      requested_kind: "tool",
      action: action.action_type,
      reason,
      risk_level: risk,
      approval_id: approval.approval_id,
      operator_action_id: action.action_id,
      target_project_id: action.project_id ?? undefined,
      target_task_id: action.task_id ?? undefined,
      target_worker_id: action.worker_id ?? undefined,
      created_at: new Date().toISOString(),
    };
    session.pending_action_payload = { operator_action_id: action.action_id, approval_id: approval.approval_id };
    session.latest_codex_message = `${action.action_type} requires approval: ${reason}`;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
  }
  appendOrchestratorEvent({
    scope: "approval",
    scope_id: approval.approval_id,
    type: "approval.requested",
    message: `${action.action_type} requires approval.`,
    data: { approval, action },
  });
  return approval;
}

function recordActionEvent(action: OperatorActionRecord, type: string, message: string) {
  appendOrchestratorEvent({
    scope: "operator_action",
    scope_id: action.action_id,
    type,
    message,
    data: action,
  });
}

export function parseOperatorIntent(message: string): ParsedOperatorIntent | null {
  const cleaned = normalizeIntent(message);
  if (!cleaned) return null;
  if (/^(what is happening|what's happening|summarize current state|current state)\??$/.test(cleaned)) {
    return { action_type: "summarize_current_state", input: {}, normalized_intent: cleaned };
  }
  if (/^(what command is running|what command's running|show command output|show stderr)\??$/.test(cleaned)) {
    return { action_type: "inspect_command", input: { stream: cleaned.includes("stderr") ? "stderr" : "summary" }, normalized_intent: cleaned };
  }
  if (/^(show worker logs|tail logs|show logs|show last \d+ lines|show api logs|show task events)/.test(cleaned)) {
    const lines = Number(cleaned.match(/last\s+(\d+)/)?.[1] ?? "20");
    if (cleaned.includes("api")) return { action_type: "tail_api_logs", input: { lines }, normalized_intent: cleaned };
    if (cleaned.includes("task events")) return { action_type: "tail_task_logs", input: { lines }, normalized_intent: cleaned };
    return { action_type: "tail_worker_logs", input: { lines }, normalized_intent: cleaned };
  }
  if (/\b(list|what|which|show)\b[\s\S]*\bworkers?\b/.test(cleaned) && !/\bstop|restart|start\b/.test(cleaned) && !/\b(gcp|cloud|logs?)\b/.test(cleaned)) {
    return { action_type: "list_workers", input: {}, normalized_intent: cleaned };
  }
  if (/\binspect\b[\s\S]*\bworker\b|\bwhat\b[\s\S]*\bworker\b[\s\S]*\bdoing\b|\blook inside\b[\s\S]*\bworker\b/.test(cleaned)) {
    const workerId = message.match(/worker_[\w-]+/)?.[0];
    return { action_type: "inspect_worker", input: workerId ? { worker_id: workerId } : {}, normalized_intent: cleaned };
  }
  if (/\b(start|launch)\b[\s\S]*\b(worker|docker worker|gcp worker|gke worker|kubernetes worker|local worker)\b/.test(cleaned)) {
    const mode: WorkerType | undefined = /\b(gke|kubernetes|k8s)\b/.test(cleaned) ? "gke_job" : cleaned.includes("gcp") ? "gcp_vm" : cleaned.includes("docker") ? "docker_local" : cleaned.includes("local") ? "local" : undefined;
    return { action_type: "start_worker", input: mode ? { worker_mode: mode } : {}, normalized_intent: cleaned };
  }
  if (/\brestart\b[\s\S]*\bworker\b/.test(cleaned)) {
    const workerId = message.match(/worker_[\w-]+/)?.[0];
    return { action_type: "restart_worker", input: workerId ? { worker_id: workerId } : {}, normalized_intent: cleaned };
  }
  if (/\b(stop|cancel)\b[\s\S]*\bworker\b/.test(cleaned)) {
    const workerId = message.match(/worker_[\w-]+/)?.[0];
    return { action_type: "stop_worker", input: workerId ? { worker_id: workerId } : {}, normalized_intent: cleaned };
  }
  if (/\b(clean up|cleanup)\b[\s\S]*\bidle\s+workers?\b/.test(cleaned)) {
    return { action_type: "cleanup_idle_workers", input: {}, normalized_intent: cleaned };
  }
  if (/\bcancel\b[\s\S]*\btask\b/.test(cleaned)) {
    return { action_type: "cancel_task", input: {}, normalized_intent: cleaned };
  }
  if (/\bretry\b[\s\S]*(task|failed command|failed step|command)/.test(cleaned)) {
    return { action_type: "retry_task", input: {}, normalized_intent: cleaned };
  }
  if (/^(preview it|open it in browser|preview latest app|open preview)\.?$/.test(cleaned)) {
    return { action_type: "open_preview", input: {}, normalized_intent: cleaned };
  }
  if (/\b(show|inspect|open|verify|where)\b[\s\S]*\bcodex\b[\s\S]*(history|session|resume)/.test(cleaned)) {
    return { action_type: "inspect_codex_history", input: {}, normalized_intent: cleaned };
  }
  if (/\b(show|inspect)\b[\s\S]*\b(project docs|docs|documentation)\b/.test(cleaned)) {
    return { action_type: "inspect_project_docs", input: {}, normalized_intent: cleaned };
  }
  if (/\bwhat\b[\s\S]*\bfunctions?\b[\s\S]*\b(exist|available|defined)\b|\bshow\b[\s\S]*\bfunctions?\b/.test(cleaned)) {
    return { action_type: "inspect_functions", input: {}, normalized_intent: cleaned };
  }
  if (/\bwhat\b[\s\S]*\bvariables?\b[\s\S]*\b(matter|exist|available|defined)\b|\bshow\b[\s\S]*\bvariables?\b/.test(cleaned)) {
    return { action_type: "inspect_variables", input: {}, normalized_intent: cleaned };
  }
  if (/\bwhat\b[\s\S]*\bstate model\b|\bshow\b[\s\S]*\bstate model\b/.test(cleaned)) {
    return { action_type: "inspect_state_model", input: {}, normalized_intent: cleaned };
  }
  if (/\b(show|inspect)\b[\s\S]*\bhandoff\b/.test(cleaned)) {
    return { action_type: "inspect_handoff", input: {}, normalized_intent: cleaned };
  }
  if (/\bare\b[\s\S]*\bdocs\b[\s\S]*\b(up to date|fresh)\b/.test(cleaned)) {
    return { action_type: "inspect_project_docs", input: { freshness: true }, normalized_intent: cleaned };
  }
  if (/\bupdate\b[\s\S]*\bdocs\b/.test(cleaned)) {
    return { action_type: "update_project_docs", input: {}, normalized_intent: cleaned };
  }
  if (/^run\s+/.test(cleaned) && !/\b(local|docker|gcp|cloud|mode|instead|future tasks?|next task)\b/.test(cleaned)) {
    const command = message.trim().replace(/^run\s+/i, "").replace(/\s+in the worker\.?$/i, "").trim();
    return { action_type: "run_worker_command", input: { command }, normalized_intent: cleaned };
  }
  return null;
}

export class ActionRouter {
  parse(message: string) {
    return parseOperatorIntent(message);
  }

  async execute(request: OperatorActionRequest) {
    const session = getSession(request.session_id);
    if (!session) throw new Error(`Session not found: ${request.session_id}`);
    const action = this.createActionRecord(session, request);
    upsertOperatorAction(action);
    recordActionEvent(action, "operator.action.started", `${action.action_type} started.`);
    try {
      const result = await this.perform(action, Boolean(request.approved_by_user));
      if (action.status !== "waiting_for_approval") {
        action.status = "completed";
        action.completed_at = new Date().toISOString();
        action.result = result;
        upsertOperatorAction(action);
        recordActionEvent(action, "operator.action.completed", resultText(result) || `${action.action_type} completed.`);
      }
      return { action, response: this.responseFor(action) };
    } catch (error) {
      action.status = action.status === "blocked" ? "blocked" : "failed";
      action.completed_at = new Date().toISOString();
      action.error = error instanceof Error ? error.message : String(error);
      upsertOperatorAction(action);
      recordActionEvent(action, "operator.action.failed", `${action.action_type} failed: ${action.error}`);
      return { action, response: action.error };
    }
  }

  async executeParsed(sessionId: string, message: string) {
    const parsed = this.parse(message);
    if (!parsed) return null;
    return this.execute({
      session_id: sessionId,
      action_type: parsed.action_type,
      user_goal: message,
      input: parsed.input,
    });
  }

  private createActionRecord(session: SessionState, request: OperatorActionRequest): OperatorActionRecord {
    const now = new Date().toISOString();
    const task = resolveTask(session, request.task_id ?? text(request.input?.task_id));
    const worker = resolveWorker(session, request.worker_id ?? text(request.input?.worker_id));
    const projectId = request.project_id ?? task?.project_id ?? session.project_id ?? session.current_project_id ?? null;
    return {
      action_id: `action_${randomUUID()}`,
      action_type: request.action_type,
      session_id: session.session_id,
      project_id: projectId,
      task_id: request.task_id ?? task?.task_id ?? null,
      worker_id: request.worker_id ?? worker?.worker_id ?? null,
      command_id: request.command_id ?? (text(request.input?.command_id) || null),
      approval_id: null,
      user_goal: request.user_goal ?? request.action_type,
      normalized_intent: normalizeIntent(request.user_goal ?? request.action_type),
      input: request.input ?? {},
      risk_level: "low",
      requires_approval: false,
      status: "running",
      started_at: now,
      completed_at: null,
      result: null,
      error: null,
    };
  }

  private async perform(action: OperatorActionRecord, approvedByUser: boolean): Promise<Record<string, unknown>> {
    switch (action.action_type) {
      case "inspect_system":
        return this.inspectSystem();
      case "list_workers":
        return { workers: listWorkers() };
      case "inspect_worker":
        return this.inspectWorker(action);
      case "start_worker":
        return this.startWorker(action);
      case "stop_worker":
        return this.stopWorker(action, approvedByUser);
      case "restart_worker":
        return this.restartWorker(action, approvedByUser);
      case "assign_worker":
        return this.startWorker(action);
      case "cancel_task":
        return this.cancelTask(action, approvedByUser);
      case "retry_task":
        return this.retryTask(action, approvedByUser);
      case "run_worker_command":
      case "run_project_command":
        return this.runCommand(action, approvedByUser);
      case "inspect_task":
        return this.inspectTask(action);
      case "inspect_command":
        return this.inspectCommand(action);
      case "tail_worker_logs":
      case "tail_task_logs":
      case "tail_api_logs":
        return this.tailLogs(action);
      case "open_preview":
        return this.openPreview(action);
      case "cleanup_idle_workers":
        return this.cleanupIdleWorkers(action);
      case "inspect_codex_history":
        return this.inspectCodexHistory(action);
      case "inspect_project_docs":
        return this.inspectProjectDocs(action);
      case "inspect_functions":
        return this.inspectDocFile(action, "FUNCTIONS.md", "Function docs");
      case "inspect_variables":
        return this.inspectDocFile(action, "VARIABLES.md", "Variable docs");
      case "inspect_state_model":
        return this.inspectDocFile(action, "STATE_MODEL.md", "State model docs");
      case "inspect_handoff":
        return this.inspectDocFile(action, "WORKER_HANDOFFS.md", "Worker handoff");
      case "update_project_docs":
        return this.updateProjectDocs(action);
      case "summarize_current_state":
        return this.summarizeCurrentState(action);
      case "request_approval":
        createApprovalForAction(action, text(action.input.reason) || "Approval requested by operator.", action.risk_level || "medium");
        return action.result ?? {};
      default:
        throw new Error(`Unsupported operator action: ${action.action_type}`);
    }
  }

  private responseFor(action: OperatorActionRecord) {
    if (action.status === "waiting_for_approval") return approvalPrompt(action);
    if (action.error) return action.error;
    if (action.action_type === "list_workers") return listWorkersMessage(listWorkers());
    if (action.action_type === "inspect_worker" && action.worker_id) {
      const worker = getWorker(action.worker_id);
      if (worker) return inspectWorkerMessage(worker);
    }
    return resultText(action.result) || `${action.action_type} completed.`;
  }

  private inspectSystem() {
    const workers = listWorkers();
    const tasks = listTasks();
    return {
      message: `There are ${workers.length} workers and ${tasks.filter((task) => activeTaskStatuses(task.status)).length} active tasks.`,
      sessions: listSessions().length,
      workers,
      active_tasks: tasks.filter((task) => activeTaskStatuses(task.status)),
    };
  }

  private inspectWorker(action: OperatorActionRecord) {
    const worker = action.worker_id ? getWorker(action.worker_id) : null;
    if (!worker) throw new Error("No worker is available to inspect.");
    return inspectWorkerResult(worker);
  }

  private async startWorker(action: OperatorActionRecord) {
    const task = action.task_id ? getTask(action.task_id) : null;
    if (!task) throw new Error("Start worker needs an active task.");
    const mode = (text(action.input.worker_mode) || text(action.input.mode) || "local") as WorkerType;
    const worker = await workerManagerFor(mode).createWorker(task.task_id, task.project_id, mode);
    const assigned = await workerManagerFor(mode).assignTask(worker.worker_id, task.task_id);
    action.worker_id = assigned.worker_id;
    action.task_id = task.task_id;
    action.project_id = task.project_id;
    return { message: `Started ${mode} worker ${assigned.worker_id} for task ${task.task_id}.`, worker: assigned };
  }

  private async stopWorker(action: OperatorActionRecord, approvedByUser: boolean) {
    const worker = action.worker_id ? getWorker(action.worker_id) : null;
    if (!worker) throw new Error("No worker is available to stop.");
    const active = workerHasActiveTask(worker);
    if (active && !approvedByUser) {
      const approval = createApprovalForAction(action, "Stopping an active worker can interrupt a running task.", "medium");
      return { message: `Stopping active worker ${worker.worker_id} requires approval.`, approval_id: approval.approval_id };
    }
    if (active && worker.task_id) {
      const task = getTask(worker.task_id);
      if (task) {
        task.status = "cancelled";
        task.latest_summary = "Cancelled by approved operator worker stop.";
        task.updated_at = new Date().toISOString();
        upsertTask(task);
      }
    }
    const stopped = await workerManagerFor(worker.type).stopWorker(worker.worker_id);
    return { message: `Stopped worker ${stopped.worker_id}. Status: ${stopped.status}.`, worker: stopped };
  }

  private async restartWorker(action: OperatorActionRecord, approvedByUser: boolean) {
    const worker = action.worker_id ? getWorker(action.worker_id) : null;
    if (!worker) throw new Error("No worker is available to restart.");
    if (workerHasActiveTask(worker) && !approvedByUser) {
      const approval = createApprovalForAction(action, "Restarting an active worker can abandon in-flight work.", "medium");
      return { message: `Restarting active worker ${worker.worker_id} requires approval.`, approval_id: approval.approval_id };
    }
    const stopped = await workerManagerFor(worker.type).stopWorker(worker.worker_id);
    const taskId = worker.task_id;
    const projectId = worker.project_id;
    if (!taskId || !projectId) return { message: `Stopped worker ${stopped.worker_id}; no task is attached for restart.`, worker: stopped };
    const restarted = await workerManagerFor(worker.type).createWorker(taskId, projectId, worker.type);
    await workerManagerFor(worker.type).assignTask(restarted.worker_id, taskId);
    action.worker_id = restarted.worker_id;
    return { message: `Restarted worker ${worker.worker_id} as ${restarted.worker_id}.`, previous_worker: stopped, worker: restarted };
  }

  private async cancelTask(action: OperatorActionRecord, approvedByUser: boolean) {
    const task = action.task_id ? getTask(action.task_id) : null;
    if (!task) throw new Error("No task is available to cancel.");
    if (activeTaskStatuses(task.status) && !approvedByUser) {
      const approval = createApprovalForAction(action, "Cancelling an active task requires approval.", "medium");
      return { message: `Cancelling active task ${task.task_id} requires approval.`, approval_id: approval.approval_id };
    }
    task.status = "cancelled";
    task.latest_summary = "Cancelled by operator action.";
    task.updated_at = new Date().toISOString();
    upsertTask(task);
    return { message: `Cancelled task ${task.task_id}.`, task };
  }

  private retryTask(action: OperatorActionRecord, approvedByUser: boolean) {
    const task = action.task_id ? getTask(action.task_id) : null;
    if (!task) throw new Error("No task is available to retry.");
    if (!approvedByUser) {
      const approval = createApprovalForAction(action, "Retrying may overwrite generated files or repeat failed commands.", "medium");
      return { message: `Retrying task ${task.task_id} requires approval.`, approval_id: approval.approval_id };
    }
    task.status = "queued";
    task.latest_summary = "Retry requested by operator.";
    task.next_steps = ["Worker assignment can resume for this retry.", "Run validation after the retry completes."];
    task.worker_id = null;
    task.in_flight_action = null;
    task.command_lease_id = null;
    task.command_lease_owner = null;
    task.command_lease_attempt_id = null;
    task.command_lease_acquired_at = null;
    task.command_lease_expires_at = null;
    task.updated_at = new Date().toISOString();
    upsertTask(task);
    if (task.task_graph_id && task.task_graph_node_id) {
      const graph = getTaskGraph(task.task_graph_id);
      const node = graph?.nodes.find((candidate) => candidate.node_id === task.task_graph_node_id);
      if (graph && node) {
        node.status = "queued";
        node.assigned_worker_id = null;
        node.completion_gate = null;
        node.summary = "Retry requested by operator.";
        node.updated_at = task.updated_at;
        graph.status = "queued";
        graph.updated_at = task.updated_at;
        upsertTaskGraph(graph);
      }
    }
    return { message: `Queued retry for task ${task.task_id}.`, task };
  }

  private async runCommand(action: OperatorActionRecord, approvedByUser: boolean) {
    const command = commandFromInput(action.input);
    if (!command) throw new Error("No command was provided.");
    const task = action.task_id ? getTask(action.task_id) : null;
    const worker = action.worker_id ? getWorker(action.worker_id) : null;
    if (!task) throw new Error("A task is required before running a worker command.");
    if (!worker) throw new Error("A worker is required before running a worker command.");
    const { cwd, workspace } = commandWorkspace(task, action.project_id, action.input.cwd);
    const policy = classifyCommand(command, cwd, workspace, approvedByUser);
    action.risk_level = policy.risk_level;
    if (policy.disposition === "blocked") {
      action.status = "blocked";
      throw new Error(`Blocked: ${policy.reason}`);
    }
    if (policy.disposition === "requires_approval" && !approvedByUser) {
      const approval = createApprovalForAction(action, policy.reason, policy.risk_level);
      return { message: `Running ${command} requires approval: ${policy.reason}`, approval_id: approval.approval_id };
    }
    const { bin, args } = splitCommand(command);
    if (action.action_type === "run_worker_command" && worker.type === "gcp_vm") {
      const now = new Date().toISOString();
      const request = upsertWorkerRuntimeCommandRequest({
        request_id: `runtime_cmd_${randomUUID()}`,
        session_id: action.session_id,
        task_id: task.task_id,
        project_id: task.project_id,
        worker_id: worker.worker_id,
        command,
        cwd,
        workspace_path: workspace,
        status: "queued",
        approved_by_user: approvedByUser,
        created_at: now,
        claimed_at: null,
        claimed_by_attempt_id: null,
        completed_at: null,
        command_event_id: null,
        error: null,
      });
      return {
        message: `Queued ${command} for GCP worker ${worker.worker_id}. The worker will execute it through its authenticated callback channel.`,
        runtime_command_request_id: request.request_id,
        status: request.status,
      };
    }
    const dockerContainerId = worker.type === "docker_local"
      ? worker.docker_container_id || (typeof worker.metadata?.runtime === "object" && worker.metadata.runtime ? String((worker.metadata.runtime as Record<string, unknown>).docker_container_id || "") : "")
      : "";
    const executor = worker.type === "docker_local" && dockerContainerId
      ? ({ command: execCommand, args: execArgs, cwd: execCwd, timeout_ms }: { command: string; args: string[]; cwd: string; timeout_ms?: number }) =>
          dockerExec({ containerId: dockerContainerId, command: execCommand, args: execArgs, cwd: execCwd, timeout_ms })
      : undefined;
    if (worker.type === "docker_local" && !executor) {
      throw new Error(`Docker Local worker ${worker.worker_id} has not reported a container id yet; cannot run inside worker runtime.`);
    }
    const event = await new CommandRunner().run({
      task_id: task.task_id,
      project_id: task.project_id,
      worker_id: worker.worker_id,
      command: bin,
      args,
      cwd,
      workspace_path: workspace,
      timeout_ms: Number(action.input.timeout_ms) || 120_000,
      approved_by_user: approvedByUser,
      executor,
      ...commandRuntime(worker),
    });
    action.command_id = event.event_id;
    return {
      message: `Command ${event.command} finished with exit ${event.exit_code}.`,
      command_event_id: event.event_id,
      exit_code: event.exit_code,
      stdout_preview: event.stdout_preview,
      stderr_preview: event.stderr_preview,
    };
  }

  private inspectTask(action: OperatorActionRecord) {
    const task = action.task_id ? getTask(action.task_id) : null;
    if (!task) throw new Error("No task is available to inspect.");
    const commands = listCommandEvents({ taskId: task.task_id });
    const worker = task.worker_id ? getWorker(task.worker_id) : null;
    const summary = getRunSummary(task.task_id);
    return {
      message: `Task ${task.task_id} is ${task.status}. ${commands.length} command events are recorded.`,
      task,
      commands,
      worker,
      summary,
      files_changed: summary?.files_changed ?? [],
    };
  }

  private inspectCommand(action: OperatorActionRecord) {
    const command = action.command_id ? getCommandEvent(action.command_id) : action.task_id ? latestCommandForTask(action.task_id) : null;
    if (!command) return { message: "No command event is recorded for the active task yet.", command: null };
    const task = getTask(command.task_id);
    return {
      message: commandMessage(command, task),
      command,
      stdout: command.stdout_preview,
      stderr: command.stderr_preview,
    };
  }

  private tailLogs(action: OperatorActionRecord) {
    const lines = Math.max(1, Math.min(200, Number(action.input.lines) || 20));
    if (action.action_type === "tail_api_logs") {
      const events = listOrchestratorEvents().slice(-lines);
      const logs = events.map((event) => redactSecrets(`${event.type}: ${event.message}`));
      return {
        message: logs.length
          ? `There are ${countLabel(logs.length, "recent orchestrator event")}. Latest: ${compact(logs.at(-1), 220)}`
          : "No orchestrator events are recorded yet.",
        logs,
        events,
      };
    }
    const task = action.task_id ? getTask(action.task_id) : null;
    const worker = action.worker_id ? getWorker(action.worker_id) : null;
    const commands = worker
      ? listCommandEvents({ workerId: worker.worker_id })
      : task
        ? listCommandEvents({ taskId: task.task_id })
        : [];
    const logs = commands.slice(-lines).map((event) => redactSecrets(`${event.command}: ${event.summary}\n${event.stdout_preview}\n${event.stderr_preview}`));
    const target = worker ? `worker ${worker.worker_id}` : task ? `task ${task.task_id}` : "the active context";
    return {
      message: logs.length
        ? `${target} has ${countLabel(logs.length, "recent command log entry", "recent command log entries")}. Latest: ${compact(logs.at(-1), 260)}`
        : `No command logs are recorded for ${target} yet.`,
      logs,
    };
  }

  private async openPreview(action: OperatorActionRecord) {
    const result = await startPreviewForSession(action.session_id);
    if (!result.ok) throw new Error(result.message);
    action.project_id = result.project.project_id;
    action.task_id = result.task.task_id;
    action.worker_id = result.task.worker_id;
    return {
      message: `Preview is ready at ${result.preview.preview_url}. Status: ${result.preview.status}; entry: ${result.preview.entry_file}.`,
      preview: result.preview,
      preview_url: result.preview.preview_url,
    };
  }

  private async cleanupIdleWorkers(action: OperatorActionRecord) {
    const idle = listWorkers().filter((worker) => worker.status === "idle" || worker.status === "stopped" || (Date.parse(worker.expires_at) <= Date.now() && !["expired", "failed"].includes(worker.status)));
    const stopped: string[] = [];
    for (const worker of idle) {
      if (worker.status !== "stopped") {
        const result = await workerManagerFor(worker.type).stopWorker(worker.worker_id);
        stopped.push(result.worker_id);
      }
    }
    return { message: stopped.length ? `Stopped idle workers: ${stopped.join(", ")}.` : "No idle workers needed cleanup.", workers_stopped: stopped, workers_deleted: [] };
  }

  private inspectCodexHistory(action: OperatorActionRecord) {
    const task = action.task_id ? getTask(action.task_id) : null;
    if (!task) throw new Error("No task is available for Codex history inspection.");
    const command = action.command_id ? getCommandEvent(action.command_id) : latestCodexCommand(task.task_id);
    if (!command) return { message: "No Codex command history is recorded for this task yet.", command: null };
    const resume = command.codex_session_id ? `codex exec resume ${command.codex_session_id} "summarize what you built"` : null;
    return {
      message: command.codex_session_id
        ? `Codex history is recorded for task ${task.task_id}. Session: ${command.codex_session_id}. Resume details are available in the side panel.`
        : `Codex rollout history is verified for task ${task.task_id} at ${command.codex_rollout_host_path ?? command.codex_rollout_path ?? "unknown path"}.`,
      command_event_id: command.event_id,
      codex_session_id: command.codex_session_id ?? null,
      codex_rollout_path: command.codex_rollout_path ?? null,
      codex_rollout_host_path: command.codex_rollout_host_path ?? null,
      codex_home: command.codex_home ?? null,
      codex_home_host_path: command.codex_home_host_path ?? null,
      codex_resume_command: resume,
      verification_command: command.codex_history_verification_command ?? null,
      confidence: command.codex_history_confidence ?? null,
    };
  }

  private projectForAction(action: OperatorActionRecord) {
    const task = action.task_id ? getTask(action.task_id) : null;
    const project = action.project_id ? getProject(action.project_id) : task?.project_id ? getProject(task.project_id) : null;
    if (!project) throw new Error("No project is available for documentation inspection.");
    return project;
  }

  private docPath(action: OperatorActionRecord, file: string) {
    const project = this.projectForAction(action);
    const docsDir = project.docs_path || path.join(project.workspace_path, ".head-developer");
    const target = path.join(docsDir, file);
    const relative = path.relative(project.workspace_path, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Documentation path escapes project root.");
    return { project, docsDir, target };
  }

  private inspectDocFile(action: OperatorActionRecord, file: string, label: string) {
    const { project, target } = this.docPath(action, file);
    const content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    return {
      message: content ? `${label} for ${project.display_name} is available in .head-developer/${file}.` : `${label} is missing for ${project.display_name}.`,
      project_id: project.project_id,
      file: `.head-developer/${file}`,
      path: target,
      content_preview: truncate(content, 4000),
    };
  }

  private inspectProjectDocs(action: OperatorActionRecord) {
    const project = this.projectForAction(action);
    const docsDir = project.docs_path || path.join(project.workspace_path, ".head-developer");
    const freshness = documentationIndexer.checkFreshness(project);
    const docs = DOCUMENTATION_INDEX_FILES.map((file) => ({
      file: `.head-developer/${file}`,
      exists: fs.existsSync(path.join(docsDir, file)),
      path: path.join(docsDir, file),
    }));
    const existingDocs = docs.filter((doc) => doc.exists);
    const missingDocs = docs.filter((doc) => !doc.exists);
    const missingDetails = [
      ...freshness.missing_docs,
      ...freshness.missing_changed_files,
      ...freshness.missing_functions,
      ...freshness.missing_variables,
      ...freshness.missing_routes,
      ...freshness.missing_state_fields,
      ...freshness.missing_validation,
    ].slice(0, 5);
    return {
      message: freshness.docs_fresh
        ? `Project docs are up to date for ${project.display_name}. ${existingDocs.length}/${docs.length} documentation files are present in .head-developer.`
        : `Project docs are stale for ${project.display_name}. ${existingDocs.length}/${docs.length} documentation files are present${missingDocs.length ? `; missing ${missingDocs.map((doc) => doc.file).join(", ")}` : ""}${missingDetails.length ? `; stale signals: ${missingDetails.join(", ")}` : ""}. Next: ${freshness.recommended_follow_up_task}`,
      project_id: project.project_id,
      docs_path: docsDir,
      docs_fresh: freshness.docs_fresh,
      freshness,
      docs,
    };
  }

  private updateProjectDocs(action: OperatorActionRecord) {
    const project = this.projectForAction(action);
    const result = documentationIndexer.updateProjectDocs(project);
    return {
      message: result.freshness.docs_fresh
        ? `Updated documentation index for ${project.display_name}.`
        : `Updated documentation index for ${project.display_name}, but docs are still stale: ${result.freshness.recommended_follow_up_task}`,
      project_id: project.project_id,
      docs_path: result.docs_path,
      files_written: result.files_written,
      docs_fresh: result.freshness.docs_fresh,
      freshness: result.freshness,
    };
  }

  private summarizeCurrentState(action: OperatorActionRecord) {
    const task = action.task_id ? getTask(action.task_id) : null;
    const worker = action.worker_id ? getWorker(action.worker_id) : null;
    const command = task ? latestCommandForTask(task.task_id) : null;
    const summary = task ? getRunSummary(task.task_id) : null;
    return {
      message: task
        ? [
            `Task ${task.task_id} is ${task.status}: ${compact(task.user_goal, 140)}.`,
            `Worker: ${worker ? `${worker.worker_id} (${workerModeLabel(worker.actual_worker_mode ?? worker.type)}, ${worker.status})` : "not assigned"}.`,
            command ? commandMessage(command, task) : "No command event is recorded yet.",
            summary?.executive_summary ? `Latest summary: ${summary.executive_summary}` : task.latest_summary ? `Latest summary: ${task.latest_summary}` : "",
          ].filter(Boolean).join(" ")
        : "No active task is attached to this session.",
      task,
      worker,
      active_command: command?.exit_code === null ? command : null,
      latest_command: command,
      summary,
    };
  }

  async executeExisting(action: OperatorActionRecord, approvedByUser: boolean) {
    action.status = "running";
    action.requires_approval = false;
    action.error = null;
    upsertOperatorAction(action);
    recordActionEvent(action, "operator.action.approved", `${action.action_type} approved.`);
    try {
      const result = await this.perform(action, approvedByUser);
      action.status = "completed";
      action.completed_at = new Date().toISOString();
      action.result = result;
      upsertOperatorAction(action);
      recordActionEvent(action, "operator.action.completed", resultText(result) || `${action.action_type} completed.`);
      return { action, response: this.responseFor(action) };
    } catch (error) {
      action.status = "failed";
      action.completed_at = new Date().toISOString();
      action.error = error instanceof Error ? error.message : String(error);
      upsertOperatorAction(action);
      recordActionEvent(action, "operator.action.failed", `${action.action_type} failed: ${action.error}`);
      return { action, response: action.error };
    }
  }
}

export const actionRouter = new ActionRouter();

export async function approveOperatorAction(actionId: string) {
  const action = getOperatorAction(actionId);
  if (!action) throw new Error(`Operator action not found: ${actionId}`);
  const approval = action.approval_id ? getApprovalRequest(action.approval_id) : null;
  if (approval) {
    approval.status = "approved";
    approval.resolved_at = new Date().toISOString();
    upsertApprovalRequest(approval);
  }
  const result = await actionRouter.executeExisting(action, true);
  const session = getSession(action.session_id);
  if (session) {
    session.pending_action = null;
    session.pending_action_payload = null;
    session.latest_codex_message = result.response;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
  }
  appendOrchestratorEvent({
    scope: "approval",
    scope_id: action.approval_id ?? action.action_id,
    type: "approval.resolved",
    message: `Approved operator action ${action.action_type}.`,
    data: { action_id: action.action_id },
  });
  return result;
}

export function rejectOperatorAction(actionId: string) {
  const action = getOperatorAction(actionId);
  if (!action) throw new Error(`Operator action not found: ${actionId}`);
  const approval = action.approval_id ? getApprovalRequest(action.approval_id) : null;
  if (approval) {
    approval.status = "rejected";
    approval.resolved_at = new Date().toISOString();
    upsertApprovalRequest(approval);
  }
  action.status = "rejected";
  action.completed_at = new Date().toISOString();
  action.error = "Rejected by user.";
  upsertOperatorAction(action);
  const session = getSession(action.session_id);
  if (session) {
    session.pending_action = null;
    session.pending_action_payload = null;
    session.latest_codex_message = `Rejected ${action.action_type}. I did not run it.`;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
  }
  recordActionEvent(action, "operator.action.rejected", `Rejected ${action.action_type}.`);
  appendOrchestratorEvent({
    scope: "approval",
    scope_id: action.approval_id ?? action.action_id,
    type: "approval.resolved",
    message: `Rejected operator action ${action.action_type}.`,
    data: { action_id: action.action_id },
  });
  return { action, response: `Rejected ${action.action_type}. I did not run it.` };
}

export function listOperatorActionRecords() {
  return listOperatorActions();
}

export { actionNodeKind };
