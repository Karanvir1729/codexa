import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { createSupervisorModel, type SupervisorModelConfig } from "./model-provider.js";
import { extractFinalAgentText, parseCodexJsonl } from "./parser.js";
import type { ProjectCandidate, SessionState, SupervisorEvent, SupervisorModelProvider } from "./types.js";

export type ProjectSelectionDecision = {
  status: "needs_user" | "selected";
  assistant_message: string;
  selected_workspace_path: string | null;
  selected_project_name: string | null;
  confidence: "low" | "medium" | "high";
  reason: string;
};

const projectMarkers = ["package.json", ".git", "pyproject.toml", "Cargo.toml", "go.mod", "README.md"];
const ignoredProjectDirectoryNames = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "test-results",
  "tmp",
]);

function isDirectory(candidate: string) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function realPathForExistingDirectory(candidate: string) {
  if (!isDirectory(candidate)) throw new Error(`Workspace is not an existing directory: ${candidate}`);
  return fs.realpathSync(candidate);
}

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectSignals(directory: string) {
  return projectMarkers.filter((marker) => fs.existsSync(path.join(directory, marker)));
}

function candidateFor(directory: string, extraSignals: string[] = [], options: { requireSignals?: boolean } = {}): ProjectCandidate | null {
  if (!isDirectory(directory)) return null;
  const realPath = fs.realpathSync(directory);
  const signals = [...new Set([...extraSignals, ...projectSignals(realPath)])];
  if (options.requireSignals && !signals.length) return null;
  return {
    name: path.basename(realPath),
    path: realPath,
    signals,
  };
}

function isGeneratedProjectsContainerRoot(directory: string) {
  try {
    const realPath = fs.realpathSync(directory);
    const newProjectsRoot = fs.realpathSync(config.newProjectsRoot);
    return realPath === newProjectsRoot && projectSignals(realPath).length === 0;
  } catch {
    return false;
  }
}

