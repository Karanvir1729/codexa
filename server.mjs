import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "web");
const testRunsDir = path.join(__dirname, "data", "test-runs");
const voiceSessionsPath = path.join(__dirname, "data", "voice-sessions.json");
const port = Number(process.env.PORT ?? 3000);
let activeTestRun = null;
let lastDesktopLaunchAt = 0;
const DESKTOP_LAUNCH_TOKEN_TTL_MS = 5 * 60 * 1000;
const desktopLaunchTokens = new Map();

function loadDotenvIntoProcess() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotenvIntoProcess();

const PROVIDER = process.env.VOICE_AGENT_PROVIDER ?? "codex";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const CODEX_COMPLETION_TIMEOUT_MS = Number(process.env.CODEX_COMPLETION_TIMEOUT_MS ?? 120000);
const CODEX_COMPLETION_MAX_TOKENS = Number(process.env.CODEX_COMPLETION_MAX_TOKENS ?? 320);
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
const CODEX_PILOT_ENABLED = process.env.CODEX_PILOT_ENABLED !== "0";
const CODEX_DESKTOP_COMMAND = "/Applications/Codex.app/Contents/Resources/codex";
const CODEX_PILOT_COMMAND = resolveCodexPilotCommand();
const CODEX_HOME_DIR = resolveCodexHomeDir();
const CODEX_PILOT_MODEL = process.env.CODEX_PILOT_MODEL ?? "";
const CODEX_PILOT_SANDBOX = process.env.CODEX_PILOT_SANDBOX ?? "workspace-write";
const CODEX_PILOT_APPROVAL = process.env.CODEX_PILOT_APPROVAL ?? "never";
const CODEX_PILOT_TIMEOUT_MS = Number(process.env.CODEX_PILOT_TIMEOUT_MS ?? 300000);
const CODEX_PILOT_MAX_CONTEXT_MESSAGES = Number(process.env.CODEX_PILOT_MAX_CONTEXT_MESSAGES ?? 8);
const CODEX_CONTROL_PROVIDER = process.env.CODEX_CONTROL_PROVIDER ?? "openclaw";
const LEGACY_CODEX_WORKSPACE_ROOT = path.resolve(path.join(__dirname, "tmp", "codex-workspaces"));
const CODEX_WORKSPACE_ROOT = path.resolve(expandHomePath(process.env.CODEX_WORKSPACE_ROOT ?? path.join(os.homedir(), "agentic-coding-projects")));
const CODEX_APP_CHAT_REGISTRATION = String(process.env.CODEX_APP_CHAT_REGISTRATION ?? process.env.CODEX_ACTIVITY_MIRROR ?? "1") !== "0";
const CODEX_APP_CHAT_COMMAND = process.env.CODEX_APP_CHAT_COMMAND?.trim() || resolveCodexAppChatCommand();
const CODEX_APP_CHAT_TIMEOUT_MS = Number(process.env.CODEX_APP_CHAT_TIMEOUT_MS ?? process.env.CODEX_ACTIVITY_MIRROR_TIMEOUT_MS ?? 90000);
const CODEX_APP_OPEN_GENERATED_WORKSPACES = String(process.env.CODEX_APP_OPEN_GENERATED_WORKSPACES ?? "1") !== "0";
const CODEX_STATE_DB = process.env.CODEX_STATE_DB ?? "";
const RESPONSE_POLISH_PROVIDER = process.env.RESPONSE_POLISH_PROVIDER ?? "codex";
const RESPONSE_POLISH_TIMEOUT_MS = Number(process.env.RESPONSE_POLISH_TIMEOUT_MS ?? 60000);
const RESPONSE_POLISH_MAX_INPUT_CHARS = Number(process.env.RESPONSE_POLISH_MAX_INPUT_CHARS ?? 6000);
const OPENCLAW_COMMAND =
  process.env.OPENCLAW_COMMAND?.trim() ||
  (process.platform === "win32" ? "openclaw.cmd" : "/opt/homebrew/bin/openclaw");
const OPENCLAW_LOCAL = process.env.OPENCLAW_LOCAL === "1";
const OPENCLAW_TIMEOUT_SECS = Number(process.env.OPENCLAW_TIMEOUT_SECS ?? 420);
const OPENCLAW_THINKING = process.env.OPENCLAW_THINKING ?? "off";
const OPENCLAW_SESSION_PREFIX = process.env.OPENCLAW_SESSION_PREFIX ?? "codexa";
const PHONE_CODEX_CONTROL_PROVIDER = process.env.PHONE_CODEX_CONTROL_PROVIDER ?? CODEX_CONTROL_PROVIDER;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER ?? "";
const TWILIO_WEBHOOK_BASE_URL = process.env.TWILIO_WEBHOOK_BASE_URL ?? "";
const TWILIO_SMS_STATUS_CALLBACK_URL = process.env.TWILIO_SMS_STATUS_CALLBACK_URL ?? "";
const PIPECAT_PUBLIC_WS_URL = process.env.PIPECAT_PUBLIC_WS_URL ?? "";
const PIPECAT_WS_PROXY_TARGET = process.env.PIPECAT_WS_PROXY_TARGET ?? "127.0.0.1:7860";
const TWILIO_STATUS_PATH = "/api/twilio/status";
const TWILIO_VOICE_PATH = "/api/twilio/voice";
const TWILIO_SMS_PATH = "/api/twilio/sms";
const PIPECAT_WS_PATH = "/ws";
const TWILIO_SMS_MAX_BODY_CHARS = 1500;
const CODEX_PILOT_SYSTEM_PROMPT =
  process.env.CODEX_PILOT_SYSTEM_PROMPT ??
  `You are the Codex pilot underneath Codexa, an agentic coding voice assistant.
The user is speaking to a desktop voice agent, but you have the repo-level capabilities of Codex and can inspect, edit, test, and run project code.
Interpret the latest user turn as an instruction for the current workspace when it asks for building, debugging, editing, testing, running commands, explaining code, or operating the project.
When work is requested, actually do the work end-to-end: inspect files, edit code, run focused checks, and report the result.
For coding/building requests, create or modify real files in the target workspace. Do not answer with fake code, hardcoded demos, or a plan unless the user only asked for a plan.
If the target workspace is empty and the user asks to build something, bootstrap the smallest complete project that satisfies the request, include a runnable test/check, run it, and summarize exact file paths.
Keep the final answer voice-friendly: concise, direct, and focused on what changed, what passed, and what remains.
Do not narrate long command logs unless the user explicitly asks.
If the user asks a general question unrelated to coding or the repo, answer normally and concisely.`;

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
  `You are an agentic coding voice assistant.
Help the user code by inspecting files, planning concise next steps, explaining code, and using Codex pilot mode when project changes or command execution are needed.
Respond naturally to whatever the user asks.
Keep spoken responses concise: usually 1-5 sentences.
Ask one clarifying question when the user's request is ambiguous.
Do not use canned domain-specific answers unless the conversation calls for them.
Do not expose hidden reasoning. Speak directly and conversationally.
Wait for the user's next turn before changing direction.`;

const SPEECH_INTENT_PROMPT =
  process.env.SPEECH_INTENT_PROMPT ??
  `You are a Wispr Flow-style speech-to-intent layer for a realtime voice coding assistant.
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
  writingStyle: "coding",
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
  const body = await readRequestText(req);
  return body ? JSON.parse(body) : {};
}

async function readRequestText(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function readForm(req) {
  const body = await readRequestText(req);
  return Object.fromEntries(new URLSearchParams(body));
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sendTwiML(res, body) {
  res.writeHead(200, {
    "Content-Type": "text/xml; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`);
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function expandHomePath(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function safeId(value, fallback = "default") {
  return safeText(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
}

function readVoiceSessions() {
  const stored = readJsonFile(voiceSessionsPath, { sessions: [] });
  return Array.isArray(stored.sessions) ? stored.sessions : [];
}

function writeVoiceSessions(sessions) {
  writeJsonFile(voiceSessionsPath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: sessions.slice(0, 200),
  });
}

function sessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    projectMode: session.projectMode,
    projectName: session.projectName,
    workspaceDir: session.workspaceDir || "",
    userId: session.userId,
    userName: session.userName,
    source: session.source,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt || null,
    turnCount: session.turnCount || 0,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    lastUserText: session.lastUserText || "",
    lastAssistantText: session.lastAssistantText || "",
  };
}

function sessionTitleFromText(text, fallback = "Untitled chat") {
  const normalized = safeText(text, fallback).replace(/\s+/g, " ");
  return normalized.length > 58 ? `${normalized.slice(0, 55)}...` : normalized;
}

function createVoiceSession(input = {}) {
  const now = new Date().toISOString();
  const projectMode = input.projectMode === "new_project" ? "new_project" : "existing_project";
  const projectName = safeText(input.projectName, projectMode === "new_project" ? "New project" : "Current repo");
  const title = safeText(input.title, `${projectName} chat`);
  return {
    id: randomUUID(),
    title,
    projectMode,
    projectName,
    workspaceDir: safeText(input.workspaceDir || input.workspace_dir, ""),
    userId: safeId(input.userId, "user_a"),
    userName: safeText(input.userName, "User A"),
    source: safeText(input.source, "browser"),
    status: "active",
    createdAt: now,
    updatedAt: now,
    endedAt: null,
    turnCount: 0,
    lastUserText: "",
    lastAssistantText: "",
    messages: [],
  };
}

function appendVoiceSessionMessage(sessionId, input = {}) {
  const sessions = readVoiceSessions();
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) return null;

  const role = ["user", "assistant", "system"].includes(input.role) ? input.role : "user";
  const content = safeText(input.content);
  if (!content) return null;

  const now = new Date().toISOString();
  const message = {
    id: randomUUID(),
    role,
    content,
    source: safeText(input.source, sessions[index].source || "browser"),
    route: safeText(input.route, ""),
    externalId: safeText(input.externalId, ""),
    createdAt: now,
  };
  sessions[index].messages = [...(sessions[index].messages || []), message].slice(-500);
  sessions[index].updatedAt = now;
  sessions[index].status = input.status === "ended" ? "ended" : "active";
  if (role === "user") {
    sessions[index].turnCount = Number(sessions[index].turnCount || 0) + 1;
    sessions[index].lastUserText = content;
    if (!sessions[index].title || sessions[index].title.endsWith(" chat")) {
      sessions[index].title = sessionTitleFromText(content, sessions[index].title);
    }
  }
  if (role === "assistant") sessions[index].lastAssistantText = content;

  sessions.splice(index, 1, sessions[index]);
  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  writeVoiceSessions(sessions);
  return { session: sessions.find((session) => session.id === sessionId), message };
}

