import { useEffect, useMemo, useState, type PointerEvent } from "react";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.js";
import Mic2 from "lucide-react/dist/esm/icons/mic-2.js";
import PanelRight from "lucide-react/dist/esm/icons/panel-right.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Radio from "lucide-react/dist/esm/icons/radio.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import SquareFunction from "lucide-react/dist/esm/icons/square-function.js";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import UploadCloud from "lucide-react/dist/esm/icons/upload-cloud.js";
import Volume2 from "lucide-react/dist/esm/icons/volume-2.js";
import Wand2 from "lucide-react/dist/esm/icons/wand-2.js";
import {
  FlowDefinition,
  FlowGraph,
  FlowSimulationResponse,
  FlowValidation,
  getActiveFlow,
  publishFlow,
  saveFlow,
  simulateFlow,
  validateFlow
} from "./api";

type VoiceNodeData = {
  label: string;
  nodeType: string;
  purpose?: string;
  prompt?: string;
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
  listen?: {
    silenceTimeoutMs?: number;
    retryLimit?: number;
    expected?: string[];
    slots?: Array<Record<string, unknown>>;
  };
  llm?: {
    mode?: string;
    temperature?: number;
    maxTokens?: number;
  };
  interrupt?: {
    enabled?: boolean;
    stopSpeaking?: boolean;
    routes?: Array<Record<string, unknown>>;
  };
  fallback?: Record<string, unknown>;
  codex?: Record<string, unknown>;
  guardrail?: Record<string, unknown>;
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
  onNotice?: (message: string) => void;
};

const palette = [
  { type: "start", label: "Start", icon: Radio },
  { type: "say", label: "Say", icon: Volume2 },
  { type: "listen", label: "Listen", icon: Mic2 },
  { type: "intent_router", label: "Intent", icon: GitBranch },
  { type: "condition", label: "Condition", icon: GitBranch },
  { type: "llm_step", label: "LLM", icon: Bot },
  { type: "tool", label: "Tool", icon: SquareFunction },
  { type: "codex_task", label: "Codex", icon: Wand2 },
  { type: "set_state", label: "State", icon: PanelRight },
  { type: "guardrail", label: "Guard", icon: ShieldCheck },
  { type: "wait", label: "Wait", icon: Radio },
  { type: "fallback", label: "Fallback", icon: TriangleAlert },
  { type: "handoff", label: "Handoff", icon: UploadCloud },
  { type: "end", label: "End", icon: CheckCircle2 }
];

const latencyProfiles = ["instant", "fast", "balanced", "quality", "async"];
const tones = ["neutral", "calm", "confident", "friendly", "concise", "careful"];

export function FlowStudio({ onNotice }: FlowStudioProps) {
  return <FlowStudioInner onNotice={onNotice} />;
}

