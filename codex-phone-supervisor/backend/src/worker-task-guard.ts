import { randomUUID } from "node:crypto";
import type { CommandEventRecord, PersistedState, TaskRecord, WorkerRecord } from "./types.js";
import type { WorkerRuntimeMetadata } from "./workers.js";

export const RUNNABLE_TASK_STATUSES = new Set<TaskRecord["status"]>(["queued", "planning", "running", "waiting_for_approval"]);
export const POLLABLE_WORKER_STATUSES = new Set<WorkerRecord["status"]>(["starting", "assigned", "running", "idle"]);

export type WorkerTaskClaimDecision =
  | "claimed"
  | "claimed_after_abandoning_previous"
  | "already_running"
  | "blocked_by_active_command"
  | "skipped_terminal_task"
  | "skipped_worker_status";

export interface WorkerTaskClaimResult {
  decision: WorkerTaskClaimDecision;
  lease_id?: string;
  abandoned_commands: CommandEventRecord[];
  reason: string;
}

export interface AtomicWorkerTaskClaimInput {
  worker_id: string;
  task_id: string;
  runtime: WorkerRuntimeMetadata;
  now_iso?: string;
  lease_ttl_ms: number;
}

export interface AtomicWorkerTaskClaimResult extends WorkerTaskClaimResult {
  task: TaskRecord | null;
  worker: WorkerRecord | null;
  error_code?: "WORKER_NOT_FOUND" | "TASK_NOT_FOUND";
}

export function isRunnableTaskStatus(status: TaskRecord["status"]) {
  return RUNNABLE_TASK_STATUSES.has(status);
}

export function isPollableWorkerStatus(status: WorkerRecord["status"]) {
  return POLLABLE_WORKER_STATUSES.has(status);
}

export function isActiveCodexCommand(event: CommandEventRecord) {
  return event.exit_code === null && /\bcodex\s+exec\b/.test(event.command);
}

export function findDuplicateActiveCodexCommand(candidate: CommandEventRecord, commands: CommandEventRecord[]) {
  if (!isActiveCodexCommand(candidate)) return null;
  return commands.find((event) =>
    event.event_id !== candidate.event_id &&
    event.task_id === candidate.task_id &&
    isActiveCodexCommand(event)
  ) ?? null;
}

export function duplicateActiveCodexCommandMessage(candidate: CommandEventRecord, existing: CommandEventRecord) {
  return [
    `Refusing duplicate active codex exec for task ${candidate.task_id}.`,
    `Existing command event ${existing.event_id} is still active on worker ${existing.worker_id}.`,
    `Candidate command event ${candidate.event_id} from worker ${candidate.worker_id} was not persisted.`,
  ].join(" ");
}

function optionalText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function commandAttemptId(event: CommandEventRecord) {
  return optionalText(event.run_attempt_id) ?? optionalText(event.startup_attempt_id);
}

