import type { SessionState } from "./types.js";
import { getCodexAccessSummary } from "./access.js";

function latestPendingApproval(session: SessionState) {
  return session.pending_approvals.find((item) => item.status === "pending") ?? null;
}

function sentence(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function answerStateQuestion(session: SessionState, text: string) {
  const input = text.toLowerCase();
  const explicitStatusQuestion =
    input === "status" ||
    input.startsWith("status ") ||
    input.includes("codex status") ||
    input.includes("project status") ||
    input.includes("session status");
  if (
    input.includes("what is codex doing") ||
    input.includes("what's codex doing") ||
    input.includes("what is codex currently working on") ||
    input.includes("what's codex currently working on") ||
    input.includes("what is codex working on") ||
    input.includes("what's codex working on") ||
    input.includes("what is it working on") ||
    input.includes("what's it working on") ||
    explicitStatusQuestion
  ) {
    const approval = latestPendingApproval(session);
    const approvalText = approval ? ` Waiting for approval: ${approval.command}.` : "";
    return `Codex is ${session.current_status}. Active task: ${sentence(session.active_task || "none")} Latest update: ${sentence(session.latest_codex_message || "No update yet")}${approvalText}`;
  }
  if (input.includes("what changed")) {
    return session.files_modified.length
      ? `Files modified: ${session.files_modified.join(", ")}. ${session.git_diff_summary}`
      : "No file modifications have been recorded yet.";
  }
  if (input.includes("what project are we in") || input.includes("which project") || input.includes("current project")) {
    const projectName = session.project_discovery.selected_project_name || session.project_id || "not selected";
    return `Current project: ${projectName}. Workspace: ${session.workspace_path}.`;
  }
  if (input.includes("what files did it touch")) {
    const touched = [...new Set([...session.files_read, ...session.files_modified])];
    return touched.length ? `Touched files: ${touched.join(", ")}` : "No touched files recorded yet.";
  }
  if (input.includes("what commands did it run")) {
    return session.commands_completed.length
      ? `Completed commands: ${session.commands_completed.join(" | ")}`
      : "No completed commands recorded yet.";
  }
  if (input.includes("what approval is pending")) {
    const approval = latestPendingApproval(session);
    return approval ? `Pending approval: ${approval.command}. Reason: ${approval.reason}.` : "There is no pending approval.";
  }
  if (input.includes("why does it need that")) {
    const approval = latestPendingApproval(session);
    return approval ? `It needs approval for ${approval.command} because ${approval.reason}. Risk is ${approval.risk}.` : "There is no pending approval to explain.";
  }
  if (input.includes("what are the test failures")) {
    const failures = session.test_results.filter((item) => item.status === "failed");
    return failures.length ? failures.map((item) => `${item.name}: ${item.details || "failed"}`).join(" | ") : "No failed tests recorded.";
  }
  if (input.includes("what is stuck")) {
    const approval = latestPendingApproval(session);
    if (approval) return `Codex is waiting for approval on ${approval.command}.`;
    if (session.errors.length) return `Current blockers: ${session.errors.join(" | ")}`;
    return `Codex is not currently reporting a blocker. Status is ${session.current_status}.`;
  }
  if (input.includes("summarize the last run")) {
    return session.summary_text || session.latest_codex_message || "No prior run summary is available.";
  }
  if (input.includes("what can codex access")) {
    const access = getCodexAccessSummary(session.workspace_path);
    return `Workspace: ${access.workspace_path}. Repo: ${access.repo_name || "none"}. Branch: ${access.current_branch || "none"}. Codex installed: ${access.codex_cli_installed ? "yes" : "no"}. Approval is required for shell, network, and destructive actions.`;
  }
  return "";
}
