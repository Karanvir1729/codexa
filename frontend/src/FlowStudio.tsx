import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent
} from "react";
import BookOpen from "lucide-react/dist/esm/icons/book-open.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import Code2 from "lucide-react/dist/esm/icons/code-2.js";
import Cpu from "lucide-react/dist/esm/icons/cpu.js";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.js";
import Keyboard from "lucide-react/dist/esm/icons/keyboard.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import Maximize2 from "lucide-react/dist/esm/icons/maximize-2.js";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.js";
import Mic from "lucide-react/dist/esm/icons/mic.js";
import Minus from "lucide-react/dist/esm/icons/minus.js";
import PanelRight from "lucide-react/dist/esm/icons/panel-right.js";
import PhoneForwarded from "lucide-react/dist/esm/icons/phone-forwarded.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Radio from "lucide-react/dist/esm/icons/radio.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import SquareFunction from "lucide-react/dist/esm/icons/square-function.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { PipecatClient, type RTVIMessage, type TransportState } from "@pipecat-ai/client-js";
import {
  SmallWebRTCTransport,
  type SmallWebRTCTransportConstructorOptions
} from "@pipecat-ai/small-webrtc-transport";
import {
  apiUrl,
  FlowDefinition,
  FlowGraph,
  FlowSimulationResponse,
  FlowValidation,
  getActiveFlow,
  getFlowRunByConversation,
  getVoicePreflight,
  getWebRTCIceConfig,
  publishFlow,
  prepareVoice,
  saveFlow,
  simulateFlow,
  validateFlow,
  type VoiceInputMode,
  type VoiceSpeechPath
} from "./api";
import {
  BrowserAudioMediaManager,
  audioPlayErrorMessage,
  clearAudioElement,
  playAudioTrack
} from "./browserAudioMediaManager";

type NodeField = {
  name: string;
  type?: string;
  required?: boolean;
};

type VoiceNodeData = {
  label: string;
  nodeType: string;
  category?: string;
  purpose?: string;
  prompt?: string;
  script?: string;
  outputs?: string[];
  fields?: NodeField[];
  endpoint?: string | null;
  integration?: Record<string, unknown>;
  voice?: {
    voiceId?: string;
    tone?: string;
    speed?: number;
    language?: string;
    allowBargeIn?: boolean;
  };
  latency?: {
    profile?: string;
    targetMs?: number;
  };
  interrupt?: {
    enabled?: boolean;
    stopSpeaking?: boolean;
    routes?: Array<Record<string, unknown>>;
  };
  fallback?: Record<string, unknown>;
  autoAdvance?: boolean;
  [key: string]: unknown;
};

type VoiceNode = {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: VoiceNodeData;
  className?: string;
};

type VoiceEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  animated?: boolean;
  data?: Record<string, unknown>;
};

type FlowStudioProps = {
  speechPath: VoiceSpeechPath;
  onSpeechPathChange?: (speechPath: VoiceSpeechPath) => void;
  onNotice?: (message: string) => void;
  onConversationIdChange?: (conversationId: string | null) => void;
};

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

type FlowVoiceTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const flowVoiceConnectTimeoutMs = 60000;
const fallbackIceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const flowVoiceInputModeStorageKey = "voiceops-flow-input-mode";

function initialFlowVoiceInputMode(): VoiceInputMode {
  if (typeof window === "undefined") return "vad";
  return window.localStorage.getItem(flowVoiceInputModeStorageKey) === "push_to_talk"
    ? "push_to_talk"
    : "vad";
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function pipecatErrorText(message: RTVIMessage) {
  const data = message.data;
  if (!data || typeof data !== "object" || !("message" in data)) return null;
  const errorMessage = (data as PipecatErrorMessage["data"])?.message;
  return typeof errorMessage === "string" ? errorMessage : null;
}

type PaletteItem = {
  type: string;
  label: string;
  group: "Pre-Call" | "In-Call" | "Collect" | "Actions" | "Post-Call";
  description: string;
  icon: typeof MessageSquare;
  category: string;
  outputs: string[];
};

const WORLD = { width: 3300, height: 1350, originX: 940, originY: 420 };

const palette: PaletteItem[] = [
  {
    type: "start",
    label: "Start",
    group: "Pre-Call",
    description: "Entry into the behavior graph after the realtime voice session is active.",
    icon: Radio,
    category: "pre-call",
    outputs: ["Begin"]
  },
  {
    type: "api",
    label: "Pre-Call API",
    group: "Pre-Call",
    description: "Fetch context before the agent starts the scripted behavior.",
    icon: Code2,
    category: "pre-call",
    outputs: ["Loaded", "Failed"]
  },
  {
    type: "dialogue",
    label: "Dialogue",
    group: "In-Call",
    description: "Speak a planned line, explanation, or follow-up.",
    icon: MessageSquare,
    category: "in-call",
    outputs: ["Continue"]
  },
  {
    type: "knowledge_base",
    label: "Knowledge Base",
    group: "In-Call",
    description: "Ground a response in a repository, docs, or runbook source.",
    icon: BookOpen,
    category: "in-call",
    outputs: ["Answer found", "No answer"]
  },
  {
    type: "collect",
    label: "Collect",
    group: "Collect",
    description: "Collect structured fields from the caller.",
    icon: MessageSquare,
    category: "in-call",
    outputs: ["Task details collected", "Needs clarification"]
  },
  {
    type: "confirm",
    label: "Confirm",
    group: "Collect",
    description: "Restate understanding and branch on confirmation or correction.",
    icon: CheckCircle2,
    category: "in-call",
    outputs: ["Confirmed", "Corrected"]
  },
  {
    type: "condition",
    label: "Condition",
    group: "Collect",
    description: "Branch based on slots, confidence, safety, or caller intent.",
    icon: GitBranch,
    category: "logic",
    outputs: ["True", "False"]
  },
  {
    type: "codex_task",
    label: "Agent Task",
    group: "Actions",
    description: "Create and monitor an agent task.",
    icon: SquareFunction,
    category: "action",
    outputs: ["Task processed successfully", "Processing failed", "Needs more info"]
  },
  {
    type: "sms",
    label: "SMS",
    group: "Actions",
    description: "Send a live-call SMS update.",
    icon: MessageSquare,
    category: "action",
    outputs: ["Sent", "Failed"]
  },
  {
    type: "email",
    label: "Email",
    group: "Actions",
    description: "Send a transcript, summary, or follow-up.",
    icon: Mail,
    category: "action",
    outputs: ["Sent", "Failed"]
  },
  {
    type: "transfer_call",
    label: "Summarize Context",
    group: "Actions",
    description: "Summarize transcript, slots, and current state.",
    icon: PhoneForwarded,
    category: "action",
    outputs: ["Summarized"]
  },
  {
    type: "wait",
    label: "Wait / Monitor",
    group: "Actions",
    description: "Hold at a running process and speak progress updates.",
    icon: Radio,
    category: "action",
    outputs: ["Complete", "Needs user input", "Failed"]
  },
  {
    type: "fallback",
    label: "Fallback",
    group: "Post-Call",
    description: "Repair unclear input, tool failures, and bad states.",
    icon: TriangleAlert,
    category: "repair",
    outputs: ["Retry", "Summarize"]
  },
  {
    type: "end",
    label: "End",
    group: "Post-Call",
    description: "Close the behavior run and persist run history.",
    icon: CheckCircle2,
    category: "post-call",
    outputs: ["Complete"]
  }
];

const paletteGroups: PaletteItem["group"][] = ["Pre-Call", "In-Call", "Collect", "Actions", "Post-Call"];
const latencyProfiles = ["instant", "fast", "balanced", "quality", "async"];
const tones = [
  "neutral",
  "calm",
  "confident",
  "friendly",
  "careful",
  "sympathetic",
  "energetic",
  "spooky",
  "arrogant",
  "condescending",
  "whisper"
];

function appendFlowVoiceTurn(current: FlowVoiceTurn[], next: FlowVoiceTurn) {
  const last = current[current.length - 1];
  if (last?.role === next.role && last.text.trim() === next.text.trim()) {
    return current;
  }
  return [...current, next].slice(-10);
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

async function requestMicrophoneStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not expose microphone capture.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 }
    },
    video: false
  });
}

