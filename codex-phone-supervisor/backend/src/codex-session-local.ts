import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { parseCodexJsonl, extractFinalAgentText } from "./parser.js";
import { detectCodexHistory, findVerifiedCodexRollout } from "./codex-history.js";
import { CommandRunner } from "./command-runner.js";
import { classifyCommand } from "./command-policy.js";
import { generateRunSummary } from "./summary.js";
import { startPreviewForSession } from "./preview.js";
import { pushProjectToGitHub, type GitHubProjectPushResult } from "./github-repo.js";
import {
  appendAuditEvent,
  appendOrchestratorEvent,
  getRunSummary,
  getSession,
  getTask,
  listCommandEvents,
  upsertCommandEvent,
  upsertRunSummary,
  upsertSession,
  upsertTask,
} from "./store.js";
import { upsertProject } from "./project-store.js";
import type {
  ApprovedPlanRecord,
  CommandEventRecord,
  LocalCodexFlowchartSummary,
  LocalCodexFlowchartNodeKind,
  LocalCodexSubagentAdvisorUpdate,
  LocalCodexSubagentReport,
  LocalCodexValidationCommandResult,
  LocalCodexValidationResult,
  PlannerDecision,
  ProjectRecord,
  SessionState,
  SupervisorEvent,
  TaskRecord,
} from "./types.js";

export const LOCAL_CODEX_BACKEND = "codex_session_local" as const;
export const LOCAL_CODEX_WORKER_ID = "codex_session_local";

type LocalCodexReport = {
  summary: string;
  status: "completed" | "failed" | "needs_approval" | "running";
  final_summary?: string;
  files_changed: string[];
  required_files: string[];
  validation_commands: string[];
  docs_updated: boolean;
  preview_entry?: string;
  subagents: LocalCodexSubagentReport[];
  flowchart_summary: LocalCodexFlowchartSummary | null;
  errors: string[];
};

function nowIso() {
  return new Date().toISOString();
}

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function unique(values: string[]) {
  return [...new Set(values.map(normalizePath).filter(Boolean))].sort();
}

function uniquePlainText(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function browserConversationTranscript(session: SessionState) {
  return (session.recent_messages ?? [])
    .slice(-30)
    .map((message) => {
      const role = message.role === "assistant" ? "Codex" : message.role === "user" ? "User" : "System";
      const channel = message.channel ? ` (${message.channel})` : "";
      return `${role}${channel}: ${message.text.trim().slice(0, 2000)}`;
    })
    .filter((line) => !/:\s*$/.test(line))
    .join("\n");
}

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isDocFile(file: string) {
  const normalized = normalizePath(file);
  return normalized.startsWith(".head-developer/") || /^docs\//i.test(normalized) || /(^|\/)(README|CHANGELOG|RUNBOOK|SECURITY|OPERATIONS)\.md$/i.test(normalized);
}

function isInternalStateArtifact(file: string) {
  return normalizePath(file).startsWith(".head-developer/cli-state-store/");
}

function isAppFile(file: string) {
  const normalized = normalizePath(file);
  if (!normalized || isDocFile(normalized)) return false;
  return /\.(html|css|js|jsx|ts|tsx|mjs|cjs|json|svg|png|jpe?g|webp|gif|ico|mdx)$/i.test(normalized)
    || /(^|\/)(src|app|pages|components|scripts|styles|assets|public|server|api|shared|tests?)\//i.test(normalized);
}

function safeRead(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function listProjectFiles(root: string) {
  const files: string[] = [];
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
  function walk(dir: string) {
    if (files.length >= 2000) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = normalizePath(path.relative(root, absolute));
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(relative);
      if (files.length >= 2000) return;
    }
  }
  if (fs.existsSync(root)) walk(root);
  return files.sort();
}

function changedFilesFromBeforeAfter(before: string[], after: string[]) {
  const beforeSet = new Set(before);
  return after.filter((file) => !beforeSet.has(file));
}

function existingFiles(root: string, files: string[]) {
  return files.filter((file) => {
    const target = path.resolve(root, file);
    return isWithinDirectory(target, root) && fs.existsSync(target) && fs.statSync(target).isFile();
  });
}

function shellWords(command: string) {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}

function packageScripts(workspacePath: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workspacePath, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
  } catch {
    return {};
  }
}

function normalizeValidationCommand(command: string) {
  return command.replace(/\s+when\b.*$/i, "").trim();
}

