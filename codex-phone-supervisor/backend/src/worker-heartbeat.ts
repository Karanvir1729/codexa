import type { TaskRecord, WorkerRecord } from "./types.js";

const ACTIVE_HEARTBEAT_TASK_STATUSES = new Set<TaskRecord["status"]>([
  "queued",
  "planning",
  "running",
  "waiting_for_approval",
]);

const HEARTBEAT_WORKER_STATUSES = new Set<WorkerRecord["status"]>([
  "starting",
  "assigned",
  "running",
]);

export function taskExpectsWorkerHeartbeat(task: TaskRecord | null | undefined) {
  return Boolean(task && ACTIVE_HEARTBEAT_TASK_STATUSES.has(task.status));
}

export function workerExpectsHeartbeat(worker: WorkerRecord | null | undefined, task: TaskRecord | null | undefined) {
  return Boolean(worker && taskExpectsWorkerHeartbeat(task) && HEARTBEAT_WORKER_STATUSES.has(worker.status));
}

export function workerHeartbeatIsStale(
  worker: WorkerRecord | null | undefined,
  task: TaskRecord | null | undefined,
  nowMs: number,
  staleHeartbeatMs: number,
) {
  if (!workerExpectsHeartbeat(worker, task) || !worker?.heartbeat_at) return false;
  const heartbeatMs = Date.parse(worker.heartbeat_at);
  return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs >= staleHeartbeatMs;
}
