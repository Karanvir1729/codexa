import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { classifyCommand } from "./command-policy.js";
import { appendOrchestratorEvent, getCommandEvent, getTask, listCommandEvents, upsertCommandEvent, upsertTask } from "./store.js";
import { redactCommandEvent, redactSensitiveText } from "./redaction.js";
import type { CommandEventRecord, WorkerType } from "./types.js";

export type CommandRunnerInput = {
  task_id: string;
  project_id: string;
  worker_id: string;
  command: string;
  args?: string[];
  cwd: string;
  workspace_path: string;
  approved_by_user?: boolean;
  timeout_ms?: number;
  worker_mode?: WorkerType;
  actual_image_uri?: string;
  actual_image_digest?: string;
  vm_name?: string;
  startup_attempt_id?: string;
  run_attempt_id?: string;
  container_started_at?: string;
  worker_runtime_version?: string;
  docker_container_id?: string;
  docker_container_name?: string;
  runtime_metadata_verified?: boolean;
  executor?: (input: {
    command: string;
    args: string[];
    cwd: string;
    timeout_ms?: number;
  }) => Promise<{ code: number | null; stdout: string; stderr: string; timed_out?: boolean }>;
};

function preview(value: string, maxChars = 2000) {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function writeLargeLog(eventId: string, stream: "stdout" | "stderr", value: string) {
  if (value.length <= 4000) return null;
  const dir = path.join(config.artifactsDir, "command-logs");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${eventId}.${stream}.log`);
  fs.writeFileSync(filePath, redactSensitiveText(value));
  return filePath;
}

function renderCommand(command: string, args: string[] = []) {
  return [command, ...args].join(" ").trim();
}

function refreshTaskCommandCount(taskId: string) {
  const task = getTask(taskId);
  if (!task) return;
  task.command_count = listCommandEvents({ taskId }).length;
  task.updated_at = new Date().toISOString();
  upsertTask(task);
}

export class CommandRunner {
  async run(input: CommandRunnerInput) {
    const commandText = renderCommand(input.command, input.args);
    const policy = classifyCommand(commandText, input.cwd, input.workspace_path, Boolean(input.approved_by_user));
    const now = new Date().toISOString();
    const event: CommandEventRecord = redactCommandEvent({
      event_id: randomUUID(),
      task_id: input.task_id,
      project_id: input.project_id,
      worker_id: input.worker_id,
      worker_mode: input.worker_mode,
      actual_image_uri: input.actual_image_uri,
      actual_image_digest: input.actual_image_digest,
      vm_name: input.vm_name,
      startup_attempt_id: input.startup_attempt_id,
      run_attempt_id: input.run_attempt_id,
      container_started_at: input.container_started_at,
      worker_runtime_version: input.worker_runtime_version,
      docker_container_id: input.docker_container_id,
      docker_container_name: input.docker_container_name,
      runtime_metadata_verified: input.runtime_metadata_verified,
      command: commandText,
      cwd: input.cwd,
      started_at: now,
      ended_at: null,
      exit_code: null,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "",
      summary: policy.reason,
      risk_level: policy.risk_level,
      approved_by_user: Boolean(input.approved_by_user),
      created_at: now,
    });
    upsertCommandEvent(event);
    refreshTaskCommandCount(event.task_id);
    appendOrchestratorEvent({
      scope: "command",
      scope_id: event.event_id,
      type: "command.started",
      message: `Started ${event.command}.`,
      data: event,
    });

    if (policy.disposition === "blocked" || policy.disposition === "requires_approval") {
      event.ended_at = new Date().toISOString();
      event.exit_code = policy.disposition === "blocked" ? 126 : 125;
      event.stderr_preview = policy.reason;
      event.summary = policy.disposition === "blocked" ? `Blocked: ${policy.reason}` : `Approval required: ${policy.reason}`;
      upsertCommandEvent(event);
      refreshTaskCommandCount(event.task_id);
      appendOrchestratorEvent({
        scope: "command",
        scope_id: event.event_id,
        type: policy.disposition === "blocked" ? "command.failed" : "approval.requested",
        message: event.summary,
        data: event,
      });
      return event;
    }

    const result = input.executor
      ? await input.executor({ command: input.command, args: input.args ?? [], cwd: input.cwd, timeout_ms: input.timeout_ms })
      : await new Promise<{ code: number | null; stdout: string; stderr: string; timed_out?: boolean }>((resolve, reject) => {
      const child = spawn(input.command, input.args ?? [], {
        cwd: input.cwd,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | null = null;
      if (input.timeout_ms && input.timeout_ms > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          stderr += `\nCommand timed out after ${input.timeout_ms}ms.`;
        }, input.timeout_ms);
      }
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr, timed_out: timedOut });
      });
    });

    const latest = getCommandEvent(event.event_id) ?? event;
    const timedOut = Boolean(result.timed_out);
    const exitCode = timedOut ? 124 : result.code;
    latest.ended_at = new Date().toISOString();
    latest.exit_code = exitCode;
    const redactedStdout = redactSensitiveText(result.stdout);
    const redactedStderr = redactSensitiveText(result.stderr);
    latest.stdout_ref = writeLargeLog(event.event_id, "stdout", result.stdout);
    latest.stderr_ref = writeLargeLog(event.event_id, "stderr", result.stderr);
    latest.stdout_preview = preview(redactedStdout);
    latest.stderr_preview = preview(redactedStderr);
    latest.summary = timedOut
      ? `Command timed out after ${input.timeout_ms}ms.`
      : exitCode === 0 ? "Command completed successfully." : `Command exited with code ${exitCode ?? "null"}.`;
    upsertCommandEvent(latest);
    refreshTaskCommandCount(latest.task_id);
    appendOrchestratorEvent({
      scope: "command",
      scope_id: latest.event_id,
      type: exitCode === 0 ? "command.completed" : "command.failed",
      message: latest.summary,
      data: latest,
    });
    return latest;
  }
}