function hasShellControl(command: string) {
  return /(?:&&|\|\||[;|<>`])/.test(command);
}

function executableValidationCommands(workspacePath: string, commands: string[]) {
  return unique(commands.map(normalizeValidationCommand).filter((command) => {
    if (!command) return false;
    if (hasShellControl(command)) return false;
    if (/^(verify|ensure|confirm|check that|inspect|open|manual|look for)\b/i.test(command)) return false;
    if (!/^(npm|pnpm|yarn|node|npx|bun|deno|python|python3|pytest|vitest|playwright|tsc|eslint|find|test|grep|rg|curl|git)\b/i.test(command)) return false;
    return classifyCommand(command, workspacePath, workspacePath).disposition === "allowed";
  }));
}

function defaultValidationCommands(workspacePath: string, files: string[], reportCommands: string[]) {
  const scripts = packageScripts(workspacePath);
  const packageCommands = [
    typeof scripts.typecheck === "string" ? "npm run typecheck" : "",
    typeof scripts.test === "string" ? "npm test" : "",
    typeof scripts.build === "string" ? "npm run build" : "",
  ];
  const jsChecks = files
    .filter((file) => /\.(?:js|mjs|cjs)$/i.test(file) && fs.existsSync(path.join(workspacePath, file)))
    .slice(0, 12)
    .map((file) => `node --check ${file}`);
  return executableValidationCommands(workspacePath, [...reportCommands, ...packageCommands, ...jsChecks]);
}

function buildSchemaFile(taskId: string) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const schemaPath = path.join(config.runtimeDir, `${taskId}.local-codex.schema.json`);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "status", "final_summary", "files_changed", "required_files", "validation_commands", "docs_updated", "preview_entry", "subagents", "flowchart_summary", "errors"],
    properties: {
      summary: { type: "string" },
      status: { type: "string", enum: ["completed", "failed", "needs_approval", "running"] },
      final_summary: { type: "string" },
      files_changed: { type: "array", items: { type: "string" } },
      required_files: { type: "array", items: { type: "string" } },
      validation_commands: { type: "array", items: { type: "string" } },
      docs_updated: { type: "boolean" },
      preview_entry: { type: "string" },
      subagents: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "responsibility", "status", "changed_files", "validation", "summary"],
          properties: {
            name: { type: "string" },
            responsibility: { type: "string" },
            status: { type: "string", enum: ["waiting", "running", "completed", "failed", "skipped", "unknown"] },
            changed_files: { type: "array", items: { type: "string" } },
            validation: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
          },
        },
      },
      flowchart_summary: {
        type: "object",
        additionalProperties: false,
        required: ["title", "overview", "nodes", "edges"],
        properties: {
          title: { type: "string" },
          overview: { type: "string" },
          nodes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "kind", "label", "status", "summary", "depends_on"],
              properties: {
                id: { type: "string" },
                kind: { type: "string", enum: ["user_request", "requirement_summary", "plan", "megaplan", "approval", "codex_session", "subagent_advisor", "subagent", "flowchart_maker", "validation", "preview", "final_summary"] },
                label: { type: "string" },
                status: { type: "string" },
                summary: { type: "string" },
                depends_on: { type: "array", items: { type: "string" } },
              },
            },
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["from", "to", "label"],
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                label: { type: "string" },
              },
            },
          },
        },
      },
      errors: { type: "array", items: { type: "string" } },
    },
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  return schemaPath;
}

function codexSharedArgs() {
  const args: string[] = [];
  if (config.localCodex.model) args.push("--model", config.localCodex.model);
  if (config.localCodex.profile) args.push("--profile", config.localCodex.profile);
  if (config.localCodex.profileV2) args.push("--profile-v2", config.localCodex.profileV2);
  if (config.localCodex.reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(config.localCodex.reasoningEffort)}`);
  if (config.localCodex.inheritShellEnvironment) args.push("-c", "shell_environment_policy.inherit=all");
  return args;
}

function codexFastReadOnlyArgs() {
  const args: string[] = [];
  if (config.localCodex.planningModel) args.push("--model", config.localCodex.planningModel);
  if (config.localCodex.planningProfile) args.push("--profile", config.localCodex.planningProfile);
  if (config.localCodex.planningProfileV2) args.push("--profile-v2", config.localCodex.planningProfileV2);
  if (config.localCodex.planningReasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(config.localCodex.planningReasoningEffort)}`);
  if (config.localCodex.inheritShellEnvironment) args.push("-c", "shell_environment_policy.inherit=all");
  return args;
}

function codexImplementationAccessArgs() {
  if (config.localCodex.bypassApprovalsAndSandbox) return ["--dangerously-bypass-approvals-and-sandbox"];
  return ["-s", config.localCodex.sandbox];
}

function codexCommandDisplay(args: string[]) {
  return `${path.basename(config.codexCommand)} ${args.join(" ")}`;
}

export function buildLocalCodexImplementationPrompt(input: {
  userGoal: string;
  project: ProjectRecord;
  requirementSummary?: string | null;
  approvedPlan?: ApprovedPlanRecord | null;
  plannerDecision?: PlannerDecision | null;
  conversationTranscript?: string | null;
}) {
  const proposedResponsibilities = input.approvedPlan?.proposed_task_split.length
    ? input.approvedPlan.proposed_task_split.map((item) => `${item.title}: ${item.goal}`).join("\n")
    : input.plannerDecision?.proposed_task_split.length
      ? input.plannerDecision.proposed_task_split.map((item) => `${item.title}: ${item.goal}`).join("\n")
      : "Decide the useful internal responsibilities yourself from the request.";
  const subagentAdvice = input.approvedPlan?.subagent_advice ?? input.plannerDecision?.subagent_advice ?? null;

  return [
    "You are Codex, the local orchestrator and implementation lead. The user is talking to you directly through this CLI-backed session.",
    "Use internal Codex subagents when useful, and for non-trivial work strongly prefer multiple named logical subagents so the browser flowchart shows the real responsibility split.",
    "Execution model: one local Codex CLI orchestrator session owns this repo.",
    `Runtime mode: implementation coding uses ${config.localCodex.reasoningEffort || "Codex default"} reasoning; short planning, intake, chat mirror, subagent-advisor, and flowchart helper sessions use ${config.localCodex.planningReasoningEffort || "Codex default"} reasoning.`,
    "You choose how many logical subagents to use and what to name them. Consider product/UI, backend/API, shared logic, data, tests, docs, integration, validation, and research responsibilities only when they fit the task.",
    "Do not collapse distinct UI, API, shared logic, tests, docs, validation, and integration work into one generic subagent when separate responsibility lanes would be more truthful.",
    subagentAdvice?.recommended === false
      ? "The pre-implementation subagent check-in does not recommend internal subagents. Keep this run single-lane unless you need to stop and ask before changing that."
      : subagentAdvice?.recommended === true
        ? "The pre-implementation subagent check-in says internal subagents are useful. You still choose the actual count and names during this CLI run."
        : "If internal subagents become useful, choose them yourself and report their names and responsibilities.",
    "If your subagent strategy would materially change scope, cost, risk, or timeline from the approved Megaplan, stop and return status needs_approval instead of silently expanding.",
    "Subagents are logical responsibility lanes inside this one CLI run; do not launch separate OS processes, disconnected workspaces, or tool sessions to simulate them.",
    "All work must happen in this single repo. Do not create disconnected workspaces, per-worker worktrees, external workers, Docker workers, GKE jobs, VM workers, or cloud control-plane resources.",
    "Do not use Firestore, GKE, GCP VM workers, Kubernetes Jobs, Cloud Run orchestration, Secret Manager Codex auth, GCS Codex bundles, worker callbacks, or distributed task state for this implementation path.",
    "There is one source of truth: the local repo.",
    "Treat .head-developer/MEGAPLAN.md as the approved implementation plan when it exists. Keep changes aligned with it unless the user revises the plan.",
    "Do not claim success unless files exist and validation passes.",
    "Do not run long-lived preview or dev servers as blocking foreground commands. If a server is needed for validation, start it in the background, verify it, stop it before the final JSON response, and report clear run instructions instead of hanging the CLI session.",
    "Use the Codex CLI tools, skills, plugins, and MCP servers available in this same local account when useful. Before relying on a requested skill or plugin, verify it is available in this CODEX_HOME; if it is missing, say so and continue with the best fallback. Do not fake plugin/tool output; report only what actually happened.",
    "You have full local CLI access. Keep product source of truth in this repo and avoid external/cloud orchestration unless the user explicitly requests it.",
    "Continuous improvement is part of your role: while implementing, look for bugs, UX gaps, performance issues, test gaps, maintainability problems, and feature opportunities that would make the product better.",
    "Do not silently expand scope. Implement only improvements that fit the approved plan or are required for correctness, validation, safety, or a trustworthy MVP.",
    "Record deferred improvements in .head-developer/IMPROVEMENTS.md with concise sections for bugs found, optimizations, feature ideas, follow-up experiments, and decisions that need user input.",
    "If a valuable improvement would materially change scope, architecture, data, cost, risk, or timeline, record it as a recommendation instead of implementing it without user approval.",
    "Report each logical subagent's responsibility, changed files, and validation result so the CLI can validate the repo.",
    "Subagent reporting is part of the product experience: once you choose subagents, state their Codex-chosen names early and keep their user-facing status summaries current.",
    "As work progresses, state concise CLI progress updates for any logical subagents you create, including each subagent's Codex-chosen name, current status, and user-facing summary.",
    "Do not include file paths, code, commands, internal IDs, branch names, or stack traces in subagent progress updates.",
    "Use $codex-flowchart-summary to produce the final flowchart_summary field. The supervisor persists that JSON as the browser flowchart source of truth.",
    "flowchart_summary must be user-facing: include the user request, requirement summary, Megaplan creation, approval gate, one Codex session, the parallel subagent advisor, your chosen subagents, parallel flowchart maker, validation, preview if available, and final summary.",
    "flowchart_summary must include every subagent you actually used or reported; do not merge several real subagents into one generic node. If you truly used no subagents, say so honestly.",
    "flowchart_summary must not include file paths, command strings, code snippets, package names, stack traces, stdout/stderr, branch names, internal IDs, worktree paths, or repo paths.",
    "",
    `Project: ${input.project.display_name}`,
    `Repo path: ${input.project.workspace_path}`,
    input.conversationTranscript ? `Browser conversation with Codex before this implementation run:\n${input.conversationTranscript}` : "",
    input.requirementSummary ? `Requirement summary: ${input.requirementSummary}` : "",
    `User request: ${input.userGoal}`,
    subagentAdvice ? `Subagent check-in approved before implementation: ${subagentAdvice.user_check_in}\nLikely responsibility areas: ${subagentAdvice.suggested_responsibilities.join(", ") || "none"}` : "",
    proposedResponsibilities ? `Suggested responsibility areas from planning. You may change the number of internal subagents:\n${proposedResponsibilities}` : "",
    "",
    "Required final response: return only JSON matching the provided schema.",
    "Return exactly one final JSON object after implementation and shell validation are complete; do not emit progress JSON with status running.",
    "The JSON must include summary, final_summary, files_changed, required_files, validation_commands, docs_updated, preview_entry, subagents, flowchart_summary, and errors.",
    "files_changed must list real repo-relative files you created or modified.",
    "required_files must list the files that must exist for the build to be considered complete.",
    "subagents must list the logical internal Codex subagents you actually used or intentionally skipped.",
    "final_summary should mention notable bugs fixed, optimizations made, and deferred improvement ideas when they exist.",
    "flowchart_summary.nodes must use concise labels and summary text suitable to display directly in a browser flowchart.",
  ].filter(Boolean).join("\n");
}

function headDeveloperDocs(input: {
  project: ProjectRecord;
  task: TaskRecord;
  userGoal: string;
  requirementSummary?: string | null;
  approvedPlan?: ApprovedPlanRecord | null;
  conversationTranscript?: string | null;
}) {
  const split = input.approvedPlan?.proposed_task_split ?? [];
  return {
    "PROJECT_BRIEF.md": [
      `# ${input.project.display_name}`,
      "",
      `User request: ${input.userGoal}`,
      input.requirementSummary ? `Requirement summary: ${input.requirementSummary}` : "",
      "",
      "V1 execution model: one local Codex CLI orchestrator session owns this repo.",
      "Continuous improvement: Codex records bug findings, optimizations, and future feature ideas in `.head-developer/IMPROVEMENTS.md` while keeping implementation scoped to the approved plan.",
    ].filter(Boolean).join("\n"),
    "TASK_GRAPH.md": [
      "# Local Codex Plan",
      "",
      "Execution backend: codex_session_local.",
      "Approved plan source: .head-developer/MEGAPLAN.md.",
      "Codex role: local CLI orchestrator.",
      "Subagents are logical Codex-internal responsibilities, not OS workers.",
      "",
      split.length ? split.map((item, index) => `${index + 1}. ${item.title}: ${item.goal}`).join("\n") : "Codex will decide the internal responsibility split.",
    ].join("\n"),
    "ARCHITECTURE.md": "V1 uses a single local repository and one local Codex CLI orchestrator session. Legacy distributed worker infrastructure is not part of the main build path.\n",
    "CONVERSATION.md": [
      "# Browser Conversation",
      "",
      "This is the browser-to-Codex conversation context included in the implementation CLI prompt.",
      "",
      input.conversationTranscript || "No prior browser conversation transcript was recorded for this implementation run.",
      "",
    ].join("\n"),
    "WORKER_HANDOFFS.md": "No external worker handoffs for v1. Logical subagent breakdown is recorded in `.head-developer/state.json` after Codex reports it.\n",
    "FLOWCHART.md": "The browser flowchart is rendered from `.head-developer/flowchart.json`, generated from Codex progress summaries by a short-lived parallel Codex flowchart session.\n",
    "DECISIONS.md": "Decision: build locally with codex_session_local for v1; distributed worker paths remain experimental/legacy.\n",
    "IMPROVEMENTS.md": [
      "# Continuous Improvement Log",
      "",
      "Codex updates this file during implementation with grounded observations from the local repo.",
      "",
      "## Bugs Found",
      "- None recorded yet.",
      "",
      "## Optimizations",
      "- None recorded yet.",
      "",
      "## Feature Ideas",
      "- None recorded yet.",
      "",
      "## Follow-up Experiments",
      "- None recorded yet.",
      "",
      "## Needs User Decision",
      "- None recorded yet.",
      "",
      "Scope rule: implement only changes that fit the approved plan or are required for correctness, validation, safety, or a trustworthy MVP. Record larger ideas for approval instead of silently expanding scope.",
      "",
    ].join("\n"),
    "RUNBOOK.md": "Run local validation from this repo. Start preview through the supervisor preview endpoint when an app entry exists.\n",
    "VALIDATION.md": "Validation will be updated from local command events after the Codex session completes.\n",
  };
}

function writeHeadDeveloperState(workspacePath: string, value: Record<string, unknown>) {
  const docsDir = path.join(workspacePath, ".head-developer");
  fs.mkdirSync(docsDir, { recursive: true });
  const statePath = path.join(docsDir, "state.json");
  fs.writeFileSync(statePath, `${JSON.stringify(value, null, 2)}\n`);
  return statePath;
}

function writeHeadDeveloperFlowchartJson(workspacePath: string, flowchart: LocalCodexFlowchartSummary) {
  const normalizedFlowchart = ensureSystemProcessNodes(flowchart);
  const docsDir = path.join(workspacePath, ".head-developer");
  fs.mkdirSync(docsDir, { recursive: true });
  const flowchartPath = path.join(docsDir, "flowchart.json");
  fs.writeFileSync(flowchartPath, `${JSON.stringify({
    schema_version: 1,
    generated_at: nowIso(),
    generator: "parallel_codex_flowchart_session",
    flowchart: normalizedFlowchart,
  }, null, 2)}\n`);
  return flowchartPath;
}

function writeHeadDeveloperSubagentAdvisorJson(workspacePath: string, update: LocalCodexSubagentAdvisorUpdate) {
  const docsDir = path.join(workspacePath, ".head-developer");
  fs.mkdirSync(docsDir, { recursive: true });
  const advisorPath = path.join(docsDir, "subagent-advisor.json");
  fs.writeFileSync(advisorPath, `${JSON.stringify({
    schema_version: 1,
    generated_at: nowIso(),
    generator: "parallel_codex_subagent_advisor",
    subagent_advisor: update,
  }, null, 2)}\n`);
  return advisorPath;
}

function initializeHeadDeveloperDocs(input: {
  project: ProjectRecord;
  task: TaskRecord;
  userGoal: string;
  requirementSummary?: string | null;
  approvedPlan?: ApprovedPlanRecord | null;
  conversationTranscript?: string | null;
}) {
  const docsDir = path.join(input.project.workspace_path, ".head-developer");
  fs.mkdirSync(docsDir, { recursive: true });
  for (const [file, content] of Object.entries(headDeveloperDocs(input))) {
    const target = path.join(docsDir, file);
    if (!fs.existsSync(target)) fs.writeFileSync(target, `${content.trim()}\n`);
  }
  return writeHeadDeveloperState(input.project.workspace_path, {
    backend: LOCAL_CODEX_BACKEND,
    task_id: input.task.task_id,
    project_id: input.project.project_id,
    status: "running",
    user_request: input.userGoal,
    requirement_summary: input.requirementSummary ?? null,
    conversation_transcript: input.conversationTranscript ?? null,
    approved_plan: input.approvedPlan ?? null,
    started_at: input.task.created_at,
    message: "Built by one local Codex orchestrator session.",
  });
}

function parseLocalCodexReport(text: string): LocalCodexReport {
  const fallback: LocalCodexReport = {
    summary: text || "Codex did not return a structured report.",
    status: "failed",
    final_summary: text || "",
    files_changed: [],
    required_files: [],
    validation_commands: [],
    docs_updated: false,
    preview_entry: "",
    subagents: [],
    flowchart_summary: null,
    errors: text ? ["Codex returned non-JSON output."] : ["Codex returned an empty response."],
  };
  if (!text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text) as Partial<LocalCodexReport>;
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : fallback.summary,
      status: parsed.status === "completed" || parsed.status === "failed" || parsed.status === "needs_approval" || parsed.status === "running" ? parsed.status : "failed",
      final_summary: typeof parsed.final_summary === "string" ? parsed.final_summary : typeof parsed.summary === "string" ? parsed.summary : "",
      files_changed: Array.isArray(parsed.files_changed) ? parsed.files_changed.map(String) : [],
      required_files: Array.isArray(parsed.required_files) ? parsed.required_files.map(String) : [],
      validation_commands: Array.isArray(parsed.validation_commands) ? parsed.validation_commands.map(String) : [],
      docs_updated: Boolean(parsed.docs_updated),
      preview_entry: typeof parsed.preview_entry === "string" ? parsed.preview_entry : "",
      subagents: Array.isArray(parsed.subagents) ? parsed.subagents.map((item) => ({
        name: typeof item?.name === "string" ? item.name : "Codex subagent",
        responsibility: typeof item?.responsibility === "string" ? item.responsibility : "",
        status: item?.status === "waiting" || item?.status === "running" || item?.status === "completed" || item?.status === "failed" || item?.status === "skipped" || item?.status === "unknown" ? item.status : "unknown",
        changed_files: Array.isArray(item?.changed_files) ? item.changed_files.map(String) : [],
        validation: Array.isArray(item?.validation) ? item.validation.map(String) : [],
        summary: typeof item?.summary === "string" ? item.summary : "",
      })) : [],
      flowchart_summary: parseFlowchartSummary((parsed as { flowchart_summary?: unknown }).flowchart_summary),
      errors: Array.isArray(parsed.errors) ? parsed.errors.map(String) : [],
    };
  } catch {
    return fallback;
  }
}

