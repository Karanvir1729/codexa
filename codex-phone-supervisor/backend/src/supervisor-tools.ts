import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getCodexAccessSummary, gitDiffSummary } from "./access.js";
import { classifyApproval } from "./approval-firewall.js";
import { answerStateQuestion } from "./intent.js";
import { runCodexSession } from "./codex.js";
import { actionRouter, approveOperatorAction, rejectOperatorAction } from "./action-router.js";
import { createSupervisorModel, type DevelopmentTurnOutput, type SupervisorModelConfig, type SupervisorToolName } from "./model-provider.js";
import { resolveProjectIntake } from "./project-intake.js";
import {
  appendAuditEvent,
  appendOrchestratorEvent,
  getOrchestratorSettings,
  getRunSummary,
  getSession,
  getTask,
  getWorker,
  listCommandEvents,
  listTasks,
  listWorkers,
  updateOrchestratorSettings,
  upsertSession,
} from "./store.js";
import { voiceFriendlySummary } from "./summary.js";
import {
  cleanupExpiredWorkersViaMcp,
  inspectTaskStateViaMcp,
  inspectWorkerViaMcp,
  listGcpWorkersViaMcp,
} from "../../../packages/mcp-tools/src/index.js";
import { runProjectSelection } from "./project-selector.js";
import {
  attachSessionToProject,
  findProjectByWorkspace,
  getProject,
  ensureNewProjectDirectory,
  newProjectPathForName,
  projectRecordForWorkspace,
  refreshProjectsFromConfiguredRoots,
  upsertProject,
} from "./project-store.js";
import { writeSupervisorProjectMarker } from "./project-ownership.js";
import { ensureGitHubRepositoryForProject, ensureLocalGitRepository, type GitHubRepoProvisionResult } from "./github-repo.js";
import { slugifyProjectName } from "./project-naming.js";
import { cloudOrchestrator } from "./cloud-orchestrator.js";
import { multiWorkerCoordinator } from "./multi-worker-coordinator.js";
import { LOCAL_CODEX_BACKEND, startLocalCodexSession } from "./codex-session-local.js";
import { agenticPlanningController, parsePlannerDecision } from "./agentic-planning.js";
import { answerPreviewQuestion, isPreviewQuestion, isPreviewRequest, previewChatResponse, startPreviewForSession } from "./preview.js";
import { writeMegaplan, type MegaplanRecord } from "./megaplan.js";
import { mirrorBrowserConversationTurn } from "./codex-conversation-mirror.js";
import { withSubagentAdvice } from "./subagent-advisor.js";
import type { Channel, PendingAction, PlannerDecision, SessionState, SupervisorEvent, SupervisorModelProvider, WorkerType } from "./types.js";

export function list_projects() {
  return { projects: refreshProjectsFromConfiguredRoots() };
}

export function select_project(projectId: string, sessionId: string) {
  return attachSessionToProject(sessionId, projectId);
}

export function get_codex_status(sessionId?: string) {
  if (!sessionId) return { error: "session_id is required", code: "SESSION_ID_REQUIRED" };
  const session = getSession(sessionId);
  return session ? { session } : { error: "Session not found.", code: "SESSION_NOT_FOUND" };
}

export function get_codex_events(sessionId: string) {
  const session = getSession(sessionId);
  return session ? { session_id: session.session_id, events: session.raw_events } : { error: "Session not found.", code: "SESSION_NOT_FOUND" };
}

export function get_codex_summary(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) return { error: "Session not found.", code: "SESSION_NOT_FOUND" };
  return {
    session_id: session.session_id,
    summary: session.summary_text || session.latest_codex_message,
    files_modified: session.files_modified,
    commands_completed: session.commands_completed,
    commands_failed: session.commands_failed,
    pending_approvals: session.pending_approvals.filter((item) => item.status === "pending"),
    errors: session.errors,
    project_discovery: session.project_discovery,
    access_summary: getCodexAccessSummary(session.workspace_path),
  };
}

export function get_codex_access_summary(sessionId?: string) {
  const session = sessionId ? getSession(sessionId) : null;
  return getCodexAccessSummary(session?.workspace_path);
}

export function get_access_summary(projectId: string) {
  const project = getProject(projectId);
  if (!project) return { error: "Project not found." };
  return getCodexAccessSummary(project.workspace_path);
}

export function get_git_diff_summary(projectId: string) {
  const project = getProject(projectId);
  if (!project) return { error: "Project not found." };
  return { project_id: projectId, git_diff_summary: gitDiffSummary(project.workspace_path, []) };
}

export function get_pending_approval(projectId: string, sessionId?: string) {
  const project = getProject(projectId);
  if (!project) return { error: "Project not found." };
  const targetSessionId = sessionId || project.last_active_session_id;
  if (!targetSessionId) return { pending_approval: null };
  const session = getSession(targetSessionId);
  if (!session) return { error: "Session not found.", code: "SESSION_NOT_FOUND" };
  return { pending_approval: session.pending_approvals.find((approval) => approval.status === "pending") ?? null };
}

export function send_codex_instruction(sessionId: string, instruction: string) {
  const session = getSession(sessionId);
  if (!session) return { error: "Session not found.", code: "SESSION_NOT_FOUND" };
  if (session.project_discovery.status !== "selected") {
    return { error: "Select a project before sending coding instructions to Codex." };
  }
  const cleaned = instruction.trim();
  if (!cleaned) return { error: "Missing instruction." };
  const activeWorker = session.active_worker_id ? getWorker(session.active_worker_id) : null;
  if (activeWorker && (activeWorker.type === "gcp_vm" || activeWorker.type === "gke_job")) {
    return {
      error: `The active task is running on a ${activeWorker.type} worker. Revise the pending plan or wait for the worker result; the Cloud Run control plane will not run local Codex instructions for cloud workers.`,
      code: "CONTROL_PLANE_CODEX_DISABLED_FOR_CLOUD_WORKER",
    };
  }

  const approval = classifyApproval(cleaned);
  if (approval.requiresApproval) {
    const requestedAt = new Date().toISOString();
    const pending = {
      id: randomUUID(),
      kind: approval.kind!,
      command: cleaned,
      reason: approval.reason!,
      risk: approval.risk!,
      status: "pending" as const,
      requested_at: requestedAt,
      project_id: session.project_id ?? undefined,
      session_id: session.session_id,
    };
    session.pending_approvals.push(pending);
    session.current_status = "waiting_for_approval";
    session.status = "waiting_for_approval";
    session.last_updated = requestedAt;
    upsertSession(session);
    appendAuditEvent({
      session_id: sessionId,
      ts: requestedAt,
      source: "approval",
      type: "approval.requested",
      message: `${pending.kind}: ${pending.command}`,
      data: pending,
    });
    appendOrchestratorEvent({
      scope: "approval",
      scope_id: pending.id,
      type: "approval.requested",
      message: `${pending.kind}: ${pending.command}`,
      data: pending,
    });
    return { session_id: sessionId, status: "waiting_for_approval", approval_id: pending.id };
  }

  appendAuditEvent({
    session_id: sessionId,
    ts: new Date().toISOString(),
    source: "user",
    type: "codex.instruct",
    message: cleaned,
  });

  void runCodexSession(sessionId, cleaned).catch((error) => {
    const failed = getSession(sessionId);
    if (!failed) return;
    failed.current_status = "failed";
    failed.status = "failed";
    failed.errors.push(error instanceof Error ? error.message : String(error));
    upsertSession(failed);
  });

  return { session_id: sessionId, status: "running" };
}

