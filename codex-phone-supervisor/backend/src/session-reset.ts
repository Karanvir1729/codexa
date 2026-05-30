import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { createSession } from "./session.js";
import { appendAuditEvent, appendOrchestratorEvent, readStore, writeStore } from "./store.js";
import type { Channel, OrchestratorEvent, PersistedState, ProjectRecord, SessionState } from "./types.js";

export interface ResetSupervisorSessionInput {
  sessionId?: string;
  deleteProject?: boolean;
  label?: string;
  workspacePath?: string;
  channel?: Channel;
}

export interface ResetSupervisorSessionResult {
  old_session_id: string | null;
  session_id: string;
  session: SessionState;
  deleted_project: {
    requested: boolean;
    project_id: string | null;
    workspace_path: string | null;
    deleted: boolean;
    state_removed: boolean;
    skipped_reason: string | null;
  };
  removed: {
    sessions: number;
    projects: number;
    tasks: number;
    workers: number;
    command_events: number;
    run_summaries: number;
    approval_requests: number;
    mcp_tool_calls: number;
    operator_actions: number;
    task_graphs: number;
    worker_context_packets: number;
    worker_runtime_command_requests: number;
    project_artifacts: number;
    orchestrator_events: number;
  };
}

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function latestSessionFromState(state: PersistedState) {
  return Object.values(state.sessions).sort((a, b) => b.last_updated.localeCompare(a.last_updated))[0] ?? null;
}

function deletionTargetForGeneratedProject(project: ProjectRecord) {
  const root = fs.realpathSync(config.newProjectsRoot);
  const rawTarget = path.resolve(project.workspace_path);
  const exists = fs.existsSync(rawTarget);
  const target = exists ? fs.realpathSync(rawTarget) : rawTarget;
  if (target === root) {
    return { ok: false as const, target, exists, reason: "generated_projects_root_is_not_deletable" };
  }
  if (!isWithinDirectory(target, root)) {
    return { ok: false as const, target, exists, reason: "project_is_not_under_generated_projects_root" };
  }
  return { ok: true as const, target, exists, reason: exists ? null : "project_directory_was_already_missing" };
}

function deleteGeneratedProjectDirectory(project: ProjectRecord | null, requested: boolean) {
  if (!requested) {
    return {
      requested,
      project_id: project?.project_id ?? null,
      workspace_path: project?.workspace_path ?? null,
      deleted: false,
      state_removed: false,
      skipped_reason: "not_requested",
    };
  }
  if (!project) {
    return {
      requested,
      project_id: null,
      workspace_path: null,
      deleted: false,
      state_removed: false,
      skipped_reason: "no_project_attached",
    };
  }
  const target = deletionTargetForGeneratedProject(project);
  if (!target.ok) {
    return {
      requested,
      project_id: project.project_id,
      workspace_path: project.workspace_path,
      deleted: false,
      state_removed: false,
      skipped_reason: target.reason,
    };
  }
  if (target.exists) fs.rmSync(target.target, { recursive: true, force: true });
  return {
    requested,
    project_id: project.project_id,
    workspace_path: project.workspace_path,
    deleted: target.exists,
    state_removed: true,
    skipped_reason: target.reason,
  };
}

function removeMatchingRecords<T>(records: Record<string, T>, predicate: (record: T) => boolean) {
  let count = 0;
  for (const [id, record] of Object.entries(records)) {
    if (!predicate(record)) continue;
    delete records[id];
    count += 1;
  }
  return count;
}

function eventTouchesRemovedIds(event: OrchestratorEvent, removedIds: Set<string>) {
  if (removedIds.has(event.scope_id)) return true;
  if (!event.data) return false;
  let dataText = "";
  try {
    dataText = JSON.stringify(event.data);
  } catch {
    return false;
  }
  for (const id of removedIds) {
    if (id && dataText.includes(id)) return true;
  }
  return false;
}