function writeCommandLog(eventId: string, stream: "stdout" | "stderr", value: string) {
  if (!value) return null;
  const dir = path.join(config.artifactsDir, "local-codex-logs");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${eventId}.${stream}.log`);
  fs.writeFileSync(filePath, value);
  return filePath;
}

function preview(value: string, maxChars = 4000) {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

const localFlowchartNodeKinds = new Set<LocalCodexFlowchartNodeKind>([
  "user_request",
  "requirement_summary",
  "plan",
  "megaplan",
  "approval",
  "codex_session",
  "subagent_advisor",
  "subagent",
  "flowchart_maker",
  "validation",
  "preview",
  "final_summary",
]);

function flowchartText(value: unknown, fallback = "") {
  const raw = typeof value === "string" ? value : fallback;
  return raw
    .replace(/`[^`]*`/g, "implementation detail")
    .replace(/\b(?:npm|pnpm|yarn|node|npx|bun|deno|python3?|pytest|vitest|playwright|tsc|eslint|docker|git|curl|rg|grep)\s+[^\n.;]*/gi, "local validation")
    .replace(/(?:^|[\s(])(?:\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/]|[\w.-]+\/)[^\s,;:)]+/g, " project file")
    .replace(/\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|html|css|md|svg|png|jpe?g|webp|gif|ico|yml|yaml)\b/gi, "project file")
    .replace(/\b(?:task|session|project|worker|cmd)_[a-z0-9-]+\b/gi, "runtime record")
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, "runtime id")
    .replace(/\\+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function flowchartId(value: unknown, fallback: string) {
  const id = typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") : "";
  return id || fallback;
}

function parseFlowchartSummary(value: unknown): LocalCodexFlowchartSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    title?: unknown;
    overview?: unknown;
    nodes?: unknown;
    edges?: unknown;
  };
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map((item, index) => {
      const node = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const rawKind = typeof node.kind === "string" ? node.kind : "";
      const kind = localFlowchartNodeKinds.has(rawKind as LocalCodexFlowchartNodeKind) ? rawKind as LocalCodexFlowchartNodeKind : "subagent";
      return {
        id: flowchartId(node.id, `${kind}-${index + 1}`),
        kind,
        label: flowchartText(node.label, kind.replace(/_/g, " ")),
        status: flowchartText(node.status, "recorded"),
        summary: flowchartText(node.summary, ""),
        depends_on: Array.isArray(node.depends_on) ? uniquePlainText(node.depends_on.map((item) => flowchartId(item, ""))).filter(Boolean) : [],
      };
    }).filter((node) => node.label)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(record.edges)
    ? record.edges.map((item) => {
      const edge = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        from: flowchartId(edge.from, ""),
        to: flowchartId(edge.to, ""),
        label: flowchartText(edge.label, "next"),
      };
    }).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    : [];
  if (!nodes.length) return null;
  return {
    title: flowchartText(record.title, "Codex implementation flow"),
    overview: flowchartText(record.overview, ""),
    nodes,
    edges,
  };
}

function firstFlowNodeId(summary: LocalCodexFlowchartSummary, kind: LocalCodexFlowchartNodeKind) {
  return summary.nodes.find((node) => node.kind === kind)?.id ?? "";
}

function flowNodeStatus(summary: LocalCodexFlowchartSummary, kind: LocalCodexFlowchartNodeKind) {
  return summary.nodes.find((node) => node.kind === kind)?.status ?? "";
}

function addFlowEdge(edges: LocalCodexFlowchartSummary["edges"], from: string, to: string, label: string) {
  if (!from || !to || from === to) return;
  if (edges.some((edge) => edge.from === from && edge.to === to)) return;
  edges.push({ from, to, label });
}

function ensureSystemProcessNodes(summary: LocalCodexFlowchartSummary): LocalCodexFlowchartSummary {
  const nodes = [...summary.nodes];
  const edges = [...summary.edges];
  const hasKind = (kind: LocalCodexFlowchartNodeKind) => nodes.some((node) => node.kind === kind);
  const requestId = firstFlowNodeId(summary, "user_request") || nodes[0]?.id || "";
  const requirementsId = firstFlowNodeId(summary, "requirement_summary");
  const planId = firstFlowNodeId(summary, "plan");
  const codexSessionId = firstFlowNodeId(summary, "codex_session");
  const finalSummaryId = firstFlowNodeId(summary, "final_summary");
  const preMegaplanId = planId || requirementsId || requestId;

  if (!hasKind("megaplan")) {
    nodes.push({
      id: "megaplan",
      kind: "megaplan",
      label: "Megaplan skill",
      status: "created",
      summary: "Codex turns clarified requirements into an approval-ready Megaplan.",
      depends_on: preMegaplanId ? [preMegaplanId] : [],
    });
  }
  if (!hasKind("approval")) {
    nodes.push({
      id: "approval-gate",
      kind: "approval",
      label: "Approval gate",
      status: "approved",
      summary: "Complex work waits for user approval before implementation starts.",
      depends_on: ["megaplan"],
    });
  }
  if (!hasKind("subagent_advisor")) {
    const codexStatus = flowNodeStatus(summary, "codex_session");
    const currentApprovalId = nodes.find((node) => node.kind === "approval")?.id ?? "";
    nodes.push({
      id: "subagent-advisor",
      kind: "subagent_advisor",
      label: "Subagent advisor",
      status: /running|working|in progress/i.test(codexStatus) ? "watching" : "updated",
      summary: "Parallel Codex process watches for useful internal subagent opportunities.",
      depends_on: codexSessionId ? [codexSessionId] : currentApprovalId ? [currentApprovalId] : [],
    });
  }
  if (!hasKind("flowchart_maker")) {
    const codexStatus = flowNodeStatus(summary, "codex_session");
    const currentSubagentAdvisorId = nodes.find((node) => node.kind === "subagent_advisor")?.id ?? "";
    nodes.push({
      id: "flowchart-maker",
      kind: "flowchart_maker",
      label: "Flowchart maker",
      status: /running|working|in progress/i.test(codexStatus) ? "running" : "updated",
      summary: "Parallel Codex process converts live summaries into this graph.",
      depends_on: [codexSessionId, currentSubagentAdvisorId].filter(Boolean),
    });
  }

  const megaplanId = nodes.find((node) => node.kind === "megaplan")?.id ?? "";
  const approvalId = nodes.find((node) => node.kind === "approval")?.id ?? "";
  const subagentAdvisorId = nodes.find((node) => node.kind === "subagent_advisor")?.id ?? "";
  const flowchartMakerId = nodes.find((node) => node.kind === "flowchart_maker")?.id ?? "";
  addFlowEdge(edges, preMegaplanId, megaplanId, "megaplan");
  addFlowEdge(edges, megaplanId, approvalId, "approval");
  addFlowEdge(edges, approvalId, codexSessionId, "starts");
  addFlowEdge(edges, codexSessionId || approvalId, subagentAdvisorId, "subagent advice");
  addFlowEdge(edges, codexSessionId, flowchartMakerId, "summarizes");
  addFlowEdge(edges, subagentAdvisorId, flowchartMakerId, "advisor input");
  addFlowEdge(edges, flowchartMakerId, finalSummaryId, "updates");

  return { ...summary, nodes, edges };
}

function fallbackFlowchartSummary(input: {
  task: TaskRecord;
  session: SessionState;
  report: LocalCodexReport;
  validation: LocalCodexValidationResult;
  previewLoaded: boolean | null;
}) {
  const nodes: LocalCodexFlowchartSummary["nodes"] = [
    {
      id: "user-request",
      kind: "user_request",
      label: "User request",
      status: "received",
      summary: flowchartText(input.task.user_goal),
      depends_on: [],
    },
    {
      id: "requirements",
      kind: "requirement_summary",
      label: "Requirements",
      status: "summarized",
      summary: flowchartText(input.session.requirement_summary || input.task.user_goal),
      depends_on: ["user-request"],
    },
    {
      id: "plan",
      kind: "plan",
      label: "Plan",
      status: "ready",
      summary: "Codex chose the implementation responsibilities inside one local CLI session.",
      depends_on: ["requirements"],
    },
    {
      id: "megaplan",
      kind: "megaplan",
      label: "Megaplan skill",
      status: "created",
      summary: "Codex turns clarified requirements into an approval-ready Megaplan.",
      depends_on: ["plan"],
    },
    {
      id: "approval-gate",
      kind: "approval",
      label: "Approval gate",
      status: "approved",
      summary: "Complex work waits for user approval before implementation starts.",
      depends_on: ["megaplan"],
    },
    {
      id: "codex-session",
      kind: "codex_session",
      label: "Codex CLI session",
      status: input.task.status,
      summary: "One local Codex CLI session owned the repo and coordinated the work.",
      depends_on: ["approval-gate"],
    },
    {
      id: "subagent-advisor",
      kind: "subagent_advisor",
      label: "Subagent advisor",
      status: input.task.status === "running" ? "watching" : "updated",
      summary: "Parallel Codex process watches for useful internal subagent opportunities.",
      depends_on: ["codex-session"],
    },
    {
      id: "flowchart-maker",
      kind: "flowchart_maker",
      label: "Flowchart maker",
      status: input.task.status === "running" ? "running" : "updated",
      summary: "Parallel Codex process converts live summaries into this graph.",
      depends_on: ["codex-session", "subagent-advisor"],
    },
  ];
  const subagentIds = input.report.subagents.map((subagent, index) => {
    const id = flowchartId(subagent.name, `subagent-${index + 1}`);
    nodes.push({
      id,
      kind: "subagent",
      label: flowchartText(subagent.name, `Subagent ${index + 1}`),
      status: flowchartText(subagent.status, "recorded"),
      summary: flowchartText(subagent.summary || subagent.responsibility),
      depends_on: ["codex-session"],
    });
    return id;
  });
  const validationDependsOn = subagentIds.length ? subagentIds : ["codex-session"];
  nodes.push({
    id: "validation",
    kind: "validation",
    label: "Validation",
    status: input.validation.status,
    summary: flowchartText(input.validation.status === "passed" ? "Local validation passed." : input.validation.summary),
    depends_on: validationDependsOn,
  });
  if (input.previewLoaded !== null) {
    nodes.push({
      id: "preview",
      kind: "preview",
      label: "Preview",
      status: input.previewLoaded ? "loaded" : "not available",
      summary: input.previewLoaded ? "Local preview loaded." : "No local preview was available.",
      depends_on: ["validation"],
    });
  }
  nodes.push({
    id: "final-summary",
    kind: "final_summary",
    label: "Final summary",
    status: input.task.status,
    summary: flowchartText(input.report.final_summary || input.report.summary || input.task.latest_summary),
    depends_on: input.previewLoaded !== null ? ["preview", "flowchart-maker"] : ["validation", "flowchart-maker"],
  });
  const edges = nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.id, label: "next" })));
  return {
    title: "Codex implementation flow",
    overview: flowchartText(input.report.summary || input.task.latest_summary),
    nodes,
    edges,
  };
}

