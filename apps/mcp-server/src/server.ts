#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  cleanupExpiredWorkersViaMcp,
  cleanupIdleWorkersViaMcp,
  createProjectViaMcp,
  createTaskViaMcp,
  generateTaskSummaryViaMcp,
  inspectCodexHistoryViaMcp,
  inspectCommandViaMcp,
  inspectTaskStateViaMcp,
  inspectWorkerViaMcp,
  launchWorkerViaMcp,
  listGcpWorkersViaMcp,
  listWorkersViaMcp,
  requestApprovalViaMcp,
  restartWorkerViaMcp,
  runCodexTaskViaMcp,
  runCommandViaMcp,
  runWorkerCommandViaMcp,
  startWorkerViaMcp,
  stopWorkerViaMcp,
  tailLogsViaMcp,
} from "../../../packages/mcp-tools/src/index.js";

function jsonResult(result: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

const server = new McpServer({
  name: "head-developer-product-mcp",
  version: "0.1.0",
});

server.registerTool("create_project", {
  title: "Create Project",
  description: "Create a Cloud Orchestrator project record and workspace directory.",
  inputSchema: {
    session_id: z.string(),
    name: z.string().min(1),
    description: z.string().min(1),
    repo_url: z.string().url().optional(),
  },
  outputSchema: {
    project_id: z.string(),
    workspace_uri: z.string(),
    status: z.string(),
  },
}, async (input) => jsonResult(await createProjectViaMcp(input)));

server.registerTool("create_task", {
  title: "Create Task",
  description: "Create a task under an existing project.",
  inputSchema: {
    project_id: z.string(),
    user_goal: z.string().min(1),
    normalized_goal: z.string().optional(),
  },
  outputSchema: {
    task_id: z.string(),
    status: z.string(),
  },
}, async (input) => jsonResult(await createTaskViaMcp(input)));

server.registerTool("launch_worker", {
  title: "Launch Worker",
  description: "Launch or assign a local, Docker local, or GCP VM worker through the WorkerManager interface.",
  inputSchema: {
    task_id: z.string(),
    project_id: z.string(),
    worker_mode: z.enum(["local", "docker_local", "gcp_vm"]),
  },
  outputSchema: {
    worker_id: z.string(),
    worker_status: z.string(),
    vm_name: z.string().nullable(),
  },
}, async (input) => jsonResult(await launchWorkerViaMcp(input)));

server.registerTool("run_codex_task", {
  title: "Run Codex Task",
  description: "Run a real codex exec command inside a workspace and log the command event.",
  inputSchema: {
    task_id: z.string(),
    project_id: z.string(),
    worker_id: z.string(),
    prompt: z.string().min(1),
    workspace_path: z.string().min(1),
    timeout: z.number().int().positive(),
  },
  outputSchema: {
    codex_run_id: z.string(),
    status: z.string(),
  },
}, async (input) => jsonResult(await runCodexTaskViaMcp(input)));

server.registerTool("run_command", {
  title: "Run Command",
  description: "Run a command through CommandRunner with policy checks and event logging.",
  inputSchema: {
    task_id: z.string(),
    project_id: z.string(),
    worker_id: z.string(),
    command: z.string().min(1),
    cwd: z.string().min(1),
    risk_level: z.enum(["low", "medium", "high", "blocked"]).optional(),
  },
  outputSchema: {
    command_event_id: z.string(),
    exit_code: z.number().nullable(),
    stdout_preview: z.string(),
    stderr_preview: z.string(),
  },
}, async (input) => jsonResult(await runCommandViaMcp(input)));

server.registerTool("inspect_task_state", {
  title: "Inspect Task State",
  description: "Inspect task status, commands, worker state, changed files, and summary.",
  inputSchema: { task_id: z.string() },
}, async (input) => jsonResult(await inspectTaskStateViaMcp(input)));

server.registerTool("inspect_worker", {
  title: "Inspect Worker",
  description: "Inspect worker mode, status, heartbeat, active command, and command summaries.",
  inputSchema: { worker_id: z.string() },
}, async (input) => jsonResult(await inspectWorkerViaMcp(input)));

server.registerTool("stop_worker", {
  title: "Stop Worker",
  description: "Stop a worker through its WorkerManager.",
  inputSchema: { worker_id: z.string(), session_id: z.string().optional() },
  outputSchema: { status: z.string() },
}, async (input) => jsonResult(await stopWorkerViaMcp(input)));

server.registerTool("list_workers", {
  title: "List Workers",
  description: "List workers through the typed operator action layer.",
  inputSchema: { session_id: z.string().optional() },
}, async (input) => jsonResult(await listWorkersViaMcp(input)));

server.registerTool("start_worker", {
  title: "Start Worker",
  description: "Start a local, Docker local, or GCP VM worker through the typed operator action layer.",
  inputSchema: {
    session_id: z.string().optional(),
    task_id: z.string().optional(),
    project_id: z.string().optional(),
    worker_mode: z.enum(["local", "docker_local", "gcp_vm"]).optional(),
  },
}, async (input) => jsonResult(await startWorkerViaMcp(input)));

server.registerTool("restart_worker", {
  title: "Restart Worker",
  description: "Restart a worker through the typed operator action layer. Active workers require approval.",
  inputSchema: {
    session_id: z.string().optional(),
    worker_id: z.string(),
  },
}, async (input) => jsonResult(await restartWorkerViaMcp(input)));

server.registerTool("run_worker_command", {
  title: "Run Worker Command",
  description: "Run a safe command through CommandRunner and the typed operator action layer.",
  inputSchema: {
    session_id: z.string().optional(),
    task_id: z.string().optional(),
    project_id: z.string().optional(),
    worker_id: z.string().optional(),
    command: z.string().min(1),
    cwd: z.string().optional(),
  },
}, async (input) => jsonResult(await runWorkerCommandViaMcp(input)));

server.registerTool("inspect_command", {
  title: "Inspect Command",
  description: "Inspect the current or selected command event through the typed operator action layer.",
  inputSchema: {
    session_id: z.string().optional(),
    task_id: z.string().optional(),
    command_id: z.string().optional(),
  },
}, async (input) => jsonResult(await inspectCommandViaMcp(input)));

server.registerTool("tail_logs", {
  title: "Tail Logs",
  description: "Tail worker, task, or API event logs with redaction through the typed operator action layer.",
  inputSchema: {
    session_id: z.string().optional(),
    task_id: z.string().optional(),
    worker_id: z.string().optional(),
    lines: z.number().int().positive().optional(),
    kind: z.enum(["worker", "task", "api"]).optional(),
  },
}, async (input) => jsonResult(await tailLogsViaMcp(input)));

server.registerTool("cleanup_idle_workers", {
  title: "Cleanup Idle Workers",
  description: "Stop idle or expired workers through the typed operator action layer.",
  inputSchema: { session_id: z.string().optional() },
}, async (input) => jsonResult(await cleanupIdleWorkersViaMcp(input)));

server.registerTool("inspect_codex_history", {
  title: "Inspect Codex History",
  description: "Inspect worker Codex history metadata for the active or selected command.",
  inputSchema: {
    session_id: z.string().optional(),
    task_id: z.string().optional(),
    command_id: z.string().optional(),
  },
}, async (input) => jsonResult(await inspectCodexHistoryViaMcp(input)));

server.registerTool("generate_task_summary", {
  title: "Generate Task Summary",
  description: "Generate a task summary grounded in stored task and command events.",
  inputSchema: { task_id: z.string() },
}, async (input) => jsonResult(await generateTaskSummaryViaMcp(input)));

server.registerTool("request_approval", {
  title: "Request Approval",
  description: "Create an approval request for a risky action.",
  inputSchema: {
    task_id: z.string(),
    action: z.string().min(1),
    reason: z.string().min(1),
    risk_level: z.enum(["low", "medium", "high", "blocked"]),
  },
  outputSchema: {
    approval_id: z.string(),
    status: z.string(),
  },
}, async (input) => jsonResult(await requestApprovalViaMcp(input)));

server.registerTool("list_gcp_workers", {
  title: "List GCP Workers",
  description: "List active GCP VM workers from orchestrator state and optional gcloud read-only inspection.",
  inputSchema: { env: z.string().default("dev") },
}, async (input) => jsonResult(await listGcpWorkersViaMcp(input)));

server.registerTool("cleanup_expired_workers", {
  title: "Cleanup Expired Workers",
  description: "Stop expired workers through WorkerManager. Deletion remains disabled until approval wiring is explicit.",
  inputSchema: { max_age_minutes: z.number().int().positive() },
  outputSchema: {
    workers_stopped: z.array(z.string()),
    workers_deleted: z.array(z.string()),
  },
}, async (input) => jsonResult(await cleanupExpiredWorkersViaMcp(input)));

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("Head Developer product MCP server running on stdio.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
