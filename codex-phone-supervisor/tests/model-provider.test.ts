import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorModel, validateSupervisorModelConfig } from "../backend/src/model-provider.js";

test("mock supervisor provider is not a runtime provider", () => {
  assert.throws(
    () => validateSupervisorModelConfig({ provider: "mock" as never, testMode: true }),
    /must be codex_cli, gcp_conversation_ai, nvidia_nim, or openai/,
  );
});

test("codex cli supervisor provider requires no cloud model config", () => {
  assert.doesNotThrow(
    () => validateSupervisorModelConfig({ provider: "codex_cli", testMode: false }),
  );
});

test("test supervisor doubles require explicit test mode", () => {
  assert.throws(
    () => validateSupervisorModelConfig({ provider: "codex_cli", testMode: false, testDouble: "deterministic" }),
    /test doubles require/,
  );
});

test("gcp conversation ai provider requires explicit agent config", () => {
  assert.throws(
    () => validateSupervisorModelConfig({ provider: "gcp_conversation_ai", testMode: false }),
    /GCP_CONVERSATION_PROJECT_ID/,
  );
});

test("gcp conversation ai endpoint must be a hostname", () => {
  assert.throws(
    () =>
      validateSupervisorModelConfig({
        provider: "gcp_conversation_ai",
        testMode: false,
        gcpConversationAi: {
          projectId: "project",
          location: "us-central1",
          agentId: "agent",
          languageCode: "en-US",
          apiEndpoint: "https://us-central1-dialogflow.googleapis.com",
        },
      }),
    /hostname/,
  );
});

test("nvidia nim provider requires endpoint, model, and api key", () => {
  assert.throws(
    () => validateSupervisorModelConfig({ provider: "nvidia_nim", testMode: false }),
    /NVIDIA_NIM_BASE_URL/,
  );
});

test("nvidia nim http endpoint requires explicit insecure opt-in", () => {
  assert.throws(
    () =>
      validateSupervisorModelConfig({
        provider: "nvidia_nim",
        testMode: false,
        nvidiaNim: {
          baseUrl: "http://10.0.0.2:8000/v1",
          model: "nvidia/test-model",
          apiKeyPresent: true,
          apiKey: "present",
          allowInsecureHttp: false,
        },
      }),
    /NVIDIA_NIM_ALLOW_INSECURE_HTTP/,
  );
});

test("deterministic test supervisor routes explicit project mention", async () => {
  const provider = createSupervisorModel({ provider: "codex_cli", testMode: true, testDouble: "deterministic" });
  const decision = await provider.routeProject({
    text: "Use daybot",
    candidates: [
      { name: "Codex Phone Supervisor", path: "/projects/phone", signals: ["package.json"] },
      { name: "Daybot", path: "/projects/daybot", signals: ["package.json"] },
    ],
  });
  assert.equal(decision.status, "selected");
  assert.equal(decision.selected_project_name, "Daybot");
});

test("supervisor risk classifier applies deterministic firewall rules before model calls", async () => {
  const provider = createSupervisorModel({ provider: "codex_cli", testMode: true, testDouble: "deterministic" });
  assert.equal(await provider.classifyRisk("git push origin main"), "high");
  assert.equal(await provider.classifyRisk("npm install left-pad"), "medium");
});

test("deterministic test development router asks before ambiguous product work", async () => {
  const provider = createSupervisorModel({ provider: "codex_cli", testMode: true, testDouble: "deterministic" });
  const decision = await provider.developmentTurn({
    text: "Make it more polished, but ask me if you need a product choice.",
    projectName: "codex-demo-app",
    workspacePath: "/workspace/codex-demo-app",
    currentStatus: "completed",
    activeTask: "Create static app",
    summary: "Created a tiny habit tracker.",
    latestCodexMessage: "Created files.",
    filesModified: ["index.html"],
    commandsCompleted: [],
    commandsFailed: [],
    pendingApprovals: [],
    errors: [],
    recentMessages: [],
  });
  assert.equal(decision.action, "ask_user");
  assert.match(decision.assistant_message, /visual polish|analytics|reminders/i);
});

test("deterministic test development router sends concrete implementation work to Codex", async () => {
  const provider = createSupervisorModel({ provider: "codex_cli", testMode: true, testDouble: "deterministic" });
  const decision = await provider.developmentTurn({
    text: "Implement streak counters and empty states.",
    projectName: "codex-demo-app",
    workspacePath: "/workspace/codex-demo-app",
    currentStatus: "completed",
    activeTask: "Create static app",
    summary: "Created a tiny habit tracker.",
    latestCodexMessage: "Created files.",
    filesModified: ["index.html"],
    commandsCompleted: [],
    commandsFailed: [],
    pendingApprovals: [],
    errors: [],
    recentMessages: [],
  });
  assert.equal(decision.action, "call_tool");
  assert.equal(decision.tool_name, "send_codex_instruction");
  assert.match(String(decision.tool_arguments?.instruction ?? ""), /streak/i);
});

test("deterministic test development router can choose non-Codex state tools", async () => {
  const provider = createSupervisorModel({ provider: "codex_cli", testMode: true, testDouble: "deterministic" });
  const decision = await provider.developmentTurn({
    text: "Show me the raw event timeline.",
    projectName: "codex-demo-app",
    workspacePath: "/workspace/codex-demo-app",
    currentStatus: "completed",
    activeTask: "Create static app",
    summary: "Created a tiny habit tracker.",
    latestCodexMessage: "Created files.",
    filesModified: ["index.html"],
    commandsCompleted: [],
    commandsFailed: [],
    pendingApprovals: [],
    errors: [],
    recentMessages: [],
  });
  assert.equal(decision.action, "call_tool");
  assert.equal(decision.tool_name, "get_codex_events");
});