function recordPhoneBridgeExchange(messages = [], assistantText = "") {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const latestUser = [...safeMessages].reverse().find((message) => message?.role === "user" && typeof message.content === "string")?.content;
  if (!latestUser && !assistantText) return;
  if (/\b(no-phone|no-call|smoke test)\b/i.test(latestUser || "")) return;

  const session = createVoiceSession({
    source: "phone_bridge",
    projectMode: "existing_project",
    projectName: "Phone coding assistant",
    title: sessionTitleFromText(latestUser || "Phone call"),
    userId: "phone_caller",
    userName: "Phone caller",
  });
  const sessions = readVoiceSessions();
  sessions.unshift(session);
  writeVoiceSessions(sessions);
  if (latestUser) appendVoiceSessionMessage(session.id, { role: "user", content: latestUser, source: "phone_bridge", route: "codex_pilot" });
  if (assistantText) appendVoiceSessionMessage(session.id, { role: "assistant", content: assistantText, source: "phone_bridge", route: "codex_pilot" });
}

function findOrCreateTelephonySession({ source, userId, userName, projectName, title }) {
  const sessions = readVoiceSessions();
  const existing = sessions.find((session) => session.source === source && session.userId === userId && session.status === "active");
  if (existing) return existing;

  const session = createVoiceSession({
    source,
    projectMode: "existing_project",
    projectName,
    title,
    userId,
    userName,
  });
  sessions.unshift(session);
  writeVoiceSessions(sessions);
  return session;
}

