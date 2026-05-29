import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { classifyApproval } from "./approval-firewall.js";
import type { ProjectCandidate, SupervisorModelProvider } from "./types.js";

export const supervisorToolNames = [
  "get_codex_status",
  "get_codex_events",
  "get_codex_summary",
  "send_codex_instruction",
  "create_project",
  "get_access_summary",
  "get_git_diff_summary",
  "get_pending_approval",
  "approve_action",
  "deny_action",
  "stop_session",
] as const;

export type SupervisorToolName = typeof supervisorToolNames[number];
export type SupervisorToolArguments = Record<string, string | number | boolean | null>;

export type SupervisorModelConfig = {
  provider: SupervisorModelProvider;
  testMode: boolean;
  testDouble?: "deterministic" | null;
  gcpConversationAi?: {
    projectId: string;
    location: string;
    agentId: string;
    languageCode: string;
    apiEndpoint: string;
    environmentId?: string;
  };
  nvidiaNim?: {
    baseUrl: string;
    model: string;
    apiKeyPresent: boolean;
    apiKey?: string;
    allowInsecureHttp: boolean;
  };
  openai?: {
    model: string;
    apiKeyPresent: boolean;
  };
};

export type RouteProjectInput = {
  text: string;
  candidates: ProjectCandidate[];
  sessionId?: string;
};

export type RouteProjectOutput = {
  status: "needs_user" | "selected";
  assistant_message: string;
  selected_workspace_path: string | null;
  selected_project_name: string | null;
  confidence: "low" | "medium" | "high";
  reason: string;
};

export type DevelopmentTurnInput = {
  text: string;
  projectName: string;
  workspacePath: string;
  currentStatus: string;
  activeTask: string;
  summary: string;
  latestCodexMessage: string;
  filesModified: string[];
  commandsCompleted: string[];
  commandsFailed: string[];
  pendingApprovals: Array<{ command: string; reason: string; risk: string }>;
  errors: string[];
  recentMessages: Array<{ role: "user" | "assistant" | "system"; text: string }>;
};

export type DevelopmentTurnOutput = {
  action: "answer" | "ask_user" | "send_codex_instruction" | "call_tool";
  assistant_message: string;
  codex_instruction: string | null;
  tool_name: SupervisorToolName | null;
  tool_arguments: SupervisorToolArguments | null;
  confidence: "low" | "medium" | "high";
  reason: string;
};

export function validateSupervisorModelConfig(config: SupervisorModelConfig) {
  if (!["codex_cli", "gcp_conversation_ai", "nvidia_nim", "openai"].includes(config.provider)) {
    throw new Error("Supervisor model provider must be codex_cli, gcp_conversation_ai, nvidia_nim, or openai.");
  }
  if (config.testDouble && !config.testMode) {
    throw new Error("Supervisor model test doubles require CODEX_PHONE_SUPERVISOR_TEST_MODE=1.");
  }
  if (config.provider === "gcp_conversation_ai") {
    if (
      !config.gcpConversationAi?.projectId ||
      !config.gcpConversationAi.location ||
      !config.gcpConversationAi.agentId ||
      !config.gcpConversationAi.languageCode ||
      !config.gcpConversationAi.apiEndpoint
    ) {
      throw new Error("GCP Conversation AI provider requires GCP_CONVERSATION_PROJECT_ID, GCP_CONVERSATION_LOCATION, GCP_CONVERSATION_AGENT_ID, GCP_CONVERSATION_LANGUAGE_CODE, and GCP_CONVERSATION_API_ENDPOINT.");
    }
    if (/^https?:\/\//i.test(config.gcpConversationAi.apiEndpoint)) {
      throw new Error("GCP_CONVERSATION_API_ENDPOINT must be a hostname, not a URL.");
    }
  }
  if (config.provider === "nvidia_nim") {
    if (!config.nvidiaNim?.baseUrl || !config.nvidiaNim.model || !config.nvidiaNim.apiKeyPresent || !config.nvidiaNim.apiKey) {
      throw new Error("NVIDIA NIM provider requires NVIDIA_NIM_BASE_URL, NVIDIA_NIM_MODEL, and NVIDIA_NIM_API_KEY.");
    }
    const baseUrl = new URL(config.nvidiaNim.baseUrl);
    if (baseUrl.protocol === "http:" && !config.nvidiaNim.allowInsecureHttp) {
      throw new Error("NVIDIA_NIM_ALLOW_INSECURE_HTTP=1 is required when NVIDIA_NIM_BASE_URL uses http://.");
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new Error("NVIDIA_NIM_BASE_URL must use http:// or https://.");
    }
  }
  if (config.provider === "openai") {
    if (!config.openai?.model || !config.openai.apiKeyPresent) {
      throw new Error("OpenAI supervisor provider requires OPENAI_MODEL and OPENAI_API_KEY.");
    }
  }
}

