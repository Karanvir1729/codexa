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
const SPEAKER_GUARD_URL = process.env.SPEAKER_GUARD_URL ?? WHISPERX_URL;
const SPEAKER_GUARD_TIMEOUT_MS = Number(process.env.SPEAKER_GUARD_TIMEOUT_MS ?? 45000);
const SPEECH_FLOW_URL = process.env.SPEECH_FLOW_URL ?? WHISPERX_URL;
const SPEECH_FLOW_TIMEOUT_MS = Number(process.env.SPEECH_FLOW_TIMEOUT_MS ?? 2500);
const SPEECH_INTENT_MODE = process.env.SPEECH_INTENT_MODE ?? "rewrite";
const SPEECH_INTENT_TIMEOUT_MS = Number(process.env.SPEECH_INTENT_TIMEOUT_MS ?? 60000);
const SPEECH_INTENT_NUM_PREDICT = Number(process.env.SPEECH_INTENT_NUM_PREDICT ?? 220);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
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

const SPEECH_INTENT_PROMPT =
  process.env.SPEECH_INTENT_PROMPT ??
  `You are a Wispr Flow-style speech-to-intent layer for a realtime voice tutor.
Convert raw speech recognition text into the user's intended message.
Preserve all important details, examples, constraints, names, numbers, code terms, and questions.
Apply the provided dictionary, snippets, writing style, language hint, and cleanup level.
Handle Backtrack/self-correction language such as "actually", "no wait", "I mean", "make that", and "change that to".
Remove filler words, repeated starts, obvious ASR noise, and disfluencies.
Format spoken numbered lists, punctuation commands, line breaks, and paragraphs when useful.
If the user said several separate things, output a short bullet list.
If the user is asking one thing, output one concise paragraph.
Do not answer the question. Do not add facts. Do not mention that you cleaned the transcript.
Return only the cleaned user message.`;

const DEFAULT_SPEECH_FLOW_CONFIG = {
  cleanupLevel: "high",
  writingStyle: "tutor",
  languageHint: "auto",
  dictionary: [],
  snippets: [],
};

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

async function completeOllama(messages, systemPrompt, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? OLLAMA_INITIAL_TIMEOUT_MS);
  try {
    const response = await fetch(`${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model ?? OLLAMA_MODEL,
        messages: normalizeMessages(messages, systemPrompt),
        stream: false,
        think: false,
        options: {
          temperature: options.temperature ?? 0.1,
          num_ctx: OLLAMA_NUM_CTX,
          num_predict: options.numPredict ?? OLLAMA_NUM_PREDICT,
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = await response.json();
    return {
      text: String(data.message?.content ?? "").trim(),
      provider: "ollama",
      model: options.model ?? OLLAMA_MODEL,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function completeOpenAI(messages, systemPrompt, options = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? OLLAMA_INITIAL_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: options.model ?? OPENAI_MODEL,
        messages: normalizeMessages(messages, systemPrompt),
        stream: false,
        temperature: options.temperature ?? 0.1,
        max_tokens: options.maxTokens ?? SPEECH_INTENT_NUM_PREDICT,
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`OpenAI-compatible provider returned ${response.status}`);
    const data = await response.json();
    return {
      text: String(data.choices?.[0]?.message?.content ?? "").trim(),
      provider: "openai-compatible",
      model: options.model ?? OPENAI_MODEL,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function cleanIntentOutput(value) {
  return String(value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^(cleaned user message|cleaned message|user message|intent)\s*:\s*/i, "")
    .trim();
}

function normalizeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSpeechFlowConfig(raw = {}) {
  const dictionary = Array.isArray(raw.dictionary)
    ? raw.dictionary
        .map((entry) => {
          if (typeof entry === "string") return { term: entry.trim() };
          return {
            term: String(entry.term ?? entry.word ?? entry.to ?? entry.correction ?? "").trim(),
            from: String(entry.from ?? entry.misspelling ?? entry.heard ?? "").trim(),
            to: String(entry.to ?? entry.correction ?? entry.term ?? entry.word ?? "").trim(),
            starred: Boolean(entry.starred),
          };
        })
        .filter((entry) => entry.term || (entry.from && entry.to))
        .slice(0, 200)
    : [];

  const snippets = Array.isArray(raw.snippets)
    ? raw.snippets
        .map((entry) => {
          if (typeof entry === "string") return null;
          return {
            trigger: String(entry.trigger ?? entry.name ?? "").trim(),
            text: String(entry.text ?? entry.expansion ?? "").trim(),
          };
        })
        .filter((entry) => entry?.trigger && entry?.text)
        .slice(0, 100)
    : [];

  return {
    ...DEFAULT_SPEECH_FLOW_CONFIG,
    cleanupLevel: String(raw.cleanupLevel ?? DEFAULT_SPEECH_FLOW_CONFIG.cleanupLevel),
    writingStyle: String(raw.writingStyle ?? DEFAULT_SPEECH_FLOW_CONFIG.writingStyle),
    languageHint: String(raw.languageHint ?? DEFAULT_SPEECH_FLOW_CONFIG.languageHint),
    dictionary,
    snippets,
  };
}

function replaceWholeWord(text, from, to) {
  if (!from || !to) return text;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(from)}(?![\\p{L}\\p{N}_])`, "giu");
  return text.replace(pattern, to);
}

