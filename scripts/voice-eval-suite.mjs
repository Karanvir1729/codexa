#!/usr/bin/env node

const baseUrl = process.env.VOICE_TEST_APP_URL ?? "http://localhost:3000";

function nowIso() {
  return new Date().toISOString();
}

function parseSse(raw) {
  let type = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { type, data: JSON.parse(data) };
}

async function postJson(path, data) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body.error || "unknown error"}`);
  return body;
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body.error || "unknown error"}`);
  return body;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readChatStream(messages, systemPrompt) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, systemPrompt }),
  });
  if (!response.ok || !response.body) throw new Error(`/api/chat returned ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let firstTokenMs = null;
  let provider = "unknown";
  let model = "unknown";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const raw of events) {
      const event = parseSse(raw);
      if (!event) continue;
      if (event.type === "meta") {
        provider = event.data.provider || provider;
        model = event.data.model || model;
      }
      if (event.type === "token") {
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
        text += event.data.text || "";
      }
      if (event.type === "error") {
        throw new Error(event.data.message || "chat stream returned error");
      }
    }
  }

  return {
    text: text.trim(),
    provider,
    model,
    firstTokenMs,
    totalMs: Math.round(performance.now() - startedAt),
  };
}

const cases = [
  {
    id: "provider-health",
    name: "Provider health exposes STT, LLM, speaker, TTS, and speech intent layers",
    async run() {
      const health = await getJson("/api/providers/health");
      assert(health.llm?.configuredProvider, "missing LLM provider");
      assert(health.stt?.configuredProvider, "missing STT provider");
      assert(health.speechIntent?.mode, "missing speech intent mode");
      assert(health.speechIntent?.pythonFlowUrl, "missing Python speech-flow URL");
      assert(health.speakerGuard?.configured, "speaker identity is not configured");
      return {
        llm: health.llm.configuredProvider,
        stt: health.stt.configuredProvider,
        speechIntent: health.speechIntent.deterministicRuntime,
        speakerTarget: health.speakerGuard.targetModel,
      };
    },
  },
  {
    id: "flow-formatting",
    name: "Flow-style formatter handles dictionary, snippets, Backtrack, and lists",
    async run() {
      const result = await postJson("/api/speech-intent", {
        rawText: "um explain derivitives first use a simple analogy second quiz me third meet at two actually three period",
        mode: "format",
        flow: {
          cleanupLevel: "high",
          writingStyle: "bullets",
          languageHint: "en-US",
          dictionary: [{ from: "derivitives", to: "derivatives", term: "derivatives", starred: true }],
          snippets: [{ trigger: "quiz me", text: "Ask me one short diagnostic question." }],
        },
      });
      assert(result.text.includes("derivatives"), "dictionary correction did not apply");
      assert(result.text.includes("Ask me one short diagnostic question"), "snippet did not expand");
      assert(!result.text.toLowerCase().includes("um"), "filler word remained");
      assert(!result.text.toLowerCase().includes("two actually three"), "Backtrack correction did not apply");
      assert(result.text.includes("- "), "spoken list was not formatted");
      return {
        text: result.text,
        provider: result.provider,
        runtime: result.flow?.runtime || "node-fallback",
      };
    },
  },
  {
    id: "speech-to-intent",
    name: "Speech-to-intent turns messy speech into a tutor-ready request",
    async run() {
      const result = await postJson("/api/speech-intent", {
        rawText:
          "uh okay so can you explain why this is hyper geometric and not binomial because there are two outcomes but no replacement and then quiz me",
        mode: "rewrite",
        flow: {
          cleanupLevel: "high",
          writingStyle: "tutor",
          dictionary: [{ from: "hyper geometric", to: "hypergeometric", term: "hypergeometric" }],
          snippets: [{ trigger: "quiz me", text: "Ask one short follow-up question to check understanding." }],
        },
      });
      assert(result.text.toLowerCase().includes("hypergeometric"), "concept was not preserved");
      assert(result.text.toLowerCase().includes("binomial"), "comparison concept was not preserved");
      assert(result.text.length >= 40, "cleaned intent is too short");
      return {
        text: result.text,
        mode: result.mode,
        provider: result.provider,
        durationMs: result.duration_ms,
      };
    },
  },
  {
    id: "chat-stream",
    name: "Tutor LLM streams a concise spoken answer",
    async run() {
      const result = await readChatStream(
        [{ role: "user", content: "Explain in two sentences why no replacement means hypergeometric, not binomial." }],
        "You are Tutor-Tron. Answer in two concise spoken sentences.",
      );
      assert(result.text.length > 20, "chat response was empty or too short");
      assert(result.firstTokenMs !== null, "no first token was observed");
      assert(result.totalMs < Number(process.env.VOICE_EVAL_CHAT_TIMEOUT_MS ?? 120000), "chat response exceeded timeout budget");
      return result;
    },
  },
  {
    id: "pwa-shell",
    name: "Installable iPhone/Mac PWA shell is served",
    async run() {
      const manifest = await getJson("/manifest.webmanifest");
      assert(manifest.display === "standalone", "manifest display must be standalone");
      assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, "manifest icons missing");
      const serviceWorker = await fetch(`${baseUrl}/sw.js`);
      assert(serviceWorker.ok, "service worker is not served");
      return {
        name: manifest.name,
        display: manifest.display,
        icons: manifest.icons.length,
      };
    },
  },
];

async function runCase(testCase) {
  const startedAt = performance.now();
  try {
    const details = await testCase.run();
    return {
      id: testCase.id,
      name: testCase.name,
      status: "passed",
      durationMs: Math.round(performance.now() - startedAt),
      details,
    };
  } catch (error) {
    return {
      id: testCase.id,
      name: testCase.name,
      status: "failed",
      durationMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const startedAt = performance.now();
  const results = [];
  for (const testCase of cases) {
    results.push(await runCase(testCase));
  }

  const summary = {
    total: results.length,
    passed: results.filter((result) => result.status === "passed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
  };
  const payload = {
    id: `voice-eval-${Date.now()}`,
    name: "Tutor-Tron deterministic voice eval suite",
    status: summary.failed ? "failed" : "passed",
    startedAt: nowIso(),
    durationMs: Math.round(performance.now() - startedAt),
    baseUrl,
    summary,
    cases: results,
  };

  console.log(JSON.stringify(payload, null, 2));
  if (summary.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
