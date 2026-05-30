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
  TaskStatus,
  TaskRecord,
  WorkerContextPacket,
  WorkerRecord,
  WorkerRuntimeCommandRequest,
  WorkerType,
} from "./types.js";
import type { AtomicWorkerTaskClaimInput, AtomicWorkerTaskClaimResult } from "./worker-task-guard.js";

export interface CommandEventFilters {
  taskId?: string;
  projectId?: string;
  workerId?: string;
  limit?: number;
}

export interface McpEventFilters {
  taskId?: string;
  projectId?: string;
  workerId?: string;
  sessionId?: string;
}

export interface OperatorActionFilters {
  sessionId?: string;
  taskId?: string;
  projectId?: string;
  workerId?: string;
  status?: OperatorActionRecord["status"];
}

export interface SessionFilters {
  taskId?: string;
  workerId?: string;
  projectId?: string;
  limit?: number;
}

export interface ProjectFilters {
  workspacePath?: string;
  limit?: number;
}

export interface TaskFilters {
  projectId?: string;
  status?: TaskStatus;
  limit?: number;
}

export interface WorkerFilters {
  type?: WorkerType;
  status?: WorkerRecord["status"] | WorkerRecord["status"][];
  active?: boolean;
  limit?: number;
}

export interface TaskGraphFilters {
  projectId?: string;
  limit?: number;
}

export interface StateStore {
  readonly kind: "file" | "memory" | "firestore";
  readState(): PersistedState;
  replaceState(state: PersistedState): void;

  createSession(session: SessionState): SessionState;
  updateSession(session: SessionState): SessionState;
  getSession(sessionId: string): SessionState | null;
  listSessions(filters?: SessionFilters): SessionState[];

  createProject(project: ProjectRecord): ProjectRecord;
  updateProject(project: ProjectRecord): ProjectRecord;
  getProject(projectId: string): ProjectRecord | null;
  listProjects(filters?: ProjectFilters): ProjectRecord[];

  createTask(task: TaskRecord): TaskRecord;
  updateTask(task: TaskRecord): TaskRecord;
  getTask(taskId: string): TaskRecord | null;
  listTasks(projectIdOrFilters?: string | TaskFilters): TaskRecord[];

  createWorker(worker: WorkerRecord): WorkerRecord;
  updateWorker(worker: WorkerRecord): WorkerRecord;
  getWorker(workerId: string): WorkerRecord | null;
  listWorkers(filters?: WorkerFilters): WorkerRecord[];
  claimWorkerTask(input: AtomicWorkerTaskClaimInput): AtomicWorkerTaskClaimResult;

  createCommandEvent(event: CommandEventRecord): CommandEventRecord;
  getCommandEvent(eventId: string): CommandEventRecord | null;
  listCommandEvents(filters?: CommandEventFilters): CommandEventRecord[];

  createSummary(summary: RunSummaryRecord): RunSummaryRecord;
  getSummary(taskId: string): RunSummaryRecord | null;
  listSummaries(): RunSummaryRecord[];

  createApprovalRequest(approval: ApprovalRequestRecord): ApprovalRequestRecord;
  getApprovalRequest(approvalId: string): ApprovalRequestRecord | null;
  listApprovalRequests(status?: ApprovalRequestRecord["status"]): ApprovalRequestRecord[];

  createMcpEvent(event: McpToolCallRecord): McpToolCallRecord;
  listMcpEvents(filters?: McpEventFilters): McpToolCallRecord[];

  createOperatorAction(action: OperatorActionRecord): OperatorActionRecord;
  updateOperatorAction(action: OperatorActionRecord): OperatorActionRecord;
  getOperatorAction(actionId: string): OperatorActionRecord | null;
  listOperatorActions(filters?: OperatorActionFilters): OperatorActionRecord[];

  createTaskGraph(graph: TaskGraphRecord): TaskGraphRecord;
  updateTaskGraph(graph: TaskGraphRecord): TaskGraphRecord;
  getTaskGraph(taskGraphId: string): TaskGraphRecord | null;
  listTaskGraphs(projectIdOrFilters?: string | TaskGraphFilters): TaskGraphRecord[];

  createWorkerContextPacket(packet: WorkerContextPacket): WorkerContextPacket;
  updateWorkerContextPacket(packet: WorkerContextPacket): WorkerContextPacket;
  getWorkerContextPacket(packetId: string): WorkerContextPacket | null;
  listWorkerContextPackets(filters?: { taskGraphId?: string; taskId?: string; workerId?: string }): WorkerContextPacket[];

  createWorkerRuntimeCommandRequest(request: WorkerRuntimeCommandRequest): WorkerRuntimeCommandRequest;
  updateWorkerRuntimeCommandRequest(request: WorkerRuntimeCommandRequest): WorkerRuntimeCommandRequest;
  getWorkerRuntimeCommandRequest(requestId: string): WorkerRuntimeCommandRequest | null;
  listWorkerRuntimeCommandRequests(filters?: { workerId?: string; taskId?: string; status?: WorkerRuntimeCommandRequest["status"] }): WorkerRuntimeCommandRequest[];

  upsertProjectArtifactFile(record: ProjectArtifactFileRecord): ProjectArtifactFileRecord;
  listProjectArtifactFiles(projectId: string): ProjectArtifactFileRecord[];

  listEvents(scopeId?: string): OrchestratorEvent[];
  appendEvent(event: OrchestratorEvent): OrchestratorEvent;

  getSettings(): OrchestratorSettings;
  updateSettings(settings: OrchestratorSettings): OrchestratorSettings;
}