function FlowStudioInner({ onNotice }: FlowStudioProps) {
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
  const [dragState, setDragState] = useState<{
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  const graph = useMemo<FlowGraph>(
    () => ({
      nodes: nodes.map((node) => ({
        ...node,
        selected: undefined,
        dragging: undefined
      })) as unknown as Array<Record<string, unknown>>,
      edges: edges as unknown as Array<Record<string, unknown>>,
      metadata: {
        schemaVersion: 1,
        alwaysListening: true,
        runtime: "pipecat-compatible-flow"
      }
    }),
    [edges, nodes]
  );

  useEffect(() => {
    getActiveFlow()
      .then(({ flow: active }) => {
        setFlow(active);
        setNodes(toNodes(active.graph));
        setEdges(toEdges(active.graph));
        setValidation(active.validation);
      })
      .catch((error) => onNotice?.(error instanceof Error ? error.message : "Failed to load flow"));
  }, [onNotice]);

  useEffect(() => {
    if (!validation && flow?.validation) {
      setValidation(flow.validation);
    }
  }, [flow, validation]);

  function addNode(nodeType: string) {
    const id = `${nodeType}_${Math.random().toString(36).slice(2, 8)}`;
    const next: VoiceNode = {
      id,
      type: "flowNode",
      position: { x: 80 + nodes.length * 24, y: 80 + nodes.length * 18 },
      data: defaultNodeData(nodeType)
    };
    setNodes((current) => [...current, next]);
    setSelectedNodeId(id);
    setDirty(true);
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>, node: VoiceNode) {
    if (event.button !== 0) return;
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

  function updateDrag(event: PointerEvent<HTMLDivElement>) {
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
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
  }

  function endDrag() {
    setDragState(null);
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
        label: label || "next",
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

  async function startSimulation() {
    if (!flow) return;
    setBusy(true);
    try {
      const result = await simulateFlow({ flowId: flow.id });
      setRun(result);
      setSelectedNodeId(result.active_node_id);
      onNotice?.("Started flow simulation.");
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
      const result = await simulateFlow({
        flowId: flow.id,
        runId: run?.run_id,
        message: simInput,
        forceInterrupt
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
  const decoratedNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        className: [
          node.id === activeNodeId ? "activeRuntimeNode" : "",
          node.id === selectedNodeId ? "selectedRuntimeNode" : ""
        ]
          .filter(Boolean)
          .join(" ")
      })),
    [activeNodeId, nodes, selectedNodeId]
  );

  return (
    <section className="flowStudio">
      <header className="flowTopbar">
        <div>
          <p className="eyebrow">Realtime voice flow studio</p>
          <h1>{flow?.name ?? "Loading flow"}</h1>
          <p className="flowSubtitle">
            Always-on listening, barge-in routing, node-scoped LLM behavior, voice controls,
            latency profiles, guardrails, and Codex Orchestrator handoff.
          </p>
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
            <strong>Nodes</strong>
            <span>{palette.length} types</span>
          </div>
          <div className="nodePaletteGrid">
            {palette.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.type} onClick={() => addNode(item.type)}>
                  <Icon size={15} />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="studioPanelHead compact">
            <strong>Validation</strong>
            <span>{validation?.ok ? "ready" : "needs work"}</span>
          </div>
          <ValidationPanel validation={validation} />
        </aside>

        <div className="flowCanvas" onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <svg className="flowEdges" width="1800" height="980" viewBox="-860 -500 2200 1100">
            {edges.map((edge) => {
              const source = nodes.find((node) => node.id === edge.source);
              const target = nodes.find((node) => node.id === edge.target);
              if (!source || !target) return null;
              const path = edgePath(source, target);
              return (
                <g key={edge.id}>
                  <path d={path} />
                  <text x={(source.position.x + target.position.x) / 2 + 80} y={(source.position.y + target.position.y) / 2 + 16}>
                    {edge.label}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="flowNodesLayer">
            {decoratedNodes.map((node) => (
              <FlowNode
                key={node.id}
                node={node}
                selected={node.id === selectedNodeId}
                onPointerDown={beginDrag}
              />
            ))}
          </div>
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
            <strong>Live Simulator</strong>
            <span>
              {run ? `${run.status} · node ${run.active_node_id}` : "No simulation running"}
            </span>
          </div>
          <button onClick={startSimulation} disabled={busy || !flow}>
            <Play size={16} /> Start
          </button>
        </div>

        <div className="flowTranscript">
          {(run?.transcript ?? []).length === 0 ? (
            <p className="muted">Start the simulator to hear the entry node, then talk over it with Interrupt enabled.</p>
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
            Interrupt current speech
          </label>
          <input
            value={simInput}
            onChange={(event) => setSimInput(event.target.value)}
            placeholder="Say something to the active node"
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
  onPointerDown
}: {
  node: VoiceNode;
  selected: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>, node: VoiceNode) => void;
}) {
  const { data } = node;
  const nodeClass = `flowNodeCard ${data.nodeType} ${selected ? "selected" : ""}`;
  return (
    <div
      className={`${nodeClass} ${node.className ?? ""}`}
      style={{ transform: `translate(${node.position.x + 860}px, ${node.position.y + 500}px)` }}
      onPointerDown={(event) => onPointerDown(event, node)}
    >
      <div className="flowNodeTop">
        <span>{data.nodeType}</span>
        {data.voice?.allowBargeIn && <Mic2 size={14} />}
      </div>
      <strong>{data.label}</strong>
      <p>{data.purpose || data.prompt || "No purpose set"}</p>
      <div className="flowNodeMeta">
        <small>{data.latency?.profile ?? "fast"}</small>
        <small>{data.voice?.tone ?? "calm"}</small>
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
  const [edgeLabel, setEdgeLabel] = useState("next");

  if (!node) {
    return (
      <div className="emptyInspector">
        <PanelRight size={22} />
        <p>Select a node to edit prompt, voice, latency, interruption, and runtime settings.</p>
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
        <select value={data.nodeType} onChange={(event) => onChange({ nodeType: event.target.value })}>
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

      <Field label="Prompt / Script">
        <textarea
          value={data.prompt ?? ""}
          onChange={(event) => onChange({ prompt: event.target.value })}
          rows={5}
        />
      </Field>

      <div className="inspectorGroup">
        <h3>Outgoing Edges</h3>
        <div className="edgeEditor">
          {edges.map((edge) => (
            <div className="edgeEditorRow" key={edge.id}>
              <input
                value={edge.label ?? ""}
                onChange={(event) => onUpdateEdge(edge.id, { label: event.target.value })}
                aria-label="Edge label"
              />
              <select
                value={edge.target}
                onChange={(event) => onUpdateEdge(edge.id, { target: event.target.value })}
                aria-label="Edge target"
              >
                {nodes.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.data.label}
                  </option>
                ))}
              </select>
              <button onClick={() => onDeleteEdge(edge.id)}>Remove</button>
            </div>
          ))}
          <div className="edgeEditorRow">
            <input
              value={edgeLabel}
              onChange={(event) => setEdgeLabel(event.target.value)}
              placeholder="label"
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
                setEdgeLabel("next");
              }}
            >
              Add
            </button>
          </div>
        </div>
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
        <Field label="Language">
          <input
            value={data.voice?.language ?? "en"}
            onChange={(event) => onNestedChange("voice", { language: event.target.value })}
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
        <h3>Listening</h3>
        <Field label="Expected phrases">
          <textarea
            value={(data.listen?.expected ?? []).join(", ")}
            onChange={(event) =>
              onNestedChange("listen", {
                expected: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              })
            }
            rows={3}
          />
        </Field>
        <Field label="Silence timeout ms">
          <input
            type="number"
            min="100"
            value={data.listen?.silenceTimeoutMs ?? 700}
            onChange={(event) =>
              onNestedChange("listen", { silenceTimeoutMs: Number(event.target.value) })
            }
          />
        </Field>
        <Field label="Retry limit">
          <input
            type="number"
            min="0"
            value={data.listen?.retryLimit ?? 2}
            onChange={(event) => onNestedChange("listen", { retryLimit: Number(event.target.value) })}
          />
        </Field>
      </div>

      <div className="inspectorGroup">
        <h3>LLM</h3>
        <Field label="Mode">
          <input
            value={data.llm?.mode ?? "constrained"}
            onChange={(event) => onNestedChange("llm", { mode: event.target.value })}
          />
        </Field>
        <Field label="Temperature">
          <input
            type="number"
            step="0.1"
            min="0"
            max="1"
            value={data.llm?.temperature ?? 0}
            onChange={(event) => onNestedChange("llm", { temperature: Number(event.target.value) })}
          />
        </Field>
        <Field label="Max tokens">
          <input
            type="number"
            min="8"
            value={data.llm?.maxTokens ?? 40}
            onChange={(event) => onNestedChange("llm", { maxTokens: Number(event.target.value) })}
          />
        </Field>
      </div>

      <div className="inspectorGroup">
        <h3>Interruptions</h3>
        <label className="inlineCheck">
          <input
            type="checkbox"
            checked={Boolean(data.interrupt?.enabled)}
            onChange={(event) => onNestedChange("interrupt", { enabled: event.target.checked })}
          />
          Enabled
        </label>
        <label className="inlineCheck">
          <input
            type="checkbox"
            checked={Boolean(data.interrupt?.stopSpeaking)}
            onChange={(event) => onNestedChange("interrupt", { stopSpeaking: event.target.checked })}
          />
          Stop current speech
        </label>
      </div>

      <div className="inspectorGroup">
        <h3>Raw Runtime JSON</h3>
        <textarea
          value={JSON.stringify(
            {
              fallback: data.fallback ?? {},
              codex: data.codex ?? {},
              guardrail: data.guardrail ?? {}
            },
            null,
            2
          )}
          onChange={(event) => {
            try {
              const parsed = JSON.parse(event.target.value) as {
                fallback?: Record<string, unknown>;
                codex?: Record<string, unknown>;
                guardrail?: Record<string, unknown>;
              };
              onChange({
                fallback: parsed.fallback ?? data.fallback,
                codex: parsed.codex ?? data.codex,
                guardrail: parsed.guardrail ?? data.guardrail
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
          {validation.node_count} nodes · {validation.edge_count} edges
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
      x: typeof record.x === "number" ? record.x : 0,
      y: typeof record.y === "number" ? record.y : 0
    };
  }
  return { x: 0, y: 0 };
}

function normalizeNodeData(value: unknown): VoiceNodeData {
  const data = (typeof value === "object" && value !== null ? value : {}) as Partial<VoiceNodeData>;
  const nodeType = typeof data.nodeType === "string" ? data.nodeType : "llm_step";
  const label = typeof data.label === "string" ? data.label : "Untitled";
  return {
    ...defaultNodeData(nodeType),
    ...data,
    label,
    nodeType
  };
}

function defaultNodeData(nodeType: string): VoiceNodeData {
  return {
    label: titleFromType(nodeType),
    nodeType,
    purpose: "Describe what this state controls.",
    prompt: defaultPrompt(nodeType),
    voice: {
      voiceId: "af_heart",
      tone: "calm",
      speed: 1,
      language: "en",
      allowBargeIn: nodeType !== "end"
    },
    latency: {
      profile: nodeType === "codex_task" ? "async" : nodeType === "start" ? "instant" : "fast",
      targetMs: nodeType === "codex_task" ? 1200 : 800
    },
    listen: {
      silenceTimeoutMs: 700,
      retryLimit: 2,
      expected: []
    },
    llm: {
      mode: "constrained",
      temperature: 0,
      maxTokens: 40
    },
    interrupt: {
      enabled: nodeType !== "end",
      stopSpeaking: true,
      routes: [{ intent: "any", target: "interrupt_router" }]
    },
    fallback: {
      noInput: "repair",
      lowConfidence: "repair",
      toolError: "repair"
    }
  };
}

function titleFromType(nodeType: string) {
  return nodeType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function defaultPrompt(nodeType: string) {
  if (nodeType === "start") return "";
  if (nodeType === "say") return "I'm here. Tell me what you want to do.";
  if (nodeType === "listen") return "What should I listen for?";
  if (nodeType === "intent_router") return "Classify the user's next intent.";
  if (nodeType === "guardrail") return "Should I proceed?";
  if (nodeType === "codex_task") return "I'll hand this to Codex Orchestrator and keep you updated.";
  if (nodeType === "handoff") return "A human agent can help. I can hand you off now.";
  if (nodeType === "end") return "Done. I saved the session notes.";
  return "Reply in one short sentence inside this node's scope.";
}

function edgePath(source: VoiceNode, target: VoiceNode) {
  const startX = source.position.x + 230;
  const startY = source.position.y + 76;
  const endX = target.position.x;
  const endY = target.position.y + 76;
  const mid = Math.max(80, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`;
}