function runtimeAttemptId(runtime: WorkerRuntimeMetadata) {
  return optionalText(runtime.run_attempt_id) ?? optionalText(runtime.startup_attempt_id);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function leaseIsActive(task: TaskRecord, nowMs: number) {
  if (!task.command_lease_id || !task.command_lease_expires_at) return false;
  return Date.parse(task.command_lease_expires_at) > nowMs;
}

export function shouldPollWorkerForTask(worker: WorkerRecord, task: TaskRecord | null) {
  if (!task) return false;
  return isPollableWorkerStatus(worker.status) && isRunnableTaskStatus(task.status);
}

export function markCommandAbandoned(event: CommandEventRecord, nowIso: string, reason = "Command abandoned after worker restart before completion.") {
  return {
    ...event,
    ended_at: nowIso,
    exit_code: 124,
    stderr_preview: event.stderr_preview || reason,
    summary: reason,
  };
}

export function resolveWorkerTaskClaim(input: {
  task: TaskRecord;
  worker: WorkerRecord;
  commands: CommandEventRecord[];
  runtime: WorkerRuntimeMetadata;
  now?: Date;
  leaseTtlMs?: number;
}): WorkerTaskClaimResult {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const activeCodexCommands = input.commands.filter(isActiveCodexCommand);
  const attemptId = runtimeAttemptId(input.runtime);
  const leaseOwner = optionalText(input.task.command_lease_owner);
  const leaseAttempt = optionalText(input.task.command_lease_attempt_id);

  if (!isRunnableTaskStatus(input.task.status)) {
    return {
      decision: "skipped_terminal_task",
      abandoned_commands: [],
      reason: `Task ${input.task.task_id} is ${input.task.status}.`,
    };
  }

  if (!isPollableWorkerStatus(input.worker.status)) {
    return {
      decision: "skipped_worker_status",
      abandoned_commands: [],
      reason: `Worker ${input.worker.worker_id} is ${input.worker.status}.`,
    };
  }

  if (leaseIsActive(input.task, nowMs)) {
    if (leaseOwner === input.worker.worker_id && leaseAttempt === attemptId) {
      return {
        decision: "already_running",
        abandoned_commands: [],
        reason: `Task ${input.task.task_id} is already claimed by this worker attempt.`,
      };
    }
    if (leaseOwner) {
      return {
        decision: "blocked_by_active_command",
        abandoned_commands: [],
        reason: `Task ${input.task.task_id} is claimed by worker ${leaseOwner}${leaseAttempt ? ` attempt ${leaseAttempt}` : ""}.`,
      };
    }
  }

  if (activeCodexCommands.length) {
    const sameWorkerCommands = activeCodexCommands.filter((event) => event.worker_id === input.worker.worker_id);
    const differentWorkerCommands = activeCodexCommands.filter((event) => event.worker_id !== input.worker.worker_id);
    if (differentWorkerCommands.length) {
      return {
        decision: "blocked_by_active_command",
        abandoned_commands: [],
        reason: `Task ${input.task.task_id} already has an active Codex command on another worker.`,
      };
    }
    const sameAttemptStillActive = sameWorkerCommands.some((event) => {
      const eventAttempt = commandAttemptId(event);
      return eventAttempt && attemptId && eventAttempt === attemptId;
    });
    if (sameAttemptStillActive) {
      return {
        decision: "already_running",
        abandoned_commands: [],
        reason: `Task ${input.task.task_id} already has an active Codex command for this worker attempt.`,
      };
    }
    return {
      decision: "claimed_after_abandoning_previous",
      lease_id: `lease_${randomUUID()}`,
      abandoned_commands: sameWorkerCommands.map((event) => markCommandAbandoned(event, now.toISOString())),
      reason: `Task ${input.task.task_id} had ${sameWorkerCommands.length} abandoned Codex command(s) from a previous worker attempt.`,
    };
  }

  return {
    decision: "claimed",
    lease_id: `lease_${randomUUID()}`,
    abandoned_commands: [],
    reason: `Task ${input.task.task_id} claimed for Codex execution.`,
  };
}

export function claimWorkerTaskInState(state: PersistedState, input: AtomicWorkerTaskClaimInput): AtomicWorkerTaskClaimResult {
  const worker = state.workers[input.worker_id] ?? null;
  if (!worker) {
    return {
      decision: "skipped_worker_status",
      abandoned_commands: [],
      reason: `Worker not found: ${input.worker_id}`,
      task: null,
      worker: null,
      error_code: "WORKER_NOT_FOUND",
    };
  }
  const task = state.tasks[input.task_id] ?? null;
  if (!task) {
    return {
      decision: "skipped_terminal_task",
      abandoned_commands: [],
      reason: `Task not found: ${input.task_id}`,
      task: null,
      worker: clone(worker),
      error_code: "TASK_NOT_FOUND",
    };
  }
  const graph = task.task_graph_id ? state.task_graphs[task.task_graph_id] : null;
  if (graph && ["completed", "failed", "cancelled"].includes(graph.status)) {
    return {
      decision: "skipped_terminal_task",
      abandoned_commands: [],
      reason: `Task graph ${graph.task_graph_id} is ${graph.status}; task ${input.task_id} will not be claimed.`,
      task: clone(task),
      worker: clone(worker),
    };
  }
  const graphNode = graph?.nodes.find((node) => node.task_id === input.task_id);
  if (graphNode && ["completed", "failed", "cancelled", "blocked"].includes(graphNode.status)) {
    return {
      decision: "skipped_terminal_task",
      abandoned_commands: [],
      reason: `Task graph node ${graphNode.node_id} is ${graphNode.status}; task ${input.task_id} will not be claimed.`,
      task: clone(task),
      worker: clone(worker),
    };
  }

  const now = input.now_iso ? new Date(input.now_iso) : new Date();
  const commands = Object.values(state.command_events).filter((event) => event.task_id === input.task_id);
  const decision = resolveWorkerTaskClaim({
    task,
    worker,
    commands,
    runtime: input.runtime,
    now,
    leaseTtlMs: input.lease_ttl_ms,
  });

  for (const abandoned of decision.abandoned_commands) {
    state.command_events[abandoned.event_id] = clone(abandoned);
  }

  if (decision.decision === "claimed" || decision.decision === "claimed_after_abandoning_previous") {
    const leaseId = decision.lease_id ?? `lease_${randomUUID()}`;
    task.status = "running";
    task.worker_id = worker.worker_id;
    task.in_flight_action = "codex_exec";
    task.command_lease_id = leaseId;
    task.command_lease_owner = worker.worker_id;
    task.command_lease_attempt_id =
      optionalText(input.runtime.run_attempt_id) ??
      optionalText(input.runtime.startup_attempt_id) ??
      optionalText(worker.run_attempt_id) ??
      optionalText(worker.startup_attempt_id) ??
      null;
    task.command_lease_acquired_at = now.toISOString();
    task.command_lease_expires_at = new Date(now.getTime() + input.lease_ttl_ms).toISOString();
    task.updated_at = now.toISOString();

    worker.status = "running";
    worker.task_id = task.task_id;
    worker.project_id = task.project_id;
  }

  return {
    ...decision,
    task: clone(task),
    worker: clone(worker),
  };
}