function voiceSessionHasExternalMessage(sessionId, externalId) {
  if (!externalId) return false;
  const session = readVoiceSessions().find((item) => item.id === sessionId);
  return Boolean(session?.messages?.some((message) => message.externalId === externalId));
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

async function completeOpenAI(messages, systemPrompt, options = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? CODEX_COMPLETION_TIMEOUT_MS);
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

async function completeCodexCli(messages, systemPrompt, options = {}) {
  const prompt = [
    systemPrompt,
    "",
    "Return only the requested text. Do not edit files.",
    "",
    normalizeMessages(messages, "").map((message) => `${message.role}: ${message.content}`).join("\n\n"),
  ].join("\n");
  const text = await polishWithCodexCli(prompt, options.targetWorkspace || __dirname);
  return {
    text: String(text || "").trim(),
    provider: "codex",
    model: CODEX_PILOT_MODEL || "Codex Desktop app-server",
  };
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

function formatSpokenLists(text, writingStyle = "coding") {
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

function applyWritingStyle(text, writingStyle = "coding") {
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
  if (PROVIDER === "codex") {
    return completeCodexCli(messages, systemPrompt, options);
  }

  if (PROVIDER === "openai" && process.env.OPENAI_API_KEY) {
    return completeOpenAI(messages, systemPrompt, options);
  }

  throw new Error("Codex text generation is not available for speech cleanup.");
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
            "Clean this into the user message that should be sent to the coding assistant.",
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
  await readJson(req);
  sendSseHeaders(res);
  sse(res, "error", {
    message: "The local assistant LLM route is disabled. Use /api/codex/exec so Codexa runs through OpenClaw and Codex.",
  });
  sse(res, "done", {});
  res.end();
}

function codexPilotAvailable() {
  return CODEX_PILOT_ENABLED && fs.existsSync(CODEX_PILOT_COMMAND);
}

function resolveCodexPilotCommand() {
  return process.env.CODEX_PILOT_COMMAND?.trim() || process.env.CODEX_CLI_PATH?.trim() || CODEX_DESKTOP_COMMAND;
}

function resolveCodexHomeDir() {
  const explicit =
    process.env.CODEX_PILOT_HOME?.trim() ||
    process.env.CODEXA_CODEX_HOME?.trim() ||
    process.env.CODEX_AUTH_HOME?.trim() ||
    process.env.CODEX_HOME?.trim();
  const candidate = explicit && !explicit.includes(`${path.sep}.openclaw${path.sep}`) ? explicit : path.join(os.homedir(), ".codex");
  return path.resolve(expandHomePath(candidate));
}

function codexSubprocessEnv(extra = {}) {
  return {
    ...process.env,
    CODEX_HOME: CODEX_HOME_DIR,
    CODEX_CLI_PATH: CODEX_PILOT_COMMAND,
    CODEX_CLI: CODEX_PILOT_COMMAND,
    CODEX_COMMAND: CODEX_PILOT_COMMAND,
    OPENCLAW_CODEX_CLI: CODEX_PILOT_COMMAND,
    OPENCLAW_CODEX_APP_SERVER_BIN: CODEX_PILOT_COMMAND,
    PATH: `${path.dirname(CODEX_PILOT_COMMAND)}${path.delimiter}${process.env.PATH || ""}`,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...extra,
  };
}

function resolveCodexAppChatCommand() {
  return CODEX_PILOT_COMMAND;
}

function codexAppChatAvailable() {
  return CODEX_APP_CHAT_REGISTRATION && fs.existsSync(CODEX_APP_CHAT_COMMAND);
}

function openClawAvailable() {
  return fs.existsSync(OPENCLAW_COMMAND);
}

function openClawConfigPath() {
  return path.resolve(expandHomePath(process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json")));
}

function openClawConfiguredPrimaryModel() {
  try {
    const config = JSON.parse(fs.readFileSync(openClawConfigPath(), "utf8"));
    return config?.agents?.defaults?.model?.primary || "";
  } catch {
    return "";
  }
}

function openClawStatusPayload() {
  return {
    available: openClawAvailable(),
    command: OPENCLAW_COMMAND,
    configPath: openClawConfigPath(),
    controllerModel: openClawConfiguredPrimaryModel() || "default",
    codexCliCommand: CODEX_PILOT_COMMAND,
    codexHome: CODEX_HOME_DIR,
    codexAppServerCommand: CODEX_PILOT_COMMAND,
    localMode: OPENCLAW_LOCAL,
    timeoutSecs: OPENCLAW_TIMEOUT_SECS,
    thinking: OPENCLAW_THINKING,
    sessionPrefix: OPENCLAW_SESSION_PREFIX,
    purpose:
      "Routes voice turns through the official OpenClaw install to control Codex via the Codex onboarding/runtime path. Local model providers are disabled for this route. No fallback path is allowed.",
  };
}

function normalizeControlProvider(value) {
  const raw = String(value || CODEX_CONTROL_PROVIDER || "openclaw").toLowerCase();
  if (raw === "openclaw") return raw;
  return "openclaw";
}

function activeControlProvider(input, client) {
  return normalizeControlProvider(input || client?.control_provider || client?.controlProvider);
}

function isWithinDirectory(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function requestedWorkspaceFrom(body = {}, client = {}) {
  return safeText(
    body.workspaceDir ||
      body.workspace_dir ||
      client.workspace_dir ||
      client.workspaceDir ||
      client.target_workspace ||
      client.targetWorkspace,
  );
}

function generatedWorkspaceName(client = {}) {
  const base = safeText(client.project_name || client.session_title || client.session_id, "voice-project");
  const safeBase = safeId(base, "voice-project");
  return safeBase;
}

function resolveCodexWorkspace(body = {}, client = {}) {
  const explicit = requestedWorkspaceFrom(body, client);
  const projectMode = String(client.project_mode || client.projectMode || body.projectMode || "").toLowerCase();
  const target = explicit
    ? path.resolve(explicit)
    : projectMode === "new_project"
      ? path.resolve(CODEX_WORKSPACE_ROOT, generatedWorkspaceName(client))
      : __dirname;

  const repoRoot = path.resolve(__dirname);
  const generatedRoot = path.resolve(CODEX_WORKSPACE_ROOT);
  const legacyGeneratedRoot = path.resolve(LEGACY_CODEX_WORKSPACE_ROOT);
  if (!isWithinDirectory(target, repoRoot) && !isWithinDirectory(target, generatedRoot) && !isWithinDirectory(target, legacyGeneratedRoot)) {
    throw new Error(`Workspace is outside the allowed roots: ${target}`);
  }

  fs.mkdirSync(target, { recursive: true });
  return target;
}

function resolveCodexTimeoutMs(body = {}, client = {}) {
  const requested = Number(
    body.timeoutMs ||
      body.timeout_ms ||
      client.codex_timeout_ms ||
      client.codexTimeoutMs ||
      client.timeout_ms ||
      client.timeoutMs,
  );
  if (!Number.isFinite(requested) || requested <= 0) return CODEX_PILOT_TIMEOUT_MS;
  return Math.min(900000, Math.max(15000, Math.round(requested)));
}

function openClawSessionKey(client = {}) {
  const explicit = String(client?.openclaw_session_key || client?.openClawSessionKey || "").trim();
  if (explicit) return explicit;
  const project = String(client?.project_name || "default")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
  const session = String(client?.session_id || "main")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "main";
  return `${OPENCLAW_SESSION_PREFIX}:${project}:${session}`;
}

function buildCodexPilotPrompt({ messages, systemPrompt, client, targetWorkspace = __dirname }) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const recent = safeMessages
    .filter((message) => message && typeof message.content === "string" && ["user", "assistant", "system"].includes(message.role))
    .slice(-CODEX_PILOT_MAX_CONTEXT_MESSAGES)
    .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
    .join("\n\n");
  const latestUser = [...safeMessages].reverse().find((message) => message?.role === "user" && message.content)?.content ?? "";

  return [
    CODEX_PILOT_SYSTEM_PROMPT,
    "",
    "Voice-agent system prompt currently visible in the desktop UI:",
    systemPrompt || DEFAULT_AGENT_PROMPT,
    "",
    "Client/session context:",
    JSON.stringify(
      {
        voice_assistant_repo: __dirname,
        target_workspace: targetWorkspace,
        generated_workspace_root: CODEX_WORKSPACE_ROOT,
        user_id: client?.user_id ?? null,
        user_name: client?.user_name ?? null,
        session_id: client?.session_id ?? null,
        session_title: client?.session_title ?? null,
        project_name: client?.project_name ?? null,
        project_mode: client?.project_mode ?? null,
        control_provider: client?.control_provider ?? null,
        voice_command: true,
        raw_speech_text: client?.raw_speech_text ?? null,
        speech_intent: client?.speech_intent?.text ?? null,
      },
      null,
      2,
    ),
    "",
    "Workspace execution contract:",
    `- Run commands from target_workspace: ${targetWorkspace}`,
    "- For code/build requests, create or edit actual files in target_workspace.",
    "- If this is a new project workspace, bootstrap a minimal complete app with tests/checks.",
    "- Do not hardcode a calculator, greeting, canned response, or one-off demo path; implement the user's requested app/task generically.",
    "- After editing, run focused checks from target_workspace and report exact files changed plus pass/fail.",
    "",
    "Recent conversation:",
    recent || "(none)",
    "",
    "Latest user instruction to satisfy now:",
    latestUser,
  ].join("\n");
}

function buildOpenClawPilotPrompt({ messages, systemPrompt, client, targetWorkspace = __dirname }) {
  return [
    "You are the OpenClaw control plane underneath an agentic coding voice assistant.",
    "The user is speaking to a voice agent. Your job is to route and supervise system, repo, browser, and app-operation requests.",
    "Use OpenClaw's Codex onboarding/runtime path as the reasoning and coding engine.",
    "Expected OpenClaw model route: openai/gpt-5.5 through the Codex app-server harness.",
    "Do not route this turn through Ollama or any local model provider.",
    `Codex Desktop home for app visibility: ${CODEX_HOME_DIR}`,
    "Never satisfy coding changes with an OpenClaw-only direct-edit path if the Codex harness/auth/runtime fails.",
    "If Codex harness delegation fails, stop and return a clear failure beginning with CODEX_HARNESS_DELEGATION_FAILED.",
    "Treat this as a voice-command turn: do the useful work, then return a concise spoken summary.",
    "",
    "Important operating context:",
    JSON.stringify(
      {
        voice_assistant_repo: __dirname,
        target_workspace: targetWorkspace,
        generated_workspace_root: CODEX_WORKSPACE_ROOT,
        current_project: client?.project_name ?? null,
        current_chat_session_id: client?.session_id ?? null,
        current_chat_title: client?.session_title ?? null,
        user_id: client?.user_id ?? null,
        user_name: client?.user_name ?? null,
        route: "openclaw_control_plane",
      },
      null,
      2,
    ),
    "",
    "If the task needs code changes or tests, use the OpenClaw Codex harness rather than editing from an OpenClaw-only path.",
    "If the task needs desktop/browser operation or broader system state without code changes, use OpenClaw's local/system/browser tools directly and do not invent a coding turn.",
    "Use Codex-backed OpenClaw reasoning for planning and coding. Local model frameworks are intentionally disabled for this app.",
    "Operate in target_workspace above unless the user explicitly asks to modify the voice assistant repo.",
    "Do not hardcode one-off demos; implement the user's requested task as real editable files with checks.",
    "Keep the final answer short enough to speak out loud.",
    "",
    "Visible voice-assistant system prompt:",
    systemPrompt || DEFAULT_AGENT_PROMPT,
    "",
    "Original Codex pilot prompt for this turn:",
    buildCodexPilotPrompt({ messages, systemPrompt, client, targetWorkspace }),
  ].join("\n");
}

function runOpenClawAgent(prompt, client = {}, targetWorkspace = __dirname) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    let settled = false;
    const args = [
      "agent",
      "--session-key",
      openClawSessionKey(client),
      "--message",
      prompt,
      "--json",
      "--timeout",
      String(Math.max(15, OPENCLAW_TIMEOUT_SECS)),
    ];
    if (OPENCLAW_LOCAL) args.splice(1, 0, "--local");
    if (OPENCLAW_THINKING) args.push("--thinking", OPENCLAW_THINKING);

    const child = spawn(OPENCLAW_COMMAND, args, {
      cwd: targetWorkspace,
      env: codexSubprocessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        text: "",
        error: `OpenClaw timed out after ${Math.max(15, OPENCLAW_TIMEOUT_SECS)} seconds`,
        durationMs: Math.round(performance.now() - startedAt),
        stderr,
      });
    }, Math.max(15, OPENCLAW_TIMEOUT_SECS) * 1000 + 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        text: "",
        error: error instanceof Error ? error.message : String(error),
        durationMs: Math.round(performance.now() - startedAt),
        stderr,
      });
    });
    child.on("exit", (exitCode) => {
      let parsed = null;
      try {
        const firstJson = stdout.indexOf("{");
        parsed = firstJson >= 0 ? JSON.parse(stdout.slice(firstJson)) : null;
      } catch {
        parsed = null;
      }
      const text = extractOpenClawFinalText(parsed);
      finish({
        ok: exitCode === 0 && Boolean(text),
        text,
        exitCode,
        parsed,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}

function openClawEnvelope(parsed) {
  return parsed?.result && typeof parsed.result === "object" ? parsed.result : parsed || {};
}

function extractOpenClawFinalText(parsed) {
  const envelope = openClawEnvelope(parsed);
  const finalText = envelope?.meta?.finalAssistantVisibleText || envelope?.meta?.finalAssistantRawText;
  if (typeof finalText === "string" && finalText.trim()) return finalText.trim();

  return (envelope?.payloads || [])
    .map((payload) => payload?.text)
    .filter((text) => typeof text === "string" && text.trim())
    .join("\n")
    .trim();
}

function openClawBypassedAuthenticatedCodex(result = {}) {
  const envelope = openClawEnvelope(result.parsed);
  const payloadText = Array.isArray(envelope?.payloads)
    ? envelope.payloads
        .slice(-6)
        .map((payload) => payload?.text)
        .filter(Boolean)
        .join("\n")
    : "";
  const text = truncateText([result.text, result.error, result.stderr, payloadText].filter(Boolean).join("\n"), 10000);
  return /CODEX_CLI_DELEGATION_FAILED|Codex CLI was unavailable|missing API authentication|Missing bearer|401 Unauthorized|OpenAI API authentication|completed .* directly in the target workspace|completed .* directly.*without Codex/i.test(text);
}

function openClawSessionLogPath(sessionId) {
  if (!sessionId || !/^[a-z0-9-]+$/i.test(sessionId)) return "";
  const openClawHome = path.resolve(expandHomePath(process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw")));
  return path.join(openClawHome, "agents", "main", "sessions", `${sessionId}.jsonl`);
}

function extractOpenClawToolCommands(sessionLogPath) {
  if (!sessionLogPath || !fs.existsSync(sessionLogPath)) return [];
  const commands = [];
  for (const line of fs.readFileSync(sessionLogPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const content = event?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        const command = item?.arguments?.command || item?.input?.command;
        if (typeof command === "string" && command.trim()) commands.push(command);
      }
    } catch {
      // OpenClaw logs are best-effort verification inputs.
    }
  }
  return commands;
}

function openClawUsedAuthenticatedCodexExec(result = {}, targetWorkspace = __dirname) {
  const meta = openClawEnvelope(result.parsed)?.meta || {};
  const agentMeta = meta.agentMeta || {};
  const executionTrace = meta.executionTrace || {};
  const provider = String(agentMeta.provider || executionTrace.winnerProvider || "");
  const harnessId = String(agentMeta.agentHarnessId || executionTrace.runner || "");
  const model = String(agentMeta.model || executionTrace.winnerModel || "");
  if (provider === "openai-codex" || harnessId === "codex") {
    return {
      ok: true,
      sessionId: agentMeta.sessionId || null,
      logPath: null,
      matchedCommand: "",
      reason: "",
      provider,
      model,
      harnessId,
    };
  }

  const sessionId = agentMeta.sessionId;
  const logPath = openClawSessionLogPath(sessionId);
  const commands = extractOpenClawToolCommands(logPath);
  const target = path.resolve(targetWorkspace);
  const matched = commands.find((command) => {
    return (
      command.includes(CODEX_PILOT_COMMAND) &&
      command.includes(CODEX_HOME_DIR) &&
      command.includes(target) &&
      /\bexec\b/.test(command)
    );
  });
  return {
    ok: Boolean(matched),
    sessionId: sessionId || null,
    logPath: logPath || null,
    matchedCommand: matched || "",
    reason: matched
      ? ""
      : `OpenClaw session ${sessionId || "(missing)"} did not show the Codex harness or an authenticated Codex exec command for ${target}.`,
  };
}

function requiresCodexCodingDelegation(messages = [], client = {}) {
  const latest = latestUserContent(messages).toLowerCase();
  const projectMode = String(client?.project_mode || client?.projectMode || "").toLowerCase();
  if (projectMode === "new_project") return true;
  return /\b(code|coding|repo|repository|project|app|website|game|calculator|react|vite|next|python|file|files|folder|folders|edit|modify|patch|implement|build|create|scaffold|bootstrap|fix|debug|test|tests|lint|commit|push|git|npm|package\.json|readme|workspace)\b/.test(
    latest,
  );
}

function latestUserContent(messages = []) {
  return [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message?.role === "user" && message.content)?.content ?? "";
}

function truncateText(value, maxLength = 3000) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 20).trim()}... [truncated]`;
}

function compactForPolish(value, maxLength = RESPONSE_POLISH_MAX_INPUT_CHARS) {
  const text = String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (text.length <= maxLength) return text;
  const head = text.slice(0, Math.floor(maxLength * 0.35)).trim();
  const tail = text.slice(text.length - Math.floor(maxLength * 0.6)).trim();
  return `${head}\n\n[middle omitted]\n\n${tail}`;
}

function cleanAssistantSummaryFallback(value) {
  const text = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:file:|app:|\/|https?:\/\/localhost|https?:\/\/127\.0\.0\.1)[^)]+\)/g, "$1")
    .replace(/\/Users\/[^\s),;]+/g, "the workspace")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .replace(/\b[0-9a-f]{24,}\b/gi, "")
    .replace(/\b(?:thread|session|run|trace|request)[_-]?[a-z0-9]{12,}\b/gi, "")
    .replace(/\b\d{10,}\b/g, "")
    .replace(/^\s*(event|data|debug|trace|stdout|stderr)\s*:\s*.*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  const words = text.split(/\s+/).filter(Boolean);
  const digitHeavy = text.replace(/\D/g, "").length > Math.max(20, text.length * 0.25);
  if (words.length < 3 || digitHeavy) return "I finished the coding turn, but the raw model summary was too noisy to speak clearly.";
  return text.slice(0, 1800);
}

function buildResponsePolishPrompt({ text, messages, client = {}, targetWorkspace = __dirname }) {
  return [
    "Rewrite this raw coding-agent transcript into the final answer for a voice/text coding assistant.",
    "The answer will be shown in the chat UI and spoken aloud with text-to-speech.",
    "",
    "Rules:",
    "- Return only the final user-facing answer.",
    "- Do not include thread IDs, UUIDs, timestamps, raw JSON, random numbers, debug logs, command output, or internal tool chatter.",
    "- Do not mention that you are rewriting or polishing.",
    "- Preserve what matters: what was changed, what was created, checks run, and any concrete blocker.",
    "- Keep it concise: one short paragraph or 2-6 bullets.",
    "- Use plain language that sounds natural when spoken aloud.",
    "",
    "Latest user request:",
    latestUserContent(messages) || "(unknown)",
    "",
    "Client context:",
    JSON.stringify(
      {
        project: client?.project_name ?? null,
        session: client?.session_title ?? null,
        workspace: targetWorkspace,
      },
      null,
      2,
    ),
    "",
    "Raw transcript to rewrite:",
    compactForPolish(text),
  ].join("\n");
}

function parseCodexFinalFromJsonl(stdout) {
  let finalText = "";
  for (const rawLine of String(stdout || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && parsed.item.text) {
        finalText = String(parsed.item.text).trim();
      }
    } catch {
      // Ignore CLI diagnostics.
    }
  }
  return finalText;
}

function polishWithCodexCli(prompt, targetWorkspace = __dirname) {
  return new Promise((resolve, reject) => {
    if (!codexPilotAvailable()) {
      reject(new Error("Codex CLI is not available for response polishing."));
      return;
    }

    const args = [];
    if (CODEX_PILOT_MODEL) args.push("-m", CODEX_PILOT_MODEL);
    args.push(
      "-a",
      CODEX_PILOT_APPROVAL,
      "exec",
      ...codexWorkspaceTrustArgs(targetWorkspace),
      "--json",
      "--cd",
      targetWorkspace,
      "--sandbox",
      "read-only",
      "-",
    );

    const child = spawn(CODEX_PILOT_COMMAND, args, {
      cwd: targetWorkspace,
      env: codexSubprocessEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(text);
    };
    const timeout = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGTERM");
      finish(new Error("Response polishing timed out."));
    }, RESPONSE_POLISH_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      const text = parseCodexFinalFromJsonl(stdout);
      if (text) {
        finish(null, text);
        return;
      }
      finish(new Error(`Response polish Codex exited with code ${code}.${stderr ? ` ${stderr.slice(-500)}` : ""}`));
    });
    child.stdin.end(prompt);
  });
}

async function polishAssistantResponse({ text, messages = [], client = {}, targetWorkspace = __dirname }) {
  const fallback = cleanAssistantSummaryFallback(text);
  if (!String(text || "").trim()) return "";

  const provider = String(RESPONSE_POLISH_PROVIDER || "off").toLowerCase();
  const prompt = buildResponsePolishPrompt({ text, messages, client, targetWorkspace });

  try {
    if (provider === "openai" || provider === "auto") {
      if (process.env.OPENAI_API_KEY) {
        const result = await completeOpenAI([{ role: "user", content: prompt }], "You rewrite noisy coding-agent output into clear final answers.", {
          timeoutMs: RESPONSE_POLISH_TIMEOUT_MS,
          maxTokens: 420,
          temperature: 0.05,
        });
        return cleanAssistantSummaryFallback(result.text) || fallback;
      }
      if (provider === "openai") return fallback;
    }

    if ((provider === "codex" || provider === "auto") && codexPilotAvailable()) {
      const polished = await polishWithCodexCli(prompt, targetWorkspace);
      return cleanAssistantSummaryFallback(polished) || fallback;
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function collectWorkspaceEvidence(targetWorkspace) {
  const evidence = { gitStatus: "", files: [] };
  try {
    const git = spawnSync("git", ["-C", targetWorkspace, "status", "--short"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    if (git.status === 0) evidence.gitStatus = git.stdout.trim();
  } catch {
    evidence.gitStatus = "";
  }

  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "test-results"]);
  const walk = (dir, prefix = "") => {
    if (evidence.files.length >= 80) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (evidence.files.length >= 80) return;
      if (ignored.has(entry.name)) continue;
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolutePath, relativePath);
      else if (entry.isFile()) evidence.files.push(relativePath);
    }
  };

  walk(targetWorkspace);
  return evidence;
}

function codexStateDbPath() {
  if (CODEX_STATE_DB && fs.existsSync(CODEX_STATE_DB)) return CODEX_STATE_DB;
  const codexHome = path.join(os.homedir(), ".codex");
  try {
    const candidates = fs
      .readdirSync(codexHome)
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .map((name) => path.join(codexHome, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0] || path.join(codexHome, "state_5.sqlite");
  } catch {
    return path.join(codexHome, "state_5.sqlite");
  }
}

function sqliteQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function codexAppChatExists(targetWorkspace) {
  const dbPath = codexStateDbPath();
  if (!fs.existsSync(dbPath)) return false;
  try {
    const result = spawnSync(
      "sqlite3",
      [
        dbPath,
        `select 1 from threads where cwd = ${sqliteQuote(targetWorkspace)} and source in ('vscode','app') limit 1;`,
      ],
      { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return result.status === 0 && result.stdout.trim() === "1";
  } catch {
    return false;
  }
}

function shouldRegisterCodexAppChat(targetWorkspace, client = {}) {
  if (!CODEX_APP_CHAT_REGISTRATION || !targetWorkspace) return false;
  const repoRoot = path.resolve(__dirname);
  const generatedRoot = path.resolve(CODEX_WORKSPACE_ROOT);
  const legacyGeneratedRoot = path.resolve(LEGACY_CODEX_WORKSPACE_ROOT);
  const resolved = path.resolve(targetWorkspace);
  return (
    resolved === repoRoot ||
    isWithinDirectory(path.resolve(targetWorkspace), generatedRoot) ||
    isWithinDirectory(path.resolve(targetWorkspace), legacyGeneratedRoot)
  );
}

function isGeneratedCodexWorkspace(targetWorkspace) {
  if (!targetWorkspace) return false;
  const resolved = path.resolve(targetWorkspace);
  const generatedRoot = path.resolve(CODEX_WORKSPACE_ROOT);
  const legacyGeneratedRoot = path.resolve(LEGACY_CODEX_WORKSPACE_ROOT);
  return isWithinDirectory(resolved, generatedRoot) || isWithinDirectory(resolved, legacyGeneratedRoot);
}

function codexWorkspaceTrustArgs(targetWorkspace) {
  return isGeneratedCodexWorkspace(targetWorkspace) ? ["--skip-git-repo-check"] : [];
}

function ensureGeneratedWorkspaceLooksLikeCodexProject(targetWorkspace) {
  if (!isGeneratedCodexWorkspace(targetWorkspace)) return { gitInitialized: false };
  fs.mkdirSync(targetWorkspace, { recursive: true });

  const gitDir = path.join(targetWorkspace, ".git");
  if (fs.existsSync(gitDir)) return { gitInitialized: false };

  const init = spawnSync("git", ["init"], {
    cwd: targetWorkspace,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 128 * 1024,
  });

  if (init.status !== 0) {
    return {
      gitInitialized: false,
      error: init.stderr?.trim() || init.stdout?.trim() || "git init failed",
    };
  }

  const gitignorePath = path.join(targetWorkspace, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      ["node_modules/", "dist/", "build/", "coverage/", ".env", ".DS_Store", ""].join("\n"),
    );
  }

  return { gitInitialized: true };
}

function openCodexDesktopGeneratedWorkspace(targetWorkspace) {
  if (!CODEX_APP_OPEN_GENERATED_WORKSPACES || !isGeneratedCodexWorkspace(targetWorkspace)) return { opened: false };
  if (!fs.existsSync(CODEX_APP_CHAT_COMMAND)) return { opened: false, error: "codex command unavailable" };

  try {
    const result = spawnSync(CODEX_APP_CHAT_COMMAND, ["app", targetWorkspace], {
      cwd: targetWorkspace,
      env: codexSubprocessEnv(),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 256 * 1024,
    });
    return {
      opened: result.status === 0,
      error: result.status === 0 ? "" : result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`,
    };
  } catch (error) {
    return { opened: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildCodexAppChatRegistrationMessage({ messages, client = {}, targetWorkspace, result }) {
  const latestUser = latestUserContent(messages);
  const evidence = collectWorkspaceEvidence(targetWorkspace);
  const projectName = path.basename(targetWorkspace);
  const keyFiles = evidence.files.slice(0, 24);
  return [
    `Project visibility check for ${projectName}. Do not edit files.`,
    "",
    "This Codex chat mirrors a Codexa interaction so the generated project appears in the normal Codex project history.",
    "Reply with a concise confirmation only.",
    "",
    "Project context:",
    JSON.stringify(
      {
        route: "Codexa desktop app -> OpenClaw controller -> Codex CLI coding engine",
        workspace: targetWorkspace,
        project: client?.project_name ?? null,
        chat_session_id: client?.session_id ?? null,
        chat_title: client?.session_title ?? null,
        openclaw_session_key: openClawSessionKey(client),
        user_request: truncateText(latestUser, 900),
      },
      null,
      2,
    ),
    "",
    "Workspace evidence:",
    JSON.stringify(
      {
        git_status_short: evidence.gitStatus || null,
        files_seen: keyFiles,
      },
      null,
      2,
    ),
    "",
    "OpenClaw spoken result:",
    truncateText(result?.text || "", 1200),
    "",
    `Return exactly: ${projectName} Codex chat ready.`,
  ].join("\n");
}

function registerCodexAppChatForWorkspace({ messages, client, targetWorkspace, result }) {
  if (!shouldRegisterCodexAppChat(targetWorkspace, client)) return { queued: false, reason: "not_codex_workspace" };
  if (!codexAppChatAvailable()) return { queued: false, reason: "disabled_or_unavailable" };

  const projectShape = ensureGeneratedWorkspaceLooksLikeCodexProject(targetWorkspace);
  const registrationDir = path.join(__dirname, "tmp", "codex-app-chat-registration");
  fs.mkdirSync(registrationDir, { recursive: true });
  const logPath = path.join(registrationDir, `${Date.now()}-${randomUUID()}.log`);
  const out = fs.openSync(logPath, "a");
  const desktopOpen = openCodexDesktopGeneratedWorkspace(targetWorkspace);
  if (projectShape.gitInitialized || projectShape.error) {
    fs.writeSync(out, `[codexa] project-shape ${JSON.stringify(projectShape)}\n`);
  }
  if (desktopOpen.opened || desktopOpen.error) {
    fs.writeSync(out, `[codexa] desktop-open ${JSON.stringify(desktopOpen)}\n`);
  }
  const args = ["debug", "app-server", "send-message-v2", buildCodexAppChatRegistrationMessage({ messages, client, targetWorkspace, result })];

  const child = spawn(CODEX_APP_CHAT_COMMAND, args, {
    cwd: targetWorkspace,
    env: codexSubprocessEnv(),
    stdio: ["pipe", out, out],
  });

  const timeout = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  }, CODEX_APP_CHAT_TIMEOUT_MS);

  child.on("close", () => {
    clearTimeout(timeout);
    try {
      fs.closeSync(out);
    } catch {
      // Best-effort app chat registration only.
    }
  });
  child.on("error", () => {
    clearTimeout(timeout);
    try {
      fs.closeSync(out);
    } catch {
      // Best-effort app chat registration only.
    }
  });

  return { queued: true, logPath, desktopOpen };
}

