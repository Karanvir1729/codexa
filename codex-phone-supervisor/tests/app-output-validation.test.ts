import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateAppOutput } from "../backend/src/app-output-validation.js";
import type { CommandEventRecord, WorkerContextPacket } from "../backend/src/types.js";

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "app-output-validation-"));
}

function writeFile(root: string, relativePath: string, contents: string) {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function context(overrides: Partial<WorkerContextPacket["task_graph_node"]> = {}): WorkerContextPacket {
  const node = {
    node_id: "node_landing",
    task_id: "task_landing",
    title: "Landing and marketing pages",
    goal: "Build the public landing page and navigation shell.",
    assigned_worker_id: "worker_1",
    status: "running" as const,
    dependencies: [],
    outputs_expected: ["Landing page", "Navigation"],
    files_expected: ["index.html", "styles.css", "script.js"],
    required_app_files: ["index.html", "styles.css"],
    allowed_doc_files: [".head-developer/"],
    expected_user_visible_output: ["Landing page", "Navigation"],
    validation_commands: ["node --check"],
    acceptance_checks: ["index.html exists", "CSS is referenced", "JS validates when present"],
    completion_criteria: ["Non-documentation app files are created or changed."],
    output_contract: {
      required_app_files: ["index.html", "styles.css"],
      allowed_doc_files: [".head-developer/"],
      expected_user_visible_output: ["Landing page", "Navigation"],
      validation_commands: ["node --check"],
      acceptance_checks: ["index.html exists", "CSS is referenced", "JS validates when present"],
      completion_criteria: ["Non-documentation app files are created or changed."],
      docs_only_is_insufficient: true,
    },
    branch_name: null,
    worktree_path: null,
    completion_gate: null,
    summary: "Running.",
    created_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T00:00:00.000Z",
    ...overrides,
  };
  return {
    context_packet_id: "context_1",
    task_graph_id: "graph_1",
    node_id: node.node_id,
    task_id: node.task_id,
    project_id: "project_1",
    worker_id: "worker_1",
    project_brief: "Project brief",
    current_task_goal: node.goal,
    task_graph_node: node,
    dependencies_completed: [],
    relevant_docs: {},
    allowed_roots: [],
    branch_name: null,
    worktree_path: null,
    expected_files: node.files_expected,
    validation_commands: node.validation_commands,
    output_contract: node.output_contract,
    constraints: [],
    expected_output: node.outputs_expected,
    commands_allowed: [],
    validation_expectations: [],
    handoff_instructions: [],
    created_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T00:00:00.000Z",
  };
}

function commandEvent(command: string, exitCode: number, summary = "Command completed successfully."): CommandEventRecord {
  return {
    event_id: `event_${command.replace(/[^a-z0-9]+/gi, "_")}`,
    task_id: "task_landing",
    project_id: "project_1",
    worker_id: "worker_1",
    command,
    cwd: "/workspace",
    started_at: "2026-05-26T00:00:00.000Z",
    ended_at: "2026-05-26T00:00:01.000Z",
    exit_code: exitCode,
    stdout_ref: null,
    stderr_ref: null,
    stdout_preview: "",
    stderr_preview: "",
    summary,
    risk_level: "low",
    approved_by_user: false,
    created_at: "2026-05-26T00:00:00.000Z",
  };
}

test("app validation rejects docs-only output and weak ls/git status validation", () => {
  const root = tempWorkspace();
  writeFile(root, ".head-developer/WORKER_HANDOFFS.md", "# Handoff\nUpdated docs only.\n");
  const result = validateAppOutput({
    workspacePath: root,
    allFiles: [".head-developer/WORKER_HANDOFFS.md"],
    changedFiles: [".head-developer/WORKER_HANDOFFS.md"],
    taskGoal: "Build the public landing page and navigation shell.",
    context: context(),
    validationEvents: [commandEvent("ls -la", 0), commandEvent("git status --short .", 0)],
  });
  assert.equal(result.passed, false);
  assert.equal(result.docsOnlyOutput, true);
  assert.equal(result.weakValidationOnly, true);
  assert.match(result.summary, /docs-only|Weak validation|No HTML/i);
});

test("app validation accepts static HTML/CSS/JS with linked assets and node --check evidence", () => {
  const root = tempWorkspace();
  writeFile(root, "index.html", `<!doctype html>
    <html><head><link rel="stylesheet" href="styles.css"></head>
    <body><nav>Navigation</nav><main><section class="hero">Landing page</section></main><script src="script.js"></script></body></html>`);
  writeFile(root, "styles.css", ".hero { color: #123456; }\n");
  writeFile(root, "script.js", "function initLanding() { return document.querySelector('.hero'); }\ninitLanding();\n");
  const result = validateAppOutput({
    workspacePath: root,
    allFiles: ["index.html", "styles.css", "script.js"],
    changedFiles: ["index.html", "styles.css", "script.js"],
    taskGoal: "Build the public landing page and navigation shell.",
    context: context(),
    validationEvents: [commandEvent("node --check script.js", 0)],
  });
  assert.equal(result.passed, true);
  assert.equal(result.htmlFiles.includes("index.html"), true);
  assert.equal(result.cssFiles.includes("styles.css"), true);
  assert.equal(result.jsFiles.includes("script.js"), true);
  assert.deepEqual(result.missingAssetReferences, []);
  assert.deepEqual(result.missingJsChecks, []);
});

test("app validation resolves absolute asset refs inside public html", () => {
  const root = tempWorkspace();
  writeFile(root, "public/index.html", `<!doctype html>
    <html><head><link rel="stylesheet" href="/styles.css"></head>
    <body><main>Landing page</main><script src="/app.js"></script></body></html>`);
  writeFile(root, "public/styles.css", "body { color: #123456; }\n");
  writeFile(root, "public/app.js", "console.log('ready');\n");

  const result = validateAppOutput({
    workspacePath: root,
    allFiles: ["public/index.html", "public/styles.css", "public/app.js"],
    changedFiles: ["public/index.html", "public/styles.css", "public/app.js"],
    taskGoal: "Build frontend UI assets served from the public directory.",
    context: context({
      title: "Frontend Development",
      goal: "Build frontend UI assets served from public.",
      files_expected: ["public/index.html", "public/styles.css", "public/app.js"],
      required_app_files: ["public/index.html", "public/styles.css", "public/app.js"],
      validation_commands: ["node --check public/app.js"],
      output_contract: {
        required_app_files: ["public/index.html", "public/styles.css", "public/app.js"],
        allowed_doc_files: [".head-developer/"],
        expected_user_visible_output: ["Frontend UI"],
        validation_commands: ["node --check public/app.js"],
        acceptance_checks: ["Frontend files exist", "JS validates"],
        completion_criteria: ["Frontend files are created or changed."],
        docs_only_is_insufficient: true,
      },
    }),
    validationEvents: [commandEvent("node --check public/app.js", 0)],
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.missingAssetReferences, []);
});

test("app validation verifies multi-page static app pages and asset links", () => {
  const root = tempWorkspace();
  writeFile(root, "dashboard.html", `<link rel="stylesheet" href="styles/app.css"><h1>Dashboard</h1><a href="settings.html">Settings</a><script src="scripts/app.js"></script>`);
  writeFile(root, "settings.html", `<link rel="stylesheet" href="styles/app.css"><h1>Settings</h1><script src="scripts/app.js"></script>`);
  writeFile(root, "styles/app.css", "body { font-family: sans-serif; }\n");
  writeFile(root, "scripts/app.js", "const pages = ['dashboard', 'settings'];\nconsole.log(pages.join(','));\n");
  const result = validateAppOutput({
    workspacePath: root,
    allFiles: ["dashboard.html", "settings.html", "styles/app.css", "scripts/app.js"],
    changedFiles: ["dashboard.html", "settings.html", "styles/app.css", "scripts/app.js"],
    taskGoal: "Build dashboard layout and settings page.",
    context: context({
      title: "Dashboard and settings",
      goal: "Build dashboard layout, settings page, and core app navigation.",
      files_expected: ["dashboard", "settings"],
      required_app_files: ["dashboard", "settings"],
      outputs_expected: ["Dashboard", "Settings"],
      expected_user_visible_output: ["Dashboard", "Settings"],
      validation_commands: ["node --check"],
      output_contract: {
        required_app_files: ["dashboard", "settings"],
        allowed_doc_files: [".head-developer/"],
        expected_user_visible_output: ["Dashboard", "Settings"],
        validation_commands: ["node --check"],
        acceptance_checks: ["Dashboard files exist", "Settings files exist", "JS validates"],
        completion_criteria: ["Non-documentation dashboard/settings files are created or changed."],
        docs_only_is_insufficient: true,
      },
    }),
    validationEvents: [commandEvent("node --check scripts/app.js", 0)],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.requiredPages.sort(), ["dashboard", "settings"]);
  assert.deepEqual(result.missingRequiredPages, []);
});

test("app validation scopes required pages to the node output contract", () => {
  const root = tempWorkspace();
  writeFile(root, "index.html", `<!doctype html>
    <html><head><link rel="stylesheet" href="styles/public.css"></head>
    <body><main><section class="hero">Landing page</section><a href="login.html">Login</a></main><script src="scripts/public.js"></script></body></html>`);
  writeFile(root, "login.html", `<!doctype html>
    <html><head><link rel="stylesheet" href="styles/public.css"></head>
    <body><main><h1>Login</h1><form><input aria-label="Email"></form></main><script src="scripts/public.js"></script></body></html>`);
  writeFile(root, "styles/public.css", ".hero { color: #123456; }\n");
  writeFile(root, "scripts/public.js", "function initPublicShell() { return document.querySelector('.hero'); }\ninitPublicShell();\n");

  const result = validateAppOutput({
    workspacePath: root,
    allFiles: ["index.html", "login.html", "styles/public.css", "scripts/public.js"],
    changedFiles: ["index.html", "login.html", "styles/public.css", "scripts/public.js"],
    taskGoal: "Build the landing page and login page for the SaaS dashboard shell.",
    context: context({
      title: "Landing and login pages",
      goal: "Build landing and login pages for the static SaaS dashboard shell.",
      files_expected: ["index.html", "login.html", "styles/public.css", "scripts/public.js"],
      required_app_files: ["index.html", "login.html", "styles/public.css", "scripts/public.js"],
      outputs_expected: ["Landing page", "Login page"],
      expected_user_visible_output: ["Landing page", "Login page"],
      validation_commands: ["node --check scripts/public.js"],
      output_contract: {
        required_app_files: ["index.html", "login.html", "styles/public.css", "scripts/public.js"],
        allowed_doc_files: [".head-developer/"],
        expected_user_visible_output: ["Landing page", "Login page"],
        validation_commands: ["node --check scripts/public.js"],
        acceptance_checks: ["Landing page exists", "Login page exists", "JS validates"],
        completion_criteria: ["Non-documentation landing/login files are created or changed."],
        docs_only_is_insufficient: true,
      },
    }),
    validationEvents: [commandEvent("node --check scripts/public.js", 0)],
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.requiredPages.sort(), ["auth", "landing"]);
  assert.equal(result.missingRequiredPages.includes("dashboard"), false);
});

test("app validation accepts backend-only output contract without requiring HTML", () => {
  const root = tempWorkspace();
  writeFile(root, "server.js", "const http = require('node:http');\nhttp.createServer((_req, res) => res.end('ok'));\n");

  const result = validateAppOutput({
    workspacePath: root,
    allFiles: ["server.js"],
    changedFiles: ["server.js"],
    taskGoal: "Implement the Node.js backend server with JSON API endpoints for game logic.",
    context: context({
      title: "Backend Server Development",
      goal: "Implement the Node.js backend server with API endpoints for game logic.",
      files_expected: ["server.js"],
      required_app_files: ["server.js"],
      outputs_expected: ["Backend server"],
      expected_user_visible_output: ["Backend server"],
      validation_commands: ["node --check server.js"],
      output_contract: {
        required_app_files: ["server.js"],
        allowed_doc_files: [".head-developer/"],
        expected_user_visible_output: ["Backend server"],
        validation_commands: ["node --check server.js"],
        acceptance_checks: ["server.js exists", "JS validates"],
        completion_criteria: ["server.js is created or changed."],
        docs_only_is_insufficient: true,
      },
    }),
    validationEvents: [commandEvent("node --check server.js", 0)],
  });

  assert.equal(result.isAppNode, true);
  assert.equal(result.passed, true);
  assert.deepEqual(result.htmlFiles, []);
  assert.deepEqual(result.missingExpectedFiles, []);
  assert.deepEqual(result.missingJsChecks, []);
});

test("app validation accepts infrastructure-only docker output without requiring HTML", () => {
  const root = tempWorkspace();
  writeFile(root, "Dockerfile", "FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD [\"node\", \"server.js\"]\n");

  const result = validateAppOutput({
    workspacePath: root,
    allFiles: ["Dockerfile"],
    changedFiles: ["Dockerfile"],
    taskGoal: "Integrate the full-stack app with a Dockerfile that serves static assets from the backend.",
    context: context({
      title: "Integration and Dockerization",
      goal: "Create the Dockerfile for the integrated full-stack app.",
      files_expected: ["Dockerfile"],
      required_app_files: ["Dockerfile"],
      outputs_expected: ["Dockerfile"],
      expected_user_visible_output: ["Runnable container"],
      validation_commands: [],
      output_contract: {
        required_app_files: ["Dockerfile"],
        allowed_doc_files: [".head-developer/"],
        expected_user_visible_output: ["Runnable container"],
        validation_commands: [],
        acceptance_checks: ["Dockerfile exists"],
        completion_criteria: ["Dockerfile is created or changed."],
        docs_only_is_insufficient: true,
      },
    }),
    validationEvents: [],
  });

  assert.equal(result.isAppNode, true);
  assert.equal(result.passed, true);
  assert.deepEqual(result.htmlFiles, []);
  assert.deepEqual(result.missingExpectedFiles, []);
});
