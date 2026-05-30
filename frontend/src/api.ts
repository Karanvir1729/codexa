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
  voice_speech_path?: VoiceSpeechPath;
  voice_emotion_codes_enabled?: boolean;
  local_stt_provider?: string;
  local_tts_provider?: string;
  codex_orchestrator_enabled?: boolean;
  codex_orchestrator_base_url?: string;
  voice_mainstream_ready?: boolean;
  voice_mainstream_reasons?: string[];
  voice_mainstream?: {
    ready: boolean;
    reasons: string[];
    voice_speech_path: string;
    voice_runtime: string;
    configured_stt_provider: string;
    configured_stt_model: string;
    configured_tts_provider: string;
    configured_tts_language: string;
    codex_orchestrator_enabled: boolean;
  };
  prompt_version: number;
  reasoning_mode: string;
  cost_guard: CostGuard;
  cloud_vllm?: CloudVLLMState;
  twilio?: Partial<TwilioStatus> & {
    ready?: boolean;
    voice_mode?: string;
    voice_webhook_url?: string;
    signature_validation?: boolean;
  };
};

export type CloudVLLMState = {
  enabled: boolean;
  stop_on_idle_enabled: boolean;
  idle_shutdown_seconds: number;
  active_sessions: number;
  last_status: string | null;
  instance_name: string;
  zone: string;
  project_id: string | null;
  ip_mode: "configured" | "internal" | "external";
};

export type VoiceDependencyState = {
  provider: string;
  healthy: boolean | null;
  health_url?: string;
  error?: string;
};

export type VoicePreflight = {
  ready: boolean;
  reasons: string[];
  warnings: string[];
  llm_endpoint_healthy: boolean | null;
  dependencies: {
    stt: VoiceDependencyState;
    tts: VoiceDependencyState;
    codex?: VoiceDependencyState;
  };
  voice_runtime: string;
  voice_speech_path: VoiceSpeechPath;
  llm_provider: string;
  model: string;
  cloud_vllm: CloudVLLMState;
};

export type VoiceSpeechPath = "nvidia_gradium";
export type VoiceInputMode = "vad" | "push_to_talk";
export type VoiceRuntimeProfile = {
  profile_version: number;
  active_model_profile: "fast" | "balanced" | "reasoning";
  input_mode: VoiceInputMode;
  llm: Record<string, unknown>;
  tts: Record<string, unknown>;
  latency: Record<string, unknown>;
  turn_taking: Record<string, unknown>;
  quality: Record<string, unknown>;
  response?: Record<string, unknown>;
  debug?: Record<string, unknown>;
  last_profile_change?: Record<string, unknown> | null;
  last_turn?: Record<string, unknown> | null;
};
export type VoiceLearningLog = {
  created_at: string;
  record: Record<string, unknown>;
};
export type VoiceRuntimeProfileResponse = {
  profile: VoiceRuntimeProfile;
  recent_learning_logs: VoiceLearningLog[];
};

export type VoiceTextTurnResponse = {
  conversation_id: string;
  interaction_id: string;
  user_turn_id: string;
  assistant_turn_id: string;
  message: string;
  latency_ms: number;
  model: string;
  provider: string;
  prompt_version: number;
  mode: "assistant" | "flow";
  input: {
    text: string;
    assumed_stt: boolean;
    input_mode: VoiceInputMode;
    force_interrupt: boolean;
  };
  tts: {
    simulated: boolean;
    provider: string;
    clean_text: string;
    rendered_text: string;
    params: Record<string, unknown>;
    expression_tags_used: string[];
    unsupported_expression_tags: string[];
  };
  runtime_actions: Array<Record<string, unknown>>;
  runtime_action_status: Array<Record<string, unknown>>;
  codex?: Record<string, unknown>;
  flow: FlowSimulationResponse | null;
  providers: Record<string, unknown>;
  timings: Record<string, unknown>;
  latency_trace_id: string;
  events_recorded: string[];
  learning_failures: string[];
  runtime_profile: Record<string, unknown>;
  cost_guard: CostGuard;
};

export type VoiceCodexStatusResponse = {
  conversation_id: string;
  message: string;
  codex: Record<string, unknown>;
  raw: Record<string, unknown>;
  flowchart?: {
    status: string;
    generated_at?: string;
    nodes: Array<{
      id: string;
      type?: string;
      label?: string;
      status?: string;
      visual_state?: string;
      badges?: string[];
      summary?: string;
      detail?: Record<string, unknown>;
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      label?: string | null;
    }>;
  };
};

