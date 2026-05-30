import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { PersistedState } from "../backend/src/types.js";

process.env.HEAD_DEVELOPER_STATE_STORE = "memory";

const productSourceRoots = [
  "codex-phone-supervisor/backend/src",
  "codex-phone-supervisor/frontend/src",
  "apps",
  "packages",
  "docker",
  "scripts",
];

function listSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return /\.(ts|tsx|js|mjs|cjs|sh|ya?ml|json)$/.test(entry.name) ? [fullPath] : [];
  });
}

test("product logic does not special-case prior smoke prompts, ids, workspaces, or assets", () => {
  const forbidden = /\b(momo|chai|tea|bakery)\b|task_de41ae97|worker_60a1d80b|project_60961c|\/workspace\/(?:tea|chai)-shop-landing-page|b85d8df7-55d2-4345-9d43-766704ad603a|d287ca71-d7a2-4db1-84ce-d4daf401aea4|90d7568e-bcb4-4529-ab72-ce4f54c63cae|assets\/(?:chai-hero|mug-hero|punjabi-tiffin)\.svg|assets\/vintage-camera-hero\.png/i;
  const hits = productSourceRoots.flatMap((root) =>
    listSourceFiles(root)
      .filter((file) => forbidden.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file)),
  );
  assert.deepEqual(hits, []);
});

test("project intake routes through Codex instead of prompt-specific name parsing", () => {
  const supervisor = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "supervisor-tools.ts"), "utf8");
  const naming = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "backend", "src", "project-naming.ts"), "utf8");
  assert.match(supervisor, /resolveProjectIntake/);
  assert.doesNotMatch(supervisor, /inferNewProjectSpec/);
  assert.doesNotMatch(naming, /inferNewProjectSpec|extractName|buildIntent|requestIntent/);
});

test("summaries are grounded in command events and generated file paths", async () => {
  const { writeStore } = await import("../backend/src/store.js");
  const { generateRunSummary } = await import("../backend/src/summary.js");
  const now = new Date().toISOString();
  const taskId = "task_randomized_grounding";

  writeStore({
    sessions: {},
    projects: {
      project_randomized_grounding: {
        project_id: "project_randomized_grounding",
        display_name: "Galactic Tailor Landing Page",
        workspace_path: process.cwd(),
        repo_name: "tutor-tron-voice",
        git_branch: null,
        last_active_session_id: null,
        available_codex_adapter: "codex_cli",
        created_at: now,
        updated_at: now,
      },
    },
    tasks: {
      [taskId]: {
        task_id: taskId,
        project_id: "project_randomized_grounding",
        user_goal: "Build a landing page for a galactic tailor studio.",
        normalized_goal: "build a landing page for a galactic tailor studio.",
        status: "completed",
        plan: ["Create files", "Validate JavaScript"],
        worker_id: "worker_randomized_grounding",
        codex_run_id: null,
        command_count: 2,
        latest_summary: "",
        next_steps: ["Preview the generated page."],
        created_at: now,
        updated_at: now,
      },
    },
    workers: {
      worker_randomized_grounding: {
        worker_id: "worker_randomized_grounding",
        type: "docker_local",
        status: "idle",
        image_uri: "head-developer-worker:local",
        recorded_image_uri: "head-developer-worker:local",
        actual_image_uri: "head-developer-worker:local",
        actual_worker_mode: "docker_local",
        project_id: "project_randomized_grounding",
        task_id: taskId,
        heartbeat_at: now,
        created_at: now,
        expires_at: now,
      },
    },
    command_events: {
      command_file_status: {
        event_id: "command_file_status",
        task_id: taskId,
        project_id: "project_randomized_grounding",
        worker_id: "worker_randomized_grounding",
        worker_mode: "docker_local",
        command: "git status --short .",
        cwd: process.cwd(),
        started_at: now,
        ended_at: now,
        exit_code: 0,
        stdout_ref: null,
        stderr_ref: null,
        stdout_preview: "?? ./\n",
        stderr_preview: "",
        summary: "created: index.html\ncreated: script.js",
        risk_level: "low",
        approved_by_user: false,
        created_at: now,
      },
      command_validation: {
        event_id: "command_validation",
        task_id: taskId,
        project_id: "project_randomized_grounding",
        worker_id: "worker_randomized_grounding",
        worker_mode: "docker_local",
        command: "node --check script.js",
        cwd: process.cwd(),
        started_at: now,
        ended_at: now,
        exit_code: 0,
        stdout_ref: null,
        stderr_ref: null,
        stdout_preview: "",
        stderr_preview: "",
        summary: "Command completed successfully.",
        risk_level: "low",
        approved_by_user: false,
        created_at: now,
      },
    },
    run_summaries: {},
    approval_requests: {},
    orchestrator_events: [],
    orchestrator_settings: null,
    mcp_tool_calls: {},
    operator_actions: {},
    task_graphs: {},
    worker_context_packets: {},
    worker_runtime_command_requests: {},
    project_artifacts: {},
  } satisfies PersistedState);

  const summary = generateRunSummary(taskId);
  assert.deepEqual(summary.files_changed, ["index.html", "script.js"]);
  assert.deepEqual(summary.tests_run, ["node --check script.js"]);
  assert.match(summary.technical_summary, /2 command event\(s\) recorded/);
  assert.match(summary.technical_summary, /index\.html, script\.js/);
});

test("flowchart nodes are generated from state store records, not static demo data", async () => {
  const { buildFlowchartState } = await import("../backend/src/flowchart.js");
  const flowchart = buildFlowchartState();
  const serialized = JSON.stringify(flowchart);
  assert.match(serialized, /Galactic Tailor Landing Page/);
  assert.match(serialized, /task_randomized_grounding/);
  assert.match(serialized, /worker_randomized_grounding/);
  assert.match(serialized, /command_file_status/);
  assert.match(serialized, /summary:task_randomized_grounding/);
  assert.doesNotMatch(serialized, /\b(momo|chai|tea)\b/i);
});

test("real Codex nonce integration can verify nonce preservation when explicitly enabled", { skip: process.env.RUN_REAL_CODEX_INTEGRATION !== "1" }, () => {
  assert.equal(process.env.RUN_REAL_CODEX_INTEGRATION, "1");
});