const FLOWCHART_MAKER_TIMEOUT_MS = 5_000;
const FLOWCHART_WATCHER_INTERVAL_MS = 1_000;
const FLOWCHART_UPDATE_THROTTLE_MS = 1_000;
const SUBAGENT_ADVISOR_WATCHER_TIMEOUT_MS = 5_000;
const SUBAGENT_ADVISOR_WATCHER_INTERVAL_MS = 1_000;
const SUBAGENT_ADVISOR_UPDATE_THROTTLE_MS = 1_000;
const liveRolloutPaths = new Map<string, string>();
const flowchartMakerState = new Map<string, {
  stream: string;
  running: boolean;
  pending: boolean;
  lastStartedMs: number;
  watcher: NodeJS.Timeout | null;
  watcherStartedAt: string | null;
  beforeFiles: string[];
  lastWorkspaceSignature: string;
  latestWorkspaceActivity: string;
}>();
const subagentAdvisorWatcherState = new Map<string, {
  stream: string;
  running: boolean;
  pending: boolean;
  lastStartedMs: number;
  watcher: NodeJS.Timeout | null;
  watcherStartedAt: string | null;
  latestWorkspaceActivity: string;
}>();

function rolloutAgentMessageText(value: string) {
  try {
    const parsed = JSON.parse(value) as {
      summary?: unknown;
      final_summary?: unknown;
      subagents?: Array<{ name?: unknown; status?: unknown; summary?: unknown; responsibility?: unknown }>;
    };
    const lines: string[] = [];
    if (typeof parsed.summary === "string") lines.push(parsed.summary);
    for (const subagent of Array.isArray(parsed.subagents) ? parsed.subagents : []) {
      const name = typeof subagent.name === "string" ? subagent.name : "";
      if (!name) continue;
      const status = typeof subagent.status === "string" ? subagent.status : "running";
      const summary = typeof subagent.summary === "string" && subagent.summary.trim()
        ? subagent.summary
        : typeof subagent.responsibility === "string"
          ? subagent.responsibility
          : "";
      lines.push(`Codex subagent ${name} is ${status}: ${summary}`);
    }
    if (typeof parsed.final_summary === "string") lines.push(parsed.final_summary);
    return lines.filter(Boolean).join("\n") || value;
  } catch {
    return value;
  }
}

function extractRolloutAgentText(jsonl: string) {
  const messages: string[] = [];
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as {
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          message?: unknown;
          content?: Array<{ type?: string; text?: unknown }>;
        };
      };
      if (parsed.type === "event_msg" && parsed.payload?.type === "agent_message" && typeof parsed.payload.message === "string") {
        messages.push(rolloutAgentMessageText(parsed.payload.message));
      }
      if (parsed.type === "response_item" && parsed.payload?.type === "message" && parsed.payload.role === "assistant") {
        for (const item of parsed.payload.content ?? []) {
          if (item.type === "output_text" || item.type === "text") {
            if (typeof item.text === "string") messages.push(item.text);
          }
        }
      }
    } catch {
      // Ignore partial or non-JSON rollout lines while the CLI is still writing.
    }
  }
  return messages.join("\n");
}

function syncLiveCodexRollout(input: {
  taskId: string;
  sessionId: string;
  project: ProjectRecord;
  commandEvent: CommandEventRecord;
  prompt: string;
  startedAt: string;
}) {
  let rolloutPath = liveRolloutPaths.get(input.taskId) ?? "";
  let content = rolloutPath ? safeRead(rolloutPath) : "";
  if (!content) {
    const verified = findVerifiedCodexRollout({
      codexHome: config.codexHome,
      prompt: input.prompt,
      taskId: input.taskId,
      projectId: input.project.project_id,
      startedAt: input.startedAt,
      completedAt: null,
    });
    rolloutPath = verified?.rolloutPath ?? "";
    content = verified?.content ?? "";
    if (rolloutPath) liveRolloutPaths.set(input.taskId, rolloutPath);
  }
  if (!content) return;
  const agentText = extractRolloutAgentText(content);
  if (!agentText) return;
  if (rolloutPath && input.commandEvent.codex_rollout_path !== rolloutPath) {
    input.commandEvent.codex_rollout_path = rolloutPath;
    input.commandEvent.codex_rollout_host_path = rolloutPath;
    input.commandEvent.codex_home = config.codexHome;
    input.commandEvent.codex_home_host_path = config.codexHome;
    input.commandEvent.codex_history_kind = "exec";
    input.commandEvent.codex_history_confidence = "verified_by_prompt_match";
    upsertCommandEvent(input.commandEvent);
  }
  scheduleFlowchartSummaryUpdate({
    taskId: input.taskId,
    sessionId: input.sessionId,
    project: input.project,
    chunk: agentText,
  });
}

function flowchartMakerForTask(taskId: string) {
  const current = flowchartMakerState.get(taskId);
  if (current) return current;
  const created = {
    stream: "",
    running: false,
    pending: false,
    lastStartedMs: 0,
    watcher: null,
    watcherStartedAt: null,
    beforeFiles: [] as string[],
    lastWorkspaceSignature: "",
    latestWorkspaceActivity: "",
  };
  flowchartMakerState.set(taskId, created);
  return created;
}

function subagentAdvisorForTask(taskId: string) {
  const current = subagentAdvisorWatcherState.get(taskId);
  if (current) return current;
  const created = {
    stream: "",
    running: false,
    pending: false,
    lastStartedMs: 0,
    watcher: null,
    watcherStartedAt: null,
    latestWorkspaceActivity: "",
  };
  subagentAdvisorWatcherState.set(taskId, created);
  return created;
}

function appendFlowchartMakerStream(taskId: string, text: string) {
  if (!text) return;
  const state = flowchartMakerForTask(taskId);
  state.stream = `${state.stream}\n${text}`.slice(-12_000);
}

function appendSubagentAdvisorStream(taskId: string, text: string) {
  if (!text) return;
  const state = subagentAdvisorForTask(taskId);
  state.stream = `${state.stream}\n${text}`.slice(-12_000);
}

function workspaceActivitySummary(workspacePath: string, beforeFiles: string[]) {
  const currentFiles = listProjectFiles(workspacePath);
  const changedFiles = changedFilesFromBeforeAfter(beforeFiles, currentFiles).filter((file) => !isInternalStateArtifact(file));
  const appCount = changedFiles.filter(isAppFile).length;
  const docCount = changedFiles.filter(isDocFile).length;
  const otherCount = Math.max(0, changedFiles.length - appCount - docCount);
  return {
    signature: `${changedFiles.length}:${appCount}:${docCount}:${otherCount}:${currentFiles.length}`,
    summary: `WORKSPACE UPDATE: ${appCount} app/source change(s), ${docCount} documentation/state change(s), and ${otherCount} other repo change(s) observed by the flowchart watcher.`,
  };
}

function isTerminalTaskStatus(status: string | null | undefined) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function buildFlowchartMakerSchemaFile(taskId: string) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const schemaPath = path.join(config.runtimeDir, `${taskId}.flowchart-summary.schema.json`);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["title", "overview", "nodes", "edges"],
    properties: {
      title: { type: "string" },
      overview: { type: "string" },
      nodes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "label", "status", "summary", "depends_on"],
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["user_request", "requirement_summary", "plan", "megaplan", "approval", "codex_session", "subagent_advisor", "subagent", "flowchart_maker", "validation", "preview", "final_summary"] },
            label: { type: "string" },
            status: { type: "string" },
            summary: { type: "string" },
            depends_on: { type: "array", items: { type: "string" } },
          },
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to", "label"],
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            label: { type: "string" },
          },
        },
      },
    },
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  return schemaPath;
}

function buildSubagentAdvisorWatcherSchemaFile(taskId: string) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const schemaPath = path.join(config.runtimeDir, `${taskId}.subagent-advisor-live.schema.json`);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["recommended", "confidence", "status", "summary", "suggested_subagents", "user_check_in_needed"],
    properties: {
      recommended: { type: "boolean" },
      confidence: { type: "number" },
      status: { type: "string", enum: ["watching", "use_subagents", "single_lane_ok", "needs_user_check_in", "unknown"] },
      summary: { type: "string" },
      suggested_subagents: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "responsibility", "reason", "status"],
          properties: {
            name: { type: "string" },
            responsibility: { type: "string" },
            reason: { type: "string" },
            status: { type: "string", enum: ["candidate", "active", "not_needed", "needs_user_check_in"] },
          },
        },
      },
      user_check_in_needed: { type: "boolean" },
    },
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  return schemaPath;
}

function parseFlowchartMakerText(text: string) {
  if (!text.trim()) return null;
  try {
    return parseFlowchartSummary(JSON.parse(text));
  } catch {
    return null;
  }
}

function subagentAdvisorText(value: unknown, fallback = "") {
  return flowchartText(value, fallback).slice(0, 220);
}

function parseSubagentAdvisorWatcherText(text: string): Omit<LocalCodexSubagentAdvisorUpdate, "updated_at" | "source"> | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const status = typeof parsed.status === "string" && ["watching", "use_subagents", "single_lane_ok", "needs_user_check_in", "unknown"].includes(parsed.status)
      ? parsed.status as LocalCodexSubagentAdvisorUpdate["status"]
      : "unknown";
    const suggested = Array.isArray(parsed.suggested_subagents)
      ? parsed.suggested_subagents.map((item, index) => {
        const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const rawStatus = typeof record.status === "string" ? record.status : "";
        return {
          name: subagentAdvisorText(record.name, `Opportunity ${index + 1}`),
          responsibility: subagentAdvisorText(record.responsibility, ""),
          reason: subagentAdvisorText(record.reason, ""),
          status: ["candidate", "active", "not_needed", "needs_user_check_in"].includes(rawStatus)
            ? rawStatus as LocalCodexSubagentAdvisorUpdate["suggested_subagents"][number]["status"]
            : "candidate",
        };
      }).filter((item) => item.name && item.responsibility).slice(0, 8)
      : [];
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : Number(parsed.confidence);
    return {
      recommended: Boolean(parsed.recommended),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      status,
      summary: subagentAdvisorText(parsed.summary, "Subagent advisor checked the live implementation stream."),
      suggested_subagents: suggested,
      user_check_in_needed: Boolean(parsed.user_check_in_needed),
      error: null,
    };
  } catch {
    return null;
  }
}

function subagentAdvisorSummaryText(update: LocalCodexSubagentAdvisorUpdate) {
  const suggestions = update.suggested_subagents
    .map((item) => `${item.name}: ${item.responsibility}`)
    .join("; ");
  return suggestions ? `${update.summary} Suggested lanes: ${suggestions}.` : update.summary;
}

