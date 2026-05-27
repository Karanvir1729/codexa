import { FormEvent, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import Brain from "lucide-react/dist/esm/icons/brain.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.js";
import Gauge from "lucide-react/dist/esm/icons/gauge.js";
import MessageSquare from "lucide-react/dist/esm/icons/message-square.js";
import PhoneCall from "lucide-react/dist/esm/icons/phone-call.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RefreshCcw from "lucide-react/dist/esm/icons/refresh-ccw.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import Server from "lucide-react/dist/esm/icons/server.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import Square from "lucide-react/dist/esm/icons/square.js";
import ThumbsDown from "lucide-react/dist/esm/icons/thumbs-down.js";
import ThumbsUp from "lucide-react/dist/esm/icons/thumbs-up.js";
import Workflow from "lucide-react/dist/esm/icons/workflow.js";
import { PipecatClient, type TransportState } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { BrowserAudioMediaManager } from "./browserAudioMediaManager";
import {
  apiUrl,
  ChatResponse,
  CostGuard,
  EvalSchedulerState,
  getEvalScheduler,
  getCost,
  getHealth,
  getWebRTCIceConfig,
  getPrompt,
  Health,
  listEvalRuns,
  PromptState,
  runEval,
  sendFeedback,
  sendMessage,
  startEvalScheduler,
  stopEvalScheduler
} from "./api";
import { FlowStudio } from "./FlowStudio";

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

type Turn = {
  id: string;
  role: "user" | "assistant";
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

const prompts = [
  "Hello, I need help with my account.",
  "I want to cancel an order and get a refund.",
  "How are you reducing network latency?",
  "Can I talk to a human agent?"
];

const voiceIceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const voiceConnectTimeoutMs = 30000;

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

export function App() {
  const [activeView, setActiveView] = useState<"live" | "flow">("flow");
  const [health, setHealth] = useState<Health | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalRuns, setEvalRuns] = useState<EvalRun[]>([]);
  const [scheduler, setScheduler] = useState<EvalSchedulerState | null>(null);
  const [cost, setCost] = useState<CostGuard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voiceClient, setVoiceClient] = useState<PipecatClient | null>(null);
  const [voiceState, setVoiceState] = useState<TransportState>("disconnected");
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [localAudioTrack, setLocalAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [botAudioTrack, setBotAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [micEnabled, setMicEnabled] = useState(false);
  const [botSpeaking, setBotSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const botAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceMediaManagerRef = useRef<BrowserAudioMediaManager | null>(null);
  const voiceStateRef = useRef<TransportState>("disconnected");

  async function refresh() {
    const [healthState, promptState, runs, costState, schedulerState] = await Promise.all([
      getHealth(),
      getPrompt(),
      listEvalRuns(),
      getCost(),
      getEvalScheduler()
    ]);
    setHealth(healthState);
    setPrompt(promptState);
    setEvalRuns(runs.runs);
    setCost(costState.cost_guard);
    setScheduler(schedulerState);
  }

  useEffect(() => {
    refresh().catch((error) => setNotice(error.message));
  }, []);

  useEffect(() => {
    if (!window.RTCPeerConnection) {
      setVoiceNotice("Browser voice needs WebRTC support.");
      return;
    }

    let client: PipecatClient;
    try {
      const mediaManager = new BrowserAudioMediaManager();
      voiceMediaManagerRef.current = mediaManager;
      client = new PipecatClient({
        transport: new SmallWebRTCTransport({
          iceServers: voiceIceServers,
          mediaManager,
          waitForICEGathering: false
        }),
        enableMic: false,
        enableCam: false,
        callbacks: {
          onConnected: () => setVoiceNotice(null),
          onDisconnected: () => {
            setMicEnabled(false);
            setBotSpeaking(false);
            setUserSpeaking(false);
            setLocalAudioTrack(null);
            setBotAudioTrack(null);
          },
          onTransportStateChanged: (state: TransportState) => {
            voiceStateRef.current = state;
            setVoiceState(state);
          },
          onError: (message: PipecatErrorMessage) => {
            if (message.data?.message) {
              setVoiceNotice(message.data.message);
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
              setBotAudioTrack(track);
            }
          },
          onTrackStopped: (track: MediaStreamTrack, participant?: unknown) => {
            if (track.kind !== "audio") return;
            if (participant) {
              setLocalAudioTrack(null);
              setMicEnabled(false);
            } else {
              setBotAudioTrack(null);
            }
          },
          onUserStartedSpeaking: () => setUserSpeaking(true),
          onUserStoppedSpeaking: () => setUserSpeaking(false),
          onBotStartedSpeaking: () => setBotSpeaking(true),
          onBotStoppedSpeaking: () => setBotSpeaking(false),
          onUserTranscript: (data: TranscriptData) => {
            const text = data.text?.trim();
            if (!data.final || !text) return;
            setTurns((current) =>
              appendTurn(current, { id: crypto.randomUUID(), role: "user", content: text })
            );
          },
          onBotOutput: (data: BotOutputData) => {
            const text = data.text?.trim();
            if (!text || !data.spoken) return;
            setTurns((current) =>
              appendTurn(current, { id: crypto.randomUUID(), role: "assistant", content: text })
            );
          }
        }
      });
    } catch (error) {
      setVoiceNotice(error instanceof Error ? error.message : "Pipecat client failed to initialize.");
      return;
    }

    setVoiceClient(client);
    return () => {
      voiceMediaManagerRef.current = null;
      client.disconnect().catch(() => undefined);
    };
  }, []);

  const lastAssistant = useMemo(() => [...turns].reverse().find((turn) => turn.role === "assistant"), [turns]);
  const latency = lastAssistant?.latency_ms ?? 0;
  const voiceConnected = voiceState === "connected" || voiceState === "ready";
  const voiceBusy = voiceState === "connecting" || voiceState === "initializing";
  const voiceStatus = botSpeaking ? "assistant speaking" : userSpeaking ? "listening" : voiceState;
  const sttBadge = voiceProviderLabel(health?.local_stt_provider, "STT");
  const ttsBadge = voiceProviderLabel(health?.local_tts_provider, "TTS");

  useEffect(() => {
    const audio = botAudioRef.current;
    if (!audio || !botAudioTrack) return;
    audio.srcObject = new MediaStream([botAudioTrack]);
    audio.play().catch((error) => setVoiceNotice(error.message));
  }, [botAudioTrack]);

  async function toggleVoiceConnection() {
    if (!voiceClient) return;
    setVoiceNotice(null);
    try {
      if (voiceConnected) {
        await voiceClient.disconnect();
        return;
      }
      await withTimeout(
        getWebRTCIceConfig()
          .catch(() => ({ iceServers: voiceIceServers }))
          .then((iceConfig) =>
            voiceClient.connect({
              webrtcRequestParams: {
                endpoint: apiUrl("/api/offer"),
                requestData: { source: "browser_console" }
              },
              iceConfig
            })
          ),
        voiceConnectTimeoutMs,
        "Voice connection timed out. This network may be blocking WebRTC; switch networks or retry with TURN enabled."
      );
      setMicEnabled(voiceClient.isMicEnabled);
      setVoiceNotice(null);
    } catch (error) {
      await voiceClient.disconnect().catch(() => undefined);
      setVoiceNotice(error instanceof Error ? error.message : "Pipecat connection failed.");
    }
  }

  async function toggleVoiceMic() {
    if (!voiceClient || !voiceConnected) return;
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
    <main className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brandMark"><Sparkles size={18} /></span>
          <div>
            <strong>VoiceOps</strong>
            <span>Feedback engine</span>
          </div>
        </div>
        <nav className="nav">
          <button className={activeView === "flow" ? "active" : ""} onClick={() => setActiveView("flow")}>
            <Workflow size={18} /> Flow
          </button>
          <button className={activeView === "live" ? "active" : ""} onClick={() => setActiveView("live")}>
            <MessageSquare size={18} /> Live
          </button>
          <button onClick={() => setActiveView("live")}><Activity size={18} /> Evals</button>
          <button onClick={() => setActiveView("live")}><Server size={18} /> Runtime</button>
        </nav>
      </aside>

      <section className="workspace">
        {activeView === "flow" ? (
          <FlowStudio onNotice={setNotice} />
        ) : (
          <>
        <header className="topbar">
          <div>
            <p className="eyebrow">NVIDIA reasoning voice agent</p>
            <h1>Continuous feedback console</h1>
          </div>
          <button className="iconButton" onClick={() => refresh()} aria-label="Refresh">
            <RefreshCcw size={18} />
          </button>
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

              <div className="kitStage">
                <audio ref={botAudioRef} autoPlay />
                <CircularWaveform
                  audioTrack={localAudioTrack}
                  backgroundColor="#0a0e12"
                  barWidth={4}
                  color1="#d8fb6f"
                  color2="#67e8f9"
                  isThinking={voiceBusy || botSpeaking}
                  numBars={42}
                  rotationEnabled={voiceConnected}
                  sensitivity={1.2}
                  size={148}
                />
                <div className="kitBadges">
                  <Badge color="client" variant="outline" rounded="sm">{sttBadge}</Badge>
                  <Badge color="agent" variant="outline" rounded="sm">{ttsBadge}</Badge>
                  <Badge color="secondary" variant="outline" rounded="sm">SmallWebRTC</Badge>
                </div>
              </div>

              <div className="kitControlBar">
                <button onClick={toggleVoiceConnection} disabled={!voiceClient || voiceBusy}>
                  {voiceConnected ? "Disconnect" : voiceBusy ? "Connecting" : "Connect"}
                </button>
                <button onClick={toggleVoiceMic} disabled={!voiceConnected}>
                  {micEnabled ? "Mute" : "Unmute"}
                </button>
              </div>
              {voiceNotice && <p className="errorText">{voiceNotice}</p>}
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
                  <h2>Learned Hints</h2>
                  <p>Active prompt delta</p>
                </div>
              </div>
              <pre>{prompt?.learned_hints || "No feedback has been applied yet."}</pre>
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
    deepgram: `Deepgram ${kind}`,
    cartesia: "Cartesia TTS",
    whisper: "Whisper STT",
    whisperx: "WhisperX STT",
    mlx_whisper: "MLX Whisper STT",
    kokoro: "Kokoro TTS",
    fish_speech: "Fish Speech TTS",
    auto: `Auto ${kind}`
  };
  return labels[provider] ?? `${provider} ${kind}`;
}
