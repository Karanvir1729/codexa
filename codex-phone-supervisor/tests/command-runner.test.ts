import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config } from "../backend/src/config.js";
import { CommandRunner } from "../backend/src/command-runner.js";
import { redactSensitiveText } from "../backend/src/redaction.js";
import { appendAuditEvent, appendOrchestratorEvent, getCommandEvent, listOrchestratorEvents } from "../backend/src/store.js";

test("CommandRunner records executor timeouts as failed command events", async () => {
  const event = await new CommandRunner().run({
    task_id: "task_command_runner_timeout",
    project_id: "project_command_runner_timeout",
    worker_id: "worker_command_runner_timeout",
    command: "pwd",
    cwd: process.cwd(),
    workspace_path: process.cwd(),
    timeout_ms: 10,
    executor: async () => ({
      code: 0,
      stdout: "",
      stderr: "Command timed out after 10ms.",
      timed_out: true,
    }),
  });

  assert.equal(event.exit_code, 124);
  assert.match(event.summary, /timed out/i);
  assert.match(event.stderr_preview, /timed out/i);
});

test("CommandRunner redacts secrets from command event previews and logs", async () => {
  const rawOpenAiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const rawAccessToken = "secret-token-value-command-runner";
  const rawJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturevalue";
  const event = await new CommandRunner().run({
    task_id: "task_command_runner_redaction",
    project_id: "project_command_runner_redaction",
    worker_id: "worker_command_runner_redaction",
    command: "pwd",
    cwd: process.cwd(),
    workspace_path: process.cwd(),
    executor: async () => ({
      code: 0,
      stdout: `OPENAI_API_KEY=${rawOpenAiKey}\n{"access_token":"${rawAccessToken}"}\n${"x".repeat(4100)}`,
      stderr: `Authorization: Bearer ${rawJwt}`,
    }),
  });

  const stored = getCommandEvent(event.event_id);
  const orchestratorEvents = listOrchestratorEvents(event.event_id);
  const serialized = JSON.stringify({ event, stored, orchestratorEvents });
  assert.doesNotMatch(serialized, new RegExp(rawOpenAiKey));
  assert.doesNotMatch(serialized, new RegExp(rawAccessToken));
  assert.doesNotMatch(serialized, /signaturevalue/);
  assert.match(serialized, /\[redacted\]/);
  assert.ok(event.stdout_ref);
  const persistedStdout = fs.readFileSync(event.stdout_ref, "utf8");
  assert.doesNotMatch(persistedStdout, new RegExp(rawOpenAiKey));
  assert.doesNotMatch(persistedStdout, new RegExp(rawAccessToken));
});

test("audit and orchestrator event payloads are redacted before persistence", () => {
  const rawApiKey = "sk-proj-redactionpayloadabcdefghijklmnopqrstuvwxyz";
  const rawPassword = "payload-password-redaction-test";
  const rawToken = "payload-access-token-redaction-test";
  const scopeId = `redaction_payload_${Date.now()}`;

  const orchestratorEvent = appendOrchestratorEvent({
    scope: "command",
    scope_id: scopeId,
    type: "command.completed",
    message: `Finished command with PASSWORD=${rawPassword}`,
    data: {
      stdout_preview: `OPENAI_API_KEY=${rawApiKey}`,
      stderr_preview: `password=${rawPassword}`,
      event: { access_token: rawToken },
    },
  });
  const auditEvent = appendAuditEvent({
    session_id: "session_redaction_payload",
    ts: new Date().toISOString(),
    source: "codex",
    type: "command.output",
    message: `token=${rawToken}`,
    data: {
      stdout_preview: `OPENAI_API_KEY=${rawApiKey}`,
      stderr_preview: `password=${rawPassword}`,
      event: { access_token: rawToken },
    },
  });

  const persistedOrchestratorEvent = listOrchestratorEvents(scopeId).at(-1);
  const auditLog = fs.readFileSync(config.auditLogPath, "utf8");
  const serialized = JSON.stringify({ orchestratorEvent, persistedOrchestratorEvent, auditEvent, auditLogTail: auditLog.slice(-8000) });
  assert.doesNotMatch(serialized, new RegExp(rawApiKey));
  assert.doesNotMatch(serialized, new RegExp(rawPassword));
  assert.doesNotMatch(serialized, new RegExp(rawToken));
  assert.match(serialized, /\[redacted\]/);
});

test("Codex VM home auth paths are redacted from command-visible text", () => {
  const raw = "using /Users/operator/project/.codex-vm-home/auth.json and /codex-home/auth.json but session evidence is /codex-home/sessions/2026/rollout.jsonl";
  const redacted = redactSensitiveText(raw);
  assert.doesNotMatch(redacted, /\.codex-vm-home\/auth\.json/);
  assert.doesNotMatch(redacted, /\/codex-home\/auth\.json/);
  assert.match(redacted, /\.codex-vm-home\/\[redacted\]/);
  assert.match(redacted, /\/codex-home\/\[redacted\]/);
  assert.match(redacted, /\/codex-home\/sessions\/2026\/rollout\.jsonl/);
});