function pruneOldSessionState(state: PersistedState, oldSession: SessionState | null, project: ProjectRecord | null, removeProjectState: boolean) {
  const removedIds = new Set<string>();
  const sessionIds = new Set<string>();
  const projectIds = new Set<string>();
  const taskIds = new Set<string>();
  const workerIds = new Set<string>();
  const taskGraphIds = new Set<string>();
  const commandEventIds = new Set<string>();
  const approvalIds = new Set<string>();
  const mcpCallIds = new Set<string>();

  if (oldSession) {
    sessionIds.add(oldSession.session_id);
    removedIds.add(oldSession.session_id);
    if (oldSession.active_task_id) taskIds.add(oldSession.active_task_id);
  }
  if (project && removeProjectState) {
    projectIds.add(project.project_id);
    removedIds.add(project.project_id);
  }

  for (const task of Object.values(state.tasks)) {
    if (projectIds.has(task.project_id)) taskIds.add(task.task_id);
  }
  for (const graph of Object.values(state.task_graphs)) {
    if (projectIds.has(graph.project_id) || graph.nodes.some((node) => taskIds.has(node.task_id))) {
      taskGraphIds.add(graph.task_graph_id);
      removedIds.add(graph.task_graph_id);
      graph.nodes.forEach((node) => taskIds.add(node.task_id));
    }
  }
  for (const taskId of taskIds) removedIds.add(taskId);
  for (const worker of Object.values(state.workers)) {
    if ((worker.project_id && projectIds.has(worker.project_id)) || (worker.task_id && taskIds.has(worker.task_id))) {
      workerIds.add(worker.worker_id);
      removedIds.add(worker.worker_id);
    }
  }
  for (const event of Object.values(state.command_events)) {
    if (projectIds.has(event.project_id) || taskIds.has(event.task_id) || workerIds.has(event.worker_id)) {
      commandEventIds.add(event.event_id);
      removedIds.add(event.event_id);
    }
  }
  for (const approval of Object.values(state.approval_requests)) {
    if (projectIds.has(approval.project_id) || taskIds.has(approval.task_id)) {
      approvalIds.add(approval.approval_id);
      removedIds.add(approval.approval_id);
    }
  }
  for (const call of Object.values(state.mcp_tool_calls)) {
    if (
      (call.session_id && sessionIds.has(call.session_id)) ||
      (call.project_id && projectIds.has(call.project_id)) ||
      (call.task_id && taskIds.has(call.task_id)) ||
      (call.worker_id && workerIds.has(call.worker_id))
    ) {
      mcpCallIds.add(call.mcp_call_id);
      removedIds.add(call.mcp_call_id);
    }
  }

  const beforeEvents = state.orchestrator_events.length;
  const removed = {
    sessions: removeMatchingRecords(state.sessions, (session) => sessionIds.has(session.session_id as string)),
    projects: removeProjectState ? removeMatchingRecords(state.projects, (item) => projectIds.has(item.project_id as string)) : 0,
    tasks: removeMatchingRecords(state.tasks, (task) => taskIds.has(task.task_id as string)),
    workers: removeMatchingRecords(state.workers, (worker) => workerIds.has(worker.worker_id as string)),
    command_events: removeMatchingRecords(state.command_events, (event) => commandEventIds.has(event.event_id as string)),
    run_summaries: removeMatchingRecords(state.run_summaries, (summary) => taskIds.has(summary.task_id as string)),
    approval_requests: removeMatchingRecords(state.approval_requests, (approval) => approvalIds.has(approval.approval_id as string)),
    mcp_tool_calls: removeMatchingRecords(state.mcp_tool_calls, (call) => mcpCallIds.has(call.mcp_call_id as string)),
    operator_actions: removeMatchingRecords(state.operator_actions, (action) =>
      sessionIds.has(action.session_id as string) ||
      projectIds.has(action.project_id as string) ||
      taskIds.has(action.task_id as string) ||
      workerIds.has(action.worker_id as string) ||
      commandEventIds.has(action.command_id as string) ||
      approvalIds.has(action.approval_id as string)
    ),
    task_graphs: removeMatchingRecords(state.task_graphs, (graph) => taskGraphIds.has(graph.task_graph_id as string)),
    worker_context_packets: removeMatchingRecords(state.worker_context_packets, (packet) =>
      taskGraphIds.has(packet.task_graph_id as string) ||
      taskIds.has(packet.task_id as string) ||
      projectIds.has(packet.project_id as string) ||
      workerIds.has(packet.worker_id as string)
    ),
    worker_runtime_command_requests: removeMatchingRecords(state.worker_runtime_command_requests, (request) =>
      sessionIds.has(request.session_id as string) ||
      projectIds.has(request.project_id as string) ||
      taskIds.has(request.task_id as string) ||
      workerIds.has(request.worker_id as string) ||
      commandEventIds.has(request.command_event_id as string)
    ),
    project_artifacts: removeMatchingRecords(state.project_artifacts, (artifact) =>
      projectIds.has(artifact.project_id as string) ||
      taskIds.has(artifact.task_id as string) ||
      workerIds.has(artifact.worker_id as string)
    ),
    orchestrator_events: 0,
  };

  state.orchestrator_events = state.orchestrator_events.filter((event) => !eventTouchesRemovedIds(event, removedIds));
  removed.orchestrator_events = beforeEvents - state.orchestrator_events.length;

  if (project && !removeProjectState && oldSession && state.projects[project.project_id]?.last_active_session_id === oldSession.session_id) {
    state.projects[project.project_id] = {
      ...state.projects[project.project_id],
      last_active_session_id: null,
      updated_at: new Date().toISOString(),
    };
  }

  return removed;
}

export function resetSupervisorSession(input: ResetSupervisorSessionInput = {}): ResetSupervisorSessionResult {
  const state = readStore();
  const oldSession = input.sessionId ? state.sessions[input.sessionId] ?? null : latestSessionFromState(state);
  const projectId = oldSession?.project_id ?? oldSession?.current_project_id ?? null;
  const project = projectId ? state.projects[projectId] ?? null : null;
  const deletedProject = deleteGeneratedProjectDirectory(project, input.deleteProject !== false);
  const removed = pruneOldSessionState(state, oldSession, project, deletedProject.state_removed);

  const session = createSession(input.label?.trim() || "New local Codex session", input.workspacePath?.trim() || config.defaultWorkspacePath);
  session.channel = input.channel ?? oldSession?.channel ?? "web_text";
  session.current_status = "idle";
  session.status = "idle";
  session.active_task = "New local Codex session";
  session.summary_text = "New local Codex session ready.";
  session.latest_summary = session.summary_text;
  session.latest_codex_message = "Describe what Codex should build next.";
  state.sessions[session.session_id] = session;
  writeStore(state);

  appendAuditEvent({
    session_id: session.session_id,
    ts: new Date().toISOString(),
    source: "system",
    type: "supervisor.session.reset",
    message: "Started a new local Codex session.",
    data: {
      old_session_id: oldSession?.session_id ?? null,
      deleted_project: deletedProject,
      removed,
    },
  });
  appendOrchestratorEvent({
    scope: "session",
    scope_id: session.session_id,
    type: "session.reset",
    message: "Started a new local Codex session.",
    data: {
      session_id: session.session_id,
      old_session_id: oldSession?.session_id ?? null,
      deleted_project: deletedProject,
      removed,
      architecture: "one_local_codex_cli_session",
    },
  });

  return {
    old_session_id: oldSession?.session_id ?? null,
    session_id: session.session_id,
    session,
    deleted_project: deletedProject,
    removed,
  };
}
