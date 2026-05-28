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
