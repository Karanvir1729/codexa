import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import ExternalLink from "lucide-react/dist/esm/icons/external-link.js";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.js";
import RefreshCcw from "lucide-react/dist/esm/icons/refresh-ccw.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import Terminal from "lucide-react/dist/esm/icons/terminal.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import Workflow from "lucide-react/dist/esm/icons/workflow.js";

type SessionEvent = {
  id: string;
  ts: string;
  type: string;
  message: string;
  source: string;
  data?: unknown;
};

type Session = {
  session_id: string;
  project_id: string | null;
  current_project_id: string | null;
  active_task_id: string | null;
  channel: string | null;
  pending_action: { type?: string; action?: string | null } | null;
  active_task: string;
  current_status: string;
  latest_codex_message: string;
  files_modified: string[];
  commands_completed: string[];
  commands_failed: string[];
  summary_text: string;
  latest_summary: string;
  recent_messages: Array<{ ts: string; role: "user" | "assistant" | "system"; channel: string | null; text: string }>;
  raw_events: SessionEvent[];
  codex_conversation_session_id: string | null;
  codex_conversation_resume_command: string | null;
  codex_conversation_mirrored_at: string | null;
  codex_conversation_mirror_error: string | null;
  git_diff_summary: string;
  workspace_path: string;
};

type PreviewMetadata = {
  preview_url: string;
  status: string;
  loaded: boolean;
  summary: string;
};

type TaskRecord = {
  task_id: string;
  project_id: string;
  user_goal: string;
  status: string;
  latest_summary: string;
  next_steps: string[];
  latest_preview?: PreviewMetadata | null;
};

type RuntimeSettings = {
  model: string;
  reasoning_effort: string;
  planning_model: string;
  planning_reasoning_effort: string;
  access: string;
  shell_environment: string;
  account_config_plugins: string;
  conversation_resume_mirror: string;
  skill_inventory?: {
    status: string;
    total_discovered: number;
    critical_present: string[];
    critical_missing: string[];
  };
};

type FlowchartVisualState = "idle" | "planning" | "waiting_for_approval" | "completed" | "failed" | "running" | "warning";

type FlowchartNode = {
  id: string;
  type: string;
  label: string;
  status: string;
  visual_state: FlowchartVisualState;
  badges: string[];
  summary: string;
  detail: Record<string, unknown>;
};

type FlowchartState = {
  generated_at: string;
  nodes: FlowchartNode[];
  edges: Array<{ id: string; from: string; to: string; label: string }>;
};

type MegaplanRecord = {
  project_id: string;
  session_id: string;
  content: string;
  updated_at: string;
  repo: {
    name: string;
    web_url: string | null;
    branch: string | null;
    commit: string | null;
    remote_url: string | null;
  };
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  source: "app-text" | "app-voice" | "system";
  text: string;
  ts?: string;
  session_id?: string;
};

type ResetSupervisorSessionResponse = {
  session_id: string;
  session: Session;
  deleted_project: {
    deleted: boolean;
    state_removed: boolean;
    skipped_reason: string | null;
  };
};

class SupervisorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const supervisorApiBase = import.meta.env.VITE_SUPERVISOR_API_BASE?.trim() || "/supervisor-api";
const supervisorWorkspacePath = import.meta.env.VITE_SUPERVISOR_WORKSPACE_PATH?.trim() || "/Users/karanvirkhanna";
const supervisorUserId = import.meta.env.VITE_SUPERVISOR_USER_ID?.trim() || "browser-ui";
const sessionStorageKey = "codex-phone-supervisor-session";
const interactionStorageKey = "codex-phone-supervisor-builder-interactions";

const hiddenBuilderFlowTypes = new Set([
  "channel",
  "session",
  "project",
  "task",
  "planner_decision",
  "proposed_design",
  "task_split_proposal",
  "project_docs",
  "code_index",
  "function_docs",
  "variable_docs",
  "state_model_docs",
  "worker_handoff",
  "shared_docs",
  "task_graph",
  "task_graph_node",
  "worktree",
  "merge_review",
  "worker",
  "worker_control",
  "command",
  "artifact",
  "files_changed",
  "summary",
  "operator_action",
  "command_action",
  "log_inspection",
  "codex_history",
  "mcp_action"
]);