export function listProjectCandidates() {
  const candidates = new Map<string, ProjectCandidate>();
  for (const root of [config.defaultWorkspacePath, ...config.projectRoots]) {
    const rootCandidate = candidateFor(root, ["configured_root"]);
    if (!rootCandidate) continue;
    if (!isGeneratedProjectsContainerRoot(rootCandidate.path)) {
      candidates.set(rootCandidate.path, rootCandidate);
    }

    for (const entry of fs.readdirSync(rootCandidate.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ignoredProjectDirectoryNames.has(entry.name)) continue;
      const child = candidateFor(path.join(rootCandidate.path, entry.name), [], { requireSignals: true });
      if (child) candidates.set(child.path, child);
    }
  }
  return [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function buildProjectSelectorSchema(sessionId: string) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const schemaPath = path.join(config.runtimeDir, `${sessionId}.project-selector.schema.json`);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["status", "assistant_message", "selected_workspace_path", "selected_project_name", "confidence", "reason"],
    properties: {
      status: { type: "string", enum: ["needs_user", "selected"] },
      assistant_message: { type: "string" },
      selected_workspace_path: { type: ["string", "null"] },
      selected_project_name: { type: ["string", "null"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      reason: { type: "string" },
    },
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  return schemaPath;
}

function buildProjectSelectorPrompt(session: SessionState, userText: string, candidates: ProjectCandidate[]) {
  return [
    "You are Codex Phone Supervisor's project-selection chat model.",
    "Before coding starts, identify the exact local project/workspace the user wants to work in.",
    "Do not edit files. Do not run shell commands. Do not request network, install, delete, deploy, git push, secret, or credential actions.",
    "Use a short back-and-forth conversation. If the project is not clear, ask exactly one concise question.",
    "Select a workspace only when the user's words clearly identify one configured candidate.",
    "If the user says current repo, this repo, supervisor, or here, choose the configured current workspace candidate.",
    "Return only JSON matching the provided schema.",
    "",
    `Current supervisor workspace: ${config.defaultWorkspacePath}`,
    `Allowed project roots: ${config.projectRoots.join(", ")}`,
    "",
    "Candidate projects:",
    candidates.length
      ? candidates.map((item) => `- ${item.name}: ${item.path} [${item.signals.join(", ") || "directory"}]`).join("\n")
      : "(No candidate projects were found under the configured roots.)",
    "",
    "Prior project-selection conversation:",
    session.project_discovery.conversation.length
      ? session.project_discovery.conversation.map((turn) => `${turn.role}: ${turn.text}`).join("\n")
      : "(none)",
    "",
    `Latest user message: ${userText}`,
  ].join("\n");
}

function parseDecision(text: string): ProjectSelectionDecision {
  if (!text) throw new Error("Codex project selector returned an empty response.");
  const parsed = JSON.parse(text) as ProjectSelectionDecision;
  if (parsed.status !== "needs_user" && parsed.status !== "selected") {
    throw new Error(`Invalid project selector status: ${String((parsed as { status?: unknown }).status)}`);
  }
  if (!parsed.assistant_message?.trim()) throw new Error("Project selector response is missing assistant_message.");
  if (!["low", "medium", "high"].includes(parsed.confidence)) throw new Error("Project selector response has invalid confidence.");
  return parsed;
}

function summarizeProcessOutput(output: string) {
  return output.replace(/\s+/g, " ").trim().slice(0, 800);
}

function validateSelectedWorkspace(decision: ProjectSelectionDecision) {
  if (decision.status !== "selected") return decision;
  if (!decision.selected_workspace_path) {
    return {
      ...decision,
      status: "needs_user" as const,
      assistant_message: "I need the exact project folder before I can attach Codex to it. Which configured project should I use?",
      selected_workspace_path: null,
      selected_project_name: null,
      confidence: "low" as const,
      reason: "Selector marked the project selected without a workspace path.",
    };
  }

  const selected = realPathForExistingDirectory(decision.selected_workspace_path);
  const allowedRoots = [config.defaultWorkspacePath, ...config.projectRoots].map(realPathForExistingDirectory);
  if (!allowedRoots.some((root) => isWithinDirectory(selected, root))) {
    return {
      ...decision,
      status: "needs_user" as const,
      assistant_message: "That project is outside the configured project roots. Which configured project should I use?",
      selected_workspace_path: null,
      selected_project_name: null,
      confidence: "low" as const,
      reason: `Selected path is outside configured roots: ${selected}`,
    };
  }

  return {
    ...decision,
    selected_workspace_path: selected,
    selected_project_name: decision.selected_project_name || path.basename(selected),
  };
}

function supervisorModelConfig(): SupervisorModelConfig {
  return {
    provider: config.supervisorModelProvider as SupervisorModelProvider,
    testMode: config.testMode,
    testDouble: config.testSupervisorModelDouble as "deterministic" | null,
    gcpConversationAi: config.gcpConversationAi,
    nvidiaNim: config.nvidiaNim,
    openai: config.openai,
  };
}

async function runConfiguredModelProjectSelection(session: SessionState, userText: string, candidates: ProjectCandidate[]) {
  const model = createSupervisorModel(supervisorModelConfig());
  const decision = validateSelectedWorkspace(
    await model.routeProject({
      text: userText,
      candidates,
      sessionId: session.session_id,
    }),
  );
  return {
    decision,
    candidates,
    rawEvents: [
      {
        id: randomUUID(),
        session_id: session.session_id,
        ts: new Date().toISOString(),
        source: "system" as const,
        type: "project_selector.model_decision",
        message: decision.assistant_message,
        data: {
          provider: config.supervisorModelProvider,
          decision,
        },
      },
    ],
  };
}

export async function runProjectSelection(session: SessionState, userText: string) {
  const candidates = listProjectCandidates();
  if (
    config.supervisorModelProvider === "gcp_conversation_ai" ||
    config.supervisorModelProvider === "nvidia_nim"
  ) {
    return runConfiguredModelProjectSelection(session, userText, candidates);
  }

  const schemaPath = buildProjectSelectorSchema(session.session_id);
  const args = [
    "exec",
    "--json",
    "--output-schema",
    schemaPath,
    "-C",
    config.defaultWorkspacePath,
    "--skip-git-repo-check",
    "-s",
    "read-only",
    buildProjectSelectorPrompt(session, userText, candidates),
  ];

  const child = spawn(config.codexCommand, args, {
    cwd: config.defaultWorkspacePath,
    env: {
      ...process.env,
      CODEX_HOME: config.codexHome,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  const codexEvents = parseCodexJsonl(`${stdout}\n${stderr}`);
  const finalText = extractFinalAgentText(codexEvents);
  if (exitCode !== 0) {
    const details = summarizeProcessOutput(`${stderr}\n${stdout}`);
    throw new Error(`Codex project selector failed with exit code ${exitCode}${details ? `: ${details}` : "."}`);
  }
  const decision = validateSelectedWorkspace(parseDecision(finalText));
  const rawEvents: SupervisorEvent[] = codexEvents.map((event) => ({
    id: randomUUID(),
    session_id: session.session_id,
    ts: new Date().toISOString(),
    source: "codex",
    type: "project_selector.event",
    message: event.type,
    data: event,
  }));
  return { decision, candidates, rawEvents };
}
