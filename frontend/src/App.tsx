import { FormEvent, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import Brain from "lucide-react/dist/esm/icons/brain.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.js";
import Code2 from "lucide-react/dist/esm/icons/code-2.js";
import Cpu from "lucide-react/dist/esm/icons/cpu.js";
import Gauge from "lucide-react/dist/esm/icons/gauge.js";
import Keyboard from "lucide-react/dist/esm/icons/keyboard.js";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.js";
import Mic from "lucide-react/dist/esm/icons/mic.js";
import Moon from "lucide-react/dist/esm/icons/moon.js";
import PanelLeftClose from "lucide-react/dist/esm/icons/panel-left-close.js";
import PanelLeftOpen from "lucide-react/dist/esm/icons/panel-left-open.js";
import PhoneCall from "lucide-react/dist/esm/icons/phone-call.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RefreshCcw from "lucide-react/dist/esm/icons/refresh-ccw.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Square from "lucide-react/dist/esm/icons/square.js";
import Sun from "lucide-react/dist/esm/icons/sun.js";
import ThumbsDown from "lucide-react/dist/esm/icons/thumbs-down.js";
import ThumbsUp from "lucide-react/dist/esm/icons/thumbs-up.js";
import Volume2 from "lucide-react/dist/esm/icons/volume-2.js";
import Workflow from "lucide-react/dist/esm/icons/workflow.js";
import { PipecatClient, type RTVIMessage, type TransportState } from "@pipecat-ai/client-js";
import {
  SmallWebRTCTransport,
  type SmallWebRTCTransportConstructorOptions
} from "@pipecat-ai/small-webrtc-transport";
import {
  BrowserAudioMediaManager,
  audioPlayErrorMessage,
  clearAudioElement,
  playAudioTrack
} from "./browserAudioMediaManager";
import {
  apiUrl,
  AutoImprovementState,
  ChatResponse,
  CostGuard,
  EvalSchedulerState,
  getEvalScheduler,
  getAutoImprovement,
  getCost,
  getHealth,
  getVoiceCodexOrchestratorStatus,
  getVoicePreflight,
  getVoiceRuntimeProfile,
  getWebRTCIceConfig,
  getPrompt,
  getTwilioCallLogs,
  Health,
  listEvalRuns,
  prepareVoice,
  PromptState,
  runEval,
  runVoiceTextSuite,
  runVoiceTextTurn,
  sendFeedback,
  sendMessage,
  startEvalScheduler,
  stopEvalScheduler,
  synthesizeVoiceTextAudio,
  type VoicePreflight,
  type VoiceCodexStatusResponse,
  type TwilioCallLog,
  type VoiceRuntimeProfileResponse,
  type VoiceInputMode,
  type VoiceSpeechPath,
  type VoiceTextSuiteResponse,
  type VoiceTextTurnResponse
} from "./api";
import { AppBuilderPage } from "./AppBuilder";
import { FlowStudio } from "./FlowStudio";
import { SelfLearn } from "./SelfLearn";
import { SmokeBackground } from "./SmokeBackground";

type PipecatErrorMessage = {
  data?: {
    message?: string;
  };
};

type PipecatDeviceError = {
  message?: string;
};

type TranscriptData = {
  final?: boolean;
  text?: string;
};

type BotOutputData = {
  spoken?: boolean;
  text?: string;
};

type VoicePhase = "Idle" | "Listening" | "Processing" | "Speaking";

type Turn = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  latency_ms?: number;
  prompt_version?: number;
};

function appendTurn(current: Turn[], next: Turn) {
  const last = current[current.length - 1];
  if (last?.role === next.role && last.content.trim() === next.content.trim()) {
    return current;
  }
  return [...current, next];
}

type EvalRun = {
  id: string;
  suite: string;
  status: string;
  started_at: string;
  aggregate_score: number;
};

type ThemeMode = "dark" | "light";

function initialTheme(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem("voiceops-theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const prompts = [
  "Hey, how's it going?",
  "Tell me a spooky story in four sentences.",
  "How are you reducing network latency?",
  "Can you talk faster?"
];

const voiceIceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const voiceConnectTimeoutMs = 60000;
const voiceWarmupTimeoutMs = 15 * 60 * 1000;
const speechPathStorageKey = "voiceops-speech-path";
const voiceInputModeStorageKey = "voiceops-input-mode";

function initialSpeechPath(): VoiceSpeechPath {
  if (typeof window === "undefined") return "supertone_parakeet";
  return "supertone_parakeet";
}

function initialVoiceInputMode(): VoiceInputMode {
  if (typeof window === "undefined") return "vad";
  return window.localStorage.getItem(voiceInputModeStorageKey) === "push_to_talk"
    ? "push_to_talk"
    : "vad";
}

function Badge({
  children,
  color
}: {
  children: React.ReactNode;
  color: string;
  variant?: string;
  rounded?: string;
}) {
  return <span className={`kitBadge kitBadge-${color}`}>{children}</span>;
}

function CircularWaveform({
  backgroundColor,
  barWidth,
  color1,
  color2,
  isThinking,
  numBars,
  rotationEnabled,
  sensitivity,
  size
}: {
  audioTrack: MediaStreamTrack | null;
  backgroundColor: string;
  barWidth: number;
  color1: string;
  color2: string;
  isThinking: boolean;
  numBars: number;
  rotationEnabled: boolean;
  sensitivity: number;
  size: number;
}) {
  const radius = size / 2 - 16;
  return (
    <div
      className={`kitWaveform ${rotationEnabled ? "isRotating" : ""} ${isThinking ? "isThinking" : ""}`}
      style={
        {
          "--wave-bg": backgroundColor,
          width: size,
          height: size
        } as CSSProperties
      }
    >
      {Array.from({ length: numBars }).map((_, index) => {
        const height = Math.round((16 + (index % 7) * 4) * sensitivity);
        const color = index % 2 ? color2 : color1;
        return (
          <span
            key={index}
            className="kitWaveformBar"
            style={{
              width: barWidth,
              height,
              background: color,
              transform: `rotate(${(360 / numBars) * index}deg) translateY(-${radius}px)`,
              animationDelay: `${index * 32}ms`
            }}
          />
        );
      })}
    </div>
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function pipecatErrorText(message: RTVIMessage) {
  const data = message.data;
  if (!data || typeof data !== "object" || !("message" in data)) return null;
  const errorMessage = (data as PipecatErrorMessage["data"])?.message;
  return typeof errorMessage === "string" ? errorMessage : null;
}

async function requestMicrophoneStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not expose microphone capture.");
  }
  const audio: MediaTrackConstraints = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48000 }
  };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new Error(
        `Microphone permission is blocked. Allow microphone access for ${window.location.origin} and try Unmute again.`
      );
    }
    throw error;
  }
}

function needsCloudVoiceStart(preflight: VoicePreflight) {
  return (
    preflight.llm_provider === "local" &&
    preflight.cloud_vllm.enabled &&
    (preflight.llm_endpoint_healthy === false ||
      preflight.cloud_vllm.last_status !== "RUNNING")
  );
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function formatMaybeMs(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} ms` : "-";
}

function formatMaybeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

function formatDebugValue(value: unknown) {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) {
    if (!value.length) return "-";
    return value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

type AppView = "voice" | "builder" | "live" | "flow" | "selfLearn";

const activeViewStorageKey = "voiceops-active-view";

function normalizeAppView(value: string | null | undefined): AppView | null {
  const normalized = (value ?? "").replace(/^#\/?/, "").trim().toLowerCase();
  if (normalized === "builder" || normalized === "app-builder" || normalized === "appbuilder") return "builder";
  if (normalized === "flow") return "flow";
  if (normalized === "testing" || normalized === "evals" || normalized === "runtime" || normalized === "live") return "live";
  if (normalized === "self-learn" || normalized === "selflearn") return "selfLearn";
  if (normalized === "voice" || normalized === "") return "voice";
  return null;
}

function hashForAppView(view: AppView) {
  if (view === "selfLearn") return "#self-learn";
  if (view === "live") return "#testing";
  return `#${view}`;
}

function initialActiveView() {
  if (typeof window === "undefined") return "voice";
  const hashView = normalizeAppView(window.location.hash);
  if (hashView) return hashView;
  try {
    return normalizeAppView(window.localStorage.getItem(activeViewStorageKey)) ?? "voice";
  } catch {
    return "voice";
  }
}

type VariableBadge = {
  id: string;
  label: string;
  value: string;
};

type RawVariableGroup = {
  title: string;
  rows: Array<{ label: string; value: string }>;
};

type CodexFlowStep = {
  id: string;
  label: string;
  detail: string;
  state: "idle" | "active" | "done" | "failed";
};

type VoiceCodexFlowchart = NonNullable<VoiceCodexStatusResponse["flowchart"]>;

function codexFlowState(status: string | undefined, visualState: string | undefined): CodexFlowStep["state"] {
  const normalized = `${status ?? ""} ${visualState ?? ""}`.toLowerCase();
  if (normalized.includes("failed") || normalized.includes("error")) return "failed";
  if (normalized.includes("completed") || normalized.includes("success")) return "done";
  if (normalized.includes("running") || normalized.includes("planning") || normalized.includes("waiting")) {
    return "active";
  }
  if (normalized.includes("active")) return "active";
  return "idle";
}