export function FlowStudio({
  speechPath,
  onSpeechPathChange,
  onNotice,
  onConversationIdChange
}: FlowStudioProps) {
  return (
    <FlowStudioInner
      speechPath={speechPath}
      onSpeechPathChange={onSpeechPathChange}
      onNotice={onNotice}
      onConversationIdChange={onConversationIdChange}
    />
  );
}

function FlowStudioInner({
  speechPath,
  onSpeechPathChange,
  onNotice,
  onConversationIdChange
}: FlowStudioProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef({ zoom: 0.82, pan: { x: 150, y: 100 } });
  const [flow, setFlow] = useState<FlowDefinition | null>(null);
  const [nodes, setNodes] = useState<VoiceNode[]>([]);
  const [edges, setEdges] = useState<VoiceEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [validation, setValidation] = useState<FlowValidation | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<FlowSimulationResponse | null>(null);
  const [simInput, setSimInput] = useState("");
  const [forceInterrupt, setForceInterrupt] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [zoom, setZoom] = useState(0.82);
  const [pan, setPan] = useState({ x: 150, y: 100 });
  const [flowVoiceClient, setFlowVoiceClient] = useState<PipecatClient | null>(null);
  const [flowVoiceState, setFlowVoiceState] = useState<TransportState>("disconnected");
  const [flowVoiceNotice, setFlowVoiceNotice] = useState<string | null>(null);
  const [flowVoiceConversationId, setFlowVoiceConversationId] = useState<string | null>(null);
  const [flowRunnerConversationId, setFlowRunnerConversationId] = useState<string | null>(null);
  const [flowVoiceTurns, setFlowVoiceTurns] = useState<FlowVoiceTurn[]>([]);
  const [flowVoiceMicEnabled, setFlowVoiceMicEnabled] = useState(false);
  const [flowVoiceUserSpeaking, setFlowVoiceUserSpeaking] = useState(false);
  const [flowVoiceBotSpeaking, setFlowVoiceBotSpeaking] = useState(false);
  const [flowVoiceInputMode, setFlowVoiceInputMode] = useState<VoiceInputMode>(
    initialFlowVoiceInputMode
  );
  const [flowBotAudioTrack, setFlowBotAudioTrack] = useState<MediaStreamTrack | null>(null);
  const flowBotAudioRef = useRef<HTMLAudioElement | null>(null);
  const flowVoiceMediaManagerRef = useRef<BrowserAudioMediaManager | null>(null);
  const flowVoiceConnectInFlightRef = useRef(false);
  const flowPushToTalkPressedRef = useRef(false);
  const [dragState, setDragState] = useState<{
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [panState, setPanState] = useState<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  const outgoingBySource = useMemo(() => {
    const map = new Map<string, VoiceEdge[]>();
    for (const edge of edges) {
      map.set(edge.source, [...(map.get(edge.source) ?? []), edge]);
    }
    return map;
  }, [edges]);

  const graph = useMemo<FlowGraph>(
    () => ({
      nodes: nodes.map((node) => ({
        ...node,
        selected: undefined,
        dragging: undefined
      })) as unknown as Array<Record<string, unknown>>,
      edges: edges as unknown as Array<Record<string, unknown>>,
      viewport: { x: pan.x, y: pan.y, zoom },
      metadata: {
        schemaVersion: 4,
        alwaysListening: true,
        runtime: "flow-bound-conversational-voice-agent"
      }
    }),
    [edges, nodes, pan.x, pan.y, zoom]
  );

  useEffect(() => {
    getActiveFlow()
      .then(({ flow: active }) => {
        setFlow(active);
        setNodes(toNodes(active.graph));
        setEdges(toEdges(active.graph));
        setValidation(active.validation);
        const viewport = active.graph.viewport ?? {};
        setPan({
          x: readNumber(viewport.x, 150),
          y: readNumber(viewport.y, 100)
        });
        setZoom(readNumber(viewport.zoom, 0.82));
      })
      .catch((error) => onNotice?.(error instanceof Error ? error.message : "Failed to load flow"));
  }, [onNotice]);

  useEffect(() => {
    if (!window.RTCPeerConnection) {
      setFlowVoiceNotice("Browser voice needs WebRTC support.");
      return;
    }

    let client: PipecatClient;
    try {
      const mediaManager = new BrowserAudioMediaManager();
      flowVoiceMediaManagerRef.current = mediaManager;
      client = new PipecatClient({
        transport: new SmallWebRTCTransport({
          iceServers: fallbackIceServers,
          mediaManager: mediaManager as unknown as SmallWebRTCTransportConstructorOptions["mediaManager"],
          waitForICEGathering: false
        }),
        enableMic: false,
        enableCam: false,
        callbacks: {
          onConnected: () => setFlowVoiceNotice(null),
          onDisconnected: () => {
            setFlowVoiceMicEnabled(false);
            setFlowVoiceUserSpeaking(false);
            setFlowVoiceBotSpeaking(false);
            flowPushToTalkPressedRef.current = false;
            setFlowBotAudioTrack(null);
          },
          onTransportStateChanged: (state: TransportState) => setFlowVoiceState(state),
          onError: (message: RTVIMessage) => {
            const errorMessage = pipecatErrorText(message);
            if (errorMessage) setFlowVoiceNotice(errorMessage);
          },
          onDeviceError: (error: PipecatDeviceError) => {
            setFlowVoiceNotice(error.message ?? "Device access failed");
          },
          onTrackStarted: (track: MediaStreamTrack, participant?: unknown) => {
            if (track.kind !== "audio") return;
            if (participant) {
              setFlowVoiceMicEnabled(true);
              setFlowVoiceNotice(null);
            } else {
              setFlowBotAudioTrack(track);
            }
          },
          onTrackStopped: (track: MediaStreamTrack, participant?: unknown) => {
            if (track.kind !== "audio") return;
            if (participant) {
              setFlowVoiceMicEnabled(false);
            } else {
              setFlowBotAudioTrack(null);
            }
          },
          onUserStartedSpeaking: () => setFlowVoiceUserSpeaking(true),
          onUserStoppedSpeaking: () => setFlowVoiceUserSpeaking(false),
          onBotStartedSpeaking: () => setFlowVoiceBotSpeaking(true),
          onBotStoppedSpeaking: () => setFlowVoiceBotSpeaking(false),
          onUserTranscript: (data: TranscriptData) => {
            const text = data.text?.trim();
            if (!data.final || !text) return;
            setFlowVoiceTurns((current) =>
              appendFlowVoiceTurn(current, { id: crypto.randomUUID(), role: "user", text })
            );
          },
          onBotOutput: (data: BotOutputData) => {
            const text = data.text?.trim();
            if (!text || !data.spoken) return;
            setFlowVoiceTurns((current) =>
              appendFlowVoiceTurn(current, { id: crypto.randomUUID(), role: "assistant", text })
            );
          }
        }
      });
    } catch (error) {
      setFlowVoiceNotice(error instanceof Error ? error.message : "Pipecat client failed to initialize.");
      return;
    }

    setFlowVoiceClient(client);
    return () => {
      flowVoiceMediaManagerRef.current = null;
      client.disconnect().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const audio = flowBotAudioRef.current;
    if (!audio) return;
    if (!flowBotAudioTrack) {
      clearAudioElement(audio);
      return;
    }
    playAudioTrack(audio, flowBotAudioTrack).catch((error) => {
      const message = audioPlayErrorMessage(error);
      if (message) setFlowVoiceNotice(message);
    });
  }, [flowBotAudioTrack]);

  useEffect(() => {
    if (!flowVoiceConversationId) return;
    const poll = window.setInterval(() => {
      getFlowRunByConversation(flowVoiceConversationId)
        .then(({ run: latestRun }) => {
          if (!latestRun) return;
          setRun(latestRun);
          setSelectedNodeId(latestRun.active_node_id);
        })
        .catch(() => undefined);
    }, 1200);
    return () => window.clearInterval(poll);
  }, [flowVoiceConversationId]);

  useEffect(() => {
    onConversationIdChange?.(flowVoiceConversationId ?? flowRunnerConversationId ?? run?.conversation_id ?? null);
  }, [flowRunnerConversationId, flowVoiceConversationId, onConversationIdChange, run?.conversation_id]);

  useEffect(() => {
    viewRef.current = { zoom, pan };
  }, [pan, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (event: globalThis.WheelEvent) => {
      if (isCanvasControlTarget(event.target)) return;
      event.preventDefault();

      const { zoom: currentZoom, pan: currentPan } = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        const rect = canvas.getBoundingClientRect();
        const worldX = (event.clientX - rect.left - currentPan.x) / currentZoom;
        const worldY = (event.clientY - rect.top - currentPan.y) / currentZoom;
        const nextZoom = Math.min(1.4, Math.max(0.32, currentZoom * Math.exp(-event.deltaY * 0.002)));

        const nextPan = {
          x: Math.round(event.clientX - rect.left - worldX * nextZoom),
          y: Math.round(event.clientY - rect.top - worldY * nextZoom)
        };
        const roundedZoom = Number(nextZoom.toFixed(3));
        viewRef.current = { zoom: roundedZoom, pan: nextPan };
        setZoom(roundedZoom);
        setPan(nextPan);
        return;
      }

      const nextPan = {
        x: Math.round(currentPan.x - event.deltaX),
        y: Math.round(currentPan.y - event.deltaY)
      };
      viewRef.current = { zoom: currentZoom, pan: nextPan };
      setPan(nextPan);
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  function addNode(nodeType: string) {
    const id = `${nodeType}_${Math.random().toString(36).slice(2, 8)}`;
    const next: VoiceNode = {
      id,
      type: "flowNode",
      position: {
        x: Math.round((-pan.x + 420) / zoom - WORLD.originX),
        y: Math.round((-pan.y + 280) / zoom - WORLD.originY)
      },
      data: defaultNodeData(nodeType)
    };
    setNodes((current) => [...current, next]);
    setSelectedNodeId(id);
    setPickerOpen(false);
    setDirty(true);
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>, node: VoiceNode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    setSelectedNodeId(node.id);
    setDragState({
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: node.position.x,
      originY: node.position.y
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function beginPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || isCanvasControlTarget(event.target)) return;
    setPanState({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updatePointer(event: PointerEvent<HTMLDivElement>) {
    if (dragState) {
      const dx = (event.clientX - dragState.startX) / zoom;
      const dy = (event.clientY - dragState.startY) / zoom;
      setNodes((current) =>
        current.map((node) =>
          node.id === dragState.id
            ? {
                ...node,
                position: {
                  x: Math.round(dragState.originX + dx),
                  y: Math.round(dragState.originY + dy)
                }
              }
            : node
        )
      );
      setDirty(true);
      return;
    }

    if (panState) {
      setPan({
        x: Math.round(panState.originX + event.clientX - panState.startX),
        y: Math.round(panState.originY + event.clientY - panState.startY)
      });
    }
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    if (panState?.pointerId === event.pointerId && canvasRef.current?.hasPointerCapture(event.pointerId)) {
      canvasRef.current.releasePointerCapture(event.pointerId);
    }
    setDragState(null);
    setPanState(null);
  }

  function zoomBy(delta: number) {
    setZoom((current) => Math.min(1.4, Math.max(0.32, Number((current + delta).toFixed(2)))));
  }

  function fitView() {
    setZoom(0.42);
    setPan({ x: -45, y: 170 });
  }

  function updateSelectedNode(patch: Partial<VoiceNodeData>) {
    if (!selectedNodeId) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNodeId
          ? {
              ...node,
              data: {
                ...node.data,
                ...patch
              }
            }
          : node
      )
    );
    setDirty(true);
  }

  function updateSelectedNested<K extends keyof VoiceNodeData>(
    key: K,
    patch: Record<string, unknown>
  ) {
    if (!selectedNode) return;
    const current = selectedNode.data[key];
    updateSelectedNode({
      [key]: {
        ...(typeof current === "object" && current !== null ? current : {}),
        ...patch
      }
    } as Partial<VoiceNodeData>);
  }

  function addOutgoingEdge(source: string, target: string, label: string) {
    if (!source || !target || source === target) return;
    setEdges((current) => [
      ...current,
      {
        id: `${source}-${target}-${Date.now()}`,
        source,
        target,
        label: label || "Continue",
        type: "smoothstep",
        data: { keywords: [] }
      }
    ]);
    setDirty(true);
  }

  function updateEdge(edgeId: string, patch: Partial<VoiceEdge>) {
    setEdges((current) =>
      current.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge))
    );
    setDirty(true);
  }

  function deleteEdge(edgeId: string) {
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
    setDirty(true);
  }

  async function runValidation() {
    setBusy(true);
    try {
      const result = await validateFlow(graph);
      setValidation(result.validation);
      onNotice?.(
        result.validation.ok
          ? `Flow validates with ${result.validation.warnings.length} warning(s).`
          : `Flow has ${result.validation.errors.length} error(s).`
      );
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Validation failed");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!flow) return;
    setBusy(true);
    try {
      const result = await saveFlow({
        id: flow.id,
        name: flow.name,
        description: flow.description,
        graph
      });
      setFlow(result.flow);
      setValidation(result.flow.validation);
      setDirty(false);
      onNotice?.(`Saved ${result.flow.name} v${result.flow.version}.`);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!flow) return;
    setBusy(true);
    try {
      if (dirty) {
        const saved = await saveFlow({
          id: flow.id,
          name: flow.name,
          description: flow.description,
          graph
        });
        setFlow(saved.flow);
      }
      const result = await publishFlow(flow.id);
      setFlow(result.flow);
      setValidation(result.flow.validation);
      setDirty(false);
      onNotice?.(`Published ${result.flow.name} v${result.flow.version}.`);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Publish failed");
    } finally {
      setBusy(false);
    }
  }

  async function ensurePublishedFlow() {
    if (!flow) return null;
    if (!dirty) return flow;
    const saved = await saveFlow({
      id: flow.id,
      name: flow.name,
      description: flow.description,
      graph
    });
    const published = await publishFlow(saved.flow.id);
    setFlow(published.flow);
    setValidation(published.flow.validation);
    setDirty(false);
    return published.flow;
  }

  async function toggleFlowVoiceConnection() {
    if (!flowVoiceClient) return;
    if (flowVoiceConnectInFlightRef.current) return;
    flowVoiceConnectInFlightRef.current = true;
    setFlowVoiceNotice(null);
    try {
      const connected = flowVoiceState === "connected" || flowVoiceState === "ready";
      if (connected) {
        await flowVoiceClient.disconnect();
        setFlowVoiceConversationId(null);
        setFlowVoiceUserSpeaking(false);
        setFlowVoiceBotSpeaking(false);
        return;
      }
      const publishedFlow = await ensurePublishedFlow();
      if (!publishedFlow) return;
      const preflight = await getVoicePreflight(speechPath);
      if (!preflight.ready) {
        throw new Error(preflight.reasons.join(" "));
      }
      await prepareVoice(speechPath);
      if (flowVoiceInputMode === "vad") {
        const stream = await withTimeout(
          requestMicrophoneStream(),
          flowVoiceConnectTimeoutMs,
          "Microphone permission timed out."
        );
        flowVoiceMediaManagerRef.current?.setPendingMicStream(stream);
        flowVoiceClient.enableMic(true);
        setFlowVoiceMicEnabled(true);
      }
      const conversationId = crypto.randomUUID();
      setFlowVoiceConversationId(conversationId);
      setFlowVoiceTurns([]);
      await withTimeout(
        getWebRTCIceConfig()
          .catch(() => ({ iceServers: fallbackIceServers }))
          .then((iceConfig) =>
            flowVoiceClient.connect({
              webrtcRequestParams: {
                endpoint: apiUrl("/api/offer"),
                requestData: {
                  source: "flow_studio",
                  conversation_id: conversationId,
                  voice_behavior_mode: "flow",
                  voice_flow_id: publishedFlow.id,
                  voice_speech_path: speechPath,
                  input_mode: flowVoiceInputMode
                }
              },
              iceConfig
            })
          ),
        flowVoiceConnectTimeoutMs,
        "Flow voice connection timed out."
      );
      const attachedRun = await simulateFlow({ flowId: publishedFlow.id, conversationId });
      setRun(attachedRun);
      setSelectedNodeId(attachedRun.active_node_id);
      setFlowRunnerConversationId(null);
      setFlowVoiceMicEnabled(flowVoiceClient.isMicEnabled);
    } catch (error) {
      await flowVoiceClient.disconnect().catch(() => undefined);
      setFlowVoiceConversationId(null);
      setFlowVoiceUserSpeaking(false);
      setFlowVoiceBotSpeaking(false);
      setFlowVoiceNotice(error instanceof Error ? error.message : "Flow voice connection failed.");
    } finally {
      flowVoiceConnectInFlightRef.current = false;
    }
  }

  async function toggleFlowVoiceMic() {
    if (!flowVoiceClient || !(flowVoiceState === "connected" || flowVoiceState === "ready")) return;
    if (flowVoiceInputMode === "push_to_talk") return;
    try {
      const next = !flowVoiceMicEnabled;
      if (next) {
        const stream = await withTimeout(
          requestMicrophoneStream(),
          flowVoiceConnectTimeoutMs,
          "Microphone permission timed out."
        );
        flowVoiceMediaManagerRef.current?.setPendingMicStream(stream);
      }
      flowVoiceClient.enableMic(next);
      if (!next) setFlowVoiceMicEnabled(false);
    } catch (error) {
      setFlowVoiceNotice(error instanceof Error ? error.message : "Microphone toggle failed.");
    }
  }

  async function startFlowPushToTalk() {
    if (!flowVoiceClient || !flowVoiceConnected || flowVoiceInputMode !== "push_to_talk") return;
    if (flowPushToTalkPressedRef.current) return;
    flowPushToTalkPressedRef.current = true;
    try {
      const stream = await withTimeout(
        requestMicrophoneStream(),
        flowVoiceConnectTimeoutMs,
        "Microphone permission timed out."
      );
      flowVoiceMediaManagerRef.current?.setPendingMicStream(stream);
      flowVoiceClient.enableMic(true);
      setFlowVoiceMicEnabled(true);
      setFlowVoiceUserSpeaking(true);
      setFlowVoiceNotice(null);
    } catch (error) {
      flowPushToTalkPressedRef.current = false;
      setFlowVoiceMicEnabled(false);
      setFlowVoiceUserSpeaking(false);
      setFlowVoiceNotice(error instanceof Error ? error.message : "Push to Talk failed.");
    }
  }

  function stopFlowPushToTalk() {
    if (!flowPushToTalkPressedRef.current) return;
    flowPushToTalkPressedRef.current = false;
    if (flowVoiceClient && flowVoiceConnected) {
      flowVoiceClient.enableMic(false);
    }
    setFlowVoiceMicEnabled(false);
    setFlowVoiceUserSpeaking(false);
  }

  async function startSimulation() {
    if (!flow) return;
    setBusy(true);
    try {
      const conversationId = crypto.randomUUID();
      setFlowRunnerConversationId(conversationId);
      const result = await simulateFlow({ flowId: flow.id, conversationId });
      setRun(result);
      setSelectedNodeId(result.active_node_id);
      onNotice?.("Started live flow execution.");
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendSimulation() {
    if (!flow || !simInput.trim()) return;
    setBusy(true);
    try {
      const conversationId = run?.conversation_id ?? flowRunnerConversationId ?? crypto.randomUUID();
      if (!flowRunnerConversationId) {
        setFlowRunnerConversationId(conversationId);
      }
      const result = await simulateFlow({
        flowId: flow.id,
        runId: run?.run_id,
        message: simInput,
        forceInterrupt,
        conversationId
      });
      setRun(result);
      setSelectedNodeId(result.active_node_id);
      setSimInput("");
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }

  const activeNodeId = run?.active_node_id;
  const flowVoiceConnected = flowVoiceState === "connected" || flowVoiceState === "ready";
  const flowVoiceBusy = flowVoiceState === "connecting" || flowVoiceState === "initializing";
  const flowVoiceActivity = flowVoiceBotSpeaking
    ? "speaking"
    : flowVoiceUserSpeaking
      ? "listening"
      : flowVoiceConnected
        ? "linked"
        : "detached";
  const activeNodeLabel =
    nodes.find((node) => node.id === activeNodeId)?.data.label ?? activeNodeId ?? "waiting";

  useEffect(() => {
    window.localStorage.setItem(flowVoiceInputModeStorageKey, flowVoiceInputMode);
    if (flowVoiceInputMode === "push_to_talk" && flowVoiceClient?.isMicEnabled) {
      flowVoiceClient.enableMic(false);
      setFlowVoiceMicEnabled(false);
    }
  }, [flowVoiceInputMode, flowVoiceClient]);

  useEffect(() => {
    if (flowVoiceInputMode !== "push_to_talk" || !flowVoiceConnected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      startFlowPushToTalk();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (!flowPushToTalkPressedRef.current && isTypingTarget(event.target)) return;
      event.preventDefault();
      stopFlowPushToTalk();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      stopFlowPushToTalk();
    };
  }, [flowVoiceInputMode, flowVoiceConnected]);

  const decoratedNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        className: [
          node.id === activeNodeId ? "activeRuntimeNode" : "",
          node.id === activeNodeId && flowVoiceConnected ? "voiceLinkedRuntimeNode" : "",
          node.id === activeNodeId && flowVoiceUserSpeaking ? "listeningRuntimeNode" : "",
          node.id === activeNodeId && flowVoiceBotSpeaking ? "speakingRuntimeNode" : "",
          node.id === selectedNodeId ? "selectedRuntimeNode" : ""
        ]
          .filter(Boolean)
          .join(" ")
      })),
    [activeNodeId, flowVoiceBotSpeaking, flowVoiceConnected, flowVoiceUserSpeaking, nodes, selectedNodeId]
  );

  return (
    <section className="flowStudio">
      <header className="flowTopbar">
        <div>
          <p className="eyebrow">Flow-bound voice agent</p>
          <h1>{flow?.name ?? "Loading flow"}</h1>
          <p className="flowSubtitle">
            The audio runtime stays realtime and always-on; this graph controls what the agent says,
            collects, routes, repairs, and how it changes tone or speed during the call.
          </p>
          <div className="flowMetaRail">
            <span>{nodes.length} nodes</span>
            <span>{edges.length} routes</span>
            <span>{validation?.ok ? "validated" : "needs review"}</span>
            <span>{dirty ? "draft changes" : "saved"}</span>
          </div>
        </div>
        <div className="flowActions">
          <button onClick={runValidation} disabled={busy}>
            <CheckCircle2 size={16} /> Validate
          </button>
          <button onClick={save} disabled={busy || !flow || !dirty}>
            <Save size={16} /> Save
          </button>
          <button onClick={publish} disabled={busy || !flow}>
            <UploadCloud size={16} /> Publish
          </button>
        </div>
      </header>

      <section className="flowWorkspace">
        <aside className="flowPalette">
          <div className="studioPanelHead">
            <div>
              <strong>Live Execution</strong>
              <span>{run ? `${run.status} · ${run.active_node_id}` : "No run active"}</span>
            </div>
            <button className="miniIconButton" onClick={startSimulation} disabled={busy || !flow} aria-label="Start">
              <Play size={15} />
            </button>
          </div>
          <div className="traceList">
            {run?.transcript.slice(-6).map((turn) => (
              <article className={`traceTurn ${turn.role}`} key={turn.id}>
                <span>{turn.role}</span>
                <p>{turn.text}</p>
              </article>
            )) ?? <p className="muted">Start the simulator to watch the active node move.</p>}
          </div>
          <div className="studioPanelHead compact">
            <strong>Validation</strong>
            <span>{validation?.ok ? "ready" : "needs work"}</span>
          </div>
          <ValidationPanel validation={validation} />
        </aside>

        <div
          className={`flowCanvas ${panState ? "isPanning" : ""}`}
          ref={canvasRef}
          onPointerDown={beginPan}
          onPointerMove={updatePointer}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          <div
            className="flowWorld"
            style={
              {
                width: WORLD.width,
                height: WORLD.height,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
              } as CSSProperties
            }
          >
            <svg className="flowEdges" width={WORLD.width} height={WORLD.height}>
              {edges.map((edge) => {
                const source = nodes.find((node) => node.id === edge.source);
                const target = nodes.find((node) => node.id === edge.target);
                if (!source || !target) return null;
                const outgoing = outgoingBySource.get(edge.source) ?? [];
                const outputIndex = Math.max(0, outgoing.findIndex((candidate) => candidate.id === edge.id));
                const path = edgePath(source, target, outputIndex);
                const labelPoint = edgeLabelPoint(source, target, outputIndex);
                const isActive = source.id === activeNodeId || target.id === activeNodeId;
                return (
                  <g className={isActive ? "activeEdge" : ""} key={edge.id}>
                    <path d={path} />
                    <text x={labelPoint.x} y={labelPoint.y}>
                      {edge.label}
                    </text>
                  </g>
                );
              })}
            </svg>

            {selectedNode && (
              <SelectedPreview node={selectedNode} outgoing={outgoingBySource.get(selectedNode.id) ?? []} />
            )}

            <div className="flowNodesLayer">
              {decoratedNodes.map((node) => (
                <FlowNode
                  key={node.id}
                  node={node}
                  selected={node.id === selectedNodeId}
                  active={node.id === activeNodeId}
                  outputLabels={nodeOutputs(node, outgoingBySource.get(node.id) ?? [])}
                  onPointerDown={beginDrag}
                />
              ))}
            </div>
          </div>

          <div className="canvasToolbar">
            <button onClick={() => setPickerOpen(true)}>
              <Plus size={16} /> Add Node
            </button>
            <button onClick={() => zoomBy(-0.08)} aria-label="Zoom out">
              <Minus size={16} />
            </button>
            <button onClick={fitView} aria-label="Fit view">
              <Maximize2 size={16} />
            </button>
            <button onClick={() => zoomBy(0.08)} aria-label="Zoom in">
              <Plus size={16} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
          </div>

          <NodePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onAdd={addNode} />
        </div>

        <aside className="flowInspector">
          <NodeInspector
            node={selectedNode}
            nodes={nodes}
            edges={edges.filter((edge) => edge.source === selectedNode?.id)}
            onChange={updateSelectedNode}
            onNestedChange={updateSelectedNested}
            onAddEdge={addOutgoingEdge}
            onUpdateEdge={updateEdge}
            onDeleteEdge={deleteEdge}
          />
        </aside>
      </section>

      <section className="flowTestBench">
        <div className="studioPanelHead">
          <div>
            <strong>Live Process Runner</strong>
            <span>{run ? `${run.status} · active ${run.active_node_id}` : "Start to execute the graph"}</span>
          </div>
          <button onClick={startSimulation} disabled={busy || !flow}>
            <Play size={16} /> Start
          </button>
        </div>

        <div className="flowVoicePanel">
          <audio ref={flowBotAudioRef} autoPlay />
          <div>
            <strong>Flow Voice Agent</strong>
            <span>
              {flowVoiceConversationId
                ? `${flowVoiceActivity} · ${flowVoiceConversationId.slice(0, 8)} · ${activeNodeLabel}`
                : flowVoiceState}
            </span>
          </div>
          <div className="flowVoiceControls">
            <button onClick={toggleFlowVoiceConnection} disabled={!flowVoiceClient || busy}>
              {flowVoiceConnected ? "Disconnect" : "Connect Flow"}
            </button>
            <button
              onClick={toggleFlowVoiceMic}
              disabled={!flowVoiceConnected || flowVoiceInputMode === "push_to_talk"}
            >
              {flowVoiceInputMode === "push_to_talk" ? "Hold Space" : flowVoiceMicEnabled ? "Mute" : "Unmute"}
            </button>
          </div>
          <div className="flowSpeechPathSwitch" aria-label="Voice input mode">
            <button
              className={flowVoiceInputMode === "vad" ? "active" : ""}
              onClick={() => setFlowVoiceInputMode("vad")}
              disabled={flowVoiceConnected || flowVoiceBusy || busy}
            >
              <Mic size={15} /> Voice Activity Detection
            </button>
            <button
              className={flowVoiceInputMode === "push_to_talk" ? "active" : ""}
              onClick={() => setFlowVoiceInputMode("push_to_talk")}
              disabled={flowVoiceConnected || flowVoiceBusy || busy}
            >
              <Keyboard size={15} /> Push to Talk
            </button>
          </div>
          <div className="flowSpeechPathSwitch" aria-label="Speech provider path">
            <button
              className="active"
              onClick={() => onSpeechPathChange?.("nvidia_gradium")}
              disabled={flowVoiceConnected || flowVoiceBusy || busy}
            >
              <Cpu size={15} /> Gradium
            </button>
          </div>
          <div
            className={`flowVoiceLink ${flowVoiceConnected ? "isConnected" : ""} ${
              flowVoiceUserSpeaking ? "isListening" : ""
            } ${flowVoiceBotSpeaking ? "isSpeaking" : ""}`}
          >
            <span className="flowVoiceLinkDot" />
            <span>{flowVoiceConnected ? `Graph run ${run?.run_id.slice(0, 8) ?? "starting"}` : "Graph detached"}</span>
            <strong>{activeNodeLabel}</strong>
          </div>
          {flowVoiceNotice && <p className="errorText">{flowVoiceNotice}</p>}
          {flowVoiceTurns.length > 0 && (
            <div className="flowVoiceTurns">
              {flowVoiceTurns.map((turn) => (
                <span className={turn.role} key={turn.id}>
                  {turn.role}: {turn.text}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flowTranscript">
          {(run?.transcript ?? []).length === 0 ? (
            <p className="muted">
              Start the runner, then speak task details. The highlighted node follows the process live.
            </p>
          ) : (
            run?.transcript.map((turn) => (
              <article className={`flowTurn ${turn.role}`} key={turn.id}>
                <span>{turn.role}</span>
                <p>{turn.text}</p>
                {turn.latency_ms !== undefined && <small>{turn.latency_ms} ms</small>}
              </article>
            ))
          )}
        </div>

        <div className="flowSimControls">
          <label>
            <input
              type="checkbox"
              checked={forceInterrupt}
              onChange={(event) => setForceInterrupt(event.target.checked)}
            />
            Interrupt current node
          </label>
          <input
            value={simInput}
            onChange={(event) => setSimInput(event.target.value)}
            placeholder="Say something to the active behavior node"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                sendSimulation();
              }
            }}
          />
          <button onClick={sendSimulation} disabled={busy || !simInput.trim()}>
            <Send size={16} /> Send
          </button>
        </div>
      </section>
    </section>
  );
}

function FlowNode({
  node,
  selected,
  active,
  outputLabels,
  onPointerDown
}: {
  node: VoiceNode;
  selected: boolean;
  active: boolean;
  outputLabels: string[];
  onPointerDown: (event: PointerEvent<HTMLDivElement>, node: VoiceNode) => void;
}) {
  const { data } = node;
  const Icon = iconForType(data.nodeType);
  const nodeClass = `flowNodeCard ${data.nodeType} ${data.category ?? ""} ${
    selected ? "selected" : ""
  } ${active ? "activeRuntimeNode" : ""}`;
  return (
    <div
      className={`${nodeClass} ${node.className ?? ""}`}
      style={{
        left: WORLD.originX + node.position.x,
        top: WORLD.originY + node.position.y
      }}
      onPointerDown={(event) => onPointerDown(event, node)}
    >
      <span className="nodeInputHandle" />
      <div className="nodeIcon">
        <Icon size={18} />
      </div>
      <div className="nodeMain">
        <strong>{data.label}</strong>
        <span>{titleFromType(data.nodeType)}</span>
      </div>
      <div className="nodeRouteRows">
        {outputLabels.map((label) => (
          <div className="nodeRouteRow" key={label}>
            <span>{label}</span>
            <i />
          </div>
        ))}
      </div>
    </div>
  );
}

function SelectedPreview({ node, outgoing }: { node: VoiceNode; outgoing: VoiceEdge[] }) {
  const script = String(node.data.script || node.data.prompt || "");
  const endpoint = String(node.data.endpoint || "");
  const contentLabel = endpoint ? "Endpoint" : "Script";
  const content = endpoint || script || node.data.purpose || "No script configured.";
  return (
    <div
      className="selectedPreview"
      style={{
        left: WORLD.originX + node.position.x - 36,
        top: Math.max(12, WORLD.originY + node.position.y - 154)
      }}
    >
      <h2>{node.data.label}</h2>
      <div>
        <span>{contentLabel}</span>
        <p>{content}</p>
      </div>
      {outgoing.length > 0 && (
        <footer>
          {outgoing.map((edge) => (
            <small key={edge.id}>{edge.label}</small>
          ))}
        </footer>
      )}
    </div>
  );
}

function NodePicker({
  open,
  onClose,
  onAdd
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (nodeType: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<PaletteItem["group"]>("In-Call");
  if (!open) return null;
  const filtered = palette.filter((item) => item.group === group);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = filtered.filter((item) =>
    normalizedQuery
      ? `${item.label} ${item.description} ${item.type}`.toLowerCase().includes(normalizedQuery)
      : true
  );

  return (
    <div className="nodePicker">
      <div className="nodePickerSearch">
        <Search size={17} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search..."
        />
        <button onClick={onClose} aria-label="Close node picker">
          <X size={16} />
        </button>
      </div>
      <div className="nodePickerTabs">
        {paletteGroups.map((item) => (
          <button className={item === group ? "active" : ""} key={item} onClick={() => setGroup(item)}>
            {item}
          </button>
        ))}
      </div>
      <div className="nodePickerList">
        {visible.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.type} onClick={() => onAdd(item.type)}>
              <Icon size={17} />
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  nodes,
  edges,
  onChange,
  onNestedChange,
  onAddEdge,
  onUpdateEdge,
  onDeleteEdge
}: {
  node: VoiceNode | null;
  nodes: VoiceNode[];
  edges: VoiceEdge[];
  onChange: (patch: Partial<VoiceNodeData>) => void;
  onNestedChange: <K extends keyof VoiceNodeData>(
    key: K,
    patch: Record<string, unknown>
  ) => void;
  onAddEdge: (source: string, target: string, label: string) => void;
  onUpdateEdge: (edgeId: string, patch: Partial<VoiceEdge>) => void;
  onDeleteEdge: (edgeId: string) => void;
}) {
  const [edgeTarget, setEdgeTarget] = useState("");
  const [edgeLabel, setEdgeLabel] = useState("Continue");

  if (!node) {
    return (
      <div className="emptyInspector">
        <PanelRight size={22} />
        <p>Select a behavior node to edit script, route names, voice, tone, latency, and integrations.</p>
      </div>
    );
  }

  const data = node.data;
  return (
    <div className="inspectorScroll">
      <div className="studioPanelHead">
        <div>
          <strong>{data.label}</strong>
          <span>{node.id}</span>
        </div>
      </div>

      <Field label="Label">
        <input value={data.label} onChange={(event) => onChange({ label: event.target.value })} />
      </Field>

      <Field label="Type">
        <select
          value={data.nodeType}
          onChange={(event) => onChange({ nodeType: event.target.value, ...defaultTypePatch(event.target.value) })}
        >
          {palette.map((item) => (
            <option key={item.type} value={item.type}>
              {item.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Purpose">
        <textarea
          value={data.purpose ?? ""}
          onChange={(event) => onChange({ purpose: event.target.value })}
          rows={3}
        />
      </Field>

      <Field label="Script / Prompt">
        <textarea
          value={data.script ?? data.prompt ?? ""}
          onChange={(event) => onChange({ script: event.target.value, prompt: event.target.value })}
          rows={5}
        />
      </Field>

      <div className="inspectorGroup">
        <h3>Outgoing Routes</h3>
        <div className="edgeEditor">
          {edges.map((edge) => (
            <div className="edgeEditorRow" key={edge.id}>
              <input
                value={edge.label ?? ""}
                onChange={(event) => onUpdateEdge(edge.id, { label: event.target.value })}
                aria-label="Route label"
              />
              <select
                value={edge.target}
                onChange={(event) => onUpdateEdge(edge.id, { target: event.target.value })}
                aria-label="Route target"
              >
                {nodes.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.data.label}
                  </option>
                ))}
              </select>
              <button onClick={() => onDeleteEdge(edge.id)} aria-label="Remove route">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="edgeEditorRow">
            <input
              value={edgeLabel}
              onChange={(event) => setEdgeLabel(event.target.value)}
              placeholder="route label"
            />
            <select value={edgeTarget} onChange={(event) => setEdgeTarget(event.target.value)}>
              <option value="">Target node</option>
              {nodes
                .filter((candidate) => candidate.id !== node.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.data.label}
                  </option>
                ))}
            </select>
            <button
              onClick={() => {
                onAddEdge(node.id, edgeTarget, edgeLabel);
                setEdgeTarget("");
                setEdgeLabel("Continue");
              }}
            >
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="inspectorGroup">
        <h3>Data To Collect</h3>
        <Field label="Fields">
          <textarea
            value={(data.fields ?? []).map((field) => field.name).join("\n")}
            onChange={(event) =>
              onChange({
                fields: event.target.value
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean)
                  .map((name, index) => ({ name, type: "text", required: index === 0 }))
              })
            }
            rows={4}
          />
        </Field>
      </div>

      <div className="inspectorGroup">
        <h3>Voice</h3>
        <Field label="Voice ID">
          <input
            value={data.voice?.voiceId ?? ""}
            onChange={(event) => onNestedChange("voice", { voiceId: event.target.value })}
          />
        </Field>
        <Field label="Tone">
          <select
            value={data.voice?.tone ?? "calm"}
            onChange={(event) => onNestedChange("voice", { tone: event.target.value })}
          >
            {tones.map((tone) => (
              <option key={tone} value={tone}>
                {tone}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Speed">
          <input
            type="number"
            step="0.01"
            min="0.7"
            max="1.4"
            value={data.voice?.speed ?? 1}
            onChange={(event) => onNestedChange("voice", { speed: Number(event.target.value) })}
          />
        </Field>
        <label className="inlineCheck">
          <input
            type="checkbox"
            checked={Boolean(data.voice?.allowBargeIn)}
            onChange={(event) => onNestedChange("voice", { allowBargeIn: event.target.checked })}
          />
          Allow barge-in
        </label>
      </div>

      <div className="inspectorGroup">
        <h3>Latency</h3>
        <Field label="Profile">
          <select
            value={data.latency?.profile ?? "fast"}
            onChange={(event) => onNestedChange("latency", { profile: event.target.value })}
          >
            {latencyProfiles.map((profile) => (
              <option key={profile} value={profile}>
                {profile}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target ms">
          <input
            type="number"
            min="100"
            value={data.latency?.targetMs ?? 800}
            onChange={(event) => onNestedChange("latency", { targetMs: Number(event.target.value) })}
          />
        </Field>
      </div>

      <div className="inspectorGroup">
        <h3>Integration</h3>
        <Field label="Endpoint">
          <input
            value={data.endpoint ?? ""}
            onChange={(event) => onChange({ endpoint: event.target.value })}
          />
        </Field>
        <textarea
          value={JSON.stringify({ integration: data.integration ?? {}, fallback: data.fallback ?? {} }, null, 2)}
          onChange={(event) => {
            try {
              const parsed = JSON.parse(event.target.value) as {
                integration?: Record<string, unknown>;
                fallback?: Record<string, unknown>;
              };
              onChange({
                integration: parsed.integration ?? data.integration,
                fallback: parsed.fallback ?? data.fallback
              });
            } catch {
              return;
            }
          }}
          rows={8}
        />
      </div>
    </div>
  );
}

function ValidationPanel({ validation }: { validation: FlowValidation | null }) {
  if (!validation) return <p className="muted">Validation has not run yet.</p>;
  return (
    <div className="validationList">
      <div className={validation.ok ? "validationOk" : "validationBad"}>
        {validation.ok ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}
        <span>
          {validation.node_count} nodes · {validation.edge_count} routes
        </span>
      </div>
      {validation.errors.map((item) => (
        <p className="validationError" key={item}>
          {item}
        </p>
      ))}
      {validation.warnings.slice(0, 8).map((item) => (
        <p className="validationWarning" key={item}>
          {item}
        </p>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: JSX.Element }) {
  return (
    <label className="inspectorField">
      <span>{label}</span>
      {children}
    </label>
  );
}

function toNodes(graph: FlowGraph): VoiceNode[] {
  return graph.nodes.map((rawNode) => {
    const record = rawNode as Record<string, unknown>;
    const data = normalizeNodeData(record.data);
    return {
      ...record,
      id: String(record.id),
      type: "flowNode",
      position: normalizePosition(record.position),
      data
    } as VoiceNode;
  });
}

function toEdges(graph: FlowGraph): VoiceEdge[] {
  return graph.edges.map((rawEdge) => {
    const record = rawEdge as Record<string, unknown>;
    return {
      ...record,
      id: String(record.id ?? `${record.source}-${record.target}`),
      source: String(record.source),
      target: String(record.target),
      type: String(record.type ?? "smoothstep")
    } as VoiceEdge;
  });
}

function normalizePosition(value: unknown) {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return {
      x: readNumber(record.x, 0),
      y: readNumber(record.y, 0)
    };
  }
  return { x: 0, y: 0 };
}

function normalizeNodeData(value: unknown): VoiceNodeData {
  const data = (typeof value === "object" && value !== null ? value : {}) as Partial<VoiceNodeData>;
  const nodeType = typeof data.nodeType === "string" ? data.nodeType : "dialogue";
  const defaults = defaultNodeData(nodeType);
  const script = typeof data.script === "string" ? data.script : data.prompt;
  return {
    ...defaults,
    ...data,
    label: typeof data.label === "string" ? data.label : defaults.label,
    nodeType,
    script: typeof script === "string" ? script : defaults.script
  };
}

function defaultNodeData(nodeType: string): VoiceNodeData {
  const paletteItem = palette.find((item) => item.type === nodeType);
  const label = paletteItem?.label ?? titleFromType(nodeType);
  const script = defaultScript(nodeType);
  return {
    label,
    nodeType,
    category: paletteItem?.category ?? "in-call",
    purpose: paletteItem?.description ?? "Describe what this behavior node controls.",
    prompt: script,
    script,
    outputs: paletteItem?.outputs ?? ["Continue"],
    fields: nodeType === "collect" ? [{ name: "user_request", type: "text", required: true }] : [],
    endpoint: nodeType === "api" ? "https://api.example.com/context" : "",
    integration: nodeType === "codex_task" ? { orchestrator: "agent", approvalMode: "ask_before_write" } : {},
    voice: {
      voiceId: "neutral_female",
      tone: nodeType === "confirm" ? "careful" : "calm",
      speed: 1,
      language: "en",
      allowBargeIn: nodeType !== "end"
    },
    latency: {
      profile: nodeType === "codex_task" || nodeType === "wait" ? "async" : nodeType === "start" ? "instant" : "fast",
      targetMs: nodeType === "codex_task" ? 1200 : 800
    },
    interrupt: {
      enabled: nodeType !== "end",
      stopSpeaking: true,
      routes: [{ intent: "correction_or_cancel", target: "clarify_request" }]
    },
    fallback: {
      unclear: "clarify_request",
      failed: "repair"
    },
    autoAdvance: nodeType === "start"
  };
}

function defaultTypePatch(nodeType: string): Partial<VoiceNodeData> {
  const defaults = defaultNodeData(nodeType);
  return {
    category: defaults.category,
    purpose: defaults.purpose,
    outputs: defaults.outputs,
    latency: defaults.latency,
    fields: defaults.fields
  };
}

function defaultScript(nodeType: string) {
  if (nodeType === "start") return "";
  if (nodeType === "dialogue") return "Answer naturally inside this flow node.";
  if (nodeType === "collect") return "I'm listening.";
  if (nodeType === "confirm") return "Just to confirm, should I continue with {user_request}?";
  if (nodeType === "condition") return "Check whether this should proceed automatically or needs approval.";
  if (nodeType === "api") return "I'll call the configured API and use the result in the next step.";
  if (nodeType === "codex_task") return "I'll queue this task and keep tracking it live.";
  if (nodeType === "wait") return "The task is running. I'll call out anything that needs your decision.";
  if (nodeType === "transfer_call") return "Here is the current conversation summary.";
  if (nodeType === "fallback") return "I missed that. Say it again and I'll stay with the flow.";
  if (nodeType === "end") return "Done.";
  return "Reply naturally inside this node's scope.";
}

function titleFromType(nodeType: string) {
  return nodeType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function iconForType(nodeType: string) {
  if (nodeType === "start" || nodeType === "wait") return Radio;
  if (nodeType === "condition") return GitBranch;
  if (nodeType === "codex_task" || nodeType === "api") return Code2;
  if (nodeType === "knowledge_base") return BookOpen;
  if (nodeType === "sms" || nodeType === "dialogue" || nodeType === "collect") return MessageSquare;
  if (nodeType === "email") return Mail;
  if (nodeType === "transfer_call" || nodeType === "handoff") return PhoneForwarded;
  if (nodeType === "confirm" || nodeType === "end") return CheckCircle2;
  if (nodeType === "fallback") return TriangleAlert;
  if (nodeType === "guardrail") return ShieldCheck;
  return SquareFunction;
}

function nodeOutputs(node: VoiceNode, outgoing: VoiceEdge[]) {
  if (outgoing.length > 0) return outgoing.map((edge) => edge.label || "Continue");
  return node.data.outputs && node.data.outputs.length > 0 ? node.data.outputs : ["Continue"];
}

function nodePoint(node: VoiceNode) {
  return {
    x: WORLD.originX + node.position.x,
    y: WORLD.originY + node.position.y
  };
}

function edgePath(source: VoiceNode, target: VoiceNode, outputIndex: number) {
  const sourcePoint = nodePoint(source);
  const targetPoint = nodePoint(target);
  const startX = sourcePoint.x + 252;
  const startY = sourcePoint.y + 120 + outputIndex * 31;
  const endX = targetPoint.x - 16;
  const endY = targetPoint.y + 78;
  const mid = Math.max(86, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`;
}

function edgeLabelPoint(source: VoiceNode, target: VoiceNode, outputIndex: number) {
  const sourcePoint = nodePoint(source);
  const targetPoint = nodePoint(target);
  return {
    x: (sourcePoint.x + targetPoint.x) / 2 + 92,
    y: (sourcePoint.y + targetPoint.y) / 2 + 62 + outputIndex * 16
  };
}

function readNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isCanvasControlTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        ".flowNodeCard, .canvasToolbar, .nodePicker, .selectedPreview, button, input, textarea, select"
      )
    )
  );
}
