import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStateStore } from "../backend/src/memory-state-store.js";
import {
  buildVisibilityMirrorPrompt,
  detectCodexHistory,
  parseCodexJsonlMetadata,
} from "../backend/src/codex-history.js";
import type { CommandEventRecord } from "../backend/src/types.js";

function command(overrides: Partial<CommandEventRecord> = {}): CommandEventRecord {
  const now = new Date().toISOString();
  return {
    event_id: "cmd_codex_history",
    task_id: "task_codex_history",
    project_id: "project_codex_history",
    worker_id: "worker_codex_history",
    command: "codex exec --json -C /workspace/example Build something",
    cwd: "/workspace/example",
    started_at: now,
    ended_at: now,
    exit_code: 0,
    stdout_ref: null,
    stderr_ref: null,
    stdout_preview: "",
    stderr_preview: "",
    summary: "Command completed successfully.",
    risk_level: "low",
    approved_by_user: false,
    created_at: now,
    ...overrides,
  };
}

const initialStoreOptions = {
  defaultWorkerMode: "docker_local" as const,
  allowWorkerModeSwitch: true,
  maxLocalWorkers: 1,
  maxDockerLocalWorkers: 3,
  maxGcpVmWorkers: 10,
  maxGkeJobWorkers: 5,
};

test("CommandEvent stores Codex history metadata", () => {
  const store = new MemoryStateStore(initialStoreOptions);
  const saved = store.createCommandEvent(command({
    codex_session_id: "019e-history-session",
    codex_rollout_relative_path: ".codex-worker-home/sessions/2026/05/26/rollout-019e-history-session.jsonl",
    codex_home: "/codex-home",
    codex_history_kind: "exec",
    codex_resume_command: "codex resume --include-non-interactive 019e-history-session",
    codex_history_confidence: "session_id_with_verified_rollout",
  }));
  assert.equal(saved.codex_session_id, "019e-history-session");
  assert.match(saved.codex_resume_command ?? "", /codex resume --include-non-interactive 019e-history-session/);
  assert.equal(store.getCommandEvent(saved.event_id)?.codex_history_confidence, "session_id_with_verified_rollout");
});

test("Codex JSONL parser extracts emitted session metadata", () => {
  const parsed = parseCodexJsonlMetadata([
    JSON.stringify({ type: "thread.started", thread_id: "019e-jsonl-thread" }),
    JSON.stringify({ type: "turn.started", model: "gpt-5-codex" }),
  ].join("\n"));
  assert.equal(parsed.sessionId, "019e-jsonl-thread");
  assert.equal(parsed.model, "gpt-5-codex");
});

test("fallback rollout path detection verifies by prompt match and nonce", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-history-"));
  const codexHome = path.join(root, ".codex-worker-home");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "05", "26");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const rollout = path.join(sessionsDir, "rollout-019e-fallback.jsonl");
  const prompt = [
    "You are the Cloud Orchestrator worker running Codex for a real user task.",
    "Project: Glassblowing Studio Landing Page",
    "Task: Build a landing page for a glassblowing studio. Include exact text NONCE-HISTORY-BRIDGE-TEST.",
  ].join("\n\n");
  fs.writeFileSync(rollout, `${JSON.stringify({ type: "thread.started" })}\n${JSON.stringify({ item: { text: prompt } })}\n`);
  const now = new Date().toISOString();
  const metadata = detectCodexHistory({
    commandEvent: command({ stdout_preview: "", started_at: now, ended_at: now }),
    codexHome,
    hostCodexHomePath: codexHome,
    prompt,
    commandStartedAt: now,
    commandCompletedAt: now,
  });
  assert.equal(metadata.codex_history_confidence, "verified_by_prompt_match");
  assert.equal(metadata.codex_session_id, null);
  assert.equal(metadata.codex_resume_command, null);
  assert.equal(metadata.codex_rollout_path, rollout);
  assert.equal(metadata.codex_home_host_path, codexHome);
  assert.match(metadata.codex_history_verification_command ?? "", /NONCE-HISTORY-BRIDGE-TEST/);
  assert.match(metadata.codex_history_verification_command ?? "", new RegExp(`${codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sessions`));
  assert.match(fs.readFileSync(metadata.codex_rollout_path ?? "", "utf8"), /NONCE-HISTORY-BRIDGE-TEST/);
});

test("fallback rollout detection does not invent a resumable session id from the filename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-history-no-session-"));
  const codexHome = path.join(root, ".codex-worker-home");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "05", "26");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "rollout-2026-05-26T19-30-28-019e-file-only.jsonl"),
    JSON.stringify({ item: { text: "Task: Build a thing with NONCE-HISTORY-BRIDGE-NO-SESSION" } }),
  );
  const now = new Date().toISOString();
  const metadata = detectCodexHistory({
    commandEvent: command({ stdout_preview: "", started_at: now, ended_at: now }),
    codexHome,
    hostCodexHomePath: codexHome,
    prompt: "Task: Build a thing with NONCE-HISTORY-BRIDGE-NO-SESSION",
    commandStartedAt: now,
    commandCompletedAt: now,
  });
  assert.equal(metadata.codex_history_confidence, "verified_by_prompt_match");
  assert.equal(metadata.codex_session_id, null);
  assert.equal(metadata.codex_resume_command, null);
  assert.match(metadata.codex_rollout_path ?? "", /rollout-2026-05-26T19-30-28-019e-file-only\.jsonl$/);
});

test("dashboard command side panel exposes Codex resume and verification commands", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "frontend", "src", "main.tsx"), "utf8");
  assert.match(source, /data-testid="command-codex-history"/);
  assert.match(source, /codex_resume_command/);
  assert.match(source, /codex_history_verification_command/);
  assert.match(source, /Codex home host path/);
  assert.match(source, /Codex home container path/);
});

test("visibility mirror is disabled by default and labels itself when configured", () => {
  assert.notEqual(process.env.CODEX_VISIBILITY_MIRROR, "true");
  const prompt = buildVisibilityMirrorPrompt({
    sessionId: "019e-worker-session",
    taskId: "task_visibility",
    commandEventId: "cmd_visibility",
    summary: "Files were generated and validation passed.",
  });
  assert.match(prompt, /^This is a visibility mirror\./);
  assert.match(prompt, /did not execute the build or edit project files/);
  assert.match(prompt, /actual work was executed by worker Codex session 019e-worker-session/);
  const rolloutOnlyPrompt = buildVisibilityMirrorPrompt({
    rolloutPath: ".codex-worker-home/sessions/2026/05/26/rollout-file-only.jsonl",
    taskId: "task_visibility",
    commandEventId: "cmd_visibility",
    summary: "Files were generated and validation passed.",
  });
  assert.match(rolloutOnlyPrompt, /verified worker Codex rollout/);
  assert.doesNotMatch(rolloutOnlyPrompt, /worker Codex session \.codex-worker-home/);
});