function displayNameFromSlug(slug: string) {
  return slug.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nearestExistingAncestor(candidate: string) {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing parent directory found for requested workspace: ${candidate}`);
    current = parent;
  }
  if (!fs.statSync(current).isDirectory()) {
    throw new Error(`Requested workspace parent is not a directory: ${current}`);
  }
  return current;
}

function resolveRequestedProjectWorkspacePath(rawWorkspacePath: string) {
  const raw = rawWorkspacePath.trim();
  if (!raw) throw new Error("Requested workspace path is empty.");
  const requested = path.resolve(path.isAbsolute(raw) ? raw : path.join(config.defaultWorkspacePath, raw));
  const ancestor = nearestExistingAncestor(requested);
  const realAncestor = fs.realpathSync(ancestor);
  const resolved = path.resolve(realAncestor, path.relative(ancestor, requested));
  const allowedRoots = [...new Set([config.defaultWorkspacePath, ...config.projectRoots].map((root) => fs.realpathSync(root)))];
  const allowed = allowedRoots.some((root) => isWithinDirectory(resolved, root));
  if (!allowed) {
    throw new Error(`Requested workspace path must stay inside an allowed project root: ${allowedRoots.join(", ")}`);
  }
  return resolved;
}

function ensureWorkspaceDirectory(workspacePath: string) {
  if (fs.existsSync(workspacePath)) {
    if (!fs.statSync(workspacePath).isDirectory()) {
      throw new Error(`Requested workspace exists and is not a directory: ${workspacePath}`);
    }
  } else {
    fs.mkdirSync(workspacePath, { recursive: true });
  }
  return fs.realpathSync(workspacePath);
}

function githubProvisionMessage(result: GitHubRepoProvisionResult | null) {
  if (!result) return "";
  if (result.status === "created" || result.status === "attached" || result.status === "existing_remote") {
    return result.url ? `GitHub repo: ${result.url}.` : "";
  }
  if (result.status === "failed") {
    return `GitHub repo creation did not complete: ${result.error}`;
  }
  return "";
}

function recordGitHubProvision(project: ReturnType<typeof projectRecordForWorkspace>, result: GitHubRepoProvisionResult) {
  project.github_repo_url = result.url;
  project.github_repo_full_name = result.full_name;
  project.github_repo_created = result.status === "created";
  project.github_repo_error = result.status === "failed" ? result.error : null;
  appendOrchestratorEvent({
    scope: "project",
    scope_id: project.project_id,
    type: result.status === "failed"
      ? "github.repo.failed"
      : result.status === "skipped"
        ? "github.repo.skipped"
        : "github.repo.ready",
    message: result.status === "failed"
      ? `GitHub repo creation failed for ${project.display_name}.`
      : result.status === "skipped"
        ? `GitHub repo creation skipped for ${project.display_name}.`
        : `GitHub repo ready for ${project.display_name}.`,
    data: { project_id: project.project_id, workspace_path: project.workspace_path, github: result },
  });
}

function initializeNewProjectRepository(input: {
  session: SessionState;
  workspacePath: string;
  displayName: string;
  slug: string;
  description: string;
}) {
  const git = ensureLocalGitRepository(input.workspacePath);
  const project = projectRecordForWorkspace(input.workspacePath);
  project.display_name = input.displayName;
  project.last_active_session_id = input.session.session_id;
  project.created_by_codex_supervisor = true;
  project.created_by_session_id = input.session.session_id;
  project.created_by_supervisor_at ??= new Date().toISOString();
  writeSupervisorProjectMarker({
    workspacePath: input.workspacePath,
    projectId: project.project_id,
    sessionId: input.session.session_id,
    createdAt: project.created_by_supervisor_at,
  });
  const github = ensureGitHubRepositoryForProject({
    project,
    slug: input.slug,
    description: input.description,
  });
  const refreshed = projectRecordForWorkspace(input.workspacePath, project);
  refreshed.display_name = input.displayName;
  refreshed.last_active_session_id = input.session.session_id;
  recordGitHubProvision(refreshed, github);
  upsertProject(refreshed);
  return { project: refreshed, gitInitialized: git.initialized, github };
}

function describeNewProjectResult(result: Awaited<ReturnType<typeof create_project>>) {
  if ("error" in result) return `Could not create the new project: ${result.error}`;
  const message = "message" in result ? result.message : undefined;
  if (result.status === "waiting_for_approval" && message) {
    return message;
  }
  if (result.status === "idle" && message) {
    return message;
  }
  if ("task_graph_id" in result && result.task_graph_id && result.status === "waiting_for_approval") {
    return message ?? `This is a multi-part project. I prepared task graph ${result.task_graph_id}; approve the split to start workers.`;
  }
  if ("task_graph_id" in result && result.task_graph_id && message) {
    return message;
  }
  if ("task_graph_id" in result && result.task_graph_id && Array.isArray(result.task_ids) && result.task_ids.length > 1) {
    return message ?? `Started task graph ${result.task_graph_id} with ${result.task_ids.length} subtasks through ${result.worker_type} worker mode.`;
  }
  if ("task_id" in result && result.task_id) {
    if (result.worker_type === LOCAL_CODEX_BACKEND) {
      return `Creating ${result.project_name} at ${result.target_path}. Task ${result.task_id} is running in one local Codex CLI orchestrator session.`;
    }
    return `Creating ${result.project_name} at ${result.target_path}. Task ${result.task_id} is assigned through ${result.worker_type} worker mode.`;
  }
  return `Creating ${result.project_name} at ${result.target_path}. Codex CLI is running from the configured project root: ${config.newProjectsRoot}.`;
}

function taskSplitMessage(graph: import("./types.js").TaskGraphRecord, workerMode: WorkerType) {
  if (workerMode === LOCAL_CODEX_BACKEND) {
    return [
      `This is a ${graph.complexity.complexity} project, so I prepared a local implementation plan.`,
      "Execution: one local Codex CLI orchestrator session in this repo.",
      "Codex will choose how many logical internal subagents to use and report their responsibilities, files, and validation.",
      `Responsibility areas: ${graph.nodes.map((node) => node.title).join(" | ")}.`,
      "Approve this plan to start the local Codex session.",
    ].join(" ");
  }
  const parallel = graph.execution_strategy === "parallel_worktrees"
    ? `I can start up to ${Math.min(graph.recommended_worker_count, config.orchestrator.maxParallelWorkers)} Docker workers in isolated worktrees.`
    : "I will run conflicting or dependent work sequentially.";
  return [
    `This is a ${graph.complexity.complexity} project, so I split it into ${graph.nodes.length} subtasks.`,
    `Strategy: ${graph.execution_strategy}. ${parallel}`,
    `Worker mode: ${workerMode}.`,
    `Subtasks: ${graph.nodes.map((node) => node.title).join(" | ")}.`,
    "Approve this task split to start the workers.",
  ].join(" ");
}

function plannerTaskSplitMessage(decision: PlannerDecision) {
  const split = decision.proposed_task_split.map((item, index) => {
    const dependencyText = item.depends_on.length ? ` after ${item.depends_on.join(", ")}` : "";
    const parallelText = item.can_run_parallel ? "parallel" : "sequential";
    const outputText = item.expected_files.length ? `Expected outputs: ${item.expected_files.join(", ")}` : "Expected outputs: output contract files";
    const validationText = item.validation.length ? `Validation: ${item.validation.join(", ")}` : "Validation: output-contract checks";
    return `${index + 1}. ${item.title} (${parallelText}${dependencyText}) - ${item.goal} ${outputText}. ${validationText}.`;
  });
  const assumptions = decision.assumptions.length
    ? `Assumptions: ${decision.assumptions.join(" ")}`
    : "Assumptions: I will keep the implementation scoped to the approved request and avoid unrelated features.";
  return [
    decision.requirements_summary ? `Before I start, here is what I understand: ${decision.requirements_summary}` : "Before I start, I want to confirm the plan.",
    decision.proposed_design ? `Technical direction: ${decision.proposed_design}` : "",
    assumptions,
    decision.recommended_worker_mode === LOCAL_CODEX_BACKEND
      ? "Execution plan: one local Codex CLI orchestrator session. Codex will choose how many logical internal subagents to use."
      : `Worker plan: ${decision.recommended_worker_count} ${decision.recommended_worker_mode} worker${decision.recommended_worker_count === 1 ? "" : "s"}.`,
    split.length ? `Task split: ${split.join(" ")}` : "",
    decision.approval_reason || "I need your approval before I launch workers.",
    "Does this match what you want? Reply `approve` to start, or tell me what to change.",
  ].filter(Boolean).join(" ");
}

function firstAssignment(result: { assignments: Awaited<ReturnType<typeof multiWorkerCoordinator.createAndMaybeStart>>["assignments"] }) {
  return result.assignments[0] ?? null;
}

function localCodexApprovalMessage(decision: PlannerDecision, megaplan?: MegaplanRecord | null, project?: ReturnType<typeof projectRecordForWorkspace> | null) {
  const split = decision.proposed_task_split.map((item, index) => {
    const validation = item.validation.length ? ` Validation: ${item.validation.join(", ")}.` : "";
    return `${index + 1}. ${item.title}: ${item.goal}.${validation}`;
  });
  const design = /\b(worker|workers|task graph|output-contract|output contract|worktree|GKE|GCP VM|Docker)\b/i.test(decision.proposed_design)
    ? "One local Codex CLI session will own the repo. Codex may use logical internal subagents and local validation inside that session."
    : decision.proposed_design;
  const approvalReason = /multi-worker|workers launch|launch workers/i.test(decision.approval_reason)
    ? "Because this is complex work, I need your approval before I start the single local Codex CLI orchestrator session."
    : decision.approval_reason;
  const subagentAdvice = decision.subagent_advice
    ? [
      `Subagent check-in: ${decision.subagent_advice.user_check_in}`,
      decision.subagent_advice.suggested_responsibilities.length
        ? `Useful responsibility areas: ${decision.subagent_advice.suggested_responsibilities.join(", ")}.`
        : "",
    ].filter(Boolean).join(" ")
    : "";
  return [
    decision.requirements_summary ? `Before I start, here is what I understand: ${decision.requirements_summary}` : "Before I start, I want to confirm the plan.",
    design ? `Technical direction: ${design}` : "",
    "You will talk directly to Codex as the local CLI orchestrator for this repo.",
    "I will build this locally in one repo using one local Codex CLI orchestrator session.",
    githubProvisionMessage(project?.github_repo_error
      ? { status: "failed", url: null, full_name: null, reason: "GitHub repo creation failed.", error: project.github_repo_error }
      : project?.github_repo_url
        ? { status: project.github_repo_created ? "created" : "existing_remote", url: project.github_repo_url, full_name: project.github_repo_full_name ?? null, reason: "GitHub repo ready." }
        : null),
    megaplan ? `The Megaplan skill created MEGAPLAN.md for ${megaplan.repo.name} on branch ${megaplan.repo.branch ?? "unknown"}.` : "",
    "Codex will choose how many logical internal subagents to create and will report the actual subagent breakdown after implementation.",
    subagentAdvice,
    split.length ? `Proposed responsibility areas: ${split.join(" ")}` : "",
    approvalReason || "Because this is complex work, I need your approval before I start the local Codex orchestrator session.",
    "Reply `approve` to start, or tell me what to change.",
  ].filter(Boolean).join(" ");
}

function queueLocalMegaplanApproval(input: {
  session: SessionState;
  project: ReturnType<typeof projectRecordForWorkspace>;
  userGoal: string;
  decision: PlannerDecision;
  selectedExistingProject?: boolean;
}) {
  const latest = getSession(input.session.session_id) ?? input.session;
  const advisedDecision = withSubagentAdvice({
    session: latest,
    project: input.project,
    userGoal: input.userGoal,
    decision: {
      ...input.decision,
      recommended_worker_mode: LOCAL_CODEX_BACKEND,
      recommended_worker_count: 1,
    },
  });
  const decision: PlannerDecision = {
    ...advisedDecision,
    recommended_worker_mode: LOCAL_CODEX_BACKEND,
    recommended_worker_count: 1,
    requires_user_approval: true,
    execution_allowed: false,
    next_action: "none",
    approval_reason: input.decision.approval_reason || "The Megaplan must be approved before Codex starts implementation.",
  };
  const megaplan = writeMegaplan({
    session: latest,
    project: input.project,
    userGoal: input.userGoal,
    decision,
  });
  const response = localCodexApprovalMessage(decision, megaplan, input.project);
  setPendingAction(latest, {
    type: "approve_megaplan",
    original_user_goal: input.userGoal,
    requested_kind: "app",
    description: input.userGoal,
    action: "approve_megaplan",
    reason: decision.approval_reason || decision.reason,
    risk_level: decision.risk_level,
    worker_mode: LOCAL_CODEX_BACKEND,
    target_project_id: input.project.project_id,
    planning_decision_id: decision.planning_decision_id,
    proposed_plan: decision,
    user_approved_worker_count: 1,
    user_approved_worker_mode: LOCAL_CODEX_BACKEND,
    created_at: new Date().toISOString(),
  });
  latest.current_status = "waiting_for_approval";
  latest.status = "waiting_for_approval";
  latest.approval_status = "pending";
  latest.requirement_summary = decision.requirements_summary;
  latest.planning_decision_id = decision.planning_decision_id ?? latest.planning_decision_id;
  latest.planner_output = decision;
  latest.latest_codex_message = response;
  latest.latest_plan = decision.proposed_task_split.map((item) => item.goal);
  latest.latest_summary = decision.requirements_summary;
  latest.current_project_id = input.project.project_id;
  latest.project_id = input.project.project_id;
  latest.last_updated = new Date().toISOString();
  upsertSession(latest);
  upsertProject({
    ...input.project,
    requirement_summary: decision.requirements_summary,
    planning_decision_id: decision.planning_decision_id,
    planner_output: decision,
    approval_status: "pending",
    open_questions: decision.open_questions,
    assumptions: decision.assumptions,
    last_active_session_id: latest.session_id,
    updated_at: new Date().toISOString(),
  });
  appendOrchestratorEvent({
    scope: "planning",
    scope_id: decision.planning_decision_id ?? latest.session_id,
    type: "megaplan.approval.requested",
    message: response,
    data: { session_id: latest.session_id, project_id: input.project.project_id, decision, pending_action: latest.pending_action, megaplan },
  });
  return {
    session_id: latest.session_id,
    status: "waiting_for_approval" as const,
    message: response,
    project_name: input.project.display_name,
    target_path: input.project.workspace_path,
    project_id: input.project.project_id,
    task_graph_id: null,
    task_ids: [],
    worker_ids: [],
    worker_type: LOCAL_CODEX_BACKEND,
    selected_existing_project: input.selectedExistingProject,
    planning_decision_id: decision.planning_decision_id,
    megaplan,
  };
}

async function startWorkerBackedProject(input: {
  session: SessionState;
  project: ReturnType<typeof projectRecordForWorkspace>;
  displayName: string;
  targetPath: string;
  description: string;
  workerType: WorkerType;
  selectedExistingProject?: boolean;
}) {
  const { session, project, displayName, targetPath, description, workerType } = input;
  const planning = await agenticPlanningController.decide({
    session,
    userMessage: description,
    project,
    workerMode: workerType,
  });
  const decision = planning.decision;
  const useLocalCodexSession = workerType === LOCAL_CODEX_BACKEND || decision.recommended_worker_mode === LOCAL_CODEX_BACKEND;

  if (
    decision.decision_type === "ask_clarification" ||
    decision.decision_type === "wait_for_user" ||
    decision.decision_type === "explain_blocker" ||
    decision.decision_type === "answer_status_question"
  ) {
    const latest = getSession(session.session_id) ?? session;
    if (decision.decision_type === "ask_clarification") {
      setPendingAction(latest, {
        type: "clarify_requirements",
        original_user_goal: description,
        requested_kind: "app",
        description,
        reason: decision.reason,
        worker_mode: useLocalCodexSession ? LOCAL_CODEX_BACKEND : decision.recommended_worker_mode,
        target_project_id: project.project_id,
        planning_decision_id: decision.planning_decision_id,
        proposed_plan: decision,
        created_at: new Date().toISOString(),
      });
    }
    latest.current_status = decision.decision_type === "ask_clarification" ? "idle" : latest.current_status;
    latest.status = latest.current_status;
    latest.latest_codex_message = decision.user_visible_response;
    latest.open_questions = decision.open_questions;
    latest.assumptions = decision.assumptions;
    latest.last_updated = new Date().toISOString();
    upsertSession(latest);
    return {
      session_id: latest.session_id,
      status: latest.current_status,
      message: decision.user_visible_response,
      project_name: displayName,
      target_path: targetPath,
      project_id: project.project_id,
      task_graph_id: null,
      task_ids: [],
      worker_ids: [],
      worker_type: workerType,
      selected_existing_project: input.selectedExistingProject,
      planning_decision_id: decision.planning_decision_id,
    };
  }

  if (
    decision.requires_user_approval ||
    decision.decision_type === "propose_task_split" ||
    decision.decision_type === "request_user_approval" ||
    decision.decision_type === "request_risky_action_approval"
  ) {
    const latest = getSession(session.session_id) ?? session;
    if (useLocalCodexSession) {
      return queueLocalMegaplanApproval({
        session: latest,
        project,
        userGoal: description,
        decision: { ...decision, recommended_worker_mode: LOCAL_CODEX_BACKEND },
        selectedExistingProject: input.selectedExistingProject,
      });
    }
    const response = decision.proposed_task_split.length > 1
      ? plannerTaskSplitMessage(decision)
      : decision.user_visible_response;
    setPendingAction(latest, {
      type: !useLocalCodexSession && decision.decision_type === "request_risky_action_approval" ? "approve_gcp_action" : "approve_task_split",
      original_user_goal: description,
      requested_kind: "app",
      description,
      action: decision.decision_type === "request_risky_action_approval" ? description : "approve_planner_task_split",
      reason: decision.approval_reason || decision.reason,
      risk_level: decision.risk_level,
      worker_mode: useLocalCodexSession ? LOCAL_CODEX_BACKEND : decision.recommended_worker_mode,
      target_project_id: project.project_id,
      planning_decision_id: decision.planning_decision_id,
      proposed_plan: useLocalCodexSession ? { ...decision, recommended_worker_mode: LOCAL_CODEX_BACKEND } : decision,
      user_approved_worker_count: null,
      user_approved_worker_mode: null,
      created_at: new Date().toISOString(),
    });
    latest.current_status = "waiting_for_approval";
    latest.status = "waiting_for_approval";
    latest.approval_status = "pending";
    latest.latest_codex_message = response;
    latest.latest_plan = decision.proposed_task_split.map((item) => item.goal);
    latest.latest_summary = decision.requirements_summary;
    latest.last_updated = new Date().toISOString();
    upsertSession(latest);
    appendOrchestratorEvent({
      scope: "planning",
      scope_id: decision.planning_decision_id ?? latest.session_id,
      type: "planner.approval.requested",
      message: response,
      data: { session_id: latest.session_id, project_id: project.project_id, decision, pending_action: latest.pending_action },
    });
    return {
      session_id: latest.session_id,
      status: "waiting_for_approval" as const,
      message: response,
      project_name: displayName,
      target_path: targetPath,
      project_id: project.project_id,
      task_graph_id: null,
      task_ids: [],
      worker_ids: [],
      worker_type: useLocalCodexSession ? LOCAL_CODEX_BACKEND : decision.recommended_worker_mode,
      selected_existing_project: input.selectedExistingProject,
      planning_decision_id: decision.planning_decision_id,
    };
  }

  if (decision.execution_allowed && (decision.next_action === "launch_workers" || decision.next_action === "create_task_graph")) {
    if (useLocalCodexSession) {
      return queueLocalMegaplanApproval({
        session,
        project,
        userGoal: description,
        decision: { ...decision, recommended_worker_mode: LOCAL_CODEX_BACKEND },
        selectedExistingProject: input.selectedExistingProject,
      });
    }
    const started = await agenticPlanningController.createApprovedGraphAndStart({
      session: getSession(session.session_id) ?? session,
      project,
      userGoal: description,
      decision,
      channel: session.channel ?? null,
    });
    const assignment = firstAssignment(started);
    const response = assignment
      ? `${decision.user_visible_response} Task graph ${started.graph.task_graph_id} created; worker ${assignment.worker.worker_id} is running ${assignment.node.title}.`
      : `${decision.user_visible_response} Task graph ${started.graph.task_graph_id} was created; no worker assignment started yet.`;
    return {
      session_id: session.session_id,
      status: assignment ? "running" as const : "queued" as const,
      message: response,
      project_name: displayName,
      target_path: targetPath,
      project_id: project.project_id,
      task_id: assignment?.task.task_id,
      worker_id: assignment?.worker.worker_id,
      task_graph_id: started.graph.task_graph_id,
      task_ids: started.graph.nodes.map((node) => node.task_id),
      worker_ids: started.assignments.map((item) => item.worker.worker_id),
      worker_type: decision.recommended_worker_mode,
      selected_existing_project: input.selectedExistingProject,
      planning_decision_id: decision.planning_decision_id,
    };
  }

  if (workerType !== "local" && workerType !== LOCAL_CODEX_BACKEND) {
    const latest = getSession(session.session_id) ?? session;
    const approvalReason = decision.approval_reason || `${workerModeLabel(workerType)} worker execution requires approval before launch.`;
    const response = decision.proposed_task_split.length
      ? plannerTaskSplitMessage({
          ...decision,
          requires_user_approval: true,
          approval_reason: approvalReason,
          recommended_worker_mode: decision.recommended_worker_mode || workerType,
        })
      : `${decision.user_visible_response} ${approvalReason} Reply \`approve\` to start, or tell me what to change.`;
    setPendingAction(latest, {
      type: "approve_task_split",
      original_user_goal: description,
      requested_kind: "app",
      description,
      action: "approve_planner_task_split",
      reason: approvalReason,
      risk_level: decision.risk_level,
      worker_mode: decision.recommended_worker_mode || workerType,
      target_project_id: project.project_id,
      planning_decision_id: decision.planning_decision_id,
      proposed_plan: {
        ...decision,
        requires_user_approval: true,
        approval_reason: approvalReason,
        execution_allowed: false,
        next_action: "none",
      },
      user_approved_worker_count: null,
      user_approved_worker_mode: null,
      created_at: new Date().toISOString(),
    });
    latest.current_status = "waiting_for_approval";
    latest.status = "waiting_for_approval";
    latest.approval_status = "pending";
    latest.latest_codex_message = response;
    latest.latest_plan = decision.proposed_task_split.map((item) => item.goal);
    latest.latest_summary = decision.requirements_summary;
    latest.last_updated = new Date().toISOString();
    upsertSession(latest);
    appendOrchestratorEvent({
      scope: "planning",
      scope_id: decision.planning_decision_id ?? latest.session_id,
      type: "planner.approval.requested",
      message: response,
      data: { session_id: latest.session_id, project_id: project.project_id, decision, pending_action: latest.pending_action },
    });
    return {
      session_id: latest.session_id,
      status: "waiting_for_approval" as const,
      message: response,
      project_name: displayName,
      target_path: targetPath,
      project_id: project.project_id,
      task_graph_id: null,
      task_ids: [],
      worker_ids: [],
      worker_type: decision.recommended_worker_mode || workerType,
      selected_existing_project: input.selectedExistingProject,
      planning_decision_id: decision.planning_decision_id,
    };
  }

  if (useLocalCodexSession) {
    return queueLocalMegaplanApproval({
      session,
      project,
      userGoal: description,
      decision: { ...decision, recommended_worker_mode: LOCAL_CODEX_BACKEND },
      selectedExistingProject: input.selectedExistingProject,
    });
  }

  const result = await multiWorkerCoordinator.createAndMaybeStart(project, description, workerType, { autoStart: true });
  const assignment = firstAssignment(result);
  const taskIds = result.graph.nodes.map((node) => node.task_id);
  const workerIds = result.assignments.map((item) => item.worker.worker_id);

  if (!assignment && result.graph.status === "proposed") {
    const message = taskSplitMessage(result.graph, workerType);
    setPendingAction(session, {
      type: "approve_task_split",
      original_user_goal: description,
      requested_kind: "app",
      description,
      worker_mode: workerType,
      target_project_id: project.project_id,
      target_task_graph_id: result.graph.task_graph_id,
      created_at: new Date().toISOString(),
    });
    session.current_status = "waiting_for_approval";
    session.status = "waiting_for_approval";
    session.latest_codex_message = message;
    session.latest_plan = result.graph.nodes.map((node) => node.goal);
    session.latest_summary = result.graph.complexity.reason;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
    return {
      session_id: session.session_id,
      status: "waiting_for_approval" as const,
      message,
      project_name: displayName,
      target_path: targetPath,
      project_id: project.project_id,
      task_graph_id: result.graph.task_graph_id,
      task_ids: taskIds,
      worker_ids: workerIds,
      worker_type: workerType,
      selected_existing_project: input.selectedExistingProject,
    };
  }

  if (assignment) {
    session.active_task_id = assignment.task.task_id;
    session.active_worker_id = assignment.worker.worker_id;
    session.current_status = "running";
    session.status = "running";
    session.latest_plan = assignment.task.plan;
    session.latest_summary = assignment.task.latest_summary;
    session.latest_codex_message = result.graph.nodes.length > 1
      ? `Started task graph ${result.graph.task_graph_id}. First worker ${assignment.worker.worker_id} is running ${assignment.node.title}.`
      : `Started task ${assignment.task.task_id} on ${assignment.worker.type} worker ${assignment.worker.worker_id}.`;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
  }

  return {
    session_id: session.session_id,
    status: assignment ? "running" as const : "queued" as const,
    message: assignment
      ? session.latest_codex_message
      : `Created task graph ${result.graph.task_graph_id}; no ready worker assignment was started yet.`,
    project_name: displayName,
    target_path: targetPath,
    project_id: project.project_id,
    task_id: assignment?.task.task_id,
    worker_id: assignment?.worker.worker_id,
    task_graph_id: result.graph.task_graph_id,
    task_ids: taskIds,
    worker_ids: workerIds,
    worker_type: workerType,
    selected_existing_project: input.selectedExistingProject,
  };
}

