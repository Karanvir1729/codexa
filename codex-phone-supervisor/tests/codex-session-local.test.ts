import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function bootstrapEnv(storeDir: string, workspaceRoot: string, codexHome: string) {
  return `
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = "codex";
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = ${JSON.stringify(codexHome)};
    process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR = ${JSON.stringify(storeDir)};
    process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR = "codex-phone-supervisor/frontend/dist";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS = "5000";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS = "25";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE = "1";
    process.env.CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL = "";
    process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED = "0";
    process.env.SUPERVISOR_MODEL_PROVIDER = "codex_cli";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL = "deterministic";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.WORKER_MODE = "codex_session_local";
    process.env.DEFAULT_WORKER_MODE = "codex_session_local";
    process.env.HEAD_DEVELOPER_STATE_STORE = "file";
  `;
}

function runIsolated(script: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv, CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
}

test("codex_session_local prompt names Codex as the direct CLI orchestrator", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-prompt-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "chai-shop");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    const { projectRecordForWorkspace } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { buildLocalCodexImplementationPrompt } = await import("./codex-phone-supervisor/backend/src/codex-session-local.ts");
    const { getOrchestratorSettings, stateStoreKind } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    const prompt = buildLocalCodexImplementationPrompt({ userGoal: "Build a landing page for a chai shop.", project });
    console.log(JSON.stringify({
      defaultMode: getOrchestratorSettings().default_worker_mode,
      storeKind: stateStoreKind(),
      hasCodexOrchestrator: /You are Codex, the local orchestrator/.test(prompt),
      hasDirectCli: /talking to you directly through this CLI-backed session/.test(prompt),
      letsCodexChoose: /You choose how many logical subagents/.test(prompt),
      allowsPlugins: /tools, skills, plugins, and MCP servers available in this same local account/.test(prompt),
      hasFullAccess: /You have full local CLI access/.test(prompt),
      hasImprovementLoop: /Continuous improvement is part of your role/.test(prompt) && /\\.head-developer\\/IMPROVEMENTS\\.md/.test(prompt),
      preventsScopeCreep: /Do not silently expand scope/.test(prompt) && /without user approval/.test(prompt),
      blocksExternal: /Do not create disconnected workspaces/.test(prompt) && /GKE/.test(prompt) && /Firestore/.test(prompt)
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.defaultMode, "codex_session_local");
  assert.equal(payload.storeKind, "file");
  assert.equal(payload.hasCodexOrchestrator, true);
  assert.equal(payload.hasDirectCli, true);
  assert.equal(payload.letsCodexChoose, true);
  assert.equal(payload.allowsPlugins, true);
  assert.equal(payload.hasFullAccess, true);
  assert.equal(payload.hasImprovementLoop, true);
  assert.equal(payload.preventsScopeCreep, true);
  assert.equal(payload.blocksExternal, true);
});

test("codex_session_local invokes Codex with same-account full access settings", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "codex-session-local.ts"), "utf8");
  const configSource = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "config.ts"), "utf8");
  assert.match(configSource, /CODEX_PHONE_SUPERVISOR_CODEX_MODEL/);
  assert.match(configSource, /"gpt-5\.5"/);
  assert.match(configSource, /CODEX_PHONE_SUPERVISOR_CODEX_PROFILE/);
  assert.match(configSource, /CODEX_PHONE_SUPERVISOR_CODEX_PROFILE_V2/);
  assert.match(configSource, /CODEX_PHONE_SUPERVISOR_CODEX_SANDBOX/);
  assert.match(configSource, /"danger-full-access"/);
  assert.match(configSource, /CODEX_PHONE_SUPERVISOR_CODEX_BYPASS_APPROVALS_AND_SANDBOX/);
  assert.match(source, /CODEX_HOME: config\.codexHome/);
  assert.match(source, /"--model", config\.localCodex\.model/);
  assert.match(source, /"--profile", config\.localCodex\.profile/);
  assert.match(source, /"--profile-v2", config\.localCodex\.profileV2/);
  assert.match(source, /shell_environment_policy\.inherit=all/);
  assert.match(source, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(source, /config\.localCodex\.sandbox === "danger-full-access"/);
  assert.match(source, /plugins_source: "same CODEX_HOME and user Codex config"/);
  assert.match(source, /IMPROVEMENTS\.md/);
  assert.match(source, /Bugs Found/);
  assert.match(source, /Feature Ideas/);
  assert.match(source, /Needs User Decision/);
});

