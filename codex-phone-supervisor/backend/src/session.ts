import { randomUUID } from "node:crypto";
import type { ProjectDiscoveryState, SessionState } from "./types.js";

export function initialProjectDiscoveryState(): ProjectDiscoveryState {
  return {
    status: "collecting",
    selected_workspace_path: null,
    selected_project_name: null,
    confidence: null,
    reason: "",
    last_question: "Which project should I attach this Codex session to?",
    conversation: [],
  };
}

export function ensureSessionShape(session: SessionState): SessionState {
  session.project_discovery ??= initialProjectDiscoveryState();
  session.project_id ??= null;
  session.current_project_id ??= session.project_id;
  session.active_task_id ??= null;
  session.active_worker_id ??= null;
  session.user_id ??= null;
  session.channel ??= null;
  session.pending_action ??= null;
  session.pending_action_payload ??= null;
  session.latest_summary ??= session.summary_text ?? "";
  session.latest_plan ??= [];
  session.preferred_worker_mode ??= null;
  session.recent_messages ??= [];
  session.created_at ??= session.last_updated ?? new Date().toISOString();
  session.status ??= session.current_status ?? "idle";
  session.requirement_summary ??= null;
  session.planning_decision_id ??= null;
  session.planner_model ??= null;
  session.planner_output ??= null;
  session.approved_plan ??= null;
  session.approval_status ??= null;
  session.open_questions ??= [];
  session.assumptions ??= [];
  session.design_decision_history ??= [];
  session.user_approved_worker_count ??= null;
  session.user_approved_worker_mode ??= null;
  session.codex_conversation_session_id ??= null;
  session.codex_conversation_resume_command ??= null;
  session.codex_conversation_mirrored_at ??= null;
  session.codex_conversation_mirror_error ??= null;
  return session;
}

export function createSession(activeTask: string, workspacePath: string): SessionState {
  const now = new Date().toISOString();
  return {
    session_id: randomUUID(),
    user_id: null,
    channel: null,
    active_task: activeTask,
    active_task_id: null,
    active_worker_id: null,
    current_project_id: null,
    current_status: "idle",
    status: "idle",
    latest_codex_message: "",
    files_read: [],
    files_modified: [],
    commands_requested: [],
    commands_completed: [],
    commands_failed: [],
    pending_approvals: [],
    test_results: [],
    errors: [],
    git_diff_summary: "",
    raw_events: [],
    last_updated: now,
    workspace_path: workspacePath,
    project_id: null,
    pending_action: null,
    pending_action_payload: null,
    created_at: now,
    summary_text: "",
    latest_summary: "",
    latest_plan: [],
    preferred_worker_mode: null,
    recent_messages: [],
    instruction_history: [],
    project_discovery: initialProjectDiscoveryState(),
    requirement_summary: null,
    planning_decision_id: null,
    planner_model: null,
    planner_output: null,
    approved_plan: null,
    approval_status: null,
    open_questions: [],
    assumptions: [],
    design_decision_history: [],
    user_approved_worker_count: null,
    user_approved_worker_mode: null,
    codex_conversation_session_id: null,
    codex_conversation_resume_command: null,
    codex_conversation_mirrored_at: null,
    codex_conversation_mirror_error: null,
  };
}
