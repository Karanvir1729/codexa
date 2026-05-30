import { useEffect, useMemo, useState } from "react";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import Brain from "lucide-react/dist/esm/icons/brain.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import Clock3 from "lucide-react/dist/esm/icons/clock-3.js";
import Gauge from "lucide-react/dist/esm/icons/gauge.js";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.js";
import RefreshCcw from "lucide-react/dist/esm/icons/refresh-ccw.js";
import Server from "lucide-react/dist/esm/icons/server.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.js";
import ToggleLeft from "lucide-react/dist/esm/icons/toggle-left.js";
import ToggleRight from "lucide-react/dist/esm/icons/toggle-right.js";
import Workflow from "lucide-react/dist/esm/icons/workflow.js";
import { getSelfLearn, updateSelfLearnConfig, type LatencyTrace, type SelfLearnConfig, type SelfLearnState } from "./api";

type SelfLearnScope = "all" | "live" | "flow";

type TimelineItem = {
  id: string;
  at: string;
  source: string;
  event: string;
  text: string;
  meta: string;
  tone: "data" | "voice" | "flow" | "fix" | "latency";
};

type SelfLearnProps = {
  liveConversationId?: string | null;
  flowConversationId?: string | null;
};

export function SelfLearn({ liveConversationId, flowConversationId }: SelfLearnProps) {
  const [scope, setScope] = useState<SelfLearnScope>("all");
  const [state, setState] = useState<SelfLearnState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number>(0);

  const selectedConversationId =
    scope === "live" ? liveConversationId || undefined : scope === "flow" ? flowConversationId || undefined : undefined;

  async function load() {
    try {
      const result = await getSelfLearn({ limit: 60, conversationId: selectedConversationId });
      setState(result);
      setError(null);
      setLastLoadedAt(Date.now());
    } catch (requestError) {
      setError(formatRequestError(requestError));
    }
  }

  async function patchConfig(patch: Partial<SelfLearnConfig>) {
    const current = state?.config ?? { enabled: true, factor: 0.75 };
    setConfigBusy(true);
    setState((existing) => existing ? { ...existing, config: { ...current, ...patch } } : existing);
    try {
      const result = await updateSelfLearnConfig(patch);
      setState((existing) => existing ? { ...existing, config: result.config } : existing);
      setError(null);
    } catch (requestError) {
      setError(formatRequestError(requestError));
    } finally {
      setConfigBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await getSelfLearn({ limit: 60, conversationId: selectedConversationId });
        if (!cancelled) {
          setState(result);
          setError(null);
          setLastLoadedAt(Date.now());
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(formatRequestError(requestError));
        }
      }
    };
    refresh();
    const interval = window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedConversationId]);

  const timeline = useMemo(() => buildTimeline(state), [state]);
  const latestTrace = state?.latency_traces[0] ?? null;
  const firstAudio = metricSummary(state, "speech_end_to_first_audio_ms") ?? metricSummary(state, "first_response_ms");
  const totalInteraction = metricSummary(state, "total_interaction_ms");
  const topBottleneck = topBottleneckName(state);
  const learnedLines = splitHints(state?.learned_hints);
  const proposedLines = state?.proposed_hints.map((hint) => hint.replace(/^-\s*/, "")) ?? [];
  const config = state?.config ?? { enabled: true, factor: 0.75 };
  const activePrompt = state?.recent_prompt_versions.find((version) => version.active);
  const appliedFixes = state?.recent_prompt_versions.filter((version) => version.source === "feedback-loop").length ?? 0;
  const dataPoints =
    (state?.recent_turns.length ?? 0) +
    (state?.interaction_events.length ?? 0) +
    (state?.recent_flow_events.length ?? 0) +
    (state?.latency_traces.length ?? 0);

  return (
    <section className="selfLearn">
      <header className="topbar selfLearnTopbar">
        <div>
          <p className="eyebrow">Self-learning control loop</p>
          <h1>Self-learn</h1>
        </div>
        <div className="selfLearnTopActions">
          <div className="selfLearnControls">
            <button
              className={`selfLearnToggle ${config.enabled ? "active" : ""}`}
              disabled={configBusy}
              onClick={() => patchConfig({ enabled: !config.enabled })}
            >
              {config.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
              <span>Self-learn</span>
              <strong>{config.enabled ? "On" : "Off"}</strong>
            </button>
            <label className="selfLearnFactor">
              <span><SlidersHorizontal size={15} /> Self learn factor</span>
              <strong>{config.factor.toFixed(2)}</strong>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={config.factor}
                disabled={!config.enabled}
                onChange={(event) => patchConfig({ factor: Number(event.currentTarget.value) })}
              />
            </label>
          </div>
          <div className="selfLearnScope" aria-label="Self-learn scope">
            <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
              <Activity size={15} /> All
            </button>
            <button
              className={scope === "live" ? "active" : ""}
              onClick={() => setScope("live")}
              disabled={!liveConversationId}
            >
              <Server size={15} /> Live
            </button>
            <button
              className={scope === "flow" ? "active" : ""}
              onClick={() => setScope("flow")}
              disabled={!flowConversationId}
            >
              <Workflow size={15} /> Flow
            </button>
          </div>
          <button className="iconButton" onClick={load} aria-label="Refresh Self-learn">
            <RefreshCcw size={18} />
          </button>
        </div>
      </header>

      <section className="selfLearnSessionStrip">
        <SessionPill label="Live session" value={liveConversationId ? shortId(liveConversationId) : "none"} />
        <SessionPill label="Flow session" value={flowConversationId ? shortId(flowConversationId) : "none"} />
        <SessionPill label="Poll" value={lastLoadedAt ? `${Math.max(0, Math.round((Date.now() - lastLoadedAt) / 1000))}s ago` : "starting"} />
        <SessionPill label="Scope" value={selectedConversationId ? shortId(selectedConversationId) : "all recent data"} />
      </section>

      {error && <p className="errorText selfLearnError">{error}</p>}

      <section className="selfLearnMetrics">
        <SelfLearnMetric icon={<Brain />} label="Active prompt" value={`v${state?.active_prompt_version ?? "-"}`} detail={activePrompt?.source ?? "loading"} />
        <SelfLearnMetric icon={<Sparkles />} label="Applied fixes" value={String(appliedFixes)} detail="feedback-loop prompt versions" />
        <SelfLearnMetric icon={<Activity />} label="Data points" value={String(dataPoints)} detail="turns, events, flow, latency" />
        <SelfLearnMetric icon={<Gauge />} label="First audio p95" value={formatMs(firstAudio?.p95_ms)} detail={`${state?.latency_summary.target_breaches ?? 0} target breach(es)`} />
        <SelfLearnMetric icon={<Clock3 />} label="Total turn p50" value={formatMs(totalInteraction?.p50_ms)} detail="recent voice interactions" />
        <SelfLearnMetric icon={<GitBranch />} label="Bottleneck" value={topBottleneck ?? "none"} detail="dominant recent stage" />
      </section>

      <section className="selfLearnGrid">
        <div className="selfLearnPanel selfLearnTimelinePanel">
          <div className="sectionHead">
            <div>
              <h2>Collected Interaction Data</h2>
              <p>Turns, live voice telemetry, flow events, feedback, and latency traces</p>
            </div>
            <span className="selfLearnLiveBadge">live</span>
          </div>
          <div className="selfLearnTimeline">
            {timeline.length === 0 ? (
              <div className="emptyState compact">
                <Activity size={22} />
                <p>No interaction data has been recorded yet.</p>
              </div>
            ) : (
              timeline.map((item) => (
                <article className={`selfLearnEvent ${item.tone}`} key={item.id}>
                  <div>
                    <span>{item.source}</span>
                    <strong>{item.event}</strong>
                  </div>
                  <p>{item.text}</p>
                  <small>
                    {formatTime(item.at)}
                    {item.meta ? ` · ${item.meta}` : ""}
                  </small>
                </article>
              ))
            )}
          </div>
        </div>

        <div className="selfLearnSideStack">
          <section className="selfLearnPanel">
            <div className="sectionHead">
              <div>
                <h2>Fixes Applied</h2>
                <p>Feedback and evals feeding the next prompt policy</p>
              </div>
              <CheckCircle2 size={18} />
            </div>
            <div className="fixList">
              {state?.recent_feedback.slice(0, 4).map((feedback) => (
                <article key={feedback.id}>
                  <span>{feedback.label} · {feedback.rating}/5</span>
                  <p>{feedback.turn_content || feedback.notes || "Feedback captured."}</p>
                  <small>{formatTime(feedback.created_at)} · {shortId(feedback.conversation_id)}</small>
                </article>
              ))}
              {(state?.recent_feedback.length ?? 0) === 0 && <p className="muted">No manual feedback has been applied yet.</p>}
            </div>
            <div className="learnedPolicy">
              <strong>Active learned policy</strong>
              {learnedLines.length === 0 ? (
                <p className="muted">No learned hints are active yet.</p>
              ) : (
                learnedLines.map((hint) => <span key={hint}>{hint}</span>)
              )}
            </div>
          </section>

          <section className="selfLearnPanel">
            <div className="sectionHead">
              <div>
                <h2>Proposed Next Fixes</h2>
                <p>What the learner would apply on the next rebuild</p>
              </div>
            </div>
            <div className="improvementList selfLearnHints">
              {proposedLines.length === 0 ? (
                <p className="muted">No proposed hints yet.</p>
              ) : (
                proposedLines.map((hint) => <span key={hint}>{hint}</span>)
              )}
            </div>
          </section>

          <section className="selfLearnPanel">
            <div className="sectionHead">
              <div>
                <h2>Latency Controller</h2>
                <p>Recent timing signals that should change behavior</p>
              </div>
            </div>
            <LatencyBreakdown state={state} latestTrace={latestTrace} />
          </section>
        </div>
      </section>
    </section>
  );
}