const pendingMegaplanFlowchartTypes = new Set([
  "user_request",
  "requirement_summary",
  "codex_plan",
  "subagent_advisor",
  "user_approval"
]);

function makeLocalId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isChatMessage(value: unknown): value is ChatMessage {
  const record = asRecord(value);
  return (
    typeof record.id === "string" &&
    (record.role === "user" || record.role === "assistant" || record.role === "system") &&
    (record.source === "app-text" || record.source === "app-voice" || record.source === "system") &&
    typeof record.text === "string"
  );
}

function loadSavedInteractions() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(interactionStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter(isChatMessage).slice(-200) : [];
  } catch {
    return [];
  }
}

function interactionContentKey(message: ChatMessage) {
  return `${message.session_id ?? ""}:${message.role}:${message.source}:${message.text.trim()}`;
}

function interactionDuplicateKey(message: ChatMessage) {
  if (message.role === "assistant" && (message.source === "system" || message.source === "app-text")) {
    return `${message.session_id ?? ""}:${message.role}:${message.text.trim()}`;
  }
  return interactionContentKey(message);
}

function mergeInteractions(current: ChatMessage[], incoming: ChatMessage[]) {
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  const merged: ChatMessage[] = [];
  for (const message of [...current, ...incoming]) {
    const contentKey = interactionDuplicateKey(message);
    if (seenIds.has(message.id) || seenContent.has(contentKey)) continue;
    seenIds.add(message.id);
    seenContent.add(contentKey);
    merged.push(message);
  }
  return merged.slice(-200);
}

function sourceForSessionMessage(message: Session["recent_messages"][number]): ChatMessage["source"] {
  if (message.role === "system") return "system";
  return message.channel === "web_voice" ? "app-voice" : "app-text";
}

