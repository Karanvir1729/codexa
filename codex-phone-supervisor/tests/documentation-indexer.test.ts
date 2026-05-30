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
    maxBuffer: 20 * 1024 * 1024,
  });
}

test("DocumentationIndexer creates function variable API and state docs from real project files", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-index-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doc-index-root-"));
  const projectDir = path.join(workspaceRoot, "doc-index-project");
  fs.mkdirSync(path.join(projectDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "index.html"), [
    "<!doctype html>",
    "<html><head><link rel=\"stylesheet\" href=\"styles.css\"></head>",
    "<body><main id=\"app\" class=\"hero\"><button class=\"cta\">Start</button></main><script type=\"module\" src=\"script.js\"></script></body></html>",
  ].join("\n"));
  fs.writeFileSync(path.join(projectDir, "styles.css"), ":root { --brand: #0f766e; }\n.hero { color: var(--brand); }\n.cta { border: 0; }\n");
  fs.writeFileSync(path.join(projectDir, "script.js"), [
    "export const SHOP_NAME = 'Documentation Cafe';",
    "export function renderMenu(items) { return items.map((item) => `<li>${item}</li>`).join(''); }",
    "export function initApp(root = document.querySelector('#app')) { root?.addEventListener('click', () => renderMenu(['tea'])); return root; }",
    "document.querySelector('.cta')?.addEventListener('click', () => initApp());",
  ].join("\n"));
  fs.writeFileSync(path.join(projectDir, "server.ts"), [
    "export interface SessionState {",
    "  session_id: string;",
    "  status: 'idle' | 'running';",
    "}",
    "export const DEFAULT_STATUS = 'idle';",
    "export function createSession(input: { id: string }): SessionState { return { session_id: input.id, status: DEFAULT_STATUS }; }",
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
  ].join("\n"));
  fs.writeFileSync(path.join(projectDir, "assets", "logo.svg"), "<svg></svg>\n");
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { projectRecordForWorkspace, upsertProject, getProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { gitProjectManager } = await import("./codex-phone-supervisor/backend/src/git-project-manager.ts");
    const { documentationIndexer } = await import("./codex-phone-supervisor/backend/src/documentation-indexer.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    upsertProject(project);
    gitProjectManager.ensureSharedDocs(project, null, "Build a documented static app.");
    const indexed = documentationIndexer.updateProjectDocs(getProject(project.project_id));
    fs.writeFileSync(path.join(${JSON.stringify(projectDir)}, "new-feature.js"), "export function newFeature() { return true; }\\n");
    const stale = documentationIndexer.checkFreshness(getProject(project.project_id), ["new-feature.js"]);
    const docsDir = path.join(${JSON.stringify(projectDir)}, ".head-developer");
    const codeIndex = fs.readFileSync(path.join(docsDir, "CODE_INDEX.md"), "utf8");
    const functionsDoc = fs.readFileSync(path.join(docsDir, "FUNCTIONS.md"), "utf8");
    const variablesDoc = fs.readFileSync(path.join(docsDir, "VARIABLES.md"), "utf8");
    const apiDoc = fs.readFileSync(path.join(docsDir, "API_SURFACE.md"), "utf8");
    const stateDoc = fs.readFileSync(path.join(docsDir, "STATE_MODEL.md"), "utf8");
    console.log(JSON.stringify({
      docsCreated: ["CODE_INDEX.md", "FUNCTIONS.md", "VARIABLES.md", "API_SURFACE.md", "STATE_MODEL.md", "WORKER_HANDOFFS.md", "VALIDATION.md"].every((file) => fs.existsSync(path.join(docsDir, file))),
      codeHasFiles: ["index.html", "styles.css", "script.js", "server.ts", "assets/logo.svg"].every((item) => codeIndex.includes(item)),
      functionEntries: ["renderMenu", "initApp", "createSession", "event handler: click"].every((item) => functionsDoc.includes(item)),
      variableEntries: ["SHOP_NAME", "--brand", "DEFAULT_STATUS", "SessionState.session_id"].every((item) => variablesDoc.includes(item) || stateDoc.includes(item)),
      apiEntry: apiDoc.includes("GET") && apiDoc.includes("/health"),
      stateEntry: stateDoc.includes("SessionState") && stateDoc.includes("session_id") && stateDoc.includes("status"),
      initiallyFresh: indexed.freshness.docs_fresh,
      staleDetected: stale.docs_fresh === false && stale.missing_changed_files.includes("new-feature.js") && Boolean(stale.recommended_follow_up_task)
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.docsCreated, true);
  assert.equal(payload.codeHasFiles, true);
  assert.equal(payload.functionEntries, true);
  assert.equal(payload.variableEntries, true);
  assert.equal(payload.apiEntry, true);
  assert.equal(payload.stateEntry, true);
  assert.equal(payload.initiallyFresh, true);
  assert.equal(payload.staleDetected, true);
});

test("documentation docs are included in worker context, conversation answers, and flowchart docs nodes", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-context-store-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doc-context-root-"));
  const projectDir = path.join(workspaceRoot, "doc-context-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "script.js"), "export function visibleFunction() { return 'ok'; }\nexport const IMPORTANT_FLAG = true;\n");
  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const { createSession } = await import("./codex-phone-supervisor/backend/src/session.ts");
    const { projectRecordForWorkspace, upsertProject, getProject } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { multiWorkerCoordinator } = await import("./codex-phone-supervisor/backend/src/multi-worker-coordinator.ts");
    const { actionRouter, parseOperatorIntent } = await import("./codex-phone-supervisor/backend/src/action-router.ts");
    const { buildFlowchartState } = await import("./codex-phone-supervisor/backend/src/flowchart.ts");
    const { upsertSession } = await import("./codex-phone-supervisor/backend/src/store.ts");
    const project = projectRecordForWorkspace(${JSON.stringify(projectDir)});
    project.display_name = "Documentation Context Project";
    upsertProject(project);
    const simple = multiWorkerCoordinator.judge("Build a simple landing page for a candle shop.", project);
    const created = await multiWorkerCoordinator.createAndMaybeStart(project, "Build a small SaaS dashboard with a landing page, login screen, dashboard layout, settings page, fake billing page, and tests.", "docker_local", { autoStart: false });
    const graph = created.graph;
    const appNode = graph.nodes.find((node) => node.title !== "Project setup and shared docs");
    const packet = multiWorkerCoordinator.buildWorkerContext(getProject(project.project_id), graph, appNode, "worker_doc_context");
    const session = createSession("docs conversation", ${JSON.stringify(projectDir)});
    session.session_id = "session_docs_context";
    session.channel = "web_text";
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.workspace_path = project.workspace_path;
    session.project_discovery.status = "selected";
    upsertSession(session);
    const parsedFunctions = parseOperatorIntent("What functions exist?");
    const parsedVariables = parseOperatorIntent("What variables matter?");
    const parsedState = parseOperatorIntent("What is the state model?");
    const functions = await actionRouter.executeParsed(session.session_id, "What functions exist?");
    const docsFresh = await actionRouter.executeParsed(session.session_id, "Are the docs up to date?");
    const flow = buildFlowchartState();
    console.log(JSON.stringify({
      simpleComplexity: simple.complexity,
      contextHasCodeIndex: Boolean(packet.relevant_docs[".head-developer/CODE_INDEX.md"]?.includes("script.js")),
      contextHasFunctions: Boolean(packet.relevant_docs[".head-developer/FUNCTIONS.md"]?.includes("visibleFunction")),
      contextHasVariables: Boolean(packet.relevant_docs[".head-developer/VARIABLES.md"]?.includes("IMPORTANT_FLAG")),
      parsedFunctions: parsedFunctions?.action_type,
      parsedVariables: parsedVariables?.action_type,
      parsedState: parsedState?.action_type,
      functionAnswer: functions?.action.result.content_preview.includes("visibleFunction"),
      freshnessAnswer: docsFresh?.action.result.docs_fresh,
      flowDocsNodes: ["project_docs", "code_index", "function_docs", "variable_docs", "state_model_docs", "worker_handoff"].every((type) => flow.nodes.some((node) => node.type === type)),
      flowDocsEdge: flow.edges.some((edge) => edge.label === "docs -> next worker context")
    }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.simpleComplexity, "simple");
  assert.equal(payload.contextHasCodeIndex, true);
  assert.equal(payload.contextHasFunctions, true);
  assert.equal(payload.contextHasVariables, true);
  assert.equal(payload.parsedFunctions, "inspect_functions");
  assert.equal(payload.parsedVariables, "inspect_variables");
  assert.equal(payload.parsedState, "inspect_state_model");
  assert.equal(payload.functionAnswer, true);
  assert.equal(payload.freshnessAnswer, true);
  assert.equal(payload.flowDocsNodes, true);
  assert.equal(payload.flowDocsEdge, true);
});
