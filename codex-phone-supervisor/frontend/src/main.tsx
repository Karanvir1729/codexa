import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

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
  active_worker_id: string | null;
  channel: string | null;
  pending_action: { type: string; original_user_goal: string; requested_kind: string; action?: string | null } | null;
  active_task: string;
  current_status: string;
  latest_codex_message: string;
  files_modified: string[];
  commands_completed: string[];
  commands_failed: string[];
  pending_approvals: Array<{ id: string; command: string; reason: string; risk: string; status: string }>;
  summary_text: string;
  latest_summary: string;
  latest_plan: string[];
  recent_messages: Array<{ ts: string; role: "user" | "assistant" | "system"; channel: string | null; text: string }>;
  raw_events: SessionEvent[];
  codex_conversation_session_id: string | null;
  codex_conversation_resume_command: string | null;
  codex_conversation_mirrored_at: string | null;
  codex_conversation_mirror_error: string | null;
  git_diff_summary: string;
  workspace_path: string;
  project_discovery: {
    status: "collecting" | "selected";
    selected_workspace_path: string | null;
    selected_project_name: string | null;
    confidence: "low" | "medium" | "high" | null;
    reason: string;
    last_question: string;
  };
};

type PreviewMetadata = {
  preview_id: string;
  project_id: string;
  task_id: string;
  worker_id: string | null;
  workspace_path: string;
  entry_file: string;
  asset_paths: string[];
  preview_url: string;
  server_type: string;
  status: string;
  command_event_id?: string;
  console_errors: string[];
  screenshot_path?: string;
  loaded: boolean;
  summary: string;
  created_at: string;
  updated_at: string;
};

type TaskRecord = {
  task_id: string;
  project_id: string;
  user_goal: string;
  status: string;
  worker_id: string | null;
  latest_summary: string;
  next_steps: string[];
  command_count: number;
  latest_preview?: PreviewMetadata | null;
};

type RuntimeSettings = {
  model: string;
  planning_model: string;
  planning_reasoning_effort: string;
  access: string;
  shell_environment: string;
  account_config_plugins: string;
  conversation_resume_mirror: string;
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
  position: { x: number; y: number };
};

type FlowchartEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
};

type WorkerSettings = {
  default_worker_mode: "codex_session_local" | "local" | "docker_local" | "gcp_vm" | "gke_job";
  allow_worker_mode_switch: boolean;
  max_local_workers: number;
  max_docker_local_workers: number;
  max_gcp_vm_workers: number;
  max_gke_job_workers: number;
  updated_at: string;
};

type ModelProviders = {
  supervisor_model_provider: string;
  planner_model_provider: string;
  worker_code_model: string;
};

type FlowchartState = {
  generated_at: string;
  worker_settings: WorkerSettings;
  model_providers: ModelProviders;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  events: Array<{ event_id: string; type: string; message: string; created_at: string }>;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  source: "app-text" | "app-voice" | "system";
  text: string;
};

type ResetSupervisorSessionResponse = {
  old_session_id: string | null;
  session_id: string;
  session: Session;
  deleted_project: {
    requested: boolean;
    project_id: string | null;
    workspace_path: string | null;
    deleted: boolean;
    state_removed: boolean;
    skipped_reason: string | null;
  };
};