function buildFlowchartMakerPrompt(input: {
  task: TaskRecord;
  session: SessionState;
  stream: string;
  report?: LocalCodexReport | null;
  validation?: LocalCodexValidationResult | null;
  previewLoaded?: boolean | null;
}) {
  return [
    "Use $codex-flowchart-summary.",
    "You are the local Codex flowchart maker. Convert the current implementation summary into the browser flowchart JSON.",
    "Return only JSON matching the supplied schema. The supervisor writes your JSON into the repo-local flowchart artifact for the UI renderer.",
    "You have at most 5 seconds. Optimize for rapid truthful updates: produce the best valid partial graph from current evidence instead of waiting for completion.",
    "Be concise and use only the supplied summary state.",
    "Do not write files. Do not inspect the repo. Do not include code, file paths, command strings, internal IDs, stdout/stderr, worktree names, branch names, package names, or stack traces.",
    "Preserve the subagent names chosen by Codex. Include every reported_subagents entry as a separate subagent node.",
    "During live runs, infer subagent nodes only from Codex-authored implementation progress and do not invent names. If names are not available yet, show the Codex session as planning or running without fake subagent nodes.",
    "Include system process nodes for Megaplan creation, approval gate, the parallel subagent advisor, and the parallel flowchart maker so the user can understand how this UI is orchestrating Codex.",
    "This is a live update; represent partial progress honestly when the implementation is still running.",
    "",
    JSON.stringify({
      user_request: flowchartText(input.task.user_goal),
      requirement_summary: flowchartText(input.session.requirement_summary || input.task.user_goal),
      session_status: input.session.current_status,
      task_status: input.task.status,
      reported_subagents: (input.report?.subagents ?? input.task.codex_subagents ?? []).map((agent) => ({
        name: flowchartText(agent.name),
        status: agent.status,
        summary: flowchartText(agent.summary || agent.responsibility),
      })),
      latest_summary: flowchartText(input.report?.summary || input.task.latest_summary || input.session.latest_summary),
      final_summary: flowchartText(input.report?.final_summary || input.task.final_summary || ""),
      validation: input.validation ? {
        status: input.validation.status,
        summary: flowchartText(input.validation.summary),
      } : null,
      preview: input.previewLoaded === null || input.previewLoaded === undefined ? null : {
        loaded: input.previewLoaded,
      },
      subagent_advisor: input.task.codex_subagent_advisor ? {
        status: input.task.codex_subagent_advisor.status,
        summary: flowchartText(input.task.codex_subagent_advisor.summary),
        recommended: input.task.codex_subagent_advisor.recommended,
        user_check_in_needed: input.task.codex_subagent_advisor.user_check_in_needed,
        suggested_subagents: input.task.codex_subagent_advisor.suggested_subagents.map((item) => ({
          name: flowchartText(item.name),
          responsibility: flowchartText(item.responsibility),
          status: item.status,
        })),
      } : null,
      flowchart_watcher: {
        mode: "continuous parallel Codex flowchart watcher",
        interval_ms: FLOWCHART_WATCHER_INTERVAL_MS,
        update_throttle_ms: FLOWCHART_UPDATE_THROTTLE_MS,
        priority: "rapid truthful flowchart creation",
        latest_workspace_activity: flowchartText(flowchartMakerForTask(input.task.task_id).latestWorkspaceActivity),
      },
      required_system_nodes: ["Megaplan skill", "Approval gate", "Subagent advisor", "Flowchart maker"],
      implementation_stream_summary: flowchartText(input.stream, input.stream),
    }, null, 2),
  ].join("\n");
}

function buildSubagentAdvisorWatcherPrompt(input: {
  task: TaskRecord;
  session: SessionState;
  stream: string;
}) {
  return [
    "You are the fast parallel Codex subagent advisor for a live local Codex implementation run.",
    "Your job is to continuously identify where internal logical Codex subagents would help, based only on supplied live summaries.",
    "The implementation lead remains the source of truth and chooses the actual subagent count and names. You only advise on opportunities.",
    "Return quickly within 5 seconds. Prefer a useful partial assessment over waiting.",
    "Do not inspect files, write files, run commands, or include code, file paths, command strings, package names, branch names, internal IDs, or stack traces.",
    "Do not invent that a subagent exists. Mark suggestions as candidate unless the supplied stream says Codex actually started that subagent.",
    "Recommend subagents when distinct product/UI, backend/API, shared logic, data, tests, docs, integration, validation, research, or release responsibilities are visible.",
    "If adding subagents would materially change approved scope, set user_check_in_needed true.",
    "Return only JSON matching the supplied schema.",
    "",
    JSON.stringify({
      user_request: flowchartText(input.task.user_goal),
      requirement_summary: flowchartText(input.session.requirement_summary || input.task.user_goal),
      task_status: input.task.status,
      current_reported_subagents: (input.task.codex_subagents ?? []).map((agent) => ({
        name: flowchartText(agent.name),
        status: agent.status,
        summary: flowchartText(agent.summary || agent.responsibility),
      })),
      existing_advisor_summary: input.task.codex_subagent_advisor ? {
        status: input.task.codex_subagent_advisor.status,
        summary: flowchartText(input.task.codex_subagent_advisor.summary),
        suggestions: input.task.codex_subagent_advisor.suggested_subagents.map((item) => ({
          name: flowchartText(item.name),
          responsibility: flowchartText(item.responsibility),
          status: item.status,
        })),
      } : null,
      live_implementation_summary: flowchartText(input.stream, input.stream),
    }, null, 2),
  ].join("\n");
}

function scheduleSubagentAdvisorUpdate(input: {
  taskId: string;
  sessionId: string;
  project: ProjectRecord;
  chunk?: string;
  force?: boolean;
}) {
  if (input.chunk) appendSubagentAdvisorStream(input.taskId, input.chunk);
  const state = subagentAdvisorForTask(input.taskId);
  const now = Date.now();
  if (!input.force && now - state.lastStartedMs < SUBAGENT_ADVISOR_UPDATE_THROTTLE_MS) return;
  if (state.running) {
    state.pending = true;
    return;
  }
  state.running = true;
  state.pending = false;
  state.lastStartedMs = now;
  void runSubagentAdvisorWatcherOnce(input)
    .catch((error) => {
      appendOrchestratorEvent({
        scope: "task",
        scope_id: input.taskId,
        type: "local_codex_subagent_advisor.failed",
        message: error instanceof Error ? error.message : String(error),
        data: { task_id: input.taskId },
      });
    })
    .finally(() => {
      state.running = false;
      if (state.pending) {
        state.pending = false;
        scheduleSubagentAdvisorUpdate({ ...input, force: true, chunk: "" });
      }
    });
}

