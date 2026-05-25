const baseUrl = process.env.BENCH_BASE_URL ?? "http://localhost:3000";
const prompt =
  process.env.BENCH_PROMPT ??
  "Explain how you would debug a failing calculator test. Keep it short.";
const ttsProvider = process.env.BENCH_TTS_PROVIDER ?? "browser";

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

async function benchChat() {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok || !response.body) throw new Error(`Chat failed: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt = null;
  let text = "";
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
        provider = event.data.provider ?? provider;
        model = event.data.model ?? model;
      }
      if (event.type === "token") {
        if (!firstTokenAt) firstTokenAt = performance.now();
        text += event.data.text ?? "";
      }
    }
  }

  return {
    provider,
    model,
    prompt,
    responseText: text.trim(),
    chars: text.length,
    firstTokenMs: firstTokenAt ? Math.round(firstTokenAt - startedAt) : null,
    totalChatMs: Math.round(performance.now() - startedAt),
  };
}

async function benchTts(text) {
  if (ttsProvider === "browser") {
    return {
      provider: "browser",
      note: "Browser speechSynthesis latency and voice quality must be measured in-browser.",
    };
  }

  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: ttsProvider,
      text,
      speed: 1,
    }),
  });

  const elapsed = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    return {
      provider: ttsProvider,
      ok: false,
      status: response.status,
      elapsedMs: elapsed,
      error: await response.text(),
    };
  }

  const audio = Buffer.from(await response.arrayBuffer());
  return {
    provider: ttsProvider,
    ok: true,
    status: response.status,
    contentType: response.headers.get("content-type"),
    serverMs: response.headers.get("x-tts-server-ms"),
    elapsedMs: elapsed,
    bytes: audio.length,
  };
}

async function main() {
  const health = await fetch(`${baseUrl}/api/providers/health?deep=1`).then((r) => r.json());
  const chat = await benchChat();
  const tts = await benchTts(chat.responseText.split(/(?<=[.!?])\s+/)[0] || chat.responseText);

  console.log(JSON.stringify({ health, chat, tts }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