type MegaplanRecord = {
  project_id: string;
  session_id: string;
  path: string;
  content: string;
  updated_at: string;
  repo: {
    name: string;
    path: string;
    link: string;
    branch: string | null;
    commit: string | null;
    remote_url: string | null;
  };
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const apiBase = import.meta.env.VITE_SUPERVISOR_API_BASE?.trim();
const workspacePath = import.meta.env.VITE_SUPERVISOR_WORKSPACE_PATH?.trim();
const supervisorUserId = import.meta.env.VITE_SUPERVISOR_USER_ID?.trim();

if (!apiBase) throw new Error("VITE_SUPERVISOR_API_BASE is required.");
if (!workspacePath) throw new Error("VITE_SUPERVISOR_WORKSPACE_PATH is required.");
if (!supervisorUserId) throw new Error("VITE_SUPERVISOR_USER_ID is required.");

function makeId() {
  if (!crypto.randomUUID) throw new Error("crypto.randomUUID is required.");
  return crypto.randomUUID();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : "";
}

function hostVisibleCodexRolloutPath(detail: Record<string, unknown>, command: Record<string, unknown>) {
  const hostPath = stringValue(detail.codex_rollout_host_path) || stringValue(command.codex_rollout_host_path);
  if (hostPath && !hostPath.startsWith("/workspace/")) return hostPath;
  return stringValue(detail.codex_rollout_relative_path)
    || stringValue(command.codex_rollout_relative_path)
    || hostPath;
}

function hostVisibleCodexHomePath(detail: Record<string, unknown>, command: Record<string, unknown>) {
  return stringValue(detail.codex_home_host_path)
    || stringValue(command.codex_home_host_path)
    || (hostVisibleCodexRolloutPath(detail, command).startsWith(".codex-worker-home") ? ".codex-worker-home" : "");
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
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
  if (event.type === "local_codex_session.completed" || event.type === "local_codex_session.failed" || event.type === "local_codex_session.finished") {
    return event.message;
  }
  if (event.type === "codex.cli.started") {
    const command = typeof data.command === "string" ? data.command : "codex";
    const args = Array.isArray(data.args) ? data.args.map(String).join(" ") : "";
    const cwd = typeof data.cwd === "string" ? data.cwd : "";
    const target = typeof data.target_project_path === "string" ? data.target_project_path : "";
    const promptChars = typeof data.prompt_chars === "number" ? `prompt chars: ${data.prompt_chars}` : "";
    return [`$ cd ${cwd}`, `$ ${command} ${args}`, target ? `target project: ${target}` : "", promptChars].filter(Boolean).join("\n");
  }
  if (event.type === "codex.cli.exited") return event.message;
  if (event.type === "codex.cli.stdout") return `stdout\n${event.message}`;
  if (event.type === "codex.cli.stderr") return `stderr\n${event.message}`;
  return event.message;
}

const flowStateColors: Record<FlowchartVisualState, { border: string; background: string; text: string }> = {
  idle: { border: "#9ca3af", background: "#f3f4f6", text: "#111827" },
  planning: { border: "#2563eb", background: "#eff6ff", text: "#172554" },
  waiting_for_approval: { border: "#ca8a04", background: "#fefce8", text: "#422006" },
  completed: { border: "#16a34a", background: "#f0fdf4", text: "#052e16" },
  failed: { border: "#dc2626", background: "#fef2f2", text: "#450a0a" },
  running: { border: "#7c3aed", background: "#f5f3ff", text: "#2e1065" },
  warning: { border: "#ea580c", background: "#fff7ed", text: "#431407" },
};

const FLOW_NODE_WIDTH = 190;
const FLOW_NODE_HEIGHT = 126;
const FLOW_COLUMN_GAP = 34;
const FLOW_ROW_GAP = 32;
const FLOW_PADDING = 24;
const FLOW_COLUMNS = 4;

function flowNodeStyle(node: FlowchartNode): React.CSSProperties {
  const colors = flowStateColors[node.visual_state] ?? flowStateColors.idle;
  return {
    position: "absolute",
    left: node.position.x,
    top: node.position.y,
    width: FLOW_NODE_WIDTH,
    height: FLOW_NODE_HEIGHT,
    border: `1.5px solid ${colors.border}`,
    background: colors.background,
    color: colors.text,
    borderRadius: 8,
    padding: 10,
    boxSizing: "border-box",
    cursor: "pointer",
    boxShadow: "0 1px 3px rgba(15, 23, 42, 0.10)",
    overflow: "hidden",
  };
}

function flowGraphSize(nodes: FlowchartNode[]) {
  if (!nodes.length) return { width: FLOW_PADDING * 2 + FLOW_NODE_WIDTH, height: 420 };
  const width = Math.max(FLOW_PADDING * 2 + FLOW_NODE_WIDTH, Math.max(...nodes.map((node) => node.position.x)) + FLOW_NODE_WIDTH + FLOW_PADDING);
  const height = Math.max(420, Math.max(...nodes.map((node) => node.position.y)) + FLOW_NODE_HEIGHT + FLOW_PADDING);
  return { width, height };
}

function compactFlowchartLayout(nodes: FlowchartNode[], columns = FLOW_COLUMNS) {
  const columnCount = Math.max(1, Math.min(FLOW_COLUMNS, columns));
  const typePriority = new Map([
    ["orchestrator", 0],
    ["user_request", 1],
    ["requirement_summary", 2],
    ["codex_plan", 3],
    ["user_approval", 4],
    ["codex_session", 5],
    ["codex_subagent", 6],
    ["validation", 7],
    ["preview", 8],
    ["final_summary", 9],
  ]);
  const sorted = [...nodes].sort((a, b) => {
    const priority = (typePriority.get(a.type) ?? 99) - (typePriority.get(b.type) ?? 99);
    return priority || a.label.localeCompare(b.label);
  });
  const subagents = sorted.filter((node) => node.type === "codex_subagent");
  const byType = new Map<string, FlowchartNode[]>();
  sorted.filter((node) => node.type !== "codex_subagent").forEach((node) => {
    const items = byType.get(node.type) ?? [];
    items.push(node);
    byType.set(node.type, items);
  });
  const placements = new Map<string, { row: number; column: number }>();
  const placeNext = (type: string, row: number, column: number) => {
    const item = byType.get(type)?.shift();
    if (item) placements.set(item.id, { row, column: Math.min(column, columnCount - 1) });
  };
  let cursor = 0;
  const placeInFlow = (type: string) => {
    const item = byType.get(type)?.shift();
    if (!item) return;
    placements.set(item.id, { row: Math.floor(cursor / columnCount), column: cursor % columnCount });
    cursor += 1;
  };

  ["orchestrator", "user_request", "requirement_summary", "codex_plan", "user_approval", "codex_session"].forEach(placeInFlow);

  const subagentStartRow = Math.max(1, Math.ceil(cursor / columnCount));
  subagents.forEach((node, index) => {
    placements.set(node.id, {
      row: subagentStartRow + Math.floor(index / columnCount),
      column: index % columnCount,
    });
  });
  const closingRow = subagentStartRow + Math.max(1, Math.ceil(subagents.length / columnCount));
  const closingStartColumn = columnCount >= 3 ? columnCount - 3 : 0;
  ["validation", "preview", "final_summary"].forEach((type, index) => {
    placeNext(type, closingRow + Math.floor((closingStartColumn + index) / columnCount), (closingStartColumn + index) % columnCount);
  });

  let overflowIndex = 0;
  for (const leftovers of byType.values()) {
    for (const node of leftovers) {
      placements.set(node.id, {
        row: closingRow + 1 + Math.floor(overflowIndex / columnCount),
        column: overflowIndex % columnCount,
      });
      overflowIndex += 1;
    }
  }

  return sorted.map((node) => {
    const placement = placements.get(node.id) ?? {
      row: closingRow + 1 + Math.floor(overflowIndex / columnCount),
      column: overflowIndex++ % columnCount,
    };
    return {
      ...node,
      position: {
        x: FLOW_PADDING + placement.column * (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP),
        y: FLOW_PADDING + placement.row * (FLOW_NODE_HEIGHT + FLOW_ROW_GAP),
      },
    };
  });
}

function flowEdgePath(from: FlowchartNode, to: FlowchartNode) {
  const fromCenterX = from.position.x + FLOW_NODE_WIDTH / 2;
  const fromCenterY = from.position.y + FLOW_NODE_HEIGHT / 2;
  const toCenterX = to.position.x + FLOW_NODE_WIDTH / 2;
  const toCenterY = to.position.y + FLOW_NODE_HEIGHT / 2;
  const verticalFirst = to.position.y > from.position.y + FLOW_NODE_HEIGHT / 2;
  if (verticalFirst) {
    const startX = fromCenterX;
    const startY = from.position.y + FLOW_NODE_HEIGHT;
    const endX = toCenterX;
    const endY = to.position.y;
    const midY = Math.round((startY + endY) / 2);
    return `M ${startX} ${startY} L ${startX} ${midY} L ${endX} ${midY} L ${endX} ${endY}`;
  }
  if (toCenterX >= fromCenterX) {
    const startX = from.position.x + FLOW_NODE_WIDTH;
    const startY = fromCenterY;
    const endX = to.position.x;
    const endY = toCenterY;
    const midX = Math.round((startX + endX) / 2);
    return `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`;
  }
  const startX = from.position.x;
  const startY = fromCenterY;
  const endX = to.position.x + FLOW_NODE_WIDTH;
  const endY = toCenterY;
  const midX = Math.round((startX + endX) / 2);
  return `M ${startX} ${startY} L ${midX} ${startY} L ${midX} ${endY} L ${endX} ${endY}`;
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
      parts.push(<code key={`${token}-${match.index}`} style={{ background: "#f6f8fa", border: "1px solid #d0d7de", borderRadius: 4, padding: "1px 4px" }}>{token.slice(1, -1)}</code>);
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
  const lines = markdown.split(/\r?\n/);
  const elements: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  const flushList = () => {
    if (!listItems.length) return;
    elements.push(<ul key={`ul-${elements.length}`} style={{ paddingLeft: 24, marginTop: 6 }}>{listItems}</ul>);
    listItems = [];
  };
  lines.forEach((line, index) => {
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
      elements.push(<h1 key={index} style={{ borderBottom: "1px solid #d0d7de", paddingBottom: 8, marginTop: 0 }}>{renderInlineMarkdown(trimmed.slice(2))}</h1>);
    } else if (trimmed.startsWith("## ")) {
      elements.push(<h2 key={index} style={{ borderBottom: "1px solid #d8dee4", paddingBottom: 6, marginTop: 24 }}>{renderInlineMarkdown(trimmed.slice(3))}</h2>);
    } else if (trimmed.startsWith("### ")) {
      elements.push(<h3 key={index} style={{ marginTop: 18 }}>{renderInlineMarkdown(trimmed.slice(4))}</h3>);
    } else if (/^\d+\.\s+/.test(trimmed)) {
      elements.push(<p key={index} style={{ margin: "8px 0" }}>{renderInlineMarkdown(trimmed)}</p>);
    } else if (trimmed.startsWith("> ")) {
      elements.push(<blockquote key={index} style={{ borderLeft: "4px solid #d0d7de", margin: "8px 0", padding: "2px 12px", color: "#57606a" }}>{renderInlineMarkdown(trimmed.slice(2))}</blockquote>);
    } else {
      elements.push(<p key={index} style={{ margin: "8px 0" }}>{renderInlineMarkdown(trimmed)}</p>);
    }
  });
  flushList();
  return elements;
}

