import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "web");
const port = Number(process.env.PORT ?? 3000);

const PROVIDER = process.env.VOICE_AGENT_PROVIDER ?? "ollama";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5";
const OLLAMA_INITIAL_TIMEOUT_MS = Number(process.env.OLLAMA_INITIAL_TIMEOUT_MS ?? 120000);
const OLLAMA_NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 8192);
const OLLAMA_NUM_PREDICT = Number(process.env.OLLAMA_NUM_PREDICT ?? 320);
const FISH_API_KEY = process.env.FISH_API_KEY ?? "";
const TTS_PROVIDER = process.env.TTS_PROVIDER ?? (FISH_API_KEY ? "fish" : "browser");
const FISH_TTS_URL = process.env.FISH_TTS_URL ?? "https://api.fish.audio/v1/tts";
const FISH_TTS_MODEL = process.env.FISH_TTS_MODEL ?? "s2-pro";
const FISH_REFERENCE_ID = process.env.FISH_REFERENCE_ID ?? "";
const FISH_LATENCY = process.env.FISH_LATENCY ?? "balanced";
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE ?? "alloy";
const STT_PROVIDER = process.env.STT_PROVIDER ?? "whisperx";
const WHISPERX_URL = process.env.WHISPERX_URL ?? "http://127.0.0.1:9001";
const WHISPERX_TIMEOUT_MS = Number(process.env.WHISPERX_TIMEOUT_MS ?? 120000);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
};