function sessionMessagesToInteractions(session: Session): ChatMessage[] {
  return session.recent_messages.map((message, index) => ({
    id: `session:${session.session_id}:${message.ts}:${message.role}:${message.channel ?? "none"}:${index}`,
    role: message.role,
    source: sourceForSessionMessage(message),
    text: message.text,
    ts: message.ts,
    session_id: session.session_id
  }));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sanitizeFlowText(value: string) {
  return value
    .replace(/`([^`]*)`/g, (_match, snippet: string) => {
      const trimmed = snippet.trim();
      if (!trimmed) return "implementation detail";
      if (/(?:^|[\s(])(?:\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/]|[\w.-]+\/)/.test(trimmed)) return "project file";
      if (/\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|html|css|md|svg|png|jpe?g|webp|gif|ico|yml|yaml)\b/i.test(trimmed)) return "project file";
      if (/[$;&|<>]/.test(trimmed)) return "implementation detail";
      return trimmed.length <= 60 ? trimmed : "implementation detail";
    })
    .replace(/(?:^|[\s(])(?:\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/]|[\w.-]+\/)[^\s,;:)]+/g, " project file")
    .replace(/\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|html|css|md|svg|png|jpe?g|webp|gif|ico|yml|yaml)\b/gi, "project file")
    .replace(/\s+/g, " ")
    .trim();
}

function localFlowchartTaskId(nodeId: string) {
  return nodeId.match(/^codex_flow:(task_[^:]+):/)?.[1] ?? nodeId.match(/^codex_flow_pending:(task_[^:]+)/)?.[1] ?? "";
}

function visibleFlowchartNodes(flowchart: FlowchartState | null, taskIds: Set<string>, currentSessionId: string) {
  const hasTaskScopedNodes = (flowchart?.nodes ?? []).some((node) => {
    if (!node.id.startsWith("codex_flow:") && !node.id.startsWith("codex_flow_pending:")) return false;
    const taskId = localFlowchartTaskId(node.id);
    return Boolean(taskId && taskIds.has(taskId));
  });
  const hasPendingSessionPlanning = (flowchart?.nodes ?? []).some((node) => (
    Boolean(currentSessionId && String(asRecord(node.detail).session_id ?? "") === currentSessionId)
    && pendingMegaplanFlowchartTypes.has(node.type)
    && (/pending|waiting|needs|approval/i.test(node.status) || Boolean(asRecord(node.detail).pending_action))
  ));

  return (flowchart?.nodes ?? [])
    .filter((node) => {
      if (node.type === "orchestrator") return true;
      if (node.id.startsWith("codex_flow:") || node.id.startsWith("codex_flow_pending:")) {
        const taskId = localFlowchartTaskId(node.id);
        return Boolean(taskId && taskIds.has(taskId));
      }
      if (!pendingMegaplanFlowchartTypes.has(node.type)) return false;
      if (hasTaskScopedNodes || !hasPendingSessionPlanning) return false;
      return Boolean(currentSessionId && String(asRecord(node.detail).session_id ?? "") === currentSessionId);
    })
    .filter((node) => !hiddenBuilderFlowTypes.has(node.type))
    .map((node) => {
      const detail = asRecord(node.detail);
      if (node.type === "orchestrator") {
        return {
          ...node,
          label: "Codex CLI Orchestrator",
          badges: ["one local session", "direct CLI"],
          summary: "Owns the repo, talks with the user, and starts real Codex work."
        };
      }
      return {
        ...node,
        label: sanitizeFlowText(node.label),
        badges: node.badges.map(sanitizeFlowText).filter(Boolean).slice(0, 2),
        summary: sanitizeFlowText(node.summary),
        detail: {
          kind: detail.kind ?? node.type,
          status: sanitizeFlowText(String(detail.status ?? node.status)),
          summary: sanitizeFlowText(String(detail.summary ?? node.summary))
        }
      };
    });
}

function splitFlowLanes(nodes: FlowchartNode[]) {
  const subagents = nodes.filter((node) => node.type === "codex_subagent");
  const support = nodes.filter((node) => ["subagent_advisor", "flowchart_maker", "quality_check"].includes(node.type));
  const closing = nodes.filter((node) => ["validation", "preview", "final_summary"].includes(node.type));
  const main = nodes.filter(
    (node) => !subagents.includes(node) && !support.includes(node) && !closing.includes(node)
  );
  return { main, subagents, support, closing };
}

function codexTerminalEvents(session: Session) {
  return session.raw_events.filter((event) =>
    event.type.startsWith("local_codex_session.")
    || event.type.startsWith("codex.cli.")
    || event.type === "task.started"
    || event.type === "task.completed"
  );
}

function renderTerminalEvent(event: SessionEvent) {
  const data = asRecord(event.data);
  if (event.type === "local_codex_session.started") {
    const command = typeof data.command === "string" ? data.command : "codex exec [local orchestrator prompt via stdin]";
    const cwd = typeof data.cwd === "string" ? data.cwd : "";
    return [`$ cd ${cwd}`, `$ ${command}`, "stream: stdout/stderr piped from the real Codex CLI process"].filter(Boolean).join("\n");
  }
  if (event.type === "local_codex_session.stdout") return event.message;
  if (event.type === "local_codex_session.stderr") return `stderr\n${event.message}`;
  if (event.type === "codex.cli.started") {
    const command = typeof data.command === "string" ? data.command : "codex";
    const args = Array.isArray(data.args) ? data.args.map(String).join(" ") : "";
    const cwd = typeof data.cwd === "string" ? data.cwd : "";
    return [`$ cd ${cwd}`, `$ ${command} ${args}`].filter(Boolean).join("\n");
  }
  if (event.type === "codex.cli.stdout") return `stdout\n${event.message}`;
  if (event.type === "codex.cli.stderr") return `stderr\n${event.message}`;
  return event.message;
}

async function readSupervisorJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch (error) {
    throw new Error(`Invalid supervisor JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const error = asRecord(asRecord(parsed).error);
    throw new SupervisorApiError(
      response.status,
      typeof error.code === "string" ? error.code : `HTTP_${response.status}`,
      typeof error.message === "string" ? error.message : `HTTP ${response.status}`
    );
  }
  return parsed as T;
}