test("codex_session_local pipes real Codex CLI stdout and stderr into session events", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "codex-session-local.ts"), "utf8");
  assert.match(source, /child\.stdout\.on\("data"/);
  assert.match(source, /child\.stderr\.on\("data"/);
  assert.match(source, /local_codex_session\.stdout/);
  assert.match(source, /local_codex_session\.stderr/);
  assert.match(source, /piped_from: "codex_cli"/);
});

test("flowchart maker is a separate read-only Codex session capped at five seconds", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "codex-session-local.ts"), "utf8");
  const flowchartSource = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "flowchart.ts"), "utf8");
  assert.match(source, /const FLOWCHART_MAKER_TIMEOUT_MS = 5_000/);
  assert.match(source, /const FLOWCHART_WATCHER_INTERVAL_MS = 2_000/);
  assert.match(source, /local_codex_flowchart\.started/);
  assert.match(source, /local_codex_flowchart\.watcher\.started/);
  assert.match(source, /local_codex_flowchart\.watcher\.tick/);
  assert.match(source, /local_codex_flowchart\.watcher\.stopped/);
  assert.match(source, /startFlowchartWatcher/);
  assert.match(source, /stopFlowchartWatcher/);
  assert.match(source, /workspaceActivitySummary/);
  assert.match(source, /continuous parallel Codex flowchart watcher/);
  assert.match(source, /writeHeadDeveloperFlowchartJson/);
  assert.match(source, /"flowchart\.json"/);
  assert.match(source, /generator: "parallel_codex_flowchart_session"/);
  assert.match(source, /Codex flowchart summary timed out after 5 seconds/);
  assert.match(source, /"exec"[\s\S]*"--output-schema"[\s\S]*"-s"[\s\S]*"read-only"/);
  assert.match(source, /findVerifiedCodexRollout/);
  assert.match(source, /extractRolloutAgentText/);
  assert.match(source, /syncLiveCodexRollout/);
  assert.match(source, /setInterval\(\(\) => \{/);
  assert.match(source, /force: true/);
  assert.match(source, /implementation_stream_summary/);
  assert.match(source, /reported_subagents/);
  assert.match(source, /latest_workspace_activity/);
  assert.match(source, /scheduleFlowchartSummaryUpdate\(\{\s*taskId: input\.task\.task_id/);
  assert.doesNotMatch(source, /updateLiveSubagentsFromCodexText/);
  assert.doesNotMatch(source, /liveSubagentBuffers/);
  assert.doesNotMatch(source, /line\.match\(\/SUBAGENT UPDATE/);
  assert.match(flowchartSource, /codex_flow_pending:/);
  assert.match(flowchartSource, /codex_flowchart_json_path/);
  assert.match(flowchartSource, /readLocalCodexFlowchartJson/);
  assert.match(flowchartSource, /live Codex updates/);
  assert.match(flowchartSource, /!summary\.nodes\.some\(\(node\) => node\.kind === "subagent"\)/);
  assert.match(flowchartSource, /parallel Codex flowchart/);
  assert.doesNotMatch(flowchartSource, /label: "Files Changed"/);
  assert.doesNotMatch(flowchartSource, /changed_files\.length\} files/);
});

test("continuous flowchart watcher writes live JSON while Codex is still running", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-flowchart-watcher-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "chai-shop");
  const codexHome = path.join(root, "codex-home");
  const fakeCodexPath = path.join(root, "fake-codex.cjs");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.on("data", () => undefined);
function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}
const finalPath = arg("--output-last-message");
const cwd = arg("-C") || process.cwd();
function writeJson(value) {
  if (finalPath) fs.writeFileSync(finalPath, JSON.stringify(value));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } }));
}
if (finalPath.includes("flowchart-summary")) {
  writeJson({
    title: "Live Codex flowchart",
    overview: "Flowchart watcher updated while implementation was still running.",
    nodes: [
      { id: "request", kind: "user_request", label: "User request", status: "received", summary: "Build a tiny chai page.", depends_on: [] },
      { id: "codex-session", kind: "codex_session", label: "Codex session", status: "running", summary: "One local Codex session is making changes.", depends_on: ["request"] },
      { id: "page-builder", kind: "subagent", label: "Page Builder", status: "running", summary: "Creating the page experience.", depends_on: ["codex-session"] },
      { id: "validation", kind: "validation", label: "Validation", status: "waiting", summary: "Validation waits for implementation output.", depends_on: ["page-builder"] }
    ],
    edges: [
      { from: "request", to: "codex-session", label: "next" },
      { from: "codex-session", to: "page-builder", label: "subagent" },
      { from: "page-builder", to: "validation", label: "next" }
    ]
  });
  process.exit(0);
}
setTimeout(() => {
  fs.writeFileSync(path.join(cwd, "index.html"), "<!doctype html><html><head><script src=\\"script.js\\"></script></head><body>Chai</body></html>");
  fs.writeFileSync(path.join(cwd, "script.js"), "console.log('chai');\\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# Chai Shop\\n\\nSubagent Breakdown\\n");
  writeJson({
    summary: "Built a tiny chai shop page.",
    status: "completed",
    final_summary: "Built and validated the chai shop page.",
    files_changed: ["index.html", "script.js", "README.md"],
    required_files: ["index.html", "script.js", "README.md"],
    validation_commands: ["node --check script.js"],
    docs_updated: true,
    preview_entry: "index.html",
    subagents: [
      { name: "Page Builder", responsibility: "Create the page.", status: "completed", changed_files: ["index.html", "script.js"], validation: ["node --check script.js"], summary: "Page is complete." },
      { name: "Docs Writer", responsibility: "Document usage.", status: "completed", changed_files: ["README.md"], validation: ["README updated"], summary: "Docs are complete." }
    ],
    flowchart_summary: null,
    errors: []
  });
}, 7000);
`);
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
    const fs = await import("node:fs");
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { upsertSession, getTask, listOrchestratorEvents, listWorkers } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { startLocalCodexSession } = await import("./codex-phone-supervisor/backend/src/codex-session-local.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("Build a tiny chai shop page.", project.workspace_path);
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    upsertSession(session);
    const started = startLocalCodexSession({ session, project, userGoal: "Build a tiny chai shop page with README and validation." });
    await new Promise((resolve) => setTimeout(resolve, 4500));
    const midTask = getTask(started.task.task_id);
    const midEvents = listOrchestratorEvents(started.task.task_id).map((event) => event.type);
    const midFlowchartExists = Boolean(midTask?.codex_flowchart_json_path && fs.existsSync(midTask.codex_flowchart_json_path));
    const deadline = Date.now() + 20000;
    let task = getTask(started.task.task_id);
    while (Date.now() < deadline && task && task.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 500));
      task = getTask(started.task.task_id);
    }
    const finalEvents = listOrchestratorEvents(started.task.task_id).map((event) => event.type);
    console.log(JSON.stringify({
      midTaskStatus: midTask?.status ?? null,
      midFlowchartExists,
      watcherStarted: midEvents.includes("local_codex_flowchart.watcher.started"),
      watcherTicked: midEvents.includes("local_codex_flowchart.watcher.tick"),
      watcherUpdated: midEvents.includes("local_codex_flowchart.updated"),
      watcherStopped: finalEvents.includes("local_codex_flowchart.watcher.stopped"),
      finalStatus: task?.status ?? null,
      workerCount: listWorkers().length
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
    midTaskStatus?: string | null;
    midFlowchartExists?: boolean;
    watcherStarted?: boolean;
    watcherTicked?: boolean;
    watcherUpdated?: boolean;
    watcherStopped?: boolean;
    finalStatus?: string | null;
    workerCount?: number;
  };
  assert.equal(payload.midTaskStatus, "running");
  assert.equal(payload.midFlowchartExists, true);
  assert.equal(payload.watcherStarted, true);
  assert.equal(payload.watcherTicked, true);
  assert.equal(payload.watcherUpdated, true);
  assert.equal(payload.watcherStopped, true);
  assert.equal(payload.finalStatus, "completed");
  assert.equal(payload.workerCount, 0);
});

test("flowchart renders Codex-chosen logical subagents without external workers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-flowchart-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "wordle-app");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { upsertSession, upsertTask, upsertCommandEvent, listWorkers } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");
    const fs = await import("node:fs");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("Build Wordle.", project.workspace_path);
    session.session_id = "session_flowchart_local_codex";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    upsertSession(session);
    const now = new Date().toISOString();
    const task = {
      task_id: "task_local_codex_flowchart",
      project_id: project.project_id,
      user_goal: "Build a full-stack Wordle app.",
      normalized_goal: "build a full-stack wordle app.",
      status: "completed",
      plan: ["One local Codex CLI orchestrator session."],
      worker_id: null,
      codex_run_id: null,
      command_count: 2,
      latest_summary: "Built by one local Codex orchestrator session.",
      next_steps: ["Review preview."],
      execution_backend: "codex_session_local",
      local_state_path: ${JSON.stringify(path.join(projectDir, ".head-developer", "state.json"))},
      codex_session_id: "real-or-recorded-codex-session-id",
      codex_resume_command: "codex exec resume real-or-recorded-codex-session-id",
      codex_prompt_excerpt: "You are Codex, the local orchestrator.",
      codex_flowchart_summary: {
        title: "Wordle build flow",
        overview: "One local Codex session coordinated the Wordle build with Codex-chosen subagents.",
        nodes: [
          { id: "request", kind: "user_request", label: "User request", status: "received", summary: "Build a full-stack Wordle app.", depends_on: [] },
          { id: "requirements", kind: "requirement_summary", label: "Requirements", status: "approved", summary: "Frontend, backend, shared rules, tests, README, validation, and preview.", depends_on: ["request"] },
          { id: "plan", kind: "plan", label: "Codex plan", status: "approved", summary: "Codex selected the internal responsibilities for one local session.", depends_on: ["requirements"] },
          { id: "codex-session", kind: "codex_session", label: "Codex CLI session", status: "completed", summary: "One local Codex CLI session owned the repo.", depends_on: ["plan"] },
          { id: "rules-agent", kind: "subagent", label: "Rules Agent", status: "completed", summary: "Created the shared game rules.", depends_on: ["codex-session"] },
          { id: "api-agent", kind: "subagent", label: "API Agent", status: "completed", summary: "Connected the backend API.", depends_on: ["codex-session"] },
          { id: "interface-agent", kind: "subagent", label: "Interface Agent", status: "completed", summary: "Built the browser play surface.", depends_on: ["codex-session"] },
          { id: "validation", kind: "validation", label: "Validation", status: "passed", summary: "Local validation passed.", depends_on: ["rules-agent", "api-agent", "interface-agent"] },
          { id: "preview", kind: "preview", label: "Preview", status: "loaded", summary: "Local preview loaded.", depends_on: ["validation"] },
          { id: "final", kind: "final_summary", label: "Final summary", status: "completed", summary: "Wordle build completed with local validation.", depends_on: ["preview"] }
        ],
        edges: [
          { from: "request", to: "requirements", label: "next" },
          { from: "requirements", to: "plan", label: "next" },
          { from: "plan", to: "codex-session", label: "next" },
          { from: "codex-session", to: "rules-agent", label: "subagent" },
          { from: "codex-session", to: "api-agent", label: "subagent" },
          { from: "codex-session", to: "interface-agent", label: "subagent" },
          { from: "rules-agent", to: "validation", label: "validated" },
          { from: "api-agent", to: "validation", label: "validated" },
          { from: "interface-agent", to: "validation", label: "validated" },
          { from: "validation", to: "preview", label: "next" },
          { from: "preview", to: "final", label: "next" }
        ]
      },
      codex_subagents: [
        { name: "Shared logic", responsibility: "Game rules.", status: "completed", changed_files: ["shared/game.js"], validation: ["npm test"], summary: "Scoring implemented." },
        { name: "Backend API", responsibility: "HTTP API.", status: "completed", changed_files: ["server.js"], validation: ["npm run typecheck"], summary: "API implemented." },
        { name: "Frontend UI", responsibility: "Browser UI.", status: "completed", changed_files: ["public/index.html", "public/app.js"], validation: ["npm run build"], summary: "UI implemented." }
      ],
      local_validation_result: {
        status: "passed",
        validated_at: now,
        required_files_exist: true,
        docs_updated: true,
        docs_only_success_rejected: false,
        preview_loaded: true,
        files_changed: ["shared/game.js", "server.js", "public/index.html", "public/app.js", "README.md"],
        app_files: ["shared/game.js", "server.js", "public/index.html", "public/app.js"],
        documentation_files: ["README.md"],
        commands: [{ command: "npm test", status: "passed", exit_code: 0, summary: "tests passed" }],
        failures: [],
        warnings: [],
        summary: "Local validation passed."
      },
      files_changed: ["shared/game.js", "server.js", "public/index.html", "public/app.js", "README.md"],
      final_summary: "Subagent breakdown: Shared logic | Backend API | Frontend UI. Validation passed.",
      created_at: now,
      updated_at: now
    };
    const flowchartJsonPath = ${JSON.stringify(path.join(projectDir, ".head-developer", "flowchart.json"))};
    fs.mkdirSync(${JSON.stringify(path.join(projectDir, ".head-developer"))}, { recursive: true });
    fs.writeFileSync(flowchartJsonPath, JSON.stringify({
      schema_version: 1,
      generated_at: now,
      generator: "parallel_codex_flowchart_session",
      flowchart: task.codex_flowchart_summary
    }, null, 2));
    task.codex_flowchart_json_path = flowchartJsonPath;
    task.codex_flowchart_summary = null;
    upsertTask(task);
    upsertCommandEvent({
      event_id: "cmd_local_codex_exec",
      task_id: task.task_id,
      project_id: project.project_id,
      worker_id: "codex_session_local",
      worker_mode: "codex_session_local",
      codex_session_id: "real-or-recorded-codex-session-id",
      codex_history_kind: "exec",
      codex_prompt_excerpt: "You are Codex, the local orchestrator.",
      command: "codex exec --json [prompt omitted]",
      cwd: project.workspace_path,
      started_at: now,
      ended_at: now,
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: "Local Codex CLI orchestrator completed.",
      risk_level: "low",
      approved_by_user: false,
      created_at: now
    });
    const flowchart = buildFlowchartState();
    const summaryNodes = flowchart.nodes.filter((node) => node.id.startsWith("codex_flow:"));
    console.log(JSON.stringify({
      workerCount: listWorkers().length,
      types: flowchart.nodes.map((node) => node.type),
      labels: flowchart.nodes.map((node) => node.label),
      summaryTypes: summaryNodes.map((node) => node.type),
      summaryLabels: summaryNodes.map((node) => node.label),
      summaryText: JSON.stringify(summaryNodes)
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { workerCount?: number; types?: string[]; labels?: string[]; summaryTypes?: string[]; summaryLabels?: string[]; summaryText?: string };
  assert.equal(payload.workerCount, 0);
  assert.ok(payload.summaryTypes?.includes("user_request"));
  assert.ok(payload.summaryTypes?.includes("codex_plan"));
  assert.ok(payload.summaryTypes?.includes("codex_session"));
  assert.ok(payload.summaryTypes?.includes("codex_subagent"));
  assert.ok(payload.summaryTypes?.includes("validation"));
  assert.ok(payload.summaryTypes?.includes("preview"));
  assert.ok(payload.summaryTypes?.includes("final_summary"));
  assert.equal(payload.summaryTypes?.includes("files_changed"), false);
  assert.match(payload.summaryText ?? "", /Rules Agent/);
  assert.match(payload.summaryText ?? "", /API Agent/);
  assert.match(payload.summaryText ?? "", /Interface Agent/);
  assert.doesNotMatch(payload.summaryText ?? "", /shared\/game\.js|public\/index\.html|\/workspace|npm test|npm run/);
});

test("local Codex validation rejects missing files and docs-only success", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-validation-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    const { validateLocalCodexResult } = await import("./codex-phone-supervisor/backend/src/codex-session-local.ts");
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(path.join(${JSON.stringify(workspaceRoot)}, ".head-developer"), { recursive: true });
    fs.writeFileSync(path.join(${JSON.stringify(workspaceRoot)}, ".head-developer", "state.json"), "{}");
    const result = validateLocalCodexResult({
      workspacePath: ${JSON.stringify(workspaceRoot)},
      requiredFiles: ["index.html"],
      changedFiles: [".head-developer/state.json"],
      commandResults: [],
      docsUpdated: true,
      codexStatus: "completed",
      errors: []
    });
    console.log(JSON.stringify(result));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { status?: string; failures?: string[]; docs_only_success_rejected?: boolean };
  assert.equal(payload.status, "failed");
  assert.equal(payload.docs_only_success_rejected, true);
  assert.match((payload.failures ?? []).join(" "), /Missing required file|Docs-only success/);
});

test("starting a new local session deletes only the current generated project and clears stale state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-reset-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "chai-shop");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "index.html"), "<h1>Chai</h1>\\n");

  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { readStore, upsertCommandEvent, upsertSession, upsertTask } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { resetSupervisorSession } = await import("./codex-phone-supervisor/backend/src/session-reset.ts");
    const fs = await import("node:fs");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("Old generated app", project.workspace_path);
    session.session_id = "session_reset_old";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.active_task_id = "task_reset_old";
    upsertSession(session);
    const now = new Date().toISOString();
    upsertTask({
      task_id: "task_reset_old",
      project_id: project.project_id,
      user_goal: "Build a chai shop.",
      normalized_goal: "build a chai shop",
      status: "completed",
      plan: ["Use one local Codex session."],
      worker_id: null,
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Built.",
      next_steps: [],
      execution_backend: "codex_session_local",
      created_at: now,
      updated_at: now
    });
    upsertCommandEvent({
      event_id: "command_reset_old",
      task_id: "task_reset_old",
      project_id: project.project_id,
      worker_id: "local-codex-session",
      worker_mode: "codex_session_local",
      command: "codex exec --json",
      cwd: project.workspace_path,
      started_at: now,
      ended_at: now,
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: "completed",
      risk_level: "low",
      approved_by_user: false,
      created_at: now
    });
    const result = resetSupervisorSession({ sessionId: session.session_id, deleteProject: true, workspacePath: ${JSON.stringify(workspaceRoot)}, channel: "web_text" });
    const state = readStore();
    console.log(JSON.stringify({
      oldSessionGone: !state.sessions.session_reset_old,
      oldProjectGone: !state.projects[project.project_id],
      oldTaskGone: !state.tasks.task_reset_old,
      oldCommandGone: !state.command_events.command_reset_old,
      newSessionExists: Boolean(state.sessions[result.session_id]),
      projectDirExists: fs.existsSync(${JSON.stringify(projectDir)}),
      workspaceRootExists: fs.existsSync(${JSON.stringify(workspaceRoot)}),
      deleted: result.deleted_project.deleted,
      stateRemoved: result.deleted_project.state_removed,
      removedTasks: result.removed.tasks,
      removedCommands: result.removed.command_events
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.oldSessionGone, true);
  assert.equal(payload.oldProjectGone, true);
  assert.equal(payload.oldTaskGone, true);
  assert.equal(payload.oldCommandGone, true);
  assert.equal(payload.newSessionExists, true);
  assert.equal(payload.projectDirExists, false);
  assert.equal(payload.workspaceRootExists, true);
  assert.equal(payload.deleted, true);
  assert.equal(payload.stateRemoved, true);
  assert.equal(payload.removedTasks, 1);
  assert.equal(payload.removedCommands, 1);
});

test("session reset refuses to delete the configured workspace root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-reset-root-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "README.md"), "root workspace\\n");

  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { readStore, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { resetSupervisorSession } = await import("./codex-phone-supervisor/backend/src/session-reset.ts");
    const fs = await import("node:fs");
    const project = projectRecordForWorkspace(${JSON.stringify(workspaceRoot)});
    upsertProject(project);
    const session = createSession("Root workspace session", project.workspace_path);
    session.session_id = "session_reset_root";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    upsertSession(session);
    const result = resetSupervisorSession({ sessionId: session.session_id, deleteProject: true, workspacePath: ${JSON.stringify(workspaceRoot)}, channel: "web_text" });
    const state = readStore();
    console.log(JSON.stringify({
      rootStillExists: fs.existsSync(${JSON.stringify(workspaceRoot)}),
      rootReadmeStillExists: fs.existsSync(${JSON.stringify(path.join(workspaceRoot, "README.md"))}),
      projectStillExists: Boolean(state.projects[project.project_id]),
      oldSessionGone: !state.sessions.session_reset_root,
      skippedReason: result.deleted_project.skipped_reason,
      deleted: result.deleted_project.deleted
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.rootStillExists, true);
  assert.equal(payload.rootReadmeStillExists, true);
  assert.equal(payload.projectStillExists, true);
  assert.equal(payload.oldSessionGone, true);
  assert.equal(payload.skippedReason, "generated_projects_root_is_not_deletable");
  assert.equal(payload.deleted, false);
});

test("full-stack Wordle conversation proposes direct local Codex orchestration before approval", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-wordle-plan-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "wordle-app");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { upsertSession, getSession, listWorkers } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getMegaplanForSession } = await import("./codex-phone-supervisor/backend/src/megaplan.ts");
    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("Wordle session", ${JSON.stringify(projectDir)});
    session.session_id = "session_wordle_local_plan";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = project.display_name;
    upsertSession(session);
    const request = "Build a complete full-stack Wordle app in this existing project with frontend UI, backend API, shared game logic, tests, README, local validation, and local preview instructions.";
    const proposed = await handleSupervisorMessage(session.session_id, request, "web_text");
    const latest = getSession(session.session_id);
    const megaplan = getMegaplanForSession(session.session_id);
    const flowchart = buildFlowchartState();
    const sessionNodes = flowchart.nodes.filter((node) => node.detail?.session_id === session.session_id);
    console.log(JSON.stringify({
      proposed: proposed.response,
      pendingKind: latest?.pending_action?.type,
      pendingWorkerMode: latest?.pending_action?.worker_mode ?? latest?.pending_action?.proposed_plan?.recommended_worker_mode,
      megaplanExists: Boolean(megaplan),
      megaplanText: megaplan?.content ?? "",
      flowTypes: sessionNodes.map((node) => node.type),
      flowLabels: sessionNodes.map((node) => node.label),
      branch: megaplan?.repo.branch ?? null,
      workerCount: listWorkers().length
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { proposed?: string; pendingKind?: string; pendingWorkerMode?: string; workerCount?: number; megaplanExists?: boolean; megaplanText?: string; branch?: string | null; flowTypes?: string[]; flowLabels?: string[] };
  assert.match(payload.proposed ?? "", /talk directly to Codex/i);
  assert.match(payload.proposed ?? "", /local Codex CLI orchestrator session/);
  assert.match(payload.proposed ?? "", /Codex will choose how many logical internal subagents/);
  assert.match(payload.proposed ?? "", /Megaplan skill created MEGAPLAN\.md/);
  assert.equal(payload.pendingKind, "approve_megaplan");
  assert.equal(payload.pendingWorkerMode, "codex_session_local");
  assert.equal(payload.megaplanExists, true);
  assert.match(payload.megaplanText ?? "", /# Megaplan/);
  assert.match(payload.megaplanText ?? "", /Approval Gate/);
  assert.match(payload.megaplanText ?? "", /Repository/);
  assert.match(payload.megaplanText ?? "", /Technical Requirements/);
  assert.match(payload.megaplanText ?? "", /Codex Orchestration/);
  assert.match(payload.megaplanText ?? "", /Continuous Improvement Loop/);
  assert.match(payload.megaplanText ?? "", /IMPROVEMENTS\.md/);
  assert.match(payload.megaplanText ?? "", /must record deferred ideas/);
  assert.match(payload.megaplanText ?? "", /Codex Runtime/);
  assert.match(payload.megaplanText ?? "", /Model: gpt-5\.5/);
  assert.match(payload.megaplanText ?? "", /full local access/);
  assert.ok(payload.flowTypes?.includes("codex_plan"));
  assert.ok(payload.flowTypes?.includes("user_approval"));
  assert.ok(payload.flowLabels?.includes("Megaplan"));
  assert.equal(payload.workerCount, 0);
});

test("read-only browser wrapper verification does not become an implementation plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-codex-readonly-chat-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "selected-app");
  const codexHome = path.join(root, "codex-home");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), "{}\n");
  fs.mkdirSync(codexHome, { recursive: true });

  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { upsertSession, getSession, listWorkers } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("Read-only wrapper check", project.workspace_path);
    session.session_id = "session_readonly_wrapper_check";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = project.display_name;
    upsertSession(session);
    const response = await handleSupervisorMessage(
      session.session_id,
      "Wrapper verification only for the current repo. Reply in one sentence confirming this browser wrapper can reach Codex. Do not create or modify files.",
      "web_text"
    );
    const afterFirst = getSession(session.session_id);
    afterFirst.pending_action = {
      type: "approve_task_split",
      original_user_goal: "Build a static SaaS dashboard.",
      requested_kind: "app",
      created_at: new Date().toISOString(),
      worker_mode: "codex_session_local"
    };
    upsertSession(afterFirst);
    const pendingResponse = await handleSupervisorMessage(
      session.session_id,
      "Wrapper verification only while approval is pending. Confirm the browser wrapper can reach Codex. Do not create or modify files.",
      "web_text"
    );
    const latest = getSession(session.session_id);
    console.log(JSON.stringify({
      response: response.response,
      pendingResponse: pendingResponse.response,
      pendingAction: latest?.pending_action?.type ?? null,
      eventTypes: latest?.raw_events?.map((event) => event.type) ?? [],
      workerCount: listWorkers().length
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { response?: string; pendingResponse?: string; pendingAction?: string | null; eventTypes?: string[]; workerCount?: number };
  assert.match(payload.response ?? "", /Confirmed: this browser wrapper can reach Codex/);
  assert.match(payload.pendingResponse ?? "", /Confirmed: this browser wrapper can reach Codex/);
  assert.equal(payload.pendingAction, "approve_task_split");
  assert.equal(payload.workerCount, 0);
  assert.ok(payload.eventTypes?.includes("supervisor.development.answer"));
  assert.equal(payload.eventTypes?.includes("supervisor.development.sent_to_codex"), false);
});

test("real Codex CLI local smoke runs only when explicitly enabled", { skip: process.env.RUN_REAL_CODEX_LOCAL_SMOKE === "1" ? false : "Set RUN_REAL_CODEX_LOCAL_SMOKE=1 to run the real Codex CLI smoke." }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "real-local-codex-smoke-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "chai-shop");
  const codexHome = process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  fs.mkdirSync(projectDir, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot, codexHome)}
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = ${JSON.stringify(process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND || "codex")};
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { upsertSession, getTask, listWorkers } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { startLocalCodexSession } = await import("./codex-phone-supervisor/backend/src/codex-session-local.ts");
    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");
    const fs = await import("node:fs");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("Build a landing page for a chai shop.", project.workspace_path);
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    upsertSession(session);
    const started = startLocalCodexSession({ session, project, userGoal: "Build a tiny static chai shop landing page with index.html, styles.css, script.js, README, and a concise subagent breakdown." });
    const deadline = Date.now() + 480000;
    let task = getTask(started.task.task_id);
    while (Date.now() < deadline && task && task.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      task = getTask(task.task_id);
    }
    const flowchart = buildFlowchartState();
    console.log(JSON.stringify({
      taskStatus: task?.status,
      workerCount: listWorkers().length,
      filesChanged: task?.files_changed ?? [],
      subagents: task?.codex_subagents?.map((item) => item.name) ?? [],
      validation: task?.local_validation_result?.status,
      flowchartJsonExists: Boolean(task?.codex_flowchart_json_path && fs.existsSync(task.codex_flowchart_json_path)),
      flowTypes: flowchart.nodes.map((node) => node.type),
      projectDir: ${JSON.stringify(projectDir)}
    }));
  `;
  const result = runIsolated(script, { RUN_REAL_CODEX_LOCAL_SMOKE: "1" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { taskStatus?: string; workerCount?: number; filesChanged?: string[]; subagents?: string[]; validation?: string; flowchartJsonExists?: boolean; flowTypes?: string[] };
  assert.equal(payload.taskStatus, "completed");
  assert.equal(payload.workerCount, 0);
  assert.ok((payload.filesChanged ?? []).some((file) => file.endsWith("index.html")));
  assert.ok((payload.subagents ?? []).length >= 1);
  assert.equal(payload.validation, "passed");
  assert.equal(payload.flowchartJsonExists, true);
  assert.ok(payload.flowTypes?.includes("codex_session"));
  assert.ok(payload.flowTypes?.includes("codex_subagent"));
});