function streamCodexJsonLine(res, line, state) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  if (parsed.type === "thread.started") {
    state.threadId = parsed.thread_id;
    sse(res, "meta", { provider: "codex", model: CODEX_PILOT_MODEL || "default", threadId: parsed.thread_id });
    return;
  }

  if (parsed.type === "item.completed") {
    const item = parsed.item || {};
    if (item.type === "agent_message" && item.text) {
      const text = String(item.text).trim();
      if (text) {
        state.finalText = text;
        if (Array.isArray(state.agentMessages)) state.agentMessages.push(text);
      }
      return;
    }

    if (item.type === "command_execution" || item.type === "tool_call") {
      const label = item.name || item.command || "tool";
      sse(res, "codex_event", { label, status: "completed" });
    }
  }
}

function writeOpenAIChunk(res, id, delta = {}, finishReason = null) {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: CODEX_PILOT_MODEL || "codex-pilot",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function extractPhoneMessages(messages = []) {
  return Array.isArray(messages)
    ? messages
        .filter((message) => message && typeof message.content === "string" && ["user", "assistant", "system"].includes(message.role))
        .slice(-CODEX_PILOT_MAX_CONTEXT_MESSAGES)
    : [];
}

function buildPhoneCodexPrompt(messages = []) {
  const recent = extractPhoneMessages(messages)
    .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
    .join("\n\n");
  const latestUser = [...extractPhoneMessages(messages)].reverse().find((message) => message.role === "user")?.content ?? "";

  return [
    CODEX_PILOT_SYSTEM_PROMPT,
    "",
    "You are currently powering an agentic coding assistant over a phone call through Twilio and Pipecat.",
    "Act like a concise coding receptionist for this repo: answer what you are doing, inspect/edit/test when asked, and summarize results in spoken language.",
    "Keep the final response short enough to be read over a phone call. Avoid markdown tables and long logs.",
    "",
    "Recent phone conversation:",
    recent || "(none)",
    "",
    "Latest caller request to satisfy now:",
    latestUser,
  ].join("\n");
}

function decodeOpenAICompatibleSse(payload) {
  let content = "";
  const events = [];
  for (const block of String(payload || "").split(/\n\n+/)) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        events.push(parsed);
        content += parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      } catch {
        events.push({ raw: data });
      }
    }
  }
  return { content: content.trim(), events };
}

