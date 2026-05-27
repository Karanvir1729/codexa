export type CostGuard = {
  enabled: boolean;
  cap_usd: number;
  used_usd: number;
  remaining_usd: number;
  reserved_usd: number;
  actual_usd: number;
};

export type Health = {
  status: string;
  environment: string;
  llm_provider: string;
  model: string;
  voice_runtime: string;
  voice_behavior_mode?: "assistant" | "flow";
  voice_flow_id?: string;
  voice_emotion_codes_enabled?: boolean;
  local_stt_provider?: string;
  local_tts_provider?: string;
  prompt_version: number;
  reasoning_mode: string;
  cost_guard: CostGuard;
};

export type ChatResponse = {
  conversation_id: string;
  user_turn_id: string;
  assistant_turn_id: string;
  message: string;
  latency_ms: number;
  model: string;
  provider: string;
  prompt_version: number;
  cost_guard: CostGuard;
};

export type PromptState = {
  version: number;
  system_prompt: string;
  learned_hints: string;
  compiled: string;
};

export type EvalSchedulerState = {
  running: boolean;
  suite_path: string;
  interval_seconds: number;
  apply_feedback: boolean;
  run_count: number;
  last_run: null | {
    run_id: string;
    status: string;
    aggregate_score: number;
    ran_at: string;
  };
  last_error: string | null;
  next_run_at: string | null;
};

export type AutoImprovementState = {
  active_prompt_version: number;
  learned_hints: string;
  proposed_hints: string[];
  feedback_summary: Array<{
    label: string;
    avg_rating: number | null;
    count: number;
  }>;
  recent_eval_results: Array<{
    case_id: string;
    score: number;
    passed: boolean;
    latency_ms: number | null;
    failed_checks: string[];
    created_at: string;
  }>;
};

export type WebRTCIceConfig = {
  iceServers: RTCIceServer[];
};

export type FlowValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  node_count: number;
  edge_count: number;
};

export type FlowSummary = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "published" | "archived";
  version: number;
  node_count: number;
  edge_count: number;
  validation: FlowValidation;
  updated_at: string;
  published_at: string | null;
};

export type FlowDefinition = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "published" | "archived";
  version: number;
  graph: FlowGraph;
  published_graph: FlowGraph | null;
  validation: FlowValidation;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

export type FlowGraph = {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  viewport?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type FlowSimulationMessage = {
  id: string;
  role: "assistant";
  node_id: string;
  text: string;
  latency_ms?: number;
  voice?: {
    tone?: string;
    speed?: number;
    language?: string;
    allowBargeIn?: boolean;
  };
};

export type FlowSimulationResponse = {
  run_id: string;
  flow_id: string;
  flow_version: number;
  status: "active" | "completed" | "failed";
  active_node_id: string;
  active_node: Record<string, unknown> | null;
  slots: Record<string, unknown>;
  transcript: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    latency_ms?: number;
    created_at: number;
  }>;
  messages: FlowSimulationMessage[];
  error: string | null;
};

const configuredApiBase = import.meta.env.VITE_API_BASE?.trim() ?? "";
const localDevApiBase =
  import.meta.env.DEV &&
  typeof window !== "undefined" &&
  ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname) &&
  window.location.port.startsWith("517")
    ? "http://localhost:8000"
    : "";

export const API_BASE = configuredApiBase || localDevApiBase;

export function apiUrl(path: string) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

export function getHealth() {
  return request<Health>("/health");
}

export function getPrompt() {
  return request<PromptState>("/api/prompt");
}

export function getAutoImprovement() {
  return request<AutoImprovementState>("/api/auto-improvement");
}

export function getCost() {
  return request<{ cost_guard: CostGuard }>("/api/cost");
}

export function getWebRTCIceConfig() {
  return request<WebRTCIceConfig>("/api/webrtc/ice-config");
}

export function sendMessage(message: string, conversationId?: string) {
  return request<ChatResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ message, conversation_id: conversationId, channel: "web" })
  });
}

export function sendFeedback(payload: {
  conversation_id: string;
  turn_id?: string;
  rating: number;
  label: string;
  notes?: string;
}) {
  return request<{ feedback_id: string; active_prompt_version: number }>("/api/feedback", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runEval() {
  return request<{
    run_id: string;
    status: string;
    aggregate_score: number;
    prompt_version: number | null;
    improvement_hints: string[];
    results: Array<{ case_id: string; score: number; passed: boolean; latency_ms: number }>;
  }>("/api/evals/run", {
    method: "POST",
    body: JSON.stringify({ suite_path: "backend/evals/conversational_voice.yml", apply_feedback: true })
  });
}

export function getEvalScheduler() {
  return request<EvalSchedulerState>("/api/evals/scheduler");
}

export function startEvalScheduler(intervalSeconds = 300) {
  return request<EvalSchedulerState>("/api/evals/scheduler/start", {
    method: "POST",
    body: JSON.stringify({ interval_seconds: intervalSeconds })
  });
}

export function stopEvalScheduler() {
  return request<EvalSchedulerState>("/api/evals/scheduler/stop", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function listEvalRuns() {
  return request<{
    runs: Array<{
      id: string;
      suite: string;
      status: string;
      started_at: string;
      aggregate_score: number;
    }>;
  }>("/api/evals/runs");
}

export function listFlows() {
  return request<{ flows: FlowSummary[] }>("/api/flows");
}

export function getActiveFlow() {
  return request<{ flow: FlowDefinition }>("/api/flows/active");
}

export function getFlow(flowId: string) {
  return request<{ flow: FlowDefinition }>(`/api/flows/${flowId}`);
}

export function saveFlow(payload: {
  id: string;
  name: string;
  description: string;
  graph: FlowGraph;
}) {
  return request<{ flow: FlowDefinition }>(`/api/flows/${payload.id}`, {
    method: "PUT",
    body: JSON.stringify({
      name: payload.name,
      description: payload.description,
      graph: payload.graph
    })
  });
}

export function publishFlow(flowId: string) {
  return request<{ flow: FlowDefinition }>(`/api/flows/${flowId}/publish`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function validateFlow(graph: FlowGraph) {
  return request<{ validation: FlowValidation }>("/api/flows/validate", {
    method: "POST",
    body: JSON.stringify({ graph })
  });
}

export function simulateFlow(payload: {
  flowId: string;
  runId?: string;
  message?: string;
  forceInterrupt?: boolean;
  conversationId?: string;
}) {
  return request<FlowSimulationResponse>(`/api/flows/${payload.flowId}/simulate`, {
    method: "POST",
    body: JSON.stringify({
      run_id: payload.runId,
      message: payload.message,
      force_interrupt: payload.forceInterrupt ?? false,
      conversation_id: payload.conversationId
    })
  });
}

export function getFlowRunByConversation(conversationId: string) {
  return request<{ run: FlowSimulationResponse | null }>(
    `/api/flows/runs/by-conversation/${encodeURIComponent(conversationId)}`
  );
}
