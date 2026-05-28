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
  pending_action: { type: string; original_user_goal: string; requested_kind: string } | null;
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

type WorkerRecord = {
  worker_id: string;
  type: string;
  status: string;
  vm_name?: string;
  actual_vm_name?: string;
  runtime_vm_name?: string;
  task_id?: string;
  project_id?: string;
  image_uri?: string;
  recorded_image_uri?: string;
  actual_image_uri?: string;
  actual_image_digest?: string;
  actual_worker_mode?: string;
  runtime_image_uri?: string;
  runtime_image_digest?: string;
  startup_attempt_id?: string;
  run_attempt_id?: string;
  container_started_at?: string;
  worker_runtime_version?: string;
  codex_auth_method?: string;
  codex_auth_validation_status?: string;
  docker_container_id?: string;
  docker_container_name?: string;
  last_runtime_report_at?: string;
  metadata_verified_from_runtime?: boolean;
  runtime_metadata_updated_at?: string;
  heartbeat_at?: string | null;
  expires_at?: string;
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
  default_worker_mode: "local" | "docker_local" | "gcp_vm";
  allow_worker_mode_switch: boolean;
  max_local_workers: number;
  max_docker_local_workers: number;
  max_gcp_vm_workers: number;
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
const terminalWsUrl = import.meta.env.VITE_SUPERVISOR_TERMINAL_WS_URL?.trim();

if (!apiBase) throw new Error("VITE_SUPERVISOR_API_BASE is required.");
if (!workspacePath) throw new Error("VITE_SUPERVISOR_WORKSPACE_PATH is required.");
if (!supervisorUserId) throw new Error("VITE_SUPERVISOR_USER_ID is required.");
if (!terminalWsUrl) throw new Error("VITE_SUPERVISOR_TERMINAL_WS_URL is required.");

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
  return session.raw_events.filter((event) => event.type.startsWith("codex.cli.") || event.type === "task.started" || event.type === "task.completed");
}

