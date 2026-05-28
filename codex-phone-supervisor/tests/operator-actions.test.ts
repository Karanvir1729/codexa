import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function bootstrapEnv(storeDir: string, workspace: string) {
  return `
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = process.execPath;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH = ${JSON.stringify(workspace)};
    process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT = ${JSON.stringify(workspace)};
    process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS = ${JSON.stringify(workspace)};
    process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR = ${JSON.stringify(storeDir)};
    process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR = "codex-phone-supervisor/frontend/dist";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS = "5000";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS = "25";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE = "1";
    process.env.CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL = "";
    process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED = "0";
    process.env.SUPERVISOR_MODEL_PROVIDER = "vertex";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL = "deterministic";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.WORKER_MODE = "local";
    process.env.DEFAULT_WORKER_MODE = "local";
    process.env.ALLOW_WORKER_MODE_SWITCH = "true";
    process.env.HEAD_DEVELOPER_GCP_VM_DRY_RUN = "1";
  `;
}

function runIsolated(script: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    env: { ...process.env, CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("operator action router controls workers, commands, approvals, logs, MCP, and flowchart state", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-action-store-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "operator-action-workspace-"));
  fs.writeFileSync(path.join(workspace, "script.js"), "console.log('ok');\n");
  const script = `
    ${bootstrapEnv(storeDir, workspace)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { actionRouter, rejectOperatorAction, parseOperatorIntent } = await import("./codex-phone-supervisor/backend/src/action-router.ts");
    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");
    const { listWorkersViaMcp } = await import("./packages/mcp-tools/src/index.ts");
    const { upsertSession, upsertTask, upsertWorker, upsertCommandEvent, listCommandEvents, listOperatorActions, listMcpToolCalls, getWorker } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const project = projectRecordForWorkspace(${JSON.stringify(workspace)});
    upsertProject(project);
    const session = createSession("operator action test", ${JSON.stringify(workspace)});
    session.session_id = "session_operator_action";
    session.channel = "web_text";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.active_task_id = "task_operator_action";
    session.active_worker_id = "worker_operator_action";
    session.project_discovery.status = "selected";
    upsertSession(session);
    upsertTask({
      task_id: "task_operator_action",
      project_id: project.project_id,
      user_goal: "Operator action task",
      normalized_goal: "operator action task",
      status: "running",
      plan: ["Run commands."],
      worker_id: "worker_operator_action",
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Task is running.",
      next_steps: ["Wait for command."],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    upsertWorker({
      worker_id: "worker_operator_action",
      type: "local",
      status: "running",
      image_uri: "worker:test",
      actual_image_uri: "worker:test@sha256:abc",
      project_id: project.project_id,
      task_id: "task_operator_action",
      heartbeat_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600000).toISOString(),
      metadata_verified_from_runtime: true
    });
    upsertCommandEvent({
      event_id: "cmd_running_operator_action",
      task_id: "task_operator_action",
      project_id: project.project_id,
      worker_id: "worker_operator_action",
      command: "codex exec --json test",
      cwd: ${JSON.stringify(workspace)},
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "running",
      stderr_preview: "token=supersecret",
      summary: "Command is running.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date().toISOString()
    });

    const parsedCommand = parseOperatorIntent("What command is running?");
    const parsedRun = parseOperatorIntent("Run pwd in the worker");
    const parsedWorkerLogs = parseOperatorIntent("Show worker logs.");
    const parsedGcpWorkers = parseOperatorIntent("What GCP workers are running?");
    const list = await actionRouter.execute({ session_id: session.session_id, action_type: "list_workers", user_goal: "list workers" });
    const inspect = await actionRouter.execute({ session_id: session.session_id, action_type: "inspect_worker", user_goal: "inspect worker", worker_id: "worker_operator_action" });
    const stop = await actionRouter.execute({ session_id: session.session_id, action_type: "stop_worker", user_goal: "stop active worker", worker_id: "worker_operator_action", task_id: "task_operator_action", project_id: project.project_id });
    const rejected = rejectOperatorAction(stop.action.action_id);
    const afterRejectWorker = getWorker("worker_operator_action");
    const restart = await actionRouter.execute({ session_id: session.session_id, action_type: "restart_worker", user_goal: "restart active worker", worker_id: "worker_operator_action", task_id: "task_operator_action", project_id: project.project_id });
    const safe = await actionRouter.execute({ session_id: session.session_id, action_type: "run_worker_command", user_goal: "run pwd", worker_id: "worker_operator_action", task_id: "task_operator_action", project_id: project.project_id, input: { command: "pwd" } });
    const unsafe = await actionRouter.execute({ session_id: session.session_id, action_type: "run_worker_command", user_goal: "run npm install", worker_id: "worker_operator_action", task_id: "task_operator_action", project_id: project.project_id, input: { command: "npm install left-pad" } });
    const blocked = await actionRouter.execute({ session_id: session.session_id, action_type: "run_worker_command", user_goal: "run env", worker_id: "worker_operator_action", task_id: "task_operator_action", project_id: project.project_id, input: { command: "env" } });
    const logs = await actionRouter.execute({ session_id: session.session_id, action_type: "tail_worker_logs", user_goal: "tail logs", worker_id: "worker_operator_action", task_id: "task_operator_action", project_id: project.project_id, input: { lines: 20 } });
    const mcp = await listWorkersViaMcp({ session_id: session.session_id });
    const flow = buildFlowchartState();
    const commandEvents = listCommandEvents({ taskId: "task_operator_action" });
    console.log(JSON.stringify({
      parsedCommand: parsedCommand?.action_type,
      parsedRun: parsedRun?.action_type,
      parsedWorkerLogs: parsedWorkerLogs?.action_type,
      parsedGcpWorkers: parsedGcpWorkers?.action_type ?? null,
      workerCount: list.action.result.workers.length,
      inspectImage: inspect.action.result.actual_runtime_image,
      stopStatus: stop.action.status,
      stopApproval: Boolean(stop.action.approval_id),
      rejectedStatus: rejected.action.status,
      workerAfterReject: afterRejectWorker.status,
      restartStatus: restart.action.status,
      restartApproval: Boolean(restart.action.approval_id),
      safeCommandId: safe.action.command_id,
      safeLogged: commandEvents.some((event) => event.event_id === safe.action.command_id && event.command === "pwd"),
      unsafeStatus: unsafe.action.status,
      unsafeApproval: Boolean(unsafe.action.approval_id),
      blockedStatus: blocked.action.status,
      blockedError: blocked.action.error,
      redactedLogs: logs.action.result.logs,
      mcpActionStatus: mcp.status,
      mcpEvents: listMcpToolCalls({ sessionId: session.session_id }).length,
      operatorActions: listOperatorActions({ sessionId: session.session_id }).length,
      flowHasOperator: flow.nodes.some((node) => ["operator_action", "worker_control", "command_action", "log_inspection"].includes(node.type)),
      flowHasActionEdge: flow.edges.some((edge) => edge.label === "typed action")
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.parsedCommand, "inspect_command");
  assert.equal(payload.parsedRun, "run_worker_command");
  assert.equal(payload.parsedWorkerLogs, "tail_worker_logs");
  assert.equal(payload.parsedGcpWorkers, null);
  assert.equal(payload.workerCount, 1);
  assert.equal(payload.inspectImage, "worker:test@sha256:abc");
  assert.equal(payload.stopStatus, "waiting_for_approval");
  assert.equal(payload.stopApproval, true);
  assert.equal(payload.rejectedStatus, "rejected");
  assert.equal(payload.workerAfterReject, "running");
  assert.equal(payload.restartStatus, "waiting_for_approval");
  assert.equal(payload.restartApproval, true);
  assert.equal(typeof payload.safeCommandId, "string");
  assert.equal(payload.safeLogged, true);
  assert.equal(payload.unsafeStatus, "waiting_for_approval");
  assert.equal(payload.unsafeApproval, true);
  assert.equal(payload.blockedStatus, "blocked");
  assert.match(String(payload.blockedError), /Blocked/i);
  assert.doesNotMatch(JSON.stringify(payload.redactedLogs), /supersecret/);
  assert.equal(payload.mcpActionStatus, "completed");
  assert.ok(Number(payload.mcpEvents) >= 1);
  assert.ok(Number(payload.operatorActions) >= 7);
  assert.equal(payload.flowHasOperator, true);
  assert.equal(payload.flowHasActionEdge, true);
});

test("operator chat responses summarize state without raw JSON payloads", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-chat-store-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "operator-chat-workspace-"));
  fs.writeFileSync(path.join(workspace, "index.html"), "<!doctype html><title>UX Polish</title><main>Ready</main>\n");
  fs.writeFileSync(path.join(workspace, "app.js"), "export function ready() { return true; }\n");
  fs.mkdirSync(path.join(workspace, ".head-developer"), { recursive: true });

  const script = `
    ${bootstrapEnv(storeDir, workspace)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { handleUserMessage } = await import("./codex-phone-supervisor/backend/src/agent-core.ts");
    const { documentationIndexer } = await import("./codex-phone-supervisor/backend/src/documentation-indexer.ts");
    const { upsertSession, upsertTask, upsertWorker, upsertCommandEvent, upsertRunSummary } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const now = new Date().toISOString();
    const project = projectRecordForWorkspace(${JSON.stringify(workspace)});
    project.display_name = "Operator UX Polish";
    upsertProject(project);
    documentationIndexer.updateProjectDocs(project);

    const session = createSession("operator UX chat", ${JSON.stringify(workspace)});
    session.session_id = "session_operator_chat";
    session.user_id = "operator-chat-user";
    session.channel = "web_text";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.active_task_id = "task_ux_a";
    session.active_worker_id = "worker_ux_a";
    session.current_status = "running";
    session.status = "running";
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = project.display_name;
    upsertSession(session);

    upsertTask({
      task_id: "task_ux_a",
      project_id: project.project_id,
      user_goal: "Build the landing and login flow",
      normalized_goal: "build the landing and login flow",
      status: "running",
      plan: ["Build landing", "Build login"],
      worker_id: "worker_ux_a",
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Landing/login work is in progress.",
      next_steps: ["Wait for Codex command to finish."],
      task_graph_id: "graph_operator_chat",
      task_graph_node_id: "node_landing_login",
      branch_name: "worker/landing-login",
      worktree_path: ${JSON.stringify(path.join(workspace, ".worktrees", "landing-login"))},
      created_at: now,
      updated_at: now
    });
    upsertTask({
      task_id: "task_ux_b",
      project_id: project.project_id,
      user_goal: "Build dashboard settings",
      normalized_goal: "build dashboard settings",
      status: "running",
      plan: ["Build dashboard", "Build settings"],
      worker_id: "worker_ux_b",
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Dashboard/settings work is in progress.",
      next_steps: ["Review dashboard output."],
      task_graph_id: "graph_operator_chat",
      task_graph_node_id: "node_dashboard_settings",
      branch_name: "worker/dashboard-settings",
      worktree_path: ${JSON.stringify(path.join(workspace, ".worktrees", "dashboard-settings"))},
      created_at: now,
      updated_at: now
    });
    upsertTask({
      task_id: "task_ux_preview",
      project_id: project.project_id,
      user_goal: "Completed previewable page",
      normalized_goal: "completed previewable page",
      status: "completed",
      plan: ["Serve preview"],
      worker_id: "worker_ux_a",
      codex_run_id: null,
      command_count: 0,
      latest_summary: "Preview page is complete.",
      next_steps: ["Inspect preview."],
      created_at: new Date(Date.now() + 1).toISOString(),
      updated_at: new Date(Date.now() + 1).toISOString()
    });
    upsertWorker({
      worker_id: "worker_ux_a",
      type: "docker_local",
      actual_worker_mode: "docker_local",
      status: "running",
      image_uri: "worker:test",
      actual_image_uri: "worker:test@sha256:landing",
      project_id: project.project_id,
      task_id: "task_ux_a",
      heartbeat_at: now,
      created_at: now,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      metadata_verified_from_runtime: true,
      docker_container_name: "worker-ux-a"
    });
    upsertWorker({
      worker_id: "worker_ux_b",
      type: "docker_local",
      actual_worker_mode: "docker_local",
      status: "running",
      image_uri: "worker:test",
      actual_image_uri: "worker:test@sha256:dashboard",
      project_id: project.project_id,
      task_id: "task_ux_b",
      heartbeat_at: now,
      created_at: new Date(Date.now() - 1000).toISOString(),
      expires_at: new Date(Date.now() + 600000).toISOString(),
      metadata_verified_from_runtime: true,
      docker_container_name: "worker-ux-b"
    });
    upsertCommandEvent({
      event_id: "cmd_ux_active",
      task_id: "task_ux_a",
      project_id: project.project_id,
      worker_id: "worker_ux_a",
      command: "codex exec --json build landing login",
      cwd: ${JSON.stringify(workspace)},
      started_at: now,
      ended_at: null,
      exit_code: null,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "Editing landing page",
      stderr_preview: "",
      summary: "Codex is implementing the landing/login task.",
      risk_level: "low",
      approved_by_user: false,
      created_at: now,
      codex_session_id: "019e-operator-chat",
      codex_history_kind: "exec",
      codex_rollout_path: ${JSON.stringify(path.join(workspace, ".codex", "rollout.jsonl"))},
      codex_home: ${JSON.stringify(path.join(workspace, ".codex-worker-home"))},
      codex_history_confidence: "session_id_with_verified_rollout"
    });
    upsertCommandEvent({
      event_id: "cmd_ux_dashboard",
      task_id: "task_ux_b",
      project_id: project.project_id,
      worker_id: "worker_ux_b",
      command: "npm run build",
      cwd: ${JSON.stringify(workspace)},
      started_at: new Date(Date.now() - 2000).toISOString(),
      ended_at: new Date(Date.now() - 1000).toISOString(),
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "build passed",
      stderr_preview: "",
      summary: "Dashboard build passed.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date(Date.now() - 2000).toISOString()
    });
    upsertRunSummary({
      task_id: "task_ux_a",
      executive_summary: "Landing/login is being implemented by worker_ux_a.",
      technical_summary: "Codex is editing app files in the landing/login worktree.",
      commands_run: ["codex exec --json build landing login"],
      files_changed: ["index.html", "app.js"],
      tests_run: [],
      failures: [],
      current_state: "running",
      next_plan: ["Wait for Codex to finish."],
      confidence: "high",
      created_at: now
    });

    async function ask(text) {
      const response = await handleUserMessage({
        userId: "operator-chat-user",
        channel: "web_text",
        text,
        sessionId: session.session_id,
        timestamp: new Date().toISOString()
      });
      return response.text;
    }

    const responses = {
      listWorkers: await ask("list workers"),
      inspectWorker: await ask("what is worker 1 doing?"),
      happening: await ask("what is happening?"),
      command: await ask("what command is running?"),
      logs: await ask("show worker logs"),
      history: await ask("show Codex history"),
      docs: await ask("show project docs"),
      docsFresh: await ask("are docs up to date?"),
      stopApproval: await ask("stop worker"),
      stopRejected: await ask("reject"),
      restartApproval: await ask("restart worker"),
      restartRejected: await ask("reject"),
      preview: await ask("preview it")
    };
    console.log(JSON.stringify(responses));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const responses = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, string>;
  for (const [label, response] of Object.entries(responses)) {
    assert.doesNotMatch(response, /^\s*[\[{]/, `${label} should not start with raw JSON`);
    assert.doesNotMatch(response, /"workers"\s*:|"worker_id"\s*:|"task_id"\s*:/, `${label} should not expose raw JSON fields`);
  }
  assert.match(responses.listWorkers, /worker_ux_a/);
  assert.match(responses.listWorkers, /worker_ux_b/);
  assert.match(responses.listWorkers, /No duplicate Codex commands are active/);
  assert.match(responses.inspectWorker, /worker_ux_a/);
  assert.match(responses.inspectWorker, /task_ux_a is running/);
  assert.match(responses.inspectWorker, /running codex exec --json build landing login/);
  assert.match(responses.happening, /Task task_ux_a is running/);
  assert.match(responses.command, /Running command on worker worker_ux_a/);
  assert.match(responses.logs, /worker worker_ux_a has 1 recent command log entry/);
  assert.match(responses.history, /Codex history is recorded for task task_ux_a/);
  assert.match(responses.docs, /Project docs are up to date/);
  assert.match(responses.docsFresh, /Project docs are up to date/);
  assert.match(responses.stopApproval, /Approval needed before stopping worker worker_ux_a/);
  assert.match(responses.restartApproval, /Approval needed before restarting worker worker_ux_a/);
  assert.match(responses.preview, /Preview is ready at http:\/\/127\.0\.0\.1:0\/previews\//);
});

test("dashboard worker controls call the typed operator action API", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor/frontend/src/main.tsx"), "utf8");
  assert.match(source, /\/operator\/actions/);
  assert.match(source, /Stop worker/);
  assert.match(source, /Restart worker/);
  assert.match(source, /Show Codex history/);
});