function truncateValue(value: string, maxLength = 44) {
  if (value.length <= maxLength) return value;
  const side = Math.max(8, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, side)}...${value.slice(-side)}`;
}

function formatCallDuration(value: string | number | null) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatCallTime(value: string) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function valueText(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataBoolean(metadata: Record<string, unknown> | null | undefined, key: string) {
  return metadata?.[key] === true;
}

function metadataForConversation(value: unknown, conversationId: string | undefined) {
  if (!conversationId) return {};
  const metadata = asRecord(value);
  const metadataConversationId =
    metadataString(metadata, "voice_conversation_id") ?? metadataString(metadata, "conversation_id");
  return metadataConversationId === conversationId ? metadata : {};
}

function codexStatusLabel(metadata: Record<string, unknown>) {
  return (
    metadataString(metadata, "codex_current_status") ??
    metadataString(metadata, "codex_session_status") ??
    metadataString(metadata, "status") ??
    "-"
  );
}

function latestCodexMetadataFromActionStatus(value: unknown) {
  if (!Array.isArray(value)) return {};
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const status = asRecord(value[index]);
    const codex = asRecord(status.codex);
    if (metadataString(codex, "codex_session_id")) {
      return codex;
    }
  }
  return {};
}

function buildCodexFlowSteps(metadata: Record<string, unknown>, hasConversationTurns: boolean): CodexFlowStep[] {
  const sessionId = metadataString(metadata, "codex_session_id");
  const projectId = metadataString(metadata, "codex_project_id");
  const taskId = metadataString(metadata, "codex_task_id");
  const approvalId = metadataString(metadata, "approval_id");
  const requiresApproval = metadataBoolean(metadata, "requires_approval");
  const status = codexStatusLabel(metadata).toLowerCase();
  const failed = status.includes("failed") || status.includes("error");
  const completed = status.includes("completed") || status.includes("succeeded") || status === "success";

  return [
    {
      id: "voice",
      label: "Voice turn",
      detail: hasConversationTurns ? "Transcript captured" : "Waiting",
      state: hasConversationTurns ? "done" : "idle"
    },
    {
      id: "intent",
      label: "Task intent",
      detail: sessionId ? "Delegated" : "Listening",
      state: sessionId ? "done" : "idle"
    },
    {
      id: "codexa",
      label: "Codexa route",
      detail: projectId ? truncateValue(projectId, 28) : sessionId ? "Selecting project" : "Standby",
      state: projectId ? "done" : sessionId ? "active" : "idle"
    },
    {
      id: "plan",
      label: "Plan first",
      detail: requiresApproval ? "Approval gate" : taskId ? "Approved" : sessionId ? "Planning" : "Waiting",
      state: requiresApproval || taskId ? "done" : sessionId ? "active" : "idle"
    },
    {
      id: "approval",
      label: "Approval",
      detail: requiresApproval ? truncateValue(approvalId ?? "pending", 30) : taskId ? "Approved" : "Not requested",
      state: requiresApproval ? "active" : taskId ? "done" : "idle"
    },
    {
      id: "worker",
      label: "Codex worker",
      detail: taskId ? truncateValue(taskId, 32) : "Not started",
      state: failed ? "failed" : completed ? "done" : taskId ? "active" : "idle"
    },
    {
      id: "quality",
      label: "Quality check",
      detail: status === "-" ? "Waiting" : codexStatusLabel(metadata),
      state: failed ? "failed" : completed ? "done" : taskId ? "active" : "idle"
    }
  ];
}

function buildSyncedCodexFlowSteps(
  flowchart: VoiceCodexFlowchart | undefined,
  metadata: Record<string, unknown>,
  hasConversationTurns: boolean
): CodexFlowStep[] {
  const syncedNodes = (flowchart?.nodes ?? []).filter((node) => node.id && node.label);
  if (!syncedNodes.length) return buildCodexFlowSteps(metadata, hasConversationTurns);
  const voiceStep: CodexFlowStep = {
    id: "voice",
    label: "Voice turn",
    detail: hasConversationTurns ? "Transcript captured" : "Waiting",
    state: hasConversationTurns ? "done" : "idle"
  };
  return [
    voiceStep,
    ...syncedNodes.slice(0, 12).map((node) => ({
      id: node.id,
      label: node.label ?? node.type ?? "Codexa",
      detail: node.summary
        ? truncateValue(node.summary, 64)
        : node.badges?.length
          ? node.badges.join(" · ")
          : node.status ?? node.visual_state ?? "Synced",
      state: codexFlowState(node.status, node.visual_state)
    }))
  ];
}

export function App() {
  const [activeView, setActiveViewState] = useState<AppView>(initialActiveView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [voiceConsoleSidebarOpen, setVoiceConsoleSidebarOpen] = useState(true);
  const [voiceConsoleSettingsOpen, setVoiceConsoleSettingsOpen] = useState(false);
  const [codexStatus, setCodexStatus] = useState<VoiceCodexStatusResponse | null>(null);
  const [codexStatusBusy, setCodexStatusBusy] = useState(false);
  const [variableBadges, setVariableBadges] = useState<VariableBadge[]>([]);
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [health, setHealth] = useState<Health | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [flowConversationId, setFlowConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [voiceTextMessage, setVoiceTextMessage] = useState("Can you talk faster?");
  const [voiceTextBusy, setVoiceTextBusy] = useState(false);
  const [voiceTextAudioBusy, setVoiceTextAudioBusy] = useState(false);
  const [voiceTextResult, setVoiceTextResult] = useState<VoiceTextTurnResponse | null>(null);
  const [voiceTextSuite, setVoiceTextSuite] = useState<VoiceTextSuiteResponse | null>(null);
  const [twilioCallLogs, setTwilioCallLogs] = useState<TwilioCallLog[]>([]);
  const [twilioLogsBusy, setTwilioLogsBusy] = useState(false);
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalRuns, setEvalRuns] = useState<EvalRun[]>([]);
  const [scheduler, setScheduler] = useState<EvalSchedulerState | null>(null);
  const [autoImprovement, setAutoImprovement] = useState<AutoImprovementState | null>(null);
  const [cost, setCost] = useState<CostGuard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voiceClient, setVoiceClient] = useState<PipecatClient | null>(null);
  const [voiceState, setVoiceState] = useState<TransportState>("disconnected");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState<"assistant" | "flow">("assistant");
  const [voiceInputMode, setVoiceInputMode] = useState<VoiceInputMode>(initialVoiceInputMode);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("Idle");
  const [voiceRuntime, setVoiceRuntime] = useState<VoiceRuntimeProfileResponse | null>(null);
  const [voicePreflight, setVoicePreflight] = useState<VoicePreflight | null>(null);
  const [speechPath, setSpeechPath] = useState<VoiceSpeechPath>(initialSpeechPath);
  const [assistantEmotion, setAssistantEmotion] = useState("neutral");
  const [localAudioTrack, setLocalAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [botAudioTrack, setBotAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [micEnabled, setMicEnabled] = useState(false);
  const [botSpeaking, setBotSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const botAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceTextAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceTextAudioUrlRef = useRef<string | null>(null);
  const botAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const voiceClientRef = useRef<PipecatClient | null>(null);
  const voiceMediaManagerRef = useRef<BrowserAudioMediaManager | null>(null);
  const voiceStateRef = useRef<TransportState>("disconnected");
  const voiceModeInitializedRef = useRef(false);
  const voicePrewarmStartedRef = useRef(false);
  const voiceConnectInFlightRef = useRef(false);
  const voiceRuntimeRefreshInFlightRef = useRef(false);
  const pushToTalkPressedRef = useRef(false);
  const voiceProcessingStartedAtRef = useRef<number | null>(null);
  const previousVariableSnapshotRef = useRef<Record<string, string> | null>(null);

  function setActiveView(view: AppView) {
    setActiveViewState(view);
    try {
      window.localStorage.setItem(activeViewStorageKey, view);
      const nextHash = hashForAppView(view);
      if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
    } catch {
      // Navigation still works if storage or history is unavailable.
    }
  }

  function clearVoiceTextAudioUrl() {
    if (!voiceTextAudioUrlRef.current) return;
    URL.revokeObjectURL(voiceTextAudioUrlRef.current);
    voiceTextAudioUrlRef.current = null;
  }

  async function refreshVoiceRuntime() {
    if (voiceRuntimeRefreshInFlightRef.current) return;
    voiceRuntimeRefreshInFlightRef.current = true;
    try {
      setVoiceRuntime(await getVoiceRuntimeProfile());
    } catch {
      setVoiceRuntime(null);
    } finally {
      voiceRuntimeRefreshInFlightRef.current = false;
    }
  }

  async function refreshCodexStatus(options: { silent?: boolean; conversationId?: string } = {}) {
    const cid = options.conversationId ?? conversationId;
    if (!cid || codexStatusBusy) return null;
    setCodexStatusBusy(true);
    try {
      const result = await getVoiceCodexOrchestratorStatus(cid);
      setCodexStatus(result);
      return result;
    } catch (error) {
      if (!options.silent) {
        setNotice(error instanceof Error ? error.message : "Codexa status refresh failed");
      }
      return null;
    } finally {
      setCodexStatusBusy(false);
    }
  }

  async function refreshTwilioLogs(options: { silent?: boolean } = {}) {
    if (twilioLogsBusy) return twilioCallLogs;
    setTwilioLogsBusy(true);
    try {
      const result = await getTwilioCallLogs(8);
      setTwilioCallLogs(result.calls);
      return result.calls;
    } catch (error) {
      if (!options.silent) {
        setNotice(error instanceof Error ? error.message : "Twilio call logs refresh failed");
      }
      return twilioCallLogs;
    } finally {
      setTwilioLogsBusy(false);
    }
  }

  async function refresh() {
    const [
      healthState,
      promptState,
      runs,
      costState,
      schedulerState,
      improvementState,
      runtimeState,
      preflightState,
      twilioState
    ] = await Promise.all([
      getHealth(),
      getPrompt(),
      listEvalRuns(),
      getCost(),
      getEvalScheduler(),
      getAutoImprovement(),
      getVoiceRuntimeProfile().catch(() => null),
      getVoicePreflight(speechPath).catch(() => null),
      getTwilioCallLogs(8).catch(() => null)
    ]);
    setHealth(healthState);
    setPrompt(promptState);
    setEvalRuns(runs.runs);
    setCost(costState.cost_guard);
    setScheduler(schedulerState);
    setAutoImprovement(improvementState);
    setVoiceRuntime(runtimeState);
    setVoicePreflight(preflightState);
    if (twilioState) setTwilioCallLogs(twilioState.calls);
    return healthState;
  }

  useEffect(() => {
    refresh()
      .then(() => prewarmVoiceOnLoad())
      .catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    const syncViewFromHash = () => {
      const nextView = normalizeAppView(window.location.hash);
      if (nextView) setActiveViewState(nextView);
    };
    window.addEventListener("hashchange", syncViewFromHash);
    return () => window.removeEventListener("hashchange", syncViewFromHash);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(activeViewStorageKey, activeView);
      const nextHash = hashForAppView(activeView);
      if ((activeView !== "voice" || window.location.hash) && window.location.hash !== nextHash) {
        window.history.replaceState(null, "", nextHash);
      }
    } catch {
      // Keep the console usable if browser storage is unavailable.
    }
  }, [activeView]);

  async function prewarmVoiceOnLoad() {
    if (voicePrewarmStartedRef.current) return;
    voicePrewarmStartedRef.current = true;
    try {
      const preflight = await getVoicePreflight(speechPath);
      setVoicePreflight(preflight);
      if (!preflight.ready || !needsCloudVoiceStart(preflight)) return;
      setVoiceNotice("Starting the voice VM. Connect will be faster once it is ready.");
      await withTimeout(
        prepareVoice(speechPath),
        voiceWarmupTimeoutMs,
        "Voice VM warmup timed out. Click Connect to retry."
      );
      setVoiceNotice("Voice VM is ready. Click Connect when you want to talk.");
      await refresh();
    } catch (error) {
      setVoiceNotice(error instanceof Error ? error.message : "Voice VM warmup failed.");
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("voiceops-theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem(speechPathStorageKey, speechPath);
  }, [speechPath]);

  useEffect(() => {
    window.localStorage.setItem(voiceInputModeStorageKey, voiceInputMode);
    if (voiceInputMode === "push_to_talk" && voiceClientRef.current?.isMicEnabled) {
      voiceClientRef.current.enableMic(false);
      setMicEnabled(false);
      setUserSpeaking(false);
      setVoicePhase("Idle");
    }
  }, [voiceInputMode]);

  useEffect(() => {
    if (
      !voiceModeInitializedRef.current &&
      (health?.voice_behavior_mode === "assistant" || health?.voice_behavior_mode === "flow")
    ) {
      voiceModeInitializedRef.current = true;
      setVoiceMode(health.voice_behavior_mode);
    }
  }, [health?.voice_behavior_mode]);

  function resetVoiceUi() {
    setMicEnabled(false);
    setBotSpeaking(false);
    setUserSpeaking(false);
    setVoicePhase("Idle");
    setLocalAudioTrack(null);
    setBotAudioTrack(null);
    botAudioTrackRef.current = null;
  }

  function playBotAudio() {
    const audio = botAudioRef.current;
    const track = botAudioTrackRef.current;
    if (!audio || !track) return;
    playAudioTrack(audio, track).catch((error) => {
      const message = audioPlayErrorMessage(error);
      if (message) setVoiceNotice(message);
    });
  }

  function createVoiceClient(): PipecatClient {
    if (!window.RTCPeerConnection) {
      throw new Error("Browser voice needs WebRTC support.");
    }

    const mediaManager = new BrowserAudioMediaManager();
    voiceMediaManagerRef.current = mediaManager;
    const client = new PipecatClient({
      transport: new SmallWebRTCTransport({
        iceServers: voiceIceServers,
        mediaManager: mediaManager as unknown as SmallWebRTCTransportConstructorOptions["mediaManager"],
        waitForICEGathering: false
      }),
      enableMic: false,
      enableCam: false,
      callbacks: {
        onConnected: () => setVoiceNotice(null),
        onDisconnected: () => {
          resetVoiceUi();
          if (voiceClientRef.current === client) {
            voiceClientRef.current = null;
            voiceMediaManagerRef.current = null;
            setVoiceClient(null);
          }
        },
        onTransportStateChanged: (state: TransportState) => {
          voiceStateRef.current = state;
          setVoiceState(state);
        },
        onError: (message: RTVIMessage) => {
          const errorMessage = pipecatErrorText(message);
          if (errorMessage) {
            setVoiceNotice(errorMessage);
          }
        },
        onDeviceError: (error: PipecatDeviceError) => {
          setVoiceNotice(error.message ?? "Device access failed");
        },
        onTrackStarted: (track: MediaStreamTrack, participant?: unknown) => {
          if (track.kind !== "audio") return;
          if (participant) {
            setLocalAudioTrack(track);
            setMicEnabled(true);
            setVoiceNotice(null);
          } else {
            botAudioTrackRef.current = track;
            setBotAudioTrack(track);
            window.setTimeout(playBotAudio, 0);
          }
        },
        onTrackStopped: (track: MediaStreamTrack, participant?: unknown) => {
          if (track.kind !== "audio") return;
          if (participant) {
            setLocalAudioTrack(null);
            setMicEnabled(false);
          } else {
            botAudioTrackRef.current = null;
            setBotAudioTrack(null);
          }
        },
        onUserStartedSpeaking: () => {
          setUserSpeaking(true);
          setVoicePhase("Listening");
        },
        onUserStoppedSpeaking: () => {
          setUserSpeaking(false);
          voiceProcessingStartedAtRef.current = Date.now();
          setVoicePhase("Processing");
        },
        onBotStartedSpeaking: () => {
          setBotSpeaking(true);
          setVoicePhase("Speaking");
          window.setTimeout(playBotAudio, 0);
        },
        onBotStoppedSpeaking: () => {
          setBotSpeaking(false);
          setVoicePhase("Idle");
        },
        onUserTranscript: (data: TranscriptData) => {
          const text = data.text?.trim();
          if (!data.final || !text) return;
          voiceProcessingStartedAtRef.current = Date.now();
          setVoicePhase("Processing");
          setTurns((current) =>
            appendTurn(current, { id: crypto.randomUUID(), role: "user", content: text })
          );
        },
        onBotOutput: (data: BotOutputData) => {
          const text = data.text?.trim();
          if (!text || !data.spoken) return;
          setAssistantEmotion(inferEmotion(text));
          setVoicePhase("Speaking");
          setTurns((current) =>
            appendTurn(current, { id: crypto.randomUUID(), role: "assistant", content: text })
          );
        }
      }
    });
    voiceClientRef.current = client;
    setVoiceClient(client);
    return client;
  }

  useEffect(() => {
    return () => {
      voiceClientRef.current?.disconnect().catch(() => undefined);
      voiceClientRef.current = null;
      voiceMediaManagerRef.current = null;
      botAudioTrackRef.current = null;
      clearVoiceTextAudioUrl();
    };
  }, []);

  const lastAssistant = useMemo(() => [...turns].reverse().find((turn) => turn.role === "assistant"), [turns]);
  const latency = lastAssistant?.latency_ms ?? 0;
  const voiceConnected = voiceState === "connected" || voiceState === "ready";
  const voiceBusy = voiceState === "connecting" || voiceState === "initializing";
  const voiceStatus = voiceConnected ? voicePhase.toLowerCase() : voiceState;

  useEffect(() => {
    if (voicePhase !== "Processing") {
      voiceProcessingStartedAtRef.current = null;
      return;
    }
    if (!voiceConnected || userSpeaking || botSpeaking) return;
    voiceProcessingStartedAtRef.current ??= Date.now();
    const startedAt = voiceProcessingStartedAtRef.current;
    const timeout = window.setTimeout(() => {
      if (voiceProcessingStartedAtRef.current !== startedAt) return;
      setVoicePhase("Idle");
      setVoiceNotice("No assistant audio returned for that turn. You can speak again.");
      voiceProcessingStartedAtRef.current = null;
    }, 22000);
    return () => window.clearTimeout(timeout);
  }, [botSpeaking, userSpeaking, voiceConnected, voicePhase]);

  const sttBadge = voiceProviderLabel(health?.local_stt_provider, "STT");
  const ttsBadge = "Supertonic TTS";
  const codexDependency = voicePreflight?.dependencies.codex;
  const codexDependencyLabel =
    codexDependency?.healthy === true
      ? "Codexa live"
      : codexDependency?.healthy === false
        ? "Codexa down"
        : "Codexa check";
  const codexDependencyBadgeColor =
    codexDependency?.healthy === false ? "inactive" : codexDependency?.healthy === true ? "active" : "secondary";
  const runtimeProfile = voiceRuntime?.profile;
  const runtimeLatency = runtimeProfile?.latency ?? {};
  const runtimeTts = runtimeProfile?.tts ?? {};
  const runtimeLlm = runtimeProfile?.llm ?? {};
  const runtimeTurnTaking = runtimeProfile?.turn_taking ?? {};
  const runtimeDebug = runtimeProfile?.debug ?? {};
  const lastLearningRecord = voiceRuntime?.recent_learning_logs[0]?.record ?? {};
  const lastTtsParams = (lastLearningRecord.tts_params as Record<string, unknown> | undefined) ?? {};
  const lastQualitySignals =
    (lastLearningRecord.quality_signals as Record<string, unknown> | undefined) ?? {};
  const lastFailureTypes = Array.isArray(lastQualitySignals.failure_types)
    ? lastQualitySignals.failure_types.join(", ")
    : Array.isArray(runtimeProfile?.quality?.recent_failure_types)
      ? runtimeProfile?.quality?.recent_failure_types.join(", ")
      : "-";
  const allowedExpressionTags = Array.isArray(runtimeTts.allowed_expression_tags)
    ? runtimeTts.allowed_expression_tags.join(", ")
    : "-";
  const usedExpressionTags = Array.isArray(lastTtsParams.expression_tags_used)
    ? lastTtsParams.expression_tags_used.join(", ")
    : "-";
  const lastProfileChange =
    runtimeProfile?.last_profile_change &&
    Array.isArray(runtimeProfile.last_profile_change.reasons)
      ? runtimeProfile.last_profile_change.reasons.join(", ")
      : "-";
  const lastRuntimeActions = formatDebugValue(runtimeDebug.last_runtime_actions);
  const lastRuntimeActionStatus = formatDebugValue(runtimeDebug.last_runtime_action_status);
  const lastStructuredOutput = formatDebugValue(runtimeDebug.last_llm_structured_output);
  const parseErrors = formatDebugValue(runtimeDebug.structured_output_parse_errors);
  const lastSupertonicPayload = formatDebugValue(runtimeDebug.last_supertonic_payload);
  const lastRenderedDebugText = formatDebugValue(
    runtimeDebug.last_tts_rendered_text ?? lastLearningRecord.tts_rendered_text
  );
  const voicePhases: VoicePhase[] = ["Idle", "Listening", "Processing", "Speaking"];
  const codexMetadata = useMemo(() => {
    const rawStatusMetadata =
      codexStatus && codexStatus.conversation_id === conversationId ? codexStatus.codex : {};
    const statusMetadata = metadataString(rawStatusMetadata, "codex_session_id") ? rawStatusMetadata : {};
    const actionMetadata = metadataForConversation(
      latestCodexMetadataFromActionStatus(runtimeDebug.last_runtime_action_status),
      conversationId
    );
    const runtimeMetadata = metadataForConversation(runtimeDebug.last_codex_orchestrator, conversationId);
    const voiceTextMetadata =
      voiceTextResult?.conversation_id === conversationId ? asRecord(voiceTextResult?.codex) : {};
    return {
      ...runtimeMetadata,
      ...actionMetadata,
      ...voiceTextMetadata,
      ...asRecord(statusMetadata)
    };
  }, [
    conversationId,
    codexStatus,
    runtimeDebug.last_codex_orchestrator,
    runtimeDebug.last_runtime_action_status,
    voiceTextResult?.codex,
    voiceTextResult?.conversation_id
  ]);
  const codexSessionId = metadataString(codexMetadata, "codex_session_id");
  const codexProjectId = metadataString(codexMetadata, "codex_project_id");
  const codexTaskId = metadataString(codexMetadata, "codex_task_id");
  const codexApprovalId = metadataString(codexMetadata, "approval_id");
  const codexRequiresApproval = metadataBoolean(codexMetadata, "requires_approval");
  const codexCurrentStatus = codexStatusLabel(codexMetadata);
  const codexSyncedFlowchart =
    codexStatus && codexStatus.conversation_id === conversationId ? codexStatus.flowchart : undefined;
  const codexFlowSteps = useMemo(
    () => buildSyncedCodexFlowSteps(codexSyncedFlowchart, codexMetadata, turns.length > 0),
    [codexMetadata, codexSyncedFlowchart, turns.length]
  );
  const codexFlowVisible = Boolean(codexSessionId);
  const recentHistoryTurns = turns.slice(-8);
  const observedVariables = useMemo(
    () => ({
      transport: voiceState,
      phase: voicePhase,
      mic: micEnabled ? "enabled" : "muted",
      speech_path: speechPath,
      input_mode: voiceInputMode,
      tts_speed: valueText(runtimeTts.speed),
      conversation: conversationId ? truncateValue(conversationId, 28) : "-",
      codex_session: codexSessionId ? truncateValue(codexSessionId, 28) : "-",
      codex_project: codexProjectId ? truncateValue(codexProjectId, 28) : "-",
      codex_task: codexTaskId ? truncateValue(codexTaskId, 28) : "-",
      codex_flow_nodes: valueText(codexSyncedFlowchart?.nodes.length),
      approval: codexRequiresApproval ? codexApprovalId ?? "pending" : "false",
      codex_status: codexCurrentStatus
    }),
    [
      codexApprovalId,
      codexCurrentStatus,
      codexProjectId,
      codexRequiresApproval,
      codexSessionId,
      codexSyncedFlowchart?.nodes.length,
      codexTaskId,
      conversationId,
      micEnabled,
      runtimeTts.speed,
      speechPath,
      voiceInputMode,
      voicePhase,
      voiceState
    ]
  );
  const rawVariableGroups = useMemo<RawVariableGroup[]>(
    () => [
      {
        title: "Voice",
        rows: [
          { label: "transport", value: voiceState },
          { label: "phase", value: voicePhase },
          { label: "connected", value: valueText(voiceConnected) },
          { label: "mic_enabled", value: valueText(micEnabled) },
          { label: "user_speaking", value: valueText(userSpeaking) },
          { label: "bot_speaking", value: valueText(botSpeaking) },
          { label: "input_mode", value: voiceInputMode },
          { label: "speech_path", value: speechPath }
        ]
      },
      {
        title: "Codexa",
        rows: [
          { label: "enabled", value: valueText(health?.codex_orchestrator_enabled) },
          { label: "base_url", value: health?.codex_orchestrator_base_url ?? "-" },
          { label: "preflight", value: codexDependencyLabel },
          { label: "preflight_error", value: codexDependency?.error ?? "-" },
          { label: "conversation_id", value: conversationId ?? "-" },
          { label: "session_id", value: codexSessionId ?? "-" },
          { label: "project_id", value: codexProjectId ?? "-" },
          { label: "task_id", value: codexTaskId ?? "-" },
          { label: "requires_approval", value: valueText(codexRequiresApproval) },
          { label: "approval_id", value: codexApprovalId ?? "-" },
          { label: "status", value: codexCurrentStatus },
          { label: "flowchart_status", value: codexSyncedFlowchart?.status ?? "-" },
          { label: "flowchart_nodes", value: valueText(codexSyncedFlowchart?.nodes.length) },
          { label: "flowchart_edges", value: valueText(codexSyncedFlowchart?.edges.length) },
          { label: "last_message", value: codexStatus?.message ?? voiceTextResult?.message ?? "-" }
        ]
      },
      {
        title: "Runtime",
        rows: [
          { label: "model_profile", value: String(runtimeProfile?.active_model_profile ?? "-") },
          { label: "llm_model", value: String(runtimeLlm.current_model ?? runtimeLlm.balanced_model ?? "-") },
          { label: "llm_ttfb_ms", value: formatMaybeMs(runtimeLatency.last_llm_ttfb_ms) },
          { label: "first_audio_ms", value: formatMaybeMs(runtimeLatency.last_first_audio_ms) },
          { label: "runtime_actions", value: lastRuntimeActions },
          { label: "action_status", value: lastRuntimeActionStatus }
        ]
      },
      {
        title: "TTS",
        rows: [
          { label: "provider", value: String(runtimeTts.provider ?? ttsBadge) },
          { label: "voice", value: String(runtimeTts.voice ?? "-") },
          { label: "speed", value: valueText(runtimeTts.speed) },
          { label: "steps", value: valueText(runtimeTts.steps) },
          { label: "expression_mode", value: String(runtimeTts.expression_mode ?? "-") },
          { label: "last_rendered", value: lastRenderedDebugText }
        ]
      }
    ],
    [
      botSpeaking,
      codexApprovalId,
      codexCurrentStatus,
      codexDependency?.error,
      codexDependencyLabel,
      codexProjectId,
      codexRequiresApproval,
      codexSessionId,
      codexStatus?.message,
      codexSyncedFlowchart?.edges.length,
      codexSyncedFlowchart?.nodes.length,
      codexSyncedFlowchart?.status,
      codexTaskId,
      conversationId,
      health?.codex_orchestrator_base_url,
      health?.codex_orchestrator_enabled,
      lastRenderedDebugText,
      lastRuntimeActionStatus,
      lastRuntimeActions,
      micEnabled,
      runtimeLlm.balanced_model,
      runtimeLlm.current_model,
      runtimeLatency.last_first_audio_ms,
      runtimeLatency.last_llm_ttfb_ms,
      runtimeProfile?.active_model_profile,
      runtimeTts.expression_mode,
      runtimeTts.provider,
      runtimeTts.speed,
      runtimeTts.steps,
      runtimeTts.voice,
      speechPath,
      ttsBadge,
      userSpeaking,
      voiceConnected,
      voiceInputMode,
      voicePhase,
      voiceState,
      voiceTextResult?.message
    ]
  );

  useEffect(() => {
    refreshVoiceRuntime();
    const interval = window.setInterval(refreshVoiceRuntime, voiceConnected ? 5000 : 10000);
    return () => window.clearInterval(interval);
  }, [voiceConnected, speechPath]);

  useEffect(() => {
    const previous = previousVariableSnapshotRef.current;
    if (previous) {
      const changes = Object.entries(observedVariables)
        .filter(([key, value]) => previous[key] !== value)
        .slice(0, 4)
        .map(([key, value]) => ({
          id: crypto.randomUUID(),
          label: key,
          value
        }));
      if (changes.length > 0) {
        setVariableBadges((current) => [...changes, ...current].slice(0, 6));
        const ids = new Set<string>(changes.map((change) => change.id));
        window.setTimeout(() => {
          setVariableBadges((current) => current.filter((change) => !ids.has(change.id)));
        }, 2800);
      }
    }
    previousVariableSnapshotRef.current = observedVariables;
  }, [observedVariables]);

  useEffect(() => {
    if (!conversationId || activeView !== "voice" || !codexSessionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await getVoiceCodexOrchestratorStatus(conversationId);
        if (!cancelled) {
          setCodexStatus(result);
        }
      } catch {
        // Status polling is opportunistic; manual refresh surfaces errors.
      }
    };
    poll();
    const interval = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeView, codexSessionId, conversationId]);

  useEffect(() => {
    if (activeView !== "voice") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await getTwilioCallLogs(8);
        if (!cancelled) setTwilioCallLogs(result.calls);
      } catch {
        // Manual refresh surfaces call-log fetch errors.
      }
    };
    poll();
    const interval = window.setInterval(poll, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeView]);

  useEffect(() => {
    const audio = botAudioRef.current;
    botAudioTrackRef.current = botAudioTrack;
    if (!audio) return;
    if (!botAudioTrack) {
      clearAudioElement(audio);
      return;
    }
    playAudioTrack(audio, botAudioTrack).catch((error) => {
      const message = audioPlayErrorMessage(error);
      if (message) setVoiceNotice(message);
    });
  }, [botAudioTrack]);

  async function enableVoiceMicForVad(client: PipecatClient, timeoutMs: number) {
    const stream = await withTimeout(
      requestMicrophoneStream(),
      timeoutMs,
      "Microphone permission timed out. Allow microphone access and try Connect again."
    );
    voiceMediaManagerRef.current?.setPendingMicStream(stream);
    client.enableMic(true);
    setMicEnabled(true);
  }

  async function toggleVoiceConnection() {
    if (voiceConnectInFlightRef.current) return;
    const currentClient = voiceClientRef.current;
    voiceConnectInFlightRef.current = true;
    setVoiceNotice(null);
    try {
      if (voiceConnected && currentClient) {
        await currentClient.disconnect();
        voiceClientRef.current = null;
        voiceMediaManagerRef.current = null;
        botAudioTrackRef.current = null;
        setVoiceClient(null);
        return;
      }
      const preflight = await getVoicePreflight(speechPath);
      setVoicePreflight(preflight);
      if (!preflight.ready) {
        throw new Error(preflight.reasons.join(" "));
      }
      const needsCloudStart = needsCloudVoiceStart(preflight);
      if (needsCloudStart) {
        setVoiceNotice("Starting the voice VM. First connect can take several minutes.");
      }
      const connectTimeoutMs =
        needsCloudStart ? Math.max(voiceConnectTimeoutMs, voiceWarmupTimeoutMs) : voiceConnectTimeoutMs;
      await withTimeout(
        prepareVoice(speechPath),
        connectTimeoutMs,
        needsCloudStart
          ? "Voice preparation timed out while starting the model VM."
          : "Voice preparation timed out while checking speech services."
      );
      const client = createVoiceClient();
      if (voiceInputMode === "vad") {
        await enableVoiceMicForVad(client, connectTimeoutMs);
      }
      const voiceConversationId = crypto.randomUUID();
      setConversationId(voiceConversationId);
      await withTimeout(
        getWebRTCIceConfig()
          .catch(() => ({ iceServers: voiceIceServers }))
          .then((iceConfig) =>
            client.connect({
              webrtcRequestParams: {
                endpoint: apiUrl("/api/offer"),
                requestData: {
                  source: "browser_console",
                  conversation_id: voiceConversationId,
                  voice_behavior_mode: voiceMode,
                  voice_flow_id: health?.voice_flow_id ?? "active",
                  voice_speech_path: speechPath,
                  input_mode: voiceInputMode
                }
              },
              iceConfig
            })
          ),
        connectTimeoutMs,
        "Voice connection timed out. This network may be blocking WebRTC; switch networks or retry with TURN enabled."
      );
      setMicEnabled(client.isMicEnabled);
      setVoiceNotice(null);
    } catch (error) {
      await voiceClientRef.current?.disconnect().catch(() => undefined);
      voiceClientRef.current = null;
      voiceMediaManagerRef.current = null;
      botAudioTrackRef.current = null;
      setVoiceClient(null);
      setVoiceNotice(error instanceof Error ? error.message : "Pipecat connection failed.");
    } finally {
      voiceConnectInFlightRef.current = false;
    }
  }

  async function toggleVoiceMic() {
    if (!voiceClient || !voiceConnected) return;
    if (voiceInputMode === "push_to_talk") return;
    try {
      const next = !micEnabled;
      if (next) {
        const stream = await withTimeout(
          requestMicrophoneStream(),
          voiceConnectTimeoutMs,
          "Microphone permission timed out. Allow microphone access and try Unmute again."
        );
        voiceMediaManagerRef.current?.setPendingMicStream(stream);
      }
      voiceClient.enableMic(next);
      if (!next) {
        setMicEnabled(false);
        setVoiceNotice(null);
      }
    } catch (error) {
      setVoiceNotice(error instanceof Error ? error.message : "Microphone toggle failed.");
    }
  }

  async function startPushToTalk() {
    const client = voiceClientRef.current;
    if (!client || !voiceConnected || voiceInputMode !== "push_to_talk") return;
    if (pushToTalkPressedRef.current) return;
    pushToTalkPressedRef.current = true;
    try {
      const stream = await withTimeout(
        requestMicrophoneStream(),
        voiceConnectTimeoutMs,
        "Microphone permission timed out. Allow microphone access and try Push to Talk again."
      );
      voiceMediaManagerRef.current?.setPendingMicStream(stream);
      client.enableMic(true);
      setMicEnabled(true);
      setUserSpeaking(true);
      setVoicePhase("Listening");
      setVoiceNotice(null);
    } catch (error) {
      pushToTalkPressedRef.current = false;
      setMicEnabled(false);
      setUserSpeaking(false);
      setVoicePhase("Idle");
      setVoiceNotice(error instanceof Error ? error.message : "Push to Talk failed.");
    }
  }

  function stopPushToTalk() {
    const client = voiceClientRef.current;
    if (!pushToTalkPressedRef.current) return;
    pushToTalkPressedRef.current = false;
    if (client && voiceConnected) {
      client.enableMic(false);
    }
    setMicEnabled(false);
    setUserSpeaking(false);
    voiceProcessingStartedAtRef.current = Date.now();
    setVoicePhase("Processing");
  }

  useEffect(() => {
    if (voiceInputMode !== "push_to_talk" || !voiceConnected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      startPushToTalk();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (!pushToTalkPressedRef.current && isTypingTarget(event.target)) return;
      event.preventDefault();
      stopPushToTalk();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      stopPushToTalk();
    };
  }, [voiceInputMode, voiceConnected]);

  async function submit(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const text = (override ?? message).trim();
    if (!text || busy) return null;
    setBusy(true);
    setNotice(null);
    setTurns((current) =>
      appendTurn(current, { id: crypto.randomUUID(), role: "user", content: text })
    );
    setMessage("");
    try {
      const response = await sendMessage(text, conversationId);
      applyAssistantResponse(response);
      await refresh();
      return response;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  function applyAssistantResponse(response: ChatResponse) {
    setConversationId(response.conversation_id);
    setCost(response.cost_guard);
    setTurns((current) =>
      appendTurn(current, {
        id: response.assistant_turn_id,
        role: "assistant",
        content: response.message,
        latency_ms: response.latency_ms,
        prompt_version: response.prompt_version
      })
    );
  }

  function applyVoiceTextResponse(response: VoiceTextTurnResponse) {
    setConversationId(response.conversation_id);
    setCost(response.cost_guard);
    setTurns((current) => {
      const withUser = appendTurn(current, {
        id: response.user_turn_id,
        role: "user",
        content: response.input.text
      });
      return appendTurn(withUser, {
        id: response.assistant_turn_id,
        role: "assistant",
        content: response.message,
        latency_ms: response.latency_ms,
        prompt_version: response.prompt_version
      });
    });
  }

  function watchTwilioCall(call: TwilioCallLog) {
    setConversationId(call.conversation_id);
    setTurns(
      call.turns.map((turn) => ({
        id: turn.id,
        role: turn.role,
        content: turn.content,
        latency_ms: turn.latency_ms ?? undefined
      }))
    );
    void refreshCodexStatus({ silent: true, conversationId: call.conversation_id });
  }

  async function playVoiceTextTtsForResult(
    result: VoiceTextTurnResponse | null | undefined,
    options: { autoplay?: boolean } = {}
  ) {
    const text = result?.message.trim();
    if (!text || voiceTextAudioBusy) return;
    const audio = voiceTextAudioRef.current;
    if (!audio) {
      if (!options.autoplay) setNotice("Text TTS audio element is not ready.");
      return;
    }
    setVoiceTextAudioBusy(true);
    setNotice(null);
    try {
      audio.pause();
      clearVoiceTextAudioUrl();
      const blob = await synthesizeVoiceTextAudio({
        text,
        voice_speech_path: speechPath,
        user_text: result?.input.text
      });
      const url = URL.createObjectURL(blob);
      voiceTextAudioUrlRef.current = url;
      audio.src = url;
      audio.muted = false;
      audio.volume = 1;
      await audio.play();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Text TTS playback failed";
      setNotice(options.autoplay ? `${message}. Use Play TTS to retry.` : message);
    } finally {
      setVoiceTextAudioBusy(false);
    }
  }

  async function playVoiceTextTts() {
    await playVoiceTextTtsForResult(voiceTextResult);
  }

  async function executeVoiceTextTurn(event?: FormEvent) {
    event?.preventDefault();
    const text = voiceTextMessage.trim();
    if (!text || voiceTextBusy) return;
    setVoiceTextBusy(true);
    clearVoiceTextAudioUrl();
    setNotice(null);
    try {
      const result = await runVoiceTextTurn({
        message: text,
        conversation_id: conversationId,
        voice_behavior_mode: voiceMode,
        voice_flow_id: health?.voice_flow_id ?? "active",
        voice_speech_path: speechPath,
        input_mode: "push_to_talk"
      });
      setVoiceTextResult(result);
      setVoiceTextSuite(null);
      applyVoiceTextResponse(result);
      if (result.codex?.codex_session_id && speechPath === "supertone_parakeet") {
        await playVoiceTextTtsForResult(result, { autoplay: true });
      }
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Text voice test failed");
    } finally {
      setVoiceTextBusy(false);
    }
  }

  async function executeVoiceTextSuite() {
    if (voiceTextBusy) return;
    setVoiceTextBusy(true);
    clearVoiceTextAudioUrl();
    setNotice(null);
    try {
      const result = await runVoiceTextSuite({
        conversation_id: conversationId,
        voice_behavior_mode: voiceMode,
        voice_flow_id: health?.voice_flow_id ?? "active",
        voice_speech_path: speechPath,
        input_mode: "push_to_talk"
      });
      setVoiceTextSuite(result);
      setVoiceTextResult(result.cases[result.cases.length - 1]?.turn ?? null);
      result.cases.forEach((testCase) => applyVoiceTextResponse(testCase.turn));
      setNotice(`Text voice suite ${result.status}: ${result.summary.passed}/${result.summary.total}`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Text voice suite failed");
    } finally {
      setVoiceTextBusy(false);
    }
  }

  async function rate(rating: number, label: string) {
    if (!conversationId || !lastAssistant) return;
    const result = await sendFeedback({
      conversation_id: conversationId,
      turn_id: lastAssistant.id,
      rating,
      label
    });
    setNotice(`Feedback applied to prompt v${result.active_prompt_version}`);
    await refresh();
  }

  async function executeEval() {
    setEvalBusy(true);
    setNotice(null);
    try {
      const result = await runEval();
      setNotice(`Eval ${result.status}: ${(result.aggregate_score * 100).toFixed(0)}%`);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Eval failed");
    } finally {
      setEvalBusy(false);
    }
  }

  async function toggleScheduler() {
    setEvalBusy(true);
    setNotice(null);
    try {
      const state = scheduler?.running ? await stopEvalScheduler() : await startEvalScheduler(300);
      setScheduler(state);
      setNotice(state.running ? "Scheduled evals started" : "Scheduled evals stopped");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Scheduler update failed");
    } finally {
      setEvalBusy(false);
    }
  }

  return (
    <main className={`shell ${sidebarCollapsed ? "shellCollapsed" : ""}`} data-theme={theme}>
      <SmokeBackground smokeColor={theme === "light" ? "#35c878" : "#3cff82"} />
      <aside className="rail">
        <div className="railChrome">
          <button
            className="railIconButton"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
          <button
            className="railIconButton"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
        </div>
        <div className="brand">
          <span className="brandMark"><Sparkles size={18} /></span>
          <div className="brandText">
            <strong>Codexa</strong>
            <span>Feedback engine</span>
          </div>
        </div>
        <nav className="nav">
          <button
            className={activeView === "voice" ? "active" : ""}
            onClick={() => setActiveView("voice")}
            aria-label="Voice agent"
            title="Voice agent"
          >
            <Mic size={18} /> <span className="navLabel">Voice</span>
          </button>
          <button
            className={activeView === "builder" ? "active" : ""}
            onClick={() => setActiveView("builder")}
            aria-label="App builder"
            title="App builder"
          >
            <Code2 size={18} /> <span className="navLabel">Builder</span>
          </button>
          <button
            className={activeView === "flow" ? "active" : ""}
            onClick={() => setActiveView("flow")}
            aria-label="Flow"
            title="Flow"
          >
            <Workflow size={18} /> <span className="navLabel">Flow</span>
          </button>
          <button
            className={activeView === "live" ? "active" : ""}
            onClick={() => setActiveView("live")}
            aria-label="Testing"
            title="Testing"
          >
            <MessageSquare size={18} /> <span className="navLabel">Testing</span>
          </button>
          <button
            className={activeView === "selfLearn" ? "active" : ""}
            onClick={() => setActiveView("selfLearn")}
            aria-label="Self-learn"
            title="Self-learn"
          >
            <Brain size={18} /> <span className="navLabel">Self-learn</span>
          </button>
          <button onClick={() => setActiveView("live")} aria-label="Evals" title="Evals">
            <Activity size={18} /> <span className="navLabel">Evals</span>
          </button>
          <button onClick={() => setActiveView("live")} aria-label="Runtime" title="Runtime">
            <Gauge size={18} /> <span className="navLabel">Runtime</span>
          </button>
        </nav>
        <div className="railFooter">
          <span>
            <i />
            {voiceConnected ? "Voice online" : "Voice standby"}
          </span>
          <strong>{health?.voice_runtime ?? "Runtime loading"}</strong>
          <small>{health?.model ?? "Model loading"}</small>
        </div>
      </aside>

      <section className="workspace">
        <audio ref={botAudioRef} autoPlay className="persistentVoiceAudio" />
        {activeView === "voice" ? (
          <section className={`voiceConsole ${voiceConsoleSidebarOpen ? "" : "voiceConsoleCompact"}`}>
            <header className="voiceConsoleTopbar">
              <div>
                <p className="eyebrow">Voice Agent</p>
                <h1>Codexa Voice</h1>
              </div>
              <div className="voiceConsoleHeaderActions">
                <Badge color={voiceConnected ? "active" : "inactive"}>
                  {voiceConnected ? "voice connected" : "voice standby"}
                </Badge>
                <Badge color={codexSessionId ? "active" : codexDependencyBadgeColor}>
                  {codexSessionId ? "codexa synced" : codexDependencyLabel}
                </Badge>
                <button
                  className="voiceConsoleIconButton"
                  type="button"
                  onClick={() => refresh()}
                  aria-label="Refresh"
                  title="Refresh"
                >
                  <RefreshCcw size={17} />
                </button>
                <button
                  className={`voiceConsoleIconButton ${voiceConsoleSettingsOpen ? "active" : ""}`}
                  type="button"
                  onClick={() => setVoiceConsoleSettingsOpen((current) => !current)}
                  aria-label="Settings"
                  title="Settings"
                >
                  <Gauge size={17} />
                </button>
                <button
                  className="voiceConsoleIconButton"
                  type="button"
                  onClick={() => setVoiceConsoleSidebarOpen((current) => !current)}
                  aria-label={voiceConsoleSidebarOpen ? "Hide variables" : "Show variables"}
                  title={voiceConsoleSidebarOpen ? "Hide variables" : "Show variables"}
                >
                  {voiceConsoleSidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
                </button>
              </div>
            </header>

            <div className="voiceConsoleLayout">
              <section className="voiceConsoleStage">
                <div className="voiceConsoleCore">
                  <div className={`voiceOrbShell ${voiceConnected ? "connected" : ""} ${botSpeaking ? "speaking" : ""}`}>
                    <CircularWaveform
                      audioTrack={localAudioTrack}
                      backgroundColor={emotionBackground(assistantEmotion)}
                      barWidth={5}
                      color1={emotionColors(assistantEmotion)[0]}
                      color2={emotionColors(assistantEmotion)[1]}
                      isThinking={voiceBusy || botSpeaking || voiceTextBusy}
                      numBars={58}
                      rotationEnabled={voiceConnected || voiceTextBusy}
                      sensitivity={1.5}
                      size={246}
                    />
                    <div className="voiceOrbState">
                      <strong>{voiceConnected ? voicePhase : voiceTextBusy ? "Processing" : "Ready"}</strong>
                      <span>{voiceConnected ? voiceStatus : `${sttBadge} · ${ttsBadge}`}</span>
                    </div>
                  </div>

                  <div className="voiceConsoleControls">
                    <button type="button" className="voicePrimaryButton" onClick={toggleVoiceConnection} disabled={voiceBusy}>
                      {voiceConnected ? "Disconnect" : voiceBusy ? "Connecting" : "Connect"}
                    </button>
                    <button
                      type="button"
                      className="voiceSecondaryButton"
                      onClick={toggleVoiceMic}
                      disabled={!voiceConnected || voiceInputMode === "push_to_talk"}
                    >
                      {voiceInputMode === "push_to_talk" ? "Hold Space" : micEnabled ? "Mute" : "Unmute"}
                    </button>
                  </div>

                  <div className="voiceConsoleSegments">
                    <div className="voiceConsoleSegmented" aria-label="Voice mode">
                      <button
                        type="button"
                        className={voiceMode === "assistant" ? "active" : ""}
                        onClick={() => setVoiceMode("assistant")}
                        disabled={voiceConnected}
                      >
                        <MessageSquare size={14} /> Agent
                      </button>
                      <button
                        type="button"
                        className={voiceMode === "flow" ? "active" : ""}
                        onClick={() => setVoiceMode("flow")}
                        disabled={voiceConnected}
                      >
                        <Workflow size={14} /> Flow
                      </button>
                    </div>
                    <div className="voiceConsoleSegmented" aria-label="Speech provider path">
                      <button
                        type="button"
                        className="active"
                        onClick={() => setSpeechPath("supertone_parakeet")}
                        disabled={voiceConnected || voiceBusy}
                      >
                        <Cpu size={14} /> Supertonic
                      </button>
                    </div>
                    <div className="voiceConsoleSegmented" aria-label="Input mode">
                      <button
                        type="button"
                        className={voiceInputMode === "vad" ? "active" : ""}
                        onClick={() => setVoiceInputMode("vad")}
                        disabled={voiceConnected || voiceBusy}
                      >
                        <Mic size={14} /> VAD
                      </button>
                      <button
                        type="button"
                        className={voiceInputMode === "push_to_talk" ? "active" : ""}
                        onClick={() => setVoiceInputMode("push_to_talk")}
                        disabled={voiceConnected || voiceBusy}
                      >
                        <Keyboard size={14} /> Push
                      </button>
                    </div>
                  </div>

                  <form className="voiceConsoleComposer" onSubmit={executeVoiceTextTurn}>
                    <input
                      value={voiceTextMessage}
                      onChange={(event) => setVoiceTextMessage(event.target.value)}
                      placeholder="Send a task or reply"
                      disabled={voiceTextBusy}
                    />
                    <button type="submit" disabled={voiceTextBusy || !voiceTextMessage.trim()}>
                      <Send size={17} /> Send
                    </button>
                    <button
                      type="button"
                      onClick={playVoiceTextTts}
                      disabled={voiceTextAudioBusy || !voiceTextResult?.message.trim()}
                    >
                      <Volume2 size={17} /> Play
                    </button>
                  </form>
                  <audio ref={voiceTextAudioRef} controls className="voiceConsoleAudio" />
                  {voiceNotice && <p className="errorText voiceConsoleNotice">{voiceNotice}</p>}
                </div>

                {codexFlowVisible && (
                  <section className="codexSyncPanel">
                    <div className="voicePanelHeader">
                      <div>
                        <h2>Codexa Flow</h2>
                        <p>
                          {codexSyncedFlowchart?.nodes.length
                            ? `${codexCurrentStatus} · ${codexSyncedFlowchart.nodes.length} synced nodes`
                            : codexCurrentStatus}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="voiceConsoleIconButton"
                        onClick={() => refreshCodexStatus()}
                        disabled={codexStatusBusy}
                        aria-label="Refresh Codexa status"
                        title="Refresh Codexa status"
                      >
                        <RefreshCcw size={16} />
                      </button>
                    </div>
                    <div className="codexFlowChart">
                      {codexFlowSteps.map((step, index) => (
                        <div className={`codexFlowStep ${step.state}`} key={step.id}>
                          <span className="codexFlowDot" />
                          <strong>{step.label}</strong>
                          <small>{step.detail}</small>
                          {index < codexFlowSteps.length - 1 && <i className="codexFlowConnector" />}
                        </div>
                      ))}
                    </div>
                    <p className="codexSyncMessage">
                      {codexStatus?.message ?? voiceTextResult?.message ?? "Codexa session attached."}
                    </p>
                  </section>
                )}

                <section className="twilioCallLogPanel">
                  <div className="voicePanelHeader">
                    <div>
                      <h2>Twilio Calls</h2>
                      <p>
                        {twilioCallLogs.length > 0
                          ? `${twilioCallLogs.length} recent calls · live polling`
                          : "Waiting for phone traffic"}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="voiceConsoleIconButton"
                      onClick={() => refreshTwilioLogs()}
                      disabled={twilioLogsBusy}
                      aria-label="Refresh Twilio calls"
                      title="Refresh Twilio calls"
                    >
                      <RefreshCcw size={16} />
                    </button>
                  </div>
                  <div className="twilioCallList">
                    {twilioCallLogs.length === 0 ? (
                      <div className="emptyState compact">
                        <PhoneCall size={20} />
                        <p>Call the Twilio number to see live speech turns here.</p>
                      </div>
                    ) : (
                      twilioCallLogs.map((call) => (
                        <article
                          className={`twilioCallCard ${conversationId === call.conversation_id ? "active" : ""}`}
                          key={call.conversation_id}
                        >
                          <div className="twilioCallCardTop">
                            <div>
                              <strong>{call.caller ?? "Unknown caller"}</strong>
                              <span>{formatCallTime(call.updated_at)}</span>
                            </div>
                            <Badge color={call.status === "completed" ? "secondary" : "active"}>
                              {call.status}
                            </Badge>
                          </div>
                          <div className="twilioCallMeta">
                            <span>{truncateValue(call.call_sid ?? call.conversation_id, 30)}</span>
                            <span>{formatCallDuration(call.duration_seconds)}</span>
                            <span>{call.turns.length} events</span>
                          </div>
                          <div className="twilioCallTurns">
                            {call.turns.filter((turn) => turn.role !== "system").slice(-4).map((turn) => (
                              <p key={turn.id}>
                                <span>{turn.role}</span>
                                {turn.content}
                              </p>
                            ))}
                            {!call.turns.some((turn) => turn.role !== "system") && (
                              <p>
                                <span>system</span>
                                Call connected.
                              </p>
                            )}
                          </div>
                          <button type="button" onClick={() => watchTwilioCall(call)}>
                            Watch in Codexa
                          </button>
                        </article>
                      ))
                    )}
                  </div>
                </section>

                <section className="voiceConversationStrip">
                  <div className="voicePanelHeader">
                    <div>
                      <h2>Conversation</h2>
                      <p>{conversationId ? truncateValue(conversationId, 34) : "No active session"}</p>
                    </div>
                    <div className="voicePhaseGrid compact" aria-label="Voice state">
                      {voicePhases.map((phase) => (
                        <span key={phase} className={`voicePhase ${voicePhase === phase ? "active" : ""}`}>
                          {phase}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="voiceConversationTurns">
                    {recentHistoryTurns.length === 0 ? (
                      <div className="emptyState compact">
                        <Activity size={20} />
                        <p>Ready.</p>
                      </div>
                    ) : (
                      recentHistoryTurns.map((turn) => (
                        <article className={`turn ${turn.role}`} key={turn.id}>
                          <span>{turn.role}</span>
                          <p>{turn.content}</p>
                          {turn.latency_ms !== undefined && (
                            <small>{turn.latency_ms} ms · prompt v{turn.prompt_version}</small>
                          )}
                        </article>
                      ))
                    )}
                  </div>
                </section>
              </section>

              {voiceConsoleSidebarOpen ? (
                <aside className="voiceConsoleInspector">
                  <div className="voiceInspectorHead">
                    <div>
                      <h2>State</h2>
                      <p>{codexSessionId ? truncateValue(codexSessionId, 32) : "runtime variables"}</p>
                    </div>
                    <button
                      type="button"
                      className="voiceConsoleIconButton"
                      onClick={() => setVoiceConsoleSidebarOpen(false)}
                      aria-label="Collapse state"
                      title="Collapse state"
                    >
                      <PanelLeftClose size={16} />
                    </button>
                  </div>

                  {voiceConsoleSettingsOpen && (
                    <section className="voiceSettingsPanel">
                      <div className="rawGroupHead">
                        <strong>Settings</strong>
                        <span>{recentHistoryTurns.length} recent turns</span>
                      </div>
                      <div className="settingsRows">
                        <label>
                          <span>Theme</span>
                          <button
                            type="button"
                            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
                          >
                            {theme}
                          </button>
                        </label>
                        <label>
                          <span>Mode</span>
                          <strong>{voiceMode}</strong>
                        </label>
                        <label>
                          <span>Speech</span>
                          <strong>{speechPath}</strong>
                        </label>
                        <label>
                          <span>History</span>
                          <strong>{conversationId ? truncateValue(conversationId, 24) : "-"}</strong>
                        </label>
                      </div>
                      <div className="settingsHistory">
                        {recentHistoryTurns.map((turn) => (
                          <span key={`settings-${turn.id}`}>
                            <strong>{turn.role}</strong>
                            {truncateValue(turn.content, 72)}
                          </span>
                        ))}
                      </div>
                    </section>
                  )}

                  <div className="rawVariableList">
                    {rawVariableGroups.map((group) => (
                      <section className="rawVariableGroup" key={group.title}>
                        <div className="rawGroupHead">
                          <strong>{group.title}</strong>
                          <span>{group.rows.length}</span>
                        </div>
                        {group.rows.map((row) => (
                          <div className="rawVariableRow" key={`${group.title}-${row.label}`}>
                            <span>{row.label}</span>
                            <strong>{truncateValue(row.value, 88)}</strong>
                          </div>
                        ))}
                      </section>
                    ))}
                  </div>
                </aside>
              ) : (
                <button
                  type="button"
                  className="voiceInspectorHandle"
                  onClick={() => setVoiceConsoleSidebarOpen(true)}
                  aria-label="Show variables"
                  title="Show variables"
                >
                  <PanelLeftOpen size={18} />
                </button>
              )}
            </div>

            {variableBadges.length > 0 && (
              <div className="variableBadgeStack" aria-live="polite">
                {variableBadges.map((badge) => (
                  <span className="variableChangeBadge" key={badge.id}>
                    <strong>{badge.label}</strong>
                    {truncateValue(badge.value, 38)}
                  </span>
                ))}
              </div>
            )}
          </section>
        ) : activeView === "builder" ? (
          <AppBuilderPage onNotice={setNotice} />
        ) : activeView === "flow" ? (
          <FlowStudio
            speechPath={speechPath}
            onSpeechPathChange={setSpeechPath}
            onNotice={setNotice}
            onConversationIdChange={setFlowConversationId}
          />
        ) : activeView === "selfLearn" ? (
          <SelfLearn liveConversationId={conversationId ?? null} flowConversationId={flowConversationId} />
        ) : (
          <>
        <header className="topbar">
          <div>
            <p className="eyebrow">Live Ops</p>
            <h1>Live Ops</h1>
          </div>
          <div className="liveHeaderActions">
            <Badge color={voiceConnected ? "active" : "inactive"}>{voiceConnected ? "voice connected" : "voice offline"}</Badge>
            <Badge color="secondary">{prompt ? `prompt v${prompt.version}` : "prompt loading"}</Badge>
            <button className="iconButton" onClick={() => refresh()} aria-label="Refresh">
              <RefreshCcw size={18} />
            </button>
          </div>
        </header>

        <section className="statusGrid">
          <Metric icon={<Brain />} label="Model" value={health?.model ?? "loading"} detail={health?.llm_provider ?? ""} />
          <Metric icon={<PhoneCall />} label="Voice" value={health?.voice_runtime ?? "loading"} detail="Pipecat local/Twilio path" />
          <Metric icon={<Gauge />} label="Latency" value={`${latency} ms`} detail="latest assistant turn" />
          <Metric icon={<CheckCircle2 />} label="Prompt" value={`v${prompt?.version ?? "-"}`} detail={health?.reasoning_mode ?? ""} />
          <Metric
            icon={<Clock3 />}
            label="Auto eval"
            value={scheduler?.running ? "running" : "manual"}
            detail={scheduler?.running ? `every ${scheduler.interval_seconds}s` : "scheduler idle"}
          />
          <Metric
            icon={<ShieldCheck />}
            label="Local cap"
            value={`$${(cost?.remaining_usd ?? 0).toFixed(2)} left`}
            detail={`of $${(cost?.cap_usd ?? 0).toFixed(2)}`}
          />
        </section>

        <section className="mainGrid">
          <div className="conversationPanel">
            <div className="sectionHead">
              <div>
                <h2>Conversation</h2>
                <p>{conversationId ? conversationId.slice(0, 8) : "No active session"}</p>
              </div>
              <div className="feedbackActions">
                <button disabled={!lastAssistant} onClick={() => rate(5, "accurate")}><ThumbsUp size={16} /> Good</button>
                <button disabled={!lastAssistant} onClick={() => rate(2, "incorrect")}><ThumbsDown size={16} /> Fix</button>
              </div>
            </div>

            <div className="transcript">
              {turns.length === 0 ? (
                <div className="emptyState">
                  <Activity size={22} />
                  <p>Start a text turn here, or run the local Pipecat voice agent to stream microphone audio into the same feedback loop.</p>
                </div>
              ) : (
                turns.map((turn) => (
                  <article className={`turn ${turn.role}`} key={turn.id}>
                    <span>{turn.role}</span>
                    <p>{turn.content}</p>
                    {turn.latency_ms !== undefined && <small>{turn.latency_ms} ms · prompt v{turn.prompt_version}</small>}
                  </article>
                ))
              )}
            </div>

            <div className="promptChips">
              {prompts.map((sample) => (
                <button key={sample} onClick={() => submit(undefined, sample)}>{sample}</button>
              ))}
            </div>

            <form className="composer" onSubmit={submit}>
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Type a test utterance"
                disabled={busy}
              />
              <button disabled={busy || !message.trim()}><Send size={18} /> Send</button>
            </form>
          </div>

          <div className="sideStack">
            <section className="panel pipecatKitPanel">
              <div className="sectionHead">
                <div>
                  <h2>Browser Voice</h2>
                  <p>{voiceStatus}</p>
                </div>
                <Badge color={voiceConnected ? "active" : "inactive"} variant="outline" rounded="sm">
                  {voiceConnected ? "connected" : "offline"}
                </Badge>
              </div>

              <div className="voiceModeSwitch" aria-label="Voice mode">
                <button
                  className={voiceMode === "assistant" ? "active" : ""}
                  onClick={() => setVoiceMode("assistant")}
                  disabled={voiceConnected}
                >
                  <MessageSquare size={15} /> Agent
                </button>
                <button
                  className={voiceMode === "flow" ? "active" : ""}
                  onClick={() => setVoiceMode("flow")}
                  disabled={voiceConnected}
                >
                  <Workflow size={15} /> Flow
                </button>
              </div>

              <div className="speechPathSwitch" aria-label="Speech provider path">
                <button
                  className="active"
                  onClick={() => setSpeechPath("supertone_parakeet")}
                  disabled={voiceConnected || voiceBusy}
                >
                  <Cpu size={15} /> Supertonic
                </button>
              </div>

              <div className="inputModeSwitch" aria-label="Voice input mode">
                <button
                  className={voiceInputMode === "vad" ? "active" : ""}
                  onClick={() => setVoiceInputMode("vad")}
                  disabled={voiceConnected || voiceBusy}
                >
                  <Mic size={15} /> Voice Activity Detection
                </button>
                <button
                  className={voiceInputMode === "push_to_talk" ? "active" : ""}
                  onClick={() => setVoiceInputMode("push_to_talk")}
                  disabled={voiceConnected || voiceBusy}
                >
                  <Keyboard size={15} /> Push to Talk
                </button>
              </div>

              <div className="kitStage">
                <CircularWaveform
                  audioTrack={localAudioTrack}
                  backgroundColor={emotionBackground(assistantEmotion)}
                  barWidth={4}
                  color1={emotionColors(assistantEmotion)[0]}
                  color2={emotionColors(assistantEmotion)[1]}
                  isThinking={voiceBusy || botSpeaking}
                  numBars={42}
                  rotationEnabled={voiceConnected}
                  sensitivity={1.2}
                  size={148}
                />
                <div className="kitBadges">
                  <Badge color="client" variant="outline" rounded="sm">{sttBadge}</Badge>
                  <Badge color="agent" variant="outline" rounded="sm">{ttsBadge}</Badge>
                  <Badge color={codexDependencyBadgeColor} variant="outline" rounded="sm">{codexDependencyLabel}</Badge>
                  <Badge color="secondary" variant="outline" rounded="sm">SmallWebRTC</Badge>
                  <Badge color="secondary" variant="outline" rounded="sm">{assistantEmotion}</Badge>
                </div>
              </div>

              <div className="voicePhaseGrid" aria-label="Voice state">
                {voicePhases.map((phase) => (
                  <span key={phase} className={`voicePhase ${voicePhase === phase ? "active" : ""}`}>
                    {phase}
                  </span>
                ))}
              </div>

              <div className="kitControlBar">
                <button onClick={toggleVoiceConnection} disabled={voiceBusy}>
                  {voiceConnected ? "Disconnect" : voiceBusy ? "Connecting" : "Connect"}
                </button>
                <button
                  onClick={toggleVoiceMic}
                  disabled={!voiceConnected || voiceInputMode === "push_to_talk"}
                >
                  {voiceInputMode === "push_to_talk" ? "Hold Space" : micEnabled ? "Mute" : "Unmute"}
                </button>
              </div>
              {voiceNotice && <p className="errorText">{voiceNotice}</p>}

              <div className="voiceDebugPanel">
                <div className="debugPanelHead">
                  <strong>Voice runtime</strong>
                  <span>{runtimeProfile?.input_mode === "push_to_talk" ? "Push to Talk" : "VAD"}</span>
                </div>
                <div className="debugGrid">
                  <small>Model profile</small>
                  <span>{runtimeProfile?.active_model_profile ?? "-"}</span>
                  <small>LLM model</small>
                  <span>{String(runtimeLlm.current_model ?? runtimeLlm.balanced_model ?? "-")}</span>
                  <small>LLM TTFB</small>
                  <span>{formatMaybeMs(runtimeLatency.last_llm_ttfb_ms)}</span>
                  <small>TTS TTFB</small>
                  <span>{formatMaybeMs(runtimeLatency.last_tts_ttfb_ms)}</span>
                  <small>First audio</small>
                  <span>{formatMaybeMs(runtimeLatency.last_first_audio_ms)}</span>
                  <small>Rolling first audio</small>
                  <span>{formatMaybeMs(runtimeLatency.rolling_avg_first_audio_ms)}</span>
                  <small>TTS provider</small>
                  <span>{String(runtimeTts.provider ?? "supertonic")}</span>
                  <small>Active provider</small>
                  <span>{String(runtimeTts.provider ?? "supertonic")}</span>
                  <small>Voice</small>
                  <span>{String(runtimeTts.voice ?? "-")}</span>
                  <small>Current speed</small>
                  <span>{formatMaybeNumber(runtimeTts.speed)}</span>
                  <small>Steps</small>
                  <span>{formatMaybeNumber(runtimeTts.steps)}</span>
                  <small>Max chunk</small>
                  <span>{formatMaybeNumber(runtimeTts.max_chunk_length)}</span>
                  <small>Expression mode</small>
                  <span>{String(runtimeTts.expression_mode ?? "-")}</span>
                  <small>Allowed tags</small>
                  <span>{allowedExpressionTags}</span>
                  <small>Last tags used</small>
                  <span>{usedExpressionTags}</span>
                  <small>Duplicate stops</small>
                  <span>{formatMaybeNumber(runtimeTurnTaking.duplicate_interruptions_prevented)}</span>
                  <small>Failures</small>
                  <span>{lastFailureTypes}</span>
                  <small>Profile change</small>
                  <span>{lastProfileChange}</span>
                  <small>Runtime actions</small>
                  <span>{lastRuntimeActions}</span>
                  <small>Action status</small>
                  <span>{lastRuntimeActionStatus}</span>
                  <small>Parse errors</small>
                  <span>{parseErrors}</span>
                  <small>Supertonic payload</small>
                  <span>{lastSupertonicPayload}</span>
                </div>
                <div className="debugTextPair">
                  <div>
                    <small>Clean</small>
                    <p>{String(lastLearningRecord.assistant_response_clean ?? "-")}</p>
                  </div>
                  <div>
                    <small>Rendered</small>
                    <p>{lastRenderedDebugText}</p>
                  </div>
                  <div>
                    <small>Structured output</small>
                    <p>{lastStructuredOutput}</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="panel voiceTextTestPanel">
              <div className="sectionHead">
                <div>
                  <h2>Text Voice Test</h2>
                  <p>{voiceTextResult ? `${voiceTextResult.mode} · ${voiceTextResult.provider}` : "STT assumed"}</p>
                </div>
                <Badge color={voiceTextSuite?.passed ? "active" : "secondary"}>
                  {voiceTextSuite ? voiceTextSuite.status : "ready"}
                </Badge>
              </div>
              <form className="voiceTextControls" onSubmit={executeVoiceTextTurn}>
                <input
                  value={voiceTextMessage}
                  onChange={(event) => setVoiceTextMessage(event.target.value)}
                  placeholder="Final transcript"
                  disabled={voiceTextBusy}
                />
                <button disabled={voiceTextBusy || !voiceTextMessage.trim()}>
                  <Keyboard size={16} /> Turn
                </button>
                <button type="button" onClick={executeVoiceTextSuite} disabled={voiceTextBusy}>
                  <Play size={16} /> Suite
                </button>
              </form>

              {voiceTextResult && (
                <div className="voiceTextResult">
                  <small>
                    {voiceTextResult.tts.provider} · {voiceTextResult.latency_ms} ms · {voiceTextResult.learning_failures.join(", ")}
                  </small>
                  {Boolean(voiceTextResult.codex?.codex_session_id) && (
                    <small>
                      Codex {String(voiceTextResult.codex?.codex_session_id)}
                      {voiceTextResult.codex?.requires_approval === true ? " · approval pending" : ""}
                    </small>
                  )}
                  <p>{voiceTextResult.message}</p>
                  <span>{voiceTextResult.tts.rendered_text}</span>
                  <div className="voiceTextAudioControls">
                    <button type="button" onClick={playVoiceTextTts} disabled={voiceTextAudioBusy}>
                      <Volume2 size={16} /> {voiceTextAudioBusy ? "Synthesizing" : "Play TTS"}
                    </button>
                    <audio ref={voiceTextAudioRef} controls className="voiceTextAudio" />
                  </div>
                </div>
              )}

              {voiceTextSuite && (
                <div className="voiceTextSuiteList">
                  {voiceTextSuite.cases.map((testCase) => (
                    <div className="voiceTextCase" key={testCase.id}>
                      <span className={testCase.passed ? "passed" : "failed"}>
                        {testCase.passed ? "passed" : "failed"}
                      </span>
                      <strong>{testCase.id}</strong>
                      <small>{testCase.checks.filter((check) => !check.passed).map((check) => check.name).join(", ") || testCase.turn.message}</small>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="panel">
              <div className="sectionHead">
                <div>
                  <h2>Evaluation</h2>
                  <p>Regression suite</p>
                </div>
                <div className="buttonRow">
                  <button onClick={executeEval} disabled={evalBusy}><Play size={16} /> Run</button>
                  <button onClick={toggleScheduler} disabled={evalBusy}>
                    {scheduler?.running ? <Square size={16} /> : <Clock3 size={16} />}
                    {scheduler?.running ? "Stop" : "Auto"}
                  </button>
                </div>
              </div>
              {scheduler?.last_error && <p className="errorText">{scheduler.last_error}</p>}
              {scheduler?.next_run_at && <p className="muted padX">Next run {new Date(scheduler.next_run_at).toLocaleTimeString()}</p>}
              <div className="evalList">
                {evalRuns.slice(0, 5).map((run) => (
                  <div className="evalRow" key={run.id}>
                    <span className={run.status}>{run.status}</span>
                    <strong>{Math.round(run.aggregate_score * 100)}%</strong>
                    <small>{run.suite}</small>
                  </div>
                ))}
                {evalRuns.length === 0 && <p className="muted">No runs yet.</p>}
              </div>
            </section>

            <section className="panel grow">
              <div className="sectionHead">
                <div>
                  <h2>Auto-Improvement</h2>
                  <p>Eval data feeding prompt v{autoImprovement?.active_prompt_version ?? prompt?.version ?? "-"}</p>
                </div>
              </div>
              <pre>{prompt?.learned_hints || "No feedback has been applied yet."}</pre>
              <div className="improvementList">
                {(autoImprovement?.proposed_hints ?? []).map((hint) => (
                  <span key={hint}>{hint.replace(/^-\s*/, "")}</span>
                ))}
              </div>
            </section>
          </div>
        </section>
          </>
        )}
        {notice && <div className="toast">{notice}</div>}
      </section>
    </main>
  );
}

function Metric({ icon, label, value, detail }: { icon: JSX.Element; label: string; value: string; detail: string }) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </div>
    </div>
  );
}

function voiceProviderLabel(provider: string | undefined, kind: "STT" | "TTS") {
  if (!provider) return kind;
  const labels: Record<string, string> = {
    google: `Google ${kind}`,
    nvidia: `NVIDIA ${kind}`,
    parakeet: "Parakeet STT",
    openrouter: "OpenRouter STT",
    deepgram: `Deepgram ${kind}`,
    cartesia: "Cartesia TTS",
    whisper: "Whisper STT",
    remote_whisper: "Remote Whisper STT",
    whisperx: "WhisperX STT",
    mlx_whisper: "MLX Whisper STT",
    kokoro: "Kokoro TTS",
    fish_speech: "Fish Speech TTS",
    supertonic: "Supertonic TTS",
    auto: `Auto ${kind}`
  };
  return labels[provider] ?? `${provider} ${kind}`;
}

function inferEmotion(text: string) {
  const normalized = text.toLowerCase();
  if (normalized.includes("fast") || normalized.includes("faster")) return "energetic";
  if (normalized.includes("sorry") || normalized.includes("make sure")) return "sympathetic";
  if (normalized.includes("confirm") || normalized.includes("correct") || normalized.includes("careful")) {
    return "careful";
  }
  if (normalized.includes("done") || normalized.includes("finished") || normalized.includes("saved")) {
    return "confident";
  }
  if (normalized.includes("here") || normalized.includes("help")) return "friendly";
  return "neutral";
}

function emotionColors(emotion: string): [string, string] {
  const colors: Record<string, [string, string]> = {
    energetic: ["#facc15", "#67e8f9"],
    sympathetic: ["#fda4af", "#93c5fd"],
    careful: ["#93c5fd", "#d8fb6f"],
    confident: ["#d8fb6f", "#34d399"],
    friendly: ["#d8fb6f", "#67e8f9"],
    neutral: ["#d8fb6f", "#67e8f9"]
  };
  return colors[emotion] ?? colors.neutral;
}

function emotionBackground(emotion: string) {
  const backgrounds: Record<string, string> = {
    energetic: "#131107",
    sympathetic: "#120d14",
    careful: "#0a1017",
    confident: "#0b130f",
    friendly: "#0a0e12",
    neutral: "#0a0e12"
  };
  return backgrounds[emotion] ?? backgrounds.neutral;
}
