import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ParsedArgs = {
  repo: string;
  timeoutMs: number;
  goal: string;
};

function usage() {
  return [
    "Usage: npm run codex:local -- [--repo <path>] [--timeout-ms <ms>] \"build request\"",
    "",
    "Runs one real local Codex CLI orchestrator session and prints the subagent flowchart.",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  let repo = process.cwd();
  let timeoutMs = 10 * 60 * 1000;
  const goalParts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--repo") {
      repo = argv[index + 1] ?? "";
      index += 1;
    } else if (item === "--timeout-ms") {
      timeoutMs = Number(argv[index + 1] ?? "");
      index += 1;
    } else if (item === "--help" || item === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      goalParts.push(item);
    }
  }
  const goal = goalParts.join(" ").trim();
  if (!repo || !goal || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error(usage());
    process.exit(1);
  }
  return { repo: path.resolve(repo), timeoutMs, goal };
}

function setDefaultEnv(repo: string) {
  fs.mkdirSync(repo, { recursive: true });
  const realRepo = fs.realpathSync(repo);
  const workspaceRoot = path.dirname(realRepo);
  const stateDir = path.join(realRepo, ".head-developer", "cli-state-store");
  fs.mkdirSync(stateDir, { recursive: true });

  process.env.CODEX_PHONE_SUPERVISOR_HOST ??= "127.0.0.1";
  process.env.CODEX_PHONE_SUPERVISOR_PORT ??= "0";
  process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS ??= "http://127.0.0.1:4318";
  process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND ??= "codex";
  process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME ??= process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH ??= workspaceRoot;
  process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT ??= workspaceRoot;
  process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS ??= workspaceRoot;
  process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR ??= stateDir;
  process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR ??= "codex-phone-supervisor/frontend/dist";
  process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS ??= "5000";
  process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS ??= "25";
  process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE ??= "1";
  process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL ??= "deterministic";
  process.env.CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL ??= "";
  process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED ??= "0";
  process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED ??= "0";
  process.env.SUPERVISOR_MODEL_PROVIDER ??= "codex_cli";
  process.env.TWILIO_SMS_ENABLED ??= "0";
  process.env.TWILIO_VOICE_ENABLED ??= "0";
  process.env.TWILIO_VALIDATE_SIGNATURES ??= "0";
  process.env.TWILIO_AUTH_TOKEN ??= "";
  process.env.TWILIO_CONVERSATION_RELAY_WS_URL ??= "";
  process.env.WORKER_MODE ??= "codex_session_local";
  process.env.DEFAULT_WORKER_MODE ??= "codex_session_local";
  process.env.HEAD_DEVELOPER_STATE_STORE ??= "file";
  process.env.CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES ??= "1";
}

function mermaidSafe(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, " ");
}

function renderSubagentFlowchart(flowchart: { nodes: any[]; edges: any[] }, taskId: string) {
  const keep = new Set<string>();
  for (const node of flowchart.nodes) {
    if (
      node.id === `task:${taskId}` ||
      node.id === `codex_session:${taskId}` ||
      node.id === `files_changed:${taskId}` ||
      node.id === `validation:${taskId}` ||
      node.id === `final_summary:${taskId}` ||
      node.detail?.task_id === taskId ||
      node.detail?.task?.task_id === taskId ||
      node.detail?.validation?.task_id === taskId
    ) {
      keep.add(node.id);
    }
  }
  for (const edge of flowchart.edges) {
    if (keep.has(edge.from) || keep.has(edge.to)) {
      keep.add(edge.from);
      keep.add(edge.to);
    }
  }

  const idMap = new Map<string, string>();
  [...keep].forEach((id, index) => idMap.set(id, `n${index}`));
  const lines = ["flowchart TD"];
  for (const node of flowchart.nodes.filter((item) => keep.has(item.id))) {
    const label = `${node.label || node.type}\\n${node.status || node.visual_state || ""}`;
    lines.push(`  ${idMap.get(node.id)}["${mermaidSafe(label)}"]`);
  }
  for (const edge of flowchart.edges.filter((item) => keep.has(item.from) && keep.has(item.to))) {
    lines.push(`  ${idMap.get(edge.from)} -->|"${mermaidSafe(edge.label || "")}"| ${idMap.get(edge.to)}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  setDefaultEnv(args.repo);

  const [{ createSession }, store, projectStore, localCodex, flowchartModule] = await Promise.all([
    import("../backend/src/session.js"),
    import("../backend/src/store.js"),
    import("../backend/src/project-store.js"),
    import("../backend/src/codex-session-local.js"),
    import("../backend/src/flowchart.js"),
  ]);

  const project = projectStore.projectRecordForWorkspace(args.repo);
  projectStore.upsertProject(project);

  const session = createSession(args.goal, project.workspace_path);
  session.channel = "operator";
  session.user_id = "local-codex-cli";
  session.project_id = project.project_id;
  session.current_project_id = project.project_id;
  session.workspace_path = project.workspace_path;
  session.project_discovery.status = "selected";
  session.project_discovery.selected_workspace_path = project.workspace_path;
  session.project_discovery.selected_project_name = project.display_name;
  store.upsertSession(session);

  console.log(`Talking directly to Codex as local CLI orchestrator.`);
  console.log(`Repo: ${project.workspace_path}`);
  console.log(`Request: ${args.goal}`);

  const started = localCodex.startLocalCodexSession({ session, project, userGoal: args.goal });
  console.log(`Started task: ${started.task.task_id}`);

  const deadline = Date.now() + args.timeoutMs;
  let task = store.getTask(started.task.task_id);
  while (Date.now() < deadline && task && task.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    task = store.getTask(started.task.task_id);
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  task = store.getTask(started.task.task_id);
  const flowchart = flowchartModule.buildFlowchartState();
  const subagents = task?.codex_subagents ?? [];

  console.log(`Status: ${task?.status ?? "unknown"}`);
  console.log(`Files changed: ${(task?.files_changed ?? []).join(", ") || "none recorded"}`);
  console.log(`Validation: ${task?.local_validation_result?.status ?? "not recorded"}`);
  console.log(`Codex session: ${task?.codex_session_id ?? "not emitted"}`);
  console.log(`Codex rollout: ${task?.codex_rollout_host_path ?? task?.codex_rollout_path ?? "not detected"}`);
  console.log("");
  console.log("Subagents:");
  if (subagents.length) {
    for (const subagent of subagents) {
      console.log(`- ${subagent.name}: ${subagent.responsibility || subagent.summary} (${subagent.status})`);
    }
  } else {
    console.log("- Codex did not report separate logical subagents.");
  }
  console.log("");
  console.log("Mermaid flowchart:");
  console.log(renderSubagentFlowchart(flowchart, started.task.task_id));

  if (!task || task.status === "running") {
    console.error(`Timed out waiting for task ${started.task.task_id}.`);
    process.exit(2);
  }
  if (task.status !== "completed") process.exit(1);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
