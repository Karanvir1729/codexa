import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateTaskGraphNodeCompletion } from "../backend/src/completion-gate.js";
import type { CommandEventRecord, TaskGraphNode } from "../backend/src/types.js";

function command(overrides: Partial<CommandEventRecord> = {}): CommandEventRecord {
  const now = new Date().toISOString();
  return {
    event_id: "command_gate_test",
    task_id: "task_gate_test",
    project_id: "project_gate_test",
    worker_id: "worker_gate_test",
    command: "git status --short .",
    cwd: "/workspace/project",
    started_at: now,
    ended_at: now,
    exit_code: 0,
    stdout_ref: null,
    stderr_ref: null,
    stdout_preview: "",
    stderr_preview: "",
    summary: "",
    risk_level: "low",
    approved_by_user: false,
    created_at: now,
    ...overrides,
  };
}

function appNode(overrides: Partial<TaskGraphNode> = {}): TaskGraphNode {
  const now = new Date().toISOString();
  return {
    node_id: "node_app",
    task_id: "task_gate_test",
    title: "Landing and marketing pages",
    goal: "Build a visible landing page.",
    assigned_worker_id: null,
    status: "running",
    dependencies: [],
    outputs_expected: ["Visible landing page"],
    files_expected: ["index.html", "styles.css"],
    output_contract: {
      required_app_files: ["index.html", "styles.css"],
      allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md"],
      expected_user_visible_output: ["Visible landing page"],
      validation_commands: ["node --check"],
      acceptance_checks: ["App files exist"],
      completion_criteria: ["Docs-only output is insufficient"],
      docs_only_is_insufficient: true,
    },
    required_app_files: ["index.html", "styles.css"],
    allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md"],
    expected_user_visible_output: ["Visible landing page"],
    validation_commands: ["node --check"],
    acceptance_checks: ["App files exist"],
    completion_criteria: ["Docs-only output is insufficient"],
    completion_gate: null,
    branch_name: null,
    worktree_path: null,
    summary: "Running.",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

test("completion gate rejects docs-only output for app-building nodes", () => {
  const result = evaluateTaskGraphNodeCompletion({
    node: appNode(),
    commandEvents: [
      command({ summary: "created: .head-developer/WORKER_HANDOFFS.md" }),
      command({ event_id: "command_validation", command: "node --check script.js", summary: "Command completed successfully." }),
    ],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.docs_only, true);
  assert.match(result.reasons.join(" "), /docs-only output is insufficient/i);
  assert.deepEqual(result.app_files, []);
});

test("completion gate passes when required app files and validation are evidenced", () => {
  const result = evaluateTaskGraphNodeCompletion({
    node: appNode(),
    commandEvents: [
      command({ summary: "created: index.html\ncreated: styles.css\ncreated: .head-developer/WORKER_HANDOFFS.md" }),
      command({ event_id: "command_validation", command: "node --check script.js", summary: "Command completed successfully." }),
    ],
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(result.missing_required_app_files, []);
  assert.deepEqual(result.missing_validation_commands, []);
  assert.deepEqual(result.app_files, ["index.html", "styles.css"]);
});

test("completion gate ignores natural-language planner validation as command evidence", () => {
  const result = evaluateTaskGraphNodeCompletion({
    node: appNode({
      output_contract: {
        required_app_files: ["index.html", "styles.css"],
        allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md"],
        expected_user_visible_output: ["Visible landing page"],
        validation_commands: [
          "Verify that the nonce appears in index.html.",
          "Ensure the form fields are present.",
        ],
        acceptance_checks: ["Nonce and form fields are present."],
        completion_criteria: ["Docs-only output is insufficient"],
        docs_only_is_insufficient: true,
      },
      validation_commands: [
        "Verify that the nonce appears in index.html.",
        "Ensure the form fields are present.",
      ],
    }),
    commandEvents: [
      command({ summary: "created: index.html\ncreated: styles.css" }),
      command({ event_id: "command_validation", command: "node --check script.js", summary: "Command completed successfully." }),
    ],
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.missing_validation_commands, []);
});

test("completion gate accepts conditional validation command evidence", () => {
  const result = evaluateTaskGraphNodeCompletion({
    node: appNode({
      output_contract: {
        required_app_files: ["index.html", "script.js"],
        allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md"],
        expected_user_visible_output: ["Visible landing page"],
        validation_commands: ["node --check script.js when script.js exists"],
        acceptance_checks: ["JS validates when present."],
        completion_criteria: ["Docs-only output is insufficient"],
        docs_only_is_insufficient: true,
      },
      required_app_files: ["index.html", "script.js"],
      validation_commands: ["node --check script.js when script.js exists"],
    }),
    commandEvents: [
      command({ summary: "created: index.html\ncreated: script.js" }),
      command({ event_id: "command_validation", command: "node --check script.js", summary: "Command completed successfully." }),
    ],
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.validation_commands_run, ["node --check script.js"]);
});

test("completion gate does not require app output for documentation-only setup nodes", () => {
  const result = evaluateTaskGraphNodeCompletion({
    node: appNode({
      title: "Project Setup and Documentation",
      goal: "Set up the project structure, architecture docs, and language/runtime justification.",
      outputs_expected: ["Project documentation"],
      files_expected: ["README.md", "docs/architecture.md", "docs/language_runtime_justification.md"],
      output_contract: {
        required_app_files: ["README.md", "docs/architecture.md", "docs/language_runtime_justification.md"],
        allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md", ".head-developer/VALIDATION.md"],
        expected_user_visible_output: ["User-visible project setup and documentation"],
        validation_commands: [],
        acceptance_checks: ["Required files exist"],
        completion_criteria: ["Report incomplete work honestly with command evidence."],
        docs_only_is_insufficient: true,
      },
      required_app_files: ["README.md", "docs/architecture.md", "docs/language_runtime_justification.md"],
      expected_user_visible_output: ["User-visible project setup and documentation"],
      validation_commands: [],
    }),
    commandEvents: [
      command({
        summary: [
          "created: README.md",
          "created: docs/architecture.md",
          "created: docs/language_runtime_justification.md",
          "created: .head-developer/WORKER_HANDOFFS.md",
        ].join("\n"),
      }),
    ],
  });

  assert.equal(result.status, "not_applicable");
  assert.match(result.reasons.join(" "), /does not require app output/i);
  assert.deepEqual(result.app_files, []);
});

test("multi-worker graph does not complete when an app node only reports docs", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "completion-gate-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "completion-gate-root-"));
  const script = `
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR = ${JSON.stringify(storeDir)};
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = process.execPath;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS = "5000";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS = "25";
    process.env.CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES = "1";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE = "1";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR = "codex-phone-supervisor/frontend/dist";
    process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED = "0";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.SUPERVISOR_MODEL_PROVIDER = "vertex";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL = "deterministic";
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { multiWorkerCoordinator } = await import("./codex-phone-supervisor/backend/src/multi-worker-coordinator.ts");
    const { getTask, getTaskGraph, upsertCommandEvent, upsertTask, upsertTaskGraph } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const projectDir = path.join(${JSON.stringify(workspaceRoot)}, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const project = projectRecordForWorkspace(projectDir);
    upsertProject(project);
    const now = new Date().toISOString();
    const task = {
      task_id: "task_docs_only",
      project_id: project.project_id,
      user_goal: "Build the landing page.",
      normalized_goal: "build the landing page",
      status: "completed",
      plan: ["Build app files."],
      worker_id: "worker_docs_only",
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Worker claimed completion.",
      next_steps: ["Continue."],
      task_graph_id: "task_graph_docs_only",
      task_graph_node_id: "node_docs_only",
      created_at: now,
      updated_at: now
    };
    const node = {
      node_id: "node_docs_only",
      task_id: task.task_id,
      title: "Landing and marketing pages",
      goal: task.user_goal,
      assigned_worker_id: "worker_docs_only",
      status: "running",
      dependencies: [],
      outputs_expected: ["Visible landing page"],
      files_expected: ["index.html"],
      output_contract: {
        required_app_files: ["index.html"],
        allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md"],
        expected_user_visible_output: ["Visible landing page"],
        validation_commands: [],
        acceptance_checks: ["App files exist"],
        completion_criteria: ["Docs-only output is insufficient"],
        docs_only_is_insufficient: true
      },
      required_app_files: ["index.html"],
      allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md"],
      expected_user_visible_output: ["Visible landing page"],
      validation_commands: [],
      acceptance_checks: ["App files exist"],
      completion_criteria: ["Docs-only output is insufficient"],
      completion_gate: null,
      branch_name: null,
      worktree_path: project.workspace_path,
      summary: "Running.",
      created_at: now,
      updated_at: now
    };
    upsertTask(task);
    upsertTaskGraph({
      task_graph_id: "task_graph_docs_only",
      project_id: project.project_id,
      root_user_goal: "Build a landing page.",
      status: "running",
      complexity: {
        complexity: "simple",
        recommended_worker_count: 1,
        should_split: false,
        parallelizable: false,
        reason: "test",
        suggested_subtasks: [],
        dependency_graph: [],
        risks: [],
        approval_needed: false
      },
      nodes: [node],
      edges: [],
      recommended_worker_count: 1,
      execution_strategy: "single_worker",
      created_at: now,
      updated_at: now
    });
    upsertCommandEvent({
      event_id: "command_docs_only",
      task_id: task.task_id,
      project_id: project.project_id,
      worker_id: "worker_docs_only",
      command: "git status --short .",
      cwd: project.workspace_path,
      started_at: now,
      ended_at: now,
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: "created: .head-developer/WORKER_HANDOFFS.md",
      risk_level: "low",
      approved_by_user: false,
      created_at: now
    });
    const result = await multiWorkerCoordinator.advanceAfterTaskResult(task, "docker_local");
    const graph = getTaskGraph("task_graph_docs_only");
    const gatedTask = getTask(task.task_id);
    const repairNodes = graph.nodes.filter((node) => node.repair_task_for_node_id === "node_docs_only");
    console.log(JSON.stringify({
      graphStatus: graph.status,
      nodeStatus: graph.nodes[0].status,
      gateStatus: graph.nodes[0].completion_gate?.status,
      taskStatus: gatedTask.status,
      repairNodeCount: repairNodes.length,
      repairNodeStatus: repairNodes[0]?.status,
      summary: graph.nodes[0].summary,
      assignments: result.assignments.length
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    env: { ...process.env, CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.graphStatus, "review");
  assert.equal(payload.nodeStatus, "needs_repair");
  assert.equal(payload.gateStatus, "failed");
  assert.equal(payload.taskStatus, "failed");
  assert.equal(payload.repairNodeCount, 1);
  assert.equal(payload.repairNodeStatus, "queued");
  assert.equal(payload.assignments, 0);
  assert.match(String(payload.summary), /Completion gate failed/i);
});

test("repair node completion clears the original needs_repair node", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "completion-gate-repair-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "completion-gate-repair-root-"));
  const script = `
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR = ${JSON.stringify(storeDir)};
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = process.execPath;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS = "5000";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS = "25";
    process.env.CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES = "1";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE = "1";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR = "codex-phone-supervisor/frontend/dist";
    process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED = "0";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.SUPERVISOR_MODEL_PROVIDER = "vertex";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL = "deterministic";
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { multiWorkerCoordinator } = await import("./codex-phone-supervisor/backend/src/multi-worker-coordinator.ts");
    const { getTask, getTaskGraph, upsertCommandEvent, upsertTask, upsertTaskGraph } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const projectDir = path.join(${JSON.stringify(workspaceRoot)}, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const project = projectRecordForWorkspace(projectDir);
    upsertProject(project);
    const now = new Date().toISOString();
    const originalTask = {
      task_id: "task_original",
      project_id: project.project_id,
      user_goal: "Build the landing page.",
      normalized_goal: "build the landing page",
      status: "failed",
      plan: ["Build app files."],
      worker_id: "worker_original",
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Completion gate failed.",
      next_steps: ["Repair output."],
      task_graph_id: "task_graph_repair",
      task_graph_node_id: "node_original",
      created_at: now,
      updated_at: now
    };
    const repairTask = {
      ...originalTask,
      task_id: "task_repair",
      status: "completed",
      worker_id: "worker_repair",
      latest_summary: "Repair completed.",
      task_graph_node_id: "node_repair"
    };
    const contract = {
      required_app_files: ["index.html"],
      allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md"],
      expected_user_visible_output: ["Visible landing page"],
      validation_commands: [],
      acceptance_checks: ["App files exist"],
      completion_criteria: ["Docs-only output is insufficient"],
      docs_only_is_insufficient: true
    };
    const originalNode = {
      node_id: "node_original",
      task_id: originalTask.task_id,
      title: "Landing page",
      goal: originalTask.user_goal,
      assigned_worker_id: "worker_original",
      status: "needs_repair",
      dependencies: [],
      outputs_expected: ["Visible landing page"],
      files_expected: ["index.html"],
      output_contract: contract,
      required_app_files: ["index.html"],
      allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md"],
      expected_user_visible_output: ["Visible landing page"],
      validation_commands: [],
      acceptance_checks: ["App files exist"],
      completion_criteria: ["Docs-only output is insufficient"],
      completion_gate: null,
      branch_name: null,
      worktree_path: project.workspace_path,
      repair_task_for_node_id: "node_repair",
      summary: "Needs repair.",
      created_at: now,
      updated_at: now
    };
    const repairNode = {
      ...originalNode,
      node_id: "node_repair",
      task_id: repairTask.task_id,
      title: "Repair Landing page",
      goal: "Repair missing app output.",
      assigned_worker_id: "worker_repair",
      status: "running",
      repair_task_for_node_id: "node_original",
      summary: "Running repair."
    };
    upsertTask(originalTask);
    upsertTask(repairTask);
    upsertTaskGraph({
      task_graph_id: "task_graph_repair",
      project_id: project.project_id,
      root_user_goal: "Build a landing page.",
      status: "review",
      complexity: {
        complexity: "simple",
        recommended_worker_count: 1,
        should_split: false,
        parallelizable: false,
        reason: "test",
        suggested_subtasks: [],
        dependency_graph: [],
        risks: [],
        approval_needed: false
      },
      nodes: [originalNode, repairNode],
      edges: [{ from_node_id: "node_original", to_node_id: "node_repair", relationship: "reviews" }],
      recommended_worker_count: 1,
      execution_strategy: "single_worker",
      created_at: now,
      updated_at: now
    });
    upsertCommandEvent({
      event_id: "command_repair",
      task_id: repairTask.task_id,
      project_id: project.project_id,
      worker_id: "worker_repair",
      command: "git status --short .",
      cwd: project.workspace_path,
      started_at: now,
      ended_at: now,
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: "created: index.html",
      risk_level: "low",
      approved_by_user: false,
      created_at: now
    });
    await multiWorkerCoordinator.advanceAfterTaskResult(repairTask, "docker_local");
    const graph = getTaskGraph("task_graph_repair");
    console.log(JSON.stringify({
      graphStatus: graph.status,
      originalNodeStatus: graph.nodes.find((node) => node.node_id === "node_original")?.status,
      repairNodeStatus: graph.nodes.find((node) => node.node_id === "node_repair")?.status,
      originalTaskStatus: getTask("task_original")?.status,
      repairTaskStatus: getTask("task_repair")?.status
    }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    env: { ...process.env, CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.graphStatus, "completed");
  assert.equal(payload.originalNodeStatus, "completed");
  assert.equal(payload.repairNodeStatus, "completed");
  assert.equal(payload.originalTaskStatus, "completed");
  assert.equal(payload.repairTaskStatus, "completed");
});