function deterministicTestSupervisorModel() {
  return {
    routeProject: deterministicTestRouteProject,
    developmentTurn: deterministicTestDevelopmentTurn,
    async summarize(text: string) {
      return text;
    },
    async classifyRisk(action: string) {
      const firewallClassification = classifyApproval(action);
      if (firewallClassification.risk) return firewallClassification.risk;
      return /delete|deploy|gcloud|git push|twilio/i.test(action) ? "high" : "medium";
    },
  };
}

function localCodexCliSupervisorModel() {
  return {
    routeProject: deterministicTestRouteProject,
    developmentTurn: deterministicTestDevelopmentTurn,
    async summarize(text: string) {
      return text;
    },
    async classifyRisk(action: string) {
      const firewallClassification = classifyApproval(action);
      if (firewallClassification.risk) return firewallClassification.risk;
      return /delete|deploy|gcloud|git push|twilio/i.test(action) ? "high" : "medium";
    },
  };
}

function stableDialogflowSessionId(seed: string) {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function extractTextMessages(response: unknown) {
  const messages = (response as { queryResult?: { responseMessages?: Array<{ text?: { text?: string[] } }> } }).queryResult?.responseMessages ?? [];
  return messages.flatMap((message) => message.text?.text ?? []).join("\n").trim();
}

function parseStructuredDecision(text: string): RouteProjectOutput {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error("GCP Conversation AI response did not include a JSON project-routing decision.");
  }
  const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as RouteProjectOutput;
  if (parsed.status !== "needs_user" && parsed.status !== "selected") {
    throw new Error("Supervisor project-routing decision has an invalid status.");
  }
  if (!parsed.assistant_message?.trim()) {
    throw new Error("Supervisor project-routing decision is missing assistant_message.");
  }
  if (parsed.confidence !== "low" && parsed.confidence !== "medium" && parsed.confidence !== "high") {
    throw new Error("Supervisor project-routing decision has an invalid confidence.");
  }
  return parsed;
}

function parseDevelopmentDecision(text: string): DevelopmentTurnOutput {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error("Supervisor development decision did not include JSON.");
  }
  const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as DevelopmentTurnOutput;
  if (parsed.action !== "answer" && parsed.action !== "ask_user" && parsed.action !== "send_codex_instruction" && parsed.action !== "call_tool") {
    throw new Error("Supervisor development decision has an invalid action.");
  }
  if (!parsed.assistant_message?.trim()) {
    throw new Error("Supervisor development decision is missing assistant_message.");
  }
  if (parsed.confidence !== "low" && parsed.confidence !== "medium" && parsed.confidence !== "high") {
    throw new Error("Supervisor development decision has an invalid confidence.");
  }
  if (parsed.action === "send_codex_instruction" && !parsed.codex_instruction?.trim()) {
    throw new Error("Supervisor development decision selected send_codex_instruction without codex_instruction.");
  }
  if (parsed.action === "call_tool") {
    if (!parsed.tool_name || !supervisorToolNames.includes(parsed.tool_name)) {
      throw new Error("Supervisor development decision selected call_tool with an invalid tool_name.");
    }
    if (parsed.tool_name === "send_codex_instruction") {
      const instruction = parsed.tool_arguments?.instruction;
      if (typeof instruction !== "string" || !instruction.trim()) {
        throw new Error("Supervisor development decision selected send_codex_instruction without an instruction argument.");
      }
    }
    if (parsed.tool_name === "create_project") {
      const projectName = parsed.tool_arguments?.project_name;
      const description = parsed.tool_arguments?.description;
      if (typeof projectName !== "string" || !projectName.trim() || typeof description !== "string" || !description.trim()) {
        throw new Error("Supervisor development decision selected create_project without project_name and description arguments.");
      }
    }
  }
  return {
    ...parsed,
    codex_instruction: parsed.codex_instruction?.trim() || null,
    tool_name: parsed.tool_name ?? (parsed.action === "send_codex_instruction" ? "send_codex_instruction" : null),
    tool_arguments: parsed.tool_arguments ?? (parsed.codex_instruction?.trim() ? { instruction: parsed.codex_instruction.trim() } : null),
  };
}