export async function create_project(
  sessionId: string,
  projectName: string,
  description: string,
  options: { workspacePath?: string | null } = {},
) {
  const session = getSession(sessionId);
  if (!session) return { error: "Session not found.", code: "SESSION_NOT_FOUND" };
  const cleanedName = projectName.trim();
  const cleanedDescription = description.trim();
  if (!cleanedName) return { error: "Missing project name." };
  if (!cleanedDescription) return { error: "Missing project description." };

  let requestedWorkspacePath: string | null = null;
  try {
    requestedWorkspacePath = options.workspacePath ? resolveRequestedProjectWorkspacePath(options.workspacePath) : null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), code: "INVALID_WORKSPACE_PATH" };
  }
  const generatedTarget = requestedWorkspacePath ? null : newProjectPathForName(cleanedName);
  const slug = requestedWorkspacePath ? slugifyProjectName(path.basename(requestedWorkspacePath) || cleanedName) : generatedTarget!.slug;
  const target = requestedWorkspacePath ?? generatedTarget!.target;
  const displayName = displayNameFromSlug(slug);
  const now = new Date().toISOString();
  const selectedWorkerType = session.preferred_worker_mode ?? getOrchestratorSettings().default_worker_mode;
  const requestedWorkspace = Boolean(requestedWorkspacePath);

  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    let gitInitialized = false;
    if (requestedWorkspacePath) {
      try {
        gitInitialized = ensureLocalGitRepository(target).initialized;
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), code: "WORKSPACE_CREATE_FAILED" };
      }
    }
    const existingProject = findProjectByWorkspace(target) ?? projectRecordForWorkspace(target);
    existingProject.display_name = existingProject.display_name || displayName;
    existingProject.last_active_session_id = session.session_id;
    upsertProject(existingProject);

    session.workspace_path = existingProject.workspace_path;
    session.project_id = existingProject.project_id;
    session.current_project_id = existingProject.project_id;
    session.pending_action = null;
    session.pending_action_payload = null;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = existingProject.workspace_path;
    session.project_discovery.selected_project_name = existingProject.display_name;
    session.project_discovery.confidence = "high";
    session.project_discovery.reason = requestedWorkspace
      ? "Selected the explicit workspace path requested by the user."
      : "Selected existing project workspace for a repeated project request.";
    session.project_discovery.last_question = "";
    session.active_task = cleanedDescription;
    session.latest_codex_message = `Selected existing ${existingProject.display_name} at ${existingProject.workspace_path}.`;
    session.last_updated = now;
    pushSessionEvent(session, {
      ts: now,
      source: "system",
      type: "project.selected",
      message: `Selected ${existingProject.display_name} at ${existingProject.workspace_path}`,
      data: {
        display_name: existingProject.display_name,
        slug,
        target_path: existingProject.workspace_path,
        requested_workspace_path: requestedWorkspacePath,
        git_initialized: gitInitialized,
        worker_type: selectedWorkerType,
      },
    });
    upsertSession(session);

    appendOrchestratorEvent({
      scope: "project",
      scope_id: existingProject.project_id,
      type: "project.selected",
      message: `Selected project ${existingProject.display_name}.`,
      data: { project: existingProject, session_id: session.session_id },
    });

    if (selectedWorkerType !== "local") {
      return await startWorkerBackedProject({
        session,
        project: existingProject,
        displayName: existingProject.display_name,
        targetPath: existingProject.workspace_path,
        description: cleanedDescription,
        workerType: selectedWorkerType,
        selectedExistingProject: true,
      });
    }

    const task = cloudOrchestrator.createTask(existingProject.project_id, cleanedDescription);
    session.active_task_id = task.task_id;
    session.latest_plan = task.plan;
    session.latest_summary = task.latest_summary;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
    return {
      session_id: sessionId,
      status: "running" as const,
      project_name: existingProject.display_name,
      target_path: existingProject.workspace_path,
      project_id: existingProject.project_id,
      task_id: task.task_id,
      worker_type: selectedWorkerType,
      selected_existing_project: true,
    };
  }

  if (requestedWorkspacePath) {
    let workspacePath: string;
    let gitInitialized = false;
    let github: GitHubRepoProvisionResult | null = null;
    let project: ReturnType<typeof projectRecordForWorkspace>;
    try {
      workspacePath = ensureWorkspaceDirectory(target);
      const initialized = initializeNewProjectRepository({
        session,
        workspacePath,
        displayName,
        slug,
        description: cleanedDescription,
      });
      project = initialized.project;
      gitInitialized = initialized.gitInitialized;
      github = initialized.github;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), code: "WORKSPACE_CREATE_FAILED" };
    }

    session.workspace_path = project.workspace_path;
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.pending_action = null;
    session.pending_action_payload = null;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = displayName;
    session.project_discovery.confidence = "high";
    session.project_discovery.reason = "Creating or selecting the explicit workspace path requested by the user.";
    session.project_discovery.last_question = "";
    session.active_task = cleanedDescription;
    session.latest_codex_message = `Starting ${selectedWorkerType} worker to create ${displayName} at ${project.workspace_path}.`;
    session.last_updated = now;
    pushSessionEvent(session, {
      ts: now,
      source: "system",
      type: "project.create.requested",
      message: `Create ${displayName} at ${project.workspace_path}`,
      data: {
        display_name: displayName,
        slug,
        target_path: project.workspace_path,
        requested_workspace_path: requestedWorkspacePath,
        git_initialized: gitInitialized,
        github,
        worker_type: selectedWorkerType,
      },
    });
    upsertSession(session);

    appendOrchestratorEvent({
      scope: "project",
      scope_id: project.project_id,
      type: "project.created",
      message: `Created project workspace ${project.display_name}.`,
      data: { project, session_id: session.session_id, requested_workspace_path: requestedWorkspacePath, git_initialized: gitInitialized, github },
    });
    appendOrchestratorEvent({
      scope: "project",
      scope_id: project.project_id,
      type: "project.selected",
      message: `Selected project ${project.display_name}.`,
      data: { project, session_id: session.session_id, requested_workspace_path: requestedWorkspacePath },
    });

    if (selectedWorkerType !== "local") {
      return await startWorkerBackedProject({
        session,
        project,
        displayName,
        targetPath: project.workspace_path,
        description: cleanedDescription,
        workerType: selectedWorkerType,
      });
    }

    const task = cloudOrchestrator.createTask(project.project_id, cleanedDescription);
    session.active_task_id = task.task_id;
    session.latest_plan = task.plan;
    session.latest_summary = task.latest_summary;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
    return {
      session_id: sessionId,
      status: "running" as const,
      project_name: displayName,
      target_path: project.workspace_path,
      project_id: project.project_id,
      task_id: task.task_id,
      worker_type: selectedWorkerType,
      github_repo_url: project.github_repo_url,
      github_repo_status: github?.status ?? null,
    };
  }

  if (selectedWorkerType !== "local") {
    const { workspacePath } = ensureNewProjectDirectory(cleanedName);
    let initialized: ReturnType<typeof initializeNewProjectRepository>;
    try {
      initialized = initializeNewProjectRepository({
        session,
        workspacePath,
        displayName,
        slug,
        description: cleanedDescription,
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), code: "WORKSPACE_CREATE_FAILED" };
    }
    const { project, gitInitialized, github } = initialized;

    session.workspace_path = project.workspace_path;
    session.project_id = project.project_id;
    session.current_project_id = project.project_id;
    session.pending_action = null;
    session.pending_action_payload = null;
    session.project_discovery.status = "selected";
    session.project_discovery.selected_workspace_path = project.workspace_path;
    session.project_discovery.selected_project_name = displayName;
    session.project_discovery.confidence = "high";
    session.project_discovery.reason = `Creating a new project through ${selectedWorkerType} worker mode.`;
    session.project_discovery.last_question = "";
    session.active_task = cleanedDescription;
    session.latest_codex_message = `Starting ${selectedWorkerType} worker to create ${displayName} at ${target}.`;
    session.last_updated = now;
    pushSessionEvent(session, {
      ts: now,
      source: "system",
      type: "project.create.requested",
      message: `Create ${displayName} at ${target}`,
      data: { display_name: displayName, slug, target_path: target, git_initialized: gitInitialized, github, worker_type: selectedWorkerType },
    });
    upsertSession(session);

    appendOrchestratorEvent({
      scope: "project",
      scope_id: project.project_id,
      type: "project.created",
      message: `Created project workspace ${project.display_name}.`,
      data: { project, session_id: session.session_id, git_initialized: gitInitialized, github },
    });
    appendOrchestratorEvent({
      scope: "project",
      scope_id: project.project_id,
      type: "project.selected",
      message: `Selected project ${project.display_name}.`,
      data: { project, session_id: session.session_id },
    });

    return await startWorkerBackedProject({
      session,
      project,
      displayName,
      targetPath: target,
      description: cleanedDescription,
      workerType: selectedWorkerType,
    });
  }

  session.workspace_path = config.newProjectsRoot;
  session.project_id = null;
  session.current_project_id = null;
  session.pending_action = null;
  session.pending_action_payload = null;
  session.project_discovery.status = "selected";
  session.project_discovery.selected_workspace_path = config.newProjectsRoot;
  session.project_discovery.selected_project_name = displayName;
  session.project_discovery.confidence = "high";
  session.project_discovery.reason = "Creating a new project under the configured root repository.";
  session.project_discovery.last_question = "";
  session.active_task = `Create new project: ${displayName}`;
  session.latest_codex_message = `Starting Codex CLI to create ${displayName} at ${target}.`;
  session.last_updated = now;
  pushSessionEvent(session, {
    ts: now,
    source: "system",
    type: "project.create.requested",
    message: `Create ${displayName} at ${target}`,
    data: { display_name: displayName, slug, target_path: target },
  });
  upsertSession(session);

  const instruction = [
    `Create a new local project named "${displayName}".`,
    `Project directory: ${slug}`,
    `User request: ${cleanedDescription}`,
    "Build the requested app or website as a real, usable MVP, not a placeholder or demo.",
    "Choose the simplest appropriate local implementation for the request; for a straightforward website, static HTML/CSS/JS is acceptable.",
    "Include concrete content, layout, interactions, and local assets that match the user's actual product or app request.",
    "Include an index.html and any local CSS/JS files needed when using a static implementation.",
    "Do not install packages, run network commands, deploy, delete files, read secrets, or write outside the new project directory.",
  ].join("\n");

  void runCodexSession(sessionId, instruction, {
    newProject: {
      displayName,
      slug,
      targetPath: target,
    },
  }).catch((error) => {
    const failed = getSession(sessionId);
    if (!failed) return;
    failed.current_status = "failed";
    failed.status = "failed";
    failed.errors.push(error instanceof Error ? error.message : String(error));
    upsertSession(failed);
  });

  return { session_id: sessionId, status: "running", project_name: displayName, target_path: target };
}

