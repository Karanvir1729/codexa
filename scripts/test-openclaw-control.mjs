#!/usr/bin/env node

function parseSse(payload) {
  const events = [];
  for (const block of payload.split(/\n\n+/)) {
    let type = "message";
    let data = "";
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("event:")) type = line.slice("event:".length).trim();
      if (line.startsWith("data:")) data += line.slice("data:".length).trim();
    }
    if (!data) continue;
    try {
      events.push({ type, data: JSON.parse(data) });
    } catch {
      events.push({ type, data });
    }
  }
  return events;
}

async function main() {
  const baseUrl = process.env.VOICE_TEST_APP_URL || "http://localhost:3000";
  const expectText = "openclaw controls codex ready";
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/codex/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      controlProvider: "openclaw",
      systemPrompt: "You are a concise voice system-control smoke test.",
      messages: [
        {
          role: "user",
          content: `Say exactly: ${expectText}`,
        },
      ],
      client: {
        session_id: "openclaw_smoke",
        session_title: "OpenClaw smoke",
        project_name: "Agentic Coding Assistant",
        user_id: "test",
        user_name: "Test",
        control_provider: "openclaw",
      },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenClaw control endpoint returned ${response.status}: ${raw.slice(0, 500)}`);

  const events = parseSse(raw);
  const text = events
    .filter((event) => event.type === "token")
    .map((event) => event.data?.text || "")
    .join("")
    .trim();
  const ok = text.toLowerCase().includes(expectText);
  console.log(`${ok ? "PASS" : "FAIL"} OpenClaw control endpoint: ${Math.round(performance.now() - startedAt)} ms`);
  console.log(`response_excerpt=${text.slice(0, 240).replace(/\s+/g, " ") || "(empty)"}`);
  console.log(JSON.stringify({ ok, eventTypes: events.map((event) => event.type), responseExcerpt: text.slice(0, 400) }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