function twilioConfigured() {
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_PHONE_NUMBER);
}

function twilioVoiceStreamUrl(req) {
  if (PIPECAT_PUBLIC_WS_URL) return PIPECAT_PUBLIC_WS_URL;
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `wss://${host}${PIPECAT_WS_PATH}`;
}

function twilioWebhookUrl(pathname) {
  const base = TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, "");
  return base ? `${base}${pathname}` : pathname;
}

function sendTwilioSms({ to, from, body }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !from || !to || !body) {
    return Promise.resolve({ ok: false, reason: "missing_twilio_config" });
  }

  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      From: from,
      To: to,
      Body: body.slice(0, TWILIO_SMS_MAX_BODY_CHARS),
      ...(TWILIO_SMS_STATUS_CALLBACK_URL ? { StatusCallback: TWILIO_SMS_STATUS_CALLBACK_URL } : {}),
    }),
  })
    .then(async (response) => ({ ok: response.ok, status: response.status, body: await response.text() }))
    .catch((error) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
}

async function completeSmsAssistantText(messages, client) {
  const prompt = buildPhoneCodexPrompt(messages);
  const controlProvider = activeControlProvider(PHONE_CODEX_CONTROL_PROVIDER, client);

  if (controlProvider === "openclaw") {
    if (!openClawAvailable()) {
      throw new Error(`OpenClaw is not available at ${OPENCLAW_COMMAND}. No fallback path is allowed.`);
    }
    const result = await runOpenClawAgent(
      [
        "You are powering an agentic coding assistant over SMS.",
        "Use OpenClaw to control Codex/system tools when useful, then return a concise text-message response.",
        "",
        prompt,
      ].join("\n"),
      client,
      __dirname,
    );
    const text = result.ok && !openClawBypassedAuthenticatedCodex(result)
      ? result.text
      : `OpenClaw control failed and I could not complete the SMS request. No fallback path is allowed. ${result.error || result.stderr?.trim().split("\n").filter(Boolean).slice(-1)[0] || "Authenticated Codex CLI delegation failed."}`.trim();
    const polishedText = await polishAssistantResponse({
      text,
      messages,
      client,
      targetWorkspace: __dirname,
    });
    return polishedText || text;
  }

  const response = await fetch(`http://127.0.0.1:${port}/api/phone/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer local-codex",
    },
    body: JSON.stringify({
      model: "codex-pilot",
      stream: true,
      controlProvider: "codex",
      messages,
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`SMS Codex bridge failed ${response.status}: ${raw.slice(0, 300)}`);
  const { content } = decodeOpenAICompatibleSse(raw);
  return content || "I finished, but could not summarize the result clearly.";
}

async function runSmsAssistantTurn({ sessionId, from, to, messages }) {
  const client = {
    project_name: "SMS coding assistant",
    session_id: sessionId,
    user_id: safeId(`sms_${from}`, "sms_caller"),
    control_provider: PHONE_CODEX_CONTROL_PROVIDER,
  };

  try {
    const text = await completeSmsAssistantText(messages, client);
    await saveAndSendSmsAssistantReply({ sessionId, from, to, text });
  } catch (error) {
    const text = `I hit an error while working on that SMS request: ${error instanceof Error ? error.message : String(error)}`.slice(0, TWILIO_SMS_MAX_BODY_CHARS);
    await saveAndSendSmsAssistantReply({ sessionId, from, to, text });
  }
}

async function saveAndSendSmsAssistantReply({ sessionId, from, to, text }) {
  appendVoiceSessionMessage(sessionId, {
    role: "assistant",
    content: text,
    source: "sms_bridge",
    route: "codex_pilot",
  });
  const result = await sendTwilioSms({ to: from, from: to || TWILIO_PHONE_NUMBER, body: text });
  if (!result.ok) {
    console.error("twilio sms send failed", {
      status: result.status || null,
      reason: result.reason || "twilio_api_error",
    });
  }
}

async function twilioParams(req, url) {
  const query = Object.fromEntries(url.searchParams);
  if (req.method === "GET") return query;
  const type = String(req.headers["content-type"] || "");
  if (type.includes("application/json")) return { ...query, ...(await readJson(req)) };
  return { ...query, ...(await readForm(req)) };
}

async function handleTwilioVoiceWebhook(req, res) {
  const streamUrl = twilioVoiceStreamUrl(req);
  sendTwiML(
    res,
    `<Connect><Stream url="${xmlEscape(streamUrl)}" /></Connect>`,
  );
}

async function handleTwilioSmsWebhook(req, res, url) {
  const params = await twilioParams(req, url);
  const body = safeText(params.Body);
  const from = safeText(params.From, "unknown");
  const to = safeText(params.To, TWILIO_PHONE_NUMBER);
  const messageSid = safeText(params.MessageSid || params.SmsMessageSid || params.SmsSid);
  const userId = safeId(`sms_${from}`, "sms_caller");

  if (/\b(no-sms|smoke test)\b/i.test(body)) {
    sendTwiML(res, "<Message>no-sms webhook ready</Message>");
    return;
  }

  if (!body) {
    sendTwiML(res, "<Message>Send me a coding request and I will work on it through Codex.</Message>");
    return;
  }

  const session = findOrCreateTelephonySession({
    source: "sms_bridge",
    userId,
    userName: from,
    projectName: "SMS coding assistant",
    title: sessionTitleFromText(body, "SMS coding request"),
  });

  if (messageSid && voiceSessionHasExternalMessage(session.id, messageSid)) {
    sendTwiML(res, "<Message>I already received this request and am working on it.</Message>");
    return;
  }

  const appended = appendVoiceSessionMessage(session.id, {
    role: "user",
    content: body,
    source: "sms_bridge",
    route: "codex_pilot",
    externalId: messageSid,
  });
  const messages = appended?.session?.messages || [{ role: "user", content: body }];

  sendTwiML(res, "<Message>Got it. I am working through Codex and will text back with the result.</Message>");
  setImmediate(() => {
    runSmsAssistantTurn({ sessionId: session.id, from, to, messages }).catch((error) => {
      console.error("sms assistant turn failed", error);
    });
  });
}

function handleTwilioStatus(res) {
  json(res, 200, {
    configured: twilioConfigured(),
    phoneNumber: TWILIO_PHONE_NUMBER || null,
    statusPath: TWILIO_STATUS_PATH,
    voiceWebhookPath: TWILIO_VOICE_PATH,
    smsWebhookPath: TWILIO_SMS_PATH,
    voiceWebhookUrl: twilioWebhookUrl(TWILIO_VOICE_PATH),
    smsWebhookUrl: twilioWebhookUrl(TWILIO_SMS_PATH),
    mediaStreamUrl: PIPECAT_PUBLIC_WS_URL || null,
    localMediaStreamProxy: `${PIPECAT_WS_PATH} -> ${PIPECAT_WS_PROXY_TARGET}${PIPECAT_WS_PATH}`,
    voiceRuntime: "Twilio Programmable Voice -> Media Stream -> Pipecat -> Codex bridge",
    smsRuntime: "Twilio Programmable Messaging -> app webhook -> OpenClaw/Codex -> outbound SMS",
  });
}

async function handlePhoneCodexCompletion(req, res) {
  const body = await readJson(req);
  const id = `chatcmpl-phone-${randomUUID()}`;
  const stream = body.stream !== false;

  if (!stream) {
    json(res, 400, { error: "Phone Codex bridge currently supports stream=true only." });
    return;
  }

  if (!CODEX_PILOT_ENABLED || !fs.existsSync(CODEX_PILOT_COMMAND)) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    writeOpenAIChunk(res, id, {
      role: "assistant",
      content: "Codex pilot is not available on this laptop yet.",
    });
    writeOpenAIChunk(res, id, {}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  writeOpenAIChunk(res, id, { role: "assistant" });

  const prompt = buildPhoneCodexPrompt(body.messages);
  const phoneControlProvider = activeControlProvider(body.controlProvider || PHONE_CODEX_CONTROL_PROVIDER, {
    project_name: "Phone coding assistant",
    session_id: "phone",
  });

  if (phoneControlProvider === "openclaw") {
    if (!openClawAvailable()) {
      writeOpenAIChunk(res, id, {
        content: `OpenClaw is not available at ${OPENCLAW_COMMAND}. No fallback path is allowed.`,
      });
      writeOpenAIChunk(res, id, {}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const result = await runOpenClawAgent(
      [
        "You are powering an agentic coding assistant over a phone call.",
        "Use OpenClaw to control Codex/system tools when useful, then return a concise spoken response.",
        "",
        prompt,
      ].join("\n"),
      {
        project_name: "Phone coding assistant",
        session_id: "phone",
        user_id: "phone_caller",
      },
      __dirname,
    );
    const text = result.ok && !openClawBypassedAuthenticatedCodex(result)
      ? result.text
      : `OpenClaw control failed and I could not complete the request. No fallback path is allowed. ${result.error || result.stderr?.trim().split("\n").filter(Boolean).slice(-1)[0] || "Authenticated Codex CLI delegation failed."}`.trim();
    const polishedText = await polishAssistantResponse({
      text,
      messages: body.messages,
      client: { project_name: "Phone coding assistant", session_id: "phone" },
      targetWorkspace: __dirname,
    });
    recordPhoneBridgeExchange(body.messages, polishedText || text);
    writeOpenAIChunk(res, id, { content: (polishedText || text).slice(0, 1800) });
    writeOpenAIChunk(res, id, {}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const args = [];
  if (CODEX_PILOT_MODEL) args.push("-m", CODEX_PILOT_MODEL);
  args.push("-a", CODEX_PILOT_APPROVAL);
  args.push("exec", "--json", "--cd", __dirname, "--sandbox", CODEX_PILOT_SANDBOX, "-");

  const child = spawn(CODEX_PILOT_COMMAND, args, {
    cwd: __dirname,
    env: codexSubprocessEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state = { finalText: "", sentFinal: false };
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    if (!state.sentFinal) {
      writeOpenAIChunk(res, id, {
        content: "Codex is still working and hit the phone response timeout. Ask me for status in a moment.",
      });
      state.sentFinal = true;
    }
  }, CODEX_PILOT_TIMEOUT_MS);

  let stdoutBuffer = "";
  let stderrBuffer = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && parsed.item.text) {
          state.finalText = String(parsed.item.text).trim();
        }
      } catch {
        // Ignore non-JSON diagnostics.
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  child.stdin.end(prompt);
  req.on("close", () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });

  child.on("error", (error) => {
    clearTimeout(timeout);
    if (!state.sentFinal) {
      writeOpenAIChunk(res, id, {
        content: `Codex failed to start: ${error instanceof Error ? error.message : "unknown error"}`,
      });
      state.sentFinal = true;
    }
    writeOpenAIChunk(res, id, {}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  });

  child.on("close", async (code) => {
    clearTimeout(timeout);
    if (stdoutBuffer.trim()) {
      try {
        const parsed = JSON.parse(stdoutBuffer.trim());
        if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && parsed.item.text) {
          state.finalText = String(parsed.item.text).trim();
        }
      } catch {
        // Ignore trailing partial diagnostics.
      }
    }

    if (!state.sentFinal) {
      const fallbackDetail = stderrBuffer.trim().split("\n").filter(Boolean).slice(-1)[0];
      const text =
        state.finalText ||
        (code === 0
          ? "Codex finished, but did not return a spoken summary."
          : `Codex exited with code ${code}.${fallbackDetail ? ` ${fallbackDetail}` : ""}`);
      const polishedText = await polishAssistantResponse({
        text,
        messages: body.messages,
        client: { project_name: "Phone coding assistant", session_id: "phone" },
        targetWorkspace: __dirname,
      });
      recordPhoneBridgeExchange(body.messages, polishedText || text);
      writeOpenAIChunk(res, id, { content: (polishedText || text).slice(0, 1800) });
      state.sentFinal = true;
    }
    writeOpenAIChunk(res, id, {}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  });
}

async function handleCodexPilot(req, res) {
  const body = await readJson(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemPrompt = typeof body.systemPrompt === "string" && body.systemPrompt.trim() ? body.systemPrompt.trim() : DEFAULT_AGENT_PROMPT;
  const client = body.client && typeof body.client === "object" ? body.client : {};
  const controlProvider = activeControlProvider(body.controlProvider, client);

  sendSseHeaders(res);

  let targetWorkspace;
  try {
    targetWorkspace = resolveCodexWorkspace(body, client);
  } catch (error) {
    sse(res, "error", { message: error instanceof Error ? error.message : "Invalid Codex workspace." });
    sse(res, "done", {});
    res.end();
    return;
  }
  const codexTimeoutMs = resolveCodexTimeoutMs(body, client);
  const projectShape = ensureGeneratedWorkspaceLooksLikeCodexProject(targetWorkspace);
  if (projectShape.error) {
    sse(res, "warning", { message: `Could not initialize generated workspace git project shape: ${projectShape.error}` });
  }
  const mustUseCodexForCoding = requiresCodexCodingDelegation(messages, client);

  if (!CODEX_PILOT_ENABLED) {
    sse(res, "error", { message: "Codex pilot is disabled. Set CODEX_PILOT_ENABLED=1." });
    sse(res, "done", {});
    res.end();
    return;
  }

  if (controlProvider === "openclaw") {
    if (!openClawAvailable()) {
      sse(res, "error", { message: `OpenClaw is not available at ${OPENCLAW_COMMAND}. No fallback path is allowed.` });
      sse(res, "done", {});
      res.end();
      return;
    } else {
      const prompt = buildOpenClawPilotPrompt({ messages, systemPrompt, client, targetWorkspace });
      sse(res, "meta", {
        provider: "openclaw",
        model: "openclaw-codex",
        sessionKey: openClawSessionKey(client),
        mode: OPENCLAW_LOCAL ? "local" : "gateway",
        workspace: targetWorkspace,
      });
      sse(res, "warning", { message: "OpenClaw is controlling Codex/system tools for this voice turn." });
      const result = await runOpenClawAgent(prompt, client, targetWorkspace);
      const delegation = openClawUsedAuthenticatedCodexExec(result, targetWorkspace);
      if (result.ok && !openClawBypassedAuthenticatedCodex(result) && (!mustUseCodexForCoding || delegation.ok)) {
        const openClawMeta = openClawEnvelope(result.parsed)?.meta || {};
        const agentMeta = openClawMeta.agentMeta || {};
        const executionTrace = openClawMeta.executionTrace || {};
        const appChat = registerCodexAppChatForWorkspace({ messages, client, targetWorkspace, result });
        const polishedText = await polishAssistantResponse({ text: result.text, messages, client, targetWorkspace });
        sse(res, "token", { text: (polishedText || result.text).slice(0, 2400) });
        sse(res, "meta", {
          provider: "openclaw",
          model: agentMeta.model || "openclaw-codex",
          durationMs: result.durationMs,
          sessionId: agentMeta.sessionId || null,
          runner: executionTrace.runner || (OPENCLAW_LOCAL ? "local" : "gateway"),
          workspace: targetWorkspace,
          codexDelegationRequired: mustUseCodexForCoding,
          codexDelegationVerified: mustUseCodexForCoding ? true : delegation.ok,
          codexDelegationLogPath: delegation.logPath,
        });
        if (appChat.queued) {
          sse(res, "meta", {
            provider: "codex_activity_mirror",
            model: "Codex Desktop app-server",
            workspace: targetWorkspace,
            command: CODEX_APP_CHAT_COMMAND,
            logPath: appChat.logPath,
            desktopOpen: appChat.desktopOpen || null,
          });
        }
        sse(res, "done", {});
        res.end();
        return;
      }
      const bypassed = openClawBypassedAuthenticatedCodex(result);
      const detail =
        result.error ||
        String(result.stderr || "").trim().split("\n").filter(Boolean).slice(-1)[0] ||
        (mustUseCodexForCoding && !delegation.ok ? delegation.reason : "") ||
        (bypassed ? "OpenClaw did not complete through the authenticated Codex CLI." : `exit ${result.exitCode}`);
      sse(res, "error", { message: `OpenClaw control failed. No fallback path is allowed. ${detail}` });
      sse(res, "done", {});
      res.end();
      return;
    }
  }

  if (!fs.existsSync(CODEX_PILOT_COMMAND)) {
    sse(res, "error", {
      message: `Codex CLI is not available at ${CODEX_PILOT_COMMAND}. Run npm install or set CODEX_PILOT_COMMAND.`,
    });
    sse(res, "done", {});
    res.end();
    return;
  }

  const prompt = buildCodexPilotPrompt({ messages, systemPrompt, client, targetWorkspace });
  const args = [];
  if (CODEX_PILOT_MODEL) args.push("-m", CODEX_PILOT_MODEL);
  args.push("-a", CODEX_PILOT_APPROVAL);
  args.push("exec", ...codexWorkspaceTrustArgs(targetWorkspace), "--json", "--cd", targetWorkspace, "--sandbox", CODEX_PILOT_SANDBOX, "-");

  const child = spawn(CODEX_PILOT_COMMAND, args, {
    cwd: targetWorkspace,
    env: codexSubprocessEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const state = { finalText: "", agentMessages: [], threadId: null };
  const startedAt = performance.now();
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    sse(res, "error", { message: "Codex pilot timed out." });
  }, codexTimeoutMs);

  sse(res, "meta", {
    provider: "codex",
    model: CODEX_PILOT_MODEL || "default",
    sandbox: CODEX_PILOT_SANDBOX,
    approval: CODEX_PILOT_APPROVAL,
    workspace: targetWorkspace,
    timeoutMs: codexTimeoutMs,
  });
  sse(res, "warning", { message: `Codex pilot is working in ${targetWorkspace}. This can take longer than the fast assistant LLM path.` });

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      streamCodexJsonLine(res, line, state);
    }
  });

  let stderrBuffer = "";
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";
    const warnings = lines
      .map((line) => line.trim())
      .filter((line) => line && !line.includes("codex_core_skills::loader"))
      .slice(-3);
    for (const warning of warnings) {
      sse(res, "warning", { message: warning.slice(0, 500) });
    }
  });

  child.stdin.end(prompt);

  req.on("close", () => {
    if (!res.writableEnded && child.exitCode === null) child.kill("SIGTERM");
  });

  child.on("error", (error) => {
    clearTimeout(timeout);
    sse(res, "error", { message: error instanceof Error ? error.message : "Codex pilot failed to start." });
    sse(res, "done", {});
    res.end();
  });

  child.on("close", async (code) => {
    clearTimeout(timeout);
    if (stdoutBuffer.trim()) streamCodexJsonLine(res, stdoutBuffer.trim(), state);
    const rawFinalText = state.agentMessages.length ? state.agentMessages.join("\n\n") : state.finalText;
    const appChat =
      code === 0
        ? registerCodexAppChatForWorkspace({
            messages,
            client,
            targetWorkspace,
            result: { text: rawFinalText || "Direct Codex CLI run completed." },
          })
        : { queued: false };
    if (code !== 0 && !rawFinalText) {
      const detail = stderrBuffer.trim().split("\n").filter(Boolean).slice(-4).join("\n");
      sse(res, "error", {
        message: `Codex pilot exited with code ${code}.${detail ? ` ${detail}` : ""}`,
      });
    } else if (rawFinalText) {
      const finalText = await polishAssistantResponse({ text: rawFinalText, messages, client, targetWorkspace });
      if (finalText) sse(res, "token", { text: finalText });
    }
    sse(res, "meta", {
      provider: "codex",
      model: CODEX_PILOT_MODEL || "default",
      durationMs: Math.round(performance.now() - startedAt),
      threadId: state.threadId,
      workspace: targetWorkspace,
      timeoutMs: codexTimeoutMs,
    });
    if (appChat.queued) {
      sse(res, "meta", {
        provider: "codex_activity_mirror",
        model: "Codex Desktop app-server",
        workspace: targetWorkspace,
        command: CODEX_APP_CHAT_COMMAND,
        logPath: appChat.logPath,
        desktopOpen: appChat.desktopOpen || null,
      });
    }
    sse(res, "done", {});
    res.end();
  });
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
      codexConfigured: codexPilotAvailable(),
      openclawConfigured: openClawAvailable(),
      localModelProvidersDisabled: true,
      purpose: "All coding turns route through OpenClaw using the Codex onboarding/runtime path.",
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
      purpose: "speaker identity for persistent per-user voice profiles.",
    },
    codexPilot: {
      enabled: CODEX_PILOT_ENABLED,
      available: codexPilotAvailable(),
      defaultControlProvider: CODEX_CONTROL_PROVIDER,
      command: CODEX_PILOT_COMMAND,
      codexHome: CODEX_HOME_DIR,
      sandbox: CODEX_PILOT_SANDBOX,
      approval: CODEX_PILOT_APPROVAL,
      model: CODEX_PILOT_MODEL || "default",
      workspaceRoot: CODEX_WORKSPACE_ROOT,
      legacyWorkspaceRoot: LEGACY_CODEX_WORKSPACE_ROOT,
      purpose:
        "Routes Codexa voice-intent coding tasks through the Codex CLI so the desktop agent can inspect, edit, test, and operate the target workspace.",
      appChatRegistration: {
        enabled: CODEX_APP_CHAT_REGISTRATION,
        available: codexAppChatAvailable(),
        command: CODEX_APP_CHAT_COMMAND,
        codexHome: CODEX_HOME_DIR,
        timeoutMs: CODEX_APP_CHAT_TIMEOUT_MS,
        opensGeneratedWorkspacesInDesktop: CODEX_APP_OPEN_GENERATED_WORKSPACES,
        defaultForCodexWrapperInteractions: true,
        purpose:
          "Mirrors Codexa wrapper interactions into normal Codex Desktop app chats for visibility and auditability.",
      },
    },
    twilio: {
      configured: twilioConfigured(),
      phoneNumber: TWILIO_PHONE_NUMBER || null,
      voiceWebhookPath: TWILIO_VOICE_PATH,
      smsWebhookPath: TWILIO_SMS_PATH,
      mediaStreamConfigured: Boolean(PIPECAT_PUBLIC_WS_URL),
      purpose: "Phone calls and SMS route into the same OpenClaw/Codex coding assistant.",
    },
    openclaw: openClawStatusPayload(),
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

  json(res, 200, health);
}

function handleLatestTestRun(_req, res) {
  const latest = readJsonFile(path.join(testRunsDir, "latest.json"), null);
  json(res, 200, {
    active: activeTestRun
      ? {
          id: activeTestRun.id,
          pid: activeTestRun.process.pid,
          startedAt: activeTestRun.startedAt,
        }
      : null,
    latest,
  });
}

function isLoopbackRequest(req) {
  const remoteAddress = req.socket?.remoteAddress || "";
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress);
}

function allowedDesktopLaunchOrigins() {
  return new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
}

function isAllowedDesktopLaunchOrigin(value) {
  try {
    return allowedDesktopLaunchOrigins().has(new URL(value).origin);
  } catch {
    return false;
  }
}

function isSameOriginDesktopLaunchRequest(req) {
  const origin = firstHeader(req.headers.origin);
  if (origin) return isAllowedDesktopLaunchOrigin(origin);

  const referer = firstHeader(req.headers.referer);
  return Boolean(referer && isAllowedDesktopLaunchOrigin(referer));
}

function pruneDesktopLaunchTokens(now = Date.now()) {
  for (const [token, expiresAt] of desktopLaunchTokens.entries()) {
    if (expiresAt <= now) desktopLaunchTokens.delete(token);
  }
}

function createDesktopLaunchToken() {
  pruneDesktopLaunchTokens();
  const token = randomUUID();
  desktopLaunchTokens.set(token, Date.now() + DESKTOP_LAUNCH_TOKEN_TTL_MS);
  return token;
}

function consumeDesktopLaunchToken(token) {
  if (!token) return false;
  const now = Date.now();
  pruneDesktopLaunchTokens(now);
  const expiresAt = desktopLaunchTokens.get(token);
  if (!expiresAt || expiresAt <= now) return false;
  desktopLaunchTokens.delete(token);
  return true;
}

function validateDesktopLaunchRequest(req) {
  if (!isLoopbackRequest(req)) {
    return { ok: false, status: 403, error: "Desktop launch is only available from localhost." };
  }
  if (!isSameOriginDesktopLaunchRequest(req)) {
    return { ok: false, status: 403, error: "Desktop launch requires a same-origin request." };
  }
  if (!consumeDesktopLaunchToken(firstHeader(req.headers["x-desktop-launch-token"]))) {
    return { ok: false, status: 403, error: "Desktop launch token is missing or expired." };
  }
  return { ok: true };
}

function handleDesktopLaunchToken(req, res) {
  if (!isLoopbackRequest(req)) {
    json(res, 403, { error: "Desktop launch is only available from localhost." });
    return;
  }
  if (!isSameOriginDesktopLaunchRequest(req)) {
    json(res, 403, { error: "Desktop launch token requires a same-origin request." });
    return;
  }
  json(res, 200, {
    token: createDesktopLaunchToken(),
    expiresInMs: DESKTOP_LAUNCH_TOKEN_TTL_MS,
  });
}

function handleDesktopLaunch(req, res) {
  const validation = validateDesktopLaunchRequest(req);
  if (!validation.ok) {
    json(res, validation.status, { error: validation.error });
    return;
  }
  const now = Date.now();
  if (now - lastDesktopLaunchAt < 5000) {
    json(res, 202, { status: "already_requested" });
    return;
  }
  lastDesktopLaunchAt = now;
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", "desktop"], {
    cwd: __dirname,
    env: {
      ...process.env,
      AGENTIC_CODING_APP_URL: `http://localhost:${port}`,
      PORT: String(port),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  json(res, 202, {
    status: "launching",
    app: "Codexa Mac app",
  });
}

function resolveStaticFilePath(urlPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname || "/");
  } catch {
    return null;
  }

  const relativePath = decoded === "/" ? "index.html" : path.normalize(decoded).replace(/^[/\\]+/, "");
  const filePath = path.resolve(root, relativePath);
  const rootPath = path.resolve(root);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) return null;
  return filePath;
}