function pushSessionEvent(session: SessionState, event: Omit<SupervisorEvent, "id" | "session_id">) {
  const stored = appendAuditEvent({
    session_id: session.session_id,
    ...event,
  });
  session.raw_events.push(stored);
  session.last_updated = stored.ts;
  return stored;
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

function recentConversation(session: SessionState) {
  const projectTurns = session.project_discovery.conversation.map((turn) => ({
    role: turn.role === "assistant" ? ("assistant" as const) : ("user" as const),
    text: turn.text,
  }));
  const rawTurns = session.raw_events
    .filter((event) => ["call.message", "project_discovery.question", "project_discovery.selected", "supervisor.development.answer", "supervisor.development.question", "supervisor.development.sent_to_codex"].includes(event.type))
    .map((event) => ({
      role: event.source === "user" ? ("user" as const) : event.source === "codex" ? ("assistant" as const) : ("system" as const),
      text: event.message,
    }));
  return [...projectTurns, ...rawTurns].slice(-10);
}

function requireProjectId(session: SessionState) {
  if (!session.project_id) throw new Error("The session is not attached to a project.");
  return session.project_id;
}

function toolInstruction(decision: DevelopmentTurnOutput) {
  const argument = decision.tool_arguments?.instruction;
  if (typeof argument === "string" && argument.trim()) return argument.trim();
  if (decision.codex_instruction?.trim()) return decision.codex_instruction.trim();
  throw new Error("send_codex_instruction requires an instruction argument.");
}

function latestPending(session: SessionState) {
  return session.pending_approvals.find((approval) => approval.status === "pending") ?? null;
}

function formatToolResponse(toolName: SupervisorToolName, result: unknown) {
  if (result && typeof result === "object" && "error" in result) {
    return `Backend tool ${toolName} failed: ${String((result as { error: unknown }).error)}`;
  }

  if (toolName === "get_codex_status") {
    const session = (result as { session?: SessionState }).session;
    return session
      ? `Codex is ${session.current_status}. Active task: ${session.active_task || "none"}. Latest update: ${session.latest_codex_message || "No update yet."}`
      : "No Codex status is available for this session.";
  }

  if (toolName === "get_codex_summary") {
    const summary = result as {
      summary?: string;
      files_modified?: string[];
      commands_completed?: string[];
      commands_failed?: string[];
      pending_approvals?: Array<{ command: string }>;
      errors?: string[];
    };
    const parts = [
      summary.summary || "No summary is available yet.",
      summary.files_modified?.length ? `Files modified: ${summary.files_modified.join(", ")}.` : "",
      summary.commands_completed?.length ? `Commands completed: ${summary.commands_completed.join(" | ")}.` : "",
      summary.commands_failed?.length ? `Commands failed: ${summary.commands_failed.join(" | ")}.` : "",
      summary.pending_approvals?.length ? `Pending approval: ${summary.pending_approvals[0].command}.` : "",
      summary.errors?.length ? `Errors: ${summary.errors.join(" | ")}.` : "",
    ].filter(Boolean);
    return parts.join(" ");
  }

  if (toolName === "get_codex_events") {
    const events = ((result as { events?: Array<{ type: string; message: string }> }).events ?? []).slice(-5);
    return events.length
      ? `Latest Codex events: ${events.map((event) => `${event.type}: ${event.message}`).join(" | ")}`
      : "No Codex events are recorded yet.";
  }

  if (toolName === "get_access_summary") {
    const access = result as {
      workspace_path?: string;
      repo_name?: string | null;
      current_branch?: string | null;
      workspace_cleanliness?: string;
      codex_cli_installed?: boolean;
      codex_version?: string | null;
      detectable_config_files?: string[];
      environment_variable_names?: string[];
    };
    return [
      `Workspace: ${access.workspace_path || "unknown"}.`,
      `Repo: ${access.repo_name || "none"}.`,
      `Branch: ${access.current_branch || "none"}.`,
      `Workspace is ${access.workspace_cleanliness || "unknown"}.`,
      `Codex CLI installed: ${access.codex_cli_installed ? "yes" : "no"}${access.codex_version ? ` (${access.codex_version})` : ""}.`,
      `Config files: ${access.detectable_config_files?.join(", ") || "none"}.`,
      `Environment variable names visible: ${access.environment_variable_names?.length ?? 0}. Values are not exposed.`,
      "Network, shell, and destructive actions require approval.",
    ].join(" ");
  }

  if (toolName === "get_git_diff_summary") {
    return `Git diff summary: ${(result as { git_diff_summary?: string }).git_diff_summary || "No diff available."}`;
  }

  if (toolName === "get_pending_approval") {
    const approval = (result as { pending_approval?: { command: string; reason: string; risk: string } | null }).pending_approval;
    return approval
      ? `Pending approval: ${approval.command}. Reason: ${approval.reason}. Risk: ${approval.risk}.`
      : "There is no pending approval.";
  }

  if (toolName === "stop_session") return "Stopped the Codex session.";
  return `Backend tool ${toolName} completed.`;
}

async function executeSupervisorTool(session: SessionState, decision: DevelopmentTurnOutput, userText: string, channel?: Channel) {
  const toolName = decision.tool_name ?? (decision.action === "send_codex_instruction" ? "send_codex_instruction" : null);
  if (!toolName) throw new Error("Supervisor selected a tool action without a tool name.");

  if (toolName === "send_codex_instruction") {
    const instruction = toolInstruction(decision);
    const result = send_codex_instruction(session.session_id, instruction);
    const response = "approval_id" in result
      ? `Approval required before Codex can run: ${instruction}`
      : decision.assistant_message;
    return { response, result, eventType: "supervisor.development.sent_to_codex" };
  }

  if (toolName === "create_project") {
    const projectName = decision.tool_arguments?.project_name;
    const description = decision.tool_arguments?.description;
    if (typeof projectName !== "string" || !projectName.trim() || typeof description !== "string" || !description.trim()) {
      const response = "What should I call the new project?";
      setPendingAction(session, {
        type: "collect_project_name",
        original_user_goal: userText,
        requested_kind: "project",
        created_at: new Date().toISOString(),
      });
      session.project_discovery.status = "collecting";
      session.project_discovery.last_question = response;
      session.project_discovery.reason = "The model selected create_project without required arguments, so Codex needs the project name.";
      upsertSession(session);
      return {
        response,
        result: { error: "MISSING_TOOL_ARGUMENTS", code: "MISSING_TOOL_ARGUMENTS" },
        eventType: "supervisor.development.question",
      };
    }
    const workspacePath = typeof decision.tool_arguments?.workspace_path === "string"
      ? decision.tool_arguments.workspace_path
      : null;
    const result = await create_project(session.session_id, projectName, description, { workspacePath });
    return { response: describeNewProjectResult(result), result, eventType: "supervisor.development.sent_to_codex" };
  }

  if (toolName === "get_codex_status") {
    const result = get_codex_status(session.session_id);
    return { response: formatToolResponse(toolName, result), result, eventType: "supervisor.tool.called" };
  }

  if (toolName === "get_codex_events") {
    const result = get_codex_events(session.session_id);
    return { response: formatToolResponse(toolName, result), result, eventType: "supervisor.tool.called" };
  }

  if (toolName === "get_codex_summary") {
    const result = get_codex_summary(session.session_id);
    return { response: formatToolResponse(toolName, result), result, eventType: "supervisor.tool.called" };
  }

  if (toolName === "get_access_summary") {
    const result = get_access_summary(requireProjectId(session));
    return { response: formatToolResponse(toolName, result), result, eventType: "supervisor.tool.called" };
  }

  if (toolName === "get_git_diff_summary") {
    const result = get_git_diff_summary(requireProjectId(session));
    return { response: formatToolResponse(toolName, result), result, eventType: "supervisor.tool.called" };
  }

  if (toolName === "get_pending_approval") {
    const result = get_pending_approval(requireProjectId(session), session.session_id);
    return { response: formatToolResponse(toolName, result), result, eventType: "supervisor.tool.called" };
  }

  if (toolName === "approve_action" || toolName === "deny_action") {
    const pending = latestPending(session);
    if (!pending) return { response: "There is no pending approval.", result: { pending_approval: null }, eventType: "supervisor.tool.called" };
    const explicitApproval = /^(approve it|approve|yes approve|go ahead)$/i.test(userText);
    const explicitDenial = /^(deny it|deny|no deny|do not approve)$/i.test(userText);
    if (toolName === "approve_action" && !explicitApproval) {
      return {
        response: `Approval still requires explicit user confirmation. Pending action: ${pending.command}.`,
        result: { pending_approval: pending },
        eventType: "supervisor.tool.called",
      };
    }
    if (toolName === "deny_action" && !explicitDenial) {
      return {
        response: `Denial still requires explicit user confirmation. Pending action: ${pending.command}.`,
        result: { pending_approval: pending },
        eventType: "supervisor.tool.called",
      };
    }
    const result = respond_to_approval(session.session_id, pending.id, toolName === "approve_action" ? "approved" : "denied", channel);
    return {
      response: toolName === "approve_action" ? `Approved: ${pending.command}.` : `Denied: ${pending.command}.`,
      result,
      eventType: "supervisor.tool.called",
    };
  }

  if (toolName === "stop_session") {
    const result = stop_session(session.session_id);
    return { response: formatToolResponse(toolName, result), result, eventType: "supervisor.tool.called" };
  }

  throw new Error(`Unsupported supervisor tool: ${toolName}`);
}

async function handleDevelopmentTurn(session: SessionState, cleaned: string, channel?: Channel) {
  const model = createSupervisorModel(supervisorModelConfig());
  const decision = await model.developmentTurn({
    text: cleaned,
    projectName: session.project_discovery.selected_project_name || session.project_id || "selected project",
    workspacePath: session.workspace_path,
    currentStatus: session.current_status,
    activeTask: session.active_task,
    summary: session.summary_text,
    latestCodexMessage: session.latest_codex_message,
    filesModified: session.files_modified,
    commandsCompleted: session.commands_completed,
    commandsFailed: session.commands_failed,
    pendingApprovals: session.pending_approvals
      .filter((approval) => approval.status === "pending")
      .map((approval) => ({ command: approval.command, reason: approval.reason, risk: approval.risk })),
    errors: session.errors,
    recentMessages: recentConversation(session),
  });

  const latest = getSession(session.session_id);
  if (!latest) return { response: "I cannot find that Codex session.", handled: false, error: "Session not found." };

  if (decision.action === "answer" || decision.action === "ask_user") {
    latest.latest_codex_message = decision.assistant_message;
    pushSessionEvent(latest, {
      ts: new Date().toISOString(),
      source: "codex",
      type: decision.action === "answer" ? "supervisor.development.answer" : "supervisor.development.question",
      message: decision.assistant_message,
      data: decision,
    });
    upsertSession(latest);
    return {
      response: decision.assistant_message,
      session_id: latest.session_id,
      project_id: latest.project_id ?? undefined,
      handled: true,
      decision,
    };
  }

  const { response, result, eventType } = await executeSupervisorTool(latest, decision, cleaned, channel);
  const afterInstruction = getSession(latest.session_id);
  if (afterInstruction) {
    afterInstruction.latest_codex_message = response;
    pushSessionEvent(afterInstruction, {
      ts: new Date().toISOString(),
      source: "codex",
      type: eventType,
      message: response,
      data: { decision, result },
    });
    upsertSession(afterInstruction);
  }
  return {
    response,
    session_id: latest.session_id,
    project_id: latest.project_id ?? undefined,
    handled: true,
    result,
    decision,
  };
}

async function handleProjectDiscovery(session: SessionState, cleaned: string) {
  const userTurn = { ts: new Date().toISOString(), role: "user" as const, text: cleaned };
  session.project_discovery.conversation.push(userTurn);
  pushSessionEvent(session, {
    ts: userTurn.ts,
    source: "user",
    type: "project_discovery.user",
    message: cleaned,
  });
  upsertSession(session);

  try {
    const { decision, rawEvents } = await runProjectSelection(session, cleaned);
    const latest = getSession(session.session_id);
    if (!latest) return { response: "The project-selection session disappeared.", handled: false, error: "Session not found." };

    for (const event of rawEvents) {
      latest.raw_events.push(event);
      appendAuditEvent({
        session_id: event.session_id,
        ts: event.ts,
        source: event.source,
        type: event.type,
        message: event.message,
        data: event.data,
      });
    }

    const assistantTurn = { ts: new Date().toISOString(), role: "assistant" as const, text: decision.assistant_message };
    latest.project_discovery.conversation.push(assistantTurn);
    latest.project_discovery.confidence = decision.confidence;
    latest.project_discovery.reason = decision.reason;
    latest.project_discovery.last_question = decision.status === "needs_user" ? decision.assistant_message : "";
    latest.latest_codex_message = decision.assistant_message;

    if (decision.status === "selected") {
      const existingProject = findProjectByWorkspace(decision.selected_workspace_path!);
      const priorSession = existingProject?.last_active_session_id ? getSession(existingProject.last_active_session_id) : null;
      const project = upsertProject(projectRecordForWorkspace(decision.selected_workspace_path!, existingProject ?? undefined));
      latest.project_discovery.status = "selected";
      latest.project_discovery.selected_workspace_path = decision.selected_workspace_path;
      latest.project_discovery.selected_project_name = project.display_name;
      latest.project_id = project.project_id;
      latest.workspace_path = decision.selected_workspace_path!;
      latest.active_task = `Project selected: ${project.display_name}`;
      latest.summary_text = `Codex is attached to ${project.display_name} at ${decision.selected_workspace_path}.`;
      latest.errors = latest.errors.filter((item) => !/^Codex project selector failed\b/.test(item));
      if (priorSession && priorSession.session_id !== latest.session_id) {
        latest.files_read = [...new Set([...latest.files_read, ...priorSession.files_read])].sort();
        latest.files_modified = [...new Set([...latest.files_modified, ...priorSession.files_modified])].sort();
        latest.commands_requested = [...new Set([...latest.commands_requested, ...priorSession.commands_requested])].sort();
        latest.commands_completed = [...new Set([...latest.commands_completed, ...priorSession.commands_completed])].sort();
        latest.commands_failed = [...new Set([...latest.commands_failed, ...priorSession.commands_failed])].sort();
        latest.test_results = priorSession.test_results.length ? priorSession.test_results : latest.test_results;
        latest.git_diff_summary = priorSession.git_diff_summary || latest.git_diff_summary;
        latest.summary_text = priorSession.summary_text
          ? `Continuing ${project.display_name}. Previous session summary: ${priorSession.summary_text}`
          : latest.summary_text;
        pushSessionEvent(latest, {
          ts: new Date().toISOString(),
          source: "system",
          type: "project_context.inherited",
          message: `Inherited prior session context from ${priorSession.session_id}.`,
          data: {
            previous_session_id: priorSession.session_id,
            previous_status: priorSession.current_status,
            previous_files_modified: priorSession.files_modified,
            previous_summary: priorSession.summary_text,
          },
        });
      }
      project.last_active_session_id = latest.session_id;
      project.updated_at = new Date().toISOString();
      upsertProject(project);
      pushSessionEvent(latest, {
        ts: assistantTurn.ts,
        source: "codex",
        type: "project_discovery.selected",
        message: decision.assistant_message,
        data: decision,
      });
      upsertSession(latest);
      return {
        response: decision.assistant_message,
        session_id: latest.session_id,
        project_id: project.project_id,
        handled: true,
        project_discovery: latest.project_discovery,
      };
    }

    latest.project_discovery.status = "collecting";
    pushSessionEvent(latest, {
      ts: assistantTurn.ts,
      source: "codex",
      type: "project_discovery.question",
      message: decision.assistant_message,
      data: decision,
    });
    upsertSession(latest);
    return {
      response: decision.assistant_message,
      session_id: latest.session_id,
      handled: true,
      project_discovery: latest.project_discovery,
    };
  } catch (error) {
    const failed = getSession(session.session_id);
    if (!failed) return { response: "The project-selection session disappeared.", handled: false, error: "Session not found." };
    const message = error instanceof Error ? error.message : String(error);
    failed.errors.push(message);
    failed.latest_codex_message = "Project selection failed. Check the Codex selector error in the session errors.";
    pushSessionEvent(failed, {
      ts: new Date().toISOString(),
      source: "system",
      type: "project_discovery.failed",
      message,
    });
    upsertSession(failed);
    return {
      response: "I could not safely select a project yet. Please name an existing project or ask me to create a new one.",
      session_id: failed.session_id,
      handled: false,
      error: "PROJECT_SELECTION_FAILED",
    };
  }
}

export function respond_to_approval(sessionId: string, approvalId: string, decision: "approved" | "denied", channel?: Channel) {
  const session = getSession(sessionId);
  if (!session) return { error: "Session not found.", code: "SESSION_NOT_FOUND" };
  const approval = session.pending_approvals.find((item) => item.id === approvalId && item.status === "pending");
  if (!approval) return { error: "Pending approval not found." };

  approval.status = decision;
  approval.responded_at = new Date().toISOString();
  approval.approved_by_channel = channel;
  appendAuditEvent({
    session_id: sessionId,
    ts: approval.responded_at,
    source: "approval",
    type: "approval.respond",
    message: `${decision}: ${approval.command}`,
    data: approval,
  });

  if (decision === "denied") {
    session.current_status = "failed";
    session.status = "failed";
    session.errors.push(`Approval denied for: ${approval.command}`);
    upsertSession(session);
    return { ok: true, session };
  }

  upsertSession(session);
  void runCodexSession(sessionId, `Continue from the last task. You are now approved to perform: ${approval.command}`, {
    approvedCommand: approval.command,
  }).catch((error) => {
    const failed = getSession(sessionId);
    if (!failed) return;
    failed.current_status = "failed";
    failed.status = "failed";
    failed.errors.push(error instanceof Error ? error.message : String(error));
    upsertSession(failed);
  });

  return { ok: true, session_id: sessionId, resumed: true };
}

export function approve_action(approvalId: string, sessionId: string, channel?: Channel) {
  return respond_to_approval(sessionId, approvalId, "approved", channel);
}

export function deny_action(approvalId: string, sessionId: string, channel?: Channel) {
  return respond_to_approval(sessionId, approvalId, "denied", channel);
}

export function stop_session(sessionId: string) {
  const session = getSession(sessionId);
  if (!session) return { error: "Session not found.", code: "SESSION_NOT_FOUND" };
  session.current_status = "failed";
  session.status = "failed";
  session.errors.push("Session stop requested by user.");
  session.last_updated = new Date().toISOString();
  upsertSession(session);
  appendAuditEvent({
    session_id: sessionId,
    ts: session.last_updated,
    source: "user",
    type: "session.stop",
    message: "Session stop requested by user.",
  });
  return { ok: true, session };
}

function activeTaskForSession(session: SessionState) {
  if (session.active_task_id) {
    const task = getTask(session.active_task_id);
    if (task) return task;
  }
  if (session.current_project_id || session.project_id) {
    return listTasks(session.current_project_id ?? session.project_id ?? undefined)[0] ?? null;
  }
  return null;
}

function activeWorkerForSession(session: SessionState) {
  if (session.active_worker_id) {
    const worker = getWorker(session.active_worker_id);
    if (worker) return worker;
  }
  const task = activeTaskForSession(session);
  if (task?.worker_id) return getWorker(task.worker_id);
  return null;
}

function rememberConversationMessage(session: SessionState, role: "user" | "assistant" | "system", text: string, channel?: Channel) {
  session.recent_messages = [
    ...(session.recent_messages ?? []),
    {
      ts: new Date().toISOString(),
      role,
      channel: channel ?? session.channel ?? null,
      text,
    },
  ].slice(-30);
}

function syncConversationState(session: SessionState) {
  const task = activeTaskForSession(session);
  const worker = activeWorkerForSession(session);
  const summary = task ? getRunSummary(task.task_id) : null;
  if (task) {
    session.active_task_id = task.task_id;
    session.current_project_id = task.project_id;
    session.active_task = task.user_goal;
    session.latest_plan = task.plan;
    session.latest_summary = summary?.executive_summary ?? task.latest_summary;
    session.summary_text = session.summary_text || session.latest_summary;
  }
  if (worker) session.active_worker_id = worker.worker_id;
  session.last_updated = new Date().toISOString();
  return session;
}

function finalConversationResponse<T extends { response: string; session_id?: string; handled?: boolean }>(
  sessionId: string,
  result: T,
  channel?: Channel,
  eventType = "orchestrator.decision.completed",
) {
  const latest = getSession(sessionId);
  if (latest) {
    const latestUserMessage = [...(latest.recent_messages ?? [])].reverse().find((message) => message.role === "user");
    rememberConversationMessage(latest, "assistant", result.response, channel);
    syncConversationState(latest);
    upsertSession(latest);
    appendOrchestratorEvent({
      scope: "session",
      scope_id: latest.session_id,
      type: eventType,
      message: result.response,
      data: {
        session_id: latest.session_id,
        project_id: latest.current_project_id ?? latest.project_id,
        task_id: latest.active_task_id,
        worker_id: latest.active_worker_id,
        pending_action: latest.pending_action,
      },
    });
    if (latestUserMessage) {
      mirrorBrowserConversationTurn({
        session: latest,
        userText: latestUserMessage.text,
        assistantText: result.response,
        channel,
      });
    }
  }
  return result;
}

function appendProjectDiscoveryTurn(session: SessionState, role: "user" | "assistant", text: string, type: string) {
  const ts = new Date().toISOString();
  session.project_discovery.conversation.push({ ts, role, text });
  pushSessionEvent(session, {
    ts,
    source: role === "user" ? "user" : "codex",
    type,
    message: text,
  });
}

const implementationVerbPattern = "\\b(build|create|make|add|update|fix|implement|scaffold|generate)\\b";

function removeNegatedImplementationClauses(text: string) {
  return text.replace(
    /\b(?:do not|don't|dont|without|no)\s+[^.?!,;]*(?:build|create|make|add|update|fix|implement|scaffold|generate|modify|change|edit|write)[^.?!,;]*/gi,
    " ",
  );
}

function hasImplementationRequest(text: string) {
  return new RegExp(implementationVerbPattern, "i").test(removeNegatedImplementationClauses(text));
}

function readOnlyConversationResponse(text: string) {
  if (!/\b(?:do not|don't|dont|without|no)\s+[^.?!,;]*(?:create|modify|change|edit|write|build|make|add|update|fix|implement|scaffold|generate)\b/i.test(text)) return null;
  if (hasImplementationRequest(text)) return null;
  if (!/\b(confirm|verify|verification|reachable|reach|reply|question|explain|status|summarize|tell me)\b/i.test(text)) return null;
  return "Confirmed: this browser wrapper can reach Codex for the selected local repo. I will not create or modify files for this turn.";
}

function setPendingAction(session: SessionState, pendingAction: PendingAction) {
  session.pending_action = pendingAction;
  session.pending_action_payload = {
    type: pendingAction.type,
    original_user_goal: pendingAction.original_user_goal,
    requested_kind: pendingAction.requested_kind,
    suggested_project_name: pendingAction.suggested_project_name ?? null,
    description: pendingAction.description ?? null,
    action: pendingAction.action ?? null,
    reason: pendingAction.reason ?? null,
    risk_level: pendingAction.risk_level ?? null,
    approval_id: pendingAction.approval_id ?? null,
    worker_mode: pendingAction.worker_mode ?? null,
    target_project_id: pendingAction.target_project_id ?? null,
    target_task_id: pendingAction.target_task_id ?? null,
    target_worker_id: pendingAction.target_worker_id ?? null,
    target_task_graph_id: pendingAction.target_task_graph_id ?? null,
    planning_decision_id: pendingAction.planning_decision_id ?? null,
    proposed_plan: pendingAction.proposed_plan ?? null,
    approved_plan: pendingAction.approved_plan ?? null,
    user_approved_worker_count: pendingAction.user_approved_worker_count ?? null,
    user_approved_worker_mode: pendingAction.user_approved_worker_mode ?? null,
    choices: pendingAction.choices ?? null,
  };
}

function clearPendingAction(session: SessionState) {
  session.pending_action = null;
  session.pending_action_payload = null;
}

async function createProjectFromResolvedName(
  session: SessionState,
  cleaned: string,
  projectName: string,
  description: string,
  workspacePath?: string | null,
) {
  appendProjectDiscoveryTurn(session, "user", cleaned, "project_discovery.user");
  clearPendingAction(session);
  upsertSession(session);

  const result = await create_project(session.session_id, projectName, description, { workspacePath });
  const response = describeNewProjectResult(result);
  const latest = getSession(session.session_id);
  if (latest) {
    latest.latest_codex_message = response;
    if (result.status !== "waiting_for_approval" && result.status !== "idle") {
      clearPendingAction(latest);
    }
    pushSessionEvent(latest, {
      ts: new Date().toISOString(),
      source: "codex",
      type: "project_discovery.selected",
      message: response,
      data: { result, new_project: true },
    });
    upsertSession(latest);
  }

  return {
    response,
    session_id: session.session_id,
    handled: !("error" in result),
    result,
  };
}

async function handleNewProjectIntent(session: SessionState, cleaned: string) {
  let intake: Awaited<ReturnType<typeof resolveProjectIntake>>;
  const startedMs = Date.now();
  appendOrchestratorEvent({
    scope: "session",
    scope_id: session.session_id,
    type: "project_intake.codex_started",
    message: "Started Codex project-intake decision.",
    data: {
      session_id: session.session_id,
      model: config.localCodex.model || null,
    },
  });
  try {
    intake = await resolveProjectIntake(session, cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.errors.push(message);
    upsertSession(session);
    appendOrchestratorEvent({
      scope: "session",
      scope_id: session.session_id,
      type: "project_intake.failed",
      message,
      data: { session_id: session.session_id, duration_ms: Date.now() - startedMs },
    });
    return null;
  }
  appendOrchestratorEvent({
    scope: "session",
    scope_id: session.session_id,
    type: "project_intake.codex_completed",
    message: `${intake.decision.action}: ${intake.decision.reason}`,
    data: {
      session_id: session.session_id,
      duration_ms: Date.now() - startedMs,
      action: intake.decision.action,
      confidence: intake.decision.confidence,
    },
  });

  const latest = getSession(session.session_id) ?? session;
  for (const event of intake.rawEvents) {
    latest.raw_events.push(event);
    appendAuditEvent({
      session_id: event.session_id,
      ts: event.ts,
      source: event.source,
      type: event.type,
      message: event.message,
      data: event.data,
    });
  }
  upsertSession(latest);

  const decision = intake.decision;
  if (decision.action === "no_project_action") return null;

  if (decision.action === "ask_user") {
    appendProjectDiscoveryTurn(latest, "user", cleaned, "project_discovery.user");
    setPendingAction(latest, {
      type: decision.pending_action_type ?? "collect_project_name",
      original_user_goal: decision.description || cleaned,
      requested_kind: decision.requested_kind ?? "project",
      description: decision.description || cleaned,
      reason: decision.reason,
      created_at: new Date().toISOString(),
    });
    latest.project_discovery.status = "collecting";
    latest.project_discovery.reason = decision.reason;
    latest.project_discovery.last_question = decision.assistant_message;
    latest.latest_codex_message = decision.assistant_message;
    appendProjectDiscoveryTurn(latest, "assistant", decision.assistant_message, "project_discovery.question");
    upsertSession(latest);
    return {
      response: decision.assistant_message,
      session_id: latest.session_id,
      handled: true,
      project_discovery: latest.project_discovery,
    };
  }

  return await createProjectFromResolvedName(
    latest,
    cleaned,
    decision.project_name ?? cleaned,
    decision.description || cleaned,
    decision.workspace_path,
  );
}

function requestedWorkerMode(text: string): WorkerType | null {
  const input = text.toLowerCase();
  if (/\b(codex_session_local|local codex session|codex cli session|one codex session)\b/.test(input)) return "codex_session_local";
  if (/\b(docker local|docker_local|local docker)\b/.test(input)) return "docker_local";
  if (/\b(gke|kubernetes|k8s)\b[\s\S]*\b(job|jobs|workers?)\b/.test(input) || /\bworkers?\b[\s\S]*\b(gke|kubernetes|k8s)\b/.test(input)) return "gke_job";
  if (/\b(local mode|use local|run (this|it|the next task) locally|local worker)\b/.test(input)) return "local";
  if (
    /\b(gcp vm|compute engine)\b/.test(input) ||
    /\b(gcp|cloud)\b[\s\S]*\bworkers?\b/.test(input) ||
    /\bworkers?\b[\s\S]*\b(gcp|cloud)\b/.test(input) ||
    /\b(run|switch|use)\b[\s\S]*\b(next task|future tasks|this task|this one)\b[\s\S]*\b(gcp|cloud)\b/.test(input)
  ) return "gcp_vm";
  return null;
}

function requestedWorkerCount(text: string) {
  return /\b(use|make|run)\b[\s\S]*\b(one|1|single)\b[\s\S]*\bworker\b/i.test(text) ? 1 : null;
}

function isTaskSplitApproval(text: string) {
  const input = text.trim();
  if (/^(yes|approve|approved|go ahead|do it|confirm|proceed|start)\b/i.test(input)) return true;
  return /\b(go ahead|proceed|start)\b/i.test(input) && /\b(fine|ok|okay|yes|please|approved?)\b/i.test(input);
}

function workerModeLabel(mode: WorkerType) {
  if (mode === "codex_session_local") return "Local Codex CLI session";
  if (mode === "docker_local") return "Docker local";
  if (mode === "gcp_vm") return "GCP VM";
  if (mode === "gke_job") return "GKE Job";
  return "local";
}

function normalizeQuestion(text: string) {
  return text.toLowerCase().replace(/[?.!]/g, "").trim();
}

function latestFailedCommand(session: SessionState) {
  const task = activeTaskForSession(session);
  const commands = task ? listCommandEvents({ taskId: task.task_id }) : [];
  return [...commands].reverse().find((command) => command.exit_code !== null && command.exit_code !== 0) ?? null;
}

function plannerDecisionForPending(session: SessionState, pending: PendingAction) {
  try {
    return parsePlannerDecision(pending.proposed_plan ?? session.planner_output);
  } catch {
    return null;
  }
}

function updatePendingPlannerDecision(session: SessionState, pending: PendingAction, decision: PlannerDecision, originalUserGoal = pending.original_user_goal) {
  session.planner_output = decision;
  session.planning_decision_id = decision.planning_decision_id ?? session.planning_decision_id;
  session.requirement_summary = decision.requirements_summary;
  session.open_questions = decision.open_questions;
  session.assumptions = decision.assumptions;
  session.user_approved_worker_count = decision.recommended_worker_count;
  session.user_approved_worker_mode = decision.recommended_worker_mode;
  setPendingAction(session, {
    ...pending,
    original_user_goal: originalUserGoal,
    planning_decision_id: decision.planning_decision_id,
    proposed_plan: decision,
    worker_mode: decision.recommended_worker_mode,
    user_approved_worker_count: decision.recommended_worker_count,
    user_approved_worker_mode: decision.recommended_worker_mode,
    created_at: pending.created_at,
  });
}

function appendPreApprovalUserUpdate(originalUserGoal: string, cleaned: string) {
  const update = cleaned.trim();
  if (!update) return originalUserGoal;
  if (originalUserGoal.includes(update)) return originalUserGoal;
  return `${originalUserGoal}\n\nPre-approval user update: ${update}`;
}

function pendingRevisionPrompt(pending: PendingAction, decision: PlannerDecision | null, cleaned: string) {
  return [
    "The user is responding while an execution plan is pending approval.",
    "Treat the message as either a clarification question or a plan/requirement revision.",
    "Do not launch workers. Keep execution_allowed false until the user explicitly approves.",
    `Original request and accepted pre-approval updates:\n${pending.original_user_goal}`,
    decision?.requirements_summary ? `Current requirement summary: ${decision.requirements_summary}` : "",
    decision?.proposed_design ? `Current proposed design: ${decision.proposed_design}` : "",
    decision?.proposed_task_split.length ? `Current task split: ${decision.proposed_task_split.map((item) => `${item.title}: ${item.goal}`).join(" | ")}` : "",
    decision?.subagent_advice ? `Current subagent check-in: ${decision.subagent_advice.user_check_in}` : "",
    `New user message: ${cleaned}`,
  ].filter(Boolean).join("\n");
}

function pendingRevisionResponse(decision: PlannerDecision) {
  const split = decision.proposed_task_split.map((item, index) => {
    const files = item.expected_files.length ? ` Files: ${item.expected_files.join(", ")}.` : "";
    const validation = item.validation.length ? ` Validation: ${item.validation.join(", ")}.` : "";
    return `${index + 1}. ${item.title}: ${item.goal}.${files}${validation}`;
  });
  const design = decision.recommended_worker_mode === LOCAL_CODEX_BACKEND && /\b(worker|workers|task graph|output-contract|output contract|worktree|GKE|GCP VM|Docker)\b/i.test(decision.proposed_design)
    ? "One local Codex CLI session owns the repo, with Codex choosing any logical internal subagents it needs."
    : decision.proposed_design;
  const subagentAdvice = decision.subagent_advice
    ? [
      `Subagent check-in: ${decision.subagent_advice.user_check_in}`,
      decision.subagent_advice.suggested_responsibilities.length
        ? `Useful responsibility areas: ${decision.subagent_advice.suggested_responsibilities.join(", ")}.`
        : "",
    ].filter(Boolean).join(" ")
    : "";
  return [
    "I updated the pending plan before approval.",
    decision.user_visible_response && !/\b(starting|started|launching|launched)\b/i.test(decision.user_visible_response)
      ? decision.user_visible_response
      : "",
    decision.requirements_summary ? `Updated requirements: ${decision.requirements_summary}` : "",
    design ? `Technical direction: ${design}` : "",
    decision.recommended_worker_mode === LOCAL_CODEX_BACKEND
      ? "Execution plan: one local Codex CLI orchestrator session. Codex will choose the actual logical subagent count."
      : `Worker plan: ${decision.recommended_worker_count} ${workerModeLabel(decision.recommended_worker_mode)} worker${decision.recommended_worker_count === 1 ? "" : "s"}.`,
    subagentAdvice,
    split.length ? `Task plan: ${split.join(" ")}` : "",
    "Reply `approve` to start this revised plan, or tell me what else to change.",
  ].filter(Boolean).join(" ");
}

function answerConversationStateQuestion(session: SessionState, cleaned: string, channel?: Channel) {
  const input = normalizeQuestion(cleaned);
  const task = activeTaskForSession(session);
  const worker = activeWorkerForSession(session);
  const commands = task ? listCommandEvents({ taskId: task.task_id }) : [];
  const summary = task ? getRunSummary(task.task_id) : null;
  const voice = channel === "phone" || channel === "twilio_call" || channel === "web_voice";

  if (isPreviewQuestion(cleaned)) {
    return answerPreviewQuestion(session, cleaned);
  }

  if (/^(what is happening|what's happening|what is going on|status|what now)$/i.test(input)) {
    if (!task) return answerStateQuestion(session, cleaned) || "No active task is recorded for this session yet.";
    const workerText = worker ? `${worker.type} worker ${worker.worker_id}` : "no worker assigned yet";
    const latestCommand = commands.at(-1);
    if (voice && summary) return voiceFriendlySummary(summary);
    return [
      `Task ${task.task_id} is ${task.status}: ${task.user_goal}.`,
      `Worker: ${workerText}.`,
      latestCommand ? `Latest command: ${latestCommand.command} (${latestCommand.exit_code === null ? "running" : `exit ${latestCommand.exit_code}`}).` : "No command has run yet.",
      summary ? `Latest summary: ${summary.executive_summary}` : `Next milestone: ${task.next_steps[0] ?? "worker event or summary"}.`,
    ].join(" ");
  }

  if (input.includes("what did codex do") || input.includes("summarize this for a phone call") || input.includes("summarize the task")) {
    if (summary) return voice ? voiceFriendlySummary(summary) : `${summary.executive_summary} ${summary.technical_summary}`;
    return session.latest_summary || session.summary_text || session.latest_codex_message || "No grounded summary is available yet.";
  }

  if (input.includes("what commands ran") || input.includes("what command ran")) {
    return commands.length
      ? `Commands run: ${commands.map((command) => `${command.command} (${command.exit_code === null ? "running" : `exit ${command.exit_code}`})`).join(" | ")}`
      : "No command events are recorded for the active task yet.";
  }

  if (input.includes("what files changed") || input.includes("what changed") || input.includes("files changed")) {
    const rawChanged = summary?.files_changed?.length ? summary.files_changed : session.files_modified;
    const specificChanged = rawChanged.filter((file) => file !== "." && file !== "./");
    const changed = specificChanged.length ? specificChanged : rawChanged;
    return changed.length ? `Files changed: ${changed.join(", ")}.` : "No file changes are recorded yet.";
  }

  if (input.includes("did tests pass") || input.includes("tests pass") || input.includes("did it pass tests")) {
    if (summary?.tests_run.length) {
      return summary.failures.length
        ? `Tests ran but did not fully pass. Failures: ${summary.failures.join(" | ")}`
        : `Tests passed based on recorded commands: ${summary.tests_run.join(", ")}.`;
    }
    const testCommands = commands.filter((command) => /\b(test|typecheck|lint|pytest|node\s+--check|npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build)\b/i.test(command.command));
    if (!testCommands.length) return "No test, typecheck, lint, or pytest command is recorded yet.";
    const failed = testCommands.filter((command) => command.exit_code !== 0);
    return failed.length
      ? `A validation command failed: ${failed.map((command) => `${command.command} (${command.summary})`).join(" | ")}`
      : `Validation commands passed: ${testCommands.map((command) => command.command).join(", ")}.`;
  }

  if (input.includes("why did it fail") || input.includes("what failed")) {
    const failed = latestFailedCommand(session);
    if (failed) return `The latest failing command was ${failed.command}. Exit code: ${failed.exit_code}. Error: ${failed.stderr_preview || failed.stdout_preview || failed.summary}`;
    if (session.errors.length) return `Recorded failure: ${session.errors.at(-1)}.`;
    return "No failure is recorded for the active task.";
  }

  if (input.includes("next step") || input.includes("next action") || input.includes("what is next") || input.includes("what's next")) {
    if (summary?.next_plan.length) return `Next step: ${summary.next_plan[0]}.`;
    if (task?.next_steps.length) return `Next step: ${task.next_steps[0]}.`;
    return "No next step is recorded yet.";
  }

  if (input.includes("current worker") || input.includes("active worker")) {
    if (!worker) return "No active worker is attached to this session.";
    const recordedImage = worker.recorded_image_uri ?? worker.image_uri;
    const actualImage = worker.actual_image_uri ?? worker.runtime_image_uri ?? worker.image_uri;
    const imageMismatch = actualImage && actualImage !== recordedImage
      ? ` Recorded launch image ${recordedImage} differs from actual runtime image ${actualImage}.`
      : "";
    const vmName = worker.actual_vm_name ?? worker.runtime_vm_name ?? worker.vm_name ?? "not recorded";
    return `Active worker: ${worker.worker_id}. Mode: ${worker.actual_worker_mode ?? worker.type}. Status: ${worker.status}. VM: ${vmName}. Actual runtime image: ${actualImage}. Digest: ${worker.actual_image_digest ?? worker.runtime_image_digest ?? "not reported"}. Attempt: ${worker.run_attempt_id ?? worker.startup_attempt_id ?? "not reported"}. Heartbeat: ${worker.heartbeat_at ?? "not received yet"}.${imageMismatch}`;
  }

  return "";
}

async function handlePendingConversationAction(session: SessionState, cleaned: string, channel?: Channel) {
  const pending = session.pending_action;
  if (!pending) return null;
  const readOnlyResponse = readOnlyConversationResponse(cleaned);
  if (readOnlyResponse) {
    session.latest_codex_message = readOnlyResponse;
    pushSessionEvent(session, {
      ts: new Date().toISOString(),
      source: "codex",
      type: "supervisor.development.answer",
      message: readOnlyResponse,
      data: { reason: "Read-only conversation turn while another action was pending." },
    });
    upsertSession(session);
    return { response: readOnlyResponse, session_id: session.session_id, handled: true };
  }
  if (pending.type === "confirm_create_project" || pending.type === "collect_project_name") {
    return await handleNewProjectIntent(session, cleaned);
  }

  if (pending.type === "clarify_requirements") {
    const project = pending.target_project_id ? getProject(pending.target_project_id) : session.project_id ? getProject(session.project_id) : null;
    if (!project) {
      const response = "I need a selected local project before I can apply those technical requirements.";
      clearPendingAction(session);
      session.latest_codex_message = response;
      upsertSession(session);
      return { response, session_id: session.session_id, handled: true };
    }
    const workerMode = pending.worker_mode ?? session.preferred_worker_mode ?? getOrchestratorSettings().default_worker_mode;
    const updatedGoal = `${pending.original_user_goal}\n\nTechnical requirements from user: ${cleaned}`;
    let planning: Awaited<ReturnType<typeof agenticPlanningController.decide>>;
    try {
      planning = await agenticPlanningController.decide({
        session,
        userMessage: updatedGoal,
        project,
        workerMode,
      });
    } catch (error) {
      const response = `I could not apply those requirements because the local Codex planner failed: ${error instanceof Error ? error.message : String(error)}`;
      session.latest_codex_message = response;
      upsertSession(session);
      return { response, session_id: session.session_id, handled: true };
    }
    const latest = getSession(session.session_id) ?? session;
    const decision = planning.decision;
    if (
      decision.decision_type === "ask_clarification" ||
      decision.decision_type === "wait_for_user" ||
      decision.decision_type === "explain_blocker" ||
      decision.decision_type === "answer_status_question"
    ) {
      setPendingAction(latest, {
        ...pending,
        original_user_goal: updatedGoal,
        description: updatedGoal,
        reason: decision.reason,
        worker_mode: decision.recommended_worker_mode,
        planning_decision_id: decision.planning_decision_id,
        proposed_plan: decision,
        created_at: pending.created_at,
      });
      latest.current_status = "idle";
      latest.status = "idle";
      latest.latest_codex_message = decision.user_visible_response;
      latest.open_questions = decision.open_questions;
      latest.assumptions = decision.assumptions;
      upsertSession(latest);
      return { response: decision.user_visible_response, session_id: latest.session_id, handled: true, decision };
    }
    clearPendingAction(latest);
    if (workerMode === LOCAL_CODEX_BACKEND || decision.recommended_worker_mode === LOCAL_CODEX_BACKEND) {
      const result = queueLocalMegaplanApproval({
        session: latest,
        project,
        userGoal: updatedGoal,
        decision: { ...decision, recommended_worker_mode: LOCAL_CODEX_BACKEND },
        selectedExistingProject: true,
      });
      return { response: result.message, session_id: latest.session_id, handled: true, result };
    }
    const result = await startWorkerBackedProject({
      session: latest,
      project,
      displayName: project.display_name,
      targetPath: project.workspace_path,
      description: updatedGoal,
      workerType: workerMode,
      selectedExistingProject: true,
    });
    return { response: result.message ?? "Planner handled the clarified requirements.", session_id: latest.session_id, handled: true, result };
  }

  if (pending.type === "approve_task_split" || pending.type === "approve_megaplan") {
    const pendingDecision = plannerDecisionForPending(session, pending);
    if (/^(explain first|explain|why|why first)$/i.test(cleaned)) {
      const graph = pending.target_task_graph_id ? await Promise.resolve(multiWorkerCoordinator.judge(pending.original_user_goal, pending.target_project_id ? getProject(pending.target_project_id) : null)) : null;
      const response = graph
        ? `${graph.reason} Suggested subtasks: ${graph.suggested_subtasks.map((item) => item.title).join(", ")}.`
        : pendingDecision
          ? `${pendingDecision.reason} Proposed split: ${pendingDecision.proposed_task_split.map((item) => item.title).join(", ")}. Worker count: ${pendingDecision.recommended_worker_count}. Validation: ${pendingDecision.proposed_task_split.flatMap((item) => item.validation).join(", ") || "output-contract validation"}.`
          : "This task split is waiting for approval because the request has multiple dependent implementation areas.";
      session.latest_codex_message = response;
      upsertSession(session);
      return { response, session_id: session.session_id, handled: true };
    }
    if (/^(no|reject|deny|cancel|do not|don't)$/i.test(cleaned)) {
      const response = pending.type === "approve_megaplan"
        ? "Rejected the Megaplan. I will not start the local Codex session."
        : "Rejected the task split. I will not start the workers for that graph.";
      clearPendingAction(session);
      session.current_status = "idle";
      session.status = "idle";
      session.latest_codex_message = response;
      upsertSession(session);
      appendOrchestratorEvent({
        scope: "task_graph",
        scope_id: pending.target_task_graph_id ?? session.session_id,
        type: "multi_worker.execution.cancelled",
        message: response,
        data: { pending, decision: "rejected" },
      });
      return { response, session_id: session.session_id, handled: true };
    }
    if (!isTaskSplitApproval(cleaned)) {
      const projectIntake = await handleNewProjectIntent(session, cleaned);
      if (projectIntake) return projectIntake;

      const project = pending.target_project_id ? getProject(pending.target_project_id) : session.project_id ? getProject(session.project_id) : null;
      const workerMode = requestedWorkerMode(cleaned)
        ?? pendingDecision?.recommended_worker_mode
        ?? pending.worker_mode
        ?? session.preferred_worker_mode
        ?? getOrchestratorSettings().default_worker_mode;
      const workerCount = requestedWorkerCount(cleaned)
        ?? pendingDecision?.recommended_worker_count
        ?? null;
      const updatedGoal = appendPreApprovalUserUpdate(pending.original_user_goal, cleaned);
      let planning: Awaited<ReturnType<typeof agenticPlanningController.decide>>;
      try {
        planning = await agenticPlanningController.decide({
          session,
          userMessage: pendingRevisionPrompt({ ...pending, original_user_goal: updatedGoal }, pendingDecision, cleaned),
          project,
          workerMode,
        });
      } catch (error) {
        const response = `I could not revise the pending plan because the local planner failed: ${error instanceof Error ? error.message : String(error)}`;
        session.latest_codex_message = response;
        upsertSession(session);
        appendOrchestratorEvent({
          scope: "planning",
          scope_id: pending.planning_decision_id ?? session.session_id,
          type: "planner.plan.revision_failed",
          message: response,
          data: { session_id: session.session_id, pending_action: pending.type },
        });
        return { response, session_id: session.session_id, handled: true };
      }
      const latest = getSession(session.session_id) ?? session;
      const latestPending = latest.pending_action ?? pending;
      const plannedDecision = planning.decision;
      const revisedWorkerCount = workerMode === LOCAL_CODEX_BACKEND ? 1 : workerCount ?? plannedDecision.recommended_worker_count;
      const revisedBase: PlannerDecision = {
        ...plannedDecision,
        decision_type: "revise_plan",
        recommended_worker_count: revisedWorkerCount,
        recommended_worker_mode: workerMode,
        requires_user_approval: true,
        execution_allowed: false,
        next_action: "none",
        reason: plannedDecision.reason || "The user revised or clarified the pending plan before approval.",
        approval_reason: plannedDecision.approval_reason || "The revised execution plan still needs approval before workers launch.",
      };
      const revisedProject = latestPending.target_project_id ? getProject(latestPending.target_project_id) : project;
      const revisedWithAdvice = workerMode === LOCAL_CODEX_BACKEND && revisedProject
        ? withSubagentAdvice({
          session: latest,
          project: revisedProject,
          userGoal: updatedGoal,
          decision: revisedBase,
        })
        : revisedBase;
      const revised: PlannerDecision = {
        ...revisedWithAdvice,
        user_visible_response: pendingRevisionResponse(revisedWithAdvice),
      };
      updatePendingPlannerDecision(latest, latestPending, revised, updatedGoal);
      const revisedMegaplan = revisedProject && (workerMode === LOCAL_CODEX_BACKEND || revised.recommended_worker_mode === LOCAL_CODEX_BACKEND)
        ? writeMegaplan({ session: latest, project: revisedProject, userGoal: updatedGoal, decision: revised })
        : null;
      latest.current_status = "waiting_for_approval";
      latest.status = "waiting_for_approval";
      latest.latest_codex_message = revisedMegaplan ? localCodexApprovalMessage(revised, revisedMegaplan, revisedProject) : revised.user_visible_response;
      upsertSession(latest);
      appendOrchestratorEvent({
        scope: "planning",
        scope_id: revised.planning_decision_id ?? latest.session_id,
        type: revisedMegaplan ? "megaplan.revised" : "planner.plan.revised",
        message: latest.latest_codex_message,
        data: { session_id: latest.session_id, decision: revised, megaplan: revisedMegaplan },
      });
      return { response: latest.latest_codex_message, session_id: latest.session_id, handled: true, decision: revised };
    }
    if (!pending.target_task_graph_id) {
      const decision = pendingDecision;
      const project = pending.target_project_id ? getProject(pending.target_project_id) : session.project_id ? getProject(session.project_id) : null;
      if (!decision || !project) {
        const response = "I cannot start that split because no approved planner decision or project was recorded.";
        clearPendingAction(session);
        session.latest_codex_message = response;
        upsertSession(session);
        return { response, session_id: session.session_id, handled: true };
      }
      if (pending.worker_mode === LOCAL_CODEX_BACKEND || decision.recommended_worker_mode === LOCAL_CODEX_BACKEND) {
        const approvedDecision: PlannerDecision = { ...decision, recommended_worker_mode: LOCAL_CODEX_BACKEND, recommended_worker_count: 1 };
        const approvedPlan = agenticPlanningController.approvedPlan(approvedDecision, channel);
        const latest = getSession(session.session_id) ?? session;
        clearPendingAction(latest);
        latest.approved_plan = approvedPlan;
        latest.approval_status = "approved";
        latest.user_approved_worker_count = 1;
        latest.user_approved_worker_mode = LOCAL_CODEX_BACKEND;
        latest.current_project_id = project.project_id;
        latest.project_id = project.project_id;
        latest.latest_codex_message = "Approved local implementation plan. Starting one local Codex CLI orchestrator session.";
        upsertSession(latest);
        upsertProject({
          ...project,
          approved_plan: approvedPlan,
          approval_status: "approved",
          user_approved_worker_count: 1,
          user_approved_worker_mode: LOCAL_CODEX_BACKEND,
          updated_at: new Date().toISOString(),
        });
        const { task } = startLocalCodexSession({
          session: latest,
          project,
          userGoal: pending.original_user_goal,
          plannerDecision: approvedDecision,
          approvedPlan,
        });
        appendOrchestratorEvent({
          scope: "planning",
          scope_id: approvedPlan.planning_decision_id,
          type: "planner.plan.approved",
          message: `Approved local Codex plan ${approvedPlan.planning_decision_id}.`,
          data: { session_id: latest.session_id, project_id: project.project_id, task_id: task.task_id, approved_plan: approvedPlan },
        });
        return {
          response: `Approved plan. Built by one local Codex orchestrator session: started task ${task.task_id}.`,
          session_id: latest.session_id,
          handled: true,
          result: { task, approved_plan: approvedPlan, worker_ids: [] },
        };
      }
      const started = await agenticPlanningController.createApprovedGraphAndStart({
        session,
        project,
        userGoal: pending.original_user_goal,
        decision,
        channel,
      });
      const first = started.assignments[0] ?? null;
      const latest = getSession(session.session_id) ?? session;
      clearPendingAction(latest);
      latest.latest_codex_message = `Approved planner split. Created task graph ${started.graph.task_graph_id} and started ${started.assignments.length} worker assignment(s).`;
      if (first) {
        latest.active_task_id = first.task.task_id;
        latest.active_worker_id = first.worker.worker_id;
        latest.current_status = "running";
        latest.status = "running";
        latest.latest_plan = first.task.plan;
      }
      upsertSession(latest);
      return { response: latest.latest_codex_message, session_id: latest.session_id, handled: true, result: started };
    }
    const workerMode = pending.worker_mode ?? session.preferred_worker_mode ?? getOrchestratorSettings().default_worker_mode;
    const started = await multiWorkerCoordinator.startReadyWork(pending.target_task_graph_id, workerMode);
    const first = started.assignments[0] ?? null;
    clearPendingAction(session);
    if (first) {
      session.active_task_id = first.task.task_id;
      session.active_worker_id = first.worker.worker_id;
      session.current_status = "running";
      session.status = "running";
      session.latest_plan = first.task.plan;
    }
    session.latest_codex_message = `Approved task split ${pending.target_task_graph_id}. Started ${started.assignments.length} worker assignment(s).`;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
    return { response: session.latest_codex_message, session_id: session.session_id, handled: true, result: started };
  }

  if (pending.type === "choose_worker_mode") {
    const mode = requestedWorkerMode(cleaned);
    if (!mode) {
      const response = "Choose one worker mode: local, Docker local, GCP VM, or GKE Job.";
      rememberConversationMessage(session, "user", cleaned, channel);
      rememberConversationMessage(session, "assistant", response, channel);
      session.latest_codex_message = response;
      upsertSession(session);
      return { response, session_id: session.session_id, handled: true };
    }
    clearPendingAction(session);
    session.preferred_worker_mode = mode;
    const settings = updateOrchestratorSettings({ default_worker_mode: mode });
    session.latest_codex_message = `Future tasks will use ${workerModeLabel(mode)} worker mode.`;
    upsertSession(session);
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: "worker-mode",
      type: "worker.mode.selected",
      message: `Conversation selected ${mode} worker mode for future tasks.`,
      data: { settings, session_id: session.session_id },
    });
    return { response: session.latest_codex_message, session_id: session.session_id, handled: true, settings };
  }

  if (pending.type === "approve_operator_action") {
    if (/^(explain first|explain|why|why first)$/i.test(cleaned)) {
      const response = `${pending.action ?? "This action"} needs approval because ${pending.reason ?? "it can change live worker or task state"}. Risk: ${pending.risk_level ?? "medium"}.`;
      session.latest_codex_message = response;
      upsertSession(session);
      return { response, session_id: session.session_id, handled: true };
    }
    if (/^(no|reject|deny|cancel|do not|don't)$/i.test(cleaned)) {
      if (!pending.operator_action_id) {
        clearPendingAction(session);
        session.latest_codex_message = `Rejected: ${pending.action ?? "requested action"}.`;
        upsertSession(session);
        return { response: session.latest_codex_message, session_id: session.session_id, handled: true };
      }
      const result = rejectOperatorAction(pending.operator_action_id);
      return { response: result.response, session_id: session.session_id, handled: true, result };
    }
    if (!/^(yes|approve|approved|go ahead|do it|confirm)$/i.test(cleaned)) {
      const response = `Approval is still pending for ${pending.action ?? "the requested action"}. Say "approve", "reject", or "explain first".`;
      session.latest_codex_message = response;
      upsertSession(session);
      return { response, session_id: session.session_id, handled: true };
    }
    if (!pending.operator_action_id) {
      clearPendingAction(session);
      session.latest_codex_message = `Approved ${pending.action ?? "the requested action"}, but no operator action id was recorded.`;
      upsertSession(session);
      return { response: session.latest_codex_message, session_id: session.session_id, handled: true };
    }
    const result = await approveOperatorAction(pending.operator_action_id);
    return { response: result.response, session_id: session.session_id, handled: true, result };
  }

  if (pending.type === "approve_gcp_action" || pending.type === "confirm_deploy") {
    if (/^(no|reject|deny|cancel|stop|do not|don't)$/i.test(cleaned)) {
      const response = `Rejected: ${pending.action ?? "requested action"}.`;
      clearPendingAction(session);
      session.latest_codex_message = response;
      upsertSession(session);
      appendOrchestratorEvent({
        scope: "approval",
        scope_id: pending.approval_id ?? session.session_id,
        type: "approval.resolved",
        message: response,
        data: { pending, decision: "rejected" },
      });
      return { response, session_id: session.session_id, handled: true };
    }

    if (/^(explain first|explain|why|why first)$/i.test(cleaned)) {
      const response = `${pending.action ?? "This action"} needs approval because ${pending.reason ?? "it changes cloud worker state"}. Risk: ${pending.risk_level ?? "medium"}.`;
      session.latest_codex_message = response;
      upsertSession(session);
      return { response, session_id: session.session_id, handled: true };
    }

    if (!/^(yes|approve|approved|go ahead|do it|confirm)$/i.test(cleaned)) {
      const response = `Approval is still pending for ${pending.action ?? "the requested action"}. Say "approve", "reject", or "explain first".`;
      session.latest_codex_message = response;
      upsertSession(session);
      return { response, session_id: session.session_id, handled: true };
    }

    if (pending.action === "cleanup_expired_workers") {
      const result = await cleanupExpiredWorkersViaMcp({ max_age_minutes: 60 });
      clearPendingAction(session);
      session.latest_codex_message = `Approved cleanup. Stopped workers: ${result.workers_stopped.length ? result.workers_stopped.join(", ") : "none"}. Deleted workers: ${result.workers_deleted.length ? result.workers_deleted.join(", ") : "none"}.`;
      upsertSession(session);
      appendOrchestratorEvent({
        scope: "approval",
        scope_id: pending.approval_id ?? session.session_id,
        type: "approval.resolved",
        message: "Approved cleanup_expired_workers.",
        data: { pending, result },
      });
      return { response: session.latest_codex_message, session_id: session.session_id, handled: true, result };
    }

    if (pending.action === "use_gcp_vm_workers" || pending.action === "use_gke_job_workers") {
      const approvedMode = pending.worker_mode === "gke_job" ? "gke_job" : "gcp_vm";
      const settings = updateOrchestratorSettings({ default_worker_mode: approvedMode });
      clearPendingAction(session);
      session.preferred_worker_mode = approvedMode;
      session.current_status = "idle";
      session.status = "idle";
      session.latest_codex_message = `Approved ${workerModeLabel(approvedMode)} worker mode for future launches. I did not start a worker until there is an approved task plan.`;
      upsertSession(session);
      appendOrchestratorEvent({
        scope: "approval",
        scope_id: pending.approval_id ?? session.session_id,
        type: "approval.resolved",
        message: `Approved ${workerModeLabel(approvedMode)} worker mode.`,
        data: { pending, settings },
      });
      return { response: session.latest_codex_message, session_id: session.session_id, handled: true, settings };
    }

    const response = `Approved ${pending.action ?? "the requested action"}, but no deterministic executor is registered for it yet.`;
    clearPendingAction(session);
    session.latest_codex_message = response;
    upsertSession(session);
    return { response, session_id: session.session_id, handled: true };
  }

  return null;
}

async function handleConversationControl(session: SessionState, cleaned: string, channel?: Channel) {
  const operatorAction = await actionRouter.executeParsed(session.session_id, cleaned);
  if (operatorAction) {
    const latest = getSession(session.session_id);
    if (latest) {
      latest.latest_codex_message = operatorAction.response;
      latest.last_updated = new Date().toISOString();
      upsertSession(latest);
    }
    return {
      response: operatorAction.response,
      session_id: session.session_id,
      project_id: operatorAction.action.project_id ?? session.project_id ?? undefined,
      task_id: operatorAction.action.task_id ?? undefined,
      worker_id: operatorAction.action.worker_id ?? undefined,
      handled: true,
      action: operatorAction.action,
    };
  }

  if (isPreviewRequest(cleaned)) {
    const result = await startPreviewForSession(session.session_id);
    const response = previewChatResponse(result);
    const latest = getSession(session.session_id);
    if (latest) {
      pushSessionEvent(latest, {
        ts: new Date().toISOString(),
        source: "codex",
        type: result.ok ? "preview.ready" : "preview.failed",
        message: response,
        data: result.ok ? { preview_id: result.preview.preview_id, task_id: result.task.task_id, project_id: result.project.project_id, preview_url: result.preview.preview_url } : result,
      });
      upsertSession(latest);
    }
    return {
      response,
      session_id: session.session_id,
      project_id: result.ok ? result.project.project_id : session.project_id ?? undefined,
      handled: true,
      ...(result.ok ? { preview: result.preview } : {}),
    };
  }

  const statusAnswer = answerConversationStateQuestion(session, cleaned, channel);
  if (statusAnswer) return { response: statusAnswer, session_id: session.session_id, project_id: session.project_id ?? undefined, handled: true };

  const mode = requestedWorkerMode(cleaned);
  const implementationIntent = /\b(build|create|make|add|update|fix|implement|scaffold|generate)\b/i.test(cleaned);
  if (mode && !implementationIntent && /\b(use|switch|run|mode|future|next)\b/i.test(cleaned)) {
    if (!getOrchestratorSettings().allow_worker_mode_switch) {
      return { response: "Worker mode switching is disabled by configuration.", session_id: session.session_id, handled: true };
    }
    if ((mode === "gcp_vm" || mode === "gke_job") && !/\b(future|default|next tasks?)\b/i.test(cleaned)) {
      const approvalId = randomUUID();
      setPendingAction(session, {
        type: "approve_gcp_action",
        original_user_goal: cleaned,
        requested_kind: "tool",
        action: mode === "gke_job" ? "use_gke_job_workers" : "use_gcp_vm_workers",
        reason: `${workerModeLabel(mode)} worker execution can create or use cloud compute resources.`,
        risk_level: "medium",
        approval_id: approvalId,
        worker_mode: mode,
        created_at: new Date().toISOString(),
      });
      session.latest_codex_message = `Running this on ${workerModeLabel(mode)} workers needs approval before launch. Approve ${workerModeLabel(mode)} worker execution?`;
      session.current_status = "waiting_for_approval";
      session.status = "waiting_for_approval";
      upsertSession(session);
      appendOrchestratorEvent({
        scope: "approval",
        scope_id: approvalId,
        type: "approval.requested",
        message: session.latest_codex_message,
        data: session.pending_action,
      });
      return { response: session.latest_codex_message, session_id: session.session_id, handled: true, approval_id: approvalId };
    }
    const activeWorker = activeWorkerForSession(session);
    const settings = updateOrchestratorSettings({ default_worker_mode: mode });
    session.preferred_worker_mode = mode;
    session.latest_codex_message = `Future tasks will use ${workerModeLabel(mode)} worker mode.`;
    upsertSession(session);
    appendOrchestratorEvent({
      scope: "worker",
      scope_id: "worker-mode",
      type: "worker.mode.selected",
      message: `Conversation selected ${mode} worker mode for future tasks.`,
      data: { settings, session_id: session.session_id, active_worker_id: activeWorker?.worker_id ?? null },
    });
    const activeText = activeWorker
      ? ` Active task remains on ${activeWorker.type} worker ${activeWorker.worker_id}; I did not stop it.`
      : "";
    return {
      response: `Future tasks will use ${workerModeLabel(mode)} worker mode.${activeText}`,
      session_id: session.session_id,
      handled: true,
      settings,
    };
  }

  if (/\bwhat\b[\s\S]*\bgcp\b[\s\S]*\bworkers?\b|\bgcp\b[\s\S]*\bworkers?\b[\s\S]*\brunning\b/i.test(cleaned)) {
    const result = await listGcpWorkersViaMcp({ env: config.orchestrator.environment });
    const workers = result.active_vm_workers;
    return {
      response: workers.length
        ? `GCP workers running or recorded: ${workers.map((worker: Record<string, unknown>) => String(worker.vm_name ?? worker.name ?? worker.worker_id ?? "unknown")).join(", ")}.`
        : "No active GCP VM workers are recorded for this environment.",
      session_id: session.session_id,
      handled: true,
      result,
    };
  }

  if (/\b(clean up|cleanup)\b[\s\S]*\b(workers?|expired workers?|vms?)\b/i.test(cleaned)) {
    const approvalId = randomUUID();
    setPendingAction(session, {
      type: "approve_gcp_action",
      original_user_goal: cleaned,
      requested_kind: "tool",
      action: "cleanup_expired_workers",
      reason: "Cleanup can stop cloud workers and should be confirmed in conversation.",
      risk_level: "medium",
      approval_id: approvalId,
      created_at: new Date().toISOString(),
    });
    session.latest_codex_message = "Cleanup can stop cloud workers. Approve cleanup of expired workers?";
    upsertSession(session);
    appendOrchestratorEvent({
      scope: "approval",
      scope_id: approvalId,
      type: "approval.requested",
      message: session.latest_codex_message,
      data: session.pending_action,
    });
    return { response: session.latest_codex_message, session_id: session.session_id, handled: true, approval_id: approvalId };
  }

  if (/\b(check|show|inspect)\b[\s\S]*\blogs?\b/i.test(cleaned)) {
    const worker = activeWorkerForSession(session);
    if (worker) {
      const result = await inspectWorkerViaMcp({ worker_id: worker.worker_id });
      return {
        response: result.logs.length
          ? `Worker ${worker.worker_id} logs: ${result.logs.slice(-5).join(" | ")}`
          : `Worker ${worker.worker_id} has no command log summaries yet.`,
        session_id: session.session_id,
        handled: true,
        result,
      };
    }
    const task = activeTaskForSession(session);
    if (task) {
      const result = await inspectTaskStateViaMcp({ task_id: task.task_id });
      return {
        response: `Task ${task.task_id} is ${result.task_status}. Commands recorded: ${result.commands.length}.`,
        session_id: session.session_id,
        handled: true,
        result,
      };
    }
  }

  if (/^(please\s+)?deploy\b[\s\S]*(it|this|the app|this app|app|publicly|public endpoint)?\.?$/i.test(cleaned.trim())) {
    const approvalId = randomUUID();
    setPendingAction(session, {
      type: "confirm_deploy",
      original_user_goal: cleaned,
      requested_kind: "tool",
      action: "deploy",
      reason: "Deploying may expose a public service or mutate cloud infrastructure.",
      risk_level: "high",
      approval_id: approvalId,
      created_at: new Date().toISOString(),
    });
    session.latest_codex_message = "Deploying may expose a public endpoint or mutate cloud infrastructure. Approve deploy?";
    upsertSession(session);
    appendOrchestratorEvent({
      scope: "approval",
      scope_id: approvalId,
      type: "approval.requested",
      message: session.latest_codex_message,
      data: session.pending_action,
    });
    return { response: session.latest_codex_message, session_id: session.session_id, handled: true, approval_id: approvalId };
  }

  if (/\bretry\b[\s\S]*(failed|step|command)?/i.test(cleaned)) {
    const failed = latestFailedCommand(session);
    if (!failed) return { response: "There is no failed command recorded to retry.", session_id: session.session_id, handled: true };
    return {
      response: `The failed step was ${failed.command}. I can retry it through the active worker after you explicitly ask to rerun that command.`,
      session_id: session.session_id,
      handled: true,
      command_event_id: failed.event_id,
    };
  }

  return null;
}

export async function handleSupervisorMessage(sessionId: string, text: string, channel?: Channel) {
  const session = getSession(sessionId);
  if (!session) return { response: "I cannot find that Codex session.", handled: false, error: "Session not found." };

  const cleaned = text.trim();
  if (!cleaned) return { response: "Send a project name, status question, approval decision, or Codex instruction.", handled: false };
  rememberConversationMessage(session, "user", cleaned, channel);
  syncConversationState(session);
  upsertSession(session);
  appendAuditEvent({
    session_id: sessionId,
    ts: new Date().toISOString(),
    source: "user",
    type: "call.message",
    message: cleaned,
  });
  appendOrchestratorEvent({
    scope: "session",
    scope_id: sessionId,
    type: "session.message.received",
    message: cleaned,
    data: { channel: channel ?? session.channel, session_id: sessionId },
  });
  appendOrchestratorEvent({
    scope: "session",
    scope_id: sessionId,
    type: "orchestrator.decision.started",
    message: `Resolving conversation turn for session ${sessionId}.`,
    data: {
      pending_action: session.pending_action,
      active_task_id: session.active_task_id,
      active_worker_id: session.active_worker_id,
    },
  });

  const pendingConversation = await handlePendingConversationAction(session, cleaned, channel);
  if (pendingConversation) return finalConversationResponse(sessionId, pendingConversation, channel);

  const conversationControl = await handleConversationControl(session, cleaned, channel);
  if (conversationControl) return finalConversationResponse(sessionId, conversationControl, channel);

  const newProject = await handleNewProjectIntent(session, cleaned);
  if (newProject) return finalConversationResponse(sessionId, newProject, channel);

  if (session.project_discovery.status !== "selected") {
    return finalConversationResponse(sessionId, await handleProjectDiscovery(session, cleaned), channel);
  }

  const direct = answerStateQuestion(session, cleaned);
  if (direct) return finalConversationResponse(sessionId, { response: direct, session_id: sessionId, handled: true }, channel);

  const readOnlyResponse = readOnlyConversationResponse(cleaned);
  if (readOnlyResponse) {
    const latest = getSession(sessionId);
    if (latest) {
      latest.latest_codex_message = readOnlyResponse;
      pushSessionEvent(latest, {
        ts: new Date().toISOString(),
        source: "codex",
        type: "supervisor.development.answer",
        message: readOnlyResponse,
        data: { reason: "Read-only conversation turn; no implementation requested." },
      });
      upsertSession(latest);
    }
    return finalConversationResponse(sessionId, { response: readOnlyResponse, session_id: sessionId, handled: true }, channel, "supervisor.development.answer");
  }

  const pending = session.pending_approvals.find((item) => item.status === "pending");
  if (/^(approve it|approve|yes approve|go ahead)$/i.test(cleaned)) {
    if (!pending) return finalConversationResponse(sessionId, { response: "There is no pending approval.", session_id: sessionId, handled: true }, channel);
    const result = respond_to_approval(sessionId, pending.id, "approved", channel);
    return finalConversationResponse(sessionId, {
      response: `Approved: ${pending.command}. I sent Codex back to continue.`,
      session_id: sessionId,
      handled: true,
      result,
    }, channel);
  }

  if (/^(deny it|deny|no deny|do not approve)$/i.test(cleaned)) {
    if (!pending) return finalConversationResponse(sessionId, { response: "There is no pending approval.", session_id: sessionId, handled: true }, channel);
    const result = respond_to_approval(sessionId, pending.id, "denied", channel);
    return finalConversationResponse(sessionId, {
      response: `Denied: ${pending.command}. Codex will not run that action.`,
      session_id: sessionId,
      handled: true,
      result,
    }, channel);
  }

  try {
    const developmentRequest = cleaned.replace(/^tell codex to /i, "");
    const selectedProject = session.project_id ? getProject(session.project_id) : null;
    const selectedWorkerType = session.preferred_worker_mode ?? getOrchestratorSettings().default_worker_mode;
    const implementationRequest = hasImplementationRequest(developmentRequest);
    const planningPreferred = selectedWorkerType !== "local" || /\b(multi-worker|workers?|task split|static|saas|dashboard|gcp)\b/i.test(developmentRequest);
    if (selectedProject && implementationRequest && planningPreferred) {
      const planned = await startWorkerBackedProject({
        session,
        project: selectedProject,
        displayName: selectedProject.display_name,
        targetPath: selectedProject.workspace_path,
        description: developmentRequest,
        workerType: selectedWorkerType,
        selectedExistingProject: true,
      });
      return finalConversationResponse(sessionId, {
        response: planned.message ?? "Planner handled the implementation request.",
        session_id: sessionId,
        project_id: selectedProject.project_id,
        handled: true,
        result: planned,
      }, channel, "planner.execution.routed");
    }
    return finalConversationResponse(sessionId, await handleDevelopmentTurn(session, developmentRequest, channel), channel);
  } catch (error) {
    const latest = getSession(sessionId);
    const message = error instanceof Error ? error.message : String(error);
    if (latest) {
      latest.errors.push(message);
      latest.latest_codex_message = "Supervisor development routing failed.";
      pushSessionEvent(latest, {
        ts: new Date().toISOString(),
        source: "system",
        type: "supervisor.development.failed",
        message,
      });
      upsertSession(latest);
    }
    return finalConversationResponse(sessionId, {
      response: "I could not safely decide the next development step. I kept the session unchanged; please restate the request with one concrete goal.",
      session_id: sessionId,
      handled: false,
      error: "SUPERVISOR_DECISION_FAILED",
    }, channel);
  }
}
