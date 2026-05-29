import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

function bootstrapEnv(storeDir: string) {
  return `
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = process.execPath;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR = ${JSON.stringify(storeDir)};
    process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR = "codex-phone-supervisor/frontend/dist";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS = "5000";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS = "25";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE = "1";
    process.env.CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL = "";
    process.env.SUPERVISOR_MODEL_PROVIDER = "codex_cli";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL = "deterministic";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
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
  });
}

test("silence watchdog sends grounded progress and stale-worker updates", () => {
  const storeDir = path.join(process.cwd(), "tmp", `progress-watchdog-test-${Date.now()}`);
  const script = `
    ${bootstrapEnv(storeDir)}

    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { startProgressBroadcaster, runSilenceWatchdogOnce, stopProgressBroadcasterForTests } = await import("./codex-phone-supervisor/backend/src/progress-broadcaster.ts");
    const { upsertSession, upsertTask, upsertWorker, getSession, listOrchestratorEvents } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const now = Date.now();
    const session = createSession("watchdog smoke", process.cwd());
    session.channel = "web_text";
    session.active_task_id = "task_watchdog";
    session.active_worker_id = "worker_watchdog";
    session.current_project_id = "project_watchdog";
    session.project_id = "project_watchdog";
    upsertSession(session);
    upsertTask({
      task_id: "task_watchdog",
      project_id: "project_watchdog",
      user_goal: "Run a long task",
      normalized_goal: "run a long task",
      status: "running",
      plan: ["Wait for worker result."],
      worker_id: "worker_watchdog",
      codex_run_id: null,
      command_count: 0,
      latest_summary: "Task is running.",
      next_steps: ["Wait for command result."],
      created_at: new Date(now - 120000).toISOString(),
      updated_at: new Date(now - 120000).toISOString()
    });
    upsertWorker({
      worker_id: "worker_watchdog",
      type: "local",
      status: "running",
      image_uri: "local-dev-worker",
      project_id: "project_watchdog",
      task_id: "task_watchdog",
      heartbeat_at: new Date(now - 90000).toISOString(),
      created_at: new Date(now - 120000).toISOString(),
      expires_at: new Date(now + 600000).toISOString()
    });

    startProgressBroadcaster();
    runSilenceWatchdogOnce(now);
    const latest = getSession(session.session_id);
    const staleEvents = listOrchestratorEvents("worker_watchdog").filter((event) => event.type === "worker.stale");
    const progress = latest.raw_events.filter((event) => event.type === "progress.update");
    stopProgressBroadcasterForTests();
    console.log(JSON.stringify({
      staleEvents: staleEvents.length,
      progressMessages: progress.map((event) => event.message),
      progressData: progress.map((event) => event.data)
    }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { staleEvents: number; progressMessages: string[]; progressData: Array<{ source_event_type?: string; task_id?: string; worker_id?: string }> };
  assert.equal(payload.staleEvents, 1);
  assert.ok(payload.progressMessages.some((message) => /has not sent a heartbeat/i.test(message)));
  assert.ok(payload.progressData.some((data) => data.source_event_type === "worker.stale" && data.task_id === "task_watchdog" && data.worker_id === "worker_watchdog"));
});

test("long-running stale heartbeat progress is emitted once for unchanged state", () => {
  const storeDir = path.join(process.cwd(), "tmp", `progress-stale-dedupe-test-${Date.now()}`);
  const script = `
    ${bootstrapEnv(storeDir)}

    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { startProgressBroadcaster, runSilenceWatchdogOnce, stopProgressBroadcasterForTests } = await import("./codex-phone-supervisor/backend/src/progress-broadcaster.ts");
    const { upsertCommandEvent, upsertSession, upsertTask, upsertWorker, getSession, listOrchestratorEvents } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const now = Date.now();
    const session = createSession("stale dedupe smoke", process.cwd());
    session.channel = "web_text";
    session.active_task_id = "task_stale_dedupe";
    session.active_worker_id = "worker_stale_dedupe";
    session.current_project_id = "project_stale_dedupe";
    session.project_id = "project_stale_dedupe";
    upsertSession(session);
    upsertTask({
      task_id: "task_stale_dedupe",
      project_id: "project_stale_dedupe",
      user_goal: "Run a long Codex task",
      normalized_goal: "run a long codex task",
      status: "running",
      plan: ["Wait for command."],
      worker_id: "worker_stale_dedupe",
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Task is running.",
      next_steps: ["Wait for command result."],
      created_at: new Date(now - 120000).toISOString(),
      updated_at: new Date(now - 120000).toISOString()
    });
    upsertWorker({
      worker_id: "worker_stale_dedupe",
      type: "docker_local",
      status: "running",
      image_uri: "head-developer-worker:local",
      project_id: "project_stale_dedupe",
      task_id: "task_stale_dedupe",
      heartbeat_at: new Date(now - 90000).toISOString(),
      created_at: new Date(now - 120000).toISOString(),
      expires_at: new Date(now + 600000).toISOString()
    });
    upsertCommandEvent({
      event_id: "cmd_stale_dedupe",
      task_id: "task_stale_dedupe",
      project_id: "project_stale_dedupe",
      worker_id: "worker_stale_dedupe",
      command: "codex exec demo",
      cwd: process.cwd(),
      started_at: new Date(now - 80000).toISOString(),
      ended_at: null,
      exit_code: null,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: "Command is running.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date(now - 80000).toISOString()
    });

    startProgressBroadcaster();
    runSilenceWatchdogOnce(now);
    runSilenceWatchdogOnce(now + 70000);
    const latest = getSession(session.session_id);
    const progress = latest.raw_events.filter((event) => event.type === "progress.update");
    const staleProgress = progress.filter((event) => /has not sent a heartbeat/i.test(event.message));
    const staleEvents = listOrchestratorEvents("worker_stale_dedupe").filter((event) => event.type === "worker.stale");
    stopProgressBroadcasterForTests();
    console.log(JSON.stringify({
      staleProgressCount: staleProgress.length,
      staleEventCount: staleEvents.length,
      staleKinds: staleProgress.map((event) => event.data?.progress_kind),
      staleDedupeKeys: [...new Set(staleProgress.map((event) => event.data?.progress_dedupe_key))]
    }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { staleProgressCount: number; staleEventCount: number; staleKinds: string[]; staleDedupeKeys: string[] };
  assert.equal(payload.staleProgressCount, 1);
  assert.equal(payload.staleEventCount, 1);
  assert.deepEqual(payload.staleKinds, ["stale_heartbeat"]);
  assert.equal(payload.staleDedupeKeys.length, 1);
});

test("stale heartbeat is not emitted after task completion", () => {
  const storeDir = path.join(process.cwd(), "tmp", `progress-completed-no-stale-test-${Date.now()}`);
  const script = `
    ${bootstrapEnv(storeDir)}

    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { startProgressBroadcaster, runSilenceWatchdogOnce, stopProgressBroadcasterForTests } = await import("./codex-phone-supervisor/backend/src/progress-broadcaster.ts");
    const { upsertSession, upsertTask, upsertWorker, getSession, listOrchestratorEvents } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const now = Date.now();
    const session = createSession("completed no stale smoke", process.cwd());
    session.channel = "web_text";
    session.active_task_id = "task_completed_no_stale";
    session.active_worker_id = "worker_completed_no_stale";
    session.current_project_id = "project_completed_no_stale";
    session.project_id = "project_completed_no_stale";
    upsertSession(session);
    upsertTask({
      task_id: "task_completed_no_stale",
      project_id: "project_completed_no_stale",
      user_goal: "Build a landing page",
      normalized_goal: "build a landing page",
      status: "completed",
      plan: ["Done."],
      worker_id: "worker_completed_no_stale",
      codex_run_id: null,
      command_count: 3,
      latest_summary: "Task completed.",
      next_steps: ["Preview."],
      created_at: new Date(now - 120000).toISOString(),
      updated_at: new Date(now - 60000).toISOString()
    });
    upsertWorker({
      worker_id: "worker_completed_no_stale",
      type: "docker_local",
      status: "idle",
      image_uri: "head-developer-worker:local",
      project_id: "project_completed_no_stale",
      task_id: "task_completed_no_stale",
      heartbeat_at: new Date(now - 120000).toISOString(),
      created_at: new Date(now - 180000).toISOString(),
      expires_at: new Date(now + 600000).toISOString()
    });

    startProgressBroadcaster();
    runSilenceWatchdogOnce(now);
    const latest = getSession(session.session_id);
    const progress = latest.raw_events.filter((event) => event.type === "progress.update");
    const staleEvents = listOrchestratorEvents("worker_completed_no_stale").filter((event) => event.type === "worker.stale");
    stopProgressBroadcasterForTests();
    console.log(JSON.stringify({
      staleEvents: staleEvents.length,
      staleProgress: progress.filter((event) => /heartbeat/i.test(event.message)).length
    }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { staleEvents: number; staleProgress: number };
  assert.equal(payload.staleEvents, 0);
  assert.equal(payload.staleProgress, 0);
});

test("unchanged latest-known-state watchdog updates are not repeated", () => {
  const storeDir = path.join(process.cwd(), "tmp", `progress-latest-known-dedupe-test-${Date.now()}`);
  const script = `
    ${bootstrapEnv(storeDir)}

    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { startProgressBroadcaster, runSilenceWatchdogOnce, stopProgressBroadcasterForTests } = await import("./codex-phone-supervisor/backend/src/progress-broadcaster.ts");
    const { upsertCommandEvent, upsertSession, upsertTask, upsertWorker, getSession } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const now = Date.now();
    const session = createSession("latest known dedupe smoke", process.cwd());
    session.channel = "web_text";
    session.active_task_id = "task_latest_known";
    session.active_worker_id = "worker_latest_known";
    session.current_project_id = "project_latest_known";
    session.project_id = "project_latest_known";
    upsertSession(session);
    upsertTask({
      task_id: "task_latest_known",
      project_id: "project_latest_known",
      user_goal: "Run Codex",
      normalized_goal: "run codex",
      status: "running",
      plan: ["Wait for command."],
      worker_id: "worker_latest_known",
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Task is running.",
      next_steps: ["Wait for command result."],
      created_at: new Date(now - 120000).toISOString(),
      updated_at: new Date(now - 120000).toISOString()
    });
    upsertWorker({
      worker_id: "worker_latest_known",
      type: "docker_local",
      status: "running",
      image_uri: "head-developer-worker:local",
      project_id: "project_latest_known",
      task_id: "task_latest_known",
      heartbeat_at: new Date(now - 10000).toISOString(),
      created_at: new Date(now - 120000).toISOString(),
      expires_at: new Date(now + 600000).toISOString()
    });
    upsertCommandEvent({
      event_id: "cmd_latest_known",
      task_id: "task_latest_known",
      project_id: "project_latest_known",
      worker_id: "worker_latest_known",
      command: "codex exec demo",
      cwd: process.cwd(),
      started_at: new Date(now - 80000).toISOString(),
      ended_at: null,
      exit_code: null,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: "Command is running.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date(now - 80000).toISOString()
    });

    startProgressBroadcaster();
    runSilenceWatchdogOnce(now);
    runSilenceWatchdogOnce(now + 70000);
    const latest = getSession(session.session_id);
    const progress = latest.raw_events.filter((event) => event.type === "progress.update");
    stopProgressBroadcasterForTests();
    console.log(JSON.stringify({
      latestKnownCount: progress.filter((event) => event.data?.progress_kind === "latest_known_state").length,
      messages: progress.map((event) => event.message)
    }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { latestKnownCount: number; messages: string[] };
  assert.equal(payload.latestKnownCount, 1);
  assert.equal(new Set(payload.messages).size, payload.messages.length);
});

test("stale heartbeat is not repeated when only the latest command changes", () => {
  const storeDir = path.join(process.cwd(), "tmp", `progress-stale-command-change-test-${Date.now()}`);
  const script = `
    ${bootstrapEnv(storeDir)}

    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { startProgressBroadcaster, runSilenceWatchdogOnce, stopProgressBroadcasterForTests } = await import("./codex-phone-supervisor/backend/src/progress-broadcaster.ts");
    const { upsertCommandEvent, upsertSession, upsertTask, upsertWorker, getSession } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const now = Date.now();
    const session = createSession("stale command change smoke", process.cwd());
    session.channel = "web_text";
    session.active_task_id = "task_stale_command_change";
    session.active_worker_id = "worker_stale_command_change";
    session.current_project_id = "project_stale_command_change";
    session.project_id = "project_stale_command_change";
    upsertSession(session);
    upsertTask({
      task_id: "task_stale_command_change",
      project_id: "project_stale_command_change",
      user_goal: "Run Codex",
      normalized_goal: "run codex",
      status: "running",
      plan: ["Run commands."],
      worker_id: "worker_stale_command_change",
      codex_run_id: null,
      command_count: 1,
      latest_summary: "Task is running.",
      next_steps: ["Validate."],
      created_at: new Date(now - 120000).toISOString(),
      updated_at: new Date(now - 120000).toISOString()
    });
    upsertWorker({
      worker_id: "worker_stale_command_change",
      type: "docker_local",
      status: "running",
      image_uri: "head-developer-worker:local",
      project_id: "project_stale_command_change",
      task_id: "task_stale_command_change",
      heartbeat_at: new Date(now - 90000).toISOString(),
      created_at: new Date(now - 120000).toISOString(),
      expires_at: new Date(now + 600000).toISOString()
    });
    upsertCommandEvent({
      event_id: "cmd_codex_done",
      task_id: "task_stale_command_change",
      project_id: "project_stale_command_change",
      worker_id: "worker_stale_command_change",
      command: "codex exec demo",
      cwd: process.cwd(),
      started_at: new Date(now - 80000).toISOString(),
      ended_at: new Date(now - 10000).toISOString(),
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: "Command completed successfully.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date(now - 80000).toISOString()
    });

    startProgressBroadcaster();
    runSilenceWatchdogOnce(now);
    upsertCommandEvent({
      event_id: "cmd_git_done",
      task_id: "task_stale_command_change",
      project_id: "project_stale_command_change",
      worker_id: "worker_stale_command_change",
      command: "git status --short .",
      cwd: process.cwd(),
      started_at: new Date(now + 10000).toISOString(),
      ended_at: new Date(now + 11000).toISOString(),
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: "Command completed successfully.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date(now + 10000).toISOString()
    });
    runSilenceWatchdogOnce(now + 70000);
    const latest = getSession(session.session_id);
    const progress = latest.raw_events.filter((event) => event.type === "progress.update");
    stopProgressBroadcasterForTests();
    console.log(JSON.stringify({
      staleProgressCount: progress.filter((event) => event.data?.progress_kind === "stale_heartbeat").length,
      staleMessages: progress.filter((event) => event.data?.progress_kind === "stale_heartbeat").map((event) => event.message)
    }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { staleProgressCount: number; staleMessages: string[] };
  assert.equal(payload.staleProgressCount, 1);
  assert.equal(new Set(payload.staleMessages).size, payload.staleMessages.length);
});

test("completed docker_local worker node is not shown as stale", () => {
  const storeDir = path.join(process.cwd(), "tmp", `flowchart-completed-worker-test-${Date.now()}`);
  const script = `
    ${bootstrapEnv(storeDir)}

    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");
    const { upsertTask, upsertWorker } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const now = Date.now();
    upsertTask({
      task_id: "task_flow_completed",
      project_id: "project_flow_completed",
      user_goal: "Build a completed app",
      normalized_goal: "build a completed app",
      status: "completed",
      plan: ["Done."],
      worker_id: "worker_flow_completed",
      codex_run_id: null,
      command_count: 3,
      latest_summary: "Task completed.",
      next_steps: ["Preview."],
      created_at: new Date(now - 120000).toISOString(),
      updated_at: new Date(now - 30000).toISOString()
    });
    upsertWorker({
      worker_id: "worker_flow_completed",
      type: "docker_local",
      status: "idle",
      image_uri: "head-developer-worker:local",
      project_id: "project_flow_completed",
      task_id: "task_flow_completed",
      heartbeat_at: new Date(now - 120000).toISOString(),
      created_at: new Date(now - 180000).toISOString(),
      expires_at: new Date(now + 600000).toISOString()
    });

    const flowchart = buildFlowchartState();
    const workerNode = flowchart.nodes.find((node) => node.id === "worker:worker_flow_completed");
    console.log(JSON.stringify({
      status: workerNode?.status,
      visualState: workerNode?.visual_state,
      badges: workerNode?.badges
    }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { status: string; visualState: string; badges: string[] };
  assert.equal(payload.status, "idle");
  assert.equal(payload.visualState, "idle");
  assert.ok(!payload.badges.some((badge) => /stale/i.test(badge)));
});

test("progress broadcaster suppresses duplicate progress updates for the same source event", () => {
  const storeDir = path.join(process.cwd(), "tmp", `progress-duplicate-test-${Date.now()}`);
  const script = `
    ${bootstrapEnv(storeDir)}

    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { publishProgressUpdate } = await import("./codex-phone-supervisor/backend/src/progress-broadcaster.ts");
    const { getSession, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");

    const session = createSession("duplicate progress smoke", process.cwd());
    session.channel = "web_text";
    upsertSession(session);

    const first = publishProgressUpdate(session, "Worker is running pwd.", { event_id: "event_same", type: "command.started" });
    const latest = getSession(session.session_id);
    const second = publishProgressUpdate(latest, "Worker is running pwd.", { event_id: "event_same", type: "command.started" });
    const finalSession = getSession(session.session_id);
    const progress = finalSession.raw_events.filter((event) => event.type === "progress.update");
    console.log(JSON.stringify({
      firstCreated: Boolean(first),
      secondCreated: Boolean(second),
      progressCount: progress.length,
      assistantMessages: finalSession.recent_messages.filter((message) => message.role === "assistant").length,
      dedupeKey: progress[0]?.data?.progress_dedupe_key
    }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
    firstCreated: boolean;
    secondCreated: boolean;
    progressCount: number;
    assistantMessages: number;
    dedupeKey?: string;
  };
  assert.equal(payload.firstCreated, true);
  assert.equal(payload.secondCreated, false);
  assert.equal(payload.progressCount, 1);
  assert.equal(payload.assistantMessages, 1);
  assert.ok(payload.dedupeKey);
});

test("voice summary stays shorter than text summary", () => {
  const storeDir = path.join(process.cwd(), "tmp", `voice-summary-length-test-${Date.now()}`);
  const script = `
    ${bootstrapEnv(storeDir)}

    const { voiceFriendlySummary } = await import("./codex-phone-supervisor/backend/src/summary.ts");
    const summary = {
      task_id: "task_voice",
      executive_summary: "Codex created the momo landing page and validation passed.",
      technical_summary: "The worker created HTML, CSS, and JavaScript files, captured command output, inspected changed files, ran validation, and generated a grounded run summary from recorded events.",
      commands_run: ["pwd", "npm run build", "npm test"],
      files_changed: ["index.html", "styles.css", "app.js"],
      tests_run: ["npm test"],
      failures: [],
      current_state: "completed",
      next_plan: ["Preview the app or deploy it after approval."],
      confidence: "high",
      created_at: new Date().toISOString()
    };
    const textSummary = summary.executive_summary + " " + summary.technical_summary + " Commands run: " + summary.commands_run.join(", ") + ". Files changed: " + summary.files_changed.join(", ") + ".";
    const voiceSummary = voiceFriendlySummary(summary);
    console.log(JSON.stringify({ textLength: textSummary.length, voiceLength: voiceSummary.length, voiceSummary }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { textLength: number; voiceLength: number; voiceSummary: string };
  assert.ok(payload.voiceLength < payload.textLength);
  assert.doesNotMatch(payload.voiceSummary, /HTML, CSS, and JavaScript files, captured command output/i);
});
