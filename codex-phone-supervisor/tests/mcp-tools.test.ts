import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

test("product MCP tools log actions and appear in flowchart state", () => {
  const root = process.cwd();
  const storeDir = path.join(root, "tmp", `mcp-tools-test-${Date.now()}`);
  const workspace = path.join(storeDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  const script = `
    const {
      createProjectViaMcp,
      createTaskViaMcp,
      generateTaskSummaryViaMcp,
      launchWorkerViaMcp,
      runCommandViaMcp
    } = await import("./packages/mcp-tools/src/index.ts");
    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");
    const project = await createProjectViaMcp({
      session_id: "session-mcp-test",
      name: "mcp smoke project",
      description: "MCP smoke project"
    });
    const task = await createTaskViaMcp({
      project_id: project.project_id,
      user_goal: "Run a low-risk command through MCP."
    });
    const worker = await launchWorkerViaMcp({
      project_id: project.project_id,
      task_id: task.task_id,
      worker_mode: "local"
    });
    const command = await runCommandViaMcp({
      project_id: project.project_id,
      task_id: task.task_id,
      worker_id: worker.worker_id,
      command: "pwd",
      cwd: project.workspace_uri,
      risk_level: "low"
    });
    const summary = await generateTaskSummaryViaMcp({ task_id: task.task_id });
    const flowchart = buildFlowchartState();
    console.log(JSON.stringify({
      project,
      task,
      worker,
      command,
      summary,
      mcpActionNodes: flowchart.nodes.filter((node) => node.type === "mcp_action").length,
      mcpEdges: flowchart.edges.filter((edge) => edge.label.startsWith("mcp")).length,
      commandNodes: flowchart.nodes.filter((node) => node.type === "command" && node.id.includes(command.command_event_id)).length,
      summaryNodes: flowchart.nodes.filter((node) => node.type === "summary" && node.id.includes(task.task_id)).length
    }));
  `;

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_PHONE_SUPERVISOR_HOST: "127.0.0.1",
      CODEX_PHONE_SUPERVISOR_PORT: "0",
      CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS: "http://127.0.0.1:4318",
      CODEX_PHONE_SUPERVISOR_CODEX_COMMAND: process.execPath,
      CODEX_PHONE_SUPERVISOR_CODEX_HOME: root,
      CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH: workspace,
      CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT: workspace,
      CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS: workspace,
      CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
      CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
      CODEX_PHONE_SUPERVISOR_STORE_DIR: storeDir,
      CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
      CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
      CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
      CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL: "",
      CODEX_PHONE_SUPERVISOR_TEST_MODE: "1",
      SUPERVISOR_MODEL_PROVIDER: "vertex",
        CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL: "deterministic",
      TWILIO_CONVERSATION_RELAY_WS_URL: "",
      TWILIO_SMS_ENABLED: "0",
      TWILIO_VOICE_ENABLED: "0",
      TWILIO_VALIDATE_SIGNATURES: "0",
      TWILIO_AUTH_TOKEN: "",
      WORKER_MODE: "local",
      DEFAULT_WORKER_MODE: "local",
      ALLOW_WORKER_MODE_SWITCH: "true",
      MAX_LOCAL_WORKERS: "1",
      MAX_DOCKER_LOCAL_WORKERS: "3",
      MAX_GCP_VM_WORKERS: "10",
      HEAD_DEVELOPER_GCP_VM_DRY_RUN: "1",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim()) as {
    command: { exit_code: number; stdout_preview: string };
    mcpActionNodes: number;
    mcpEdges: number;
    commandNodes: number;
    summaryNodes: number;
  };
  assert.equal(payload.command.exit_code, 0);
  assert.match(payload.command.stdout_preview, /mcp-smoke-project|mcp smoke project|workspace/);
  assert.ok(payload.mcpActionNodes >= 4);
  assert.ok(payload.mcpEdges >= 3);
  assert.equal(payload.commandNodes, 1);
  assert.equal(payload.summaryNodes, 1);
});
