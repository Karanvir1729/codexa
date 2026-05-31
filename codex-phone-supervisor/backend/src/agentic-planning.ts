import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { classifyApproval } from "./approval-firewall.js";
import { taskComplexityJudge } from "./task-complexity.js";
import { multiWorkerCoordinator } from "./multi-worker-coordinator.js";
import { extractFinalAgentText, parseCodexJsonl } from "./parser.js";
import {
  appendOrchestratorEvent,
  getOrchestratorSettings,
  getSession,
  getTask,
  getTaskGraph,
  getWorker,
  listCommandEvents,
  upsertSession,
} from "./store.js";
import { getProject, upsertProject } from "./project-store.js";
import { redactSensitiveJson } from "./redaction.js";
import type {
  ApprovedPlanRecord,
  Channel,
  CommandRiskLevel,
  CodexSubagentAdvice,
  DesignDecisionRecord,
  PlannerDecision,
  PlannerDecisionType,
  PlannerNextAction,
  PlannerTaskSplitItem,
  ProjectRecord,
  SessionState,
  TaskComplexityDecision,
  WorkerType,
} from "./types.js";

export interface PlannerInput {
  user_message: string;
  session: Pick<
    SessionState,
    | "session_id"
    | "current_status"
    | "project_id"
    | "current_project_id"
    | "active_task"
    | "active_task_id"
    | "active_worker_id"
    | "channel"
    | "pending_action"
    | "pending_approvals"
    | "preferred_worker_mode"
    | "recent_messages"
    | "requirement_summary"
    | "planner_output"
    | "approved_plan"
    | "approval_status"
  >;
  project: ProjectRecord | null;
  active_task: ReturnType<typeof getTask>;
  active_worker: ReturnType<typeof getWorker>;
  current_task_graph: ReturnType<typeof getTaskGraph>;
  complexity: TaskComplexityDecision;
  worker_mode: WorkerType;
  risk_policy: {
    requires_approval: boolean;
    reason: string;
    risk_level: CommandRiskLevel;
  };
  recent_command_events: ReturnType<typeof listCommandEvents>;
  known_constraints: string[];
  conversation_pressure: ConversationPressure;
}

export interface ConversationPressure {
  level: "none" | "mild" | "high";
  reduce_clarifying_questions: boolean;
  signals: string[];
  summary: string;
}

export interface PlannerModel {
  readonly modelName: string;
  generatePlanningDecision(input: PlannerInput): Promise<PlannerDecision>;
}

const decisionTypes: PlannerDecisionType[] = [
  "answer_status_question",
  "ask_clarification",
  "summarize_requirements",
  "propose_design",
  "propose_task_split",
  "request_user_approval",
  "start_simple_task",
  "start_multi_worker_task",
  "revise_plan",
  "wait_for_user",
  "continue_execution",
  "request_risky_action_approval",
  "explain_blocker",
];

const nextActions: PlannerNextAction[] = ["none", "create_project", "create_task_graph", "launch_workers", "answer_only"];
const workerModes: WorkerType[] = ["codex_session_local", "local", "docker_local", "gcp_vm", "gke_job"];
const riskLevels: CommandRiskLevel[] = ["low", "medium", "high", "blocked"];
const PLANNER_CODEX_TIMEOUT_MS = 60_000;

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function textArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function uniqueText(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isDocPath(file: string) {
  return file.startsWith(".head-developer/");
}

function normalizeValidationCommand(command: string) {
  return command
    .replace(/\s+when\b.*$/i, "")
    .trim();
}

function isExecutableValidationCommand(command: string) {
  const normalized = normalizeValidationCommand(command);
  if (!normalized) return false;
  if (/^(verify|ensure|confirm|check that|inspect|open|manual|look for)\b/i.test(normalized)) return false;
  return /^(npm|pnpm|yarn|node|npx|bun|deno|python|python3|pytest|vitest|playwright|tsc|eslint|find|test|grep|rg|curl|git|docker)\b/i.test(normalized)
    || /^[\w./-]+\s+(--?[\w-]+|\S+\.(?:js|ts|tsx|jsx|html|css|json|md)\b)/i.test(normalized);
}

function validationCommandsForPlannerTask(item: PlannerTaskSplitItem) {
  const fileChecks = item.expected_files
    .filter((file) => !isDocPath(file) && /^[\w./-]+\.[\w-]+$/.test(file))
    .map((file) => `test -f ${file}`);
  const explicitCommands = item.validation
    .filter(isExecutableValidationCommand)
    .map(normalizeValidationCommand);
  const jsChecks = item.expected_files
    .filter((file) => !isDocPath(file) && /\.(?:mjs|cjs|js)$/i.test(file))
    .map((file) => `node --check ${file}`);
  return uniqueText([...fileChecks, ...jsChecks, ...explicitCommands]);
}

function acceptanceChecksForPlannerTask(item: PlannerTaskSplitItem) {
  const humanChecks = item.validation.filter((check) => !isExecutableValidationCommand(check));
  return uniqueText([
    "Required files exist.",
    "Validation commands run or blocker is recorded.",
    "Worker handoff records changed files and validation.",
    ...humanChecks,
  ]);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function parseTaskSplit(value: unknown): PlannerTaskSplitItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      title: text(item.title, "Implementation task"),
      goal: text(item.goal, text(item.title, "Complete the requested implementation task.")),
      can_run_parallel: Boolean(item.can_run_parallel),
      depends_on: textArray(item.depends_on),
      expected_files: textArray(item.expected_files),
      validation: textArray(item.validation),
    }))
    .filter((item) => item.title && item.goal);
}

function parseSubagentAdvice(value: unknown): CodexSubagentAdvice | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    recommended: Boolean(raw.recommended),
    confidence: boundedNumber(raw.confidence, 0.5, 0, 1),
    reason: text(raw.reason, "Codex will decide whether internal subagents are useful."),
    user_check_in: text(raw.user_check_in, "Approval means Codex may choose internal subagents when useful; tell me before approval if you want a single-lane run."),
    suggested_responsibilities: textArray(raw.suggested_responsibilities),
    source: raw.source === "codex_cli" ? "codex_cli" : "planner_context",
    error: text(raw.error) || null,
  };
}

function extractJsonObject(value: string) {
  const trimmed = value.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Planner response did not include a JSON object.");
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
}

function safeRead(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function preview(value: string, max = 600) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function parsePlannerDecision(value: unknown): PlannerDecision {
  const parsed = typeof value === "string" ? extractJsonObject(value) : value;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Planner decision must be an object.");
  }
  const raw = parsed as Record<string, unknown>;
  const decisionType = text(raw.decision_type) as PlannerDecisionType;
  if (!decisionTypes.includes(decisionType)) {
    throw new Error("Planner decision has an invalid decision_type.");
  }
  const nextAction = text(raw.next_action, "none") as PlannerNextAction;
  if (!nextActions.includes(nextAction)) {
    throw new Error("Planner decision has an invalid next_action.");
  }
  const workerMode = text(raw.recommended_worker_mode, "local") as WorkerType;
  if (!workerModes.includes(workerMode)) {
    throw new Error("Planner decision has an invalid recommended_worker_mode.");
  }
  const riskLevel = text(raw.risk_level, "low") as CommandRiskLevel;
  if (!riskLevels.includes(riskLevel)) {
    throw new Error("Planner decision has an invalid risk_level.");
  }
  const userVisibleResponse = text(raw.user_visible_response);
  if (!userVisibleResponse) {
    throw new Error("Planner decision is missing user_visible_response.");
  }
  const confidence = boundedNumber(raw.confidence, 0.5, 0, 1);
  const split = parseTaskSplit(raw.proposed_task_split);
  return {
    planning_decision_id: text(raw.planning_decision_id) || `planning_${randomUUID()}`,
    decision_type: decisionType,
    confidence,
    reason: text(raw.reason, "Planner selected the next orchestration move."),
    user_visible_response: userVisibleResponse,
    requirements_summary: text(raw.requirements_summary, userVisibleResponse),
    open_questions: textArray(raw.open_questions),
    assumptions: textArray(raw.assumptions),
    proposed_design: text(raw.proposed_design),
    proposed_task_split: split,
    recommended_worker_count: Math.max(1, Math.round(boundedNumber(raw.recommended_worker_count, split.length || 1, 1, 10))),
    recommended_worker_mode: workerMode,
    requires_user_approval: Boolean(raw.requires_user_approval),
    approval_reason: text(raw.approval_reason),
    risk_level: riskLevel,
    next_action: nextAction,
    execution_allowed: Boolean(raw.execution_allowed),
    subagent_advice: parseSubagentAdvice(raw.subagent_advice),
  };
}

