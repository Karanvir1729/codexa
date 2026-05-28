import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ensureSessionShape } from "./session.js";
import { redactCommandEvent, redactSensitiveJson, redactSensitiveText } from "./redaction.js";
import { FileStateStore } from "./file-state-store.js";
import { FirestoreStateStore } from "./firestore-state-store.js";
import { MemoryStateStore } from "./memory-state-store.js";
import type { ProjectFilters, SessionFilters, StateStore, TaskFilters, TaskGraphFilters, WorkerFilters } from "./state-store-types.js";
import type { AtomicWorkerTaskClaimInput } from "./worker-task-guard.js";
import type {
  ApprovalRequestRecord,
  CommandEventRecord,
  McpToolCallRecord,
  OperatorActionRecord,
  OrchestratorEvent,
  OrchestratorSettings,
  PersistedState,
  RunSummaryRecord,
  SessionState,
  SupervisorEvent,
  TaskGraphRecord,
  TaskRecord,
  WorkerContextPacket,
  WorkerRecord,
  WorkerRuntimeCommandRequest,
} from "./types.js";

type OrchestratorEventSubscriber = (event: OrchestratorEvent) => void;
const orchestratorEventSubscribers = new Set<OrchestratorEventSubscriber>();
let auditLogScrubbedForProcess = false;

function initialStateOptions() {
  return {
    defaultWorkerMode: config.orchestrator.workerMode || config.orchestrator.defaultWorkerType,
    allowWorkerModeSwitch: config.orchestrator.allowWorkerModeSwitch,
    maxLocalWorkers: config.orchestrator.maxLocalWorkers,
    maxDockerLocalWorkers: config.orchestrator.maxDockerLocalWorkers,
    maxGcpVmWorkers: config.orchestrator.maxGcpVmWorkers,
    maxGkeJobWorkers: config.orchestrator.maxGkeJobWorkers,
  };
}

function createConfiguredStateStore(): StateStore {
  const initialState = initialStateOptions();
  if (config.stateStore.type === "memory") return new MemoryStateStore(initialState);
  if (config.stateStore.type === "firestore") {
    return new FirestoreStateStore({
      projectId: config.stateStore.firestoreProjectId,
      databaseId: config.stateStore.firestoreDatabaseId,
      collectionPrefix: config.stateStore.firestoreCollectionPrefix,
      initialState,
    });
  }
  return new FileStateStore({
    storePath: config.storePath,
    lockTimeoutMs: config.storeLockTimeoutMs,
    lockRetryMs: config.storeLockRetryMs,
    initialState,
  });
}

let activeStore: StateStore | null = null;

export function getStateStore() {
  activeStore ??= createConfiguredStateStore();
  return activeStore;
}

export function stateStoreKind() {
  return getStateStore().kind;
}

export function subscribeOrchestratorEvents(subscriber: OrchestratorEventSubscriber) {
  orchestratorEventSubscribers.add(subscriber);
  return () => orchestratorEventSubscribers.delete(subscriber);
}

export function readStore(): PersistedState {
  return getStateStore().readState();
}

export function writeStore(state: PersistedState) {
  return getStateStore().replaceState(state);
}

export function getSession(sessionId: string) {
  const session = getStateStore().getSession(sessionId);
  return session ? ensureSessionShape(session) : null;
}

export function upsertSession(session: SessionState) {
  return getStateStore().updateSession(session);
}

export function listSessions(filters: SessionFilters = {}) {
  return getStateStore().listSessions(filters).map(ensureSessionShape);
}

export function appendAuditEvent(event: Omit<SupervisorEvent, "id">) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  fs.mkdirSync(config.artifactsDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.auditLogPath), { recursive: true });
  if (!auditLogScrubbedForProcess && fs.existsSync(config.auditLogPath)) {
    const existing = fs.readFileSync(config.auditLogPath, "utf8");
    const redactedExisting = redactSensitiveText(existing);
    if (redactedExisting !== existing) fs.writeFileSync(config.auditLogPath, redactedExisting);
  }
  auditLogScrubbedForProcess = true;
  const withId = redactSensitiveJson({ ...event, id: randomUUID() });
  const line = `${JSON.stringify(withId).replace(/\r?\n/g, "\\n")}\n`;
  const fd = fs.openSync(config.auditLogPath, "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return withId;
}

export function getTask(taskId: string) {
  return getStateStore().getTask(taskId);
}

export function upsertTask(task: TaskRecord) {
  return getStateStore().updateTask(task);
}

export function listTasks(projectIdOrFilters?: string | TaskFilters) {
  return getStateStore().listTasks(projectIdOrFilters);
}

export function getWorker(workerId: string) {
  return getStateStore().getWorker(workerId);
}

export function upsertWorker(worker: WorkerRecord) {
  return getStateStore().updateWorker(worker);
}

export function listWorkers(filters: WorkerFilters = {}) {
  return getStateStore().listWorkers(filters);
}

export function claimWorkerTask(input: AtomicWorkerTaskClaimInput) {
  return getStateStore().claimWorkerTask(input);
}