export type TwilioCallLogTurn = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  latency_ms: number | null;
  model: string | null;
  metrics: Record<string, unknown>;
  created_at: string;
};

export type TwilioCallLog = {
  conversation_id: string;
  call_sid: string | null;
  caller: string | null;
  to: string | null;
  voice_mode: string | null;
  status: string;
  duration_seconds: string | number | null;
  started_at: string;
  updated_at: string;
  last_message: string;
  codex?: Record<string, unknown>;
  turns: TwilioCallLogTurn[];
};

export type TwilioStatus = {
  ready: boolean;
  account_sid_configured: boolean;
  auth_token_configured: boolean;
  from_number_configured: boolean;
  phone_number: string | null;
  phone_number_sid_configured: boolean;
  voice_mode: string;
  voice_webhook_url: string;
  status_callback_url: string;
  signature_validation: boolean;
};

export type TwilioCallLogsResponse = {
  calls: TwilioCallLog[];
  generated_at: string;
};

export type VoiceTextSuiteCheck = {
  name: string;
  passed: boolean;
  detail?: string;
};

export type VoiceTextSuiteCaseResult = {
  id: string;
  message: string;
  voice_behavior_mode: "assistant" | "flow";
  passed: boolean;
  checks: VoiceTextSuiteCheck[];
  turn: VoiceTextTurnResponse;
};

