import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Brain,
  CheckCircle2,
  Gauge,
  MessageSquare,
  PhoneCall,
  Play,
  RefreshCcw,
  Send,
  Server,
  Sparkles,
  ThumbsDown,
  ThumbsUp
} from "lucide-react";
import {
  ChatResponse,
  getHealth,
  getPrompt,
  Health,
  listEvalRuns,
  PromptState,
  runEval,
  sendFeedback,
  sendMessage
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
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const [healthState, promptState, runs] = await Promise.all([getHealth(), getPrompt(), listEvalRuns()]);
    setHealth(healthState);
    setPrompt(promptState);
    setEvalRuns(runs.runs);
  }

  useEffect(() => {
    refresh().catch((error) => setNotice(error.message));
  }, []);

  const lastAssistant = useMemo(() => [...turns].reverse().find((turn) => turn.role === "assistant"), [turns]);
  const latency = lastAssistant?.latency_ms ?? 0;

  async function submit(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const text = (override ?? message).trim();
    if (!text || busy) return;
    setBusy(true);
    setNotice(null);
    setTurns((current) => [...current, { id: crypto.randomUUID(), role: "user", content: text }]);
    setMessage("");
    try {
      const response = await sendMessage(text, conversationId);
      applyAssistantResponse(response);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function applyAssistantResponse(response: ChatResponse) {
    setConversationId(response.conversation_id);
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
          <Metric icon={<PhoneCall />} label="Voice" value={health?.voice_runtime ?? "loading"} detail="Twilio + Pipecat path" />
          <Metric icon={<Gauge />} label="Latency" value={`${latency} ms`} detail="latest assistant turn" />
          <Metric icon={<CheckCircle2 />} label="Prompt" value={`v${prompt?.version ?? "-"}`} detail={health?.reasoning_mode ?? ""} />
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
                  <p>Start a web turn or connect Twilio to stream live calls into the same feedback loop.</p>
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
            <section className="panel">
              <div className="sectionHead">
                <div>
                  <h2>Evaluation</h2>
                  <p>Regression suite</p>
                </div>
                <button onClick={executeEval} disabled={evalBusy}><Play size={16} /> Run</button>
              </div>
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