function normalized(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function includesAny(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

function userConversationCorpus(input: Pick<PlannerInput, "user_message" | "session">) {
  return [
    ...(input.session.recent_messages ?? [])
      .filter((message) => message.role === "user")
      .slice(-6)
      .map((message) => message.text),
    input.user_message,
  ].join("\n");
}

export function detectConversationPressure(input: Pick<PlannerInput, "user_message" | "session">): ConversationPressure {
  const corpus = userConversationCorpus(input);
  const value = normalized(corpus);
  const signals: string[] = [];
  const highPatterns: Array<[RegExp, string]> = [
    [/\b(stop asking|no more questions|too many questions|too much back and forth|so much back and forth)\b/i, "user asked to reduce clarification loops"],
    [/\b(just build it|just make it|just do it|go ahead|use defaults|you decide|pick defaults)\b/i, "user wants Codex to choose defaults"],
    [/\b(i already told you|i told you|you are not listening|you're not listening|why (are|do) you keep)\b/i, "user indicates repeated misunderstanding"],
    [/\b(frustrating|frustrated|annoying|ugh|wtf)\b/i, "user expressed frustration"],
  ];
  const mildPatterns: Array<[RegExp, string]> = [
    [/\b(issue|glitch|for some reason|seems like|hmm)\b/i, "user is reporting a problem"],
    [/\b(no,? (call|name|make|use)|actually|instead)\b/i, "user is correcting the plan"],
  ];
  for (const [pattern, signal] of highPatterns) {
    if (pattern.test(value)) signals.push(signal);
  }
  const high = signals.length > 0;
  if (!high) {
    for (const [pattern, signal] of mildPatterns) {
      if (pattern.test(value)) signals.push(signal);
    }
  }
  const level = high ? "high" : signals.length ? "mild" : "none";
  return {
    level,
    reduce_clarifying_questions: high,
    signals: uniqueText(signals),
    summary: level === "high"
      ? "User appears impatient with more back-and-forth; ask only true blockers and otherwise choose local defaults."
      : level === "mild"
        ? "User is correcting or reporting a problem; acknowledge the correction and avoid repeating stale assumptions."
        : "No user discomfort detected.",
  };
}

function hasResearchDecision(input: PlannerInput) {
  const value = normalized(userConversationCorpus(input));
  return /\b(no research|skip research|without research|do not research|don't research|no need to research|no need for research|proceed without research)\b/i.test(value)
    || /\b(research first|do research|conduct research|need research|needs research|look up|browse|search the web|investigate sources|compare current|current best practices)\b/i.test(value)
    || /\b(you decide|codex decide|use defaults|use practical defaults|use sensible defaults|choose practical defaults|choose sensible defaults|pick defaults|just build it|just make it|just do it|go ahead|no more questions|keep it simple)\b/i.test(value);
}

function isVoiceLikeChannel(channel?: Channel | null) {
  return channel === "web_voice" || channel === "phone" || channel === "twilio_call" || channel === "twilio_sms" || channel === "sms";
}

function shouldReducePlannerQuestions(input: PlannerInput) {
  return input.conversation_pressure.reduce_clarifying_questions || isVoiceLikeChannel(input.session.channel);
}

function isResearchRelevantBuild(input: PlannerInput, decision: PlannerDecision) {
  const value = normalized([
    input.user_message,
    input.session.requirement_summary ?? "",
    decision.requirements_summary,
    decision.proposed_design,
    ...decision.proposed_task_split.flatMap((item) => [item.title, item.goal]),
  ].join(" "));
  if (!/\b(app|website|site|store|shop|commerce|marketplace|dashboard|saas|landing page|product|checkout|cart|customer|users?)\b/.test(value)) return false;
  if (/\b(cli|bash|shell script|number guessing|toy script)\b/.test(value) && !/\b(website|app|store|shop|commerce|dashboard|saas|full[- ]?stack)\b/.test(value)) return false;
  if (/\blanding page\b/.test(value) && !/\b(sell|selling|ecommerce|commerce|marketplace|checkout|cart|payment|inventory|regulated|current|latest|recommendations?)\b/.test(value)) return false;
  return /\b(sell|selling|ecommerce|commerce|marketplace|checkout|cart|payment|inventory|regulated|current|latest|recommendations?|medical|healthcare|finance|legal|compliance)\b/.test(value);
}

function needsResearchClarification(input: PlannerInput, decision: PlannerDecision) {
  if (decision.decision_type === "ask_clarification" || decision.decision_type === "wait_for_user" || decision.decision_type === "answer_status_question") return false;
  if (shouldReducePlannerQuestions(input)) return false;
  if (hasResearchDecision(input)) return false;
  if (!isResearchRelevantBuild(input, decision)) return false;
  return decision.requires_user_approval || decision.execution_allowed || decision.next_action === "launch_workers" || decision.next_action === "create_task_graph";
}

function enforceResearchClarification(input: PlannerInput, decision: PlannerDecision) {
  if (!needsResearchClarification(input, decision)) return decision;
  const question = "Before I write the Megaplan, should Codex conduct product, domain, UX, or technical research first? If yes, tell me the topics or sources that matter; otherwise I will proceed without research.";
  return {
    ...decision,
    decision_type: "ask_clarification" as const,
    reason: `${decision.reason} Research preference is not recorded yet, and this product/app build may benefit from research before the Megaplan.`,
    user_visible_response: question,
    open_questions: [question],
    assumptions: uniqueText([...decision.assumptions, "No research preference recorded yet."]),
    requires_user_approval: false,
    approval_reason: "",
    next_action: "none" as const,
    execution_allowed: false,
  };
}

function adaptDecisionForConversationPressure(input: PlannerInput, decision: PlannerDecision) {
  if (!shouldReducePlannerQuestions(input) || decision.decision_type !== "ask_clarification") return decision;
  if (!input.project && !input.session.project_id && !input.session.current_project_id) return decision;
  const mode = plannerMode(input);
  const fallbackSplit = input.complexity.suggested_subtasks.length
    ? input.complexity.suggested_subtasks.slice(0, mode === "codex_session_local" ? 6 : 3).map((item) => ({
      title: item.title,
      goal: item.goal,
      can_run_parallel: false,
      depends_on: item.dependencies,
      expected_files: item.files_expected,
      validation: item.validation_commands,
    }))
    : oneWorkerLandingSplit(input.session.requirement_summary || input.user_message);
  return {
    ...decision,
    decision_type: "request_user_approval" as const,
    reason: `${decision.reason} ${isVoiceLikeChannel(input.session.channel) ? "Voice/Twilio turns should use AI-inferred defaults and avoid setup back-and-forth unless truly blocked." : "User conversation pressure indicates Codex should stop expanding clarification questions and use conservative defaults."}`,
    user_visible_response: "Understood. I will use pragmatic local defaults from the conversation and put the Megaplan in front of you for approval before Codex starts.",
    requirements_summary: decision.requirements_summary || input.session.requirement_summary || input.user_message,
    open_questions: [],
    assumptions: uniqueText([
      ...decision.assumptions,
      "Use sensible local defaults for unspecified details.",
      "Proceed without product/domain research unless the user asks for it before approval.",
    ]),
    proposed_design: decision.proposed_design || (mode === "codex_session_local"
      ? "Codex will stop expanding clarification questions, use pragmatic local defaults from the conversation, then run one local Codex CLI session that owns the repo, chooses logical internal subagents, implements, and validates locally."
      : "Codex will stop expanding clarification questions, use pragmatic local defaults from the conversation, then implement and validate locally."),
    proposed_task_split: decision.proposed_task_split.length ? decision.proposed_task_split : fallbackSplit,
    recommended_worker_count: mode === "codex_session_local" ? 1 : Math.max(1, Math.min(input.complexity.recommended_worker_count, 3)),
    recommended_worker_mode: mode,
    requires_user_approval: true,
    approval_reason: mode === "codex_session_local"
      ? "The Megaplan must be approved before the local Codex CLI implementation session starts."
      : "The revised plan should be approved before execution starts.",
    next_action: "none" as const,
    execution_allowed: false,
  };
}

function requestedWorkerMode(textValue: string): WorkerType | null {
  const value = normalized(textValue);
  if (/\b(docker local|docker_local|local docker)\b/.test(value)) return "docker_local";
  if (/\b(codex session local|local codex session|one codex session|codex_session_local)\b/.test(value)) return "codex_session_local";
  if (/\b(gke|kubernetes|k8s)\b[\s\S]*\b(job|jobs|workers?)\b/.test(value) || /\bworkers?\b[\s\S]*\b(gke|kubernetes|k8s)\b/.test(value)) return "gke_job";
  if (/\b(gcp vm|compute engine)\b/.test(value) || /\b(gcp|cloud)\b[\s\S]*\bworkers?\b/.test(value) || /\bworkers?\b[\s\S]*\b(gcp|cloud)\b/.test(value)) return "gcp_vm";
  if (/\b(local mode|use local|local worker)\b/.test(value)) return "local";
  return null;
}

function plannerMode(input: PlannerInput) {
  return requestedWorkerMode(input.user_message) ?? input.session.preferred_worker_mode ?? input.worker_mode;
}

function staticSaasSplit(): PlannerTaskSplitItem[] {
  return [
    {
      title: "Landing and login pages",
      goal: "Build the static landing page and login page for the SaaS dashboard shell.",
      can_run_parallel: true,
      depends_on: [],
      expected_files: ["index.html", "login.html", "styles/public.css", "scripts/public.js"],
      validation: ["node --check scripts/public.js"],
    },
    {
      title: "Dashboard and settings pages",
      goal: "Build the static dashboard page and settings page for the SaaS dashboard shell.",
      can_run_parallel: true,
      depends_on: [],
      expected_files: ["dashboard.html", "settings.html", "styles/app.css", "scripts/app.js"],
      validation: ["node --check scripts/app.js"],
    },
  ];
}

function oneWorkerLandingSplit(userMessage: string): PlannerTaskSplitItem[] {
  return [
    {
      title: "Build static landing page",
      goal: userMessage,
      can_run_parallel: false,
      depends_on: [],
      expected_files: ["index.html", "styles.css", "script.js"],
      validation: ["node --check script.js when script.js exists"],
    },
  ];
}

function isStaticArtifactFile(file: string) {
  return /\.(?:html|css|js|mjs|cjs|json|svg|png|jpe?g|webp|ico|txt|md)$/i.test(file);
}

function duplicateExpectedFiles(split: PlannerTaskSplitItem[]) {
  const files = split.flatMap((item) => item.expected_files).filter((file) => !isDocPath(file));
  return files.length !== new Set(files).size;
}

function looksLikeSingleSurfaceStaticWork(input: PlannerInput, decision: PlannerDecision) {
  const split = decision.proposed_task_split;
  if (split.length <= 1) return false;
  const appFiles = split.flatMap((item) => item.expected_files).filter((file) => !isDocPath(file));
  if (!appFiles.length || !appFiles.every(isStaticArtifactFile)) return false;
  const serialSplit = !split.some((item) => item.can_run_parallel);
  if (!serialSplit && !duplicateExpectedFiles(split)) return false;
  const corpus = normalized([
    input.user_message,
    decision.requirements_summary,
    decision.proposed_design,
    ...split.flatMap((item) => [item.title, item.goal]),
  ].join(" "));
  if (!/\b(static|html|css|javascript|js|browser|form|landing page|website|site|localstorage|local storage|no backend)\b/.test(corpus)) return false;
  const nonNegatedCorpus = corpus.replace(/\b(no|without)\s+(api|backend|server|database|db)\b/g, "");
  if (/\b(api|backend|server|database|db|postgres|mysql|sqlite|full stack|full-stack|deploy|stripe|payment)\b/.test(nonNegatedCorpus)) return false;
  const surfaces = ["landing", "login", "dashboard", "settings", "admin", "billing", "pricing", "reports", "profile"].filter((surface) => new RegExp(`\\b${surface}\\b`).test(corpus));
  return new Set(surfaces).size < 3;
}

function optimizePlannerDecisionForSpeed(input: PlannerInput, decision: PlannerDecision) {
  if (!looksLikeSingleSurfaceStaticWork(input, decision)) return decision;
  const expectedFiles = uniqueText(decision.proposed_task_split.flatMap((item) => item.expected_files));
  const validation = uniqueText(decision.proposed_task_split.flatMap((item) => item.validation));
  const approvalIsRiskBased = decision.risk_level !== "low" || /risk|secret|iam|deploy|public|destructive/i.test(decision.approval_reason);
  const workerLabel = decision.recommended_worker_mode === "docker_local"
    ? "Docker Local"
    : decision.recommended_worker_mode === "gke_job"
      ? "GKE Job"
      : decision.recommended_worker_mode === "gcp_vm"
        ? "GCP VM"
        : decision.recommended_worker_mode === "codex_session_local"
          ? "local Codex CLI session"
        : "local";
  const localCodexSession = decision.recommended_worker_mode === "codex_session_local";
  return {
    ...decision,
    decision_type: approvalIsRiskBased ? decision.decision_type : "start_simple_task" as const,
    reason: localCodexSession
      ? `${decision.reason} Kept the static-app work in one local Codex CLI session because the planned areas overlap on one app surface.`
      : `${decision.reason} Optimized the planner split to one worker because the proposed static-app tasks were serial or overlapped on one app surface.`,
    user_visible_response: localCodexSession
      ? "I can keep this fast as one local Codex CLI session. Codex will build the requested static app, validate the generated files, and report real command evidence."
      : `I can keep this fast as one ${workerLabel} worker because the proposed static-app split is sequential or targets the same app surface. I will build the requested static app, validate the generated files, and report real command evidence.`,
    proposed_task_split: [
      {
        title: "Build static app",
        goal: decision.requirements_summary || input.user_message,
        can_run_parallel: false,
        depends_on: [],
        expected_files: expectedFiles,
        validation,
      },
    ],
    recommended_worker_count: 1,
    requires_user_approval: approvalIsRiskBased ? decision.requires_user_approval : false,
    approval_reason: approvalIsRiskBased ? decision.approval_reason : "",
    next_action: approvalIsRiskBased ? decision.next_action : "launch_workers" as const,
    execution_allowed: approvalIsRiskBased ? decision.execution_allowed : true,
  };
}

function decision(input: Omit<PlannerDecision, "planning_decision_id">): PlannerDecision {
  return { planning_decision_id: `planning_${randomUUID()}`, ...input };
}

export class DeterministicFallbackPlannerModel implements PlannerModel {
  readonly modelName = "deterministic_fallback";

  async generatePlanningDecision(input: PlannerInput): Promise<PlannerDecision> {
    const value = normalized(input.user_message);
    const mode = plannerMode(input);
    const risk = input.risk_policy;
    const statusQuestion = /^(status|what is happening|what's happening|what now|what did codex do|what changed|did tests pass)\b/i.test(value);
    if (statusQuestion) {
      return decision({
        decision_type: "answer_status_question",
        confidence: 0.9,
        reason: "The user is asking for current state, not new implementation.",
        user_visible_response: "I will answer from the recorded task, worker, command, validation, and summary events.",
        requirements_summary: "Answer the user's status question from recorded orchestration state.",
        open_questions: [],
        assumptions: [],
        proposed_design: "",
        proposed_task_split: [],
        recommended_worker_count: 1,
        recommended_worker_mode: mode,
        requires_user_approval: false,
        approval_reason: "",
        risk_level: "low",
        next_action: "answer_only",
        execution_allowed: false,
      });
    }

    if (risk.requires_approval) {
      return decision({
        decision_type: "request_risky_action_approval",
        confidence: 0.9,
        reason: risk.reason,
        user_visible_response: `${risk.reason} Approve this before I proceed?`,
        requirements_summary: input.user_message,
        open_questions: [],
        assumptions: [],
        proposed_design: "",
        proposed_task_split: [],
        recommended_worker_count: 1,
        recommended_worker_mode: mode,
        requires_user_approval: true,
        approval_reason: risk.reason,
        risk_level: risk.risk_level,
        next_action: "none",
        execution_allowed: false,
      });
    }

    const vagueGame = /\b(build|make|create)\b[\s\S]*\bgame\b/.test(value) && !/\b(platformer|puzzle|card|board|word|wordle|arcade|racing|shooter|quiz|snake|tetris|chess|memory)\b/.test(value);
    const vagueBuild = /^(build|make|create)\s+(an?\s+)?(app|website|site|tool|game)\.?$/.test(value);
    const underspecifiedCommerceApp = /\b(app|application)\b/.test(value)
      && /\b(sell|selling|shop|store|commerce|checkout|cart|marketplace)\b/.test(value)
      && !/\b(static|mock|prototype|frontend only|front-end only|no backend|full[- ]?stack|backend|api|database|db|stripe|payment|checkout|cart|inventory|auth|login)\b/.test(value);
    if (underspecifiedCommerceApp) {
      const question = "Should the selling app be a static storefront mockup, or a full-stack app with cart/checkout, inventory, auth, payments, and persistent data?";
      return decision({
        decision_type: "ask_clarification",
        confidence: 0.86,
        reason: "The request is for a commerce app, but the technical scope changes the architecture and validation plan.",
        user_visible_response: question,
        requirements_summary: input.user_message,
        open_questions: [question],
        assumptions: [],
        proposed_design: "",
        proposed_task_split: [],
        recommended_worker_count: 1,
        recommended_worker_mode: mode,
        requires_user_approval: false,
        approval_reason: "",
        risk_level: "low",
        next_action: "none",
        execution_allowed: false,
      });
    }
    if (vagueGame || vagueBuild) {
      const question = vagueGame
        ? "What kind of game should I build, and should it be browser-based/static or use an existing game framework?"
        : "What should this build do for the user, and should it be a static app or use the repo's existing stack?";
      return decision({
        decision_type: "ask_clarification",
        confidence: 0.85,
        reason: "The request names a broad category but not enough product behavior to plan files or workers.",
        user_visible_response: question,
        requirements_summary: input.user_message,
        open_questions: [question],
        assumptions: [],
        proposed_design: "",
        proposed_task_split: [],
        recommended_worker_count: 1,
        recommended_worker_mode: mode,
        requires_user_approval: false,
        approval_reason: "",
        risk_level: "low",
        next_action: "none",
        execution_allowed: false,
      });
    }

    const asksCloudWorker = mode === "gcp_vm" || mode === "gke_job" || /\b(gcp|cloud|gke|kubernetes|k8s)\b[\s\S]*\b(job|jobs|workers?)\b/.test(value);
    if (asksCloudWorker) {
      const label = mode === "gke_job" ? "GKE Job" : "GCP VM";
      return decision({
        decision_type: "request_user_approval",
        confidence: 0.88,
        reason: `${label} worker execution can create or use cloud resources and needs explicit confirmation.`,
        user_visible_response: `Running this on ${label} workers needs approval before launch. Approve ${label} worker execution?`,
        requirements_summary: input.user_message,
        open_questions: [],
        assumptions: [`No ${label} worker will launch until the approval is recorded.`],
        proposed_design: "",
        proposed_task_split: input.complexity.suggested_subtasks.map((item) => ({
          title: item.title,
          goal: item.goal,
          can_run_parallel: Boolean(item.parallel_group || input.complexity.parallelizable),
          depends_on: item.dependencies,
          expected_files: item.files_expected,
          validation: item.validation_commands,
        })),
        recommended_worker_count: Math.max(1, input.complexity.recommended_worker_count),
        recommended_worker_mode: mode === "gke_job" ? "gke_job" : "gcp_vm",
        requires_user_approval: true,
        approval_reason: `${label} workers require explicit approval.`,
        risk_level: "medium",
        next_action: "none",
        execution_allowed: false,
      });
    }

    const staticSaas = /\bsaas\b/.test(value) && /\bdashboard\b/.test(value) && /\b(landing|login|settings)\b/.test(value);
    const staticOnly = /\b(static|html|css|js|javascript|no backend|static only|html\/css\/js only)\b/.test(value);
    if (staticSaas && staticOnly) {
      const split = staticSaasSplit();
      return decision({
        decision_type: "propose_task_split",
        confidence: 0.92,
        reason: "The request has two independent static app surfaces that can run safely in parallel after user approval.",
        user_visible_response: [
          "I can build this as a static HTML/CSS/JS app.",
          "Proposed split: worker 1 builds landing/login; worker 2 builds dashboard/settings.",
          "Validation: run JS syntax checks for each surface and keep output contracts on the generated files.",
          `Worker mode: ${mode}. Approve this 2-worker plan?`,
        ].join(" "),
        requirements_summary: "Build a static SaaS dashboard shell with landing, login, dashboard, and settings pages. No backend or billing unless explicitly requested.",
        open_questions: [],
        assumptions: ["Static HTML/CSS/JS is acceptable.", "Billing and backend work are out of scope unless requested."],
        proposed_design: "A multi-page static SaaS shell with a public landing/login surface and an authenticated dashboard/settings surface.",
        proposed_task_split: split,
        recommended_worker_count: 2,
        recommended_worker_mode: mode,
        requires_user_approval: true,
        approval_reason: "Multi-worker execution needs the user to approve the task split before workers launch.",
        risk_level: "low",
        next_action: "none",
        execution_allowed: false,
      });
    }

    const simpleLanding = /\b(landing page|website|site)\b/.test(value) && !includesAny(value, [/\bdashboard\b/, /\bauth\b/, /\bbilling\b/, /\bapi\b/, /\bdatabase\b/, /\badmin\b/]);
    if (simpleLanding || (!input.complexity.should_split && input.complexity.recommended_worker_count <= 1)) {
      return decision({
        decision_type: "start_simple_task",
        confidence: 0.82,
        reason: "The request is concrete enough for one worker and does not need a multi-worker approval loop.",
        user_visible_response: mode === "codex_session_local"
          ? "I will build this locally in one repo with one Codex CLI session, validate it, and keep the output grounded."
          : `I will build this as a small static app, validate it, and keep the output contract grounded. Starting one ${mode} worker now.`,
        requirements_summary: input.user_message,
        open_questions: [],
        assumptions: ["Use static HTML/CSS/JS unless the existing repo clearly indicates another stack."],
        proposed_design: mode === "codex_session_local"
          ? "One local Codex CLI session owns the repo, implements the requested page/app surface, and runs local validation."
          : "One worker builds the requested page/app surface and runs local validation.",
        proposed_task_split: oneWorkerLandingSplit(input.user_message),
        recommended_worker_count: 1,
        recommended_worker_mode: mode,
        requires_user_approval: false,
        approval_reason: "",
        risk_level: "low",
        next_action: "launch_workers",
        execution_allowed: true,
      });
    }

    const subtasks = input.complexity.suggested_subtasks.map((item) => ({
      title: item.title,
      goal: item.goal,
      can_run_parallel: Boolean(input.complexity.parallelizable && !item.dependencies.length),
      depends_on: item.dependencies,
      expected_files: item.files_expected,
      validation: item.validation_commands,
    }));
    if (input.complexity.should_split && input.complexity.recommended_worker_count > 1) {
      return decision({
        decision_type: "propose_task_split",
        confidence: 0.78,
        reason: input.complexity.reason,
        user_visible_response: mode === "codex_session_local"
          ? `This is complex enough to plan first. Proposed responsibility areas: ${subtasks.map((item) => item.title).join(" | ")}. Approve this plan before I start the local Codex CLI session?`
          : `I recommend ${input.complexity.recommended_worker_count} workers for this: ${subtasks.map((item) => item.title).join(" | ")}. Approve this plan before I launch workers?`,
        requirements_summary: input.user_message,
        open_questions: [],
        assumptions: input.complexity.risks.length ? input.complexity.risks : [],
        proposed_design: mode === "codex_session_local"
          ? "One local Codex CLI session owns the repo. Codex chooses the logical internal subagents and validates locally."
          : "Use the existing task graph infrastructure with output contracts and validation gates.",
        proposed_task_split: subtasks,
        recommended_worker_count: mode === "codex_session_local" ? 1 : input.complexity.recommended_worker_count,
        recommended_worker_mode: mode,
        requires_user_approval: true,
        approval_reason: mode === "codex_session_local"
          ? "Complex local work needs approval of the Megaplan before the Codex CLI session starts."
          : "Multi-worker execution requires explicit approval of the task split.",
        risk_level: input.complexity.risks.length ? "medium" : "low",
        next_action: "none",
        execution_allowed: false,
      });
    }

    return decision({
      decision_type: "start_simple_task",
      confidence: 0.7,
      reason: "The request is concrete and can be handled by one worker.",
      user_visible_response: mode === "codex_session_local"
        ? "I will run this as one local Codex CLI session with validation and grounded progress updates."
        : `I will run this as a one-worker implementation with validation and grounded progress updates. Starting one ${mode} worker now.`,
      requirements_summary: input.user_message,
      open_questions: [],
      assumptions: input.complexity.risks,
      proposed_design: mode === "codex_session_local"
        ? "One local Codex CLI session owns the repo and reports grounded implementation, subagent, and validation evidence."
        : "One worker executes the task with existing output-contract and summary enforcement.",
      proposed_task_split: subtasks.length ? subtasks.slice(0, 1) : oneWorkerLandingSplit(input.user_message),
      recommended_worker_count: 1,
      recommended_worker_mode: mode,
      requires_user_approval: false,
      approval_reason: "",
      risk_level: "low",
      next_action: "launch_workers",
      execution_allowed: true,
    });
  }
}

const plannerResponseSchema = {
  type: "OBJECT",
  required: [
    "decision_type",
    "confidence",
    "reason",
    "user_visible_response",
    "requirements_summary",
    "open_questions",
    "assumptions",
    "proposed_design",
    "proposed_task_split",
    "recommended_worker_count",
    "recommended_worker_mode",
    "requires_user_approval",
    "approval_reason",
    "risk_level",
    "next_action",
    "execution_allowed",
  ],
  properties: {
    decision_type: { type: "STRING", enum: decisionTypes },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" },
    user_visible_response: { type: "STRING" },
    requirements_summary: { type: "STRING" },
    open_questions: { type: "ARRAY", items: { type: "STRING" } },
    assumptions: { type: "ARRAY", items: { type: "STRING" } },
    proposed_design: { type: "STRING" },
    proposed_task_split: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["title", "goal", "can_run_parallel", "depends_on", "expected_files", "validation"],
        properties: {
          title: { type: "STRING" },
          goal: { type: "STRING" },
          can_run_parallel: { type: "BOOLEAN" },
          depends_on: { type: "ARRAY", items: { type: "STRING" } },
          expected_files: { type: "ARRAY", items: { type: "STRING" } },
          validation: { type: "ARRAY", items: { type: "STRING" } },
        },
      },
    },
    recommended_worker_count: { type: "NUMBER" },
    recommended_worker_mode: { type: "STRING", enum: workerModes },
    requires_user_approval: { type: "BOOLEAN" },
    approval_reason: { type: "STRING" },
    risk_level: { type: "STRING", enum: riskLevels },
    next_action: { type: "STRING", enum: nextActions },
    execution_allowed: { type: "BOOLEAN" },
  },
};

function plannerPrompt(input: PlannerInput) {
  return [
    "You are an engineering lead planning controller for Codex Phone Supervisor.",
    "Decide the next orchestration move. Do not force every request through a fixed checklist.",
    "Ask clarification only when the implementation requirements are genuinely unclear.",
    "For a new app where the answer changes architecture, ask one concise technical requirements question before creating a Megaplan or allowing implementation.",
    "Examples of architecture-changing gaps: static mockup vs full-stack app, backend/API, database/persistence, auth/accounts, payments/checkout, inventory/admin, target stack, preview/runtime needs, or integrations.",
    "For commerce or selling apps, do not assume fake checkout, real payments, inventory, auth, or persistence. If not specified, ask whether the user wants a static storefront mockup or a full-stack build with cart/checkout, inventory, auth, payments, and persistent data.",
    "Use multi-turn requirements gathering for product/app builds. After the user answers one technical question, keep asking concise follow-up technical questions when low-level details still materially affect the implementation, data model, API shape, validation, preview, or UX.",
    "For app/product builds, ask whether Codex should conduct product, domain, UX, or technical research before implementation, what topics or sources matter, or whether to proceed without research.",
    "Research timing: ask about research before Megaplan approval for product, commerce, SaaS, dashboard, full-stack, high-stakes, or current-information-sensitive builds. Do not slow down tiny scripts or obvious simple local tasks with research unless research would materially change correctness.",
    "Useful low-level details include target stack, routing/runtime, core entities and fields, auth roles, session behavior, persistence mechanism, API boundaries, checkout/payment behavior, admin permissions, seed data, validation commands, local preview command, and research needs.",
    "Treat research as a user-controlled requirement. Do not assume research is needed or not needed unless the user answers, asks Codex to decide, or clearly wants to proceed without more questions.",
    "For follow-ups, prefer one compact batch of 3-7 specific questions. Do not proceed to Megaplan just because one architecture dimension was answered if important implementation details remain unclear.",
    "Stop asking and choose reasonable defaults only when the user clearly is not entertaining more questions, such as saying just build it, you decide, use defaults, keep it simple, no more questions, or approve.",
    "If conversation pressure says the user is frustrated or tired of back-and-forth, acknowledge the correction briefly, ask only true blockers, choose conservative defaults where safe, and move to a Megaplan approval instead of another long questionnaire.",
    "When you ask clarification, set decision_type=ask_clarification, next_action=none, execution_allowed=false, requires_user_approval=false, and include the question in open_questions.",
    "Do not create or approve a Megaplan until required technical direction is known.",
    "If Pending action is clarify_requirements, treat User message as the user's answer to prior technical questions, then decide whether another low-level clarification round is needed before Megaplan.",
    "For implementation plans, include the local continuous-improvement expectation: Codex should look for bugs, optimizations, UX gaps, test gaps, and feature opportunities, record deferred ideas in .head-developer/IMPROVEMENTS.md, and avoid implementing scope-changing improvements without approval.",
    "Simple concrete tasks may start with one local Codex CLI session. Multi-worker legacy modes, GCP VM, GKE Job, deploy, secret, IAM, destructive, or public actions require approval.",
    "codex_session_local means one Codex CLI session in one repo; any subagents are logical internal Codex work, not OS workers or worktrees.",
    "Treat worker modes such as gke_job, gcp_vm, docker_local, and local as where Codex executes. Do not turn a worker-mode smoke into product deployment, containerization, or infrastructure work unless the user explicitly asks the generated app itself to be deployed.",
    "For proposed_task_split.validation, prefer executable shell commands such as test -f index.html or node --check script.js. Put human review checks in the conversational response instead of pretending they are commands.",
    "When approval is required, make user_visible_response conversational: confirm what you understood, state key assumptions or technical choices, summarize the task split and validation, then ask the user to approve or revise.",
    "Return only JSON matching the schema. Do not include raw JSON in user_visible_response.",
    "",
    `User message: ${input.user_message}`,
    `Session status: ${input.session.current_status}`,
    `Project: ${input.project?.display_name ?? "none"} ${input.project?.workspace_path ?? ""}`,
    `Worker mode: ${input.worker_mode}`,
    `Pending action: ${input.session.pending_action?.type ?? "none"}`,
    `Prior requirements summary: ${input.session.requirement_summary || "none"}`,
    `Prior open questions: ${input.session.planner_output?.open_questions?.join(" | ") || "none"}`,
    `Prior assumptions: ${input.session.planner_output?.assumptions?.join(" | ") || "none"}`,
    `Pending approvals: ${input.session.pending_approvals.filter((approval) => approval.status === "pending").map((approval) => `${approval.kind}: ${approval.command}`).join(" | ") || "none"}`,
    `Complexity judge: ${input.complexity.complexity}; workers=${input.complexity.recommended_worker_count}; split=${input.complexity.should_split}; reason=${input.complexity.reason}`,
    `Suggested subtasks: ${input.complexity.suggested_subtasks.map((item) => `${item.title} -> ${item.files_expected.join(", ")}`).join(" | ") || "none"}`,
    `Risk policy: ${input.risk_policy.requires_approval ? "approval required" : "no approval required"}; ${input.risk_policy.reason}; risk=${input.risk_policy.risk_level}`,
    `Conversation pressure: ${input.conversation_pressure.level}; reduce_questions=${input.conversation_pressure.reduce_clarifying_questions}; ${input.conversation_pressure.summary}; signals=${input.conversation_pressure.signals.join(" | ") || "none"}`,
    `Current task graph: ${input.current_task_graph?.task_graph_id ?? "none"}`,
    `Validation/output-contract state: ${input.current_task_graph?.nodes.map((node) => `${node.title}:${node.status}:${node.validation_commands.join(",")}`).join(" | ") || "none"}`,
    `Recent conversation: ${input.session.recent_messages.map((message) => `${message.role}: ${message.text}`).slice(-8).join(" | ") || "none"}`,
    `Known constraints: ${input.known_constraints.join(" | ")}`,
  ].join("\n");
}

function buildPlannerSchemaFile(sessionId: string) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const schemaPath = path.join(config.runtimeDir, `${sessionId}.planner.schema.json`);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: [
      "decision_type",
      "confidence",
      "reason",
      "user_visible_response",
      "requirements_summary",
      "open_questions",
      "assumptions",
      "proposed_design",
      "proposed_task_split",
      "recommended_worker_count",
      "recommended_worker_mode",
      "requires_user_approval",
      "approval_reason",
      "risk_level",
      "next_action",
      "execution_allowed",
    ],
    properties: {
      decision_type: { type: "string", enum: decisionTypes },
      confidence: { type: "number" },
      reason: { type: "string" },
      user_visible_response: { type: "string" },
      requirements_summary: { type: "string" },
      open_questions: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      proposed_design: { type: "string" },
      proposed_task_split: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "goal", "can_run_parallel", "depends_on", "expected_files", "validation"],
          properties: {
            title: { type: "string" },
            goal: { type: "string" },
            can_run_parallel: { type: "boolean" },
            depends_on: { type: "array", items: { type: "string" } },
            expected_files: { type: "array", items: { type: "string" } },
            validation: { type: "array", items: { type: "string" } },
          },
        },
      },
      recommended_worker_count: { type: "number" },
      recommended_worker_mode: { type: "string", enum: workerModes },
      requires_user_approval: { type: "boolean" },
      approval_reason: { type: "string" },
      risk_level: { type: "string", enum: riskLevels },
      next_action: { type: "string", enum: nextActions },
      execution_allowed: { type: "boolean" },
    },
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  return schemaPath;
}

