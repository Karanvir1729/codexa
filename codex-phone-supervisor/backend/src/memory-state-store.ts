import { normalizePersistedState, type InitialStateOptions } from "./state-store-common.js";
import { redactCommandEvent, redactSensitiveJson } from "./redaction.js";
import { claimWorkerTaskInState, duplicateActiveCodexCommandMessage, findDuplicateActiveCodexCommand } from "./worker-task-guard.js";
import type { CommandEventFilters, McpEventFilters, OperatorActionFilters, ProjectFilters, SessionFilters, StateStore, TaskFilters, TaskGraphFilters, WorkerFilters } from "./state-store-types.js";
import type {
  ApprovalRequestRecord,
  CommandEventRecord,
  McpToolCallRecord,
  OperatorActionRecord,
  OrchestratorEvent,
  OrchestratorSettings,
  PersistedState,
  ProjectArtifactFileRecord,
  ProjectRecord,
  RunSummaryRecord,
  SessionState,
  TaskGraphRecord,
  TaskRecord,
  WorkerContextPacket,
  WorkerRecord,
  WorkerRuntimeCommandRequest,
} from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryStateStore implements StateStore {
  readonly kind: StateStore["kind"];
  protected state: PersistedState;

  constructor(protected readonly initialOptions: InitialStateOptions, seed: Partial<PersistedState> = {}, kind: StateStore["kind"] = "memory") {
    this.kind = kind;
    this.state = normalizePersistedState(seed, initialOptions);
  }

  readState() {
    return clone(this.state);
  }

  replaceState(state: PersistedState) {
    this.state = normalizePersistedState(clone(state), this.initialOptions);
  }

  createSession(session: SessionState) {
    this.state.sessions[session.session_id] = clone(session);
    return session;
  }

  updateSession(session: SessionState) {
    return this.createSession(session);
  }

  getSession(sessionId: string) {
    return this.state.sessions[sessionId] ? clone(this.state.sessions[sessionId]) : null;
  }

  listSessions(filters: SessionFilters = {}) {
    return Object.values(this.state.sessions)
      .filter((session) => !filters.taskId || session.active_task_id === filters.taskId)
      .filter((session) => !filters.workerId || session.active_worker_id === filters.workerId)
      .filter((session) => !filters.projectId || session.project_id === filters.projectId || session.current_project_id === filters.projectId)
      .map(clone)
      .sort((a, b) => b.last_updated.localeCompare(a.last_updated))
      .slice(0, filters.limit);
  }

  createProject(project: ProjectRecord) {
    this.state.projects[project.project_id] = clone(project);
    return project;
  }

  updateProject(project: ProjectRecord) {
    return this.createProject(project);
  }

  getProject(projectId: string) {
    return this.state.projects[projectId] ? clone(this.state.projects[projectId]) : null;
  }

  listProjects(filters: ProjectFilters = {}) {
    return Object.values(this.state.projects)
      .filter((project) => !filters.workspacePath || project.workspace_path === filters.workspacePath)
      .map(clone)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, filters.limit);
  }

  createTask(task: TaskRecord) {
    this.state.tasks[task.task_id] = clone(task);
    return task;
  }

  updateTask(task: TaskRecord) {
    return this.createTask(task);
  }

  getTask(taskId: string) {
    return this.state.tasks[taskId] ? clone(this.state.tasks[taskId]) : null;
  }

  listTasks(projectIdOrFilters?: string | TaskFilters) {
    const filters: TaskFilters = typeof projectIdOrFilters === "string" ? { projectId: projectIdOrFilters } : projectIdOrFilters ?? {};
    return Object.values(this.state.tasks)
      .filter((task) => !filters.projectId || task.project_id === filters.projectId)
      .filter((task) => !filters.status || task.status === filters.status)
      .map(clone)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, filters.limit);
  }

  createWorker(worker: WorkerRecord) {
    this.state.workers[worker.worker_id] = clone(worker);
    return worker;
  }

  updateWorker(worker: WorkerRecord) {
    return this.createWorker(worker);
  }

  getWorker(workerId: string) {
    return this.state.workers[workerId] ? clone(this.state.workers[workerId]) : null;
  }

  listWorkers(filters: WorkerFilters = {}) {
    const statuses = Array.isArray(filters.status) ? filters.status : filters.status ? [filters.status] : [];
    return Object.values(this.state.workers)
      .filter((worker) => !filters.type || worker.type === filters.type)
      .filter((worker) => !statuses.length || statuses.includes(worker.status))
      .filter((worker) => !filters.active || !["stopped", "expired", "failed"].includes(worker.status))
      .map(clone)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, filters.limit);
  }

  claimWorkerTask(input: Parameters<StateStore["claimWorkerTask"]>[0]) {
    return clone(claimWorkerTaskInState(this.state, input));
  }

  createCommandEvent(event: CommandEventRecord) {
    const redacted = redactCommandEvent(event);
    const duplicate = findDuplicateActiveCodexCommand(redacted, Object.values(this.state.command_events));
    if (duplicate) throw new Error(duplicateActiveCodexCommandMessage(redacted, duplicate));
    this.state.command_events[redacted.event_id] = clone(redacted);
    return redacted;
  }

  getCommandEvent(eventId: string) {
    return this.state.command_events[eventId] ? clone(this.state.command_events[eventId]) : null;
  }

  listCommandEvents(filters: CommandEventFilters = {}) {
    return Object.values(this.state.command_events)
      .filter((event) => !filters.taskId || event.task_id === filters.taskId)
      .filter((event) => !filters.projectId || event.project_id === filters.projectId)
      .filter((event) => !filters.workerId || event.worker_id === filters.workerId)
      .map(clone)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .slice(0, filters.limit);
  }

  createSummary(summary: RunSummaryRecord) {
    this.state.run_summaries[summary.task_id] = clone(summary);
    return summary;
  }

  getSummary(taskId: string) {
    return this.state.run_summaries[taskId] ? clone(this.state.run_summaries[taskId]) : null;
  }

  listSummaries() {
    return Object.values(this.state.run_summaries).map(clone).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  createApprovalRequest(approval: ApprovalRequestRecord) {
    this.state.approval_requests[approval.approval_id] = clone(approval);
    return approval;
  }

  getApprovalRequest(approvalId: string) {
    return this.state.approval_requests[approvalId] ? clone(this.state.approval_requests[approvalId]) : null;
  }

  listApprovalRequests(status?: ApprovalRequestRecord["status"]) {
    return Object.values(this.state.approval_requests)
      .filter((approval) => !status || approval.status === status)
      .map(clone)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  createMcpEvent(event: McpToolCallRecord) {
    this.state.mcp_tool_calls[event.mcp_call_id] = clone(event);
    return event;
  }

  listMcpEvents(filters: McpEventFilters = {}) {
    return Object.values(this.state.mcp_tool_calls)
      .filter((call) => !filters.taskId || call.task_id === filters.taskId)
      .filter((call) => !filters.projectId || call.project_id === filters.projectId)
      .filter((call) => !filters.workerId || call.worker_id === filters.workerId)
      .filter((call) => !filters.sessionId || call.session_id === filters.sessionId)
      .map(clone)
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  createOperatorAction(action: OperatorActionRecord) {
    this.state.operator_actions[action.action_id] = clone(action);
    return action;
  }

  updateOperatorAction(action: OperatorActionRecord) {
    return this.createOperatorAction(action);
  }

  getOperatorAction(actionId: string) {
    return this.state.operator_actions[actionId] ? clone(this.state.operator_actions[actionId]) : null;
  }

  listOperatorActions(filters: OperatorActionFilters = {}) {
    return Object.values(this.state.operator_actions)
      .filter((action) => !filters.sessionId || action.session_id === filters.sessionId)
      .filter((action) => !filters.taskId || action.task_id === filters.taskId)
      .filter((action) => !filters.projectId || action.project_id === filters.projectId)
      .filter((action) => !filters.workerId || action.worker_id === filters.workerId)
      .filter((action) => !filters.status || action.status === filters.status)
      .map(clone)
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  createTaskGraph(graph: TaskGraphRecord) {
    this.state.task_graphs[graph.task_graph_id] = clone(graph);
    return graph;
  }

  updateTaskGraph(graph: TaskGraphRecord) {
    return this.createTaskGraph(graph);
  }

  getTaskGraph(taskGraphId: string) {
    return this.state.task_graphs[taskGraphId] ? clone(this.state.task_graphs[taskGraphId]) : null;
  }

  listTaskGraphs(projectIdOrFilters?: string | TaskGraphFilters) {
    const filters: TaskGraphFilters = typeof projectIdOrFilters === "string" ? { projectId: projectIdOrFilters } : projectIdOrFilters ?? {};
    return Object.values(this.state.task_graphs)
      .filter((graph) => !filters.projectId || graph.project_id === filters.projectId)
      .map(clone)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, filters.limit);
  }

  createWorkerContextPacket(packet: WorkerContextPacket) {
    this.state.worker_context_packets[packet.context_packet_id] = clone(packet);
    return packet;
  }

  updateWorkerContextPacket(packet: WorkerContextPacket) {
    return this.createWorkerContextPacket(packet);
  }

  getWorkerContextPacket(packetId: string) {
    return this.state.worker_context_packets[packetId] ? clone(this.state.worker_context_packets[packetId]) : null;
  }

  listWorkerContextPackets(filters: { taskGraphId?: string; taskId?: string; workerId?: string } = {}) {
    return Object.values(this.state.worker_context_packets)
      .filter((packet) => !filters.taskGraphId || packet.task_graph_id === filters.taskGraphId)
      .filter((packet) => !filters.taskId || packet.task_id === filters.taskId)
      .filter((packet) => !filters.workerId || packet.worker_id === filters.workerId)
      .map(clone)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  createWorkerRuntimeCommandRequest(request: WorkerRuntimeCommandRequest) {
    this.state.worker_runtime_command_requests[request.request_id] = clone(request);
    return request;
  }

  updateWorkerRuntimeCommandRequest(request: WorkerRuntimeCommandRequest) {
    return this.createWorkerRuntimeCommandRequest(request);
  }

  getWorkerRuntimeCommandRequest(requestId: string) {
    return this.state.worker_runtime_command_requests[requestId] ? clone(this.state.worker_runtime_command_requests[requestId]) : null;
  }

  listWorkerRuntimeCommandRequests(filters: { workerId?: string; taskId?: string; status?: WorkerRuntimeCommandRequest["status"] } = {}) {
    return Object.values(this.state.worker_runtime_command_requests)
      .filter((request) => !filters.workerId || request.worker_id === filters.workerId)
      .filter((request) => !filters.taskId || request.task_id === filters.taskId)
      .filter((request) => !filters.status || request.status === filters.status)
      .map(clone)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  upsertProjectArtifactFile(record: ProjectArtifactFileRecord) {
    this.state.project_artifacts[record.artifact_id] = clone(record);
    return record;
  }

  listProjectArtifactFiles(projectId: string) {
    return Object.values(this.state.project_artifacts)
      .filter((record) => record.project_id === projectId)
      .map(clone)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  appendEvent(event: OrchestratorEvent) {
    const redacted = redactSensitiveJson(event);
    this.state.orchestrator_events.push(clone(redacted));
    return redacted;
  }

  listEvents(scopeId?: string) {
    return this.state.orchestrator_events
      .filter((event) => !scopeId || event.scope_id === scopeId)
      .map(clone)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  getSettings() {
    return clone(this.state.orchestrator_settings!);
  }

  updateSettings(settings: OrchestratorSettings) {
    this.state.orchestrator_settings = clone(settings);
    return settings;
  }
}
