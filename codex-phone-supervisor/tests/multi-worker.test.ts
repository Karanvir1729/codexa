import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function bootstrapEnv(storeDir: string, workspaceRoot: string) {
  return `
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = process.execPath;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = process.cwd();
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
    process.env.SUPERVISOR_MODEL_PROVIDER = "vertex";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL = "deterministic";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.WORKER_MODE = "docker_local";
    process.env.DEFAULT_WORKER_MODE = "docker_local";
    process.env.ALLOW_WORKER_MODE_SWITCH = "true";
    process.env.MAX_PARALLEL_WORKERS = "3";
    process.env.MAX_DOCKER_LOCAL_WORKERS = "3";
    process.env.HEAD_DEVELOPER_GCP_VM_DRY_RUN = "1";
  `;
}

function runIsolated(script: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    env: { ...process.env, CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
}

test("multi-worker coordinator creates task graphs, project docs, isolated worktrees, and flowchart nodes", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-worker-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-worker-root-"));
  const projectDir = path.join(workspaceRoot, "saas-dashboard");
  fs.mkdirSync(projectDir, { recursive: true });
  const complexGoal = "Build a small SaaS dashboard with a landing page, login screen, dashboard layout, settings page, fake billing page, and tests.";
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const { projectRecordForWorkspace, upsertProject, getProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { multiWorkerCoordinator } = await import("./codex-phone-supervisor/backend/src/multi-worker-coordinator.ts");
    const { classifyCommand } = await import("./codex-phone-supervisor/backend/src/command-policy.ts");
    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");
    const { getTask, getTaskGraph, listTaskGraphs, listWorkerContextPackets, listWorkers, upsertTask } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { renderCodexPrompt } = await import("./codex-phone-supervisor/backend/src/worker-entry.ts");
    const fs = await import("node:fs");
    const path = await import("node:path");

    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    project.display_name = "SaaS Dashboard";
    upsertProject(project);
    const simple = multiWorkerCoordinator.judge("Build a simple landing page for a candle shop.", project);
    const staticShell = multiWorkerCoordinator.judge("Build a static SaaS dashboard shell with landing page, login page, dashboard page, and settings page. Static HTML/CSS/JS only. No billing. No backend. No package installs.", project);
    const created = await multiWorkerCoordinator.createAndMaybeStart(project, ${JSON.stringify(complexGoal)}, "docker_local", { autoStart: false });
    const preparedProject = getProject(project.project_id);
    const docs = [".head-developer/PROJECT_BRIEF.md", ".head-developer/TASK_GRAPH.md", ".head-developer/WORKER_HANDOFFS.md", ".head-developer/VALIDATION.md"];
    const docsExist = docs.every((file) => fs.existsSync(path.join(${JSON.stringify(projectDir)}, file)));
    const firstStart = await multiWorkerCoordinator.startReadyWork(created.graph.task_graph_id, "docker_local", 2);
    const graph = getTaskGraph(created.graph.task_graph_id);
    const contexts = listWorkerContextPackets({ taskGraphId: graph.task_graph_id });
    const firstContext = contexts[0];
    const firstContextTask = getTask(firstContext.task_id);
    const renderedPrompt = renderCodexPrompt(firstContextTask, preparedProject, firstContext);
    const flow = buildFlowchartState();
    const worktrees = firstStart.assignments.map((item) => item.node.worktree_path).filter(Boolean);
    const setupNode = graph.nodes.find((node) => node.title === "Project setup and shared docs");
    const distinctWorktrees = new Set(worktrees).size === worktrees.length;
    const outsidePolicy = classifyCommand("pwd", "/tmp", project.workspace_path, false);
    console.log(JSON.stringify({
      simpleComplexity: simple.complexity,
      simpleWorkers: simple.recommended_worker_count,
      staticShellWorkers: staticShell.recommended_worker_count,
      staticShellSubtasks: staticShell.suggested_subtasks.map((item) => item.title),
      staticShellHasBilling: staticShell.suggested_subtasks.some((item) => /billing/i.test(item.title + " " + item.goal)),
      graphStatus: graph.status,
      graphNodeCount: graph.nodes.length,
      graphStrategy: graph.execution_strategy,
      docsExist,
      gitInitialized: Boolean(preparedProject.git_initialized),
      latestCommitRecorded: Boolean(preparedProject.latest_commit_hash),
      setupNodeStatus: setupNode?.status,
      firstAssignments: firstStart.assignments.length,
      workerCount: listWorkers().length,
      distinctWorktrees,
      worktreesInsideIsolatedRoot: worktrees.every((item) => item.includes(".worktrees")),
      contextsHaveDocs: contexts.every((packet) => packet.relevant_docs[".head-developer/PROJECT_BRIEF.md"]?.includes("Project Brief")),
      contextsHaveOutputContract: contexts.every((packet) => packet.output_contract && Array.isArray(packet.output_contract.acceptance_checks)),
      contextsHaveExpectedFiles: contexts.every((packet) => packet.expected_files.length > 0),
      contextsHaveValidationCommands: contexts.every((packet) => packet.validation_commands.some((command) => command.includes("node --check") || command.includes("find ."))),
      contextsHaveAllowedRoots: contexts.every((packet) => packet.allowed_roots.length === 1 && packet.allowed_roots[0].includes(".worktrees")),
      contextsHaveHandoffRequirements: contexts.every((packet) => packet.handoff_instructions.some((item) => item.includes("WORKER_HANDOFFS.md"))),
      promptHasOutputContract: renderedPrompt.includes("Output contract:"),
      promptHasExpectedFiles: renderedPrompt.includes("Expected files:"),
      promptHasValidationCommands: renderedPrompt.includes("Validation commands:"),
      promptHasAllowedRoots: renderedPrompt.includes("Allowed roots:"),
      promptHasHandoffRequirements: renderedPrompt.includes("Handoff requirements:"),
      promptHasDocsOnlyWarning: renderedPrompt.includes("Updating .head-developer docs alone is not sufficient"),
      promptHasRequiredExecutionOrder: renderedPrompt.includes("Required execution order:") && renderedPrompt.includes("files_to_write") && renderedPrompt.includes("Do not use apply_patch"),
      outsidePolicy: outsidePolicy.disposition,
      flowHasTaskGraph: flow.nodes.some((node) => node.type === "task_graph" && node.id.includes(graph.task_graph_id)),
      flowHasTaskGraphNode: flow.nodes.some((node) => node.type === "task_graph_node"),
      flowHasWorktree: flow.nodes.some((node) => node.type === "worktree"),
      flowHasSharedDocs: flow.nodes.some((node) => node.type === "shared_docs")
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.simpleComplexity, "simple");
  assert.equal(payload.simpleWorkers, 1);
  assert.equal(payload.staticShellWorkers, 2);
  assert.deepEqual(payload.staticShellSubtasks, ["Project setup and shared docs", "Landing and login pages", "Dashboard and settings pages", "Validation and review"]);
  assert.equal(payload.staticShellHasBilling, false);
  assert.equal(payload.graphNodeCount, 6);
  assert.equal(payload.graphStrategy, "parallel_worktrees");
  assert.equal(payload.docsExist, true);
  assert.equal(payload.gitInitialized, true);
  assert.equal(payload.latestCommitRecorded, true);
  assert.equal(payload.setupNodeStatus, "completed");
  assert.ok(Number(payload.firstAssignments) >= 2);
  assert.ok(Number(payload.workerCount) >= 2);
  assert.equal(payload.distinctWorktrees, true);
  assert.equal(payload.worktreesInsideIsolatedRoot, true);
  assert.equal(payload.contextsHaveDocs, true);
  assert.equal(payload.contextsHaveOutputContract, true);
  assert.equal(payload.contextsHaveExpectedFiles, true);
  assert.equal(payload.contextsHaveValidationCommands, true);
  assert.equal(payload.contextsHaveAllowedRoots, true);
  assert.equal(payload.contextsHaveHandoffRequirements, true);
  assert.equal(payload.promptHasOutputContract, true);
  assert.equal(payload.promptHasExpectedFiles, true);
  assert.equal(payload.promptHasValidationCommands, true);
  assert.equal(payload.promptHasAllowedRoots, true);
  assert.equal(payload.promptHasHandoffRequirements, true);
  assert.equal(payload.promptHasDocsOnlyWarning, true);
  assert.equal(payload.promptHasRequiredExecutionOrder, true);
  assert.equal(payload.outsidePolicy, "requires_approval");
  assert.equal(payload.flowHasTaskGraph, true);
  assert.equal(payload.flowHasTaskGraphNode, true);
  assert.equal(payload.flowHasWorktree, true);
  assert.equal(payload.flowHasSharedDocs, true);
});

test("conversation proposes complex task split before launching multi-worker execution", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-worker-convo-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multi-worker-convo-root-"));
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, listTaskGraphs } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(workspaceRoot)});
    project.display_name = "Planner Convo Project";
    upsertProject(project);
    const session = createSession("multi worker conversation", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_multi_worker_split";
    session.channel = "web_text";
    session.preferred_worker_mode = "docker_local";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = project.display_name;
    const { upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    upsertSession(session);
    const response = await handleSupervisorMessage(session.session_id, "Implement auth, dashboard, settings, and admin panel for the SaaS product.", "web_text");
    const latest = getSession(session.session_id);
    const graphCountBeforeApproval = listTaskGraphs(project.project_id).length;
    const approve = await handleSupervisorMessage(session.session_id, "approve", "web_text");
    const afterApprove = getSession(session.session_id);
    const graphs = listTaskGraphs(project.project_id);
    console.log(JSON.stringify({
      response: response.response,
      approveResponse: approve.response,
      pendingType: latest.pending_action?.type,
      graphCountBeforeApproval,
      graphCountAfterApproval: graphs.length,
      currentStatus: latest.current_status,
      afterApproveStatus: afterApprove.current_status
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.match(String(payload.response), /split/i);
  assert.equal(payload.pendingType, "approve_task_split");
  assert.equal(payload.graphCountBeforeApproval, 0);
  assert.equal(payload.graphCountAfterApproval, 1);
  assert.equal(payload.currentStatus, "waiting_for_approval");
  assert.equal(payload.afterApproveStatus, "running");
});

test("operator runtime commands do not use API-side shell for Docker Local and queue through callback path for GCP", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-command-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-command-root-"));
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { actionRouter } = await import("./codex-phone-supervisor/backend/src/action-router.ts");
    const { upsertSession, upsertTask, upsertWorker, listWorkerRuntimeCommandRequests } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(workspaceRoot)});
    upsertProject(project);
    const session = createSession("runtime command", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_runtime_command";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.project_discovery.status = "selected";
    upsertSession(session);
    const baseTask = {
      task_id: "task_runtime_command",
      project_id: project.project_id,
      user_goal: "Runtime command test",
      normalized_goal: "runtime command test",
      status: "running",
      plan: ["Inspect runtime."],
      worker_id: "worker_docker_no_container",
      codex_run_id: null,
      command_count: 0,
      latest_summary: "Running.",
      next_steps: ["Inspect worker."],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    upsertTask(baseTask);
    upsertWorker({
      worker_id: "worker_docker_no_container",
      type: "docker_local",
      status: "running",
      image_uri: "worker:test",
      project_id: project.project_id,
      task_id: baseTask.task_id,
      heartbeat_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600000).toISOString()
    });
    const dockerResult = await actionRouter.execute({ session_id: session.session_id, action_type: "run_worker_command", user_goal: "run pwd in the worker", worker_id: "worker_docker_no_container", task_id: baseTask.task_id, project_id: project.project_id, input: { command: "pwd" } });
    upsertWorker({
      worker_id: "worker_gcp_runtime",
      type: "gcp_vm",
      status: "running",
      image_uri: "worker:gcp",
      project_id: project.project_id,
      task_id: baseTask.task_id,
      heartbeat_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600000).toISOString()
    });
    const gcpResult = await actionRouter.execute({ session_id: session.session_id, action_type: "run_worker_command", user_goal: "run pwd in the worker", worker_id: "worker_gcp_runtime", task_id: baseTask.task_id, project_id: project.project_id, input: { command: "pwd" } });
    const requests = listWorkerRuntimeCommandRequests({ workerId: "worker_gcp_runtime" });
    console.log(JSON.stringify({
      dockerStatus: dockerResult.action.status,
      dockerError: dockerResult.action.error,
      gcpStatus: gcpResult.action.status,
      requestCount: requests.length,
      queuedStatus: requests[0]?.status,
      queuedCommand: requests[0]?.command
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.dockerStatus, "failed");
  assert.match(String(payload.dockerError), /container id/i);
  assert.equal(payload.gcpStatus, "completed");
  assert.equal(payload.requestCount, 1);
  assert.equal(payload.queuedStatus, "queued");
  assert.equal(payload.queuedCommand, "pwd");
});
