import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MemoryStateStore } from "./memory-state-store.js";
import { redactCommandEvent, redactSensitiveJson } from "./redaction.js";
import { emptyPersistedState, normalizePersistedState, type InitialStateOptions } from "./state-store-common.js";
import { claimWorkerTaskInState, duplicateActiveCodexCommandMessage, findDuplicateActiveCodexCommand } from "./worker-task-guard.js";
import type { PersistedState } from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface FileStateStoreOptions {
  storePath: string;
  lockTimeoutMs: number;
  lockRetryMs: number;
  initialState: InitialStateOptions;
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function staleLockAgeMs(lockPath: string) {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

function ensureFile(filePath: string, initialContent: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, initialContent);
}

export class FileStateStore extends MemoryStateStore {
  constructor(private readonly options: FileStateStoreOptions) {
    super(options.initialState, {}, "file");
  }

  private withLock<T>(action: () => T) {
    const lockPath = `${this.options.storePath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        fs.mkdirSync(lockPath, { recursive: false });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        if (staleLockAgeMs(lockPath) > this.options.lockTimeoutMs) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() - started > this.options.lockTimeoutMs) {
          throw new Error(`Timed out acquiring store lock ${lockPath}`);
        }
        sleepSync(this.options.lockRetryMs);
      }
    }

    try {
      return action();
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  private readUnlocked() {
    ensureFile(this.options.storePath, JSON.stringify(emptyPersistedState(this.options.initialState), null, 2));
    const parsed = JSON.parse(fs.readFileSync(this.options.storePath, "utf8")) as Partial<PersistedState>;
    return normalizePersistedState(parsed, this.options.initialState);
  }

  private writeUnlocked(state: PersistedState) {
    ensureFile(this.options.storePath, JSON.stringify(emptyPersistedState(this.options.initialState), null, 2));
    const tempPath = `${this.options.storePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(normalizePersistedState(state, this.options.initialState), null, 2));
    fs.renameSync(tempPath, this.options.storePath);
  }

  readState() {
    return this.withLock(() => this.readUnlocked());
  }

  replaceState(state: PersistedState) {
    this.withLock(() => this.writeUnlocked(state));
  }

  getSession(sessionId: string) {
    const session = this.readState().sessions[sessionId] ?? null;
    return session ? clone(session) : null;
  }

  listSessions(filters: Parameters<MemoryStateStore["listSessions"]>[0] = {}) {
    return Object.values(this.readState().sessions)
      .filter((session) => !filters.taskId || session.active_task_id === filters.taskId)
      .filter((session) => !filters.workerId || session.active_worker_id === filters.workerId)
      .filter((session) => !filters.projectId || session.project_id === filters.projectId || session.current_project_id === filters.projectId)
      .map(clone)
      .sort((a, b) => b.last_updated.localeCompare(a.last_updated))
      .slice(0, filters.limit);
  }

  getProject(projectId: string) {
    const project = this.readState().projects[projectId] ?? null;
    return project ? clone(project) : null;
  }

  listProjects(filters: Parameters<MemoryStateStore["listProjects"]>[0] = {}) {
    return Object.values(this.readState().projects)
      .filter((project) => !filters.workspacePath || project.workspace_path === filters.workspacePath)
      .map(clone)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, filters.limit);
  }

  getTask(taskId: string) {
    const task = this.readState().tasks[taskId] ?? null;
    return task ? clone(task) : null;
  }

  listTasks(projectIdOrFilters?: Parameters<MemoryStateStore["listTasks"]>[0]) {
    const filters = typeof projectIdOrFilters === "string" ? { projectId: projectIdOrFilters } : projectIdOrFilters ?? {};
    return Object.values(this.readState().tasks)
      .filter((task) => !filters.projectId || task.project_id === filters.projectId)
      .filter((task) => !filters.status || task.status === filters.status)
      .map(clone)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, filters.limit);
  }

  getWorker(workerId: string) {
    const worker = this.readState().workers[workerId] ?? null;
    return worker ? clone(worker) : null;
  }

  listWorkers(filters: Parameters<MemoryStateStore["listWorkers"]>[0] = {}) {
    const statuses = Array.isArray(filters.status) ? filters.status : filters.status ? [filters.status] : [];
    return Object.values(this.readState().workers)
      .filter((worker) => !filters.type || worker.type === filters.type)
      .filter((worker) => !statuses.length || statuses.includes(worker.status))
      .filter((worker) => !filters.active || !["stopped", "expired", "failed"].includes(worker.status))
      .map(clone)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, filters.limit);
  }

  getCommandEvent(eventId: string) {
    const event = this.readState().command_events[eventId] ?? null;
    return event ? clone(event) : null;
  }

  listCommandEvents(filters: Parameters<MemoryStateStore["listCommandEvents"]>[0] = {}) {
    return Object.values(this.readState().command_events)
      .filter((event) => !filters.taskId || event.task_id === filters.taskId)
      .filter((event) => !filters.projectId || event.project_id === filters.projectId)
      .filter((event) => !filters.workerId || event.worker_id === filters.workerId)
      .map(clone)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .slice(0, filters.limit);
  }

  getSummary(taskId: string) {
    const summary = this.readState().run_summaries[taskId] ?? null;
    return summary ? clone(summary) : null;
  }

  listSummaries() {
    return Object.values(this.readState().run_summaries).map(clone).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getApprovalRequest(approvalId: string) {
    const approval = this.readState().approval_requests[approvalId] ?? null;
    return approval ? clone(approval) : null;
  }

  listApprovalRequests(status?: Parameters<MemoryStateStore["listApprovalRequests"]>[0]) {
    return Object.values(this.readState().approval_requests)
      .filter((approval) => !status || approval.status === status)
      .map(clone)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  listMcpEvents(filters: Parameters<MemoryStateStore["listMcpEvents"]>[0] = {}) {
    return Object.values(this.readState().mcp_tool_calls)
      .filter((call) => !filters.taskId || call.task_id === filters.taskId)
      .filter((call) => !filters.projectId || call.project_id === filters.projectId)
      .filter((call) => !filters.workerId || call.worker_id === filters.workerId)
      .filter((call) => !filters.sessionId || call.session_id === filters.sessionId)
      .map(clone)
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  getOperatorAction(actionId: string) {
    const action = this.readState().operator_actions[actionId] ?? null;
    return action ? clone(action) : null;
  }

  listOperatorActions(filters: Parameters<MemoryStateStore["listOperatorActions"]>[0] = {}) {
    return Object.values(this.readState().operator_actions)
      .filter((action) => !filters.sessionId || action.session_id === filters.sessionId)
      .filter((action) => !filters.taskId || action.task_id === filters.taskId)
      .filter((action) => !filters.projectId || action.project_id === filters.projectId)
      .filter((action) => !filters.workerId || action.worker_id === filters.workerId)
      .filter((action) => !filters.status || action.status === filters.status)
      .map(clone)
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  getTaskGraph(taskGraphId: string) {
    const graph = this.readState().task_graphs[taskGraphId] ?? null;
    return graph ? clone(graph) : null;
  }

  listTaskGraphs(projectIdOrFilters?: Parameters<MemoryStateStore["listTaskGraphs"]>[0]) {
    const filters = typeof projectIdOrFilters === "string" ? { projectId: projectIdOrFilters } : projectIdOrFilters ?? {};
    return Object.values(this.readState().task_graphs)
      .filter((graph) => !filters.projectId || graph.project_id === filters.projectId)
      .map(clone)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, filters.limit);
  }

  getWorkerContextPacket(packetId: string) {
    const packet = this.readState().worker_context_packets[packetId] ?? null;
    return packet ? clone(packet) : null;
  }

  listWorkerContextPackets(filters: Parameters<MemoryStateStore["listWorkerContextPackets"]>[0] = {}) {
    return Object.values(this.readState().worker_context_packets)
      .filter((packet) => !filters.taskGraphId || packet.task_graph_id === filters.taskGraphId)
      .filter((packet) => !filters.taskId || packet.task_id === filters.taskId)
      .filter((packet) => !filters.workerId || packet.worker_id === filters.workerId)
      .map(clone)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  getWorkerRuntimeCommandRequest(requestId: string) {
    const request = this.readState().worker_runtime_command_requests[requestId] ?? null;
    return request ? clone(request) : null;
  }

  listWorkerRuntimeCommandRequests(filters: Parameters<MemoryStateStore["listWorkerRuntimeCommandRequests"]>[0] = {}) {
    return Object.values(this.readState().worker_runtime_command_requests)
      .filter((request) => !filters.workerId || request.worker_id === filters.workerId)
      .filter((request) => !filters.taskId || request.task_id === filters.taskId)
      .filter((request) => !filters.status || request.status === filters.status)
      .map(clone)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  listEvents(scopeId?: string) {
    return this.readState().orchestrator_events
      .filter((event) => !scopeId || event.scope_id === scopeId)
      .map(clone)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  getSettings() {
    return clone(this.readState().orchestrator_settings!);
  }

  private mutate<T>(action: (state: PersistedState) => T) {
    return this.withLock(() => {
      const state = this.readUnlocked();
      const result = action(state);
      this.writeUnlocked(state);
      return result;
    });
  }

  createSession(session: Parameters<MemoryStateStore["createSession"]>[0]) {
    return this.mutate((state) => {
      state.sessions[session.session_id] = session;
      return session;
    });
  }

  updateSession(session: Parameters<MemoryStateStore["updateSession"]>[0]) {
    return this.createSession(session);
  }

  createProject(project: Parameters<MemoryStateStore["createProject"]>[0]) {
    return this.mutate((state) => {
      state.projects[project.project_id] = project;
      return project;
    });
  }

  updateProject(project: Parameters<MemoryStateStore["updateProject"]>[0]) {
    return this.createProject(project);
  }

  createTask(task: Parameters<MemoryStateStore["createTask"]>[0]) {
    return this.mutate((state) => {
      state.tasks[task.task_id] = task;
      return task;
    });
  }

  updateTask(task: Parameters<MemoryStateStore["updateTask"]>[0]) {
    return this.createTask(task);
  }

  createWorker(worker: Parameters<MemoryStateStore["createWorker"]>[0]) {
    return this.mutate((state) => {
      state.workers[worker.worker_id] = worker;
      return worker;
    });
  }

  updateWorker(worker: Parameters<MemoryStateStore["updateWorker"]>[0]) {
    return this.createWorker(worker);
  }

  claimWorkerTask(input: Parameters<MemoryStateStore["claimWorkerTask"]>[0]) {
    return this.mutate((state) => claimWorkerTaskInState(state, input));
  }

  createCommandEvent(event: Parameters<MemoryStateStore["createCommandEvent"]>[0]) {
    return this.mutate((state) => {
      const redacted = redactCommandEvent(event);
      const duplicate = findDuplicateActiveCodexCommand(redacted, Object.values(state.command_events));
      if (duplicate) throw new Error(duplicateActiveCodexCommandMessage(redacted, duplicate));
      state.command_events[redacted.event_id] = redacted;
      return redacted;
    });
  }

  createSummary(summary: Parameters<MemoryStateStore["createSummary"]>[0]) {
    return this.mutate((state) => {
      state.run_summaries[summary.task_id] = summary;
      return summary;
    });
  }

  createApprovalRequest(approval: Parameters<MemoryStateStore["createApprovalRequest"]>[0]) {
    return this.mutate((state) => {
      state.approval_requests[approval.approval_id] = approval;
      return approval;
    });
  }

  createMcpEvent(event: Parameters<MemoryStateStore["createMcpEvent"]>[0]) {
    return this.mutate((state) => {
      state.mcp_tool_calls[event.mcp_call_id] = event;
      return event;
    });
  }

  createOperatorAction(action: Parameters<MemoryStateStore["createOperatorAction"]>[0]) {
    return this.mutate((state) => {
      state.operator_actions[action.action_id] = action;
      return action;
    });
  }

  updateOperatorAction(action: Parameters<MemoryStateStore["updateOperatorAction"]>[0]) {
    return this.createOperatorAction(action);
  }

  createTaskGraph(graph: Parameters<MemoryStateStore["createTaskGraph"]>[0]) {
    return this.mutate((state) => {
      state.task_graphs[graph.task_graph_id] = graph;
      return graph;
    });
  }

  updateTaskGraph(graph: Parameters<MemoryStateStore["updateTaskGraph"]>[0]) {
    return this.createTaskGraph(graph);
  }

  createWorkerContextPacket(packet: Parameters<MemoryStateStore["createWorkerContextPacket"]>[0]) {
    return this.mutate((state) => {
      state.worker_context_packets[packet.context_packet_id] = packet;
      return packet;
    });
  }

  updateWorkerContextPacket(packet: Parameters<MemoryStateStore["updateWorkerContextPacket"]>[0]) {
    return this.createWorkerContextPacket(packet);
  }

  createWorkerRuntimeCommandRequest(request: Parameters<MemoryStateStore["createWorkerRuntimeCommandRequest"]>[0]) {
    return this.mutate((state) => {
      state.worker_runtime_command_requests[request.request_id] = request;
      return request;
    });
  }

  updateWorkerRuntimeCommandRequest(request: Parameters<MemoryStateStore["updateWorkerRuntimeCommandRequest"]>[0]) {
    return this.createWorkerRuntimeCommandRequest(request);
  }

  appendEvent(event: Parameters<MemoryStateStore["appendEvent"]>[0]) {
    return this.mutate((state) => {
      const redacted = redactSensitiveJson(event);
      state.orchestrator_events.push(redacted);
      return redacted;
    });
  }

  updateSettings(settings: Parameters<MemoryStateStore["updateSettings"]>[0]) {
    return this.mutate((state) => {
      state.orchestrator_settings = settings;
      return settings;
    });
  }
}
