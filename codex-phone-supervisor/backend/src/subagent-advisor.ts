import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { config } from "./config.js";
import { extractFinalAgentText, parseCodexJsonl } from "./parser.js";
import { appendOrchestratorEvent } from "./store.js";
import type { CodexSubagentAdvice, PlannerDecision, ProjectRecord, SessionState } from "./types.js";

export const SUBAGENT_ADVISOR_TIMEOUT_MS = 5_000;

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function textArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean).slice(0, 8) : [];
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function safeRead(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function hasUserDeclinedSubagents(userGoal: string) {
  return /\b(no subagents|without subagents|do not use subagents|don't use subagents|single lane|single-lane|one lane only)\b/i.test(userGoal);
}

function plannerResponsibilities(decision: PlannerDecision) {
  return decision.proposed_task_split
    .map((item) => item.title.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function shouldRunSubagentAdvisor(userGoal: string, decision: PlannerDecision) {
  if (decision.recommended_worker_mode !== "codex_session_local") return false;
  if (hasUserDeclinedSubagents(userGoal)) return true;
  // Ask Codex instead of classifying user wording with a hand-written parser.
  return true;
}

export function plannerContextSubagentAdvice(input: {
  userGoal: string;
  decision: PlannerDecision;
  source?: CodexSubagentAdvice["source"];
  error?: string | null;
}): CodexSubagentAdvice {
  const responsibilities = plannerResponsibilities(input.decision);
  if (hasUserDeclinedSubagents(input.userGoal)) {
    return {
      recommended: false,
      confidence: 0.82,
      reason: "The user asked to avoid internal subagents, so Codex should keep the implementation single-lane unless it needs approval to change that.",
      user_check_in: "You asked to avoid internal subagents. Approval means Codex will run single-lane unless it stops and asks before changing that.",
      suggested_responsibilities: [],
      source: input.source ?? "planner_context",
      error: input.error ?? null,
    };
  }
  const recommended = responsibilities.length >= 2;
  return {
    recommended,
    confidence: recommended ? 0.74 : 0.55,
    reason: recommended
      ? "The Codex planner produced multiple responsibility areas, so internal Codex subagents look useful while keeping one repo and one CLI session."
      : "The Codex planner produced a narrow responsibility split, so a direct implementation lane looks sufficient.",
    user_check_in: recommended
      ? "Approval means Codex may choose the internal subagent count and names, use multiple named internal subagents when useful, and show those names in the flowchart; tell me before approving if you want a single-lane run."
      : "The plan looks narrow enough for a direct Codex lane. Approval keeps Codex free to ask before changing to a materially different subagent strategy.",
    suggested_responsibilities: responsibilities,
    source: input.source ?? "planner_context",
    error: input.error ?? null,
  };
}

function parseAdvice(value: string, fallback: CodexSubagentAdvice): CodexSubagentAdvice {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      recommended: Boolean(parsed.recommended),
      confidence: boundedNumber(parsed.confidence, fallback.confidence, 0, 1),
      reason: text(parsed.reason, fallback.reason),
      user_check_in: text(parsed.user_check_in, fallback.user_check_in),
      suggested_responsibilities: textArray(parsed.suggested_responsibilities),
      source: "codex_cli",
      error: null,
    };
  } catch {
    return fallback;
  }
}

function buildSchemaFile(sessionId: string) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const schemaPath = path.join(config.runtimeDir, `${sessionId}.subagent-advisor.schema.json`);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["recommended", "confidence", "reason", "user_check_in", "suggested_responsibilities"],
    properties: {
      recommended: { type: "boolean" },
      confidence: { type: "number" },
      reason: { type: "string" },
      user_check_in: { type: "string" },
      suggested_responsibilities: { type: "array", items: { type: "string" } },
    },
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  return schemaPath;
}

function codexAdvisorArgs() {
  const args: string[] = [];
  if (config.localCodex.planningModel) args.push("--model", config.localCodex.planningModel);
  if (config.localCodex.planningProfile) args.push("--profile", config.localCodex.planningProfile);
  if (config.localCodex.planningProfileV2) args.push("--profile-v2", config.localCodex.planningProfileV2);
  if (config.localCodex.planningReasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(config.localCodex.planningReasoningEffort)}`);
  if (config.localCodex.inheritShellEnvironment) args.push("-c", "shell_environment_policy.inherit=all");
  return args;
}

export function buildSubagentAdvisorPrompt(input: {
  userGoal: string;
  session: SessionState;
  project: ProjectRecord;
  decision: PlannerDecision;
}) {
  return [
    "You are a short-lived parallel Codex subagent advisor for Codex Phone Supervisor.",
    "Decide whether the upcoming single local Codex CLI implementation should use internal logical Codex subagents.",
    "Do not choose a fixed subagent count. Codex implementation lead still chooses count and names during the real run.",
    "Bias toward visible internal subagents for non-trivial app, site, game, full-stack, integration, docs, tests, validation, or research work when that is truthful.",
    "Recommend subagents when the work has meaningfully distinct responsibility areas such as product/UI, backend/API, shared logic, data, tests, docs, integration, research, or validation.",
    "Do not recommend fake subagents for tiny single-file edits or when the user asks for a single-lane run.",
    "If the user asked for no subagents or a single-lane run, recommend false and say Codex should ask before changing that.",
    "Return a concise user_check_in sentence that can be shown before Megaplan approval.",
    "Do not inspect files, write files, run commands, or include file paths. Return only JSON.",
    "",
    JSON.stringify({
      user_request: input.userGoal,
      requirement_summary: input.decision.requirements_summary,
      proposed_design: input.decision.proposed_design,
      proposed_responsibility_areas: input.decision.proposed_task_split.map((item) => ({
        title: item.title,
        goal: item.goal,
      })),
      pending_approval: input.session.pending_action?.type ?? null,
      project_name: input.project.display_name,
    }, null, 2),
  ].join("\n");
}

export function runSubagentAdvisor(input: {
  userGoal: string;
  session: SessionState;
  project: ProjectRecord;
  decision: PlannerDecision;
}) {
  const fallback = plannerContextSubagentAdvice({
    userGoal: input.userGoal,
    decision: input.decision,
  });
  if (!shouldRunSubagentAdvisor(input.userGoal, input.decision)) return fallback;
  if (config.testMode) return fallback;

  const startedMs = Date.now();
  const schemaPath = buildSchemaFile(input.session.session_id);
  const finalMessagePath = path.join(config.runtimeDir, `${input.session.session_id}.subagent-advisor.final.json`);
  const prompt = buildSubagentAdvisorPrompt(input);
  const args = [
    "exec",
    ...codexAdvisorArgs(),
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
    scope: "planning",
    scope_id: input.decision.planning_decision_id ?? input.session.session_id,
    type: "subagent_advisor.codex_cli.started",
    message: "Started short-lived read-only Codex subagent advisor.",
    data: {
      session_id: input.session.session_id,
      project_id: input.project.project_id,
      timeout_ms: SUBAGENT_ADVISOR_TIMEOUT_MS,
    },
  });
  const result = spawnSync(config.codexCommand, args, {
    cwd: input.project.workspace_path,
    input: prompt,
    encoding: "utf8",
    timeout: SUBAGENT_ADVISOR_TIMEOUT_MS,
    env: {
      ...process.env,
      CODEX_HOME: config.codexHome,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    maxBuffer: 1024 * 1024,
  });
  const durationMs = Date.now() - startedMs;
  if (result.error || result.status !== 0) {
    const error = result.error?.message || result.stderr?.slice(0, 240) || `Codex subagent advisor exited with ${result.status ?? "unknown status"}`;
    appendOrchestratorEvent({
      scope: "planning",
      scope_id: input.decision.planning_decision_id ?? input.session.session_id,
      type: result.error?.message.includes("ETIMEDOUT") ? "subagent_advisor.codex_cli.timed_out" : "subagent_advisor.codex_cli.failed",
      message: error,
      data: { session_id: input.session.session_id, project_id: input.project.project_id, duration_ms: durationMs },
    });
    return plannerContextSubagentAdvice({ userGoal: input.userGoal, decision: input.decision, error });
  }
  const finalText = extractFinalAgentText(parseCodexJsonl(`${result.stdout}\n${result.stderr}`)) || safeRead(finalMessagePath) || result.stdout;
  const advice = parseAdvice(finalText, fallback);
  appendOrchestratorEvent({
    scope: "planning",
    scope_id: input.decision.planning_decision_id ?? input.session.session_id,
    type: "subagent_advisor.codex_cli.completed",
    message: advice.user_check_in,
    data: {
      session_id: input.session.session_id,
      project_id: input.project.project_id,
      duration_ms: durationMs,
      advice,
    },
  });
  return advice;
}

export function withSubagentAdvice(input: {
  userGoal: string;
  session: SessionState;
  project: ProjectRecord;
  decision: PlannerDecision;
}): PlannerDecision {
  return {
    ...input.decision,
    subagent_advice: runSubagentAdvisor(input),
  };
}