async function supervisorGet<T>(path: string) {
  return readSupervisorJson<T>(await fetch(`${supervisorApiBase}${path}`));
}

async function supervisorPost<T>(path: string, body: Record<string, unknown>) {
  return readSupervisorJson<T>(
    await fetch(`${supervisorApiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

function renderInlineMarkdown(text: string) {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > index) parts.push(text.slice(index, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      parts.push(<code key={`${token}-${match.index}`}>{token.slice(1, -1)}</code>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) parts.push(<a key={`${token}-${match.index}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>);
    }
    index = match.index + token.length;
  }
  if (index < text.length) parts.push(text.slice(index));
  return parts;
}

function renderMegaplanMarkdown(markdown: string) {
  const elements: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  const flushList = () => {
    if (!listItems.length) return;
    elements.push(<ul key={`ul-${elements.length}`}>{listItems}</ul>);
    listItems = [];
  };

  markdown.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      return;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      listItems.push(<li key={`li-${index}`}>{renderInlineMarkdown(bullet[1])}</li>);
      return;
    }
    flushList();
    if (trimmed.startsWith("# ")) {
      elements.push(<h1 key={index}>{renderInlineMarkdown(trimmed.slice(2))}</h1>);
    } else if (trimmed.startsWith("## ")) {
      elements.push(<h2 key={index}>{renderInlineMarkdown(trimmed.slice(3))}</h2>);
    } else if (trimmed.startsWith("### ")) {
      elements.push(<h3 key={index}>{renderInlineMarkdown(trimmed.slice(4))}</h3>);
    } else if (trimmed.startsWith("> ")) {
      elements.push(<blockquote key={index}>{renderInlineMarkdown(trimmed.slice(2))}</blockquote>);
    } else {
      elements.push(<p key={index}>{renderInlineMarkdown(trimmed)}</p>);
    }
  });
  flushList();
  return elements;
}

function FlowNodeCard({ node }: { node: FlowchartNode }) {
  return (
    <article className={`builderFlowNode ${node.visual_state}`} data-testid={`builder-flow-node-${node.type}`}>
      <span>{node.type.replace(/_/g, " ")}</span>
      <strong>{node.label}</strong>
      <div>
        <small>{node.status}</small>
        {node.badges.map((badge) => <small key={badge}>{badge}</small>)}
      </div>
      <p>{node.summary || "Waiting for a truthful runtime update."}</p>
    </article>
  );
}