function codexPlannerArgs() {
  const args: string[] = [];
  if (config.localCodex.planningModel) args.push("--model", config.localCodex.planningModel);
  if (config.localCodex.planningProfile) args.push("--profile", config.localCodex.planningProfile);
  if (config.localCodex.planningProfileV2) args.push("--profile-v2", config.localCodex.planningProfileV2);
  if (config.localCodex.planningReasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(config.localCodex.planningReasoningEffort)}`);
  if (config.localCodex.inheritShellEnvironment) args.push("-c", "shell_environment_policy.inherit=all");
  return args;
}

export class CodexCliPlannerModel implements PlannerModel {
  readonly modelName = "codex_cli";

  async generatePlanningDecision(input: PlannerInput): Promise<PlannerDecision> {
    const startedMs = Date.now();
    const schemaPath = buildPlannerSchemaFile(input.session.session_id);
    const finalMessagePath = path.join(config.runtimeDir, `${input.session.session_id}.planner.final.json`);
    const cwd = input.project?.workspace_path ?? config.defaultWorkspacePath;
    const prompt = plannerPrompt(input);
    const args = [
      "exec",
      ...codexPlannerArgs(),
      "--json",
      "--color",
      "never",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      finalMessagePath,
      "-C",
      cwd,
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "-",
    ];
    appendOrchestratorEvent({
      scope: "planning",
      scope_id: input.session.session_id,
      type: "planner.codex_cli.started",
      message: "Started read-only Codex CLI planner session.",
      data: {
        session_id: input.session.session_id,
        project_id: input.project?.project_id ?? null,
        cwd,
        model: config.localCodex.planningModel || null,
        reasoning_effort: config.localCodex.planningReasoningEffort,
      },
    });
    let timer: NodeJS.Timeout | null = null;
    try {
      const child = spawn(config.codexCommand, args, {
        cwd,
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
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, PLANNER_CODEX_TIMEOUT_MS);
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
      if (timer) clearTimeout(timer);
      timer = null;
      if (timedOut) throw new Error("Codex planner timed out.");
      if (exit.code !== 0) throw new Error(`Codex planner exited with code ${exit.code ?? "null"}${stderr ? `: ${preview(stderr)}` : ""}`);
      const finalText = extractFinalAgentText(parseCodexJsonl(`${stdout}\n${stderr}`)) || safeRead(finalMessagePath) || stdout;
      const decision = parsePlannerDecision(finalText);
      appendOrchestratorEvent({
        scope: "planning",
        scope_id: decision.planning_decision_id ?? input.session.session_id,
        type: "planner.codex_cli.completed",
        message: `${decision.decision_type}: ${decision.reason}`,
        data: {
          session_id: input.session.session_id,
          project_id: input.project?.project_id ?? null,
          duration_ms: Date.now() - startedMs,
          decision,
        },
      });
      return decision;
    } catch (error) {
      if (timer) clearTimeout(timer);
      appendOrchestratorEvent({
        scope: "planning",
        scope_id: input.session.session_id,
        type: "planner.codex_cli.failed",
        message: error instanceof Error ? error.message : String(error),
        data: {
          session_id: input.session.session_id,
          project_id: input.project?.project_id ?? null,
          duration_ms: Date.now() - startedMs,
        },
      });
      throw error;
    }
  }
}

function approvalStatus(decision: PlannerDecision): DesignDecisionRecord["approval_status"] {
  if (!decision.requires_user_approval) return "not_required";
  return "pending";
}

function activeGraphForSession(session: SessionState) {
  const task = session.active_task_id ? getTask(session.active_task_id) : null;
  if (task?.task_graph_id) return getTaskGraph(task.task_graph_id);
  return null;
}

function activeTaskForSession(session: SessionState) {
  return session.active_task_id ? getTask(session.active_task_id) : null;
}

function activeWorkerForSession(session: SessionState) {
  return session.active_worker_id ? getWorker(session.active_worker_id) : null;
}

function riskPolicy(userMessage: string) {
  const approval = classifyApproval(userMessage);
  return {
    requires_approval: approval.requiresApproval,
    reason: approval.reason ?? "No elevated risk detected.",
    risk_level: approval.risk ?? "low" as CommandRiskLevel,
  };
}

function currentWorkerMode(session: SessionState, explicit?: WorkerType | null) {
  return explicit ?? session.preferred_worker_mode ?? getOrchestratorSettings().default_worker_mode;
}

function modelForConfig(): PlannerModel {
  if (config.testMode && config.testSupervisorModelDouble === "deterministic") return new DeterministicFallbackPlannerModel();
  if (config.supervisorModelProvider === "codex_cli") return new CodexCliPlannerModel();
  throw new Error("Agentic planning is local-first in v1. Set SUPERVISOR_MODEL_PROVIDER=codex_cli or enable the deterministic test planner.");
}

function recordProjectPlanning(project: ProjectRecord | null, decision: PlannerDecision, modelName: string) {
  if (!project) return;
  const history: DesignDecisionRecord[] = [
    ...(project.design_decision_history ?? []),
    {
      planning_decision_id: decision.planning_decision_id!,
      ts: new Date().toISOString(),
      decision_type: decision.decision_type,
      reason: decision.reason,
      requirements_summary: decision.requirements_summary,
      assumptions: decision.assumptions,
      open_questions: decision.open_questions,
      worker_count: decision.recommended_worker_count,
      worker_mode: decision.recommended_worker_mode,
      approval_status: approvalStatus(decision),
    },
  ].slice(-20);
  upsertProject({
    ...project,
    requirement_summary: decision.requirements_summary,
    planning_decision_id: decision.planning_decision_id!,
    planner_model: modelName,
    planner_output: decision,
    approval_status: approvalStatus(decision),
    open_questions: decision.open_questions,
    assumptions: decision.assumptions,
    design_decision_history: history,
    user_approved_worker_count: decision.requires_user_approval ? null : decision.recommended_worker_count,
    user_approved_worker_mode: decision.requires_user_approval ? null : decision.recommended_worker_mode,
    updated_at: new Date().toISOString(),
  });
}

function normalizeUserVisibleApprovalPrompt(decision: PlannerDecision) {
  if (!decision.requires_user_approval) return decision;
  if (/\b(approve|approval|confirm)\b/i.test(decision.user_visible_response)) return decision;
  if (decision.recommended_worker_mode === "codex_session_local") {
    return {
      ...decision,
      user_visible_response: `${decision.user_visible_response} Approve this plan before I start the local Codex CLI session?`,
    };
  }
  return {
    ...decision,
    user_visible_response: `${decision.user_visible_response} Approve this plan before I launch workers?`,
  };
}

function normalizeClarificationResponse(decision: PlannerDecision) {
  if (decision.decision_type !== "ask_clarification" || !decision.open_questions.length) return decision;
  if (decision.open_questions.length === 1 && /\?/.test(decision.user_visible_response)) return decision;
  const visible = normalized(decision.user_visible_response);
  const missingQuestions = decision.open_questions.filter((question) => !visible.includes(normalized(question)));
  if (!missingQuestions.length) return decision;
  const questions = missingQuestions.map((question, index) => `${index + 1}. ${question}`).join(" ");
  return {
    ...decision,
    user_visible_response: `${decision.user_visible_response} ${questions}`.trim(),
  };
}

function enforceExecutionSafety(decision: PlannerDecision) {
  const cloudWorkerMode = decision.recommended_worker_mode === "gcp_vm" || decision.recommended_worker_mode === "gke_job";
  const localCodexSession = decision.recommended_worker_mode === "codex_session_local";
  const multiWorker = decision.recommended_worker_count > 1 || decision.decision_type === "start_multi_worker_task";
  if (!decision.execution_allowed || (!cloudWorkerMode && !multiWorker)) return decision;

  const workerLabel = decision.recommended_worker_mode === "gke_job"
    ? "GKE Job"
    : decision.recommended_worker_mode === "gcp_vm"
      ? "GCP VM"
      : localCodexSession
        ? "local Codex CLI session"
      : decision.recommended_worker_mode;
  const approvalReason = cloudWorkerMode
    ? `${workerLabel} workers run outside the local process, so I need approval before launching them.`
    : localCodexSession
      ? "This is complex enough that I need approval of the local implementation plan before starting the single Codex CLI session."
    : "Multi-worker execution needs approval of the task split before workers launch.";
  const response = /\b(approve|approval|confirm)\b/i.test(decision.user_visible_response)
    ? decision.user_visible_response
    : localCodexSession
      ? `${decision.user_visible_response} ${approvalReason} Approve this plan before I start the local Codex CLI session?`
      : `${decision.user_visible_response} ${approvalReason} Approve this plan before I launch workers?`;

  return {
    ...decision,
    decision_type: cloudWorkerMode ? "request_user_approval" as const : "propose_task_split" as const,
    requires_user_approval: true,
    approval_reason: decision.approval_reason || approvalReason,
    next_action: "none" as const,
    execution_allowed: false,
    user_visible_response: response,
  };
}

export class AgenticPlanningController {
  constructor(private readonly model: PlannerModel = modelForConfig()) {}

  buildInput(input: {
    session: SessionState;
    userMessage: string;
    project: ProjectRecord | null;
    workerMode?: WorkerType | null;
  }): PlannerInput {
    const workerMode = currentWorkerMode(input.session, input.workerMode);
    const activeTask = activeTaskForSession(input.session);
    const pressure = detectConversationPressure({ user_message: input.userMessage, session: input.session });
    return {
      user_message: input.userMessage,
      session: input.session,
      project: input.project,
      active_task: activeTask,
      active_worker: activeWorkerForSession(input.session),
      current_task_graph: activeTask?.task_graph_id ? getTaskGraph(activeTask.task_graph_id) : activeGraphForSession(input.session),
      complexity: taskComplexityJudge.evaluate({
        user_goal: input.userMessage,
        current_project: input.project,
        active_tasks: input.project ? [] : [],
        active_workers: [],
      }),
      worker_mode: workerMode,
      risk_policy: riskPolicy(input.userMessage),
      recent_command_events: activeTask ? listCommandEvents({ taskId: activeTask.task_id }).slice(-8) : [],
      conversation_pressure: pressure,
      known_constraints: [
        "Do not print or request secrets.",
        "Do not change GCP IAM or secrets without explicit approval.",
        "Complex local plans require approval before starting the single Codex CLI session.",
        "Multi-worker legacy execution requires approval of the split.",
        "GCP VM and GKE Job worker execution require approval before launch.",
        "Worker mode is an execution backend, not an implicit request to deploy or containerize the generated app.",
        "Completion gates and output contracts remain mandatory for app nodes.",
      ],
    };
  }

  async decide(input: {
    session: SessionState;
    userMessage: string;
    project: ProjectRecord | null;
    workerMode?: WorkerType | null;
  }) {
    const plannerInput = this.buildInput(input);
    let decision: PlannerDecision;
    let modelName = this.model.modelName;
    try {
      decision = parsePlannerDecision(await this.model.generatePlanningDecision(plannerInput));
    } catch (error) {
      if (!config.testMode) throw new Error("Local planner failed.");
      const fallback = new DeterministicFallbackPlannerModel();
      modelName = `${fallback.modelName}:after_invalid_${this.model.modelName}`;
      decision = parsePlannerDecision(await fallback.generatePlanningDecision(plannerInput));
      decision.reason = `Planner fallback used because ${error instanceof Error ? error.message : String(error)} ${decision.reason}`;
    }
    decision = normalizeClarificationResponse(normalizeUserVisibleApprovalPrompt(enforceExecutionSafety(enforceResearchClarification(plannerInput, adaptDecisionForConversationPressure(plannerInput, optimizePlannerDecisionForSpeed(plannerInput, decision))))));
    const planningDecisionId = decision.planning_decision_id ?? `planning_${randomUUID()}`;
    decision.planning_decision_id = planningDecisionId;
    decision = redactSensitiveJson(decision);
    decision.planning_decision_id = planningDecisionId;

    const latest = getSession(input.session.session_id) ?? input.session;
    const designRecord: DesignDecisionRecord = {
      planning_decision_id: planningDecisionId,
      ts: new Date().toISOString(),
      decision_type: decision.decision_type,
      reason: decision.reason,
      requirements_summary: decision.requirements_summary,
      assumptions: decision.assumptions,
      open_questions: decision.open_questions,
      worker_count: decision.recommended_worker_count,
      worker_mode: decision.recommended_worker_mode,
      approval_status: approvalStatus(decision),
    };
    latest.requirement_summary = decision.requirements_summary;
    latest.planning_decision_id = planningDecisionId;
    latest.planner_model = modelName;
    latest.planner_output = decision;
    latest.approval_status = approvalStatus(decision);
    latest.open_questions = decision.open_questions;
    latest.assumptions = decision.assumptions;
    latest.user_approved_worker_count = decision.requires_user_approval ? null : decision.recommended_worker_count;
    latest.user_approved_worker_mode = decision.requires_user_approval ? null : decision.recommended_worker_mode;
    latest.design_decision_history = [...(latest.design_decision_history ?? []), designRecord].slice(-20);
    latest.latest_codex_message = decision.user_visible_response;
    latest.last_updated = new Date().toISOString();
    upsertSession(latest);
    recordProjectPlanning(input.project, decision, modelName);
    appendOrchestratorEvent({
      scope: "planning",
      scope_id: planningDecisionId,
      type: "planner.decision.created",
      message: `${decision.decision_type}: ${decision.reason}`,
      data: {
        session_id: latest.session_id,
        project_id: input.project?.project_id ?? null,
        planner_model: modelName,
        decision,
      },
    });
    return { decision, planner_model: modelName, session: latest };
  }

  approvedPlan(decision: PlannerDecision, channel?: Channel | null): ApprovedPlanRecord {
    return redactSensitiveJson({
      planning_decision_id: decision.planning_decision_id ?? `planning_${randomUUID()}`,
      approved_at: new Date().toISOString(),
      approved_by_channel: channel ?? null,
      requirements_summary: decision.requirements_summary,
      proposed_design: decision.proposed_design,
      proposed_task_split: decision.proposed_task_split,
      worker_count: decision.recommended_worker_count,
      worker_mode: decision.recommended_worker_mode,
      approval_reason: decision.approval_reason,
      risk_level: decision.risk_level,
      subagent_advice: decision.subagent_advice ?? null,
    });
  }

  decisionToComplexity(decision: PlannerDecision, fallback: TaskComplexityDecision): TaskComplexityDecision {
    const split = decision.proposed_task_split.length
      ? decision.proposed_task_split
      : fallback.suggested_subtasks.map((item) => ({
        title: item.title,
        goal: item.goal,
        can_run_parallel: fallback.parallelizable,
        depends_on: item.dependencies,
        expected_files: item.files_expected,
        validation: item.validation_commands,
      }));
    const shouldSplit = split.length > 1;
    return {
      complexity: shouldSplit ? "complex" : fallback.complexity === "complex" ? "moderate" : fallback.complexity,
      recommended_worker_count: Math.max(1, decision.recommended_worker_count),
      should_split: shouldSplit,
      parallelizable: shouldSplit && decision.recommended_worker_count > 1 && split.some((item) => item.can_run_parallel),
      reason: decision.reason || fallback.reason,
      suggested_subtasks: split.map((item) => {
        const validationCommands = validationCommandsForPlannerTask(item);
        const acceptanceChecks = acceptanceChecksForPlannerTask(item);
        const requiredAppFiles = item.expected_files.filter((file) => !isDocPath(file));
        return {
          title: item.title,
          goal: item.goal,
          dependencies: item.depends_on,
          outputs_expected: [`Completed ${item.title.toLowerCase()} with file and validation evidence.`],
          files_expected: item.expected_files,
          required_app_files: requiredAppFiles,
          allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md", ".head-developer/VALIDATION.md"],
          expected_user_visible_output: [`User-visible ${item.title.toLowerCase()}`],
          validation_commands: validationCommands,
          acceptance_checks: acceptanceChecks,
          completion_criteria: [
            "Do not report complete if only .head-developer docs changed for app output.",
            "Report incomplete work honestly with command evidence.",
          ],
          output_contract: {
            required_app_files: requiredAppFiles,
            allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md", ".head-developer/VALIDATION.md"],
            expected_user_visible_output: [`User-visible ${item.title.toLowerCase()}`],
            validation_commands: validationCommands,
            acceptance_checks: acceptanceChecks,
            completion_criteria: [
              "Do not report complete if only .head-developer docs changed for app output.",
              "Report incomplete work honestly with command evidence.",
            ],
            docs_only_is_insufficient: requiredAppFiles.length > 0,
          },
        };
      }),
      dependency_graph: split.flatMap((item) => item.depends_on.map((dependency) => ({
        from: dependency,
        to: item.title,
        relationship: "blocks" as const,
      }))),
      risks: decision.risk_level === "low" ? [] : [decision.approval_reason || decision.reason],
      approval_needed: false,
    };
  }

  async createApprovedGraphAndStart(input: {
    session: SessionState;
    project: ProjectRecord;
    userGoal: string;
    decision: PlannerDecision;
    channel?: Channel | null;
  }) {
    const approvedPlan = this.approvedPlan(input.decision, input.channel);
    const fallback = taskComplexityJudge.evaluate({
      user_goal: input.userGoal,
      current_project: input.project,
      active_tasks: [],
      active_workers: [],
    });
    const complexity = this.decisionToComplexity(input.decision, fallback);
    const graph = multiWorkerCoordinator.createTaskGraph(input.project, input.userGoal, approvedPlan.worker_mode, {
      decision: complexity,
      planning: {
        requirement_summary: approvedPlan.requirements_summary,
        planning_decision_id: approvedPlan.planning_decision_id,
        planner_model: input.session.planner_model ?? this.model.modelName,
        planner_output: input.decision,
        approved_plan: approvedPlan,
        approval_status: "approved",
        open_questions: input.decision.open_questions,
        assumptions: input.decision.assumptions,
        design_decision_history: input.session.design_decision_history ?? [],
        user_approved_worker_count: approvedPlan.worker_count,
        user_approved_worker_mode: approvedPlan.worker_mode,
      },
    });
    const preparedProject = approvedPlan.worker_mode === "gke_job"
      ? getProject(input.project.project_id) ?? input.project
      : await multiWorkerCoordinator.prepareProject(input.project, graph);
    const started = await multiWorkerCoordinator.startReadyWork(graph.task_graph_id, approvedPlan.worker_mode, approvedPlan.worker_count);
    const latest = getSession(input.session.session_id) ?? input.session;
    latest.approved_plan = approvedPlan;
    latest.approval_status = "approved";
    latest.user_approved_worker_count = approvedPlan.worker_count;
    latest.user_approved_worker_mode = approvedPlan.worker_mode;
    latest.current_project_id = input.project.project_id;
    latest.project_id = latest.project_id ?? input.project.project_id;
    const first = started.assignments[0] ?? null;
    if (first) {
      latest.active_task_id = first.task.task_id;
      latest.active_worker_id = first.worker.worker_id;
      latest.current_status = "running";
      latest.status = "running";
      latest.latest_plan = first.task.plan;
    }
    latest.latest_codex_message = `Approved plan ${approvedPlan.planning_decision_id}. Created task graph ${graph.task_graph_id} and started ${started.assignments.length} worker assignment(s).`;
    latest.last_updated = new Date().toISOString();
    upsertSession(latest);
    upsertProject({
      ...preparedProject,
      approved_plan: approvedPlan,
      approval_status: "approved",
      user_approved_worker_count: approvedPlan.worker_count,
      user_approved_worker_mode: approvedPlan.worker_mode,
      updated_at: new Date().toISOString(),
    });
    appendOrchestratorEvent({
      scope: "planning",
      scope_id: approvedPlan.planning_decision_id,
      type: "planner.plan.approved",
      message: `Approved planner plan ${approvedPlan.planning_decision_id}.`,
      data: { session_id: latest.session_id, project_id: input.project.project_id, task_graph_id: graph.task_graph_id, approved_plan: approvedPlan },
    });
    appendOrchestratorEvent({
      scope: "planning",
      scope_id: approvedPlan.planning_decision_id,
      type: "planner.execution.started",
      message: `Started execution for approved plan ${approvedPlan.planning_decision_id}.`,
      data: { session_id: latest.session_id, task_graph_id: graph.task_graph_id, assignments: started.assignments },
    });
    return { graph: started.graph, project: preparedProject, assignments: started.assignments, approved_plan: approvedPlan, session: latest };
  }
}

export const agenticPlanningController = new AgenticPlanningController();