function handleTestRunHistory(_req, res) {
  const history = readJsonFile(path.join(testRunsDir, "history.json"), []);
  json(res, 200, { history });
}

function handleListVoiceSessions(_req, res) {
  const sessions = readVoiceSessions()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(sessionSummary);
  const projects = [...new Set(sessions.map((session) => session.projectName).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  json(res, 200, { sessions, projects });
}

async function handleCreateVoiceSession(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const session = createVoiceSession(body);
  const sessions = readVoiceSessions();
  sessions.unshift(session);
  writeVoiceSessions(sessions);
  json(res, 201, { session });
}

function handleGetVoiceSession(sessionId, res) {
  const session = readVoiceSessions().find((item) => item.id === sessionId);
  if (!session) {
    json(res, 404, { error: "Session not found." });
    return;
  }
  json(res, 200, { session });
}

async function handleUpdateVoiceSession(req, res, sessionId) {
  const body = await readJson(req).catch(() => ({}));
  const sessions = readVoiceSessions();
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) {
    json(res, 404, { error: "Session not found." });
    return;
  }
  const now = new Date().toISOString();
  sessions[index] = {
    ...sessions[index],
    title: safeText(body.title, sessions[index].title),
    projectName: safeText(body.projectName, sessions[index].projectName),
    projectMode: body.projectMode === "new_project" ? "new_project" : sessions[index].projectMode,
    workspaceDir: safeText(body.workspaceDir || body.workspace_dir, sessions[index].workspaceDir || ""),
    status: body.status === "ended" ? "ended" : sessions[index].status || "active",
    endedAt: body.status === "ended" ? now : sessions[index].endedAt || null,
    updatedAt: now,
  };
  writeVoiceSessions(sessions);
  json(res, 200, { session: sessions[index] });
}

function handleEndVoiceSession(sessionId, res) {
  const sessions = readVoiceSessions();
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) {
    json(res, 404, { error: "Session not found." });
    return;
  }
  const now = new Date().toISOString();
  sessions[index] = {
    ...sessions[index],
    status: "ended",
    endedAt: now,
    updatedAt: now,
  };
  writeVoiceSessions(sessions);
  json(res, 200, { session: sessions[index] });
}