function buildDialogflowSessionPath(config: NonNullable<SupervisorModelConfig["gcpConversationAi"]>, seed: string) {
  const sessionId = stableDialogflowSessionId(seed);
  const base = [
    "projects",
    encodeURIComponent(config.projectId),
    "locations",
    encodeURIComponent(config.location),
    "agents",
    encodeURIComponent(config.agentId),
  ];
  if (config.environmentId) {
    base.push("environments", encodeURIComponent(config.environmentId));
  }
  base.push("sessions", sessionId);
  return base.join("/");
}

async function detectIntent(config: NonNullable<SupervisorModelConfig["gcpConversationAi"]>, text: string, sessionSeed: string) {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Google authentication did not return an access token.");

  const sessionPath = buildDialogflowSessionPath(config, sessionSeed);
  const response = await fetch(`https://${config.apiEndpoint}/v3/${sessionPath}:detectIntent`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      queryInput: {
        text: { text },
        languageCode: config.languageCode,
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GCP Conversation AI detectIntent failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body) as unknown;
}

function buildRouteProjectPrompt(input: RouteProjectInput) {
  return [
    "Task: choose the Codex project for this user message.",
    "Return only JSON with keys: status, assistant_message, selected_workspace_path, selected_project_name, confidence, reason.",
    "status must be selected or needs_user. Ask one concise question when unclear.",
    "Never execute tools or ask for credentials.",
    "",
    "Candidate projects:",
    input.candidates.map((candidate) => `- ${candidate.name}: ${candidate.path}`).join("\n") || "(none)",
    "",
    `User message: ${input.text}`,
  ].join("\n");
}

const routeProjectResponseSchema = {
  type: "OBJECT",
  required: ["status", "assistant_message", "selected_workspace_path", "selected_project_name", "confidence", "reason"],
  properties: {
    status: { type: "STRING", enum: ["needs_user", "selected"] },
    assistant_message: { type: "STRING" },
    selected_workspace_path: { type: "STRING", nullable: true },
    selected_project_name: { type: "STRING", nullable: true },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    reason: { type: "STRING" },
  },
};

const developmentTurnResponseSchema = {
  type: "OBJECT",
  required: ["action", "assistant_message", "codex_instruction", "tool_name", "tool_arguments", "confidence", "reason"],
  properties: {
    action: { type: "STRING", enum: ["answer", "ask_user", "send_codex_instruction", "call_tool"] },
    assistant_message: { type: "STRING" },
    codex_instruction: { type: "STRING", nullable: true },
    tool_name: { type: "STRING", enum: [...supervisorToolNames], nullable: true },
    tool_arguments: {
      type: "OBJECT",
      nullable: true,
      properties: {
        instruction: { type: "STRING", nullable: true },
        project_name: { type: "STRING", nullable: true },
        description: { type: "STRING", nullable: true },
        approval_id: { type: "STRING", nullable: true },
        session_id: { type: "STRING", nullable: true },
        project_id: { type: "STRING", nullable: true },
      },
    },
    confidence: { type: "STRING", enum: ["low", "medium", "high"] },
    reason: { type: "STRING" },
  },
};

function buildDevelopmentPrompt(input: DevelopmentTurnInput) {
  return [
    "Task: decide the next supervisor action for a Codex project conversation.",
    "Return only JSON with keys: action, assistant_message, codex_instruction, tool_name, tool_arguments, confidence, reason.",
    "action must be one of: answer, ask_user, call_tool. send_codex_instruction is accepted only for backward compatibility; prefer call_tool.",
    `Available backend tools: ${supervisorToolNames.join(", ")}.`,
    "Use call_tool for current Codex state, events, summaries, access summary, git diff, pending approvals, stopping a session, or sending concrete implementation work.",
    "Use call_tool create_project when the user asks for a new project, new website, new app, or project name that is not one of the existing candidates. tool_arguments must include project_name and description.",
    "Do not use create_project for implementation work in this/current/selected project.",
    "For call_tool send_codex_instruction, tool_arguments must include instruction. Do not include shell commands unless the user explicitly asks for them.",
    "Use ask_user when the user's development request is underspecified, includes a product choice, or explicitly asks you to ask before changing files.",
    "Use call_tool send_codex_instruction only when the request is concrete enough for Codex to execute in the selected workspace.",
    "Never execute shell commands. Never request secrets. Never bypass approvals. Risky actions are handled by the backend approval firewall.",
    "When sending Codex work, the instruction must be precise, scoped to the selected workspace, and include any safety constraints from the user.",
    "Never approve or deny unless the latest user message is an explicit approval or denial of the repeated pending action.",
    "Keep assistant_message concise and developer-like: state the decision and the next question or action.",
    "",
    `Selected project: ${input.projectName}`,
    `Workspace: ${input.workspacePath}`,
    `Current status: ${input.currentStatus}`,
    `Active task: ${input.activeTask || "none"}`,
    `Summary: ${input.summary || "none"}`,
    `Latest Codex message: ${input.latestCodexMessage || "none"}`,
    `Files modified: ${input.filesModified.join(", ") || "none"}`,
    `Commands completed: ${input.commandsCompleted.join(" | ") || "none"}`,
    `Commands failed: ${input.commandsFailed.join(" | ") || "none"}`,
    `Pending approvals: ${input.pendingApprovals.map((item) => `${item.command} (${item.risk}: ${item.reason})`).join(" | ") || "none"}`,
    `Errors: ${input.errors.join(" | ") || "none"}`,
    "",
    "Recent conversation:",
    input.recentMessages.length ? input.recentMessages.map((item) => `${item.role}: ${item.text}`).join("\n") : "(none)",
    "",
    `Latest user message: ${input.text}`,
  ].join("\n");
}

function chatCompletionsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/$/, "");
  url.pathname = `${normalizedPath}/chat/completions`;
  return url.toString();
}

