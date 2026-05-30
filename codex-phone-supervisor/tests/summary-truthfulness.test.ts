import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptyPersistedState } from "../backend/src/state-store-common.js";
import type { CommandEventRecord, PersistedState, TaskGraphNode, TaskGraphRecord, TaskRecord, WorkerRecord } from "../backend/src/types.js";

process.env.HEAD_DEVELOPER_STATE_STORE = "memory";

function now() {
  return new Date().toISOString();
}

function baseState(): PersistedState {
  return emptyPersistedState({
    defaultWorkerMode: "docker_local",
    allowWorkerModeSwitch: true,
    maxLocalWorkers: 1,
    maxDockerLocalWorkers: 3,
    maxGcpVmWorkers: 10,
    maxGkeJobWorkers: 5,
  });
}

function projectState(workspacePath: string): Pick<PersistedState, "projects"> {
  const timestamp = now();
  return {
    projects: {
      project_summary_truth: {
        project_id: "project_summary_truth",
        display_name: "Summary Truthfulness Project",
        workspace_path: workspacePath,
        repo_name: null,
        git_branch: null,
        last_active_session_id: null,
        available_codex_adapter: "codex_cli",
        created_at: timestamp,
        updated_at: timestamp,
      },
    },
  };
}

function task(taskId: string, nodeId: string, worktreePath: string, userGoal: string): TaskRecord {
  const timestamp = now();
  return {
    task_id: taskId,
    project_id: "project_summary_truth",
    user_goal: userGoal,
    normalized_goal: userGoal.toLowerCase(),
    status: "completed",
    plan: ["Build files", "Validate output"],
    worker_id: `worker_${taskId}`,
    codex_run_id: null,
    command_count: 2,
    latest_summary: "Worker reported completion.",
    next_steps: ["Preview the generated app."],
    task_graph_id: "task_graph_summary_truth",
    task_graph_node_id: nodeId,
    worktree_path: worktreePath,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function worker(taskId: string): WorkerRecord {
  const timestamp = now();
  return {
    worker_id: `worker_${taskId}`,
    type: "docker_local",
    status: "idle",
    image_uri: "worker:test",
    project_id: "project_summary_truth",
    task_id: taskId,
    heartbeat_at: timestamp,
    created_at: timestamp,
    expires_at: timestamp,
  };
}

function command(eventId: string, taskId: string, commandText: string, summary: string, stdout = "", exitCode = 0): CommandEventRecord {
  const timestamp = now();
  return {
    event_id: eventId,
    task_id: taskId,
    project_id: "project_summary_truth",
    worker_id: `worker_${taskId}`,
    worker_mode: "docker_local",
    command: commandText,
    cwd: "/workspace",
    started_at: timestamp,
    ended_at: timestamp,
    exit_code: exitCode,
    stdout_ref: null,
    stderr_ref: null,
    stdout_preview: stdout,
    stderr_preview: "",
    summary,
    risk_level: "low",
    approved_by_user: false,
    created_at: timestamp,
  };
}

function graph(nodes: TaskGraphNode[]): TaskGraphRecord {
  const timestamp = now();
  return {
    task_graph_id: "task_graph_summary_truth",
    project_id: "project_summary_truth",
    root_user_goal: "Build a static SaaS dashboard shell.",
    status: "completed",
    complexity: {
      complexity: "complex",
      recommended_worker_count: 2,
      should_split: true,
      parallelizable: true,
      reason: "Test graph.",
      suggested_subtasks: [],
      dependency_graph: [],
      risks: [],
      approval_needed: false,
    },
    nodes,
    edges: [],
    recommended_worker_count: 2,
    execution_strategy: "parallel_worktrees",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function node(nodeId: string, taskId: string, title: string, filesExpected: string[]): TaskGraphNode {
  const timestamp = now();
  const requiredAppFiles = filesExpected.filter((file) => !file.startsWith(".head-developer/"));
  const allowedDocFiles = filesExpected.filter((file) => file.startsWith(".head-developer/"));
  return {
    node_id: nodeId,
    task_id: taskId,
    title,
    goal: `Build ${title}.`,
    assigned_worker_id: `worker_${taskId}`,
    status: "completed",
    dependencies: [],
    outputs_expected: ["Generated app files", "Validation command result"],
    files_expected: filesExpected,
    output_contract: {
      required_app_files: requiredAppFiles,
      allowed_doc_files: allowedDocFiles,
      expected_user_visible_output: ["User-visible static page output."],
      validation_commands: ["node --check script.js"],
      acceptance_checks: ["Generated app files exist."],
      completion_criteria: ["Docs-only output is not sufficient for app-building nodes."],
      docs_only_is_insufficient: true,
    },
    required_app_files: requiredAppFiles,
    allowed_doc_files: allowedDocFiles,
    expected_user_visible_output: ["User-visible static page output."],
    validation_commands: ["node --check script.js"],
    acceptance_checks: ["Generated app files exist."],
    completion_criteria: ["Docs-only output is not sufficient for app-building nodes."],
    completion_gate: null,
    branch_name: null,
    worktree_path: null,
    summary: "Worker reported completion.",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

test("completed app node with docs-only output is summarized as incomplete", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "summary-docs-only-"));
  fs.mkdirSync(path.join(workspace, ".head-developer"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".head-developer", "WORKER_HANDOFFS.md"), "# Handoff\n");
  const taskId = "task_docs_only_app";
  const nodeId = "node_landing";
  const state = baseState();
  Object.assign(state, projectState(workspace));
  state.tasks[taskId] = task(taskId, nodeId, workspace, "Build the public landing page.");
  state.workers[`worker_${taskId}`] = worker(taskId);
  state.task_graphs.task_graph_summary_truth = graph([node(nodeId, taskId, "Landing and marketing pages", ["index.html", "styles.css", "script.js"])]);
  state.command_events.codex_docs_only = command("codex_docs_only", taskId, "codex exec --json", "Command completed successfully.");
  state.command_events.status_docs_only = command("status_docs_only", taskId, "git status --short .", "created: .head-developer/WORKER_HANDOFFS.md");

  const { writeStore } = await import("../backend/src/store.js");
  const { generateRunSummary, assessTaskCompletionForSummary } = await import("../backend/src/summary.js");
  writeStore(state);

  const assessment = assessTaskCompletionForSummary(taskId);
  const summary = generateRunSummary(taskId);
  assert.equal(assessment.status, "incomplete");
  assert.equal(assessment.docs_only, true);
  assert.match(summary.executive_summary, /^Task incomplete:/);
  assert.match(summary.technical_summary, /Completion gate: incomplete/);
  assert.match(summary.technical_summary, /Only documentation files were observed/);
  assert.equal(summary.current_state, "incomplete");
  assert.ok(summary.failures.some((item) => item.includes("Only documentation files")));
});

test("completed app node with real source files is summarized as completed app output", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "summary-app-files-"));
  fs.writeFileSync(path.join(workspace, "index.html"), "<main>Dashboard shell</main>");
  fs.writeFileSync(path.join(workspace, "styles.css"), ":root { --accent: #0f766e; }");
  fs.writeFileSync(path.join(workspace, "script.js"), "console.log('dashboard');\n");
  const taskId = "task_real_app_files";
  const nodeId = "node_dashboard";
  const state = baseState();
  Object.assign(state, projectState(workspace));
  state.tasks[taskId] = task(taskId, nodeId, workspace, "Build dashboard and settings pages.");
  state.workers[`worker_${taskId}`] = worker(taskId);
  state.task_graphs.task_graph_summary_truth = graph([node(nodeId, taskId, "Dashboard and settings", ["index.html", "styles.css", "script.js"])]);
  state.command_events.codex_app = command("codex_app", taskId, "codex exec --json", "Command completed successfully.");
  state.command_events.status_app = command("status_app", taskId, "git status --short .", "created: index.html\ncreated: styles.css\ncreated: script.js");
  state.command_events.validation_app = command("validation_app", taskId, "node --check script.js", "Command completed successfully.");

  const { writeStore } = await import("../backend/src/store.js");
  const { generateRunSummary, assessTaskCompletionForSummary } = await import("../backend/src/summary.js");
  writeStore(state);

  const assessment = assessTaskCompletionForSummary(taskId);
  const summary = generateRunSummary(taskId);
  assert.equal(assessment.status, "complete");
  assert.equal(summary.current_state, "completed");
  assert.match(summary.technical_summary, /Completion gate: app output observed/);
  assert.deepEqual(summary.tests_run, ["node --check script.js"]);
  assert.doesNotMatch(summary.executive_summary, /^Task incomplete:/);
});

