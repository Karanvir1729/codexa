import { config } from "./config.js";
import { createSession } from "./session.js";
import { appendAuditEvent, appendOrchestratorEvent, getSession, upsertSession } from "./store.js";
import { getProject } from "./project-store.js";
import { handleSupervisorMessage, select_project } from "./supervisor-tools.js";
import type { AgentResponse, Channel, UserMessage } from "./types.js";

export const channels: readonly Channel[] = ["web_text", "web_voice", "sms", "phone", "operator", "twilio_sms", "twilio_call"] as const;

export class AgentRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function publicChannelFor(channel: Channel) {
  if (channel === "twilio_sms") return "sms";
  if (channel === "twilio_call") return "phone";
  return channel;
}

export function isChannel(value: string): value is Channel {
  return channels.includes(value as Channel);
}

function createDiscoverySession(message: UserMessage) {
  const session = createSession("Project discovery", config.defaultWorkspacePath);
  session.user_id = message.userId;
  session.channel = message.channel;
  session.summary_text = "Project discovery is waiting for the user to identify the workspace.";
  session.latest_codex_message = session.project_discovery.last_question;
  session.instruction_history.push({ ts: message.timestamp, text: message.text, source: "call" });
  upsertSession(session);
  appendAuditEvent({
    session_id: session.session_id,
    ts: message.timestamp,
    source: "system",
    type: "agent.session.created",
    message: `Created ${message.channel} session for ${message.userId}.`,
    data: {
      channel: message.channel,
      user_id: message.userId,
      external_conversation_id: message.externalConversationId,
    },
  });
  appendOrchestratorEvent({
    scope: "session",
    scope_id: session.session_id,
    type: "session.created",
    message: `Created ${message.channel} conversation session.`,
    data: {
      channel: message.channel,
      user_id: message.userId,
      external_conversation_id: message.externalConversationId,
      session,
    },
  });
  return session;
}

function resolveSession(message: UserMessage) {
  if (message.sessionId) {
    const session = getSession(message.sessionId);
    if (!session) throw new AgentRequestError("SESSION_NOT_FOUND", "Session not found.", 404);
    session.user_id = session.user_id ?? message.userId;
    session.channel = session.channel ?? message.channel;
    upsertSession(session);
    return session;
  }

  if (message.projectId) {
    const project = getProject(message.projectId);
    if (!project) throw new AgentRequestError("PROJECT_NOT_FOUND", "Project not found.", 404);
    if (project.last_active_session_id) {
      const active = getSession(project.last_active_session_id);
      if (active) return active;
    }
    const session = createDiscoverySession(message);
    const result = select_project(project.project_id, session.session_id);
    if ("error" in result) throw new AgentRequestError("PROJECT_SELECTION_FAILED", "Could not attach the session to that project.", 409);
    return result.session;
  }

  return createDiscoverySession(message);
}

export async function handleUserMessage(message: UserMessage): Promise<AgentResponse> {
  if (!message.userId.trim()) throw new Error("userId is required.");
  if (!isChannel(message.channel)) throw new Error(`Unsupported channel: ${message.channel}`);
  if (!message.text.trim()) throw new Error("text is required.");
  if (!message.timestamp.trim()) throw new Error("timestamp is required.");

  const session = resolveSession(message);
  const result = await handleSupervisorMessage(session.session_id, message.text, message.channel);
  const resultSessionId = "session_id" in result ? result.session_id : undefined;
  const resultProjectId = "project_id" in result ? result.project_id : undefined;
  const response: AgentResponse = {
    text: result.response,
    sessionId: resultSessionId || session.session_id,
    projectId: resultProjectId || getSession(session.session_id)?.project_id || undefined,
  };
  const latest = getSession(response.sessionId!);
  response.taskId = latest?.active_task_id ?? undefined;
  response.workerId = latest?.active_worker_id ?? undefined;
  const pending = latest?.pending_approvals.find((approval) => approval.status === "pending");
  if (pending) {
    response.requiresApproval = true;
    response.approvalId = pending.id;
  }
  return response;
}
