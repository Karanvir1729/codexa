import fs from "node:fs";
import path from "node:path";
import type { CommandEventRecord } from "./types.js";

export type CodexHistoryConfidence =
  | "emitted_by_cli"
  | "verified_by_prompt_match"
  | "session_id_with_verified_rollout"
  | "session_id_only"
  | "not_found";

export type CodexHistoryMetadata = Pick<
  CommandEventRecord,
  | "codex_session_id"
  | "codex_rollout_path"
  | "codex_rollout_host_path"
  | "codex_rollout_relative_path"
  | "codex_home"
  | "codex_home_host_path"
  | "codex_history_kind"
  | "codex_resume_command"
  | "codex_prompt_excerpt"
  | "codex_model"
  | "codex_started_at"
  | "codex_completed_at"
  | "codex_history_confidence"
  | "codex_history_verification_command"
>;

export interface DetectCodexHistoryInput {
  commandEvent: CommandEventRecord;
  codexHome: string;
  hostCodexHomePath?: string;
  prompt: string;
  commandStartedAt: string;
  commandCompletedAt: string | null;
}

function cleanWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function promptExcerpt(prompt: string) {
  return cleanWhitespace(prompt).slice(0, 500);
}

function safeRead(filePath: string, maxBytes = 2_000_000) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function stdoutText(event: CommandEventRecord) {
  const log = event.stdout_ref ? safeRead(event.stdout_ref) : "";
  return [event.stdout_preview, log].filter(Boolean).join("\n");
}

function findStringValue(value: unknown, names: Set<string>): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringValue(item, names);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (names.has(key) && typeof item === "string" && item.trim()) return item.trim();
    const nested = findStringValue(item, names);
    if (nested) return nested;
  }
  return null;
}

export function parseCodexJsonlMetadata(jsonl: string) {
  let sessionId: string | null = null;
  let model: string | null = null;
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      sessionId ??= findStringValue(parsed, new Set(["thread_id", "session_id", "conversation_id"]));
      model ??= findStringValue(parsed, new Set(["model", "model_id"]));
    } catch {
      continue;
    }
  }
  return { sessionId, model };
}

function walkJsonlFiles(root: string) {
  const files: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(absolute);
      }
    }
  }
  walk(root);
  return files;
}

function promptNeedles(prompt: string, taskId: string, projectId: string) {
  const needles = [taskId, projectId];
  const taskLine = prompt.match(/^Task:\s*(.+)$/im)?.[1];
  const projectLine = prompt.match(/^Project:\s*(.+)$/im)?.[1];
  if (taskLine) needles.push(taskLine);
  if (projectLine) needles.push(projectLine);
  const nonce = prompt.match(/NONCE-[A-Z0-9-]+/i)?.[0];
  if (nonce) needles.push(nonce);
  return needles.map(cleanWhitespace).filter((item) => item.length >= 8);
}

function rolloutMatchesPrompt(content: string, prompt: string, taskId: string, projectId: string) {
  const normalized = cleanWhitespace(content).toLowerCase();
  const needles = promptNeedles(prompt, taskId, projectId);
  return needles.some((needle) => normalized.includes(needle.toLowerCase()));
}

