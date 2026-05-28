import { randomUUID } from "node:crypto";
import { generateRunSummary } from "./summary.js";
import {
  appendOrchestratorEvent,
  getOrchestratorSettings,
  getRunSummary,
  getTask,
  getWorker,
  listCommandEvents,
  listOrchestratorEvents,
  listTasks,
  listWorkers,
  upsertTask,
} from "./store.js";
import { workerManagerFor } from "./workers.js";
import type { CommandEventRecord, TaskRecord, WorkerType } from "./types.js";

function normalizeGoal(goal: string) {
  return goal.trim().toLowerCase().replace(/\s+/g, " ");
}

function defaultPlan(goal: string) {
  return [
    `Understand the requested outcome: ${goal}`,
    "Resolve or create the project workspace.",
    "Assign an isolated worker.",
    "Run Codex/project commands through the worker path.",
    "Collect command events, changed files, tests, failures, and next steps.",
  ];
}

export class CloudOrchestrator {
  createTask(project_id: string, user_goal: string) {
    appendOrchestratorEvent({
      scope: "task",
      scope_id: project_id,
      type: "orchestrator.decision.started",
      message: `Planning task for project ${project_id}.`,
      data: { project_id, user_goal },
    });
    const now = new Date().toISOString();
    const task: TaskRecord = {
      task_id: `task_${randomUUID()}`,
      project_id,
      user_goal,
      normalized_goal: normalizeGoal(user_goal),
      status: "queued",
      plan: defaultPlan(user_goal),
      worker_id: null,
      codex_run_id: null,
      command_count: 0,
      latest_summary: "Task is queued.",
      next_steps: ["Assign a worker.", "Start command execution."],
      created_at: now,
      updated_at: now,
    };
    upsertTask(task);
    appendOrchestratorEvent({
      scope: "task",
      scope_id: task.task_id,
      type: "task.created",
      message: `Created task for project ${project_id}: ${user_goal}`,
      data: task,
    });
    appendOrchestratorEvent({
      scope: "task",
      scope_id: task.task_id,
      type: "task.planned",
      message: `Planned ${task.plan.length} steps for task ${task.task_id}.`,
      data: { plan: task.plan },
    });
    appendOrchestratorEvent({
      scope: "task",
      scope_id: task.task_id,
      type: "orchestrator.decision.completed",
      message: `Queued task ${task.task_id}.`,
      data: task,
    });
    return task;
  }

  async assignWorker(task_id: string, worker_type?: WorkerType, existingTask?: TaskRecord) {
    const task = existingTask ?? getTask(task_id);
    if (!task) throw new Error(`Task not found: ${task_id}`);
    const selectedWorkerType = worker_type ?? getOrchestratorSettings().default_worker_mode;
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: task.task_id,
      type: "worker.mode.selected",
      message: `Selected ${selectedWorkerType} worker mode for task ${task.task_id}.`,
      data: { task_id: task.task_id, worker_mode: selectedWorkerType },
    });
    const manager = workerManagerFor(selectedWorkerType);
    await manager.enforceWorkerLimits();
    const worker = await manager.createWorker(task.task_id, task.project_id, selectedWorkerType);
    await manager.assignTask(worker.worker_id, task.task_id);
    task.worker_id = worker.worker_id;
    task.status = "running";
    task.updated_at = new Date().toISOString();
    upsertTask(task);
    appendOrchestratorEvent({
      scope: "task",
      scope_id: task.task_id,
      type: "task.assigned",
      message: `Assigned task ${task.task_id} to worker ${worker.worker_id}.`,
      data: { task, worker },
    });
    return { task, worker: getWorker(worker.worker_id) ?? worker };
  }

  handleWorkerEvent(event: CommandEventRecord) {
    appendOrchestratorEvent({
      scope: "command",
      scope_id: event.event_id,
      type: event.exit_code === null ? "command.started" : event.exit_code === 0 ? "command.completed" : "command.failed",
      message: `${event.command}: ${event.summary}`,
      data: event,
    });
    const task = getTask(event.task_id);
    if (task) {
      task.command_count = listCommandEvents({ taskId: task.task_id }).length;
      task.updated_at = new Date().toISOString();
      upsertTask(task);
    }
  }

  completeTask(task_id: string, status: TaskRecord["status"], summary?: string) {
    const task = getTask(task_id);
    if (!task) return null;
    task.status = status;
    task.latest_summary = summary ?? task.latest_summary;
    task.updated_at = new Date().toISOString();
    upsertTask(task);
    const runSummary = generateRunSummary(task_id);
    appendOrchestratorEvent({
      scope: "task",
      scope_id: task.task_id,
      type: "summary.generated",
      message: runSummary.executive_summary,
      data: runSummary,
    });
    appendOrchestratorEvent({
      scope: "task",
      scope_id: task.task_id,
      type: status === "completed" ? "task.completed" : status === "failed" ? "task.failed" : "task.completed",
      message: `${task.task_id} is ${status}.`,
      data: task,
    });
    return { task, summary: runSummary };
  }

  status(task_id: string) {
    const task = getTask(task_id);
    if (!task) return null;
    return {
      task,
      worker: task.worker_id ? getWorker(task.worker_id) : null,
      commands: listCommandEvents({ taskId: task_id }),
      summary: getRunSummary(task_id),
      events: listOrchestratorEvents(task_id),
    };
  }

  listTasks(project_id?: string) {
    return listTasks(project_id);
  }

  listWorkers() {
    return listWorkers();
  }
}

export const cloudOrchestrator = new CloudOrchestrator();