function applyDictionary(text, dictionary = []) {
  const applied = [];
  let next = text;
  const replacements = dictionary
    .filter((entry) => entry.from && entry.to)
    .sort((a, b) => Number(b.starred) - Number(a.starred) || b.from.length - a.from.length);

  for (const entry of replacements) {
    const before = next;
    next = replaceWholeWord(next, entry.from, entry.to);
    if (next !== before) applied.push({ from: entry.from, to: entry.to });
  }

  return { text: next, applied };
}

function applySnippets(text, snippets = []) {
  const applied = [];
  let next = text;
  const sorted = snippets.slice().sort((a, b) => b.trigger.length - a.trigger.length);
  const normalizedText = normalizeKey(next.replace(/[.!?]+$/g, ""));

  for (const snippet of sorted) {
    const triggerKey = normalizeKey(snippet.trigger);
    if (!triggerKey) continue;
    if (normalizedText === triggerKey) {
      applied.push({ trigger: snippet.trigger });
      return { text: snippet.text, applied };
    }
  }

  for (const snippet of sorted) {
    const before = next;
    next = replaceWholeWord(next, snippet.trigger, snippet.text);
    if (next !== before) applied.push({ trigger: snippet.trigger });
  }

  return { text: next, applied };
}

function applyPunctuationCommands(text) {
  const replacements = [
    [/\bnew paragraph\b/gi, "\n\n"],
    [/\b(new line|line break|next line)\b/gi, "\n"],
    [/\b(question mark)\b/gi, "?"],
    [/\b(exclamation point|exclamation mark)\b/gi, "!"],
    [/\b(period|full stop)\b/gi, "."],
    [/\bcomma\b/gi, ","],
    [/\bsemicolon\b/gi, ";"],
    [/\bcolon\b/gi, ":"],
    [/\b(ellipsis)\b/gi, "..."],
    [/\b(open parenthesis|open paren)\b/gi, "("],
    [/\b(close parenthesis|close paren)\b/gi, ")"],
    [/\b(plus sign)\b/gi, "+"],
    [/\b(equals sign)\b/gi, "="],
    [/\b(at sign|at symbol)\b/gi, "@"],
    [/\b(percent sign|percentage symbol)\b/gi, "%"],
  ];

  let next = text;
  for (const [pattern, replacement] of replacements) {
    next = next.replace(pattern, replacement);
  }
  return next
    .replace(/\s+([,.!?;:%])/g, "$1")
    .replace(/([(\n])\s+/g, "$1")
    .replace(/\s+([)])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function applyBacktrack(text) {
  const numberWords = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty";
  let next = text;
  next = next.replace(
    new RegExp(`\\b(\\d+|${numberWords})\\s+(actually|no wait|wait no|sorry|i mean|make that|change that to)\\s+(\\d+|${numberWords})\\b`, "giu"),
    "$3",
  );
  next = next.replace(/\b(actually|no wait|wait no|sorry|i mean|rather|make that|change that to)\b[:,]?\s*/giu, "");
  return next.replace(/\s{2,}/g, " ").trim();
}

function applyFillerCleanup(text, cleanupLevel = "high") {
  if (cleanupLevel === "none") return text;
  let next = text;
  next = next.replace(/\b(um+|uh+|erm+|ah+|hmm+)\b[,\s]*/giu, "");
  next = next.replace(/\b(you know|kind of|sort of)\b[,\s]*/giu, "");
  if (cleanupLevel === "high") {
    next = next.replace(/\b(like)\b(?=\s+(so|i|we|can|could|what|why|how|the|this|that|first|second|third)\b)[,\s]*/giu, "");
    next = next.replace(/\b(okay|ok|so)\b[,\s]*(?=(first|second|third|can|could|i|we|what|why|how)\b)/giu, "");
  }
  return next.replace(/\s{2,}/g, " ").trim();
}

function formatSpokenLists(text, writingStyle = "tutor") {
  const markerPattern = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1|2|3|4|5|6|7|8|9|10)[.)]?\s+/giu;
  const matches = [...text.matchAll(markerPattern)];
  if (matches.length < 2) return text;

  const items = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const item = text.slice(start, end).trim().replace(/^[,;:. -]+|[,;:. -]+$/g, "");
    if (item) items.push(item);
  }

  const prefix = text.slice(0, matches[0].index).trim().replace(/[,;:. -]+$/g, "");
  if (items.length < 2) return text;
  const bulletChar = writingStyle === "numbered" ? null : "-";
  const formattedItems = items.map((item, index) => (bulletChar ? `${bulletChar} ${item}` : `${index + 1}. ${item}`));
  return [prefix, formattedItems.join("\n")].filter(Boolean).join("\n");
}