function extractChatCompletionText(response: unknown) {
  const choice = (response as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

async function callNvidiaNim(config: NonNullable<SupervisorModelConfig["nvidiaNim"]>, messages: Array<{ role: "system" | "user"; content: string }>) {
  const response = await fetch(chatCompletionsUrl(config.baseUrl), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.1,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`NVIDIA NIM chat completion failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  const text = extractChatCompletionText(JSON.parse(body));
  if (!text) throw new Error("NVIDIA NIM chat completion returned no assistant text.");
  return text;
}

function deterministicTestRouteProject(input: RouteProjectInput): RouteProjectOutput {
  const text = input.text.toLowerCase();
  const explicit = input.candidates.find((candidate) => {
    const name = candidate.name.toLowerCase();
    return text.includes(name) || text.includes(name.replace(/[-_]/g, " "));
  });
  if (explicit) {
    return {
      status: "selected",
      assistant_message: `Selected ${explicit.name}.`,
      selected_workspace_path: explicit.path,
      selected_project_name: explicit.name,
      confidence: "high",
      reason: "The user explicitly mentioned the project name.",
    };
  }

  if (/\b(this repo|current repo|here)\b/i.test(input.text) && input.candidates.length) {
    const current = input.candidates[0];
    return {
      status: "selected",
      assistant_message: `Selected ${current.name}.`,
      selected_workspace_path: current.path,
      selected_project_name: current.name,
      confidence: "medium",
      reason: "The user referred to the current repo.",
    };
  }

  const names = input.candidates.slice(0, 4).map((candidate) => candidate.name).join(", ");
  return {
    status: "needs_user",
    assistant_message: names ? `Which project do you mean? I see ${names}.` : "Which project should I attach this Codex session to?",
    selected_workspace_path: null,
    selected_project_name: null,
    confidence: "low",
    reason: "No configured project matched the user message.",
  };
}

function deterministicTestDevelopmentTurn(input: DevelopmentTurnInput): DevelopmentTurnOutput {
  const asksForCurrentProject = /\b(this|current|selected)\s+project\b/i.test(input.text);
  const asksForNewProject = (
    /\bnew\b.*\b(project|website|site|app|agent)\b/i.test(input.text) ||
    /\b(?:called|named)\b/i.test(input.text) ||
    (/\b(build|create|make)\b.*\b(website|site|app|agent)\b/i.test(input.text) && !asksForCurrentProject)
  );
  if (asksForNewProject) {
    const quoted = input.text.match(/["“]([^"”]{2,80})["”]/)?.[1];
    const projectName = quoted || input.text.match(/\b(?:called|named|about|for)\s+([a-z0-9][a-z0-9 _-]{1,80})/i)?.[1]?.replace(/[.?!].*$/, "") || "new project";
    return {
      action: "call_tool",
      assistant_message: `I will create a new project named ${projectName}.`,
      codex_instruction: null,
      tool_name: "create_project",
      tool_arguments: { project_name: projectName, description: input.text },
      confidence: "high",
      reason: "The user requested a new project or website.",
    };
  }
  if (/access|what can codex access/i.test(input.text)) {
    return {
      action: "call_tool",
      assistant_message: "I will retrieve Codex access details through the backend access-summary tool.",
      codex_instruction: null,
      tool_name: "get_access_summary",
      tool_arguments: {},
      confidence: "high",
      reason: "The user asked what Codex can access.",
    };
  }
  if (/event|timeline|raw log/i.test(input.text)) {
    return {
      action: "call_tool",
      assistant_message: "I will fetch the Codex event timeline through the backend events tool.",
      codex_instruction: null,
      tool_name: "get_codex_events",
      tool_arguments: {},
      confidence: "high",
      reason: "The user asked for Codex events.",
    };
  }
  if (/what changed|diff/i.test(input.text)) {
    return {
      action: "call_tool",
      assistant_message: "I will retrieve the current git diff summary through the backend tool.",
      codex_instruction: null,
      tool_name: "get_git_diff_summary",
      tool_arguments: {},
      confidence: "high",
      reason: "The user asked what changed.",
    };
  }
  if (/approval|pending/i.test(input.text)) {
    return {
      action: "call_tool",
      assistant_message: "I will check pending approvals through the backend approval tool.",
      codex_instruction: null,
      tool_name: "get_pending_approval",
      tool_arguments: {},
      confidence: "high",
      reason: "The user asked about pending approvals.",
    };
  }
  if (/status|summary|what did/i.test(input.text)) {
    return {
      action: "call_tool",
      assistant_message: "I will read the Codex session summary through the backend tool.",
      codex_instruction: null,
      tool_name: "get_codex_summary",
      tool_arguments: {},
      confidence: "high",
      reason: "The user asked for project state.",
    };
  }
  if (/ask me|choice|which|what should/i.test(input.text)) {
    return {
      action: "ask_user",
      assistant_message: "Before I change files, choose the direction: visual polish, habit analytics, or reminders?",
      codex_instruction: null,
      tool_name: null,
      tool_arguments: null,
      confidence: "high",
      reason: "The user requested a product choice before implementation.",
    };
  }
  if (/continue|implement|build|create|make|add|fix|update/i.test(input.text)) {
    return {
      action: "call_tool",
      assistant_message: "I will send that implementation request to Codex for the selected project.",
      codex_instruction: input.text,
      tool_name: "send_codex_instruction",
      tool_arguments: { instruction: input.text },
      confidence: "medium",
      reason: "The user requested implementation work.",
    };
  }
  return {
    action: "ask_user",
    assistant_message: "What concrete change should Codex make in this project?",
    codex_instruction: null,
    tool_name: null,
    tool_arguments: null,
    confidence: "low",
    reason: "The user message did not identify a concrete next action.",
  };
}

export function createSupervisorModel(config: SupervisorModelConfig) {
  validateSupervisorModelConfig(config);
  if (config.testDouble === "deterministic") return deterministicTestSupervisorModel();
  if (config.provider === "codex_cli") return localCodexCliSupervisorModel();
  return {
    async routeProject(input: RouteProjectInput) {
      if (config.provider === "gcp_conversation_ai") {
        const response = await detectIntent(config.gcpConversationAi!, buildRouteProjectPrompt(input), input.sessionId || input.text);
        return parseStructuredDecision(extractTextMessages(response));
      }
      if (config.provider === "nvidia_nim") {
        const text = await callNvidiaNim(config.nvidiaNim!, [
          {
            role: "system",
            content: "You are Codex Phone Supervisor's project router. Return only JSON. Do not execute tools, request credentials, or issue shell commands.",
          },
          { role: "user", content: buildRouteProjectPrompt(input) },
        ]);
        return parseStructuredDecision(text);
      }
      throw new Error(`${config.provider} supervisor model calls are configured but not executed in local dry-run mode.`);
    },
    async developmentTurn(input: DevelopmentTurnInput) {
      if (config.provider === "nvidia_nim") {
        const text = await callNvidiaNim(config.nvidiaNim!, [
          {
            role: "system",
            content: "You are Codex Phone Supervisor's high-level developer agent. Return only JSON with action, assistant_message, codex_instruction, tool_name, tool_arguments, confidence, reason. Do not execute commands.",
          },
          { role: "user", content: buildDevelopmentPrompt(input) },
        ]);
        return parseDevelopmentDecision(text);
      }
      throw new Error(`${config.provider} supervisor development turns are not implemented.`);
    },
    async summarize(text: string) {
      if (config.provider === "gcp_conversation_ai") {
        const response = await detectIntent(config.gcpConversationAi!, `Summarize this Codex supervisor state concisely:\n\n${text}`, `summary:${text.slice(0, 200)}`);
        return extractTextMessages(response);
      }
      if (config.provider === "nvidia_nim") {
        return callNvidiaNim(config.nvidiaNim!, [
          {
            role: "system",
            content: "Summarize Codex supervisor state for a phone caller. Be concise, factual, and never reveal secret values.",
          },
          { role: "user", content: text },
        ]);
      }
      throw new Error(`${config.provider} supervisor model calls are configured but not executed in local dry-run mode.`);
    },
    async classifyRisk(action: string) {
      const firewallClassification = classifyApproval(action);
      if (firewallClassification.risk) return firewallClassification.risk;
      if (config.provider === "gcp_conversation_ai") {
        const response = await detectIntent(config.gcpConversationAi!, `Classify risk as exactly one word: low, medium, or high.\nAction: ${action}`, `risk:${action}`);
        const risk = extractTextMessages(response).toLowerCase().trim();
        if (risk !== "low" && risk !== "medium" && risk !== "high") throw new Error(`GCP Conversation AI returned invalid risk classification: ${risk}`);
        return risk;
      }
      if (config.provider === "nvidia_nim") {
        const risk = (
          await callNvidiaNim(config.nvidiaNim!, [
            { role: "system", content: "Classify the action risk as exactly one word: low, medium, or high." },
            { role: "user", content: action },
          ])
        ).toLowerCase().trim();
        if (risk !== "low" && risk !== "medium" && risk !== "high") throw new Error(`NVIDIA NIM returned invalid risk classification: ${risk}`);
        return risk;
      }
      throw new Error(`${config.provider} supervisor model calls are configured but not executed in local dry-run mode.`);
    },
  };
}
