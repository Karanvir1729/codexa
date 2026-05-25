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

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
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

export function getCost() {
  return request<{ cost_guard: CostGuard }>("/api/cost");
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
    results: Array<{ case_id: string; score: number; passed: boolean; latency_ms: number }>;
  }>("/api/evals/run", {
    method: "POST",
    body: JSON.stringify({ suite_path: "backend/evals/customer_intake.yml", apply_feedback: true })
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
