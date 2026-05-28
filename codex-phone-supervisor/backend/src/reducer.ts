import { randomUUID } from "node:crypto";
import type { ApprovalKind, CodexStructuredReport, SessionState, SupervisorEvent } from "./types.js";

function uniq(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

const approvalKindAliases: Record<string, ApprovalKind> = {
  shell_command: "shell",
  shell_commands: "shell",
  command: "shell",
  commands: "shell",
  file_delete: "delete",
  deletion: "delete",
  gitpush: "git_push",
  gcp: "gcp_resource",
  twilio: "twilio_mutation",
  secret: "secret_access",
  credential: "secret_access",
  billing: "payment_or_billing",
  payment: "payment_or_billing",
};

function normalizeApprovalKind(kind: string): ApprovalKind {
  const normalized = kind.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (approvalKindAliases[normalized]) return approvalKindAliases[normalized];
  const allowed: ApprovalKind[] = [
    "shell",
    "network",
    "install",
    "delete",
    "deploy",
    "git_push",
    "secret_access",
    "external_repo",
    "gcp_resource",
    "twilio_mutation",
    "payment_or_billing",
  ];
  if (allowed.includes(normalized as ApprovalKind)) return normalized as ApprovalKind;
  return "shell";
}

export function applySupervisorEvent(session: SessionState, event: SupervisorEvent) {
  session.raw_events = [...session.raw_events, event].slice(-400);
  session.last_updated = event.ts;
  return session;
}

export function mergeCodexReport(session: SessionState, report: CodexStructuredReport, ts: string) {
  session.latest_codex_message = report.latest_codex_message || report.summary || session.latest_codex_message;
  session.files_read = uniq([...session.files_read, ...report.files_read]);
  session.files_modified = uniq([...session.files_modified, ...report.files_modified]);
  session.commands_requested = uniq([...session.commands_requested, ...report.commands_requested]);
  session.commands_completed = uniq([...session.commands_completed, ...report.commands_completed]);
  session.commands_failed = uniq([...session.commands_failed, ...report.commands_failed]);
  session.test_results = report.test_results;
  session.errors = uniq([...session.errors, ...report.errors]);
  session.summary_text = report.summary || session.summary_text;
  session.current_status =
    report.status === "needs_approval"
      ? "waiting_for_approval"
      : report.status === "failed"
        ? "failed"
        : report.status === "completed"
          ? "completed"
          : session.current_status;
  session.status = session.current_status;

  if (report.approval_requests.length) {
    session.pending_approvals = [
      ...session.pending_approvals,
      ...report.approval_requests.map((request) => ({
        id: randomUUID(),
        kind: normalizeApprovalKind(request.kind),
        command: request.command,
        reason: request.reason,
        risk: request.risk,
        status: "pending" as const,
        requested_at: ts,
        project_id: session.project_id ?? undefined,
        session_id: session.session_id,
      })),
    ];
  }

  session.last_updated = ts;
  return session;
}
