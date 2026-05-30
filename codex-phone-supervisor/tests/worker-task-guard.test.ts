import test from "node:test";
import assert from "node:assert/strict";
import {
  claimWorkerTaskInState,
  duplicateActiveCodexCommandMessage,
  findDuplicateActiveCodexCommand,
  isActiveCodexCommand,
  markCommandAbandoned,
  resolveWorkerTaskClaim,
  shouldPollWorkerForTask,
} from "../backend/src/worker-task-guard.js";
import type { CommandEventRecord, PersistedState, TaskGraphRecord, TaskRecord, WorkerRecord } from "../backend/src/types.js";

const now = new Date("2026-05-26T18:00:00.000Z");

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: "task_guard",
    project_id: "project_guard",
    user_goal: "Build a landing page.",
    normalized_goal: "build a landing page.",
    status: "running",
    plan: ["Run Codex."],
    worker_id: "worker_guard",
    codex_run_id: null,
    command_count: 0,
    latest_summary: "Task is running.",
    next_steps: ["Wait for Codex."],
    created_at: "2026-05-26T17:00:00.000Z",
    updated_at: "2026-05-26T17:00:00.000Z",
    ...overrides,
  };
}

function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    worker_id: "worker_guard",
    type: "docker_local",
    status: "running",
    image_uri: "head-developer-worker:local",
    project_id: "project_guard",
    task_id: "task_guard",
    heartbeat_at: "2026-05-26T17:59:00.000Z",
    created_at: "2026-05-26T17:00:00.000Z",
    expires_at: "2026-05-26T19:00:00.000Z",
    startup_attempt_id: "attempt_current",
    run_attempt_id: "attempt_current",
    ...overrides,
  };
}

function command(overrides: Partial<CommandEventRecord> = {}): CommandEventRecord {
  return {
    event_id: "cmd_guard",
    task_id: "task_guard",
    project_id: "project_guard",
    worker_id: "worker_guard",
    worker_mode: "docker_local",
    actual_image_uri: "head-developer-worker:local",
    startup_attempt_id: "attempt_current",
    run_attempt_id: "attempt_current",
    runtime_metadata_verified: true,
    command: "codex exec --json build",
    cwd: "/workspace/tea-shop",
    started_at: "2026-05-26T17:50:00.000Z",
    ended_at: null,
    exit_code: null,
    stdout_ref: null,
    stderr_ref: null,
    stdout_preview: "",
    stderr_preview: "",
    summary: "Command is running.",
    risk_level: "low",
    approved_by_user: false,
    created_at: "2026-05-26T17:50:00.000Z",
    ...overrides,
  };
}

test("worker poller skips workers whose linked task is completed, failed, or cancelled", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(shouldPollWorkerForTask(worker({ status: "idle" }), task({ status })), false);
  }
  assert.equal(shouldPollWorkerForTask(worker({ status: "idle" }), task({ status: "running" })), true);
});

test("worker claim does not start a second codex exec when one is already running for the same attempt", () => {
  const result = resolveWorkerTaskClaim({
    task: task({
      command_lease_id: "lease_guard",
      command_lease_owner: "worker_guard",
      command_lease_attempt_id: "attempt_current",
      command_lease_acquired_at: "2026-05-26T17:59:00.000Z",
      command_lease_expires_at: "2026-05-26T18:15:00.000Z",
      in_flight_action: "codex_exec",
    }),
    worker: worker(),
    commands: [command()],
    runtime: { startup_attempt_id: "attempt_current", run_attempt_id: "attempt_current" },
    now,
  });

  assert.equal(result.decision, "already_running");
  assert.equal(result.abandoned_commands.length, 0);
});