export function upsertCommandEvent(event: CommandEventRecord) {
  return getStateStore().createCommandEvent(redactCommandEvent(event));
}

export function getCommandEvent(eventId: string) {
  return getStateStore().getCommandEvent(eventId);
}

export function listCommandEvents(filters: { taskId?: string; projectId?: string; workerId?: string } = {}) {
  return getStateStore().listCommandEvents(filters);
}

export function upsertRunSummary(summary: RunSummaryRecord) {
  return getStateStore().createSummary(summary);
}

export function getRunSummary(taskId: string) {
  return getStateStore().getSummary(taskId);
}

export function listRunSummaries() {
  return getStateStore().listSummaries();
}

export function upsertApprovalRequest(approval: ApprovalRequestRecord) {
  return getStateStore().createApprovalRequest(approval);
}

export function getApprovalRequest(approvalId: string) {
  return getStateStore().getApprovalRequest(approvalId);
}

export function listApprovalRequests(status?: ApprovalRequestRecord["status"]) {
  return getStateStore().listApprovalRequests(status);
}

export function upsertMcpToolCall(call: McpToolCallRecord) {
  return getStateStore().createMcpEvent(call);
}

export function listMcpToolCalls(filters: { taskId?: string; projectId?: string; workerId?: string; sessionId?: string } = {}) {
  return getStateStore().listMcpEvents(filters);
}

export function upsertOperatorAction(action: OperatorActionRecord) {
  return getStateStore().updateOperatorAction(action);
}

export function getOperatorAction(actionId: string) {
  return getStateStore().getOperatorAction(actionId);
}

export function listOperatorActions(filters: { sessionId?: string; taskId?: string; projectId?: string; workerId?: string; status?: OperatorActionRecord["status"] } = {}) {
  return getStateStore().listOperatorActions(filters);
}

export function upsertTaskGraph(graph: TaskGraphRecord) {
  return getStateStore().updateTaskGraph(graph);
}

export function getTaskGraph(taskGraphId: string) {
  return getStateStore().getTaskGraph(taskGraphId);
}

export function listTaskGraphs(projectIdOrFilters?: string | TaskGraphFilters) {
  return getStateStore().listTaskGraphs(projectIdOrFilters);
}

export function upsertWorkerContextPacket(packet: WorkerContextPacket) {
  return getStateStore().updateWorkerContextPacket(packet);
}

export function getWorkerContextPacket(packetId: string) {
  return getStateStore().getWorkerContextPacket(packetId);
}

export function listWorkerContextPackets(filters: { taskGraphId?: string; taskId?: string; workerId?: string } = {}) {
  return getStateStore().listWorkerContextPackets(filters);
}

export function upsertWorkerRuntimeCommandRequest(request: WorkerRuntimeCommandRequest) {
  return getStateStore().updateWorkerRuntimeCommandRequest(request);
}

export function getWorkerRuntimeCommandRequest(requestId: string) {
  return getStateStore().getWorkerRuntimeCommandRequest(requestId);
}

export function listWorkerRuntimeCommandRequests(filters: { workerId?: string; taskId?: string; status?: WorkerRuntimeCommandRequest["status"] } = {}) {
  return getStateStore().listWorkerRuntimeCommandRequests(filters);
}

export function appendOrchestratorEvent(event: Omit<OrchestratorEvent, "event_id" | "created_at"> & { created_at?: string }) {
  const withId: OrchestratorEvent = redactSensitiveJson({
    ...event,
    event_id: randomUUID(),
    created_at: event.created_at ?? new Date().toISOString(),
  });
  const store = getStateStore();
  if (store.kind === "firestore" && process.env.HEAD_DEVELOPER_SYNC_FIRESTORE_EVENTS !== "1") {
    if (process.env.HEAD_DEVELOPER_PERSIST_ASYNC_FIRESTORE_EVENTS === "1") {
      setImmediate(() => {
        try {
          store.appendEvent(withId);
        } catch (error) {
          console.warn(`orchestrator event persistence failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
  } else {
    store.appendEvent(withId);
  }
  const notifySubscribers = () => {
    for (const subscriber of orchestratorEventSubscribers) {
      try {
        subscriber(withId);
      } catch (error) {
        console.warn("orchestrator event subscriber failed", error);
      }
    }
  };
  if (store.kind === "firestore" && process.env.HEAD_DEVELOPER_NOTIFY_FIRESTORE_SUBSCRIBERS !== "1") {
    return withId;
  }
  if (store.kind === "firestore" && process.env.HEAD_DEVELOPER_SYNC_FIRESTORE_EVENTS !== "1") {
    setImmediate(notifySubscribers);
  } else {
    notifySubscribers();
  }
  return withId;
}

export function listOrchestratorEvents(scopeId?: string) {
  return getStateStore().listEvents(scopeId);
}

export function getOrchestratorSettings() {
  return getStateStore().getSettings();
}

export function updateOrchestratorSettings(settings: Partial<OrchestratorSettings>) {
  const current = getOrchestratorSettings();
  const next: OrchestratorSettings = {
    ...current,
    ...settings,
    updated_at: new Date().toISOString(),
  };
  return getStateStore().updateSettings(next);
}