test("task graph truthfulness summary separates app completion from docs-only output", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "summary-graph-"));
  const completeWorktree = path.join(workspace, "complete");
  const docsOnlyWorktree = path.join(workspace, "docs-only");
  fs.mkdirSync(completeWorktree, { recursive: true });
  fs.mkdirSync(path.join(docsOnlyWorktree, ".head-developer"), { recursive: true });
  fs.writeFileSync(path.join(completeWorktree, "index.html"), "<main>Landing</main>");
  fs.writeFileSync(path.join(docsOnlyWorktree, ".head-developer", "WORKER_HANDOFFS.md"), "# Docs only\n");
  const completeTask = "task_complete_app_node";
  const docsOnlyTask = "task_docs_only_node";
  const setupTask = "task_setup_docs_node";
  const state = baseState();
  Object.assign(state, projectState(workspace));
  state.tasks[completeTask] = task(completeTask, "node_complete", completeWorktree, "Build landing page.");
  state.tasks[docsOnlyTask] = task(docsOnlyTask, "node_docs_only", docsOnlyWorktree, "Build billing page.");
  state.tasks[setupTask] = task(setupTask, "node_setup", workspace, "Create shared docs.");
  state.workers[`worker_${completeTask}`] = worker(completeTask);
  state.workers[`worker_${docsOnlyTask}`] = worker(docsOnlyTask);
  state.workers[`worker_${setupTask}`] = worker(setupTask);
  state.task_graphs.task_graph_summary_truth = graph([
    { ...node("node_setup", setupTask, "Project setup and shared docs", [".head-developer/PROJECT_BRIEF.md"]), outputs_expected: ["Shared docs initialized"] },
    node("node_complete", completeTask, "Landing and marketing pages", ["index.html"]),
    node("node_docs_only", docsOnlyTask, "Billing surface", ["billing", "pricing"]),
  ]);
  state.command_events.complete_status = command("complete_status", completeTask, "git status --short .", "created: index.html");
  state.command_events.docs_status = command("docs_status", docsOnlyTask, "git status --short .", "created: .head-developer/WORKER_HANDOFFS.md");
  state.command_events.setup_status = command("setup_status", setupTask, "git status --short .", "created: .head-developer/PROJECT_BRIEF.md");

  const { writeStore } = await import("../backend/src/store.js");
  const { generateTaskGraphTruthfulnessSummary } = await import("../backend/src/summary.js");
  writeStore(state);

  const summary = generateTaskGraphTruthfulnessSummary("task_graph_summary_truth");
  assert.equal(summary?.status, "incomplete");
  assert.deepEqual(summary?.completed_app_nodes, ["node_complete"]);
  assert.deepEqual(summary?.incomplete_app_nodes, ["node_docs_only"]);
  assert.deepEqual(summary?.docs_only_nodes, ["node_docs_only"]);
  assert.match(summary?.summary ?? "", /Completed app nodes: Landing and marketing pages/);
  assert.match(summary?.summary ?? "", /Incomplete app nodes: Billing surface/);
  assert.match(summary?.summary ?? "", /Documentation\/review nodes: Project setup and shared docs/);
});
