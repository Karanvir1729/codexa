import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { redactCommandEvent, redactSensitiveJson } from "./redaction.js";
import { normalizePersistedState, type InitialStateOptions } from "./state-store-common.js";
import { duplicateActiveCodexCommandMessage, isActiveCodexCommand, resolveWorkerTaskClaim } from "./worker-task-guard.js";
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

export type FirestoreCollection =
  | "sessions"
  | "projects"
  | "tasks"
  | "workers"
  | "command_events"
  | "active_codex_commands"
  | "summaries"
  | "approvals"
  | "mcp_events"
  | "operator_actions"
  | "task_graphs"
  | "worker_context_packets"
  | "worker_runtime_command_requests"
  | "project_artifacts"
  | "events"
  | "settings";

export interface FirestoreTransportRequest {
  op: "get" | "put" | "list" | "query" | "delete";
  projectId: string;
  databaseId: string;
  collection: string;
  documentId?: string;
  payload?: unknown;
  index?: Record<string, unknown>;
  filters?: Array<{ field: string; op?: "==" | "in"; value: unknown }>;
  limit?: number;
}

export type FirestoreTransport = (request: FirestoreTransportRequest) => unknown;

export interface FirestoreStateStoreOptions {
  projectId: string;
  databaseId?: string;
  collectionPrefix?: string;
  initialState: InitialStateOptions;
  transport?: FirestoreTransport;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string | null | undefined) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function cleanIndexValue(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function compactIndex(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key, cleanIndexValue(value)] as const)
      .filter(([, value]) => value !== undefined),
  );
}

function indexForPayload(collection: FirestoreCollection, payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  switch (collection) {
    case "sessions":
      return compactIndex({
        session_id: record.session_id,
        active_task_id: record.active_task_id,
        active_worker_id: record.active_worker_id,
        current_project_id: record.current_project_id,
        project_id: record.project_id,
        last_updated: record.last_updated,
      });
    case "projects":
      return compactIndex({
        project_id: record.project_id,
        workspace_path: record.workspace_path,
        updated_at: record.updated_at,
      });
    case "tasks":
      return compactIndex({
        task_id: record.task_id,
        project_id: record.project_id,
        status: record.status,
        task_graph_id: record.task_graph_id,
        worker_id: record.worker_id,
        updated_at: record.updated_at,
      });
    case "workers":
      return compactIndex({
        worker_id: record.worker_id,
        project_id: record.project_id,
        task_id: record.task_id,
        type: record.type,
        status: record.status,
        created_at: record.created_at,
      });
    case "command_events":
      return compactIndex({
        event_id: record.event_id,
        task_id: record.task_id,
        project_id: record.project_id,
        worker_id: record.worker_id,
        exit_code: record.exit_code,
        started_at: record.started_at,
      });
    case "summaries":
      return compactIndex({ task_id: record.task_id, created_at: record.created_at });
    case "approvals":
      return compactIndex({ approval_id: record.approval_id, status: record.status, created_at: record.created_at });
    case "mcp_events":
      return compactIndex({
        mcp_call_id: record.mcp_call_id,
        task_id: record.task_id,
        project_id: record.project_id,
        worker_id: record.worker_id,
        session_id: record.session_id,
        started_at: record.started_at,
      });
    case "operator_actions":
      return compactIndex({
        action_id: record.action_id,
        session_id: record.session_id,
        task_id: record.task_id,
        project_id: record.project_id,
        worker_id: record.worker_id,
        status: record.status,
        started_at: record.started_at,
      });
    case "task_graphs":
      return compactIndex({ task_graph_id: record.task_graph_id, project_id: record.project_id, status: record.status, updated_at: record.updated_at });
    case "worker_context_packets":
      return compactIndex({
        context_packet_id: record.context_packet_id,
        task_graph_id: record.task_graph_id,
        task_id: record.task_id,
        worker_id: record.worker_id,
        created_at: record.created_at,
      });
    case "worker_runtime_command_requests":
      return compactIndex({
        request_id: record.request_id,
        worker_id: record.worker_id,
        task_id: record.task_id,
        status: record.status,
        created_at: record.created_at,
      });
    case "project_artifacts":
      return compactIndex({
        artifact_id: record.artifact_id,
        project_id: record.project_id,
        task_id: record.task_id,
        worker_id: record.worker_id,
        path: record.path,
        updated_at: record.updated_at,
      });
    case "events":
      return compactIndex({ event_id: record.event_id, scope_id: record.scope_id, scope: record.scope, type: record.type, created_at: record.created_at });
    case "active_codex_commands":
      return compactIndex({ task_id: record.task_id, event_id: record.event_id });
    case "settings":
      return compactIndex({});
  }
}

function firestoreHelperPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "firestore-state-transport.mjs");
}

function defaultTransport(request: FirestoreTransportRequest) {
  const timeout = Number(process.env.FIRESTORE_STATE_OPERATION_TIMEOUT_MS || 10_000);
  const result = spawnSync(process.execPath, [firestoreHelperPath()], {
    input: JSON.stringify(request),
    encoding: "utf8",
    env: process.env,
    maxBuffer: 25 * 1024 * 1024,
    timeout,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new Error(`Firestore state operation timed out after ${timeout}ms for ${request.op} ${request.collection}${request.documentId ? `/${request.documentId}` : ""}.`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Firestore state operation failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export class FirestoreStateStore implements StateStore {
  readonly kind = "firestore" as const;
  private readonly databaseId: string;
  private readonly collectionPrefix: string;
  private readonly transport: FirestoreTransport;
  private readonly documentCache = new Map<string, unknown>();

  constructor(private readonly options: FirestoreStateStoreOptions) {
    if (!options.projectId.trim()) throw new Error("FirestoreStateStore requires projectId.");
    this.databaseId = options.databaseId || "(default)";
    this.collectionPrefix = options.collectionPrefix || "head_developer";
    this.transport = options.transport ?? defaultTransport;
  }

  private collection(name: FirestoreCollection) {
    return `${this.collectionPrefix}_${name}`;
  }

  private cacheKey(collection: FirestoreCollection, documentId: string) {
    return `${collection}:${documentId}`;
  }

  private getDoc<T>(collection: FirestoreCollection, documentId: string): T | null {
    const key = this.cacheKey(collection, documentId);
    if (this.documentCache.has(key)) return clone(this.documentCache.get(key) as T);
    const value = this.transport({
      op: "get",
      projectId: this.options.projectId,
      databaseId: this.databaseId,
      collection: this.collection(collection),
      documentId,
    }) as T | null;
    if (value) this.documentCache.set(key, clone(value));
    return value;
  }

  private putDoc<T>(collection: FirestoreCollection, documentId: string, payload: T): T {
    this.transport({
      op: "put",
      projectId: this.options.projectId,
      databaseId: this.databaseId,
      collection: this.collection(collection),
      documentId,
      payload,
      index: indexForPayload(collection, payload),
    });
    this.documentCache.set(this.cacheKey(collection, documentId), clone(payload));
    return payload;
  }

  private deleteDoc(collection: FirestoreCollection, documentId: string) {
    this.transport({
      op: "delete",
      projectId: this.options.projectId,
      databaseId: this.databaseId,
      collection: this.collection(collection),
      documentId,
    });
    this.documentCache.delete(this.cacheKey(collection, documentId));
  }

  private rememberDocs<T>(collection: FirestoreCollection, values: T[]) {
    for (const value of values) {
      const record = value as Record<string, unknown>;
      const documentId =
        (collection === "sessions" ? record.session_id : undefined) ??
        (collection === "projects" ? record.project_id : undefined) ??
        (collection === "tasks" ? record.task_id : undefined) ??
        (collection === "workers" ? record.worker_id : undefined) ??
        (collection === "command_events" ? record.event_id : undefined) ??
        (collection === "active_codex_commands" ? record.task_id : undefined) ??
        (collection === "summaries" ? record.task_id : undefined) ??
        (collection === "approvals" ? record.approval_id : undefined) ??
        (collection === "mcp_events" ? record.mcp_call_id : undefined) ??
        (collection === "operator_actions" ? record.action_id : undefined) ??
        (collection === "task_graphs" ? record.task_graph_id : undefined) ??
        (collection === "worker_context_packets" ? record.context_packet_id : undefined) ??
        (collection === "worker_runtime_command_requests" ? record.request_id : undefined) ??
        (collection === "project_artifacts" ? record.artifact_id : undefined) ??
        (collection === "events" ? record.event_id : undefined) ??
        (collection === "settings" ? "settings" : undefined);
      if (typeof documentId === "string" && documentId) this.documentCache.set(this.cacheKey(collection, documentId), clone(value));
    }
    return values;
  }

  private listDocs<T>(collection: FirestoreCollection, limit = 100): T[] {
    const values = this.transport({
      op: "list",
      projectId: this.options.projectId,
      databaseId: this.databaseId,
      collection: this.collection(collection),
      limit,
    }) as T[];
    return this.rememberDocs(collection, values);
  }

  private queryDocs<T>(
    collection: FirestoreCollection,
    filters: Array<{ field: string; op?: "==" | "in"; value: unknown }>,
    limit = 100,
  ): T[] {
    if (!filters.length) return this.listDocs<T>(collection, limit);
    const values = this.transport({
      op: "query",
      projectId: this.options.projectId,
      databaseId: this.databaseId,
      collection: this.collection(collection),
      filters,
      limit,
    }) as T[];
    return this.rememberDocs(collection, values);
  }

  readState(): PersistedState {
    const settings = this.getSettings();
    return normalizePersistedState({
      sessions: Object.fromEntries(this.listDocs<SessionState>("sessions").map((item) => [item.session_id, item])),
      projects: Object.fromEntries(this.listDocs<ProjectRecord>("projects").map((item) => [item.project_id, item])),
      tasks: Object.fromEntries(this.listDocs<TaskRecord>("tasks").map((item) => [item.task_id, item])),
      workers: Object.fromEntries(this.listDocs<WorkerRecord>("workers").map((item) => [item.worker_id, item])),
      command_events: Object.fromEntries(this.listDocs<CommandEventRecord>("command_events").map((item) => [item.event_id, item])),
      run_summaries: Object.fromEntries(this.listDocs<RunSummaryRecord>("summaries").map((item) => [item.task_id, item])),
      approval_requests: Object.fromEntries(this.listDocs<ApprovalRequestRecord>("approvals").map((item) => [item.approval_id, item])),
      orchestrator_events: this.listDocs<OrchestratorEvent>("events"),
      orchestrator_settings: settings,
      mcp_tool_calls: Object.fromEntries(this.listDocs<McpToolCallRecord>("mcp_events").map((item) => [item.mcp_call_id, item])),
      operator_actions: Object.fromEntries(this.listDocs<OperatorActionRecord>("operator_actions").map((item) => [item.action_id, item])),
      task_graphs: Object.fromEntries(this.listDocs<TaskGraphRecord>("task_graphs").map((item) => [item.task_graph_id, item])),
      worker_context_packets: Object.fromEntries(this.listDocs<WorkerContextPacket>("worker_context_packets").map((item) => [item.context_packet_id, item])),
      worker_runtime_command_requests: Object.fromEntries(this.listDocs<WorkerRuntimeCommandRequest>("worker_runtime_command_requests").map((item) => [item.request_id, item])),
      project_artifacts: Object.fromEntries(this.listDocs<ProjectArtifactFileRecord>("project_artifacts").map((item) => [item.artifact_id, item])),
    }, this.options.initialState);
  }

  replaceState(state: PersistedState) {
    for (const item of Object.values(state.sessions)) this.createSession(item);
    for (const item of Object.values(state.projects)) this.createProject(item);
    for (const item of Object.values(state.tasks)) this.createTask(item);
    for (const item of Object.values(state.workers)) this.createWorker(item);
    for (const item of Object.values(state.command_events)) this.createCommandEvent(item);
    for (const item of Object.values(state.run_summaries)) this.createSummary(item);
    for (const item of Object.values(state.approval_requests)) this.createApprovalRequest(item);
    for (const item of Object.values(state.mcp_tool_calls)) this.createMcpEvent(item);
    for (const item of Object.values(state.operator_actions)) this.createOperatorAction(item);
    for (const item of Object.values(state.task_graphs)) this.createTaskGraph(item);
    for (const item of Object.values(state.worker_context_packets)) this.createWorkerContextPacket(item);
    for (const item of Object.values(state.worker_runtime_command_requests)) this.createWorkerRuntimeCommandRequest(item);
    for (const item of Object.values(state.project_artifacts)) this.upsertProjectArtifactFile(item);
    for (const item of state.orchestrator_events) this.appendEvent(item);
    if (state.orchestrator_settings) this.updateSettings(state.orchestrator_settings);
  }

  createSession(session: SessionState) {
    return this.putDoc("sessions", session.session_id, session);
  }

  updateSession(session: SessionState) {
    return this.createSession(session);
  }

  getSession(sessionId: string) {
    return this.getDoc<SessionState>("sessions", sessionId);
  }

  listSessions(filters: SessionFilters = {}) {
    const limit = filters.limit ?? 100;
    const results: SessionState[] = [];
    if (filters.taskId) results.push(...this.queryDocs<SessionState>("sessions", [{ field: "active_task_id", value: filters.taskId }], limit));
    if (filters.workerId) results.push(...this.queryDocs<SessionState>("sessions", [{ field: "active_worker_id", value: filters.workerId }], limit));
    if (filters.projectId) {
      results.push(...this.queryDocs<SessionState>("sessions", [{ field: "project_id", value: filters.projectId }], limit));
      results.push(...this.queryDocs<SessionState>("sessions", [{ field: "current_project_id", value: filters.projectId }], limit));
    }
    const values = results.length ? uniqueBy(results, (session) => session.session_id) : this.listDocs<SessionState>("sessions", limit);
    return values.sort((a, b) => b.last_updated.localeCompare(a.last_updated)).slice(0, limit);
  }

  createProject(project: ProjectRecord) {
    return this.putDoc("projects", project.project_id, project);
  }

  updateProject(project: ProjectRecord) {
    return this.createProject(project);
  }

  getProject(projectId: string) {
    return this.getDoc<ProjectRecord>("projects", projectId);
  }

  listProjects(filters: ProjectFilters = {}) {
    const limit = filters.limit ?? 100;
    const values = filters.workspacePath
      ? this.queryDocs<ProjectRecord>("projects", [{ field: "workspace_path", value: filters.workspacePath }], limit)
      : this.listDocs<ProjectRecord>("projects", limit);
    return values.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
  }

  createTask(task: TaskRecord) {
    return this.putDoc("tasks", task.task_id, task);
  }

  updateTask(task: TaskRecord) {
    return this.createTask(task);
  }

  getTask(taskId: string) {
    return this.getDoc<TaskRecord>("tasks", taskId);
  }

  listTasks(projectIdOrFilters?: string | TaskFilters) {
    const filters: TaskFilters = typeof projectIdOrFilters === "string" ? { projectId: projectIdOrFilters } : projectIdOrFilters ?? {};
    const limit = filters.limit ?? 200;
    const queryFilters = [
      ...(filters.projectId ? [{ field: "project_id", value: filters.projectId }] : filters.status ? [{ field: "status", value: filters.status }] : []),
    ];
    return this.queryDocs<TaskRecord>("tasks", queryFilters, limit)
      .filter((task) => !filters.projectId || task.project_id === filters.projectId)
      .filter((task) => !filters.status || task.status === filters.status)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  createWorker(worker: WorkerRecord) {
    return this.putDoc("workers", worker.worker_id, worker);
  }

  updateWorker(worker: WorkerRecord) {
    return this.createWorker(worker);
  }

  getWorker(workerId: string) {
    return this.getDoc<WorkerRecord>("workers", workerId);
  }

  listWorkers(filters: WorkerFilters = {}) {
    const limit = filters.limit ?? 200;
    const statuses = Array.isArray(filters.status) ? filters.status : filters.status ? [filters.status] : [];
    const queryFilters = [
      ...(filters.type ? [{ field: "type", value: filters.type }] : statuses.length === 1 ? [{ field: "status", value: statuses[0] }] : statuses.length > 1 ? [{ field: "status", op: "in" as const, value: statuses }] : []),
    ];
    return this.queryDocs<WorkerRecord>("workers", queryFilters, limit)
      .filter((worker) => !filters.type || worker.type === filters.type)
      .filter((worker) => !statuses.length || statuses.includes(worker.status))
      .filter((worker) => !filters.active || !["stopped", "expired", "failed"].includes(worker.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  claimWorkerTask(input: Parameters<StateStore["claimWorkerTask"]>[0]) {
    const worker = this.getWorker(input.worker_id);
    if (!worker) {
      return {
        decision: "skipped_worker_status" as const,
        abandoned_commands: [],
        reason: `Worker not found: ${input.worker_id}`,
        task: null,
        worker: null,
        error_code: "WORKER_NOT_FOUND" as const,
      };
    }
    const task = this.getTask(input.task_id);
    if (!task) {
      return {
        decision: "skipped_terminal_task" as const,
        abandoned_commands: [],
        reason: `Task not found: ${input.task_id}`,
        task: null,
        worker: clone(worker),
        error_code: "TASK_NOT_FOUND" as const,
      };
    }
    const now = input.now_iso ? new Date(input.now_iso) : new Date();
    const decision = resolveWorkerTaskClaim({
      task,
      worker,
      commands: [],
      runtime: input.runtime,
      now,
      leaseTtlMs: input.lease_ttl_ms,
    });
    for (const abandoned of decision.abandoned_commands) this.createCommandEvent(abandoned);
    const nextTask = clone(task);
    const nextWorker = clone(worker);
    if (decision.decision === "claimed" || decision.decision === "claimed_after_abandoning_previous") {
      const leaseId = decision.lease_id ?? `lease_${Date.now()}`;
      const attemptId =
        input.runtime.run_attempt_id?.trim() ||
        input.runtime.startup_attempt_id?.trim() ||
        nextWorker.run_attempt_id?.trim() ||
        nextWorker.startup_attempt_id?.trim() ||
        null;
      nextTask.status = "running";
      nextTask.worker_id = nextWorker.worker_id;
      nextTask.in_flight_action = "codex_exec";
      nextTask.command_lease_id = leaseId;
      nextTask.command_lease_owner = nextWorker.worker_id;
      nextTask.command_lease_attempt_id = attemptId;
      nextTask.command_lease_acquired_at = now.toISOString();
      nextTask.command_lease_expires_at = new Date(now.getTime() + input.lease_ttl_ms).toISOString();
      nextTask.updated_at = now.toISOString();
      nextWorker.status = "running";
      nextWorker.task_id = nextTask.task_id;
      nextWorker.project_id = nextTask.project_id;
      this.updateTask(nextTask);
      this.updateWorker(nextWorker);
    }
    return { ...decision, task: clone(nextTask), worker: clone(nextWorker) };
  }

  createCommandEvent(event: CommandEventRecord) {
    const redacted = redactCommandEvent(event);
    const existingActive = this.getDoc<CommandEventRecord>("active_codex_commands", redacted.task_id);
    if (isActiveCodexCommand(redacted)) {
      if (existingActive && existingActive.event_id !== redacted.event_id) {
        throw new Error(duplicateActiveCodexCommandMessage(redacted, existingActive));
      }
      this.putDoc("active_codex_commands", redacted.task_id, redacted);
    } else if (existingActive?.event_id === redacted.event_id) {
      this.deleteDoc("active_codex_commands", redacted.task_id);
    }
    return this.putDoc("command_events", redacted.event_id, redacted);
  }

  getCommandEvent(eventId: string) {
    return this.getDoc<CommandEventRecord>("command_events", eventId);
  }

  listCommandEvents(filters: CommandEventFilters = {}) {
    const limit = filters.limit ?? 500;
    const queryFilters = [
      ...(filters.taskId ? [{ field: "task_id", value: filters.taskId }] : filters.workerId ? [{ field: "worker_id", value: filters.workerId }] : filters.projectId ? [{ field: "project_id", value: filters.projectId }] : []),
    ];
    return this.queryDocs<CommandEventRecord>("command_events", queryFilters, limit)
      .filter((event) => !filters.taskId || event.task_id === filters.taskId)
      .filter((event) => !filters.projectId || event.project_id === filters.projectId)
      .filter((event) => !filters.workerId || event.worker_id === filters.workerId)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .slice(0, limit);
  }

  createSummary(summary: RunSummaryRecord) {
    return this.putDoc("summaries", summary.task_id, summary);
  }

  getSummary(taskId: string) {
    return this.getDoc<RunSummaryRecord>("summaries", taskId);
  }

  listSummaries() {
    return this.listDocs<RunSummaryRecord>("summaries").sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  createApprovalRequest(approval: ApprovalRequestRecord) {
    return this.putDoc("approvals", approval.approval_id, approval);
  }

  getApprovalRequest(approvalId: string) {
    return this.getDoc<ApprovalRequestRecord>("approvals", approvalId);
  }

  listApprovalRequests(status?: ApprovalRequestRecord["status"]) {
    const values = status ? this.queryDocs<ApprovalRequestRecord>("approvals", [{ field: "status", value: status }], 100) : this.listDocs<ApprovalRequestRecord>("approvals", 100);
    return values
      .filter((approval) => !status || approval.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  createMcpEvent(event: McpToolCallRecord) {
    return this.putDoc("mcp_events", event.mcp_call_id, event);
  }

  listMcpEvents(filters: McpEventFilters = {}) {
    const limit = 200;
    const queryFilters = [
      ...(filters.taskId ? [{ field: "task_id", value: filters.taskId }] : filters.workerId ? [{ field: "worker_id", value: filters.workerId }] : filters.sessionId ? [{ field: "session_id", value: filters.sessionId }] : filters.projectId ? [{ field: "project_id", value: filters.projectId }] : []),
    ];
    return this.queryDocs<McpToolCallRecord>("mcp_events", queryFilters, limit)
      .filter((call) => !filters.taskId || call.task_id === filters.taskId)
      .filter((call) => !filters.projectId || call.project_id === filters.projectId)
      .filter((call) => !filters.workerId || call.worker_id === filters.workerId)
      .filter((call) => !filters.sessionId || call.session_id === filters.sessionId)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .slice(0, limit);
  }

  createOperatorAction(action: OperatorActionRecord) {
    return this.putDoc("operator_actions", action.action_id, action);
  }

  updateOperatorAction(action: OperatorActionRecord) {
    return this.createOperatorAction(action);
  }

  getOperatorAction(actionId: string) {
    return this.getDoc<OperatorActionRecord>("operator_actions", actionId);
  }

  listOperatorActions(filters: OperatorActionFilters = {}) {
    const limit = 200;
    const queryFilters = [
      ...(filters.sessionId ? [{ field: "session_id", value: filters.sessionId }] : filters.taskId ? [{ field: "task_id", value: filters.taskId }] : filters.workerId ? [{ field: "worker_id", value: filters.workerId }] : filters.projectId ? [{ field: "project_id", value: filters.projectId }] : filters.status ? [{ field: "status", value: filters.status }] : []),
    ];
    return this.queryDocs<OperatorActionRecord>("operator_actions", queryFilters, limit)
      .filter((action) => !filters.sessionId || action.session_id === filters.sessionId)
      .filter((action) => !filters.taskId || action.task_id === filters.taskId)
      .filter((action) => !filters.projectId || action.project_id === filters.projectId)
      .filter((action) => !filters.workerId || action.worker_id === filters.workerId)
      .filter((action) => !filters.status || action.status === filters.status)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .slice(0, limit);
  }

  createTaskGraph(graph: TaskGraphRecord) {
    return this.putDoc("task_graphs", graph.task_graph_id, graph);
  }

  updateTaskGraph(graph: TaskGraphRecord) {
    return this.createTaskGraph(graph);
  }

  getTaskGraph(taskGraphId: string) {
    return this.getDoc<TaskGraphRecord>("task_graphs", taskGraphId);
  }

  listTaskGraphs(projectIdOrFilters?: string | TaskGraphFilters) {
    const filters: TaskGraphFilters = typeof projectIdOrFilters === "string" ? { projectId: projectIdOrFilters } : projectIdOrFilters ?? {};
    const limit = filters.limit ?? 100;
    const values = filters.projectId
      ? this.queryDocs<TaskGraphRecord>("task_graphs", [{ field: "project_id", value: filters.projectId }], limit)
      : this.listDocs<TaskGraphRecord>("task_graphs", limit);
    return values
      .filter((graph) => !filters.projectId || graph.project_id === filters.projectId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
  }

  createWorkerContextPacket(packet: WorkerContextPacket) {
    return this.putDoc("worker_context_packets", packet.context_packet_id, packet);
  }

  updateWorkerContextPacket(packet: WorkerContextPacket) {
    return this.createWorkerContextPacket(packet);
  }

  getWorkerContextPacket(packetId: string) {
    return this.getDoc<WorkerContextPacket>("worker_context_packets", packetId);
  }

  listWorkerContextPackets(filters: { taskGraphId?: string; taskId?: string; workerId?: string } = {}) {
    const limit = 200;
    const queryFilters = [
      ...(filters.taskGraphId ? [{ field: "task_graph_id", value: filters.taskGraphId }] : filters.taskId ? [{ field: "task_id", value: filters.taskId }] : filters.workerId ? [{ field: "worker_id", value: filters.workerId }] : []),
    ];
    return this.queryDocs<WorkerContextPacket>("worker_context_packets", queryFilters, limit)
      .filter((packet) => !filters.taskGraphId || packet.task_graph_id === filters.taskGraphId)
      .filter((packet) => !filters.taskId || packet.task_id === filters.taskId)
      .filter((packet) => !filters.workerId || packet.worker_id === filters.workerId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  createWorkerRuntimeCommandRequest(request: WorkerRuntimeCommandRequest) {
    return this.putDoc("worker_runtime_command_requests", request.request_id, request);
  }

  updateWorkerRuntimeCommandRequest(request: WorkerRuntimeCommandRequest) {
    return this.createWorkerRuntimeCommandRequest(request);
  }

  getWorkerRuntimeCommandRequest(requestId: string) {
    return this.getDoc<WorkerRuntimeCommandRequest>("worker_runtime_command_requests", requestId);
  }

  listWorkerRuntimeCommandRequests(filters: { workerId?: string; taskId?: string; status?: WorkerRuntimeCommandRequest["status"] } = {}) {
    const limit = 200;
    const queryFilters = [
      ...(filters.workerId ? [{ field: "worker_id", value: filters.workerId }] : filters.taskId ? [{ field: "task_id", value: filters.taskId }] : filters.status ? [{ field: "status", value: filters.status }] : []),
    ];
    return this.queryDocs<WorkerRuntimeCommandRequest>("worker_runtime_command_requests", queryFilters, limit)
      .filter((request) => !filters.workerId || request.worker_id === filters.workerId)
      .filter((request) => !filters.taskId || request.task_id === filters.taskId)
      .filter((request) => !filters.status || request.status === filters.status)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
  }

  upsertProjectArtifactFile(record: ProjectArtifactFileRecord) {
    return this.putDoc("project_artifacts", record.artifact_id, record);
  }

  listProjectArtifactFiles(projectId: string) {
    return this.queryDocs<ProjectArtifactFileRecord>("project_artifacts", [{ field: "project_id", value: projectId }], 100)
      .filter((record) => record.project_id === projectId)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  appendEvent(event: OrchestratorEvent) {
    const redacted = redactSensitiveJson(event);
    return this.putDoc("events", redacted.event_id, redacted);
  }

  listEvents(scopeId?: string) {
    const values = scopeId ? this.queryDocs<OrchestratorEvent>("events", [{ field: "scope_id", value: scopeId }], 200) : this.listDocs<OrchestratorEvent>("events", 200);
    return values
      .filter((event) => !scopeId || event.scope_id === scopeId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  getSettings() {
    return this.getDoc<OrchestratorSettings>("settings", "orchestrator") ?? clone(normalizePersistedState({}, this.options.initialState).orchestrator_settings!);
  }

  updateSettings(settings: OrchestratorSettings) {
    return this.putDoc("settings", "orchestrator", settings);
  }
}