export function findVerifiedCodexRollout(input: {
  codexHome: string;
  prompt: string;
  taskId: string;
  projectId: string;
  startedAt: string;
  completedAt: string | null;
}) {
  const sessionsDir = path.join(input.codexHome, "sessions");
  const startMs = Date.parse(input.startedAt) - 30_000;
  const endMs = (input.completedAt ? Date.parse(input.completedAt) : Date.now()) + 90_000;
  const candidates = walkJsonlFiles(sessionsDir)
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return { filePath, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { filePath: string; mtimeMs: number; birthtimeMs: number } => Boolean(item))
    .filter((item) => {
      const createdOrModified = Math.max(item.mtimeMs, item.birthtimeMs);
      return createdOrModified >= startMs && createdOrModified <= endMs;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates) {
    const content = safeRead(candidate.filePath, 5_000_000);
    if (rolloutMatchesPrompt(content, input.prompt, input.taskId, input.projectId)) {
      return { rolloutPath: candidate.filePath, content, confidence: "verified_by_prompt_match" as const };
    }
  }
  return null;
}

function hostPathForRollout(rolloutPath: string | null, codexHome: string, hostCodexHomePath?: string) {
  if (!rolloutPath || !hostCodexHomePath) return null;
  const relative = path.relative(codexHome, rolloutPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return path.join(hostCodexHomePath, relative);
}

function repoRelativeCodexPath(hostPath: string | null) {
  if (!hostPath) return null;
  const marker = ".codex-worker-home";
  const index = hostPath.indexOf(marker);
  if (index === -1) return hostPath;
  return hostPath.slice(index);
}

function verificationNeedle(prompt: string) {
  const nonce = prompt.match(/NONCE-[A-Z0-9-]+/i)?.[0];
  if (nonce) return nonce;
  const taskLine = prompt.match(/^Task:\s*(.+)$/im)?.[1];
  return cleanWhitespace(taskLine || prompt).slice(0, 90);
}

function shellDoubleQuote(value: string) {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

export function buildCodexResumeCommand(sessionId: string | null | undefined) {
  if (!sessionId) return null;
  return `codex exec resume ${sessionId} "summarize what you built"`;
}

export function buildVisibilityMirrorPrompt(input: {
  sessionId?: string | null;
  rolloutPath?: string | null;
  taskId: string;
  commandEventId: string;
  summary: string;
}) {
  const executionSource = input.sessionId
    ? `worker Codex session ${input.sessionId}`
    : input.rolloutPath
      ? `verified worker Codex rollout ${input.rolloutPath}`
      : "unknown worker Codex history";
  return [
    "This is a visibility mirror. It did not execute the build or edit project files.",
    `The actual work was executed by ${executionSource}.`,
    `Task: ${input.taskId}`,
    `Command event: ${input.commandEventId}`,
    `Grounded summary: ${input.summary}`,
  ].join("\n");
}

export function detectCodexHistory(input: DetectCodexHistoryInput): CodexHistoryMetadata {
  const stdout = stdoutText(input.commandEvent);
  const parsed = parseCodexJsonlMetadata(stdout);
  const verifiedRollout = findVerifiedCodexRollout({
    codexHome: input.codexHome,
    prompt: input.prompt,
    taskId: input.commandEvent.task_id,
    projectId: input.commandEvent.project_id,
    startedAt: input.commandStartedAt,
    completedAt: input.commandCompletedAt,
  });
  const rolloutPath = verifiedRollout?.rolloutPath ?? null;
  const sessionId = parsed.sessionId;
  const rolloutHostPath = hostPathForRollout(rolloutPath, input.codexHome, input.hostCodexHomePath);
  const rolloutRelativePath = repoRelativeCodexPath(rolloutHostPath);
  const verificationRoot = input.hostCodexHomePath
    ? path.join(input.hostCodexHomePath, "sessions")
    : ".codex-worker-home/sessions";
  const confidence: CodexHistoryConfidence = parsed.sessionId && verifiedRollout
    ? "session_id_with_verified_rollout"
    : parsed.sessionId
      ? "session_id_only"
      : verifiedRollout
        ? "verified_by_prompt_match"
        : "not_found";

  return {
    codex_session_id: sessionId,
    codex_rollout_path: rolloutPath,
    codex_rollout_host_path: rolloutHostPath,
    codex_rollout_relative_path: rolloutRelativePath,
    codex_home: input.codexHome,
    codex_home_host_path: input.hostCodexHomePath ?? null,
    codex_history_kind: "exec",
    codex_resume_command: buildCodexResumeCommand(sessionId),
    codex_prompt_excerpt: promptExcerpt(input.prompt),
    codex_model: parsed.model,
    codex_started_at: input.commandStartedAt,
    codex_completed_at: input.commandCompletedAt,
    codex_history_confidence: confidence,
    codex_history_verification_command: `grep -R ${shellDoubleQuote(verificationNeedle(input.prompt))} ${shellDoubleQuote(verificationRoot)}`,
  };
}