function renderTerminalEvent(event: SessionEvent) {
  const data = asRecord(event.data);
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

function flowNodeStyle(node: FlowchartNode): React.CSSProperties {
  const colors = flowStateColors[node.visual_state] ?? flowStateColors.idle;
  return {
    position: "absolute",
    left: node.position.x,
    top: node.position.y,
    width: 210,
    minHeight: 106,
    border: `2px solid ${colors.border}`,
    background: colors.background,
    color: colors.text,
    borderRadius: 8,
    padding: 10,
    boxSizing: "border-box",
    cursor: "pointer",
    boxShadow: "0 2px 6px rgba(15, 23, 42, 0.08)",
  };
}

function flowGraphSize(flowchart: FlowchartState | null) {
  if (!flowchart?.nodes.length) return { width: 1280, height: 520 };
  const width = Math.max(1280, Math.max(...flowchart.nodes.map((node) => node.position.x)) + 260);
  const height = Math.max(520, Math.max(...flowchart.nodes.map((node) => node.position.y)) + 150);
  return { width, height };
}

function transcriptFromSpeechEvent(event: unknown) {
  const results = (event as { results?: ArrayLike<ArrayLike<{ transcript?: string }>> }).results;
  if (!results?.length) return "";
  const last = results[results.length - 1];
  return String(last?.[0]?.transcript || "").trim();
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
  const [summary, setSummary] = useState<any>(null);
  const [workers, setWorkers] = useState<WorkerRecord[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [flowchart, setFlowchart] = useState<FlowchartState | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [workerMode, setWorkerMode] = useState<"local" | "docker_local" | "gcp_vm">("local");
  const [orchestratorTaskStatus, setOrchestratorTaskStatus] = useState("");
  const [terminalStatus, setTerminalStatus] = useState<"disconnected" | "connecting" | "connected" | "closed" | "error">("disconnected");
  const [terminalOutput, setTerminalOutput] = useState("Terminal is disconnected. Connect to open a local operator shell.\n");
  const [terminalInput, setTerminalInput] = useState("");
  const [desktopTerminalStatus, setDesktopTerminalStatus] = useState("Codex desktop terminal is idle.");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const terminalRef = useRef<WebSocket | null>(null);
  const terminalOutputRef = useRef<HTMLPreElement | null>(null);
  const staleSessionNoticeRef = useRef("");
  const pollFailureCountRef = useRef(0);
  const refreshErrorNoticeRef = useRef("");
  const progressEventIdsRef = useRef(new Set<string>());
  const voiceProgressEnabledRef = useRef(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("codex-phone-supervisor-session");
    if (saved) setSessionId(saved);
  }, []);

  useEffect(() => {
    if (sessionId) window.localStorage.setItem("codex-phone-supervisor-session", sessionId);
  }, [sessionId]);

  useEffect(() => {
    terminalOutputRef.current?.scrollTo({ top: terminalOutputRef.current.scrollHeight });
  }, [terminalOutput]);

  useEffect(() => {
    return () => {
      terminalRef.current?.close();
    };
  }, []);

  function appendTerminalOutput(text: string) {
    setTerminalOutput((current) => `${current}${text}`);
  }

  function connectTerminal() {
    if (terminalRef.current?.readyState === WebSocket.OPEN || terminalRef.current?.readyState === WebSocket.CONNECTING) return;
    setTerminalStatus("connecting");
    setTerminalOutput(`Connecting to ${terminalWsUrl}\n`);
    const ws = new WebSocket(terminalWsUrl);
    terminalRef.current = ws;
    ws.onopen = () => setTerminalStatus("connected");
    ws.onmessage = (event) => {
      const payload = JSON.parse(String(event.data)) as { type?: string; data?: string; message?: string; status?: string; cwd?: string; shell?: string; shell_args?: string[]; code?: number | null; signal?: string | null };
      if (payload.type === "status" && payload.status === "connected") {
        appendTerminalOutput(`Connected: ${payload.shell} ${(payload.shell_args || []).join(" ")}\nCWD: ${payload.cwd}\n\n`);
        setTerminalStatus("connected");
        return;
      }
      if (payload.type === "status" && payload.status === "closed") {
        appendTerminalOutput(`\n[terminal closed: code=${payload.code ?? "null"} signal=${payload.signal ?? "null"}]\n`);
        setTerminalStatus("closed");
        return;
      }
      if (payload.type === "output") {
        appendTerminalOutput(payload.data || "");
        return;
      }
      if (payload.type === "error") {
        appendTerminalOutput(`\n[terminal error] ${payload.message || "Unknown terminal error."}\n`);
        setTerminalStatus("error");
      }
    };
    ws.onerror = () => {
      appendTerminalOutput("\n[terminal websocket error]\n");
      setTerminalStatus("error");
    };
    ws.onclose = () => {
      setTerminalStatus((current) => current === "error" ? "error" : "closed");
      terminalRef.current = null;
    };
  }

  function sendTerminalInput() {
    const text = terminalInput;
    if (!text.trim()) return;
    const ws = terminalRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendTerminalOutput("\n[terminal is not connected]\n");
      return;
    }
    appendTerminalOutput(`$ ${text}\n`);
    ws.send(JSON.stringify({ type: "input", data: `${text}\n` }));
    setTerminalInput("");
  }

  function sendTerminalInterrupt() {
    const ws = terminalRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "interrupt" }));
  }

  function disconnectTerminal() {
    terminalRef.current?.close();
  }

  function clearMissingSession(missingSessionId: string) {
    window.localStorage.removeItem("codex-phone-supervisor-session");
    setSessionId((current) => current === missingSessionId ? "" : current);
    setSession(null);
    setSummary(null);
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

  async function launchDesktopCodexTerminal() {
    setDesktopTerminalStatus("Launching Codex in the configured desktop terminal...");
    const result = await fetch(`${apiBase}/terminal/launch-codex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then(readJsonResponse) as { workspace_path?: string };
    setDesktopTerminalStatus(`Launched Codex at ${result.workspace_path || "configured workspace"}.`);
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
      const summaryResponse = await fetch(`${apiBase}/codex/summary?session_id=${encodeURIComponent(targetSessionId)}`);
      if (summaryResponse.status === 404) {
        pollFailureCountRef.current += 1;
        clearMissingSession(targetSessionId);
        return;
      }
      const summaryPayload = await readJsonResponse(summaryResponse);
      const workersPayload = await fetch(`${apiBase}/workers`).then(readJsonResponse).catch(() => ({ workers: [] })) as { workers?: WorkerRecord[] };
      const activeProjectId = targetSession.project_id || targetSession.current_project_id;
      const tasksPayload = activeProjectId
        ? await fetch(`${apiBase}/projects/${encodeURIComponent(activeProjectId)}/tasks`).then(readJsonResponse).catch(() => ({ tasks: [] })) as { tasks?: TaskRecord[] }
        : { tasks: [] };
      await loadFlowchart();
      pollFailureCountRef.current = 0;
      refreshErrorNoticeRef.current = "";
      appendProgressMessages(targetSession);
      setSession(targetSession);
      setSummary(summaryPayload);
      setWorkers(workersPayload.workers ?? []);
      setTasks(tasksPayload.tasks ?? []);
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
    setWorkerMode(payload.worker_settings.default_worker_mode);
    setSelectedNodeId((current) => current && payload.nodes.some((node) => node.id === current) ? current : payload.nodes.find((node) => node.type === "orchestrator")?.id ?? "");
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

  useEffect(() => {
    if (!sessionId) return;
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [sessionId]);

  async function startTask() {
    const res = await fetch(`${apiBase}/codex/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, workspace_path: workspacePath }),
    }).then(readJsonResponse) as { session_id: string };
    setSessionId(res.session_id);
    await refresh(res.session_id);
  }

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

  async function updateWorkerMode(mode: "local" | "docker_local" | "gcp_vm") {
    const payload = await fetch(`${apiBase}/orchestrator/worker-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker_mode: mode }),
    }).then(readJsonResponse) as { settings: WorkerSettings };
    setWorkerMode(payload.settings.default_worker_mode);
    await loadFlowchart();
  }

  async function createOrchestratorTask(mode = workerMode) {
    if (!session?.project_id && !session?.current_project_id) {
      setOrchestratorTaskStatus("Select or create a project before assigning an orchestrator worker.");
      return;
    }
    const goal = task.trim() || instruction.trim() || session.active_task;
    if (!goal.trim()) {
      setOrchestratorTaskStatus("Enter a task goal first.");
      return;
    }
    setOrchestratorTaskStatus(`Assigning ${mode} worker...`);
    const payload = await fetch(`${apiBase}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        session_id: session.session_id,
        project_id: session.project_id || session.current_project_id,
        user_goal: goal,
        assign_worker: true,
        worker_type: mode,
      }),
    }).then(readJsonResponse) as { task?: TaskRecord; worker?: WorkerRecord };
    setOrchestratorTaskStatus(`Task ${payload.task?.task_id ?? ""} assigned to ${payload.worker?.type ?? mode}.`);
    await loadFlowchart();
  }

  async function runOperatorAction(actionType: string, input: Record<string, unknown> = {}, userGoal = actionType) {
    if (!session?.session_id) return;
    await fetch(`${apiBase}/operator/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: session.session_id,
        action_type: actionType,
        user_goal: userGoal,
        project_id: session.project_id || session.current_project_id || activeTask?.project_id,
        task_id: activeTask?.task_id,
        worker_id: activeWorker?.worker_id,
        input,
      }),
    }).then(readJsonResponse);
    await refresh();
    await loadFlowchart();
  }

  async function controlWorker(workerId: string, action: "stop" | "restart") {
    await runOperatorAction(action === "stop" ? "stop_worker" : "restart_worker", { worker_id: workerId }, `${action} worker`);
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
  const activeWorker = session?.active_worker_id
    ? workers.find((item) => item.worker_id === session.active_worker_id) ?? null
    : activeTask?.worker_id
      ? workers.find((item) => item.worker_id === activeTask.worker_id) ?? null
      : workers.find((item) => item.status !== "stopped" && item.status !== "expired") ?? null;
  const selectedNode = flowchart?.nodes.find((node) => node.id === selectedNodeId) ?? flowchart?.nodes.find((node) => node.type === "orchestrator") ?? null;
  const graphSize = flowGraphSize(flowchart);
  const nodeById = new Map((flowchart?.nodes ?? []).map((node) => [node.id, node]));
  const latestCommandNode = flowchart?.nodes.find((node) => node.type === "command");
  const latestCommand = latestCommandNode?.label || session?.commands_completed.at(-1) || session?.commands_failed.at(-1) || "None";
  const selectedNodeDetail = selectedNode ? asRecord(selectedNode.detail) : {};
  const selectedPreviewRecord = asRecord(selectedNodeDetail.preview) as Partial<PreviewMetadata>;
  const selectedCommandRecord = asRecord(selectedNodeDetail.command);
  const selectedCommandHostRolloutPath = hostVisibleCodexRolloutPath(selectedNodeDetail, selectedCommandRecord);
  const selectedCommandHostCodexHomePath = hostVisibleCodexHomePath(selectedNodeDetail, selectedCommandRecord);
  const activePreview = activeTask?.latest_preview ?? null;
  const selectedWorkerRecord = asRecord(selectedNodeDetail.worker);
  const selectedWorkerRuntime = selectedNode?.type === "worker"
    ? {
        recordedImage: stringValue(selectedNodeDetail.recorded_image_uri) || stringValue(selectedWorkerRecord.image_uri),
        actualImage: stringValue(selectedNodeDetail.actual_image_uri) || stringValue(selectedNodeDetail.runtime_image_uri) || stringValue(selectedWorkerRecord.actual_image_uri) || stringValue(selectedWorkerRecord.runtime_image_uri),
        actualDigest: stringValue(selectedNodeDetail.actual_image_digest) || stringValue(selectedNodeDetail.runtime_image_digest) || stringValue(selectedWorkerRecord.actual_image_digest) || stringValue(selectedWorkerRecord.runtime_image_digest),
        recordedVm: stringValue(selectedNodeDetail.recorded_vm_name) || stringValue(selectedWorkerRecord.vm_name),
        actualVm: stringValue(selectedNodeDetail.actual_vm_name) || stringValue(selectedNodeDetail.runtime_vm_name) || stringValue(selectedWorkerRecord.actual_vm_name) || stringValue(selectedWorkerRecord.runtime_vm_name),
        attemptId: stringValue(selectedNodeDetail.run_attempt_id) || stringValue(selectedNodeDetail.startup_attempt_id) || stringValue(selectedWorkerRecord.run_attempt_id) || stringValue(selectedWorkerRecord.startup_attempt_id),
        containerStartedAt: stringValue(selectedNodeDetail.container_started_at) || stringValue(selectedWorkerRecord.container_started_at),
        runtimeVersion: stringValue(selectedNodeDetail.worker_runtime_version) || stringValue(selectedWorkerRecord.worker_runtime_version),
        dockerContainerId: stringValue(selectedNodeDetail.docker_container_id) || stringValue(selectedWorkerRecord.docker_container_id),
        dockerContainerName: stringValue(selectedNodeDetail.docker_container_name) || stringValue(selectedWorkerRecord.docker_container_name),
        codexHome: stringValue(selectedNodeDetail.codex_home) || stringValue(selectedWorkerRecord.codex_home),
        codexHomeHostPath: stringValue(selectedNodeDetail.codex_home_host_path) || stringValue(selectedWorkerRecord.codex_home_host_path),
        codexSessionsPath: stringValue(selectedNodeDetail.codex_history_sessions_path) || stringValue(selectedWorkerRecord.codex_history_sessions_path),
        codexAuthMethod: stringValue(selectedNodeDetail.codex_auth_method) || stringValue(selectedWorkerRecord.codex_auth_method),
        codexAuthStatus: stringValue(selectedNodeDetail.codex_auth_validation_status) || stringValue(selectedWorkerRecord.codex_auth_validation_status),
        updatedAt: stringValue(selectedNodeDetail.last_runtime_report_at) || stringValue(selectedNodeDetail.runtime_metadata_updated_at) || stringValue(selectedWorkerRecord.last_runtime_report_at) || stringValue(selectedWorkerRecord.runtime_metadata_updated_at),
        verified: selectedNodeDetail.metadata_verified_from_runtime === true || selectedWorkerRecord.metadata_verified_from_runtime === true,
        imageMismatch: selectedNodeDetail.image_mismatch === true,
        vmMismatch: selectedNodeDetail.vm_name_mismatch === true,
      }
    : null;

  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", padding: 24, maxWidth: 1600, margin: "0 auto" }}>
      <h1>Codex Phone Supervisor</h1>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 24 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
          <h3>1. In-app voice</h3>
          <p>Computer mic to browser speech recognition, then `/call/message`.</p>
          <button onClick={startVoiceChat} disabled={isListening}>{isListening ? "Listening" : "Talk"}</button>{" "}
          <button onClick={stopVoiceChat}>Stop</button>
          <div style={{ marginTop: 8, color: "#555" }}>{voiceStatus || "Ready for mic input."}</div>
        </div>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
          <h3>2. In-app text</h3>
          <p>Browser text chat to the same supervisor intent router.</p>
          <textarea value={chatInput} onChange={(e) => setChatInput(e.target.value)} rows={3} style={{ width: "100%" }} />
          <button onClick={sendTextChat}>Send chat</button>
        </div>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
          <h3>3. Twilio text</h3>
          <p>Inbound SMS webhook calls the supervisor tools only.</p>
          <code>POST /twilio/sms</code>
        </div>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
          <h3>4. Twilio phone</h3>
          <p>ConversationRelay phone calls use the same approval firewall.</p>
          <code>POST /twilio/voice</code>
        </div>
      </section>

      <section data-testid="cloud-orchestrator-flowchart" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Cloud Orchestrator Control Room</h2>
            <div style={{ color: "#555", fontSize: 13 }}>Runtime graph from sessions, projects, tasks, workers, commands, approvals, and summaries.</div>
            {flowchart?.model_providers ? (
              <div style={{ color: "#374151", fontSize: 13, marginTop: 4 }}>
                Supervisor: {flowchart.model_providers.supervisor_model_provider} | Planner: {flowchart.model_providers.planner_model_provider} | Worker code model: {flowchart.model_providers.worker_code_model}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label>
              Worker mode{" "}
              <select
                data-testid="worker-mode-selector"
                value={workerMode}
                disabled={flowchart?.worker_settings.allow_worker_mode_switch === false}
                onChange={(event) => void updateWorkerMode(event.target.value as "local" | "docker_local" | "gcp_vm")}
              >
                <option value="local">Local</option>
                <option value="docker_local">Docker Local</option>
                <option value="gcp_vm">GCP VM</option>
              </select>
            </label>
            <button onClick={() => void createOrchestratorTask("local")}>Run Local</button>
            <button onClick={() => void createOrchestratorTask("docker_local")}>Run Docker</button>
            <button onClick={() => void createOrchestratorTask("gcp_vm")}>Run GCP VM</button>
            <button onClick={() => void runOperatorAction("list_workers", {}, "list workers")}>List workers</button>
            <button onClick={() => void runOperatorAction("start_worker", { worker_mode: workerMode }, "start worker")}>Start worker</button>
            <button onClick={() => activeWorker ? void runOperatorAction("stop_worker", { worker_id: activeWorker.worker_id }, "stop worker") : undefined}>Stop worker</button>
            <button onClick={() => activeWorker ? void runOperatorAction("restart_worker", { worker_id: activeWorker.worker_id }, "restart worker") : undefined}>Restart worker</button>
            <button onClick={() => {
              const command = window.prompt("Safe command to run through the active worker", "pwd");
              if (command) void runOperatorAction("run_worker_command", { command }, `run ${command}`);
            }}>Run safe command</button>
            <button onClick={() => void runOperatorAction("tail_worker_logs", { lines: 20 }, "tail logs")}>Tail logs</button>
            <button onClick={() => void runOperatorAction("cancel_task", {}, "cancel task")}>Cancel task</button>
            <button onClick={() => void runOperatorAction("retry_task", {}, "retry task")}>Retry task</button>
            <button onClick={() => void runOperatorAction("open_preview", {}, "preview latest app")}>Preview latest app</button>
            <button onClick={() => void runOperatorAction("inspect_codex_history", {}, "show Codex history")}>Show Codex history</button>
          </div>
        </div>
        {orchestratorTaskStatus ? <div style={{ marginBottom: 10, color: "#374151" }}>{orchestratorTaskStatus}</div> : null}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 16 }}>
          <div style={{ position: "relative", minHeight: 520, overflow: "auto", border: "1px solid #cbd5e1", borderRadius: 8, background: "#f8fafc" }}>
            <div style={{ position: "relative", width: graphSize.width, height: graphSize.height }}>
              <svg width={graphSize.width} height={graphSize.height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                {(flowchart?.edges ?? []).map((edge) => {
                  const from = nodeById.get(edge.from);
                  const to = nodeById.get(edge.to);
                  if (!from || !to) return null;
                  const x1 = from.position.x + 210;
                  const y1 = from.position.y + 52;
                  const x2 = to.position.x;
                  const y2 = to.position.y + 52;
                  const mid = Math.max(x1 + 26, (x1 + x2) / 2);
                  return (
                    <g key={edge.id}>
                      <path d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} stroke="#64748b" strokeWidth={1.5} fill="none" />
                      <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} fill="#475569" fontSize="11" textAnchor="middle">{edge.label}</text>
                    </g>
                  );
                })}
              </svg>
              {(flowchart?.nodes ?? []).map((node) => (
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
                  <div style={{ fontSize: 12, lineHeight: 1.35, overflowWrap: "anywhere" }}>{node.summary || "No details yet."}</div>
                </button>
              ))}
            </div>
          </div>
          <aside data-testid="flow-node-details" style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: 12, minHeight: 520, background: "#fff" }}>
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
                {selectedNode.type === "worker" ? (
                  <>
                    <div data-testid="worker-runtime-metadata" style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, marginBottom: 10, background: selectedWorkerRuntime?.imageMismatch ? "#fff7ed" : "#f8fafc" }}>
                      <div><strong>Recorded image:</strong> {selectedWorkerRuntime?.recordedImage || "Unknown"}</div>
                      <div><strong>Actual runtime image:</strong> {selectedWorkerRuntime?.actualImage || "Not reported yet"}</div>
                      <div><strong>Image digest:</strong> {selectedWorkerRuntime?.actualDigest || "Not reported yet"}</div>
                      <div><strong>Recorded VM:</strong> {selectedWorkerRuntime?.recordedVm || "None"}</div>
                      <div><strong>Actual VM:</strong> {selectedWorkerRuntime?.actualVm || "Not reported yet"}</div>
                      <div><strong>Startup attempt:</strong> {selectedWorkerRuntime?.attemptId || "Not reported yet"}</div>
                      <div><strong>Container started:</strong> {selectedWorkerRuntime?.containerStartedAt || "Not reported yet"}</div>
                      <div><strong>Runtime version:</strong> {selectedWorkerRuntime?.runtimeVersion || "Not reported yet"}</div>
                      <div><strong>Docker container:</strong> {selectedWorkerRuntime?.dockerContainerName || selectedWorkerRuntime?.dockerContainerId || "Not reported yet"}</div>
                      <div><strong>Codex home container path:</strong> {selectedWorkerRuntime?.codexHome || "Not reported yet"}</div>
                      <div><strong>Codex home host path:</strong> {selectedWorkerRuntime?.codexHomeHostPath || "Not reported yet"}</div>
                      <div><strong>Codex sessions container path:</strong> {selectedWorkerRuntime?.codexSessionsPath || "Not reported yet"}</div>
                      <div><strong>Codex auth:</strong> {selectedWorkerRuntime?.codexAuthMethod ? `${selectedWorkerRuntime.codexAuthMethod} (${selectedWorkerRuntime.codexAuthStatus || "unknown"})` : "Not reported yet"}</div>
                      <div><strong>Verified from runtime:</strong> {selectedWorkerRuntime?.verified ? "Yes" : "No"}</div>
                      {selectedWorkerRuntime?.updatedAt ? <div><strong>Runtime metadata:</strong> {selectedWorkerRuntime.updatedAt}</div> : null}
                      {selectedWorkerRuntime?.imageMismatch ? <div style={{ color: "#9a3412", marginTop: 6 }}><strong>Image mismatch:</strong> recorded and runtime images differ.</div> : null}
                      {selectedWorkerRuntime?.vmMismatch ? <div style={{ color: "#9a3412", marginTop: 6 }}><strong>VM mismatch:</strong> recorded and runtime VM names differ.</div> : null}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                      <button onClick={() => void controlWorker(selectedNode.id.replace(/^worker:/, ""), "stop")}>Stop</button>
                      <button onClick={() => void controlWorker(selectedNode.id.replace(/^worker:/, ""), "restart")}>Restart</button>
                      <button onClick={() => void runOperatorAction("tail_worker_logs", { worker_id: selectedNode.id.replace(/^worker:/, ""), lines: 20 }, "tail worker logs")}>Tail logs</button>
                    </div>
                  </>
                ) : null}
                {["operator_action", "worker_control", "command_action", "log_inspection", "codex_history"].includes(selectedNode.type) ? (
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
                    <div><strong>Entry file:</strong> {selectedPreviewRecord.entry_file || "Unknown"}</div>
                    <div><strong>Server:</strong> {selectedPreviewRecord.server_type || "Unknown"}</div>
                    <div><strong>Loaded:</strong> {selectedPreviewRecord.loaded ? "Yes" : "Not reported"}</div>
                    <div><strong>Console errors:</strong> {Array.isArray(selectedPreviewRecord.console_errors) && selectedPreviewRecord.console_errors.length ? selectedPreviewRecord.console_errors.join(" | ") : "None recorded"}</div>
                    {selectedPreviewRecord.screenshot_path ? <div><strong>Screenshot:</strong> {selectedPreviewRecord.screenshot_path}</div> : null}
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
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 390, overflow: "auto", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 10, fontSize: 12 }}>
{JSON.stringify(selectedNode.detail, null, 2)}
                </pre>
              </>
            ) : (
              <p>Select a node to inspect runtime details.</p>
            )}
          </aside>
        </div>
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        <div>
          <h2>Local chat transcript</h2>
          <div style={{ minHeight: 160, maxHeight: 260, overflow: "auto", border: "1px solid #ccc", borderRadius: 8, padding: 12 }}>
            {chatMessages.length ? (
              chatMessages.map((message) => (
                <div key={message.id} style={{ marginBottom: 10 }}>
                  <strong>{message.role === "user" ? "You" : "Supervisor"} ({message.source})</strong>
                  <div>{message.text}</div>
                </div>
              ))
            ) : (
              <p>Start by naming the project you want Codex to work in. The selector will ask a follow-up if needed.</p>
            )}
          </div>
        </div>
        <div>
          <h2>Operator terminal</h2>
          <p style={{ color: "#555" }}>Direct local shell for the human operator. Voice, SMS, mic, and app text cannot access this terminal.</p>
          <div style={{ border: "1px solid #1b2433", borderRadius: 14, overflow: "hidden", background: "#080b10" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "10px 12px", borderBottom: "1px solid #1b2433", color: "#dbeafe" }}>
              <span><strong>Status:</strong> {terminalStatus}</span>
              <span style={{ color: "#94a3b8", fontSize: 12 }}>configured websocket</span>
            </div>
            <pre ref={terminalOutputRef} style={{ margin: 0, minHeight: 220, maxHeight: 360, overflow: "auto", padding: 12, color: "#d6f5d6", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.45 }}>
{terminalOutput}
            </pre>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: 10, borderTop: "1px solid #1b2433", background: "#0d1320" }}>
              <input
                value={terminalInput}
                onChange={(event) => setTerminalInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    sendTerminalInput();
                  }
                }}
                placeholder="Type a shell command and press Enter"
                style={{ minHeight: 34, borderRadius: 8, border: "1px solid #263244", padding: "0 10px", background: "#05070b", color: "#e2e8f0", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
              />
              <button onClick={sendTerminalInput}>Send</button>
            </div>
            <div style={{ display: "flex", gap: 8, padding: "0 10px 10px", background: "#0d1320" }}>
              <button onClick={connectTerminal} disabled={terminalStatus === "connecting" || terminalStatus === "connected"}>Connect</button>
              <button onClick={sendTerminalInterrupt} disabled={terminalStatus !== "connected"}>Interrupt</button>
              <button onClick={disconnectTerminal} disabled={terminalStatus !== "connected"}>Disconnect</button>
              <button onClick={() => setTerminalOutput("")}>Clear</button>
              <button onClick={() => void launchDesktopCodexTerminal()}>Open Codex in desktop terminal</button>
            </div>
          </div>
          <p style={{ marginTop: 10, color: "#555" }}>{desktopTerminalStatus}</p>
          <p style={{ marginTop: 10, color: "#555" }}>All agent channels still go through backend tools and the approval firewall.</p>
        </div>
      </section>

      <section style={{ display: "grid", gap: 12, marginBottom: 24 }}>
        <label>
          New task
          <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={4} style={{ width: "100%" }} />
        </label>
        <button onClick={startTask}>Start Codex Task</button>
        <label>
          Session ID
          <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} style={{ width: "100%" }} />
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => refresh()} style={{ flex: 1 }}>Refresh</button>
          <button onClick={loadLatestSession} style={{ flex: 1 }}>Load latest session</button>
        </div>
      </section>

      {session ? (
        <>
          <section style={{ display: "grid", gridTemplateColumns: "1.15fr 0.85fr 1fr", gap: 24 }}>
            <div>
              <h2>Status</h2>
              <p><strong>{session.current_status}</strong></p>
              <p>{session.latest_codex_message || session.summary_text}</p>
              {session.pending_action ? <p><strong>Pending action:</strong> {session.pending_action.type} for {session.pending_action.requested_kind}</p> : null}
              <p><strong>Task:</strong> {session.active_task}</p>
              <p><strong>Active task ID:</strong> {session.active_task_id || activeTask?.task_id || "None"}</p>
              <p><strong>Project:</strong> {session.project_discovery.selected_project_name || "Not selected yet"}</p>
              <p><strong>Project ID:</strong> {session.project_id || session.current_project_id || "None"}</p>
              <p><strong>Workspace:</strong> {session.workspace_path}</p>
              <p><strong>Project selection:</strong> {session.project_discovery.status}</p>
              <p><strong>Active worker:</strong> {activeWorker ? `${activeWorker.worker_id} (${activeWorker.type}, ${activeWorker.status})` : "None"}</p>
              <p><strong>VM:</strong> {activeWorker?.actual_vm_name || activeWorker?.runtime_vm_name || activeWorker?.vm_name || "None"}</p>
              <p><strong>Worker image:</strong> {activeWorker?.actual_image_uri || activeWorker?.runtime_image_uri || activeWorker?.image_uri || "Unknown"}</p>
              {activeWorker?.actual_image_digest || activeWorker?.runtime_image_digest ? <p><strong>Image digest:</strong> {activeWorker.actual_image_digest || activeWorker.runtime_image_digest}</p> : null}
              {activeWorker?.run_attempt_id || activeWorker?.startup_attempt_id ? <p><strong>Startup attempt:</strong> {activeWorker.run_attempt_id || activeWorker.startup_attempt_id}</p> : null}
              <p><strong>Current command:</strong> {latestCommand}</p>
              {activePreview ? (
                <div data-testid="preview-status-card" style={{ border: "1px solid #bfdbfe", borderRadius: 8, padding: 10, margin: "10px 0", background: "#eff6ff" }}>
                  <div><strong>Preview:</strong> <a href={activePreview.preview_url} target="_blank" rel="noreferrer">{activePreview.preview_url}</a></div>
                  <div><strong>Status:</strong> {activePreview.status}{activePreview.loaded ? " (loaded)" : ""}</div>
                  <div><strong>Entry:</strong> {activePreview.entry_file}</div>
                  <div><strong>Console:</strong> {activePreview.console_errors.length ? `${activePreview.console_errors.length} error(s)` : "No errors recorded"}</div>
                </div>
              ) : null}
              {session.project_discovery.last_question ? <p><strong>Selector question:</strong> {session.project_discovery.last_question}</p> : null}
              <p><strong>Diff:</strong> {session.git_diff_summary || "None"}</p>

              <h3>Pending approvals</h3>
              {session.pending_approvals.filter((item) => item.status === "pending").length ? (
                session.pending_approvals
                  .filter((item) => item.status === "pending")
                  .map((item) => (
                    <div key={item.id} style={{ border: "1px solid #ccc", padding: 12, marginBottom: 10 }}>
                      <div><strong>{item.command}</strong></div>
                      <div>{item.reason}</div>
                      <div>Risk: {item.risk}</div>
                      <button onClick={() => respond(item.id, "approved")}>Approve</button>{" "}
                      <button onClick={() => respond(item.id, "denied")}>Deny</button>
                    </div>
                  ))
              ) : (
                <p>No pending approvals.</p>
              )}

              <h3>Send instruction</h3>
              <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} style={{ width: "100%" }} />
              <button onClick={sendInstruction} disabled={session.project_discovery.status !== "selected"}>Send to Codex</button>
            </div>

            <div>
              <h3>Files touched</h3>
              <ul>{session.files_modified.map((file) => <li key={file}>{file}</li>)}</ul>
              <h3>Commands run</h3>
              <ul>{session.commands_completed.map((command) => <li key={command}>{command}</li>)}</ul>
              <h3>Command failures</h3>
              <ul>{session.commands_failed.map((command) => <li key={command}>{command}</li>)}</ul>
              <h3>Summary</h3>
              <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(summary, null, 2)}</pre>
              <h3>Progress timeline</h3>
              <ul>
                {session.raw_events.filter((event) => event.type === "progress.update").slice(-8).map((event) => (
                  <li key={event.id}>{event.message}</li>
                ))}
              </ul>
              <h3>Next plan</h3>
              <ul>{(activeTask?.next_steps?.length ? activeTask.next_steps : ["No orchestrator task plan is active."]).map((item) => <li key={item}>{item}</li>)}</ul>
              <h3>Error cards</h3>
              {session.raw_events.filter((event) => /failed|error|stale/i.test(event.type)).slice(-5).length ? (
                session.raw_events.filter((event) => /failed|error|stale/i.test(event.type)).slice(-5).map((event) => (
                  <div key={event.id} style={{ border: "1px solid #dc2626", borderRadius: 8, padding: 8, marginBottom: 8, background: "#fef2f2" }}>
                    <strong>{event.type}</strong>
                    <div>{event.message}</div>
                  </div>
                ))
              ) : (
                <p>No active errors.</p>
              )}
              <h3>Workers</h3>
              <ul>{workers.slice(0, 5).map((worker) => <li key={worker.worker_id}>{worker.worker_id}: {worker.status}{worker.actual_vm_name || worker.runtime_vm_name || worker.vm_name ? ` (${worker.actual_vm_name || worker.runtime_vm_name || worker.vm_name})` : ""}</li>)}</ul>
            </div>

            <div>
              <h2>Codex CLI sidecar</h2>
              <p style={{ color: "#555" }}>Read-only view of the backend Codex CLI bridge for this session.</p>
              <div style={{ background: "#080b10", color: "#d6f5d6", borderRadius: 12, padding: 14, minHeight: 420, maxHeight: 640, overflow: "auto", boxShadow: "inset 0 0 0 1px #1d2633" }}>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, lineHeight: 1.5 }}>
{[
  "Codex CLI bridge",
  `session: ${session.session_id}`,
  `workspace: ${session.workspace_path}`,
  "",
  ...(codexTerminalEvents(session).length
    ? codexTerminalEvents(session).map((event) => `[${event.ts}] ${event.type}\n${renderTerminalEvent(event)}`)
    : ["$ waiting for codex exec events..."]),
].join("\n\n")}
                </pre>
              </div>
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <h2>Live event timeline</h2>
            <div style={{ maxHeight: 420, overflow: "auto", border: "1px solid #ccc", padding: 12 }}>
              {session.raw_events.map((event) => (
                <div key={event.id} style={{ marginBottom: 12 }}>
                  <strong>{event.ts}</strong> [{event.source}] {event.type}
                  <div>{event.message}</div>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
