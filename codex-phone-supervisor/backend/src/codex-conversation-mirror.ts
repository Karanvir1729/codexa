import { spawn } from "node:child_process";
import { config } from "./config.js";
import { parseCodexJsonlMetadata, buildCodexResumeCommand } from "./codex-history.js";
import { appendAuditEvent, getSession, upsertSession } from "./store.js";
import type { Channel, SessionState, SupervisorEvent } from "./types.js";

const mirrorQueues = new Map<string, Promise<void>>();

function nowIso() {
  return new Date().toISOString();
}

function preview(value: string, max = 800) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function codexFastArgs() {
  const args: string[] = [];
  if (config.localCodex.planningModel) args.push("--model", config.localCodex.planningModel);
  if (config.localCodex.planningProfile) args.push("--profile", config.localCodex.planningProfile);
  if (config.localCodex.planningProfileV2) args.push("--profile-v2", config.localCodex.planningProfileV2);
  if (config.localCodex.planningReasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(config.localCodex.planningReasoningEffort)}`);
  if (config.localCodex.inheritShellEnvironment) args.push("-c", "shell_environment_policy.inherit=all");
  return args;
}

function codexFastResumeArgs() {
  const args: string[] = [];
  if (config.localCodex.planningModel) args.push("--model", config.localCodex.planningModel);
  if (config.localCodex.planningReasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(config.localCodex.planningReasoningEffort)}`);
  if (config.localCodex.inheritShellEnvironment) args.push("-c", "shell_environment_policy.inherit=all");
  return args;
}

function mirrorEnabledFor(channel?: Channel | null) {
  if (!config.localCodex.mirrorBrowserConversationToResume) return false;
  return channel === "web_text" || channel === "web_voice";
}

function buildMirrorPrompt(input: {
  session: SessionState;
  userText: string;
  assistantText: string;
  channel?: Channel | null;
}) {
  return [
    "You are a Codex browser-conversation history mirror for Codex Phone Supervisor.",
    "Your only job is to make the browser/app conversation visible in normal Codex resume history.",
    "Do not edit files. Do not run commands. Do not plan implementation. Do not ask questions.",
    "Record the transcript turn below as context and reply with exactly: Recorded browser conversation turn.",
    "",
    `Supervisor app session: ${input.session.session_id}`,
    `Channel: ${input.channel ?? input.session.channel ?? "unknown"}`,
    `Selected workspace: ${input.session.workspace_path}`,
    `Selected project id: ${input.session.project_id ?? input.session.current_project_id ?? "none"}`,
    "",
    "Browser transcript turn:",
    `User: ${input.userText}`,
    `Codex app response: ${input.assistantText}`,
  ].join("\n");
}

function appendSessionMirrorEvent(session: SessionState, event: Omit<SupervisorEvent, "id" | "session_id">) {
  const stored = appendAuditEvent({
    session_id: session.session_id,
    ...event,
  });
  session.raw_events = [...session.raw_events, stored].slice(-400);
  session.last_updated = stored.ts;
  return stored;
}

async function runCodexMirrorProcess(input: {
  session: SessionState;
  prompt: string;
}) {
  const existingSessionId = input.session.codex_conversation_session_id;
  const cwd = input.session.workspace_path || config.defaultWorkspacePath;
  const args = existingSessionId
    ? [
        "exec",
        "resume",
        ...codexFastResumeArgs(),
        "--json",
        "--skip-git-repo-check",
        existingSessionId,
        "-",
      ]
    : [
        "exec",
        ...codexFastArgs(),
        "--json",
        "--color",
        "never",
        "-C",
        cwd,
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-",
      ];

  const child = spawn(config.codexCommand, args, {
    cwd,
    env: {
      ...process.env,
      CODEX_HOME: config.codexHome,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(input.prompt);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  if (exit.code !== 0) {
    throw new Error(`Codex browser conversation mirror exited with code ${exit.code ?? "null"}${stderr ? `: ${preview(stderr)}` : ""}`);
  }
  return parseCodexJsonlMetadata(`${stdout}\n${stderr}`);
}

async function mirrorBrowserConversationTurnNow(input: {
  sessionId: string;
  userText: string;
  assistantText: string;
  channel?: Channel | null;
}) {
  const session = getSession(input.sessionId);
  if (!session || !mirrorEnabledFor(input.channel ?? session.channel)) return;
  const prompt = buildMirrorPrompt({
    session,
    userText: input.userText,
    assistantText: input.assistantText,
    channel: input.channel,
  });
  const startedAt = nowIso();
  appendSessionMirrorEvent(session, {
    ts: startedAt,
    source: "system",
    type: "codex_conversation_mirror.started",
    message: "Mirroring browser chat turn into Codex resume history.",
    data: {
      existing_codex_session_id: session.codex_conversation_session_id ?? null,
      reasoning_effort: config.localCodex.planningReasoningEffort,
    },
  });
  upsertSession(session);

  try {
    const metadata = await runCodexMirrorProcess({ session, prompt });
    const latest = getSession(input.sessionId);
    if (!latest) return;
    const sessionId = metadata.sessionId ?? latest.codex_conversation_session_id ?? null;
    latest.codex_conversation_session_id = sessionId;
    latest.codex_conversation_resume_command = buildCodexResumeCommand(sessionId);
    latest.codex_conversation_mirrored_at = nowIso();
    latest.codex_conversation_mirror_error = null;
    appendSessionMirrorEvent(latest, {
      ts: latest.codex_conversation_mirrored_at,
      source: "codex",
      type: "codex_conversation_mirror.completed",
      message: sessionId
        ? `Browser chat is mirrored into Codex session ${sessionId}.`
        : "Browser chat was mirrored into Codex history, but no session id was emitted.",
      data: {
        codex_session_id: sessionId,
        codex_resume_command: latest.codex_conversation_resume_command,
        codex_model: metadata.model,
      },
    });
    upsertSession(latest);
  } catch (error) {
    const latest = getSession(input.sessionId);
    if (!latest) return;
    latest.codex_conversation_mirror_error = error instanceof Error ? error.message : String(error);
    appendSessionMirrorEvent(latest, {
      ts: nowIso(),
      source: "system",
      type: "codex_conversation_mirror.failed",
      message: latest.codex_conversation_mirror_error,
      data: { error: latest.codex_conversation_mirror_error },
    });
    upsertSession(latest);
  }
}

export function mirrorBrowserConversationTurn(input: {
  session: SessionState;
  userText: string;
  assistantText: string;
  channel?: Channel | null;
}) {
  if (!mirrorEnabledFor(input.channel ?? input.session.channel)) return null;
  const prior = mirrorQueues.get(input.session.session_id) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => mirrorBrowserConversationTurnNow({
      sessionId: input.session.session_id,
      userText: input.userText,
      assistantText: input.assistantText,
      channel: input.channel,
    }));
  mirrorQueues.set(input.session.session_id, next);
  void next.finally(() => {
    if (mirrorQueues.get(input.session.session_id) === next) mirrorQueues.delete(input.session.session_id);
  });
  return next;
}

export function resetConversationMirrorQueuesForTests() {
  mirrorQueues.clear();
}