test("worker claim blocks a different worker attempt while the command lease is still active", () => {
  const result = resolveWorkerTaskClaim({
    task: task({
      command_lease_id: "lease_guard",
      command_lease_owner: "worker_guard",
      command_lease_attempt_id: "attempt_current",
      command_lease_acquired_at: "2026-05-26T17:59:00.000Z",
      command_lease_expires_at: "2026-05-26T18:15:00.000Z",
      in_flight_action: "codex_exec",
    }),
    worker: worker({ startup_attempt_id: "attempt_new", run_attempt_id: "attempt_new" }),
    commands: [],
    runtime: { startup_attempt_id: "attempt_new", run_attempt_id: "attempt_new" },
    now,
  });

  assert.equal(result.decision, "blocked_by_active_command");
  assert.equal(result.abandoned_commands.length, 0);
});

test("worker restart after an expired lease abandons prior command before a new claim", () => {
  const staleCommand = command({
    event_id: "cmd_old",
    startup_attempt_id: "attempt_old",
    run_attempt_id: "attempt_old",
  });
  const result = resolveWorkerTaskClaim({
    task: task({
      command_lease_id: "lease_old",
      command_lease_owner: "worker_guard",
      command_lease_attempt_id: "attempt_old",
      command_lease_acquired_at: "2026-05-26T17:40:00.000Z",
      command_lease_expires_at: "2026-05-26T17:55:00.000Z",
      in_flight_action: "codex_exec",
    }),
    worker: worker({ startup_attempt_id: "attempt_new", run_attempt_id: "attempt_new" }),
    commands: [staleCommand],
    runtime: { startup_attempt_id: "attempt_new", run_attempt_id: "attempt_new" },
    now,
  });

  assert.equal(result.decision, "claimed_after_abandoning_previous");
  assert.equal(result.abandoned_commands.length, 1);
  assert.equal(result.abandoned_commands[0]?.event_id, "cmd_old");
  assert.equal(result.abandoned_commands[0]?.exit_code, 124);
  assert.match(result.abandoned_commands[0]?.summary ?? "", /abandoned/i);

  const nextActiveCommand = command({ event_id: "cmd_new", startup_attempt_id: "attempt_new", run_attempt_id: "attempt_new" });
  const secondClaim = resolveWorkerTaskClaim({
    task: task({
      command_lease_id: result.lease_id,
      command_lease_owner: "worker_guard",
      command_lease_attempt_id: "attempt_new",
      command_lease_acquired_at: now.toISOString(),
      command_lease_expires_at: "2026-05-26T18:15:00.000Z",
      in_flight_action: "codex_exec",
    }),
    worker: worker({ startup_attempt_id: "attempt_new", run_attempt_id: "attempt_new" }),
    commands: [result.abandoned_commands[0]!, nextActiveCommand],
    runtime: { startup_attempt_id: "attempt_new", run_attempt_id: "attempt_new" },
    now,
  });
  assert.equal(secondClaim.decision, "already_running");
});

test("abandoned command is marked clearly if the process is gone", () => {
  const abandoned = markCommandAbandoned(command(), now.toISOString(), "Command abandoned because the worker process is gone.");
  assert.equal(abandoned.exit_code, 124);
  assert.equal(abandoned.ended_at, now.toISOString());
  assert.match(abandoned.summary, /abandoned/i);
  assert.match(abandoned.stderr_preview, /worker process is gone/i);
});

test("clean new task still claims normally", () => {
  const result = resolveWorkerTaskClaim({
    task: task({ status: "queued" }),
    worker: worker({ status: "idle" }),
    commands: [],
    runtime: { startup_attempt_id: "attempt_clean", run_attempt_id: "attempt_clean" },
    now,
  });

  assert.equal(result.decision, "claimed");
  assert.ok(result.lease_id?.startsWith("lease_"));
  assert.deepEqual(result.abandoned_commands, []);
});