function applyWritingStyle(text, writingStyle = "tutor") {
  let next = text.trim();
  if (writingStyle === "casual") {
    next = next.replace(/\.$/, "");
  }
  if (writingStyle === "bullets" || writingStyle === "numbered") {
    next = formatSpokenLists(next, writingStyle);
  }
  return next;
}

function applySpeechFlowTransforms(rawText, flowConfig) {
  const dictionary = applyDictionary(rawText, flowConfig.dictionary);
  const snippets = applySnippets(dictionary.text, flowConfig.snippets);
  const cleaned = applyFillerCleanup(snippets.text, flowConfig.cleanupLevel);
  const backtracked = applyBacktrack(cleaned);
  const punctuated = applyPunctuationCommands(backtracked);
  const styled = applyWritingStyle(punctuated, flowConfig.writingStyle);

  return {
    text: styled,
    dictionary_applied: dictionary.applied,
    snippets_applied: snippets.applied,
    cleanup_level: flowConfig.cleanupLevel,
    writing_style: flowConfig.writingStyle,
    language_hint: flowConfig.languageHint,
  };
}

async function runPythonSpeechFlow(rawText, flowConfig) {
  if (!SPEECH_FLOW_URL) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SPEECH_FLOW_TIMEOUT_MS);
  try {
    const response = await fetch(`${SPEECH_FLOW_URL.replace(/\/$/, "")}/speech-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawText, flow: flowConfig }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function completeWithConfiguredProvider(messages, systemPrompt, options = {}) {
  if (PROVIDER === "ollama" || PROVIDER === "auto") {
    try {
      return await completeOllama(messages, systemPrompt, options);
    } catch (error) {
      if (PROVIDER === "ollama") throw error;
    }
  }

  if ((PROVIDER === "openai" || PROVIDER === "auto") && process.env.OPENAI_API_KEY) {
    return completeOpenAI(messages, systemPrompt, options);
  }

  throw new Error("No text generation provider is available for speech cleanup.");
}

async function handleSpeechIntent(req, res) {
  const body = await readJson(req);
  const rawText = String(body.rawText ?? body.text ?? "").trim();
  const mode = String(body.mode ?? SPEECH_INTENT_MODE);
  const flowConfig = normalizeSpeechFlowConfig(body.flow ?? body.flowConfig ?? {});

  if (!rawText) {
    json(res, 400, { error: "Missing rawText" });
    return;
  }

  const pythonFlow = await runPythonSpeechFlow(rawText, flowConfig);
  const deterministic = pythonFlow?.flow
    ? {
        ...pythonFlow.flow,
        text: String(pythonFlow.text || pythonFlow.flow.text || rawText),
      }
    : applySpeechFlowTransforms(rawText, flowConfig);

  if (mode === "raw" || rawText.length < 12) {
    json(res, 200, {
      text: rawText,
      rawText,
      mode: "raw",
      provider: "none",
      changed: false,
      flow: deterministic,
    });
    return;
  }

  if (mode === "format") {
    json(res, 200, {
      text: deterministic.text || rawText,
      rawText,
      mode: "format",
      provider: pythonFlow?.provider || "node-flow-format",
      changed: (deterministic.text || rawText) !== rawText,
      flow: deterministic,
    });
    return;
  }

  const startedAt = performance.now();
  try {
    const result = await completeWithConfiguredProvider(
      [
        {
          role: "user",
          content: [
            `Raw speech recognition text:\n${rawText}`,
            `Local Flow-style first pass:\n${deterministic.text}`,
            `Flow config:\n${JSON.stringify({
              cleanupLevel: flowConfig.cleanupLevel,
              writingStyle: flowConfig.writingStyle,
              languageHint: flowConfig.languageHint,
              dictionary: flowConfig.dictionary.map((entry) => ({
                term: entry.term,
                from: entry.from,
                to: entry.to,
                starred: entry.starred,
              })),
              snippets: flowConfig.snippets.map((entry) => ({
                trigger: entry.trigger,
                text: entry.text,
              })),
            })}`,
            "Clean this into the user message that should be sent to the tutor.",
          ].join("\n\n"),
        },
      ],
      SPEECH_INTENT_PROMPT,
      {
        timeoutMs: SPEECH_INTENT_TIMEOUT_MS,
        numPredict: SPEECH_INTENT_NUM_PREDICT,
        maxTokens: SPEECH_INTENT_NUM_PREDICT,
        temperature: 0.1,
      },
    );
    const modelText = cleanIntentOutput(result.text) || deterministic.text || rawText;
    const afterDictionary = applyDictionary(modelText, flowConfig.dictionary);
    const afterSnippets = applySnippets(afterDictionary.text, flowConfig.snippets);
    const text = applyWritingStyle(applyPunctuationCommands(afterSnippets.text), flowConfig.writingStyle) || deterministic.text || rawText;
    json(res, 200, {
      text,
      rawText,
      mode: "rewrite",
      provider: result.provider,
      model: result.model,
      changed: text !== rawText,
      duration_ms: Math.round(performance.now() - startedAt),
      flow: {
        ...deterministic,
        dictionary_applied: [...deterministic.dictionary_applied, ...afterDictionary.applied],
        snippets_applied: [...deterministic.snippets_applied, ...afterSnippets.applied],
      },
    });
  } catch (error) {
    json(res, 200, {
      text: deterministic.text || rawText,
      rawText,
      mode: "fallback_flow_format",
      provider: pythonFlow?.provider || "node-flow-format",
      changed: (deterministic.text || rawText) !== rawText,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Math.round(performance.now() - startedAt),
      flow: deterministic,
    });
  }
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

  const contentType = firstHeader(req.headers["content-type"]) || "application/octet-stream";
  const userId = firstHeader(req.headers["x-user-id"]);
  const userName = firstHeader(req.headers["x-user-name"]);
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
    const headers = {
      "Content-Type": contentType,
      "X-Audio-Format": firstHeader(req.headers["x-audio-format"]) || "webm",
    };
    if (userId) headers["X-User-Id"] = userId;
    if (userName) headers["X-User-Name"] = userName;

    response = await fetch(`${WHISPERX_URL.replace(/\/$/, "")}/transcribe`, {
      method: "POST",
      headers,
      body: audio,
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    json(res, isAbort ? 504 : 502, {
      error: isAbort ? "WhisperX transcription timed out." : "WhisperX adapter is unavailable.",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (!response) {
    json(res, 504, { error: "WhisperX adapter did not respond." });
    return;
  }

  const resultText = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(resultText);
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0] ?? "";
  return typeof value === "string" ? value : "";
}

async function proxyRawAudio(req, res, upstreamUrl, timeoutMs) {
  const contentType = firstHeader(req.headers["content-type"]) || "application/octet-stream";
  const userId = firstHeader(req.headers["x-user-id"]);
  const userName = firstHeader(req.headers["x-user-name"]);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const audio = Buffer.concat(chunks);

  if (!audio.length) {
    json(res, 400, { error: "Missing audio body" });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    const headers = {
      "Content-Type": contentType,
      "X-Audio-Format": firstHeader(req.headers["x-audio-format"]) || "webm",
    };
    if (userId) headers["X-User-Id"] = userId;
    if (userName) headers["X-User-Name"] = userName;

    response = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: audio,
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    json(res, isAbort ? 504 : 502, {
      error: isAbort ? "Upstream audio service timed out." : "Upstream audio service is unavailable.",
      detail: error instanceof Error ? error.message : String(error),
    });
    return;
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

async function handleSpeakerGuard(req, res, action) {
  if (!SPEAKER_GUARD_URL) {
    json(res, 501, {
      error: "Speaker identity service is not configured. Set SPEAKER_GUARD_URL to a service with speaker endpoints.",
    });
    return;
  }

  await proxyRawAudio(
    req,
    res,
    `${SPEAKER_GUARD_URL.replace(/\/$/, "")}/speaker/${action}`,
    SPEAKER_GUARD_TIMEOUT_MS,
  );
}

async function handleSpeakerReset(_req, res) {
  if (!SPEAKER_GUARD_URL) {
    json(res, 501, { error: "Speaker identity service is not configured." });
    return;
  }

  const response = await fetch(`${SPEAKER_GUARD_URL.replace(/\/$/, "")}/speaker/reset`, { method: "POST" });
  const resultText = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(resultText);
}

async function handleSpeakerProfiles(_req, res) {
  if (!SPEAKER_GUARD_URL) {
    json(res, 501, { error: "Speaker identity service is not configured." });
    return;
  }

  const response = await fetch(`${SPEAKER_GUARD_URL.replace(/\/$/, "")}/speaker/profiles`, { method: "GET" });
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
    speechIntent: {
      mode: SPEECH_INTENT_MODE,
      provider: PROVIDER,
      pythonFlowUrl: SPEECH_FLOW_URL || null,
      pythonFlowTimeoutMs: SPEECH_FLOW_TIMEOUT_MS,
      deterministicRuntime: "python preferred, node fallback",
      purpose: "Wispr Flow-style rewrite from raw transcript to cleaned user intent.",
    },
    speakerGuard: {
      configured: Boolean(SPEAKER_GUARD_URL),
      url: SPEAKER_GUARD_URL || null,
      targetModel: "NVIDIA NeMo Streaming Sortformer / TitaNet speaker embeddings",
      localFallbackModel: "speechbrain/spkrec-ecapa-voxceleb",
      purpose: "Parallel speaker identity for barge-in and persistent per-student profiles.",
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
        speechIntentMode: SPEECH_INTENT_MODE,
        fishConfigured: Boolean(FISH_API_KEY),
        fishModel: FISH_TTS_MODEL,
        whisperxConfigured: Boolean(WHISPERX_URL),
        speakerGuardConfigured: Boolean(SPEAKER_GUARD_URL),
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

    if (url.pathname === "/api/speech-intent" && req.method === "POST") {
      await handleSpeechIntent(req, res);
      return;
    }

    if (url.pathname === "/api/speaker/enroll" && req.method === "POST") {
      await handleSpeakerGuard(req, res, "enroll");
      return;
    }

    if (url.pathname === "/api/speaker/enroll-assistant" && req.method === "POST") {
      await handleSpeakerGuard(req, res, "enroll-assistant");
      return;
    }

    if (url.pathname === "/api/speaker/classify" && req.method === "POST") {
      await handleSpeakerGuard(req, res, "classify");
      return;
    }

    if (url.pathname === "/api/speaker/reset" && req.method === "POST") {
      await handleSpeakerReset(req, res);
      return;
    }

    if (url.pathname === "/api/speaker/profiles" && req.method === "GET") {
      await handleSpeakerProfiles(req, res);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
});

server.listen(port, () => {
  console.log(`Tutor-Tron voice system running at http://localhost:${port}`);
  console.log(`Provider mode: ${PROVIDER}`);
});
