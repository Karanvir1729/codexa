import { randomUUID } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { config } from "./config.js";
import { classifyApproval } from "./approval-firewall.js";
import { taskComplexityJudge } from "./task-complexity.js";
import { multiWorkerCoordinator } from "./multi-worker-coordinator.js";
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
import { vertexSupervisorConfigurationError } from "./model-provider.js";
import type {
  ApprovedPlanRecord,
  Channel,
  CommandRiskLevel,
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
    | "active_task"
    | "active_task_id"
    | "active_worker_id"
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
const workerModes: WorkerType[] = ["local", "docker_local", "gcp_vm", "gke_job"];
const riskLevels: CommandRiskLevel[] = ["low", "medium", "high", "blocked"];

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function textArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
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

function extractJsonObject(value: string) {
  const trimmed = value.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Planner response did not include a JSON object.");
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
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
  };
}

function normalized(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function includesAny(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

function requestedWorkerMode(textValue: string): WorkerType | null {
  const value = normalized(textValue);
  if (/\b(docker local|docker_local|local docker)\b/.test(value)) return "docker_local";
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

    const vagueGame = /\b(build|make|create)\b[\s\S]*\bgame\b/.test(value) && !/\b(platformer|puzzle|card|board|word|arcade|racing|shooter|quiz|snake|tetris|chess|memory)\b/.test(value);
    const vagueBuild = /^(build|make|create)\s+(an?\s+)?(app|website|site|tool|game)\.?$/.test(value);
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
        user_visible_response: `I will build this as a small static app, validate it, and keep the output contract grounded. Starting one ${mode} worker now.`,
        requirements_summary: input.user_message,
        open_questions: [],
        assumptions: ["Use static HTML/CSS/JS unless the existing repo clearly indicates another stack."],
        proposed_design: "One worker builds the requested page/app surface and runs local validation.",
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
        user_visible_response: `I recommend ${input.complexity.recommended_worker_count} workers for this: ${subtasks.map((item) => item.title).join(" | ")}. Approve this plan before I launch workers?`,
        requirements_summary: input.user_message,
        open_questions: [],
        assumptions: input.complexity.risks.length ? input.complexity.risks : [],
        proposed_design: "Use the existing task graph infrastructure with output contracts and validation gates.",
        proposed_task_split: subtasks,
        recommended_worker_count: input.complexity.recommended_worker_count,
        recommended_worker_mode: mode,
        requires_user_approval: true,
        approval_reason: "Multi-worker execution requires explicit approval of the task split.",
        risk_level: input.complexity.risks.length ? "medium" : "low",
        next_action: "none",
        execution_allowed: false,
      });
    }

    return decision({
      decision_type: "start_simple_task",
      confidence: 0.7,
      reason: "The request is concrete and can be handled by one worker.",
      user_visible_response: `I will run this as a one-worker implementation with validation and grounded progress updates. Starting one ${mode} worker now.`,
      requirements_summary: input.user_message,
      open_questions: [],
      assumptions: input.complexity.risks,
      proposed_design: "One worker executes the task with existing output-contract and summary enforcement.",
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

function vertexGenerateContentUrl(vertex: typeof config.vertex) {
  return `https://${encodeURIComponent(vertex.location)}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(vertex.projectId)}/locations/${encodeURIComponent(vertex.location)}/publishers/google/models/${encodeURIComponent(vertex.model)}:generateContent`;
}

function extractVertexText(response: unknown) {
  const candidates = (response as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> }).candidates ?? [];
  return candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function plannerPrompt(input: PlannerInput) {
  return [
    "You are an engineering lead planning controller for Codex Phone Supervisor.",
    "Decide the next orchestration move. Do not force every request through a fixed checklist.",
    "Ask clarification only when the implementation requirements are genuinely unclear.",
    "Simple concrete tasks may start with one worker. Multi-worker, GCP VM, GKE Job, deploy, secret, IAM, destructive, or public actions require approval.",
    "When approval is required, make user_visible_response conversational: confirm what you understood, state key assumptions or technical choices, summarize the task split and validation, then ask the user to approve or revise.",
    "Return only JSON matching the schema. Do not include raw JSON in user_visible_response.",
    "",
    `User message: ${input.user_message}`,
    `Session status: ${input.session.current_status}`,
    `Project: ${input.project?.display_name ?? "none"} ${input.project?.workspace_path ?? ""}`,
    `Worker mode: ${input.worker_mode}`,
    `Pending action: ${input.session.pending_action?.type ?? "none"}`,
    `Pending approvals: ${input.session.pending_approvals.filter((approval) => approval.status === "pending").map((approval) => `${approval.kind}: ${approval.command}`).join(" | ") || "none"}`,
    `Complexity judge: ${input.complexity.complexity}; workers=${input.complexity.recommended_worker_count}; split=${input.complexity.should_split}; reason=${input.complexity.reason}`,
    `Suggested subtasks: ${input.complexity.suggested_subtasks.map((item) => `${item.title} -> ${item.files_expected.join(", ")}`).join(" | ") || "none"}`,
    `Risk policy: ${input.risk_policy.requires_approval ? "approval required" : "no approval required"}; ${input.risk_policy.reason}; risk=${input.risk_policy.risk_level}`,
    `Current task graph: ${input.current_task_graph?.task_graph_id ?? "none"}`,
    `Validation/output-contract state: ${input.current_task_graph?.nodes.map((node) => `${node.title}:${node.status}:${node.validation_commands.join(",")}`).join(" | ") || "none"}`,
    `Recent conversation: ${input.session.recent_messages.map((message) => `${message.role}: ${message.text}`).slice(-8).join(" | ") || "none"}`,
    `Known constraints: ${input.known_constraints.join(" | ")}`,
  ].join("\n");
}

export class GcpGeminiPlannerModel implements PlannerModel {
  readonly modelName: string;

  constructor(private readonly vertex = config.vertex) {
    this.modelName = `vertex:${vertex.model || "gemini"}`;
  }

  async generatePlanningDecision(input: PlannerInput): Promise<PlannerDecision> {
    if (!this.vertex.projectId || !this.vertex.location || !this.vertex.model) {
      throw new Error("Vertex planner requires VERTEX_PROJECT_ID, VERTEX_LOCATION, and VERTEX_MODEL.");
    }
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) throw new Error("Google authentication did not return an access token.");
    const requestBody = (includeSchema: boolean) => ({
        systemInstruction: {
          parts: [{ text: "You are a model-driven agentic planning controller. Return only structured JSON." }],
        },
        contents: [{ role: "user", parts: [{ text: plannerPrompt(input) }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          ...(this.vertex.model.includes("2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          ...(includeSchema ? { responseSchema: plannerResponseSchema } : {}),
        },
      });
    const callVertexPlanner = async (includeSchema: boolean) => {
      const response = await fetch(vertexGenerateContentUrl(this.vertex), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody(includeSchema)),
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Vertex planner failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
      }
      return parsePlannerDecision(extractVertexText(JSON.parse(body)));
    };
    try {
      return await callVertexPlanner(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/Planner response did not include a JSON object|Planner decision/i.test(message)) throw error;
      return callVertexPlanner(false);
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
  if (config.supervisorModelProvider === "vertex") return new GcpGeminiPlannerModel();
  throw new Error(vertexSupervisorConfigurationError);
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
  return {
    ...decision,
    user_visible_response: `${decision.user_visible_response} Approve this plan before I launch workers?`,
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
      known_constraints: [
        "Do not print or request secrets.",
        "Do not change GCP IAM or secrets without explicit approval.",
        "Multi-worker execution requires approval of the split.",
        "GCP VM and GKE Job worker execution require approval before launch.",
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
      if (!config.testMode) throw new Error(vertexSupervisorConfigurationError);
      const fallback = new DeterministicFallbackPlannerModel();
      modelName = `${fallback.modelName}:after_invalid_${this.model.modelName}`;
      decision = parsePlannerDecision(await fallback.generatePlanningDecision(plannerInput));
      decision.reason = `Planner fallback used because ${error instanceof Error ? error.message : String(error)} ${decision.reason}`;
    }
    decision = normalizeUserVisibleApprovalPrompt(decision);
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
      suggested_subtasks: split.map((item) => ({
        title: item.title,
        goal: item.goal,
        dependencies: item.depends_on,
        outputs_expected: [`Completed ${item.title.toLowerCase()} with file and validation evidence.`],
        files_expected: item.expected_files,
        required_app_files: item.expected_files.filter((file) => !file.startsWith(".head-developer/")),
        allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md", ".head-developer/VALIDATION.md"],
        expected_user_visible_output: [`User-visible ${item.title.toLowerCase()}`],
        validation_commands: item.validation,
        acceptance_checks: [
          "Required files exist.",
          "Validation commands run or blocker is recorded.",
          "Worker handoff records changed files and validation.",
        ],
        completion_criteria: [
          "Do not report complete if only .head-developer docs changed for app output.",
          "Report incomplete work honestly with command evidence.",
        ],
        output_contract: {
          required_app_files: item.expected_files.filter((file) => !file.startsWith(".head-developer/")),
          allowed_doc_files: [".head-developer/WORKER_HANDOFFS.md", ".head-developer/VALIDATION.md"],
          expected_user_visible_output: [`User-visible ${item.title.toLowerCase()}`],
          validation_commands: item.validation,
          acceptance_checks: [
            "Required files exist.",
            "Validation commands run or blocker is recorded.",
            "Worker handoff records changed files and validation.",
          ],
          completion_criteria: [
            "Do not report complete if only .head-developer docs changed for app output.",
            "Report incomplete work honestly with command evidence.",
          ],
          docs_only_is_insufficient: item.expected_files.some((file) => !file.startsWith(".head-developer/")),
        },
      })),
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