test("worker claim skips tasks whose task graph is already terminal", () => {
  const guardedTask = task({
    task_graph_id: "task_graph_failed",
    task_graph_node_id: "node_failed",
    status: "queued",
  });
  const guardedWorker = worker({ status: "idle" });
  const graph: TaskGraphRecord = {
    task_graph_id: "task_graph_failed",
    project_id: "project_guard",
    root_user_goal: "Build app.",
    status: "failed",
    complexity: {
      complexity: "complex",
      reason: "test",
      should_split: true,
      recommended_worker_count: 2,
      parallelizable: true,
      approval_needed: false,
      suggested_subtasks: [],
      dependency_graph: [],
      risks: [],
    },
    nodes: [{
      node_id: "node_failed",
      task_id: guardedTask.task_id,
      title: "Queued stale node",
      goal: "Should not run.",
      assigned_worker_id: guardedWorker.worker_id,
      status: "queued",
      dependencies: [],
      outputs_expected: [],
      files_expected: [],
      required_app_files: [],
      allowed_doc_files: [],
      expected_user_visible_output: [],
      validation_commands: [],
      acceptance_checks: [],
      completion_criteria: [],
      output_contract: {
        required_app_files: [],
        allowed_doc_files: [],
        expected_user_visible_output: [],
        validation_commands: [],
        acceptance_checks: [],
        completion_criteria: [],
        docs_only_is_insufficient: false,
      },
      branch_name: null,
      worktree_path: null,
      completion_gate: null,
      summary: "Queued.",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }],
    edges: [],
    recommended_worker_count: 2,
    execution_strategy: "parallel_worktrees",
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const state = {
    sessions: {},
    projects: {},
    tasks: { [guardedTask.task_id]: guardedTask },
    workers: { [guardedWorker.worker_id]: guardedWorker },
    command_events: {},
    run_summaries: {},
    approval_requests: {},
    orchestrator_events: [],
    orchestrator_settings: {
      default_worker_mode: "docker_local",
      allow_worker_mode_switch: true,
      max_local_workers: 1,
      max_docker_local_workers: 2,
      max_gcp_vm_workers: 1,
      max_gke_job_workers: 1,
      updated_at: now.toISOString(),
    },
    mcp_tool_calls: {},
    operator_actions: {},
    task_graphs: { [graph.task_graph_id]: graph },
    worker_context_packets: {},
    worker_runtime_command_requests: {},
    project_artifacts: {},
  } satisfies PersistedState;

  const result = claimWorkerTaskInState(state, {
    worker_id: guardedWorker.worker_id,
    task_id: guardedTask.task_id,
    runtime: { startup_attempt_id: "attempt_terminal", run_attempt_id: "attempt_terminal" },
    now_iso: now.toISOString(),
    lease_ttl_ms: 15 * 60 * 1000,
  });

  assert.equal(result.decision, "skipped_terminal_task");
  assert.match(result.reason, /task graph .* failed/i);
  assert.equal(state.tasks[guardedTask.task_id]?.command_lease_id, undefined);
});

test("codex command detection only matches active codex exec records", () => {
  assert.equal(isActiveCodexCommand(command()), true);
  assert.equal(isActiveCodexCommand(command({ exit_code: 0, ended_at: now.toISOString() })), false);
  assert.equal(isActiveCodexCommand(command({ command: "node --check script.js" })), false);
});

test("duplicate active codex command detection blocks a second open codex exec for the same task", () => {
  const existing = command({ event_id: "cmd_existing", worker_id: "worker_one" });
  const candidate = command({ event_id: "cmd_candidate", worker_id: "worker_two" });
  const duplicate = findDuplicateActiveCodexCommand(candidate, [existing]);

  assert.equal(duplicate?.event_id, "cmd_existing");
  assert.match(duplicateActiveCodexCommandMessage(candidate, existing), /Refusing duplicate active codex exec/);
  assert.equal(findDuplicateActiveCodexCommand(candidate, [command({ task_id: "task_other" })]), null);
  assert.equal(findDuplicateActiveCodexCommand(command({ exit_code: 0, ended_at: now.toISOString() }), [existing]), null);
});