const hiddenLocalFlowchartTypes = new Set([
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
  "mcp_action",
]);

function displayFlowText(value: string) {
  return value
    .replace(/`[^`]*`/g, "implementation detail")
    .replace(/(?:^|[\s(])(?:\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/]|[\w.-]+\/)[^\s,;:)]+/g, " project file")
    .replace(/\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|html|css|md|svg|png|jpe?g|webp|gif|ico|yml|yaml)\b/gi, "project file")
    .replace(/\s+/g, " ")
    .trim();
}

function localFlowchartTaskId(nodeId: string) {
  return nodeId.match(/^codex_flow:(task_[^:]+):/)?.[1]
    ?? nodeId.match(/^codex_flow_pending:(task_[^:]+)/)?.[1]
    ?? "";
}

const pendingMegaplanFlowchartTypes = new Set(["requirement_summary", "codex_plan", "user_approval"]);

function localFlowchartNodes(flowchart: FlowchartState | null, taskIds: Set<string>, currentSessionId = "") {
  return (flowchart?.nodes ?? [])
    .filter((node) => {
      if (node.type === "orchestrator") return true;
      if (pendingMegaplanFlowchartTypes.has(node.type)) {
        return Boolean(currentSessionId && String(node.detail.session_id ?? "") === currentSessionId);
      }
      if (!node.id.startsWith("codex_flow:") && !node.id.startsWith("codex_flow_pending:")) return false;
      const taskId = localFlowchartTaskId(node.id);
      return Boolean(taskId && taskIds.has(taskId));
    })
    .filter((node) => !hiddenLocalFlowchartTypes.has(node.type))
    .map((node) => node.type === "orchestrator"
      ? {
          ...node,
          label: "Codex CLI Orchestrator",
          badges: ["codex_session_local", "direct Codex CLI"],
          summary: node.summary === "Waiting for runtime activity." || node.summary === "Waiting for local Codex CLI activity."
            ? "Waiting for a real local Codex CLI session."
            : node.summary,
          detail: {
            ...node.detail,
            orchestrator: "Codex CLI",
            subagents: "Codex internal logical subagents",
            model_providers: undefined,
            worker_counts: undefined,
            worker_settings: undefined,
          },
        }
      : {
          ...node,
          label: displayFlowText(node.label),
          badges: node.badges.map(displayFlowText).filter(Boolean).slice(0, 2),
          summary: displayFlowText(node.summary),
          detail: {
            kind: node.detail.kind ?? node.type,
            label: displayFlowText(String(node.detail.label ?? node.label)),
            status: displayFlowText(String(node.detail.status ?? node.status)),
            summary: displayFlowText(String(node.detail.summary ?? node.summary)),
            flowchart_title: displayFlowText(String(node.detail.flowchart_title ?? "")),
            flowchart_overview: displayFlowText(String(node.detail.flowchart_overview ?? "")),
          },
        });
}

function transcriptFromSpeechEvent(event: unknown) {
  const results = (event as { results?: ArrayLike<ArrayLike<{ transcript?: string }>> }).results;
  if (!results?.length) return "";
  const last = results[results.length - 1];
  return String(last?.[0]?.transcript || "").trim();
}

function activeErrorEvents(events: SessionEvent[]) {
  const recoveryIndex = events.reduce((latest, event, index) => (
    event.type === "project_discovery.selected" ||
    event.type === "supervisor.development.answer" ||
    event.type === "local_codex_session.completed"
      ? index
      : latest
  ), -1);
  return events
    .filter((event, index) => index > recoveryIndex && /failed|error|stale/i.test(event.type))
    .slice(-5);
}

async function readJsonResponse(res: Response) {
  const body = await res.text();
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) {
    const error = asRecord(asRecord(parsed).error);
    const code = typeof error.code === "string" ? error.code : `HTTP_${res.status}`;
    const message = typeof error.message === "string" ? error.message : `HTTP ${res.status}`;
    throw new ApiError(res.status, code, message);
  }
  return parsed;
}

function App() {
  const [sessionId, setSessionId] = useState("");
  const [task, setTask] = useState("");
  const [instruction, setInstruction] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [flowchart, setFlowchart] = useState<FlowchartState | null>(null);
  const [megaplan, setMegaplan] = useState<MegaplanRecord | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [orchestratorTaskStatus, setOrchestratorTaskStatus] = useState("");
  const [sessionResetStatus, setSessionResetStatus] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const cliStreamRef = useRef<HTMLPreElement | null>(null);
  const flowPanelRef = useRef<HTMLDivElement | null>(null);
  const [flowPanelWidth, setFlowPanelWidth] = useState(0);
  const staleSessionNoticeRef = useRef("");
  const pollFailureCountRef = useRef(0);
  const refreshErrorNoticeRef = useRef("");
  const progressEventIdsRef = useRef(new Set<string>());
  const voiceProgressEnabledRef = useRef(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("codex-phone-supervisor-session");
    if (saved) setSessionId(saved);
    fetch(`${apiBase}/ready`)
      .then(readJsonResponse)
      .then((payload) => {
        const ready = payload as { local_codex?: RuntimeSettings };
        setRuntimeSettings(ready.local_codex ?? null);
      })
      .catch(() => setRuntimeSettings(null));
  }, []);

  useEffect(() => {
    if (sessionId) window.localStorage.setItem("codex-phone-supervisor-session", sessionId);
  }, [sessionId]);

  useEffect(() => {
    cliStreamRef.current?.scrollTo({ top: cliStreamRef.current.scrollHeight });
  }, [session?.raw_events.length]);

  useEffect(() => {
    const panel = flowPanelRef.current;
    if (!panel) return;
    const updateWidth = () => setFlowPanelWidth(panel.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [flowchart, sessionId]);

  function clearMissingSession(missingSessionId: string) {
    window.localStorage.removeItem("codex-phone-supervisor-session");
    setSessionId((current) => current === missingSessionId ? "" : current);
    setSession(null);
    setMegaplan(null);
    if (staleSessionNoticeRef.current === missingSessionId) return;
    staleSessionNoticeRef.current = missingSessionId;
    setChatMessages((items) => [
      ...items,
      {
        id: makeId(),
        role: "system",
        source: "system",
        text: "Session expired. Start a new session.",
      },
    ]);
  }

  async function fetchSession(targetSessionId: string) {
    const response = await fetch(`${apiBase}/codex/status?session_id=${encodeURIComponent(targetSessionId)}`);
    if (response.status === 404) return null;
    const payload = await readJsonResponse(response) as { session?: Session };
    return payload.session ?? null;
  }

  function appendProgressMessages(targetSession: Session) {
    const progressEvents = targetSession.raw_events.filter((event) => event.type === "progress.update");
    const newEvents = progressEvents.filter((event) => !progressEventIdsRef.current.has(event.id));
    if (!newEvents.length) return;
    for (const event of newEvents) progressEventIdsRef.current.add(event.id);
    setChatMessages((items) => [
      ...items,
      ...newEvents.map((event) => ({
        id: event.id,
        role: "assistant" as const,
        source: targetSession.channel === "web_voice" ? "app-voice" as const : "system" as const,
        text: event.message,
      })),
    ]);
    if (voiceProgressEnabledRef.current && targetSession.channel === "web_voice") {
      speakResponse(newEvents.at(-1)!.message);
    }
  }

  async function existingSessionIsValid(targetSessionId: string) {
    try {
      return Boolean(await fetchSession(targetSessionId));
    } catch {
      return false;
    }
  }

  async function refresh(targetSessionId = sessionId) {
    if (!targetSessionId) return;
    try {
      const targetSession = await fetchSession(targetSessionId);
      if (!targetSession) {
        pollFailureCountRef.current += 1;
        clearMissingSession(targetSessionId);
        return;
      }
      const activeProjectId = targetSession.project_id || targetSession.current_project_id;
      const tasksPayload = activeProjectId
        ? await fetch(`${apiBase}/projects/${encodeURIComponent(activeProjectId)}/tasks`).then(readJsonResponse).catch(() => ({ tasks: [] })) as { tasks?: TaskRecord[] }
        : { tasks: [] };
      const megaplanPayload = await fetch(`${apiBase}/sessions/${encodeURIComponent(targetSessionId)}/megaplan`)
        .then(readJsonResponse)
        .catch(() => null) as { megaplan?: MegaplanRecord } | null;
      await loadFlowchart();
      pollFailureCountRef.current = 0;
      refreshErrorNoticeRef.current = "";
      appendProgressMessages(targetSession);
      setSession(targetSession);
      setTasks(tasksPayload.tasks ?? []);
      setMegaplan(megaplanPayload?.megaplan ?? null);
    } catch (error) {
      if (error instanceof ApiError && error.code === "SESSION_NOT_FOUND") {
        pollFailureCountRef.current += 1;
        clearMissingSession(targetSessionId);
        return;
      }
      pollFailureCountRef.current += 1;
      if (pollFailureCountRef.current >= 3 && refreshErrorNoticeRef.current !== targetSessionId) {
        refreshErrorNoticeRef.current = targetSessionId;
        setChatMessages((items) => [
          ...items,
          {
            id: makeId(),
            role: "system",
            source: "system",
            text: "Live refresh is temporarily unavailable. I will retry in the background.",
          },
        ]);
      }
    }
  }

  async function loadFlowchart() {
    const payload = await fetch(`${apiBase}/orchestrator/flowchart`).then(readJsonResponse) as FlowchartState;
    setFlowchart(payload);
    const scopedTaskIds = new Set(tasks.map((taskRecord) => taskRecord.task_id));
    const visibleNodes = localFlowchartNodes(payload, scopedTaskIds, sessionId);
    setSelectedNodeId((current) => current && visibleNodes.some((node) => node.id === current) ? current : visibleNodes.find((node) => node.type === "orchestrator")?.id ?? "");
  }

  useEffect(() => {
    void loadFlowchart().catch(() => undefined);
    const timer = setInterval(() => {
      void loadFlowchart().catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  async function loadLatestSession() {
    const payload = await fetch(`${apiBase}/codex/status`).then(readJsonResponse) as { sessions?: Array<{ session_id: string }> };
    const latest = payload.sessions?.[0];
    if (!latest?.session_id) throw new Error("No sessions are available.");
    setSessionId(latest.session_id);
    await refresh(latest.session_id);
  }

  async function ensureSupervisorSession(label: string) {
    if (sessionId) {
      if (await existingSessionIsValid(sessionId)) return sessionId;
      clearMissingSession(sessionId);
    }
    const res = await fetch(`${apiBase}/supervisor/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, workspace_path: workspacePath }),
    }).then(readJsonResponse) as { session_id: string };
    setSessionId(res.session_id);
    await refresh(res.session_id);
    return String(res.session_id);
  }

  async function startNewSession() {
    setSessionResetStatus("Starting a new local Codex session...");
    const payload = await fetch(`${apiBase}/supervisor/session/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId || undefined,
        delete_project: true,
        label: "New local Codex session",
        workspace_path: workspacePath,
        channel: "web_text",
      }),
    }).then(readJsonResponse) as ResetSupervisorSessionResponse;
    progressEventIdsRef.current.clear();
    voiceProgressEnabledRef.current = false;
    staleSessionNoticeRef.current = "";
    refreshErrorNoticeRef.current = "";
    pollFailureCountRef.current = 0;
    window.localStorage.setItem("codex-phone-supervisor-session", payload.session_id);
    setSessionId(payload.session_id);
    setSession(payload.session);
    setTasks([]);
    setFlowchart(null);
    setMegaplan(null);
    setSelectedNodeId("");
    setTask("");
    setInstruction("");
    setChatInput("");
    setOrchestratorTaskStatus("");
    const projectMessage = payload.deleted_project.deleted
      ? "The previous generated project directory was deleted."
      : payload.deleted_project.state_removed
        ? "The previous generated project was already missing, so its session state was cleared."
        : payload.deleted_project.skipped_reason
          ? `Project deletion was skipped: ${payload.deleted_project.skipped_reason.replace(/_/g, " ")}.`
          : "No generated project was attached to the previous session.";
    setChatMessages([{
      id: makeId(),
      role: "system",
      source: "system",
      text: `Started a new local Codex session. ${projectMessage}`,
    }]);
    setSessionResetStatus("New session ready.");
    await refresh(payload.session_id);
  }

  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [sessionId]);

  async function sendInstruction() {
    if (!sessionId || !instruction.trim()) return;
    await fetch(`${apiBase}/codex/instruct`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, instruction }),
    }).then(readJsonResponse);
    setInstruction("");
    await refresh();
  }

  async function sendSupervisorMessage(text: string, source: "app-text" | "app-voice", speak = false) {
    const cleaned = text.trim();
    if (!cleaned) return;
    const targetSessionId = await ensureSupervisorSession(source === "app-voice" ? "local voice supervisor session" : "local text supervisor session");
    if (source === "app-voice") voiceProgressEnabledRef.current = true;
    setChatMessages((items) => [...items, { id: makeId(), role: "user", source, text: cleaned }]);
    let result: unknown;
    try {
      result = await fetch(`${apiBase}/call/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: targetSessionId,
          user_id: supervisorUserId,
          channel: source === "app-voice" ? "web_voice" : "web_text",
          text: cleaned,
          timestamp: new Date().toISOString(),
        }),
      }).then(readJsonResponse);
    } catch (error) {
      if (error instanceof ApiError && error.code === "SESSION_NOT_FOUND") {
        clearMissingSession(targetSessionId);
        return;
      }
      throw error;
    }
    const supervisorResult = result as { text?: unknown };
    if (!supervisorResult.text) throw new Error("Supervisor response did not include response text.");
    const response = String(supervisorResult.text);
    setChatMessages((items) => [...items, { id: makeId(), role: "assistant", source, text: response }]);
    if (speak) speakResponse(response);
    await refresh(targetSessionId);
  }

  async function sendTextChat() {
    const text = chatInput;
    setChatInput("");
    await sendSupervisorMessage(text, "app-text");
  }

  function speakResponse(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }

  function startVoiceChat() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceStatus("Browser speech recognition is not available. Use Chrome or the text chat.");
      return;
    }
    window.speechSynthesis?.cancel();
    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = transcriptFromSpeechEvent(event);
      setVoiceStatus(transcript ? `Heard: ${transcript}` : "No transcript captured.");
      if (transcript) void sendSupervisorMessage(transcript, "app-voice", true);
    };
    recognition.onerror = (event) => {
      const error = (event as { error?: string }).error;
      setVoiceStatus(error ? `Voice error: ${error}` : "Voice error event did not include a browser error code.");
      setIsListening(false);
    };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setIsListening(true);
    setVoiceStatus("Listening...");
    recognition.start();
  }

  function stopVoiceChat() {
    recognitionRef.current?.stop();
    window.speechSynthesis?.cancel();
    voiceProgressEnabledRef.current = false;
    setIsListening(false);
    setVoiceStatus("Voice stopped.");
  }

  async function respond(approvalId: string, decision: "approved" | "denied") {
    await fetch(`${apiBase}/approval/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, approval_id: approvalId, decision, channel: "web_text" }),
    }).then(readJsonResponse);
    await refresh();
  }

  async function createOrchestratorTask() {
    if (!session?.project_id && !session?.current_project_id) {
      setOrchestratorTaskStatus("Select or create a project before starting Codex.");
      return;
    }
    const goal = task.trim() || instruction.trim() || session.active_task;
    if (!goal.trim()) {
      setOrchestratorTaskStatus("Enter a task goal first.");
      return;
    }
    setOrchestratorTaskStatus("Starting one local Codex CLI session...");
    await sendSupervisorMessage(goal, "app-text");
    await loadFlowchart();
  }

  async function approveMegaplan() {
    await sendSupervisorMessage("approve", "app-text");
  }

  async function resolveFlowApproval(node: FlowchartNode, decision: "approved" | "rejected") {
    const detail = asRecord(node.detail);
    const approval = asRecord(detail.approval);
    const sessionForApproval = typeof detail.session_id === "string" ? detail.session_id : "";
    const sessionApprovalId = typeof approval.id === "string" ? approval.id : "";
    const recordApprovalId = typeof approval.approval_id === "string" ? approval.approval_id : "";
    if (sessionForApproval && sessionApprovalId) {
      await respond(sessionApprovalId, decision === "approved" ? "approved" : "denied");
      await loadFlowchart();
      return;
    }
    if (recordApprovalId) {
      await fetch(`${apiBase}/approvals/${encodeURIComponent(recordApprovalId)}/${decision === "approved" ? "approve" : "reject"}`, { method: "POST" }).then(readJsonResponse);
      await loadFlowchart();
    }
  }

  const activeTask = session?.active_task_id ? tasks.find((item) => item.task_id === session.active_task_id) : tasks[0] ?? null;
  const scopedFlowchartTaskIds = new Set(tasks.map((taskRecord) => taskRecord.task_id));
  const availableFlowWidth = flowPanelWidth || 920;
  const flowColumnCount = Math.max(1, Math.min(FLOW_COLUMNS, Math.floor((availableFlowWidth - FLOW_PADDING * 2 + FLOW_COLUMN_GAP) / (FLOW_NODE_WIDTH + FLOW_COLUMN_GAP)) || 1));
  const visibleFlowchartNodes = compactFlowchartLayout(localFlowchartNodes(flowchart, scopedFlowchartTaskIds, sessionId), flowColumnCount);
  const visibleFlowchartNodeIds = new Set(visibleFlowchartNodes.map((node) => node.id));
  const visibleFlowchartEdges = (flowchart?.edges ?? []).filter((edge) => visibleFlowchartNodeIds.has(edge.from) && visibleFlowchartNodeIds.has(edge.to));
  const selectedNode = visibleFlowchartNodes.find((node) => node.id === selectedNodeId) ?? visibleFlowchartNodes.find((node) => node.type === "orchestrator") ?? null;
  const graphSize = flowGraphSize(visibleFlowchartNodes);
  const nodeById = new Map(visibleFlowchartNodes.map((node) => [node.id, node]));
  const latestCommandNode = visibleFlowchartNodes.find((node) => node.type === "command");
  const latestCommand = latestCommandNode?.label || session?.commands_completed.at(-1) || session?.commands_failed.at(-1) || "None";
  const selectedNodeDetail = selectedNode ? asRecord(selectedNode.detail) : {};
  const selectedPreviewRecord = asRecord(selectedNodeDetail.preview) as Partial<PreviewMetadata>;
  const selectedCommandRecord = asRecord(selectedNodeDetail.command);
  const selectedCommandHostRolloutPath = hostVisibleCodexRolloutPath(selectedNodeDetail, selectedCommandRecord);
  const selectedCommandHostCodexHomePath = hostVisibleCodexHomePath(selectedNodeDetail, selectedCommandRecord);
  const activePreview = activeTask?.latest_preview ?? null;
  const currentCliEvents = session ? codexTerminalEvents(session) : [];
  const currentErrorEvents = activeErrorEvents(session?.raw_events ?? []);
  const cliStreamBody = [
    "Local Codex CLI stream",
    session ? `session: ${session.session_id}` : "session: none",
    session?.workspace_path ? `workspace: ${session.workspace_path}` : `workspace: ${workspacePath}`,
    "",
    ...(currentCliEvents.length
      ? currentCliEvents.map((event) => `[${event.ts}] ${event.type}\n${renderTerminalEvent(event)}`)
      : ["$ waiting for a real codex exec process..."]),
  ].join("\n\n");

  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", padding: 24, maxWidth: 1600, margin: "0 auto" }}>
      <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
        <div>
          <h1 style={{ marginBottom: 6 }}>Codex CLI UI</h1>
          <p style={{ margin: 0, color: "#475569" }}>This browser UI streams one real local Codex CLI session and renders Codex internal subagents from session events.</p>
        </div>
        <div style={{ textAlign: "right", color: "#475569", fontSize: 13 }}>
          <div><strong>Session:</strong> local Codex CLI</div>
          <div><strong>Subagents:</strong> Codex internal</div>
          <div><strong>Model:</strong> {runtimeSettings?.model ?? "loading"}</div>
          <div><strong>Fast planning:</strong> {runtimeSettings ? `${runtimeSettings.planning_model} / ${runtimeSettings.planning_reasoning_effort}` : "loading"}</div>
          <div><strong>Access:</strong> {runtimeSettings?.access ?? "loading"}</div>
          <div><strong>Plugins:</strong> same Codex account</div>
          <div><strong>Browser chat resume:</strong> {runtimeSettings?.conversation_resume_mirror ?? "loading"}</div>
        </div>
      </header>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 16, marginBottom: 24 }}>
        <div style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: 14, background: "#fff" }}>
          <h2 style={{ marginTop: 0 }}>Talk To Codex</h2>
          <textarea
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            rows={5}
            placeholder="Describe what Codex should build in this local repo."
            style={{ width: "100%", boxSizing: "border-box", resize: "vertical" }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <button onClick={sendTextChat}>Send to Codex</button>
            <button onClick={startVoiceChat} disabled={isListening}>{isListening ? "Listening" : "Talk"}</button>
            <button onClick={stopVoiceChat}>Stop</button>
            <button onClick={loadLatestSession}>Load latest session</button>
            <button onClick={() => refresh()}>Refresh</button>
            <button onClick={() => void startNewSession()}>New session + delete project</button>
          </div>
          <div style={{ marginTop: 8, color: "#475569", fontSize: 13 }}>{sessionResetStatus || voiceStatus || "Voice input is ready."}</div>
          <label style={{ display: "block", marginTop: 12, fontSize: 13, color: "#475569" }}>
            Session ID
            <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ width: "100%", boxSizing: "border-box", marginTop: 4 }} />
          </label>
          {session ? (
            <div data-testid="codex-browser-chat-resume" style={{ marginTop: 10, border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#fff", fontSize: 13, color: "#334155" }}>
              <div><strong>Normal terminal chat resume:</strong> <code>{session.codex_conversation_resume_command || "Waiting for the browser chat mirror."}</code></div>
              {session.codex_conversation_mirrored_at ? <div><strong>Mirrored:</strong> {new Date(session.codex_conversation_mirrored_at).toLocaleString()}</div> : null}
              {session.codex_conversation_mirror_error ? <div style={{ color: "#b91c1c" }}><strong>Mirror error:</strong> {session.codex_conversation_mirror_error}</div> : null}
            </div>
          ) : null}
          <div style={{ minHeight: 130, maxHeight: 220, overflow: "auto", border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, marginTop: 12, background: "#f8fafc" }}>
            {chatMessages.length ? (
              chatMessages.map((message) => (
                <div key={message.id} style={{ marginBottom: 10 }}>
                  <strong>{message.role === "user" ? "You" : "Codex"} ({message.source})</strong>
                  <div>{message.text}</div>
                </div>
              ))
            ) : (
              <p style={{ margin: 0, color: "#64748b" }}>Send a request. Clear simple work starts after a short plan; complex work asks for approval first.</p>
            )}
          </div>
        </div>

        <div data-testid="codex-cli-stream" style={{ border: "1px solid #1b2433", borderRadius: 8, overflow: "hidden", background: "#080b10" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 12px", borderBottom: "1px solid #1b2433", color: "#dbeafe" }}>
            <span><strong>Codex CLI</strong> {session?.current_status ? `(${session.current_status})` : "(idle)"}</span>
            <span style={{ color: "#94a3b8", fontSize: 12 }}>stdout/stderr piped live</span>
          </div>
          <pre ref={cliStreamRef} style={{ margin: 0, minHeight: 380, maxHeight: 520, overflow: "auto", padding: 12, color: "#d6f5d6", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.45 }}>
{cliStreamBody}
          </pre>
        </div>
      </section>

      <section data-testid="codex-session-flowchart" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Codex Session Flowchart</h2>
            <div style={{ color: "#555", fontSize: 13 }}>Runtime graph from the live parallel Codex flowchart watcher JSON: request, requirements, plan, Codex-chosen subagents, validation, preview, and final summary.</div>
            <div style={{ color: "#374151", fontSize: 13, marginTop: 4 }}>
              Built by one local Codex session. Orchestrator: Codex CLI | Subagents: Codex internal logical subagents | Source of truth: local repo
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => void createOrchestratorTask()}>Start Codex CLI</button>
            <button onClick={() => void loadFlowchart()}>Refresh flowchart</button>
            {activePreview?.preview_url ? <a href={activePreview.preview_url} target="_blank" rel="noreferrer"><button>Open preview</button></a> : null}
          </div>
        </div>
        {orchestratorTaskStatus ? <div style={{ marginBottom: 10, color: "#374151" }}>{orchestratorTaskStatus}</div> : null}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12 }}>
          <div ref={flowPanelRef} style={{ position: "relative", minHeight: 420, maxHeight: 680, overflow: "auto", border: "1px solid #cbd5e1", borderRadius: 8, background: "#f8fafc" }}>
            <div style={{ position: "relative", width: graphSize.width, height: graphSize.height }}>
              <svg width={graphSize.width} height={graphSize.height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                <defs>
                  <marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                    <path d="M 0 0 L 8 4 L 0 8 z" fill="#475569" />
                  </marker>
                </defs>
                {visibleFlowchartEdges.map((edge) => {
                  const from = nodeById.get(edge.from);
                  const to = nodeById.get(edge.to);
                  if (!from || !to) return null;
                  return (
                    <g key={edge.id}>
                      <path d={flowEdgePath(from, to)} stroke="#64748b" strokeWidth={1.5} fill="none" strokeLinejoin="round" markerEnd="url(#flow-arrow)" />
                      <title>{edge.label}</title>
                    </g>
                  );
                })}
              </svg>
              {visibleFlowchartNodes.map((node) => (
                <button
                  key={node.id}
                  data-testid={`flow-node-${node.type}`}
                  onClick={() => setSelectedNodeId(node.id)}
                  style={{
                    ...flowNodeStyle(node),
                    textAlign: "left",
                    outline: selectedNodeId === node.id ? "3px solid #111827" : "none",
                  }}
                >
                  <div style={{ fontSize: 11, textTransform: "uppercase", color: "#475569", marginBottom: 4 }}>{node.type}</div>
                  <div style={{ fontWeight: 700, marginBottom: 6, overflowWrap: "anywhere" }}>{node.label}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                    <span style={{ border: "1px solid currentColor", borderRadius: 999, padding: "1px 6px", fontSize: 11 }}>{node.status}</span>
                    {node.badges.slice(0, 2).map((badge) => (
                      <span key={badge} style={{ border: "1px solid currentColor", borderRadius: 999, padding: "1px 6px", fontSize: 11 }}>{badge}</span>
                    ))}
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.35, overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{node.summary || "No details yet."}</div>
                </button>
              ))}
            </div>
          </div>
          <aside data-testid="flow-node-details" style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: 12, background: "#fff" }}>
            {selectedNode ? (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 12, textTransform: "uppercase", color: "#64748b" }}>{selectedNode.type}</div>
                    <h3 style={{ marginTop: 2 }}>{selectedNode.label}</h3>
                  </div>
                  <span style={{ border: `1px solid ${flowStateColors[selectedNode.visual_state].border}`, borderRadius: 999, padding: "2px 8px", color: flowStateColors[selectedNode.visual_state].text }}>
                    {selectedNode.status}
                  </span>
                </div>
                <p>{selectedNode.summary}</p>
                {["operator_action", "command_action", "log_inspection", "codex_history"].includes(selectedNode.type) ? (
                  <div data-testid="operator-action-details" style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, marginBottom: 10, background: "#f8fafc" }}>
                    <div><strong>User request:</strong> {stringValue(selectedNodeDetail.user_request) || "Unknown"}</div>
                    <div><strong>Parsed intent:</strong> {stringValue(selectedNodeDetail.parsed_intent) || stringValue(selectedNodeDetail.action_type) || "Unknown"}</div>
                    <div><strong>Risk:</strong> {stringValue(selectedNodeDetail.risk_level) || "Unknown"}</div>
                    <div><strong>Approval:</strong> {stringValue(selectedNodeDetail.approval_status) || "not_required"}</div>
                    <div><strong>Error:</strong> {stringValue(selectedNodeDetail.error) || "None"}</div>
                  </div>
                ) : null}
                {selectedNode.type === "approval" ? (
                  <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                    <button onClick={() => void resolveFlowApproval(selectedNode, "approved")}>Approve</button>
                    <button onClick={() => void resolveFlowApproval(selectedNode, "rejected")}>Reject</button>
                  </div>
                ) : null}
                {selectedNode.type === "preview" ? (
                  <div data-testid="preview-node-details" style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, marginBottom: 10, background: "#f8fafc" }}>
                    <div><strong>Preview URL:</strong> {selectedPreviewRecord.preview_url ? <a href={selectedPreviewRecord.preview_url} target="_blank" rel="noreferrer">{selectedPreviewRecord.preview_url}</a> : "Unknown"}</div>
                    <div><strong>Server:</strong> {selectedPreviewRecord.server_type || "Unknown"}</div>
                    <div><strong>Loaded:</strong> {selectedPreviewRecord.loaded ? "Yes" : "Not reported"}</div>
                    <div><strong>Console errors:</strong> {Array.isArray(selectedPreviewRecord.console_errors) && selectedPreviewRecord.console_errors.length ? selectedPreviewRecord.console_errors.join(" | ") : "None recorded"}</div>
                  </div>
                ) : null}
                {selectedNode.type === "command" ? (
                  <div data-testid="command-codex-history" style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, marginBottom: 10, background: "#f8fafc" }}>
                    <div><strong>Codex session:</strong> {stringValue(selectedNodeDetail.codex_session_id) || stringValue(selectedCommandRecord.codex_session_id) || "Not emitted"}</div>
                    <div><strong>Rollout host path:</strong> {selectedCommandHostRolloutPath || "Not found"}</div>
                    <div><strong>Rollout container path:</strong> {stringValue(selectedNodeDetail.codex_rollout_path) || stringValue(selectedCommandRecord.codex_rollout_path) || "Not found"}</div>
                    <div><strong>Codex home host path:</strong> {selectedCommandHostCodexHomePath || "Unknown"}</div>
                    <div><strong>Codex home container path:</strong> {stringValue(selectedNodeDetail.codex_home) || stringValue(selectedCommandRecord.codex_home) || "Unknown"}</div>
                    <div><strong>Codex auth:</strong> {stringValue(selectedNodeDetail.codex_auth_method) || stringValue(selectedCommandRecord.codex_auth_method) || "Unknown"} {stringValue(selectedNodeDetail.codex_auth_validation_status) || stringValue(selectedCommandRecord.codex_auth_validation_status) || ""}</div>
                    <div><strong>History kind:</strong> {stringValue(selectedNodeDetail.codex_history_kind) || stringValue(selectedCommandRecord.codex_history_kind) || "Unknown"}</div>
                    <div><strong>Confidence:</strong> {stringValue(selectedNodeDetail.codex_history_confidence) || stringValue(selectedCommandRecord.codex_history_confidence) || "Unknown"}</div>
                    <div><strong>Resume:</strong> <code>{stringValue(selectedNodeDetail.codex_resume_command) || stringValue(selectedCommandRecord.codex_resume_command) || "Not available"}</code></div>
                    <div><strong>Verify:</strong> <code>{stringValue(selectedNodeDetail.codex_history_verification_command) || stringValue(selectedCommandRecord.codex_history_verification_command) || "Not available"}</code></div>
                    <div><strong>Prompt:</strong> {stringValue(selectedNodeDetail.codex_prompt_excerpt) || stringValue(selectedCommandRecord.codex_prompt_excerpt) || "Not recorded"}</div>
                  </div>
                ) : null}
                <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, background: "#f8fafc", fontSize: 13 }}>
                  <div><strong>Kind:</strong> {String(selectedNodeDetail.kind ?? selectedNode.type)}</div>
                  <div><strong>Status:</strong> {displayFlowText(String(selectedNodeDetail.status ?? selectedNode.status))}</div>
                  {selectedNodeDetail.flowchart_title ? <div><strong>Flow:</strong> {displayFlowText(String(selectedNodeDetail.flowchart_title))}</div> : null}
                  {selectedNodeDetail.flowchart_overview ? <div><strong>Overview:</strong> {displayFlowText(String(selectedNodeDetail.flowchart_overview))}</div> : null}
                </div>
              </>
            ) : (
              <p>Select a node to inspect runtime details.</p>
            )}
          </aside>
        </div>
      </section>

      <section data-testid="megaplan-panel" style={{ border: "1px solid #d0d7de", borderRadius: 8, background: "#fff", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, padding: "14px 16px", borderBottom: "1px solid #d0d7de", background: "#f6f8fa" }}>
          <div>
            <h2 style={{ margin: "0 0 4px" }}>Megaplan</h2>
            <div style={{ color: "#57606a", fontSize: 13 }}>The first orchestrator artifact. Codex waits for approval before implementation starts.</div>
          </div>
          {session?.pending_action?.type === "approve_megaplan" || session?.pending_action?.action === "approve_megaplan" ? (
            <button onClick={() => void approveMegaplan()}>Approve Megaplan</button>
          ) : null}
        </div>
        {megaplan ? (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "10px 16px", borderBottom: "1px solid #d8dee4", fontSize: 13, color: "#24292f" }}>
              <span><strong>Repo:</strong> <a href={megaplan.repo.link} target="_blank" rel="noreferrer">{megaplan.repo.name}</a></span>
              <span><strong>Branch:</strong> {megaplan.repo.branch ?? "unknown"}</span>
              {megaplan.repo.commit ? <span><strong>Commit:</strong> {megaplan.repo.commit}</span> : null}
              <span><strong>Updated:</strong> {new Date(megaplan.updated_at).toLocaleString()}</span>
            </div>
            <article style={{ padding: "16px 24px", lineHeight: 1.55, color: "#24292f", fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" }}>
              {renderMegaplanMarkdown(megaplan.content)}
            </article>
          </>
        ) : (
          <div style={{ padding: 16, color: "#57606a" }}>
            No Megaplan has been created for this session yet. Send Codex an implementation request and the orchestrator will create MEGAPLAN.md before asking for approval.
          </div>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