const DEFAULT_AGENT_PROMPT =
  process.env.AGENT_SYSTEM_PROMPT ??
  `You are Tutor-Tron, a real-time conversational voice agent.
Respond naturally to whatever the user asks.
Keep spoken responses concise: usually 1-5 sentences.
Ask one clarifying question when the user's request is ambiguous.
Do not use canned domain-specific answers unless the conversation calls for them.
Do not expose hidden reasoning. Speak directly and conversationally.
If interrupted, adapt to the user's latest words immediately.`;

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendBinary(res, status, contentType, buffer, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(buffer);
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function normalizeMessages(messages = [], systemPrompt = DEFAULT_AGENT_PROMPT) {
  return [
    { role: "system", content: systemPrompt },
    ...messages
      .filter((m) => m && ["user", "assistant", "system"].includes(m.role) && typeof m.content === "string")
      .slice(-16),
  ];
}

async function streamOpenAI(res, messages, systemPrompt) {
  const response = await fetch(`${OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: normalizeMessages(messages, systemPrompt),
      stream: true,
      temperature: 0.4,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`OpenAI-compatible provider returned ${response.status}`);
  }

  sse(res, "meta", { provider: "openai-compatible", model: OPENAI_MODEL });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      for (const line of part.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          sse(res, "done", {});
          res.end();
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) sse(res, "token", { text });
        } catch {
          // Ignore provider keepalive frames.
        }
      }
    }
  }

  sse(res, "done", {});
  res.end();
}

async function streamOllama(res, messages, systemPrompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_INITIAL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: normalizeMessages(messages, systemPrompt),
        stream: true,
        think: false,
        options: {
          temperature: 0.35,
          num_ctx: OLLAMA_NUM_CTX,
          num_predict: OLLAMA_NUM_PREDICT,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok || !response.body) {
    throw new Error(`Ollama returned ${response?.status ?? "no response"}`);
  }

  sse(res, "meta", { provider: "ollama", model: OLLAMA_MODEL });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      const text = parsed.message?.content;
      if (text) sse(res, "token", { text });
      if (parsed.done) {
        sse(res, "done", {});
        res.end();
        return;
      }
    }
  }

  sse(res, "done", {});
  res.end();
}

async function handleChat(req, res) {
  const body = await readJson(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemPrompt = typeof body.systemPrompt === "string" && body.systemPrompt.trim() ? body.systemPrompt.trim() : DEFAULT_AGENT_PROMPT;
  sendSseHeaders(res);

  try {
    if (PROVIDER === "ollama" || PROVIDER === "auto") {
      try {
        await streamOllama(res, messages, systemPrompt);
        return;
      } catch (error) {
        if (PROVIDER === "ollama") throw error;
        sse(res, "warning", { message: `Ollama unavailable: ${error instanceof Error ? error.message : "unknown error"}` });
      }
    }

    if ((PROVIDER === "openai" || PROVIDER === "auto") && process.env.OPENAI_API_KEY) {
      await streamOpenAI(res, messages, systemPrompt);
      return;
    }

    throw new Error("No LLM provider is available. Start Ollama with qwen3.5 or configure OPENAI_API_KEY.");
  } catch (error) {
    sse(res, "error", { message: error instanceof Error ? error.message : "Unknown model error" });
    sse(res, "done", {});
    res.end();
  }
}

async function handleTts(req, res) {
  const body = await readJson(req);
  const text = String(body.text ?? "").trim();
  const provider = String(body.provider ?? TTS_PROVIDER);
  const speed = Math.min(1.25, Math.max(0.75, Number(body.speed ?? 1)));

  if (!text) {
    json(res, 400, { error: "Missing text" });
    return;
  }

  const startedAt = performance.now();

  if (provider === "fish") {
    if (!FISH_API_KEY) {
      json(res, 501, { error: "Fish TTS is not configured. Set FISH_API_KEY." });
      return;
    }

    const fishBody = {
      text,
      temperature: 0.7,
      top_p: 0.7,
      prosody: {
        speed,
        volume: 0,
        normalize_loudness: true,
      },
      chunk_length: 200,
      normalize: true,
      format: "mp3",
      sample_rate: 44100,
      mp3_bitrate: 128,
      latency: FISH_LATENCY,
      max_new_tokens: 1024,
      repetition_penalty: 1.2,
      min_chunk_length: 50,
      condition_on_previous_chunks: true,
    };

    if (FISH_REFERENCE_ID) fishBody.reference_id = FISH_REFERENCE_ID;

    const response = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${FISH_API_KEY}`,
        "Content-Type": "application/json",
        model: FISH_TTS_MODEL,
      },
      body: JSON.stringify(fishBody),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      json(res, response.status, { error: `Fish TTS failed: ${response.status}`, detail: detail.slice(0, 500) });
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    sendBinary(res, 200, response.headers.get("content-type") ?? "audio/mpeg", buffer, {
      "X-TTS-Provider": "fish",
      "X-TTS-Model": FISH_TTS_MODEL,
      "X-TTS-Server-MS": String(Math.round(performance.now() - startedAt)),
    });
    return;
  }

  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      json(res, 501, { error: "OpenAI TTS is not configured. Set OPENAI_API_KEY." });
      return;
    }

    const response = await fetch(`${OPENAI_BASE_URL.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input: text,
        response_format: "mp3",
        speed,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      json(res, response.status, { error: `OpenAI TTS failed: ${response.status}`, detail: detail.slice(0, 500) });
      return;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    sendBinary(res, 200, response.headers.get("content-type") ?? "audio/mpeg", buffer, {
      "X-TTS-Provider": "openai",
      "X-TTS-Model": OPENAI_TTS_MODEL,
      "X-TTS-Server-MS": String(Math.round(performance.now() - startedAt)),
    });
    return;
  }

  json(res, 501, { error: "Browser TTS runs on the client; no server audio is generated." });
}

async function handleStt(req, res) {
  if (!WHISPERX_URL) {
    json(res, 501, {
      error: "WhisperX adapter is not configured. Set WHISPERX_URL to a service that accepts raw audio and returns { text, segments }.",
    });
    return;
  }

  const contentType = req.headers["content-type"] ?? "application/octet-stream";
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const audio = Buffer.concat(chunks);

  if (!audio.length) {
    json(res, 400, { error: "Missing audio body" });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHISPERX_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${WHISPERX_URL.replace(/\/$/, "")}/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Audio-Format": String(req.headers["x-audio-format"] ?? "webm"),
    },
    body: audio,
    signal: controller.signal,
  });
  } finally {
    clearTimeout(timeout);
  }

  const resultText = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(resultText);
}

async function handleProviderHealth(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const deep = url.searchParams.get("deep") === "1";
  const health = {
    llm: {
      configuredProvider: PROVIDER,
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      ollamaBaseUrl: OLLAMA_BASE_URL,
      ollamaModel: OLLAMA_MODEL,
      ollamaReachable: null,
    },
    stt: {
      configuredProvider: STT_PROVIDER,
      liveBrowserStt: true,
      whisperxConfigured: Boolean(WHISPERX_URL),
      whisperxUrl: WHISPERX_URL || null,
      recommendation: "Use WhisperX for turn-level voice-agent STT; browser STT remains a fallback/debug option.",
    },
    tts: {
      defaultProvider: TTS_PROVIDER,
      browserAvailableOnClient: true,
      fishConfigured: Boolean(FISH_API_KEY),
      fishModel: FISH_TTS_MODEL,
      fishLatency: FISH_LATENCY,
      openaiTtsConfigured: Boolean(process.env.OPENAI_API_KEY),
      openaiTtsModel: OPENAI_TTS_MODEL,
    },
  };

  if (deep) {
    const startedAt = performance.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 900);
      const response = await fetch(`${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);
      health.llm.ollamaReachable = response.ok;
      health.llm.ollamaPingMs = Math.round(performance.now() - startedAt);
    } catch {
      health.llm.ollamaReachable = false;
      health.llm.ollamaPingMs = Math.round(performance.now() - startedAt);
    }
  }

  json(res, 200, health);
}

function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safePath === "/" ? "index.html" : safePath);

  if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypes[ext] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/status") {
      json(res, 200, {
        provider: PROVIDER,
        openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
        ollamaBaseUrl: OLLAMA_BASE_URL,
        ollamaModel: OLLAMA_MODEL,
        sttProvider: STT_PROVIDER,
        ttsProvider: TTS_PROVIDER,
        fishConfigured: Boolean(FISH_API_KEY),
        fishModel: FISH_TTS_MODEL,
        whisperxConfigured: Boolean(WHISPERX_URL),
      });
      return;
    }

    if (url.pathname === "/api/providers/health") {
      await handleProviderHealth(req, res);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "max-age=86400" });
      res.end();
      return;
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      await handleChat(req, res);
      return;
    }

    if (url.pathname === "/api/tts" && req.method === "POST") {
      await handleTts(req, res);
      return;
    }

    if (url.pathname === "/api/stt" && req.method === "POST") {
      await handleStt(req, res);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`Tutor-Tron voice prototype running at http://localhost:${port}`);
  console.log(`Provider mode: ${PROVIDER}`);
});