function SelfLearnMetric({ icon, label, value, detail }: { icon: JSX.Element; label: string; value: string; detail: string }) {
  return (
    <div className="metric selfLearnMetric">
      <span>{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <em>{detail}</em>
      </div>
    </div>
  );
}

function SessionPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="selfLearnSessionPill">
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function LatencyBreakdown({ state, latestTrace }: { state: SelfLearnState | null; latestTrace: LatencyTrace | null }) {
  const rows = [
    ["STT", "stt_after_speech_end_ms"],
    ["Turn finalization", "turn_finalization_ms"],
    ["LLM TTFB", "llm_ttfb_ms"],
    ["LLM total", "llm_total_ms"],
    ["TTS TTFB", "tts_ttfb_from_first_text_ms"],
    ["First audio", "speech_end_to_first_audio_ms"]
  ];

  return (
    <div className="latencyBreakdown">
      {rows.map(([label, key]) => {
        const summary = metricSummary(state, key);
        return (
          <div key={key}>
            <span>{label}</span>
            <strong>{formatMs(summary?.p50_ms)}</strong>
            <small>p95 {formatMs(summary?.p95_ms)}</small>
          </div>
        );
      })}
      <div className="latestTrace">
        <span>Latest trace</span>
        <strong>{latestTrace ? shortId(latestTrace.interaction_id) : "none"}</strong>
        <small>{latestTrace ? latestTrace.channel : "Waiting for voice telemetry"}</small>
      </div>
    </div>
  );
}

function buildTimeline(state: SelfLearnState | null): TimelineItem[] {
  if (!state) return [];
  const items: TimelineItem[] = [];

  for (const event of state.interaction_events) {
    items.push({
      id: `interaction-${event.id}`,
      at: event.created_at,
      source: event.transport.includes("webrtc") ? "Live voice" : event.channel,
      event: humanizeKey(event.event),
      text: event.text || summarizePayload(event.payload) || "Interaction event captured.",
      meta: `${event.role ?? "system"} · ${shortId(event.conversation_id)}`,
      tone: event.event.includes("interrupt") ? "fix" : "voice"
    });
  }

  for (const turn of state.recent_turns) {
    items.push({
      id: `turn-${turn.id}`,
      at: turn.created_at,
      source: turn.metrics.source === "local_pipecat" ? "Live voice" : "Conversation",
      event: `${turn.role} turn`,
      text: turn.content,
      meta: [shortId(turn.conversation_id), turn.latency_ms !== null ? `${turn.latency_ms} ms` : "", turn.model ?? ""]
        .filter(Boolean)
        .join(" · "),
      tone: turn.role === "assistant" ? "data" : "voice"
    });
  }

  for (const event of state.recent_flow_events) {
    items.push({
      id: `flow-${event.id}`,
      at: event.created_at,
      source: "Flow",
      event: humanizeKey(event.event),
      text: event.text || summarizePayload(event.payload) || `Node ${event.node_id ?? event.active_node_id}`,
      meta: `${event.status} · ${shortId(event.run_id)}`,
      tone: "flow"
    });
  }

  for (const feedback of state.recent_feedback) {
    items.push({
      id: `feedback-${feedback.id}`,
      at: feedback.created_at,
      source: "Fix",
      event: `${feedback.label} feedback`,
      text: feedback.turn_content || feedback.notes || "Prompt policy rebuilt from feedback.",
      meta: `${feedback.rating}/5 · ${shortId(feedback.conversation_id)}`,
      tone: "fix"
    });
  }

  for (const trace of state.latency_traces) {
    items.push({
      id: `latency-${trace.id}`,
      at: trace.created_at,
      source: "Latency",
      event: "trace recorded",
      text: `First audio ${formatTraceMs(trace, "speech_end_to_first_audio_ms")}; LLM TTFB ${formatTraceMs(trace, "llm_ttfb_ms")}.`,
      meta: `${trace.channel} · ${shortId(trace.conversation_id)}`,
      tone: "latency"
    });
  }

  return items.sort((a, b) => timestamp(b.at) - timestamp(a.at)).slice(0, 40);
}

function splitHints(value: string | undefined) {
  return (value ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
}

function metricSummary(state: SelfLearnState | null, key: string) {
  return state?.latency_summary.metrics[key] ?? null;
}

function topBottleneckName(state: SelfLearnState | null) {
  const entries = Object.entries(state?.latency_summary.bottleneck_counts ?? {});
  if (entries.length === 0) return null;
  return humanizeKey(entries.sort((a, b) => b[1] - a[1])[0][0]);
}

function formatMs(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return "-";
  return `${Math.round(value)} ms`;
}

function formatTraceMs(trace: LatencyTrace, key: string) {
  const value = trace.timings[key];
  return typeof value === "number" ? `${Math.round(value)} ms` : "-";
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function timestamp(value: string) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function summarizePayload(payload: Record<string, unknown>) {
  const keys = Object.keys(payload).filter((key) => !["conversation_id", "interaction_id", "timings", "providers"].includes(key));
  if (keys.length === 0) return "";
  return keys
    .slice(0, 3)
    .map((key) => `${key}: ${stringifyValue(payload[key])}`)
    .join(" · ");
}

function humanizeKey(value: string) {
  return value.replace(/_/g, " ");
}

function formatRequestError(error: unknown) {
  if (!(error instanceof Error)) return "Self-learn data failed to load.";
  try {
    const parsed = JSON.parse(error.message) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    return error.message;
  }
  return error.message;
}

function stringifyValue(value: unknown) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item(s)`;
  return "object";
}
