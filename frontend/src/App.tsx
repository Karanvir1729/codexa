import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Brain,
  CheckCircle2,
  Clock3,
  Gauge,
  MessageSquare,
  PhoneCall,
  Play,
  RefreshCcw,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp
} from "lucide-react";
import {
  Badge,
  CircularWaveform,
  ControlBar,
  UserAudioComponent
} from "@pipecat-ai/voice-ui-kit";
import {
  ChatResponse,
  CostGuard,
  EvalSchedulerState,
  getEvalScheduler,
  getCost,
  getHealth,
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

type Turn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  latency_ms?: number;
  prompt_version?: number;
};

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

export function App() {
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
  const [kitStream, setKitStream] = useState<MediaStream | null>(null);
  const [availableMics, setAvailableMics] = useState<MediaDeviceInfo[]>([]);
  const [availableSpeakers, setAvailableSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string | undefined>();
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string | undefined>();
  const [kitNotice, setKitNotice] = useState<string | null>(null);
  const kitStreamRef = useRef<MediaStream | null>(null);

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
    kitStreamRef.current = kitStream;
  }, [kitStream]);

  useEffect(() => {
    refreshKitDevices().catch((error) => setKitNotice(error.message));
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshKitDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshKitDevices);
      stopMediaStream(kitStreamRef.current);
    };
  }, []);

  const lastAssistant = useMemo(() => [...turns].reverse().find((turn) => turn.role === "assistant"), [turns]);
  const latency = lastAssistant?.latency_ms ?? 0;
  const kitAudioTrack = kitStream?.getAudioTracks()[0] ?? null;
  const selectedMic = availableMics.find((device) => device.deviceId === selectedMicId);
  const selectedSpeaker = availableSpeakers.find((device) => device.deviceId === selectedSpeakerId);

  function stopMediaStream(stream: MediaStream | null) {
    stream?.getTracks().forEach((track) => track.stop());
  }

  async function refreshKitDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setKitNotice("Media devices unavailable in this browser.");
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((device) => device.kind === "audioinput");
    const speakers = devices.filter((device) => device.kind === "audiooutput");
    setAvailableMics(mics);
    setAvailableSpeakers(speakers);
    setSelectedMicId((current) => current ?? mics[0]?.deviceId);
    setSelectedSpeakerId((current) => current ?? speakers[0]?.deviceId);
  }

  async function startKitMic(deviceId?: string) {
    if (!navigator.mediaDevices?.getUserMedia) {
      setKitNotice("Microphone access unavailable in this browser.");
      return;
    }
    setKitNotice(null);
    const audio: MediaTrackConstraints | boolean = deviceId ? { deviceId: { exact: deviceId } } : true;
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    stopMediaStream(kitStreamRef.current);
    setKitStream(stream);
    setSelectedMicId(stream.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId);
    await refreshKitDevices();
  }

  async function toggleKitMic() {
    if (kitStream) {
      stopMediaStream(kitStream);
      setKitStream(null);
      return;
    }
    try {
      await startKitMic(selectedMicId);
    } catch (error) {
      setKitNotice(error instanceof Error ? error.message : "Microphone access failed.");
    }
  }

  async function updateKitMic(deviceId: string) {
    setSelectedMicId(deviceId);
    if (!kitStream) return;
    try {
      await startKitMic(deviceId);
    } catch (error) {
      setKitNotice(error instanceof Error ? error.message : "Microphone switch failed.");
    }
  }

  async function submit(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const text = (override ?? message).trim();
    if (!text || busy) return null;
    setBusy(true);
    setNotice(null);
    setTurns((current) => [...current, { id: crypto.randomUUID(), role: "user", content: text }]);
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
    setTurns((current) => [
      ...current,
      {
        id: response.assistant_turn_id,
        role: "assistant",
        content: response.message,
        latency_ms: response.latency_ms,
        prompt_version: response.prompt_version
      }
    ]);
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
          <a className="active"><MessageSquare size={18} /> Live</a>
          <a><Activity size={18} /> Evals</a>
          <a><Server size={18} /> Runtime</a>
        </nav>
      </aside>

      <section className="workspace">
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
                  <h2>Pipecat Kit</h2>
                  <p>{kitStream ? "local media active" : "device standby"}</p>
                </div>
                <Badge color={kitStream ? "active" : "inactive"} variant="outline" rounded="sm">
                  {kitStream ? "mic open" : "mic off"}
                </Badge>
              </div>

              <div className="kitStage">
                <CircularWaveform
                  audioTrack={kitAudioTrack}
                  backgroundColor="#0a0e12"
                  barWidth={4}
                  color1="#d8fb6f"
                  color2="#67e8f9"
                  isThinking={!kitStream}
                  numBars={42}
                  rotationEnabled={Boolean(kitStream)}
                  sensitivity={1.2}
                  size={148}
                />
                <div className="kitBadges">
                  <Badge color="client" variant="outline" rounded="sm">Whisper auto</Badge>
                  <Badge color="agent" variant="outline" rounded="sm">Fish TTS route</Badge>
                  <Badge color="secondary" variant="outline" rounded="sm">Pipecat local</Badge>
                </div>
              </div>

              <ControlBar className="kitControlBar" noAnimateIn>
                <UserAudioComponent
                  activeText="Mic on"
                  availableMics={availableMics}
                  availableSpeakers={availableSpeakers}
                  inactiveText="Mic off"
                  isMicEnabled={Boolean(kitStream)}
                  noVisualizer
                  onClick={toggleKitMic}
                  selectedMic={selectedMic}
                  selectedSpeaker={selectedSpeaker}
                  size="lg"
                  updateMic={updateKitMic}
                  updateSpeaker={setSelectedSpeakerId}
                  variant="outline"
                />
              </ControlBar>
              {kitNotice && <p className="errorText">{kitNotice}</p>}
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