export function AppBuilderPage({
  onNotice,
  externalSessionId = ""
}: {
  onNotice: (message: string) => void;
  externalSessionId?: string;
}) {
  const [sessionId, setSessionId] = useState(() => window.localStorage.getItem(sessionStorageKey) ?? "");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(loadSavedInteractions);
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [flowchart, setFlowchart] = useState<FlowchartState | null>(null);
  const [megaplan, setMegaplan] = useState<MegaplanRecord | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [sessionResetStatus, setSessionResetStatus] = useState("");
  const cliStreamRef = useRef<HTMLPreElement | null>(null);
  const progressEventIdsRef = useRef(new Set<string>());

  useEffect(() => {
    supervisorGet<{ local_codex?: RuntimeSettings }>("/ready")
      .then((payload) => setRuntimeSettings(payload.local_codex ?? null))
      .catch(() => setRuntimeSettings(null));
  }, []);

  useEffect(() => {
    if (sessionId) window.localStorage.setItem(sessionStorageKey, sessionId);
  }, [sessionId]);

  useEffect(() => {
    window.localStorage.setItem(interactionStorageKey, JSON.stringify(chatMessages.slice(-200)));
  }, [chatMessages]);

  useEffect(() => {
    cliStreamRef.current?.scrollTo({ top: cliStreamRef.current.scrollHeight });
  }, [session?.raw_events.length]);

  function clearMissingSession(missingSessionId: string) {
    window.localStorage.removeItem(sessionStorageKey);
    setSessionId((current) => (current === missingSessionId ? "" : current));
    setSession(null);
    setTasks([]);
    setMegaplan(null);
    setChatMessages((items) => mergeInteractions(items, [{
      id: makeLocalId(),
      role: "system",
      source: "system",
      text: "Session expired. Start a new App Builder session.",
      ts: new Date().toISOString(),
      session_id: missingSessionId
    }]));
  }

  async function fetchSession(targetSessionId: string) {
    const response = await fetch(`${supervisorApiBase}/codex/status?session_id=${encodeURIComponent(targetSessionId)}`);
    if (response.status === 404) return null;
    const payload = await readSupervisorJson<{ session?: Session }>(response);
    return payload.session ?? null;
  }

  function appendProgressMessages(targetSession: Session) {
    const progressEvents = targetSession.raw_events.filter((event) => event.type === "progress.update");
    const newEvents = progressEvents.filter((event) => !progressEventIdsRef.current.has(event.id));
    if (!newEvents.length) return;
    for (const event of newEvents) progressEventIdsRef.current.add(event.id);
    setChatMessages((items) => mergeInteractions(items, newEvents.map((event) => ({
        id: event.id,
        role: "assistant" as const,
        source: "system" as const,
        text: event.message,
        ts: event.ts,
        session_id: targetSession.session_id
      }))));
  }

  function mergeSessionInteractions(targetSession: Session) {
    setChatMessages((items) => mergeInteractions(items, sessionMessagesToInteractions(targetSession)));
  }

  async function refreshBuilder(targetSessionId = sessionId) {
    const flowchartPayload = await supervisorGet<FlowchartState>("/orchestrator/flowchart").catch(() => null);
    if (flowchartPayload) setFlowchart(flowchartPayload);
    if (!targetSessionId) return;
    try {
      const targetSession = await fetchSession(targetSessionId);
      if (!targetSession) {
        clearMissingSession(targetSessionId);
        return;
      }
      const activeProjectId = targetSession.project_id || targetSession.current_project_id;
      const tasksPayload = activeProjectId
        ? await supervisorGet<{ tasks?: TaskRecord[] }>(`/projects/${encodeURIComponent(activeProjectId)}/tasks`).catch(() => ({ tasks: [] }))
        : { tasks: [] };
      const megaplanPayload = await supervisorGet<{ megaplan?: MegaplanRecord | null }>(`/sessions/${encodeURIComponent(targetSessionId)}/megaplan`).catch(() => null);
      appendProgressMessages(targetSession);
      mergeSessionInteractions(targetSession);
      setSession(targetSession);
      setTasks(tasksPayload.tasks ?? []);
      setMegaplan(megaplanPayload?.megaplan ?? null);
    } catch (error) {
      if (error instanceof SupervisorApiError && error.code === "SESSION_NOT_FOUND") {
        clearMissingSession(targetSessionId);
        return;
      }
      onNotice(error instanceof Error ? error.message : "App Builder refresh failed");
    }
  }

  async function existingSessionIsValid(targetSessionId: string) {
    try {
      return Boolean(await fetchSession(targetSessionId));
    } catch {
      return false;
    }
  }

  async function ensureSupervisorSession(label: string) {
    if (sessionId && await existingSessionIsValid(sessionId)) return sessionId;
    if (sessionId) clearMissingSession(sessionId);
    const result = await supervisorPost<{ session_id: string }>("/supervisor/session", {
      label,
      workspace_path: supervisorWorkspacePath,
      channel: "web_text"
    });
    setSessionId(result.session_id);
    await refreshBuilder(result.session_id);
    return result.session_id;
  }

  async function startNewSession() {
    setBusy(true);
    setSessionResetStatus("Starting a new local Codex session...");
    try {
      const payload = await supervisorPost<ResetSupervisorSessionResponse>("/supervisor/session/reset", {
        session_id: sessionId || undefined,
        delete_project: true,
        label: "New local Codex session",
        workspace_path: supervisorWorkspacePath,
        channel: "web_text"
      });
      progressEventIdsRef.current.clear();
      window.localStorage.setItem(sessionStorageKey, payload.session_id);
      setSessionId(payload.session_id);
      setSession(payload.session);
      setTasks([]);
      setFlowchart(null);
      setMegaplan(null);
      const projectMessage = payload.deleted_project.deleted
        ? "The previous App Builder project directory was deleted."
        : payload.deleted_project.state_removed
          ? "The previous App Builder project was missing, so its session state was cleared."
          : payload.deleted_project.skipped_reason === "project_not_created_by_supervisor"
            ? "Project deletion was skipped because the selected folder was not created by App Builder."
            : payload.deleted_project.skipped_reason
              ? `Project deletion was skipped: ${payload.deleted_project.skipped_reason.replace(/_/g, " ")}.`
              : "No App Builder project was attached to the previous session.";
      const resetMessage: ChatMessage = {
        id: makeLocalId(),
        role: "system",
        source: "system",
        text: `Started a new local Codex session. ${projectMessage}`,
        ts: new Date().toISOString(),
        session_id: payload.session_id
      };
      window.localStorage.setItem(interactionStorageKey, JSON.stringify([resetMessage]));
      setChatInput("");
      setChatMessages([resetMessage]);
      setSessionResetStatus("New session ready.");
      await refreshBuilder(payload.session_id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not start a new App Builder session");
    } finally {
      setBusy(false);
    }
  }

  async function loadLatestSession() {
    setBusy(true);
    try {
      const payload = await supervisorGet<{ sessions?: Array<{ session_id: string }> }>("/codex/status");
      const latest = payload.sessions?.[0];
      if (!latest?.session_id) throw new Error("No App Builder sessions are available.");
      setSessionId(latest.session_id);
      await refreshBuilder(latest.session_id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Could not load the latest session");
    } finally {
      setBusy(false);
    }
  }

  async function sendSupervisorMessage(text: string) {
    const cleaned = text.trim();
    if (!cleaned || busy) return;
    setBusy(true);
    setChatInput("");
    try {
      const targetSessionId = await ensureSupervisorSession("local app builder session");
      setChatMessages((items) => mergeInteractions(items, [{
        id: makeLocalId(),
        role: "user",
        source: "app-text",
        text: cleaned,
        ts: new Date().toISOString(),
        session_id: targetSessionId
      }]));
      const result = await supervisorPost<{ text?: unknown }>("/call/message", {
        session_id: targetSessionId,
        user_id: supervisorUserId,
        channel: "web_text",
        text: cleaned,
        timestamp: new Date().toISOString()
      });
      const response = typeof result.text === "string" ? result.text : "Codex responded without display text.";
      setChatMessages((items) => mergeInteractions(items, [{
        id: makeLocalId(),
        role: "assistant",
        source: "app-text",
        text: response,
        ts: new Date().toISOString(),
        session_id: targetSessionId
      }]));
      await refreshBuilder(targetSessionId);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Codex App Builder message failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitChat(event?: FormEvent) {
    event?.preventDefault();
    await sendSupervisorMessage(chatInput);
  }

  const visibleNodes = useMemo(() => {
    return visibleFlowchartNodes(flowchart, new Set(tasks.map((task) => task.task_id)), sessionId);
  }, [flowchart, sessionId, tasks]);
  const lanes = useMemo(() => splitFlowLanes(visibleNodes), [visibleNodes]);
  const cliEvents = session ? codexTerminalEvents(session) : [];
  const cliStreamBody = [
    "Local Codex CLI stream",
    session ? `session: ${session.session_id}` : "session: none",
    session?.current_status ? `status: ${session.current_status}` : "status: idle",
    "",
    ...(cliEvents.length
      ? cliEvents.map((event) => `[${event.ts}] ${event.type}\n${renderTerminalEvent(event)}`)
      : ["$ waiting for a real codex exec process..."])
  ].join("\n\n");
  const activePreview = tasks.find((task) => task.latest_preview?.preview_url)?.latest_preview ?? null;
  const isMegaplanApprovalPending = session?.pending_action?.type === "approve_megaplan" || session?.pending_action?.action === "approve_megaplan";

  useEffect(() => {
    const nextSessionId = externalSessionId.trim();
    if (!nextSessionId || nextSessionId === sessionId) return;
    window.localStorage.setItem(sessionStorageKey, nextSessionId);
    setSessionId(nextSessionId);
    void refreshBuilder(nextSessionId);
  }, [externalSessionId, sessionId]);

  useEffect(() => {
    void refreshBuilder().catch(() => undefined);
    const timer = window.setInterval(() => {
      void refreshBuilder().catch(() => undefined);
    }, sessionId ? 2500 : 5000);
    return () => window.clearInterval(timer);
  }, [sessionId]);

  return (
    <section className="builderConsole" data-testid="voice-app-builder">
      <header className="voiceConsoleTopbar builderTopbar">
        <div>
          <p className="eyebrow">App Builder</p>
          <h1>Codex CLI Builder</h1>
        </div>
        <div className="voiceConsoleHeaderActions">
          <span className="kitBadge kitBadge-active">Built by one local Codex session</span>
          <span className="kitBadge kitBadge-secondary">{runtimeSettings?.model ?? "Codex model loading"}</span>
          <span className="kitBadge kitBadge-secondary">planning {runtimeSettings?.planning_reasoning_effort ?? "fast"}</span>
          <button className="voiceConsoleIconButton" type="button" onClick={() => void refreshBuilder()} aria-label="Refresh builder" title="Refresh">
            <RefreshCcw size={17} />
          </button>
          <button
            className="builderNewAppButton"
            type="button"
            onClick={() => void startNewSession()}
            disabled={busy}
            aria-label="Start a new app and delete the current generated project"
            title="New app + delete generated project"
          >
            <Trash2 size={16} /> New App
          </button>
        </div>
      </header>

      <section className="builderRuntimeStrip">
        <div>
          <span>Workspace</span>
          <strong>{supervisorWorkspacePath}</strong>
        </div>
        <div>
          <span>Reasoning</span>
          <strong>{runtimeSettings?.reasoning_effort ?? "loading"}</strong>
        </div>
        <div>
          <span>Access</span>
          <strong>{runtimeSettings?.access ?? "loading"}</strong>
        </div>
        <div>
          <span>Skills</span>
          <strong>
            {runtimeSettings?.skill_inventory
              ? `${runtimeSettings.skill_inventory.status} (${runtimeSettings.skill_inventory.total_discovered})`
              : "checking"}
          </strong>
        </div>
      </section>

      <section className="builderGrid">
        <div className="builderPanel builderChatPanel">
          <div className="voicePanelHeader">
            <div>
              <h2>Talk To Codex</h2>
              <p>{session?.session_id ?? (sessionId || "No active session")} · {chatMessages.length} saved text/voice interactions</p>
            </div>
            <div className="builderPanelActions">
              <button type="button" className="builderNewAppButton compact" onClick={() => void startNewSession()} disabled={busy}>
                <Trash2 size={15} /> New App
              </button>
              <button type="button" onClick={() => void loadLatestSession()} disabled={busy}>Latest</button>
              <button type="button" onClick={() => void refreshBuilder()} disabled={busy}>Refresh</button>
            </div>
          </div>
          <div className="builderChatLog" data-testid="builder-chat-log">
            {chatMessages.length ? (
              chatMessages.map((message) => (
                <article className={`builderChatMessage ${message.role} ${message.source}`} key={message.id}>
                  <span>{message.role === "user" ? "You" : "Codex"} · {message.source}</span>
                  <p>{message.text}</p>
                </article>
              ))
            ) : (
              <div className="emptyState compact">
                <Terminal size={20} />
                <p>Tell Codex what to build. It will clarify requirements, create a Megaplan, ask for approval when needed, and run the real CLI.</p>
              </div>
            )}
          </div>
          <form className="builderComposer" onSubmit={submitChat}>
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Describe the app, or reply approve when the Megaplan is ready."
              disabled={busy}
              rows={3}
            />
            <button type="button" onClick={() => void sendSupervisorMessage(chatInput)} disabled={busy || !chatInput.trim()}>
              <Send size={17} /> Send
            </button>
          </form>
          {sessionResetStatus && <p className="builderStatusLine">{sessionResetStatus}</p>}
        </div>

        <div className="builderPanel builderCliPanel">
          <div className="voicePanelHeader">
            <div>
              <h2>Codex CLI</h2>
              <p>{session?.current_status ?? "idle"} · stdout/stderr piped live</p>
            </div>
            <Terminal size={18} />
          </div>
          <pre ref={cliStreamRef} data-testid="builder-cli-stream">{cliStreamBody}</pre>
        </div>
      </section>

      <section className="builderPanel builderFlowPanel" data-testid="builder-session-flowchart">
        <div className="voicePanelHeader">
          <div>
            <h2>Session Flow</h2>
            <p>
              {visibleNodes.length
                ? `${visibleNodes.length} truthful runtime nodes · subagents ${lanes.subagents.length}`
                : "Waiting for the parallel flowchart maker"}
            </p>
          </div>
          <Workflow size={18} />
        </div>
        {visibleNodes.length ? (
          <div className="builderFlowCircuit">
            <div className="builderFlowLane">
              <span>Main path</span>
              {lanes.main.map((node) => <FlowNodeCard node={node} key={node.id} />)}
            </div>
            <div className="builderFlowLane builderParallelLane">
              <span>Parallel Codex agents</span>
              {lanes.support.map((node) => <FlowNodeCard node={node} key={node.id} />)}
              {lanes.subagents.map((node) => <FlowNodeCard node={node} key={node.id} />)}
              {!lanes.support.length && !lanes.subagents.length && <p className="builderLaneEmpty">Codex has not reported subagents yet.</p>}
            </div>
            <div className="builderFlowLane">
              <span>Quality path</span>
              {lanes.closing.map((node) => <FlowNodeCard node={node} key={node.id} />)}
              {!lanes.closing.length && <p className="builderLaneEmpty">Validation and final checks will appear here.</p>}
            </div>
          </div>
        ) : (
          <div className="emptyState compact">
            <Workflow size={20} />
            <p>The flowchart is generated from the local supervisor events, not hard-coded UI placeholders.</p>
          </div>
        )}
      </section>

      <section className="builderPanel builderMegaplanPanel" data-testid="builder-megaplan">
        <div className="voicePanelHeader">
          <div>
            <h2>Megaplan</h2>
            <p>{megaplan ? `Updated ${new Date(megaplan.updated_at).toLocaleString()}` : "Waiting for Codex planning"}</p>
          </div>
          <div className="builderPanelActions">
            {activePreview?.preview_url ? (
              <a href={activePreview.preview_url} target="_blank" rel="noreferrer">
                Preview <ExternalLink size={14} />
              </a>
            ) : null}
            {isMegaplanApprovalPending ? (
              <button type="button" onClick={() => void sendSupervisorMessage("approve")} disabled={busy}>
                <CheckCircle2 size={15} /> Approve
              </button>
            ) : null}
          </div>
        </div>
        {megaplan ? (
          <>
            <div className="builderRepoStrip">
              <span>
                Repo{" "}
                {megaplan.repo.web_url ? (
                  <a href={megaplan.repo.web_url} target="_blank" rel="noreferrer">{megaplan.repo.name}</a>
                ) : (
                  <strong>{megaplan.repo.name}</strong>
                )}
              </span>
              <span><GitBranch size={14} /> {megaplan.repo.branch ?? "unknown"}</span>
              {megaplan.repo.commit ? <span>{megaplan.repo.commit.slice(0, 8)}</span> : null}
            </div>
            <article className="builderMarkdown">{renderMegaplanMarkdown(megaplan.content)}</article>
          </>
        ) : (
          <div className="emptyState compact">
            <CheckCircle2 size={20} />
            <p>Codex creates MEGAPLAN.md first and asks for approval before complex implementation.</p>
          </div>
        )}
      </section>
    </section>
  );
}