export type VoiceTextSuiteResponse = {
  conversation_id: string;
  status: "passed" | "failed";
  passed: boolean;
  summary: {
    passed: number;
    failed: number;
    total: number;
  };
  cases: VoiceTextSuiteCaseResult[];
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
  config?: SelfLearnConfig;
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

export type SelfLearnConfig = {
  enabled: boolean;
  factor: number;
};

export type InteractionEvent = {
  id: string;
  conversation_id: string;
  interaction_id: string;
  channel: string;
  transport: string;
  event: string;
  role: string | null;
  text: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type LatencyTrace = {
  id: string;
  conversation_id: string;
  interaction_id: string;
  channel: string;
  transport: string;
  user_turn_id: string | null;
  assistant_turn_id: string | null;
  providers: Record<string, unknown>;
  timings: Record<string, unknown>;
  created_at: string;
};

export type LatencyMetricSummary = {
  count: number;
  min_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
};

export type LatencySummary = {
  count: number;
  latency_target_ms: number;
  target_breaches: number;
  runtime_config: Record<string, unknown>;
  providers_latest: Record<string, unknown>;
  bottleneck_counts: Record<string, number>;
  metrics: Record<string, LatencyMetricSummary>;
};

export type SelfLearnTurn = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  latency_ms: number | null;
  model: string | null;
  prompt_version: number | null;
  metrics: Record<string, unknown>;
  created_at: string;
};

export type SelfLearnFeedback = {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  rating: number;
  label: string;
  notes: string | null;
  turn_role: string | null;
  turn_content: string | null;
  turn_prompt_version: number | null;
  created_at: string;
};

export type PromptVersionRecord = {
  version: number;
  system_prompt: string;
  learned_hints: string;
  source: string;
  active: boolean;
  created_at: string;
};

export type SelfLearnFlowEvent = {
  id: string;
  run_id: string;
  flow_id: string;
  conversation_id: string | null;
  node_id: string | null;
  active_node_id: string;
  status: string;
  event: string;
  role: string | null;
  text: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export type SelfLearnFlowRun = {
  id: string;
  flow_id: string;
  conversation_id: string | null;
  active_node_id: string;
  slots: Record<string, unknown>;
  transcript: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    latency_ms?: number;
    created_at: number;
  }>;
  status: string;
  created_at: string;
  updated_at: string;
};

export type SelfLearnState = {
  generated_at: string;
  conversation_id: string | null;
  config: SelfLearnConfig;
  active_prompt_version: number;
  learned_hints: string;
  proposed_hints: string[];
  feedback_summary: AutoImprovementState["feedback_summary"];
  recent_eval_results: AutoImprovementState["recent_eval_results"];
  recent_turns: SelfLearnTurn[];
  recent_feedback: SelfLearnFeedback[];
  recent_prompt_versions: PromptVersionRecord[];
  recent_flow_events: SelfLearnFlowEvent[];
  recent_flow_runs: SelfLearnFlowRun[];
  interaction_events: InteractionEvent[];
  latency_traces: LatencyTrace[];
  latency_summary: LatencySummary;
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
  conversation_id?: string | null;
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

export const API_BASE = configuredApiBase;

export function apiUrl(path: string) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

function responseErrorMessage(text: string, fallback: string) {
  const trimmed = text.trim();
  if (!trimmed) return fallback;
  if (/^<!doctype html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return fallback;
  }
  return trimmed;
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
    let detail: unknown;
    try {
      const payload = JSON.parse(text) as { detail?: unknown };
      detail = payload.detail;
    } catch {
      detail = null;
    }
    if (typeof detail === "string") {
      throw new Error(detail);
    }
    throw new Error(responseErrorMessage(text, response.statusText));
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

export function getSelfLearn(params?: { limit?: number; conversationId?: string }) {
  const query = new URLSearchParams();
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.conversationId) query.set("conversation_id", params.conversationId);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request<SelfLearnState>(`/api/self-learn${suffix}`);
}

export function updateSelfLearnConfig(payload: Partial<SelfLearnConfig>) {
  return request<{ config: SelfLearnConfig }>("/api/self-learn/config", {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function getCost() {
  return request<{ cost_guard: CostGuard }>("/api/cost");
}

export function getWebRTCIceConfig() {
  return request<WebRTCIceConfig>("/api/webrtc/ice-config");
}

export function getVoicePreflight(voiceSpeechPath?: VoiceSpeechPath) {
  const suffix = voiceSpeechPath ? `?voice_speech_path=${encodeURIComponent(voiceSpeechPath)}` : "";
  return request<VoicePreflight>(`/api/voice/preflight${suffix}`);
}

export function getVoiceRuntimeProfile() {
  return request<VoiceRuntimeProfileResponse>("/api/voice/runtime-profile");
}

export function prepareVoice(voiceSpeechPath?: VoiceSpeechPath) {
  return request<{
    ready: boolean;
    llm_endpoint_healthy: boolean | null;
    dependencies: {
      stt: VoiceDependencyState;
      tts: VoiceDependencyState;
      codex?: VoiceDependencyState;
    };
    voice_speech_path: VoiceSpeechPath;
    cloud_vllm: CloudVLLMState;
  }>("/api/voice/prepare", {
    method: "POST",
    body: JSON.stringify({ voice_speech_path: voiceSpeechPath })
  });
}

export function runVoiceTextTurn(payload: {
  message: string;
  conversation_id?: string;
  voice_behavior_mode?: "assistant" | "flow";
  voice_flow_id?: string;
  voice_speech_path?: VoiceSpeechPath;
  input_mode?: VoiceInputMode;
  force_interrupt?: boolean;
}) {
  return request<VoiceTextTurnResponse>("/api/voice/text-test/turn", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getVoiceCodexOrchestratorStatus(conversationId: string) {
  return request<VoiceCodexStatusResponse>(
    `/api/voice/codex-orchestrator/status?conversation_id=${encodeURIComponent(conversationId)}`
  );
}

export function getTwilioCallLogs(limit = 8) {
  return request<TwilioCallLogsResponse>(`/api/twilio/call-logs?limit=${encodeURIComponent(String(limit))}`);
}

export function getTwilioStatus() {
  return request<TwilioStatus>("/api/twilio/status");
}

export async function synthesizeVoiceTextAudio(payload: {
  text: string;
  voice_speech_path?: VoiceSpeechPath;
  user_text?: string;
}) {
  const response = await fetch(apiUrl("/api/voice/text-test/audio"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text();
    let detail: unknown;
    try {
      detail = (JSON.parse(text) as { detail?: unknown }).detail;
    } catch {
      detail = null;
    }
    throw new Error(typeof detail === "string" ? detail : responseErrorMessage(text, response.statusText));
  }
  return response.blob();
}

export function runVoiceTextSuite(payload: {
  conversation_id?: string;
  voice_behavior_mode?: "assistant" | "flow";
  voice_flow_id?: string;
  voice_speech_path?: VoiceSpeechPath;
  input_mode?: VoiceInputMode;
}) {
  return request<VoiceTextSuiteResponse>("/api/voice/text-test/run", {
    method: "POST",
    body: JSON.stringify(payload)
  });
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
