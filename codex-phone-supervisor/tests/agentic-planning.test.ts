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
    process.env.MAX_LOCAL_WORKERS = "1";
    process.env.MAX_DOCKER_LOCAL_WORKERS = "3";
    process.env.MAX_GCP_VM_WORKERS = "10";
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

test("agentic planner parses structured output and falls back safely on invalid model output", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-parse-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-parse-root-"));
  const projectDir = path.join(workspaceRoot, "planner-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const { parsePlannerDecision, AgenticPlanningController } = await import("./codex-phone-supervisor/backend/src/agentic-planning.ts");
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const valid = parsePlannerDecision({
      decision_type: "ask_clarification",
      confidence: 0.8,
      reason: "Need details.",
      user_visible_response: "What should it do?",
      requirements_summary: "Build an app.",
      open_questions: ["What should it do?"],
      assumptions: [],
      proposed_design: "",
      proposed_task_split: [],
      recommended_worker_count: 1,
      recommended_worker_mode: "docker_local",
      requires_user_approval: false,
      approval_reason: "",
      risk_level: "low",
      next_action: "none",
      execution_allowed: false
    });
    let invalidRejected = false;
    try {
      parsePlannerDecision({ decision_type: "nonsense", user_visible_response: "{}" });
    } catch {
      invalidRejected = true;
    }
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("bad planner", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_bad_planner";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.project_discovery.status = "selected";
    session.preferred_worker_mode = "docker_local";
    upsertSession(session);
    const badModel = {
      modelName: "bad_model",
      async generatePlanningDecision() {
        return { decision_type: "not_allowed", user_visible_response: "{bad json}" };
      }
    };
    const controller = new AgenticPlanningController(badModel);
    const planned = await controller.decide({ session, userMessage: "Build a static SaaS dashboard with landing, login, dashboard, and settings.", project, workerMode: "docker_local" });
    console.log(JSON.stringify({
      validType: valid.decision_type,
      invalidRejected,
      fallbackType: planned.decision.decision_type,
      fallbackModel: planned.planner_model,
      noRawJson: !/[{}]/.test(planned.decision.user_visible_response)
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.validType, "ask_clarification");
  assert.equal(payload.invalidRejected, true);
  assert.equal(payload.fallbackType, "propose_task_split");
  assert.match(String(payload.fallbackModel), /deterministic_fallback/);
  assert.equal(payload.noRawJson, true);
});

test("agentic planner converts human validation text into acceptance checks, not required commands", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-validation-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-validation-root-"));
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const { AgenticPlanningController } = await import("./codex-phone-supervisor/backend/src/agentic-planning.ts");
    const controller = new AgenticPlanningController({
      modelName: "unused",
      async generatePlanningDecision() {
        throw new Error("not used");
      }
    });
    const fallback = {
      complexity: "simple",
      recommended_worker_count: 1,
      should_split: false,
      parallelizable: false,
      reason: "fallback",
      suggested_subtasks: [],
      dependency_graph: [],
      risks: [],
      approval_needed: false
    };
    const complexity = controller.decisionToComplexity({
      decision_type: "start_simple_task",
      confidence: 0.9,
      reason: "clear",
      user_visible_response: "Starting.",
      requirements_summary: "Build a static form.",
      open_questions: [],
      assumptions: [],
      proposed_design: "Static app.",
      proposed_task_split: [{
        title: "Build form",
        goal: "Create a static form.",
        can_run_parallel: false,
        depends_on: [],
        expected_files: ["index.html", "script.js"],
        validation: ["Verify that the nonce appears in index.html.", "node --check script.js"]
      }],
      recommended_worker_count: 1,
      recommended_worker_mode: "docker_local",
      requires_user_approval: false,
      approval_reason: "",
      risk_level: "low",
      next_action: "launch_workers",
      execution_allowed: true
    }, fallback);
    const task = complexity.suggested_subtasks[0];
    console.log(JSON.stringify({
      validation: task.validation_commands,
      acceptance: task.acceptance_checks
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { validation?: string[]; acceptance?: string[] };
  assert.deepEqual(payload.validation, ["test -f index.html", "test -f script.js", "node --check script.js"]);
  assert.ok(payload.acceptance?.includes("Verify that the nonce appears in index.html."));
});

test("agentic planner collapses serial single-surface static splits to one worker", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-speed-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-speed-root-"));
  const projectDir = path.join(workspaceRoot, "speed-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const { AgenticPlanningController } = await import("./codex-phone-supervisor/backend/src/agentic-planning.ts");
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("speed planner", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_speed_planner";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.project_discovery.status = "selected";
    session.preferred_worker_mode = "docker_local";
    upsertSession(session);
    const serialStaticModel = {
      modelName: "serial_static_model",
      async generatePlanningDecision() {
        return {
          decision_type: "propose_task_split",
          confidence: 0.82,
          reason: "Sequential static implementation tasks.",
          user_visible_response: "I will split this into HTML, CSS, and JavaScript tasks.",
          requirements_summary: "Build a static browser form app with local storage and no backend.",
          open_questions: [],
          assumptions: ["Static HTML/CSS/JS only."],
          proposed_design: "Single static browser app.",
          proposed_task_split: [
            { title: "HTML shell", goal: "Create the form markup.", can_run_parallel: false, depends_on: [], expected_files: ["index.html"], validation: ["test -f index.html"] },
            { title: "Styles", goal: "Style the same app.", can_run_parallel: false, depends_on: ["HTML shell"], expected_files: ["styles.css"], validation: ["test -f styles.css"] },
            { title: "Client behavior", goal: "Add localStorage behavior.", can_run_parallel: false, depends_on: ["Styles"], expected_files: ["script.js"], validation: ["node --check script.js"] }
          ],
          recommended_worker_count: 3,
          recommended_worker_mode: "docker_local",
          requires_user_approval: true,
          approval_reason: "Multi-worker execution needs approval.",
          risk_level: "low",
          next_action: "none",
          execution_allowed: false
        };
      }
    };
    const controller = new AgenticPlanningController(serialStaticModel);
    const planned = await controller.decide({ session, userMessage: "Build a static form app with localStorage. No backend.", project, workerMode: "docker_local" });
    console.log(JSON.stringify({
      decisionType: planned.decision.decision_type,
      workerCount: planned.decision.recommended_worker_count,
      splitLength: planned.decision.proposed_task_split.length,
      approvalRequired: planned.decision.requires_user_approval,
      executionAllowed: planned.decision.execution_allowed,
      files: planned.decision.proposed_task_split[0]?.expected_files,
      response: planned.decision.user_visible_response
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
    decisionType?: string;
    workerCount?: number;
    splitLength?: number;
    approvalRequired?: boolean;
    executionAllowed?: boolean;
    files?: string[];
    response?: string;
  };
  assert.equal(payload.decisionType, "start_simple_task");
  assert.equal(payload.workerCount, 1);
  assert.equal(payload.splitLength, 1);
  assert.equal(payload.approvalRequired, false);
  assert.equal(payload.executionAllowed, true);
  assert.deepEqual(payload.files, ["index.html", "styles.css", "script.js"]);
  assert.match(String(payload.response), /one Docker Local worker/i);
});

test("agentic planner forces approval before cloud worker execution", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-cloud-approval-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-cloud-approval-root-"));
  const projectDir = path.join(workspaceRoot, "cloud-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    process.env.WORKER_MODE = "gke_job";
    process.env.DEFAULT_WORKER_MODE = "gke_job";
    process.env.MAX_GKE_JOB_WORKERS = "2";
    process.env.GCP_PROJECT_ID = "teamtiffy1729";
    process.env.GCP_REGION = "us-central1";
    process.env.HEAD_DEVELOPER_API_CALLBACK_URL = "https://head-developer-api.example.run.app";
    process.env.HEAD_DEVELOPER_WORKER_IMAGE_URI = "us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:test";
    process.env.HEAD_DEVELOPER_CODEX_AUTH_METHOD = "codex_home_bundle";
    process.env.HEAD_DEVELOPER_CODEX_HOME = "/codex-home";
    process.env.HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI = "gs://teamtiffy1729-head-developer-artifacts/codex-auth/codex-vm-home-bundle.tgz";
    process.env.HEAD_DEVELOPER_GKE_JOB_DRY_RUN = "1";
    const { AgenticPlanningController } = await import("./codex-phone-supervisor/backend/src/agentic-planning.ts");
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { getSession, listWorkers, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    const session = createSession("cloud approval", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_cloud_approval";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.project_discovery.status = "selected";
    session.preferred_worker_mode = "gke_job";
    upsertSession(session);
    const permissiveModel = {
      modelName: "permissive_test_model",
      async generatePlanningDecision() {
        return {
          decision_type: "start_simple_task",
          confidence: 0.9,
          reason: "Simple app.",
          user_visible_response: "I will build the app now.",
          requirements_summary: "Build a small static app.",
          open_questions: [],
          assumptions: [],
          proposed_design: "Static HTML, CSS, and JavaScript.",
          proposed_task_split: [{ title: "Build app", goal: "Create files.", can_run_parallel: false, depends_on: [], expected_files: ["index.html"], validation: ["Open in browser"] }],
          recommended_worker_count: 1,
          recommended_worker_mode: "gke_job",
          requires_user_approval: false,
          approval_reason: "",
          risk_level: "low",
          next_action: "launch_workers",
          execution_allowed: true
        };
      }
    };
    const controller = new AgenticPlanningController(permissiveModel);
    const planned = await controller.decide({ session, userMessage: "Build a landing page.", project, workerMode: "gke_job" });
    const latest = getSession(session.session_id);
    console.log(JSON.stringify({
      decisionType: planned.decision.decision_type,
      approvalRequired: planned.decision.requires_user_approval,
      executionAllowed: planned.decision.execution_allowed,
      approvalStatus: latest.approval_status,
      response: planned.decision.user_visible_response,
      workers: listWorkers().length
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.decisionType, "request_user_approval");
  assert.equal(payload.approvalRequired, true);
  assert.equal(payload.executionAllowed, false);
  assert.equal(payload.approvalStatus, "pending");
  assert.match(String(payload.response), /GKE Job workers run outside the local process|Approve this plan/i);
  assert.equal(payload.workers, 0);
});

test("supervisor does not fall through to legacy autostart for GKE design decisions", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-gke-fallback-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-gke-fallback-root-"));
  const projectDir = path.join(workspaceRoot, "gke-selected-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    process.env.WORKER_MODE = "gke_job";
    process.env.DEFAULT_WORKER_MODE = "gke_job";
    process.env.MAX_GKE_JOB_WORKERS = "2";
    process.env.GCP_PROJECT_ID = "teamtiffy1729";
    process.env.GCP_REGION = "us-central1";
    process.env.HEAD_DEVELOPER_API_CALLBACK_URL = "https://head-developer-api.example.run.app";
    process.env.HEAD_DEVELOPER_WORKER_IMAGE_URI = "us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:test";
    process.env.HEAD_DEVELOPER_CODEX_AUTH_METHOD = "codex_home_bundle";
    process.env.HEAD_DEVELOPER_CODEX_HOME = "/codex-home";
    process.env.HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI = "gs://teamtiffy1729-head-developer-artifacts/codex-auth/codex-vm-home-bundle.tgz";
    process.env.HEAD_DEVELOPER_GKE_JOB_DRY_RUN = "1";
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, listTaskGraphs, listWorkers, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    project.display_name = "GKE Selected Project";
    upsertProject(project);
    const session = createSession("gke design no autostart", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_gke_no_legacy_autostart";
    session.channel = "web_text";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = project.display_name;
    session.preferred_worker_mode = "gke_job";
    upsertSession(session);
    const response = await handleSupervisorMessage(session.session_id, "Make a quick static website for recording field notes.", "web_text");
    const revision = await handleSupervisorMessage(session.session_id, "Use static HTML, CSS, and JavaScript with localStorage before approval.", "web_text");
    const combinedRevision = await handleSupervisorMessage(session.session_id, "Use one GKE Job worker and do not deploy the generated app.", "web_text");
    const latest = getSession(session.session_id);
    console.log(JSON.stringify({
      response: response.response,
      revision: revision.response,
      combinedRevision: combinedRevision.response,
      pending: latest.pending_action?.type,
      revisedGoal: latest.pending_action?.original_user_goal,
      workerMode: latest.pending_action?.worker_mode,
      workerCount: latest.pending_action?.user_approved_worker_count,
      status: latest.current_status,
      workers: listWorkers({ projectId: project.project_id }).length,
      graphs: listTaskGraphs(project.project_id).length
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.pending, "approve_task_split");
  assert.equal(payload.status, "waiting_for_approval");
  assert.equal(payload.workers, 0);
  assert.equal(payload.graphs, 0);
  assert.match(String(payload.response), /approve|approval|GKE Job/i);
  assert.match(String(payload.revision), /updated the pending plan/i);
  assert.match(String(payload.revision), /approve/i);
  assert.match(String(payload.combinedRevision), /updated the pending plan/i);
  assert.match(String(payload.revisedGoal), /localStorage/i);
  assert.match(String(payload.revisedGoal), /do not deploy/i);
  assert.equal(payload.workerMode, "gke_job");
  assert.equal(payload.workerCount, 1);
});

test("pending task split accepts natural approval phrases", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-natural-approval-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-natural-approval-root-"));
  const projectDir = path.join(workspaceRoot, "natural-approval-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    process.env.WORKER_MODE = "gke_job";
    process.env.DEFAULT_WORKER_MODE = "gke_job";
    process.env.MAX_GKE_JOB_WORKERS = "2";
    process.env.GCP_PROJECT_ID = "teamtiffy1729";
    process.env.GCP_REGION = "us-central1";
    process.env.HEAD_DEVELOPER_API_CALLBACK_URL = "https://head-developer-api.example.run.app";
    process.env.HEAD_DEVELOPER_WORKER_IMAGE_URI = "us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:test";
    process.env.HEAD_DEVELOPER_CODEX_AUTH_METHOD = "codex_home_bundle";
    process.env.HEAD_DEVELOPER_CODEX_HOME = "/codex-home";
    process.env.HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI = "gs://teamtiffy1729-head-developer-artifacts/codex-auth/codex-vm-home-bundle.tgz";
    process.env.HEAD_DEVELOPER_GKE_JOB_DRY_RUN = "1";
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, listTaskGraphs, listWorkers, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    project.display_name = "Natural Approval Project";
    upsertProject(project);
    const session = createSession("natural approval", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_natural_approval";
    session.channel = "web_text";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = project.display_name;
    session.preferred_worker_mode = "gke_job";
    upsertSession(session);
    await handleSupervisorMessage(session.session_id, "Make a quick static website for recording tick bites.", "web_text");
    await handleSupervisorMessage(session.session_id, "Use one GKE Job worker and do not deploy the generated app.", "web_text");
    const approval = await handleSupervisorMessage(session.session_id, "Approve the plan. Start the GKE Job worker now.", "web_text");
    const latest = getSession(session.session_id);
    console.log(JSON.stringify({
      response: approval.response,
      pending: latest.pending_action?.type ?? null,
      status: latest.current_status,
      workers: listWorkers({ projectId: project.project_id }).length,
      graphs: listTaskGraphs(project.project_id).length
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.pending, null);
  assert.equal(payload.status, "running");
  assert.equal(payload.workers, 1);
  assert.match(String(payload.response), /started 1 worker/i);
});

test("agentic planning conversation handles clarification simple start approval revision GCP risk and flowchart", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-convo-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-convo-root-"));
  const projectDir = path.join(workspaceRoot, "selected-product");
  fs.mkdirSync(projectDir, { recursive: true });
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, listTaskGraphs, listWorkers, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");

    function selectedSession(id) {
      const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
      project.display_name = "Selected Product";
      upsertProject(project);
      const session = createSession(id, ${JSON.stringify(workspaceRoot)});
      session.session_id = id;
      session.channel = "web_text";
      session.project_id = project.project_id;
      session.current_project_id = project.project_id;
      session.workspace_path = project.workspace_path;
      session.project_discovery.status = "selected";
      session.project_discovery.selected_workspace_path = project.workspace_path;
      session.project_discovery.selected_project_name = project.display_name;
      session.preferred_worker_mode = "docker_local";
      upsertSession(session);
      return { session, project };
    }

    const vague = createSession("vague", ${JSON.stringify(workspaceRoot)});
    vague.session_id = "session_vague_game";
    vague.channel = "web_text";
    vague.preferred_worker_mode = "docker_local";
    upsertSession(vague);
    const vagueResponse = await handleSupervisorMessage(vague.session_id, "Build a game.", "web_text");
    const vagueWorkers = listWorkers().length;

    const simpleSession = createSession("simple landing", ${JSON.stringify(workspaceRoot)});
    simpleSession.session_id = "session_simple_landing";
    simpleSession.channel = "web_text";
    simpleSession.preferred_worker_mode = "docker_local";
    upsertSession(simpleSession);
    const simpleResponse = await handleSupervisorMessage(simpleSession.session_id, "Build a landing page for a chai shop.", "web_text");
    const simpleLatest = getSession(simpleSession.session_id);
    const simpleGraphs = listTaskGraphs(simpleLatest.project_id);
    const simpleLatestGraph = simpleGraphs[0];
    const simpleWorkers = listWorkers().filter((worker) => worker.project_id === simpleLatest.project_id).length;

    const multi = selectedSession("session_multi_planner");
    const multiResponse = await handleSupervisorMessage(multi.session.session_id, "Build a static SaaS dashboard with landing, login, dashboard, and settings.", "web_text");
    const multiAfterProposal = getSession(multi.session.session_id);
    const graphCountBeforeApproval = listTaskGraphs(multi.project.project_id).length;
    const approvalResponse = await handleSupervisorMessage(multi.session.session_id, "approve", "web_text");
    const multiAfterApproval = getSession(multi.session.session_id);
    const approvedGraph = listTaskGraphs(multi.project.project_id)[0];

    const revise = selectedSession("session_revise_planner");
    await handleSupervisorMessage(revise.session.session_id, "Build a static SaaS dashboard with landing, login, dashboard, and settings.", "web_text");
    const reviseResponse = await handleSupervisorMessage(revise.session.session_id, "Use one worker instead.", "web_text");
    const reviseApproval = await handleSupervisorMessage(revise.session.session_id, "approve", "web_text");
    const revisedGraph = listTaskGraphs(revise.project.project_id)[0];

    const gcp = selectedSession("session_gcp_planner");
    const gcpResponse = await handleSupervisorMessage(gcp.session.session_id, "Run this on GCP workers.", "web_text");
    const gcpLatest = getSession(gcp.session.session_id);

    const risky = selectedSession("session_risky_planner");
    const riskyResponse = await handleSupervisorMessage(risky.session.session_id, "Deploy this app publicly.", "web_text");
    const riskyLatest = getSession(risky.session.session_id);

    const flow = buildFlowchartState();
    console.log(JSON.stringify({
      vagueText: vagueResponse.response,
      vagueWorkers,
      simpleText: simpleResponse.response,
      simpleGraphNodes: simpleLatestGraph?.nodes.length ?? 0,
      simpleWorkers,
      multiText: multiResponse.response,
      multiPending: multiAfterProposal.pending_action?.type,
      graphCountBeforeApproval,
      approvalText: approvalResponse.response,
      approvedGraphNodes: approvedGraph?.nodes.map((node) => node.title) ?? [],
      approvedWorkerCount: multiAfterApproval.user_approved_worker_count,
      approvedMode: multiAfterApproval.user_approved_worker_mode,
      outputContracts: approvedGraph?.nodes.every((node) => node.output_contract && node.output_contract.required_app_files.length > 0) ?? false,
      reviseText: reviseResponse.response,
      reviseApprovalText: reviseApproval.response,
      revisedWorkerCount: revisedGraph?.recommended_worker_count,
      revisedStrategy: revisedGraph?.execution_strategy,
      gcpText: gcpResponse.response,
      gcpPending: gcpLatest.pending_action?.type,
      riskyText: riskyResponse.response,
      riskyPending: riskyLatest.pending_action?.type,
      plannerNodes: flow.nodes.filter((node) => node.type === "planner_decision").length,
      approvalNodes: flow.nodes.filter((node) => node.type === "user_approval").length,
      splitNodes: flow.nodes.filter((node) => node.type === "task_split_proposal").length,
      executionNodes: flow.nodes.filter((node) => node.type === "execution_start").length,
      approvalToGraphEdge: flow.edges.some((edge) => /approved_plan|execution_start|user_approval/.test(edge.from) && edge.to.startsWith("task_graph:"))
        || flow.edges.some((edge) => edge.from.startsWith("execution_start:") && edge.to.startsWith("task_graph:")),
      noRawJson: !/[{}]/.test(String(multiResponse.response) + String(approvalResponse.response))
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.match(String(payload.vagueText), /what kind of game/i);
  assert.equal(payload.vagueWorkers, 0);
  assert.match(String(payload.simpleText), /Starting one docker_local worker|Task graph/i);
  assert.equal(payload.simpleGraphNodes, 1);
  assert.equal(payload.simpleWorkers, 1);
  assert.match(String(payload.multiText), /reply `?approve`?/i);
  assert.match(String(payload.multiText), /Before I start, here is what I understand/i);
  assert.match(String(payload.multiText), /Technical direction/i);
  assert.match(String(payload.multiText), /Assumptions/i);
  assert.match(String(payload.multiText), /Does this match what you want/i);
  assert.match(String(payload.multiText), /approve.*what to change/i);
  assert.equal(payload.multiPending, "approve_task_split");
  assert.equal(payload.graphCountBeforeApproval, 0);
  assert.match(String(payload.approvalText), /Created task graph/i);
  assert.deepEqual(payload.approvedGraphNodes, ["Landing and login pages", "Dashboard and settings pages"]);
  assert.equal(payload.approvedWorkerCount, 2);
  assert.equal(payload.approvedMode, "docker_local");
  assert.equal(payload.outputContracts, true);
  assert.match(String(payload.reviseText), /one worker/i);
  assert.match(String(payload.reviseApprovalText), /Created task graph/i);
  assert.equal(payload.revisedWorkerCount, 1);
  assert.equal(payload.revisedStrategy, "sequential");
  assert.match(String(payload.gcpText), /GCP VM workers needs approval|Approve GCP VM/i);
  assert.equal(payload.gcpPending, "approve_gcp_action");
  assert.match(String(payload.riskyText), /Deploying may expose|Approve deploy/i);
  assert.equal(payload.riskyPending, "confirm_deploy");
  assert.ok(Number(payload.plannerNodes) >= 2);
  assert.ok(Number(payload.approvalNodes) >= 1);
  assert.ok(Number(payload.splitNodes) >= 1);
  assert.ok(Number(payload.executionNodes) >= 1);
  assert.equal(payload.approvalToGraphEdge, true);
  assert.equal(payload.noRawJson, true);
});