async function runSubagentAdvisorWatcherOnce(input: {
  taskId: string;
  sessionId: string;
  project: ProjectRecord;
}) {
  const task = getTask(input.taskId);
  const session = getSession(input.sessionId);
  if (!task || !session) return;
  const state = subagentAdvisorForTask(input.taskId);
  const schemaPath = buildSubagentAdvisorWatcherSchemaFile(input.taskId);
  const finalMessagePath = path.join(config.runtimeDir, `${input.taskId}.subagent-advisor-live.final.json`);
  const prompt = buildSubagentAdvisorWatcherPrompt({
    task,
    session,
    stream: state.stream,
  });
  const args = [
    "exec",
    ...codexFastReadOnlyArgs(),
    "--json",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    finalMessagePath,
    "-C",
    input.project.workspace_path,
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-",
  ];
  appendOrchestratorEvent({
    scope: "task",
    scope_id: input.taskId,
    type: "local_codex_subagent_advisor.started",
    message: "Started local Codex subagent advisor update.",
    data: { task_id: input.taskId, session_id: input.sessionId },
  });
  const child = spawn(config.codexCommand, args, {
    cwd: input.project.workspace_path,
    env: {
      ...process.env,
      CODEX_HOME: config.codexHome,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, SUBAGENT_ADVISOR_WATCHER_TIMEOUT_MS);
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(prompt);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (timedOut) throw new Error("Codex subagent advisor timed out after 5 seconds.");
  if (exit.code !== 0) throw new Error(`Codex subagent advisor exited with code ${exit.code ?? "null"}${stderr ? `: ${preview(stderr, 500)}` : ""}`);
  const finalText = extractFinalAgentText(parseCodexJsonl(`${stdout}\n${stderr}`)) || safeRead(finalMessagePath);
  const parsed = parseSubagentAdvisorWatcherText(finalText);
  if (!parsed) throw new Error("Codex subagent advisor did not return valid JSON.");
  const latestTask = getTask(input.taskId);
  const latestSession = getSession(input.sessionId);
  if (!latestTask || !latestSession) return;
  const update: LocalCodexSubagentAdvisorUpdate = {
    ...parsed,
    updated_at: nowIso(),
    source: "parallel_codex_subagent_advisor",
  };
  latestTask.codex_subagent_advisor = update;
  latestTask.updated_at = update.updated_at;
  upsertTask(latestTask);
  writeHeadDeveloperSubagentAdvisorJson(input.project.workspace_path, update);
  const summary = subagentAdvisorSummaryText(update);
  appendFlowchartMakerStream(input.taskId, `SUBAGENT ADVISOR: ${summary}`);
  scheduleFlowchartSummaryUpdate({
    taskId: input.taskId,
    sessionId: input.sessionId,
    project: input.project,
    chunk: `SUBAGENT ADVISOR: ${summary}`,
    force: true,
  });
  const latestMessage = latestSession.latest_codex_message;
  appendSessionEvent(latestSession, "local_codex_subagent_advisor.updated", "codex", summary, {
    task_id: input.taskId,
    subagent_advisor: update,
  });
  latestSession.latest_codex_message = latestMessage;
  upsertSession(latestSession);
  appendOrchestratorEvent({
    scope: "task",
    scope_id: input.taskId,
    type: "local_codex_subagent_advisor.updated",
    message: summary,
    data: { task_id: input.taskId, subagent_advisor: update },
  });
}

function startFlowchartWatcher(input: {
  taskId: string;
  sessionId: string;
  project: ProjectRecord;
  beforeFiles: string[];
  commandEvent?: CommandEventRecord;
  prompt?: string;
  startedAt?: string;
}) {
  const state = flowchartMakerForTask(input.taskId);
  if (state.watcher) return;
  state.beforeFiles = input.beforeFiles;
  state.watcherStartedAt = nowIso();
  appendOrchestratorEvent({
    scope: "task",
    scope_id: input.taskId,
    type: "local_codex_flowchart.watcher.started",
    message: "Started continuous parallel Codex flowchart watcher.",
    data: {
      task_id: input.taskId,
      session_id: input.sessionId,
      interval_ms: FLOWCHART_WATCHER_INTERVAL_MS,
      max_codex_pass_ms: FLOWCHART_MAKER_TIMEOUT_MS,
    },
  });
  appendFlowchartMakerStream(input.taskId, "FLOWCHART WATCHER: continuous parallel watcher started.");
  scheduleFlowchartSummaryUpdate({
    taskId: input.taskId,
    sessionId: input.sessionId,
    project: input.project,
    chunk: "FLOWCHART WATCHER: started continuous live updates.",
    force: true,
  });
  state.watcher = setInterval(() => {
    const latestTask = getTask(input.taskId);
    if (!latestTask || isTerminalTaskStatus(latestTask.status)) {
      stopFlowchartWatcher(input.taskId, "task is no longer running");
      return;
    }
    if (input.commandEvent && input.prompt && input.startedAt) {
      syncLiveCodexRollout({
        taskId: input.taskId,
        sessionId: input.sessionId,
        project: input.project,
        commandEvent: input.commandEvent,
        prompt: input.prompt,
        startedAt: input.startedAt,
      });
    }
    const activity = workspaceActivitySummary(input.project.workspace_path, state.beforeFiles);
    if (activity.signature !== state.lastWorkspaceSignature) {
      state.lastWorkspaceSignature = activity.signature;
      state.latestWorkspaceActivity = activity.summary;
      appendFlowchartMakerStream(input.taskId, activity.summary);
    }
    appendOrchestratorEvent({
      scope: "task",
      scope_id: input.taskId,
      type: "local_codex_flowchart.watcher.tick",
      message: state.latestWorkspaceActivity || "Flowchart watcher ticked while local Codex was running.",
      data: {
        task_id: input.taskId,
        session_id: input.sessionId,
        interval_ms: FLOWCHART_WATCHER_INTERVAL_MS,
      },
    });
    scheduleFlowchartSummaryUpdate({
      taskId: input.taskId,
      sessionId: input.sessionId,
      project: input.project,
      chunk: state.latestWorkspaceActivity || "FLOWCHART WATCHER: local Codex is still running.",
      force: true,
    });
  }, FLOWCHART_WATCHER_INTERVAL_MS);
}

function stopFlowchartWatcher(taskId: string, reason: string) {
  const state = flowchartMakerState.get(taskId);
  if (!state?.watcher) return;
  clearInterval(state.watcher);
  state.watcher = null;
  appendOrchestratorEvent({
    scope: "task",
    scope_id: taskId,
    type: "local_codex_flowchart.watcher.stopped",
    message: `Stopped continuous parallel Codex flowchart watcher: ${reason}.`,
    data: { task_id: taskId, reason },
  });
}

function startSubagentAdvisorWatcher(input: {
  taskId: string;
  sessionId: string;
  project: ProjectRecord;
  beforeFiles: string[];
}) {
  const state = subagentAdvisorForTask(input.taskId);
  if (state.watcher) return;
  state.watcherStartedAt = nowIso();
  appendOrchestratorEvent({
    scope: "task",
    scope_id: input.taskId,
    type: "local_codex_subagent_advisor.watcher.started",
    message: "Started continuous parallel Codex subagent advisor.",
    data: {
      task_id: input.taskId,
      session_id: input.sessionId,
      interval_ms: SUBAGENT_ADVISOR_WATCHER_INTERVAL_MS,
      max_codex_pass_ms: SUBAGENT_ADVISOR_WATCHER_TIMEOUT_MS,
    },
  });
  appendSubagentAdvisorStream(input.taskId, "SUBAGENT ADVISOR WATCHER: continuous parallel watcher started.");
  scheduleSubagentAdvisorUpdate({
    taskId: input.taskId,
    sessionId: input.sessionId,
    project: input.project,
    chunk: "SUBAGENT ADVISOR WATCHER: started continuous live subagent-opportunity checks.",
    force: true,
  });
  state.watcher = setInterval(() => {
    const latestTask = getTask(input.taskId);
    if (!latestTask || isTerminalTaskStatus(latestTask.status)) {
      stopSubagentAdvisorWatcher(input.taskId, "task is no longer running");
      return;
    }
    const activity = workspaceActivitySummary(input.project.workspace_path, input.beforeFiles);
    if (activity.summary !== state.latestWorkspaceActivity) {
      state.latestWorkspaceActivity = activity.summary;
      appendSubagentAdvisorStream(input.taskId, activity.summary);
    }
    appendOrchestratorEvent({
      scope: "task",
      scope_id: input.taskId,
      type: "local_codex_subagent_advisor.watcher.tick",
      message: state.latestWorkspaceActivity || "Subagent advisor ticked while local Codex was running.",
      data: {
        task_id: input.taskId,
        session_id: input.sessionId,
        interval_ms: SUBAGENT_ADVISOR_WATCHER_INTERVAL_MS,
      },
    });
    scheduleSubagentAdvisorUpdate({
      taskId: input.taskId,
      sessionId: input.sessionId,
      project: input.project,
      chunk: state.latestWorkspaceActivity || "SUBAGENT ADVISOR WATCHER: local Codex is still running.",
      force: true,
    });
  }, SUBAGENT_ADVISOR_WATCHER_INTERVAL_MS);
}

function stopSubagentAdvisorWatcher(taskId: string, reason: string) {
  const state = subagentAdvisorWatcherState.get(taskId);
  if (!state?.watcher) return;
  clearInterval(state.watcher);
  state.watcher = null;
  appendOrchestratorEvent({
    scope: "task",
    scope_id: taskId,
    type: "local_codex_subagent_advisor.watcher.stopped",
    message: `Stopped continuous parallel Codex subagent advisor: ${reason}.`,
    data: { task_id: taskId, reason },
  });
}

function scheduleFlowchartSummaryUpdate(input: {
  taskId: string;
  sessionId: string;
  project: ProjectRecord;
  chunk?: string;
  force?: boolean;
  report?: LocalCodexReport | null;
  validation?: LocalCodexValidationResult | null;
  previewLoaded?: boolean | null;
}) {
  if (input.chunk) appendFlowchartMakerStream(input.taskId, input.chunk);
  const state = flowchartMakerForTask(input.taskId);
  const now = Date.now();
  if (!input.force && now - state.lastStartedMs < FLOWCHART_UPDATE_THROTTLE_MS) return;
  if (state.running) {
    state.pending = true;
    return;
  }
  state.running = true;
  state.pending = false;
  state.lastStartedMs = now;
  void runFlowchartMakerOnce(input)
    .catch((error) => {
      appendOrchestratorEvent({
        scope: "task",
        scope_id: input.taskId,
        type: "local_codex_flowchart.failed",
        message: error instanceof Error ? error.message : String(error),
        data: { task_id: input.taskId },
      });
    })
    .finally(() => {
      state.running = false;
      if (state.pending) {
        state.pending = false;
        scheduleFlowchartSummaryUpdate({ ...input, force: true, chunk: "" });
      }
    });
}

async function runFlowchartMakerOnce(input: {
  taskId: string;
  sessionId: string;
  project: ProjectRecord;
  report?: LocalCodexReport | null;
  validation?: LocalCodexValidationResult | null;
  previewLoaded?: boolean | null;
}) {
  const task = getTask(input.taskId);
  const session = getSession(input.sessionId);
  if (!task || !session) return;
  const state = flowchartMakerForTask(input.taskId);
  const schemaPath = buildFlowchartMakerSchemaFile(input.taskId);
  const finalMessagePath = path.join(config.runtimeDir, `${input.taskId}.flowchart-summary.final.json`);
  const prompt = buildFlowchartMakerPrompt({
    task,
    session,
    stream: state.stream,
    report: input.report,
    validation: input.validation,
    previewLoaded: input.previewLoaded,
  });
  const args = [
    "exec",
    ...codexFastReadOnlyArgs(),
    "--json",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    finalMessagePath,
    "-C",
    input.project.workspace_path,
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-",
  ];
  appendOrchestratorEvent({
    scope: "task",
    scope_id: input.taskId,
    type: "local_codex_flowchart.started",
    message: "Started local Codex flowchart summary update.",
    data: { task_id: input.taskId, session_id: input.sessionId },
  });
  const child = spawn(config.codexCommand, args, {
    cwd: input.project.workspace_path,
    env: {
      ...process.env,
      CODEX_HOME: config.codexHome,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, FLOWCHART_MAKER_TIMEOUT_MS);
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(prompt);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (timedOut) throw new Error("Codex flowchart summary timed out after 5 seconds.");
  if (exit.code !== 0) throw new Error(`Codex flowchart summary exited with code ${exit.code ?? "null"}${stderr ? `: ${preview(stderr, 500)}` : ""}`);
  const finalText = extractFinalAgentText(parseCodexJsonl(`${stdout}\n${stderr}`)) || safeRead(finalMessagePath);
  const summary = parseFlowchartMakerText(finalText);
  if (!summary) throw new Error("Codex flowchart summary did not return valid JSON.");
  const latestTask = getTask(input.taskId);
  const latestSession = getSession(input.sessionId);
  if (!latestTask || !latestSession) return;
  const normalizedSummary = ensureSystemProcessNodes(summary);
  const flowchartJsonPath = writeHeadDeveloperFlowchartJson(input.project.workspace_path, normalizedSummary);
  latestTask.codex_flowchart_summary = normalizedSummary;
  latestTask.codex_flowchart_json_path = flowchartJsonPath;
  latestTask.updated_at = nowIso();
  upsertTask(latestTask);
  const latestMessage = latestSession.latest_codex_message;
  appendSessionEvent(latestSession, "local_codex_flowchart.updated", "codex", normalizedSummary.overview || "Flowchart summary updated.", {
    task_id: input.taskId,
    flowchart_summary: normalizedSummary,
  });
  latestSession.latest_codex_message = latestMessage;
  upsertSession(latestSession);
  appendOrchestratorEvent({
    scope: "task",
    scope_id: input.taskId,
    type: "local_codex_flowchart.updated",
    message: normalizedSummary.overview || "Flowchart summary updated.",
    data: { task_id: input.taskId, flowchart_summary: normalizedSummary },
  });
}

function appendStreamSessionEvent(input: {
  session: SessionState;
  type: "local_codex_session.stdout" | "local_codex_session.stderr";
  message: string;
  taskId: string;
  commandEventId: string;
  stream: "stdout" | "stderr";
}) {
  if (!input.message) return;
  const latestMessage = input.session.latest_codex_message;
  appendSessionEvent(input.session, input.type, input.stream === "stdout" ? "codex" : "system", preview(input.message, 8000), {
    task_id: input.taskId,
    command_event_id: input.commandEventId,
    stream: input.stream,
    chunk_chars: input.message.length,
    piped_from: "codex_cli",
  });
  input.session.latest_codex_message = latestMessage;
  upsertSession(input.session);
}

function appendSessionEvent(session: SessionState, type: string, source: SupervisorEvent["source"], message: string, data?: unknown) {
  const event: SupervisorEvent = {
    id: randomUUID(),
    session_id: session.session_id,
    ts: nowIso(),
    source,
    type,
    message,
    data,
  };
  session.raw_events.push(event);
  session.latest_codex_message = message || session.latest_codex_message;
  session.last_updated = event.ts;
  appendAuditEvent({
    session_id: event.session_id,
    ts: event.ts,
    source: event.source,
    type: event.type,
    message: event.message,
    data: event.data,
  });
  return event;
}

function createTask(project: ProjectRecord, userGoal: string, prompt: string): TaskRecord {
  const now = nowIso();
  return {
    task_id: `task_${randomUUID()}`,
    project_id: project.project_id,
    user_goal: userGoal,
    normalized_goal: userGoal.toLowerCase().replace(/\s+/g, " ").trim(),
    status: "running",
    plan: [
      "Clarify requirements through conversation when needed.",
      "Run one local Codex CLI implementation session.",
      "Let Codex choose useful internal logical subagents.",
      "Validate files and commands locally.",
      "Open or prepare a local preview when applicable.",
      "Record final summary from file and command evidence.",
    ],
    worker_id: null,
    codex_run_id: null,
    command_count: 0,
    latest_summary: "Built by one local Codex orchestrator session.",
    next_steps: ["Wait for the local Codex CLI orchestrator session to finish.", "Run local validation."],
    execution_backend: LOCAL_CODEX_BACKEND,
    codex_prompt_excerpt: prompt.replace(/\s+/g, " ").trim().slice(0, 500),
    codex_started_at: now,
    codex_subagents: [],
    codex_flowchart_summary: null,
    codex_flowchart_json_path: null,
    files_changed: [],
    local_validation_result: null,
    final_summary: null,
    created_at: now,
    updated_at: now,
  };
}

async function runValidationCommands(input: {
  task: TaskRecord;
  project: ProjectRecord;
  files: string[];
  reportCommands: string[];
}) {
  const commands = defaultValidationCommands(input.project.workspace_path, input.files, input.reportCommands).slice(0, 20);
  const runner = new CommandRunner();
  const results: LocalCodexValidationCommandResult[] = [];
  for (const command of commands) {
    const [bin, ...args] = shellWords(command);
    if (!bin) continue;
    const event = await runner.run({
      task_id: input.task.task_id,
      project_id: input.project.project_id,
      worker_id: LOCAL_CODEX_WORKER_ID,
      worker_mode: LOCAL_CODEX_BACKEND,
      command: bin,
      args,
      cwd: input.project.workspace_path,
      workspace_path: input.project.workspace_path,
      timeout_ms: 120_000,
    });
    results.push({
      command,
      status: event.exit_code === 0 ? "passed" : "failed",
      exit_code: event.exit_code,
      summary: event.stderr_preview || event.stdout_preview || event.summary,
    });
  }
  return results;
}

export function validateLocalCodexResult(input: {
  workspacePath: string;
  requiredFiles: string[];
  changedFiles: string[];
  commandResults?: LocalCodexValidationCommandResult[];
  previewLoaded?: boolean | null;
  docsUpdated?: boolean;
  codexStatus?: LocalCodexReport["status"];
  errors?: string[];
}): LocalCodexValidationResult {
  const changedFiles = unique(input.changedFiles);
  const appFiles = changedFiles.filter(isAppFile);
  const documentationFiles = changedFiles.filter(isDocFile);
  const requiredFiles = unique(input.requiredFiles);
  const presentRequired = existingFiles(input.workspacePath, requiredFiles);
  const commands = input.commandResults ?? [];
  const failures = [
    ...(input.codexStatus === "failed" ? ["Codex reported failed status."] : []),
    ...(input.errors ?? []),
  ];
  const warnings: string[] = [];
  const requiredFilesExist = requiredFiles.length ? presentRequired.length === requiredFiles.length : appFiles.length > 0;
  const docsPath = path.join(input.workspacePath, ".head-developer");
  const docsUpdated = Boolean(input.docsUpdated || fs.existsSync(path.join(docsPath, "state.json")));
  const docsOnlyRejected = changedFiles.length > 0 && appFiles.length === 0 && documentationFiles.length > 0;
  if (!requiredFilesExist) {
    const missing = requiredFiles.filter((file) => !presentRequired.includes(file));
    failures.push(missing.length ? `Missing required file(s): ${missing.join(", ")}.` : "No required app/source files were found.");
  }
  if (!docsUpdated) failures.push(".head-developer docs/state were not updated.");
  if (docsOnlyRejected) failures.push("Docs-only success is rejected for v1 app builds.");
  for (const command of commands) {
    if (command.status === "failed") failures.push(`Validation command failed: ${command.command}.`);
  }
  if (!commands.length) warnings.push("No executable validation command was run.");
  const status = failures.length ? "failed" : "passed";
  return {
    status,
    validated_at: nowIso(),
    required_files_exist: requiredFilesExist,
    docs_updated: docsUpdated,
    docs_only_success_rejected: docsOnlyRejected,
    preview_loaded: input.previewLoaded ?? null,
    files_changed: changedFiles,
    app_files: appFiles,
    documentation_files: documentationFiles,
    commands,
    failures: unique(failures),
    warnings,
    summary: status === "passed"
      ? `Local Codex validation passed with ${appFiles.length} app/source file(s), ${documentationFiles.length} documentation file(s), and ${commands.filter((command) => command.status === "passed").length} passed command(s).`
      : `Local Codex validation failed: ${unique(failures).join(" ")}`,
  };
}

async function runCodexCli(input: {
  task: TaskRecord;
  project: ProjectRecord;
  session: SessionState;
  prompt: string;
  beforeFiles: string[];
}) {
  const schemaPath = buildSchemaFile(input.task.task_id);
  const finalMessagePath = path.join(config.runtimeDir, `${input.task.task_id}.local-codex.final.json`);
  const commandEventId = randomUUID();
  const startedAt = nowIso();
  const args = [
    "exec",
    ...codexSharedArgs(),
    "--json",
    "--color",
    "never",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    finalMessagePath,
    "-C",
    input.project.workspace_path,
    "--skip-git-repo-check",
    ...codexImplementationAccessArgs(),
    "-",
  ];
  const commandDisplay = codexCommandDisplay([...args.slice(0, -1), "[local orchestrator prompt via stdin]"]);
  const commandEvent: CommandEventRecord = {
    event_id: commandEventId,
    task_id: input.task.task_id,
    project_id: input.project.project_id,
    worker_id: LOCAL_CODEX_WORKER_ID,
    worker_mode: LOCAL_CODEX_BACKEND,
    codex_home: config.codexHome,
    codex_home_host_path: config.codexHome,
    codex_history_kind: "exec",
    codex_prompt_excerpt: input.prompt.replace(/\s+/g, " ").trim().slice(0, 500),
    codex_model: config.localCodex.model || null,
    codex_reasoning_effort: config.localCodex.reasoningEffort || null,
    codex_started_at: startedAt,
    command: commandDisplay,
    cwd: input.project.workspace_path,
    started_at: startedAt,
    ended_at: null,
    exit_code: null,
    stdout_ref: null,
    stderr_ref: null,
    stdout_preview: "",
    stderr_preview: "",
    summary: "Local Codex CLI session is running.",
    risk_level: "low",
    approved_by_user: false,
    created_at: startedAt,
  };
  upsertCommandEvent(commandEvent);
  appendOrchestratorEvent({
    scope: "command",
    scope_id: commandEvent.event_id,
    type: "local_codex_session.started",
    message: "Started one local Codex CLI session.",
    data: commandEvent,
  });
  appendSessionEvent(input.session, "local_codex_session.started", "system", "Started one local Codex CLI session.", {
    task_id: input.task.task_id,
    command_event_id: commandEvent.event_id,
    backend: LOCAL_CODEX_BACKEND,
    command: commandEvent.command,
    cwd: input.project.workspace_path,
    codex_model: config.localCodex.model || null,
    codex_reasoning_effort: config.localCodex.reasoningEffort || null,
    codex_home: config.codexHome,
    full_access: config.localCodex.bypassApprovalsAndSandbox || config.localCodex.sandbox === "danger-full-access",
    plugins_source: "same CODEX_HOME and user Codex config",
  });
  upsertSession(input.session);
  scheduleFlowchartSummaryUpdate({
    taskId: input.task.task_id,
    sessionId: input.session.session_id,
    project: input.project,
    chunk: "Codex CLI session started. Waiting for Codex to choose and name useful subagents.",
    force: true,
  });
  scheduleSubagentAdvisorUpdate({
    taskId: input.task.task_id,
    sessionId: input.session.session_id,
    project: input.project,
    chunk: "Codex CLI session started. Subagent advisor is watching for useful responsibility lanes.",
    force: true,
  });
  startSubagentAdvisorWatcher({
    taskId: input.task.task_id,
    sessionId: input.session.session_id,
    project: input.project,
    beforeFiles: input.beforeFiles,
  });
  startFlowchartWatcher({
    taskId: input.task.task_id,
    sessionId: input.session.session_id,
    project: input.project,
    beforeFiles: input.beforeFiles,
    commandEvent,
    prompt: input.prompt,
    startedAt,
  });

  const child = spawn(config.codexCommand, args, {
    cwd: input.project.workspace_path,
    env: {
      ...process.env,
      CODEX_HOME: config.codexHome,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(input.prompt);
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    scheduleFlowchartSummaryUpdate({
      taskId: input.task.task_id,
      sessionId: input.session.session_id,
      project: input.project,
      chunk: text,
    });
    scheduleSubagentAdvisorUpdate({
      taskId: input.task.task_id,
      sessionId: input.session.session_id,
      project: input.project,
      chunk: text,
    });
    appendStreamSessionEvent({
      session: input.session,
      type: "local_codex_session.stdout",
      message: text,
      taskId: input.task.task_id,
      commandEventId: commandEvent.event_id,
      stream: "stdout",
    });
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    scheduleFlowchartSummaryUpdate({
      taskId: input.task.task_id,
      sessionId: input.session.session_id,
      project: input.project,
      chunk: text,
    });
    scheduleSubagentAdvisorUpdate({
      taskId: input.task.task_id,
      sessionId: input.session.session_id,
      project: input.project,
      chunk: text,
    });
    appendStreamSessionEvent({
      session: input.session,
      type: "local_codex_session.stderr",
      message: text,
      taskId: input.task.task_id,
      commandEventId: commandEvent.event_id,
      stream: "stderr",
    });
  });
  let exit!: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    stopFlowchartWatcher(input.task.task_id, "local Codex CLI process exited");
    stopSubagentAdvisorWatcher(input.task.task_id, "local Codex CLI process exited");
  }
  syncLiveCodexRollout({
    taskId: input.task.task_id,
    sessionId: input.session.session_id,
    project: input.project,
    commandEvent,
    prompt: input.prompt,
    startedAt,
  });
  const completedAt = nowIso();
  commandEvent.ended_at = completedAt;
  commandEvent.exit_code = exit.code;
  commandEvent.stdout_ref = writeCommandLog(commandEvent.event_id, "stdout", stdout);
  commandEvent.stderr_ref = writeCommandLog(commandEvent.event_id, "stderr", stderr);
  commandEvent.stdout_preview = preview(stdout);
  commandEvent.stderr_preview = preview(stderr);
  commandEvent.summary = exit.code === 0 ? "Local Codex CLI session completed." : `Local Codex CLI session exited with code ${exit.code ?? "null"}${exit.signal ? ` and signal ${exit.signal}` : ""}.`;
  commandEvent.codex_completed_at = completedAt;
  Object.assign(commandEvent, detectCodexHistory({
    commandEvent,
    codexHome: config.codexHome,
    hostCodexHomePath: config.codexHome,
    prompt: input.prompt,
    commandStartedAt: startedAt,
    commandCompletedAt: completedAt,
  }));
  upsertCommandEvent(commandEvent);
  appendSessionEvent(input.session, exit.code === 0 ? "local_codex_session.completed" : "local_codex_session.failed", exit.code === 0 ? "codex" : "system", commandEvent.summary, {
    task_id: input.task.task_id,
    command_event_id: commandEvent.event_id,
    backend: LOCAL_CODEX_BACKEND,
    exit_code: exit.code,
    signal: exit.signal,
  });
  upsertSession(input.session);
  appendOrchestratorEvent({
    scope: "command",
    scope_id: commandEvent.event_id,
    type: exit.code === 0 ? "local_codex_session.completed" : "local_codex_session.failed",
    message: commandEvent.summary,
    data: commandEvent,
  });
  return { commandEvent, stdout, stderr, finalMessage: safeRead(finalMessagePath), events: parseCodexJsonl(`${stdout}\n${stderr}`) };
}

async function completeLocalCodexRun(input: {
  sessionId: string;
  taskId: string;
  project: ProjectRecord;
  beforeFiles: string[];
  prompt: string;
}) {
  const task = getTask(input.taskId);
  const session = getSession(input.sessionId);
  if (!task || !session) return;
  try {
    const codex = await runCodexCli({ task, project: input.project, session, prompt: input.prompt, beforeFiles: input.beforeFiles });
    const finalText = extractFinalAgentText(codex.events) || codex.finalMessage;
    const report = parseLocalCodexReport(finalText);
    const afterFiles = listProjectFiles(input.project.workspace_path);
    const discoveredChanged = unique([...changedFilesFromBeforeAfter(input.beforeFiles, afterFiles), ...report.files_changed]).filter((file) => !isInternalStateArtifact(file));
    const requiredFiles = unique([...report.required_files, ...report.subagents.flatMap((agent) => agent.changed_files).filter((file) => isAppFile(file))]);
    const validationCommands = await runValidationCommands({
      task,
      project: input.project,
      files: unique([...discoveredChanged, ...requiredFiles]),
      reportCommands: report.validation_commands,
    });
    let previewLoaded: boolean | null = null;
    const prelimValidation = validateLocalCodexResult({
      workspacePath: input.project.workspace_path,
      requiredFiles,
      changedFiles: discoveredChanged,
      commandResults: validationCommands,
      previewLoaded,
      docsUpdated: report.docs_updated,
      codexStatus: codex.commandEvent.exit_code === 0 ? report.status : "failed",
      errors: report.errors,
    });
    if (prelimValidation.status === "passed") {
      const previewResult = await startPreviewForSession(input.sessionId, { taskId: task.task_id, allowIncompleteTask: true });
      previewLoaded = previewResult.ok ? previewResult.preview.status !== "failed" : null;
    }
    const validation = validateLocalCodexResult({
      workspacePath: input.project.workspace_path,
      requiredFiles,
      changedFiles: discoveredChanged,
      commandResults: validationCommands,
      previewLoaded,
      docsUpdated: report.docs_updated,
      codexStatus: codex.commandEvent.exit_code === 0 ? report.status : "failed",
      errors: report.errors,
    });
    const liveTask = getTask(task.task_id);
    const finalSubagents = report.subagents.length ? report.subagents : (liveTask?.codex_subagents ?? []);
    const reportForSummary = finalSubagents === report.subagents ? report : { ...report, subagents: finalSubagents };
    const taskForSummary = finalSubagents === task.codex_subagents ? task : { ...task, codex_subagents: finalSubagents };
    const flowchartSummary = report.flowchart_summary
      ?? liveTask?.codex_flowchart_summary
      ?? fallbackFlowchartSummary({ task: taskForSummary, session, report: reportForSummary, validation, previewLoaded });
    const normalizedFlowchartSummary = ensureSystemProcessNodes(flowchartSummary);
    const flowchartJsonPath = writeHeadDeveloperFlowchartJson(input.project.workspace_path, normalizedFlowchartSummary);
    const completedAt = nowIso();
    task.status = validation.status === "passed" && report.status === "completed" ? "completed" : "failed";
    task.command_count = listCommandEvents({ taskId: task.task_id }).length;
    task.latest_summary = validation.status === "passed" ? report.summary : validation.summary;
    task.next_steps = task.status === "completed" ? ["Review the local preview and final summary."] : ["Repair validation failures and rerun local validation."];
    task.codex_session_id = codex.commandEvent.codex_session_id ?? null;
    task.codex_rollout_path = codex.commandEvent.codex_rollout_path ?? null;
    task.codex_rollout_host_path = codex.commandEvent.codex_rollout_host_path ?? null;
    task.codex_rollout_relative_path = codex.commandEvent.codex_rollout_relative_path ?? null;
    task.codex_home = config.codexHome;
    task.codex_home_host_path = config.codexHome;
    task.codex_history_kind = "exec";
    task.codex_resume_command = codex.commandEvent.codex_resume_command ?? null;
    task.codex_model = codex.commandEvent.codex_model ?? null;
    task.codex_completed_at = completedAt;
    task.codex_history_confidence = codex.commandEvent.codex_history_confidence ?? null;
    task.codex_history_verification_command = codex.commandEvent.codex_history_verification_command ?? null;
    task.codex_subagents = finalSubagents;
    task.codex_flowchart_summary = normalizedFlowchartSummary;
    task.codex_flowchart_json_path = flowchartJsonPath;
    task.local_validation_result = validation;
    task.files_changed = discoveredChanged;
    task.final_summary = [
      report.final_summary || report.summary,
      finalSubagents.length ? `Subagent breakdown: ${finalSubagents.map((agent) => `${agent.name}: ${agent.summary || agent.responsibility}`).join(" | ")}` : "Subagent breakdown: Codex did not report separate logical subagents.",
      `Validation: ${validation.summary}`,
    ].join(" ");
    task.updated_at = completedAt;
    task.local_state_path = writeHeadDeveloperState(input.project.workspace_path, {
      backend: LOCAL_CODEX_BACKEND,
      task_id: task.task_id,
      project_id: input.project.project_id,
      status: task.status,
      codex_session_id: task.codex_session_id ?? null,
      codex_rollout_path: task.codex_rollout_host_path ?? task.codex_rollout_path ?? null,
      codex_resume_command: task.codex_resume_command ?? null,
      prompt_excerpt: task.codex_prompt_excerpt ?? "",
      started_at: task.codex_started_at,
      completed_at: completedAt,
      files_changed: task.files_changed,
      validation_result: validation,
      subagents: task.codex_subagents,
      flowchart_summary: task.codex_flowchart_summary,
      flowchart_json_path: task.codex_flowchart_json_path,
      final_summary: task.final_summary,
    });
    upsertTask(task);
    scheduleFlowchartSummaryUpdate({
      taskId: task.task_id,
      sessionId: session.session_id,
      project: input.project,
      chunk: `${report.summary}\n${task.final_summary}`,
      force: true,
      report: reportForSummary,
      validation,
      previewLoaded,
    });

    const validationDoc = [
      "# Validation",
      "",
      `Status: ${validation.status}`,
      "",
      ...validation.commands.map((command) => `- ${command.command}: ${command.status}${command.exit_code === null ? "" : ` (exit ${command.exit_code})`}`),
      validation.failures.length ? "" : "",
      validation.failures.length ? `Failures: ${validation.failures.join(" ")}` : "",
    ].filter(Boolean).join("\n");
    fs.writeFileSync(path.join(input.project.workspace_path, ".head-developer", "VALIDATION.md"), `${validationDoc}\n`);

    let githubPush: GitHubProjectPushResult | null = null;
    if (task.status === "completed") {
      githubPush = pushProjectToGitHub({
        project: input.project,
        taskId: task.task_id,
      });
      appendOrchestratorEvent({
        scope: "project",
        scope_id: input.project.project_id,
        type: githubPush.status === "pushed"
          ? "github.push.completed"
          : githubPush.status === "failed"
            ? "github.push.failed"
            : "github.push.skipped",
        message: githubPush.reason,
        data: { project_id: input.project.project_id, task_id: task.task_id, github_push: githubPush },
      });
      if (githubPush.status === "pushed" || githubPush.status === "no_changes") {
        input.project.latest_commit_hash = githubPush.commit ?? input.project.latest_commit_hash ?? null;
        input.project.github_last_push_at = nowIso();
        input.project.github_last_push_error = null;
      } else if (githubPush.status === "failed") {
        input.project.github_last_push_error = githubPush.error;
      }
    }

    const summary = generateRunSummary(task.task_id);
    upsertRunSummary({
      ...summary,
      executive_summary: task.status === "completed" ? `Task completed: ${task.user_goal}` : `Task failed validation: ${task.user_goal}`,
      technical_summary: `${summary.technical_summary} Built by one local Codex orchestrator session. ${task.final_summary}`,
      files_changed: task.files_changed ?? summary.files_changed,
      tests_run: unique([...summary.tests_run, ...validation.commands.map((command) => command.command)]),
      failures: validation.failures,
      current_state: task.status,
      confidence: validation.status === "passed" ? "high" : "medium",
      created_at: nowIso(),
    });

    session.current_status = task.status;
    session.status = task.status;
    session.active_task_id = task.task_id;
    session.active_worker_id = null;
    session.current_project_id = input.project.project_id;
    session.project_id = input.project.project_id;
    session.workspace_path = input.project.workspace_path;
    session.files_modified = unique([...(session.files_modified ?? []), ...(task.files_changed ?? [])]);
    session.commands_completed = unique([...session.commands_completed, ...validation.commands.filter((command) => command.status === "passed").map((command) => command.command)]);
    session.commands_failed = unique([...session.commands_failed, ...validation.commands.filter((command) => command.status === "failed").map((command) => command.command)]);
    session.summary_text = task.final_summary ?? task.latest_summary;
    session.latest_summary = session.summary_text;
    const githubPushText = githubPush?.status === "pushed" && input.project.github_repo_url
      ? ` GitHub: pushed to ${input.project.github_repo_url}.`
      : githubPush?.status === "failed"
        ? ` GitHub push failed: ${githubPush.error}`
        : "";
    session.latest_codex_message = task.status === "completed" ? `Built by one local Codex orchestrator session. ${task.final_summary}${githubPushText}` : validation.summary;
    session.last_updated = nowIso();
    appendSessionEvent(session, "local_codex_session.finished", task.status === "completed" ? "codex" : "system", session.latest_codex_message, {
      task,
      validation,
      subagents: task.codex_subagents,
      github_push: githubPush,
    });
    upsertSession(session);

    upsertProject({
      ...input.project,
      last_active_session_id: session.session_id,
      requirement_summary: session.requirement_summary ?? input.project.requirement_summary,
      approved_plan: session.approved_plan ?? input.project.approved_plan,
      approval_status: session.approval_status ?? input.project.approval_status,
      latest_commit_hash: input.project.latest_commit_hash,
      github_last_push_at: input.project.github_last_push_at ?? null,
      github_last_push_error: input.project.github_last_push_error ?? null,
      updated_at: nowIso(),
    });

    appendOrchestratorEvent({
      scope: "task",
      scope_id: task.task_id,
      type: task.status === "completed" ? "local_codex_session.validated" : "local_codex_session.validation_failed",
      message: task.final_summary ?? validation.summary,
      data: { task, validation, subagents: task.codex_subagents },
    });
  } catch (error) {
    const failedTask = getTask(input.taskId);
    const failedSession = getSession(input.sessionId);
    const message = error instanceof Error ? error.message : String(error);
    if (failedTask) {
      failedTask.status = "failed";
      failedTask.latest_summary = message;
      failedTask.updated_at = nowIso();
      upsertTask(failedTask);
    }
    if (failedSession) {
      failedSession.current_status = "failed";
      failedSession.status = "failed";
      failedSession.errors.push(message);
      failedSession.latest_codex_message = message;
      failedSession.last_updated = nowIso();
      upsertSession(failedSession);
    }
    appendOrchestratorEvent({
      scope: "task",
      scope_id: input.taskId,
      type: "local_codex_session.failed",
      message,
      data: { task_id: input.taskId, project_id: input.project.project_id },
    });
  }
}

export function startLocalCodexSession(input: {
  session: SessionState;
  project: ProjectRecord;
  userGoal: string;
  plannerDecision?: PlannerDecision | null;
  approvedPlan?: ApprovedPlanRecord | null;
}) {
  const conversationTranscript = browserConversationTranscript(input.session);
  const prompt = buildLocalCodexImplementationPrompt({
    userGoal: input.userGoal,
    project: input.project,
    requirementSummary: input.approvedPlan?.requirements_summary ?? input.plannerDecision?.requirements_summary ?? input.session.requirement_summary,
    approvedPlan: input.approvedPlan,
    plannerDecision: input.plannerDecision,
    conversationTranscript,
  });
  const task = createTask(input.project, input.userGoal, prompt);
  const beforeFiles = listProjectFiles(input.project.workspace_path);
  task.local_state_path = initializeHeadDeveloperDocs({
    project: input.project,
    task,
    userGoal: input.userGoal,
    requirementSummary: input.approvedPlan?.requirements_summary ?? input.plannerDecision?.requirements_summary ?? input.session.requirement_summary,
    approvedPlan: input.approvedPlan,
    conversationTranscript,
  });
  upsertTask(task);

  input.session.active_task_id = task.task_id;
  input.session.active_worker_id = null;
  input.session.current_project_id = input.project.project_id;
  input.session.project_id = input.project.project_id;
  input.session.workspace_path = input.project.workspace_path;
  input.session.current_status = "running";
  input.session.status = "running";
  input.session.latest_plan = task.plan;
  input.session.latest_summary = task.latest_summary;
  input.session.latest_codex_message = "Codex is the local CLI orchestrator. Local Codex session is starting.";
  input.session.instruction_history.push({ ts: nowIso(), text: input.userGoal, source: "start" });
  input.session.last_updated = nowIso();
  upsertSession(input.session);

  appendOrchestratorEvent({
    scope: "task",
    scope_id: task.task_id,
    type: "local_codex_session.queued",
    message: "Queued one local Codex CLI session.",
    data: {
      task,
      session_id: input.session.session_id,
      project_id: input.project.project_id,
      backend: LOCAL_CODEX_BACKEND,
      built_by: "one local Codex orchestrator session",
    },
  });

  void completeLocalCodexRun({
    sessionId: input.session.session_id,
    taskId: task.task_id,
    project: input.project,
    beforeFiles,
    prompt,
  });

  return { task, prompt };
}
