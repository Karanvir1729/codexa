#!/usr/bin/env node

import path from "node:path";
import { loadRepoEnv } from "./lib/env.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const env = loadRepoEnv(repoRoot);

function parseArgs(argv) {
  const args = {
    prompt:
      "This is a no-phone smoke test for the agentic coding assistant. Reply with exactly: no-call codex bridge ready.",
    expect: "no-call codex bridge ready",
    timeoutMs: Number(env.PHONE_CODEX_TEST_TIMEOUT_MS || env.PHONE_CODEX_TIMEOUT_SECS || 300) * 1000,
  };

  for (const arg of argv) {
    if (arg.startsWith("--prompt=")) args.prompt = arg.slice("--prompt=".length);
    if (arg.startsWith("--expect=")) args.expect = arg.slice("--expect=".length);
    if (arg.startsWith("--timeout-ms=")) args.timeoutMs = Number(arg.slice("--timeout-ms=".length));
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) args.timeoutMs = 300000;
  return args;
}

function decodeSseText(payload) {
  let content = "";
  const events = [];
  for (const block of payload.split(/\n\n+/)) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        events.push(parsed);
        const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
        content += delta;
      } catch {
        events.push({ raw: data });
      }
    }
  }
  return { content: content.trim(), events };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (env.PHONE_CODEX_BRIDGE_BASE_URL || "http://127.0.0.1:3000/api/phone/v1").replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  const startedAt = performance.now();

  const response = await fetch(endpoint, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.PHONE_CODEX_BRIDGE_API_KEY || "local-codex"}`,
    },
    body: JSON.stringify({
      model: env.PHONE_CODEX_MODEL || "codex-pilot",
      stream: true,
      messages: [
        {
          role: "user",
          content: args.prompt,
        },
      ],
    }),
  }).catch((error) => {
    if (error?.name === "AbortError") {
      throw new Error(`Timed out after ${Math.round(args.timeoutMs / 1000)}s waiting for ${endpoint}`);
    }
    throw error;
  });
  clearTimeout(timeout);

  const raw = await response.text();
  if (!response.ok) throw new Error(`Phone Codex bridge returned ${response.status}: ${raw.slice(0, 600)}`);

  const { content, events } = decodeSseText(raw);
  const durationMs = Math.round(performance.now() - startedAt);
  const lowered = content.toLowerCase();
  const expected = args.expect.toLowerCase();
  const obviousFailure = /\bcodex (pilot )?(is not available|failed|exited|timed out)\b/i.test(content);
  const ok = Boolean(content) && !obviousFailure && (!expected || lowered.includes(expected));

  console.log(`${ok ? "PASS" : "FAIL"} no-call phone Codex bridge: ${durationMs} ms`);
  console.log(`response_excerpt=${content.slice(0, 240).replace(/\s+/g, " ") || "(empty)"}`);
  console.log(
    JSON.stringify(
      {
        ok,
        endpoint,
        durationMs,
        eventCount: events.length,
        expected: args.expect,
        responseExcerpt: content.slice(0, 400),
      },
      null,
      2,
    ),
  );

  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
