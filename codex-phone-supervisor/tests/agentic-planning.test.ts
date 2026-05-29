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
    process.env.SUPERVISOR_MODEL_PROVIDER = "codex_cli";
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

test("Codex CLI planner asks technical requirements before Megaplan for underspecified commerce apps", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-codex-cli-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-codex-cli-root-"));
  const projectDir = path.join(workspaceRoot, "orange");
  const fakeCodexPath = path.join(storeDir, "fake-codex-planner.cjs");
  const promptCapturePath = path.join(storeDir, "planner-prompt.txt");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => input += chunk.toString());
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptCapturePath)}, input);
  function arg(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? "" : process.argv[index + 1] || "";
  }
  const finalPath = arg("--output-last-message");
  const clarified = /Technical requirements from user:/i.test(input);
  const value = clarified ? {
    decision_type: "request_user_approval",
    confidence: 0.91,
    reason: "The user clarified the commerce app architecture and approval is needed before the local Codex session starts.",
    user_visible_response: "I understand the candy app should be full-stack with cart, checkout, inventory, auth, persistent data, and mocked payments. Approve the Megaplan before I start Codex?",
    requirements_summary: "Build a candy-selling app named Orange as a full-stack local app with storefront, cart, checkout, inventory, auth, persistent data, mocked payments, tests, README, validation, and preview instructions.",
    open_questions: [],
    assumptions: ["Payments are mocked locally, not live Stripe.", "Persistent data can use a local development store unless the repo already has a stronger pattern."],
    proposed_design: "Full-stack local commerce app with browser storefront, backend API, shared commerce logic, inventory/admin surface, authentication flow, mocked checkout, tests, README, and local preview.",
    proposed_task_split: [
      {
        title: "Commerce app architecture",
        goal: "Create the full-stack candy storefront, cart, checkout, inventory, auth, and persistence plan in one repo.",
        can_run_parallel: false,
        depends_on: [],
        expected_files: ["package.json", "README.md", "src"],
        validation: ["npm run typecheck", "npm test", "npm run build"]
      }
    ],
    recommended_worker_count: 1,
    recommended_worker_mode: "codex_session_local",
    requires_user_approval: true,
    approval_reason: "The Megaplan must be approved before the local Codex CLI implementation session starts.",
    risk_level: "low",
    next_action: "none",
    execution_allowed: false
  } : {
    decision_type: "ask_clarification",
    confidence: 0.92,
    reason: "The candy-selling app request is missing technical requirements that change the architecture.",
    user_visible_response: "Should the candy-selling app be a static storefront mockup, or a full-stack app with cart/checkout, inventory, auth, payments, and persistent data?",
    requirements_summary: "Make an app to sell candies.",
    open_questions: ["Should the candy-selling app be a static storefront mockup, or a full-stack app with cart/checkout, inventory, auth, payments, and persistent data?"],
    assumptions: [],
    proposed_design: "",
    proposed_task_split: [],
    recommended_worker_count: 1,
    recommended_worker_mode: "codex_session_local",
    requires_user_approval: false,
    approval_reason: "",
    risk_level: "low",
    next_action: "none",
    execution_allowed: false
  };
  if (finalPath) fs.writeFileSync(finalPath, JSON.stringify(value));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } }));
});
`);
  fs.chmodSync(fakeCodexPath, 0o755);
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    delete process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
    process.env.WORKER_MODE = "codex_session_local";
    process.env.DEFAULT_WORKER_MODE = "codex_session_local";
    const fs = await import("node:fs");
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, listOrchestratorEvents, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { getMegaplanForSession } = await import("./codex-phone-supervisor/backend/src/megaplan.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    project.display_name = "Orange";
    upsertProject(project);
    const session = createSession("commerce clarification", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_codex_cli_commerce_clarification";
    session.channel = "web_text";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = project.display_name;
    session.preferred_worker_mode = "codex_session_local";
    upsertSession(session);
    const first = await handleSupervisorMessage(session.session_id, "Make an app to sell candies.", "web_text");
    const afterFirst = getSession(session.session_id);
    const firstMegaplan = getMegaplanForSession(session.session_id);
    const second = await handleSupervisorMessage(session.session_id, "Make it full-stack with cart, checkout, inventory, auth, persistent data, and mocked payments.", "web_text");
    const afterSecond = getSession(session.session_id);
    const secondMegaplan = getMegaplanForSession(session.session_id);
    const prompt = fs.readFileSync(${JSON.stringify(promptCapturePath)}, "utf8");
    const eventTypes = listOrchestratorEvents().map((event) => event.type);
    console.log(JSON.stringify({
      first: first.response,
      firstPending: afterFirst?.pending_action?.type ?? null,
      firstMegaplanExists: Boolean(firstMegaplan),
      second: second.response,
      secondPending: afterSecond?.pending_action?.type ?? null,
      secondMegaplanText: secondMegaplan?.content ?? "",
      prompt,
      eventTypes
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.match(String(payload.first), /static storefront mockup|full-stack app/i);
  assert.match(String(payload.first), /cart|checkout|inventory|auth|payments|persistent data/i);
  assert.equal(payload.firstPending, "clarify_requirements");
  assert.equal(payload.firstMegaplanExists, false);
  assert.match(String(payload.second), /Megaplan skill created MEGAPLAN\.md/);
  assert.equal(payload.secondPending, "approve_megaplan");
  assert.match(String(payload.secondMegaplanText), /## Technical Requirements/);
  assert.match(String(payload.secondMegaplanText), /full-stack local commerce app/i);
  assert.match(String(payload.secondMegaplanText), /cart|checkout|inventory|auth|persistent data|mocked payments/i);
  assert.match(String(payload.secondMegaplanText), /npm run typecheck|npm test|npm run build/);
  assert.match(String(payload.prompt), /For commerce or selling apps/i);
  assert.match(String(payload.prompt), /Do not create or approve a Megaplan until required technical direction is known/i);
  assert.ok((payload.eventTypes as string[]).includes("planner.codex_cli.started"));
  assert.ok((payload.eventTypes as string[]).includes("planner.codex_cli.completed"));
});

test("Codex CLI planner can keep asking low-level technical requirements before Megaplan", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-multiround-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-multiround-root-"));
  const projectDir = path.join(workspaceRoot, "candy-lab");
  const fakeCodexPath = path.join(storeDir, "fake-codex-multiround.cjs");
  const promptCapturePath = path.join(storeDir, "planner-prompt.txt");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => input += chunk.toString());
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(promptCapturePath)}, input);
  function arg(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? "" : process.argv[index + 1] || "";
  }
  const finalPath = arg("--output-last-message");
  const hasArchitecture = /Technical requirements from user:[\\s\\S]*full-stack/i.test(input);
  const hasLowLevel = /Technical requirements from user:[\\s\\S]*(Next\\.js|SQLite|admin role|server actions|API routes|preview command)/i.test(input);
  const value = !hasArchitecture ? {
    decision_type: "ask_clarification",
    confidence: 0.92,
    reason: "The candy-selling app request is missing technical requirements that change the architecture.",
    user_visible_response: "Should the candy app be a static storefront mockup, or a full-stack app with cart/checkout, inventory, auth, payments, and persistent data?",
    requirements_summary: "Build an app to sell candies.",
    open_questions: ["Should the candy app be static or full-stack?"],
    assumptions: [],
    proposed_design: "",
    proposed_task_split: [],
    recommended_worker_count: 1,
    recommended_worker_mode: "codex_session_local",
    requires_user_approval: false,
    approval_reason: "",
    risk_level: "low",
    next_action: "none",
    execution_allowed: false
  } : !hasLowLevel ? {
    decision_type: "ask_clarification",
    confidence: 0.9,
    reason: "The architecture is known, but low-level implementation choices still affect files, data, validation, and preview.",
    user_visible_response: "A few low-level choices before the Megaplan.",
    requirements_summary: "Build a full-stack candy-selling app with cart, checkout, inventory, auth, payments, and persistence.",
    open_questions: [
      "Which stack/runtime should Codex use?",
      "What persistence should back products, carts, users, and orders?",
      "Which user roles should exist?",
      "Should checkout be API-based or local mocked flow?",
      "Should Codex conduct product, domain, UX, or technical research before implementation, and if so what topics or sources matter?",
      "What command should preview the app locally?"
    ],
    assumptions: [],
    proposed_design: "",
    proposed_task_split: [],
    recommended_worker_count: 1,
    recommended_worker_mode: "codex_session_local",
    requires_user_approval: false,
    approval_reason: "",
    risk_level: "low",
    next_action: "none",
    execution_allowed: false
  } : {
    decision_type: "request_user_approval",
    confidence: 0.91,
    reason: "The product and low-level technical requirements are now specific enough for a Megaplan.",
    user_visible_response: "I have enough technical detail for the Megaplan. Approve before I start Codex?",
    requirements_summary: "Build Candy Lab as a full-stack Next.js candy shop with SQLite persistence, customer/admin roles, API-backed mocked checkout, local seed data, tests, and npm run dev preview.",
    open_questions: [],
    assumptions: ["Payments are mocked locally."],
    proposed_design: "Next.js app with API routes, SQLite persistence, customer and admin roles, seeded products, mocked checkout, local validation, and npm run dev preview.",
    proposed_task_split: [
      {
        title: "Full-stack candy shop",
        goal: "Implement the agreed Next.js, SQLite, auth-role, cart, checkout, inventory, test, and preview requirements in one repo.",
        can_run_parallel: false,
        depends_on: [],
        expected_files: ["package.json", "README.md", "src"],
        validation: ["npm run typecheck", "npm test", "npm run build"]
      }
    ],
    recommended_worker_count: 1,
    recommended_worker_mode: "codex_session_local",
    requires_user_approval: true,
    approval_reason: "The Megaplan must be approved before the local Codex CLI implementation session starts.",
    risk_level: "low",
    next_action: "none",
    execution_allowed: false
  };
  if (finalPath) fs.writeFileSync(finalPath, JSON.stringify(value));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } }));
});
`);
  fs.chmodSync(fakeCodexPath, 0o755);
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    delete process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
    process.env.WORKER_MODE = "codex_session_local";
    process.env.DEFAULT_WORKER_MODE = "codex_session_local";
    const fs = await import("node:fs");
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { projectRecordForWorkspace, upsertProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { getMegaplanForSession } = await import("./codex-phone-supervisor/backend/src/megaplan.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    project.display_name = "Candy Lab";
    upsertProject(project);
    const session = createSession("multi-round requirements", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_multiround_requirements";
    session.channel = "web_text";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = project.display_name;
    session.preferred_worker_mode = "codex_session_local";
    upsertSession(session);
    const first = await handleSupervisorMessage(session.session_id, "Build an app to sell candies.", "web_text");
    const afterFirst = getSession(session.session_id);
    const firstMegaplan = getMegaplanForSession(session.session_id);
    const second = await handleSupervisorMessage(session.session_id, "Make it full-stack with cart checkout, inventory admin, user accounts, mock payments, and persistent data.", "web_text");
    const afterSecond = getSession(session.session_id);
    const secondMegaplan = getMegaplanForSession(session.session_id);
    const third = await handleSupervisorMessage(session.session_id, "Use Next.js with API routes, SQLite persistence, customer and admin roles, API-backed mock checkout, seeded candies, no research needed, npm run dev preview command.", "web_text");
    const afterThird = getSession(session.session_id);
    const thirdMegaplan = getMegaplanForSession(session.session_id);
    const prompt = fs.readFileSync(${JSON.stringify(promptCapturePath)}, "utf8");
    console.log(JSON.stringify({
      first: first.response,
      firstPending: afterFirst?.pending_action?.type ?? null,
      firstMegaplanExists: Boolean(firstMegaplan),
      second: second.response,
      secondPending: afterSecond?.pending_action?.type ?? null,
      secondMegaplanExists: Boolean(secondMegaplan),
      third: third.response,
      thirdPending: afterThird?.pending_action?.type ?? null,
      thirdMegaplanText: thirdMegaplan?.content ?? "",
      prompt
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.match(String(payload.first), /static storefront mockup|full-stack/i);
  assert.equal(payload.firstPending, "clarify_requirements");
  assert.equal(payload.firstMegaplanExists, false);
  assert.match(String(payload.second), /low-level choices/i);
  assert.match(String(payload.second), /Which stack\/runtime should Codex use/i);
  assert.match(String(payload.second), /What persistence should back products, carts, users, and orders/i);
  assert.match(String(payload.second), /Which user roles should exist/i);
  assert.match(String(payload.second), /Should Codex conduct product, domain, UX, or technical research before implementation/i);
  assert.match(String(payload.second), /What command should preview the app locally/i);
  assert.equal(payload.secondPending, "clarify_requirements");
  assert.equal(payload.secondMegaplanExists, false);
  assert.match(String(payload.third), /Megaplan skill created MEGAPLAN\.md/);
  assert.equal(payload.thirdPending, "approve_megaplan");
  assert.match(String(payload.thirdMegaplanText), /## Technical Requirements/);
  assert.match(String(payload.thirdMegaplanText), /Next\.js app with API routes, SQLite persistence, customer and admin roles/i);
  assert.match(String(payload.prompt), /Use multi-turn requirements gathering/i);
  assert.match(String(payload.prompt), /ask whether Codex should conduct product, domain, UX, or technical research before implementation/i);
  assert.match(String(payload.prompt), /keep asking concise follow-up technical questions/i);
  assert.match(String(payload.prompt), /Stop asking and choose reasonable defaults only when the user clearly is not entertaining more questions/i);
});

test("new project naming flow preserves Codex technical clarification response", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-new-project-clarify-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-new-project-clarify-root-"));
  const fakeCodexPath = path.join(storeDir, "fake-codex-project-planner.cjs");
  fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => input += chunk.toString());
process.stdin.on("end", () => {
  const allInput = process.argv.join(" ") + "\\n" + input;
  function arg(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? "" : process.argv[index + 1] || "";
  }
  const finalPath = arg("--output-last-message");
  let value;
  if (/project-intake/i.test(allInput)) {
    value = /name it candy clarify verify/i.test(allInput) ? {
      action: "create_project",
      assistant_message: "Creating Candy Clarify Verify locally with Codex.",
      project_name: "Candy Clarify Verify",
      description: "Make an app to sell candies.",
      requested_kind: "app",
      pending_action_type: null,
      confidence: "high",
      reason: "The user provided the project name."
    } : {
      action: "ask_user",
      assistant_message: "What would you like to name the candy-selling app project?",
      project_name: null,
      description: "Make an app to sell candies.",
      requested_kind: "app",
      pending_action_type: "collect_project_name",
      confidence: "high",
      reason: "The project name is missing."
    };
  } else {
    value = {
      decision_type: "ask_clarification",
      confidence: 0.92,
      reason: "The candy-selling app request is missing technical requirements that change the architecture.",
      user_visible_response: "Should the candy-selling app be a static storefront mockup, or a full-stack app with cart/checkout, inventory, auth, payments, and persistent data?",
      requirements_summary: "Make an app to sell candies.",
      open_questions: ["Should the candy-selling app be a static storefront mockup, or a full-stack app with cart/checkout, inventory, auth, payments, and persistent data?"],
      assumptions: [],
      proposed_design: "",
      proposed_task_split: [],
      recommended_worker_count: 1,
      recommended_worker_mode: "codex_session_local",
      requires_user_approval: false,
      approval_reason: "",
      risk_level: "low",
      next_action: "none",
      execution_allowed: false
    };
  }
  if (finalPath) fs.writeFileSync(finalPath, JSON.stringify(value));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } }));
});
`);
  fs.chmodSync(fakeCodexPath, 0o755);
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    delete process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
    process.env.WORKER_MODE = "codex_session_local";
    process.env.DEFAULT_WORKER_MODE = "codex_session_local";
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { getMegaplanForSession } = await import("./codex-phone-supervisor/backend/src/megaplan.ts");
    const session = createSession("new project clarify", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_new_project_clarify";
    session.channel = "web_text";
    session.workspace_path = ${JSON.stringify(workspaceRoot)};
    upsertSession(session);
    const first = await handleSupervisorMessage(session.session_id, "can you make an app to sell candies", "web_text");
    const second = await handleSupervisorMessage(session.session_id, "name it candy clarify verify", "web_text");
    const latest = getSession(session.session_id);
    console.log(JSON.stringify({
      first: first.response,
      second: second.response,
      pending: latest?.pending_action?.type ?? null,
      latest: latest?.latest_codex_message ?? "",
      megaplanExists: Boolean(getMegaplanForSession(session.session_id))
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.match(String(payload.first), /What would you like to name/i);
  assert.match(String(payload.second), /static storefront mockup|full-stack app/i);
  assert.match(String(payload.second), /cart|checkout|inventory|auth|payments|persistent data/i);
  assert.doesNotMatch(String(payload.second), /Codex CLI is running from the configured project root/i);
  assert.equal(payload.pending, "clarify_requirements");
  assert.equal(payload.latest, payload.second);
  assert.equal(payload.megaplanExists, false);
});

test("pre-approval repo path correction updates the real project workspace", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-path-correction-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-path-correction-root-"));
  const desiredRepo = path.join(workspaceRoot, "custom-location", "x");
  const fakeCodexPath = path.join(storeDir, "fake-codex-path-correction.cjs");
  fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require("node:fs");
const desiredRepo = ${JSON.stringify(desiredRepo)};
let input = "";
process.stdin.on("data", (chunk) => input += chunk.toString());
process.stdin.on("end", () => {
  const allInput = process.argv.join(" ") + "\\n" + input;
  function arg(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? "" : process.argv[index + 1] || "";
  }
  const finalPath = arg("--output-last-message");
  let value;
  if (/project-intake/i.test(allInput)) {
    if (allInput.includes(desiredRepo)) {
      value = {
        action: "create_project",
        assistant_message: "Creating X at the requested local repo path.",
        project_name: "x",
        workspace_path: desiredRepo,
        description: "Create a Bash CLI number guessing game in " + desiredRepo + ".",
        requested_kind: "game",
        pending_action_type: null,
        confidence: "high",
        reason: "The user corrected the target repo path before approval."
      };
    } else if (/keep it as x for now/i.test(allInput)) {
      value = {
        action: "create_project",
        assistant_message: "Creating X locally with Codex.",
        project_name: "x",
        workspace_path: null,
        description: "can you make a cli game",
        requested_kind: "game",
        pending_action_type: null,
        confidence: "high",
        reason: "The user provided the project name."
      };
    } else {
      value = {
        action: "ask_user",
        assistant_message: "What should I name the CLI game project?",
        project_name: null,
        workspace_path: null,
        description: "can you make a cli game",
        requested_kind: "game",
        pending_action_type: "collect_project_name",
        confidence: "high",
        reason: "The request needs a project name."
      };
    }
  } else {
    const bashGameKnown = /number guessing game|Bash CLI/i.test(allInput);
    value = bashGameKnown ? {
      decision_type: "request_user_approval",
      confidence: 0.9,
      reason: "The Bash game shape is now clear and the Megaplan needs approval.",
      user_visible_response: "Approve the local Bash number guessing game Megaplan?",
      requirements_summary: "Create a Bash CLI number guessing game.",
      open_questions: [],
      assumptions: ["No persistence or external services."],
      proposed_design: "One local Codex CLI session owns the repo and implements a Bash prompt-based number guessing game with docs and validation.",
      proposed_task_split: [
        {
          title: "Build Bash Game",
          goal: "Create the number guessing game script with validation, hints, attempts, and clean quit behavior.",
          can_run_parallel: false,
          depends_on: [],
          expected_files: ["guess.sh"],
          validation: ["bash -n guess.sh"]
        },
        {
          title: "Document Usage",
          goal: "Write concise usage documentation for running the game.",
          can_run_parallel: true,
          depends_on: [],
          expected_files: ["README.md"],
          validation: ["test -f README.md"]
        }
      ],
      recommended_worker_count: 1,
      recommended_worker_mode: "codex_session_local",
      requires_user_approval: true,
      approval_reason: "The Megaplan must be approved before the local Codex CLI implementation session starts.",
      risk_level: "low",
      next_action: "none",
      execution_allowed: false
    } : {
      decision_type: "ask_clarification",
      confidence: 0.9,
      reason: "The CLI game needs a game type and runtime.",
      user_visible_response: "What kind of CLI game should this be, and what language/runtime should Codex use?",
      requirements_summary: "Create a CLI game.",
      open_questions: ["What kind of CLI game should this be?", "What language/runtime should Codex use?"],
      assumptions: [],
      proposed_design: "",
      proposed_task_split: [],
      recommended_worker_count: 1,
      recommended_worker_mode: "codex_session_local",
      requires_user_approval: false,
      approval_reason: "",
      risk_level: "low",
      next_action: "none",
      execution_allowed: false
    };
  }
  if (finalPath) fs.writeFileSync(finalPath, JSON.stringify(value));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } }));
});
`);
  fs.chmodSync(fakeCodexPath, 0o755);
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    delete process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
    process.env.WORKER_MODE = "codex_session_local";
    process.env.DEFAULT_WORKER_MODE = "codex_session_local";
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { handleSupervisorMessage } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { getProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { getMegaplanForSession } = await import("./codex-phone-supervisor/backend/src/megaplan.ts");
    const session = createSession("path correction", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_path_correction";
    session.channel = "web_text";
    session.workspace_path = ${JSON.stringify(workspaceRoot)};
    session.preferred_worker_mode = "codex_session_local";
    upsertSession(session);
    await handleSupervisorMessage(session.session_id, "can you make a cli game", "web_text");
    await handleSupervisorMessage(session.session_id, "keep it as x for now", "web_text");
    await handleSupervisorMessage(session.session_id, "Um make it a number guessing game. a bash game", "web_text");
    const correction = await handleSupervisorMessage(session.session_id, "No, make it in ${desiredRepo}. x is the new repo that you will make.", "web_text");
    const latest = getSession(session.session_id);
    const project = latest?.pending_action?.target_project_id ? getProject(latest.pending_action.target_project_id) : null;
    const megaplan = getMegaplanForSession(session.session_id);
    console.log(JSON.stringify({
      correction: correction.response,
      workspace: latest?.workspace_path ?? null,
      pending: latest?.pending_action?.type ?? null,
      pendingProjectPath: project?.workspace_path ?? null,
      megaplanPath: megaplan?.path ?? null,
      desiredExists: fs.existsSync(${JSON.stringify(desiredRepo)}),
      desiredGitExists: fs.existsSync(path.join(${JSON.stringify(desiredRepo)}, ".git")),
      oldGeneratedWorkspace: path.join(${JSON.stringify(workspaceRoot)}, "x")
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.match(String(payload.correction), /MEGAPLAN\.md|Megaplan/i);
  assert.equal(payload.workspace, fs.realpathSync(desiredRepo));
  assert.equal(payload.pending, "approve_megaplan");
  assert.equal(payload.pendingProjectPath, fs.realpathSync(desiredRepo));
  assert.match(String(payload.megaplanPath), new RegExp(`${desiredRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(payload.desiredExists, true);
  assert.equal(payload.desiredGitExists, true);
  assert.notEqual(payload.workspace, payload.oldGeneratedWorkspace);
});

test("new local Codex projects initialize git and attach a GitHub repo when enabled", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-github-repo-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-github-repo-root-"));
  const fakeCodexPath = path.join(storeDir, "fake-codex-github-planner.cjs");
  const fakeGhPath = path.join(storeDir, "fake-gh.cjs");
  const ghLogPath = path.join(storeDir, "gh-log.jsonl");
  fs.writeFileSync(fakeCodexPath, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => input += chunk.toString());
process.stdin.on("end", () => {
  function arg(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? "" : process.argv[index + 1] || "";
  }
  const finalPath = arg("--output-last-message");
  const value = {
    decision_type: "request_user_approval",
    confidence: 0.91,
    reason: "The local Codex plan is ready.",
    user_visible_response: "Approve the local Codex plan?",
    requirements_summary: "Build a small app in a new GitHub-backed repo.",
    open_questions: [],
    assumptions: [],
    proposed_design: "One local Codex CLI session owns the repo.",
    proposed_task_split: [{
      title: "Build App",
      goal: "Create the app files.",
      can_run_parallel: false,
      depends_on: [],
      expected_files: ["index.html"],
      validation: ["test -f index.html"]
    }],
    recommended_worker_count: 1,
    recommended_worker_mode: "codex_session_local",
    requires_user_approval: true,
    approval_reason: "The Megaplan must be approved first.",
    risk_level: "low",
    next_action: "none",
    execution_allowed: false
  };
  if (finalPath) fs.writeFileSync(finalPath, JSON.stringify(value));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } }));
});
`);
  fs.chmodSync(fakeCodexPath, 0o755);
  fs.writeFileSync(fakeGhPath, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const logPath = ${JSON.stringify(ghLogPath)};
fs.appendFileSync(logPath, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] === "repo" && args[1] === "create") {
  const target = args[2];
  const source = args[args.indexOf("--source") + 1];
  const name = target.includes("/") ? target.split("/").pop() : target;
  const owner = target.includes("/") ? target.split("/")[0] : "Karanvir1729";
  const url = "https://github.com/" + owner + "/" + name + ".git";
  const result = spawnSync("git", ["remote", "add", "origin", url], { cwd: source, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "remote add failed");
    process.exit(result.status || 1);
  }
  console.log(url);
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") {
  const target = args[2];
  const name = target.includes("/") ? target.split("/").pop() : target;
  const owner = target.includes("/") ? target.split("/")[0] : "Karanvir1729";
  console.log(JSON.stringify({ url: "https://github.com/" + owner + "/" + name, nameWithOwner: owner + "/" + name }));
  process.exit(0);
}
process.stderr.write("unexpected gh args: " + args.join(" "));
process.exit(1);
`);
  fs.chmodSync(fakeGhPath, 0o755);
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    delete process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
    process.env.CODEX_PHONE_SUPERVISOR_GH_COMMAND = ${JSON.stringify(fakeGhPath)};
    process.env.CODEX_PHONE_SUPERVISOR_GITHUB_REPO_CREATE = "always";
    process.env.CODEX_PHONE_SUPERVISOR_GITHUB_REPO_VISIBILITY = "private";
    process.env.WORKER_MODE = "codex_session_local";
    process.env.DEFAULT_WORKER_MODE = "codex_session_local";
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { create_project } = await import("./codex-phone-supervisor/backend/src/supervisor-tools.ts");
    const { getSession, listOrchestratorEvents, upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const { getProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const session = createSession("github repo project", ${JSON.stringify(workspaceRoot)});
    session.session_id = "session_github_repo_project";
    session.channel = "web_text";
    session.preferred_worker_mode = "codex_session_local";
    upsertSession(session);
    const result = await create_project(session.session_id, "GitHub Speed Repo", "Build a small app in a new GitHub-backed repo.");
    const latest = getSession(session.session_id);
    const project = result.project_id ? getProject(result.project_id) : null;
    const remote = project ? spawnSync("git", ["remote", "get-url", "origin"], { cwd: project.workspace_path, encoding: "utf8" }).stdout.trim() : "";
    console.log(JSON.stringify({
      status: result.status,
      pending: latest?.pending_action?.type ?? null,
      projectPath: project?.workspace_path ?? null,
      gitExists: project ? fs.existsSync(path.join(project.workspace_path, ".git")) : false,
      remote,
      githubUrl: project?.github_repo_url ?? null,
      githubFullName: project?.github_repo_full_name ?? null,
      githubEvents: listOrchestratorEvents(project?.project_id ?? "").filter((event) => event.type.startsWith("github.repo.")).map((event) => event.type),
      ghLog: fs.readFileSync(${JSON.stringify(ghLogPath)}, "utf8")
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.status, "waiting_for_approval");
  assert.equal(payload.pending, "approve_megaplan");
  assert.equal(payload.gitExists, true);
  assert.match(String(payload.projectPath), /github-speed-repo$/);
  assert.match(String(payload.remote), /github\.com\/Karanvir1729\/github-speed-repo\.git$/);
  assert.equal(payload.githubUrl, "https://github.com/Karanvir1729/github-speed-repo");
  assert.equal(payload.githubFullName, "Karanvir1729/github-speed-repo");
  assert.ok((payload.githubEvents as string[]).includes("github.repo.ready"));
  assert.match(String(payload.ghLog), /"repo","create","github-speed-repo"/);
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