async function handleAppendVoiceSessionMessage(req, res, sessionId) {
  const body = await readJson(req).catch(() => ({}));
  const result = appendVoiceSessionMessage(sessionId, body);
  if (!result) {
    json(res, 404, { error: "Session not found or message content missing." });
    return;
  }
  json(res, 201, {
    session: sessionSummary(result.session),
    message: result.message,
  });
}

async function handleStartTestRun(req, res) {
  if (activeTestRun) {
    json(res, 409, {
      error: "A test run is already active.",
      active: {
        id: activeTestRun.id,
        startedAt: activeTestRun.startedAt,
      },
    });
    return;
  }

  const body = await readJson(req).catch(() => ({}));
  const allowedSuites = new Set(["preflight", "eval", "api", "ui", "bench", "phone", "phone_stack", "openclaw", "codex_build", "acoustic"]);
  const requestedSuites = Array.isArray(body.suites) && body.suites.length
    ? body.suites.map(String)
    : ["preflight", "eval", "api", "ui", "bench"];
  const suites = requestedSuites.filter((suite) => allowedSuites.has(suite));
  const rejected = requestedSuites.filter((suite) => !allowedSuites.has(suite));
  if (!suites.length || rejected.length) {
    json(res, 400, {
      error: "Invalid suite list.",
      allowedSuites: [...allowedSuites],
      rejected,
    });
    return;
  }

  fs.mkdirSync(testRunsDir, { recursive: true });
  const id = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const child = spawn(process.execPath, ["scripts/voice-test-runner.mjs", `--id=${id}`, `--suites=${suites.join(",")}`], {
    cwd: __dirname,
    env: {
      ...process.env,
      VOICE_TEST_APP_URL: process.env.VOICE_TEST_APP_URL ?? `http://localhost:${port}`,
      BENCH_BASE_URL: process.env.BENCH_BASE_URL ?? process.env.VOICE_TEST_APP_URL ?? `http://localhost:${port}`,
      HEADLESS: "1",
    },
    stdio: "ignore",
    detached: false,
  });

  activeTestRun = {
    id,
    startedAt: new Date().toISOString(),
    process: child,
  };
  child.on("exit", () => {
    if (activeTestRun?.id === id) activeTestRun = null;
  });
  child.on("error", () => {
    if (activeTestRun?.id === id) activeTestRun = null;
  });

  json(res, 202, {
    id,
    status: "started",
    suites,
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const filePath = resolveStaticFilePath(url.pathname);

  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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
        codexConfigured: codexPilotAvailable(),
        openclawConfigured: openClawAvailable(),
        localModelProvidersDisabled: true,
        sttProvider: STT_PROVIDER,
        ttsProvider: TTS_PROVIDER,
        speechIntentMode: SPEECH_INTENT_MODE,
        fishConfigured: Boolean(FISH_API_KEY),
        fishModel: FISH_TTS_MODEL,
        whisperxConfigured: Boolean(WHISPERX_URL),
        speakerGuardConfigured: Boolean(SPEAKER_GUARD_URL),
        codexPilotEnabled: CODEX_PILOT_ENABLED,
        codexPilotAvailable: codexPilotAvailable(),
        codexPilotSandbox: CODEX_PILOT_SANDBOX,
        codexWorkspaceRoot: CODEX_WORKSPACE_ROOT,
        legacyCodexWorkspaceRoot: LEGACY_CODEX_WORKSPACE_ROOT,
        codexControlProvider: CODEX_CONTROL_PROVIDER,
        openclawAvailable: openClawAvailable(),
        openclawLocalMode: OPENCLAW_LOCAL,
        twilioConfigured: twilioConfigured(),
        twilioPhoneNumber: TWILIO_PHONE_NUMBER || null,
        twilioVoiceWebhookPath: TWILIO_VOICE_PATH,
        twilioSmsWebhookPath: TWILIO_SMS_PATH,
      });
      return;
    }

    if (url.pathname === "/api/providers/health") {
      await handleProviderHealth(req, res);
      return;
    }

    if (url.pathname === "/api/desktop/launch-token" && req.method === "GET") {
      handleDesktopLaunchToken(req, res);
      return;
    }

    if (url.pathname === "/api/desktop/launch" && req.method === "POST") {
      handleDesktopLaunch(req, res);
      return;
    }

    if (url.pathname === "/api/codex/status") {
      json(res, 200, {
        enabled: CODEX_PILOT_ENABLED,
        available: codexPilotAvailable(),
        command: CODEX_PILOT_COMMAND,
        codexHome: CODEX_HOME_DIR,
        sandbox: CODEX_PILOT_SANDBOX,
        approval: CODEX_PILOT_APPROVAL,
        model: CODEX_PILOT_MODEL || "default",
        workspaceRoot: CODEX_WORKSPACE_ROOT,
        legacyWorkspaceRoot: LEGACY_CODEX_WORKSPACE_ROOT,
        defaultControlProvider: CODEX_CONTROL_PROVIDER,
        appChatRegistration: {
          enabled: CODEX_APP_CHAT_REGISTRATION,
          available: codexAppChatAvailable(),
          command: CODEX_APP_CHAT_COMMAND,
          codexHome: CODEX_HOME_DIR,
          timeoutMs: CODEX_APP_CHAT_TIMEOUT_MS,
          opensGeneratedWorkspacesInDesktop: CODEX_APP_OPEN_GENERATED_WORKSPACES,
          defaultForCodexWrapperInteractions: true,
          purpose:
            "Mirrors Codexa wrapper interactions into normal Codex Desktop app chats for visibility and auditability.",
        },
        openclaw: openClawStatusPayload(),
      });
      return;
    }

    if (url.pathname === "/api/openclaw/status") {
      json(res, 200, openClawStatusPayload());
      return;
    }

    if (url.pathname === TWILIO_STATUS_PATH && req.method === "GET") {
      handleTwilioStatus(res);
      return;
    }

    if (url.pathname === TWILIO_VOICE_PATH && (req.method === "POST" || req.method === "GET")) {
      await handleTwilioVoiceWebhook(req, res);
      return;
    }

    if (url.pathname === TWILIO_SMS_PATH && (req.method === "POST" || req.method === "GET")) {
      await handleTwilioSmsWebhook(req, res, url);
      return;
    }

    if (url.pathname === "/api/test-runs/latest" && req.method === "GET") {
      handleLatestTestRun(req, res);
      return;
    }

    if (url.pathname === "/api/test-runs/history" && req.method === "GET") {
      handleTestRunHistory(req, res);
      return;
    }

    if (url.pathname === "/api/test-runs/run" && req.method === "POST") {
      await handleStartTestRun(req, res);
      return;
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      handleListVoiceSessions(req, res);
      return;
    }

    if (url.pathname === "/api/sessions" && req.method === "POST") {
      await handleCreateVoiceSession(req, res);
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|end))?$/);
    if (sessionMatch) {
      const [, sessionId, child] = sessionMatch;
      if (!child && req.method === "GET") {
        handleGetVoiceSession(sessionId, res);
        return;
      }
      if (!child && req.method === "PATCH") {
        await handleUpdateVoiceSession(req, res, sessionId);
        return;
      }
      if (child === "messages" && req.method === "POST") {
        await handleAppendVoiceSessionMessage(req, res, sessionId);
        return;
      }
      if (child === "end" && req.method === "POST") {
        handleEndVoiceSession(sessionId, res);
        return;
      }
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

    if (url.pathname === "/api/codex/exec" && req.method === "POST") {
      await handleCodexPilot(req, res);
      return;
    }

    if (url.pathname === "/api/phone/v1/chat/completions" && req.method === "POST") {
      await handlePhoneCodexCompletion(req, res);
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

function proxyPipecatWebSocket(req, socket, head) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== PIPECAT_WS_PATH) {
    socket.destroy();
    return;
  }

  const [host, rawPort] = PIPECAT_WS_PROXY_TARGET.split(":");
  const portNumber = Number(rawPort || 7860);
  const upstream = net.connect(portNumber, host || "127.0.0.1");

  upstream.on("connect", () => {
    const headers = { ...req.headers, host: PIPECAT_WS_PROXY_TARGET };
    const requestHead = [
      `${req.method} ${req.url} HTTP/${req.httpVersion}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`),
      "",
      "",
    ].join("\r\n");
    upstream.write(requestHead);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  upstream.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    upstream.destroy();
  });
}

server.on("upgrade", proxyPipecatWebSocket);

server.listen(port, () => {
  console.log(`Codexa running at http://localhost:${port}`);
  console.log(`Provider mode: ${PROVIDER}`);
});
