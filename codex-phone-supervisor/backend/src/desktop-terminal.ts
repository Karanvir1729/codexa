import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { appendAuditEvent } from "./store.js";

export class DesktopTerminalLaunchDisabledError extends Error {
  constructor() {
    super("Desktop terminal launch is disabled. Set CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED=1 to enable it.");
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspace(rawWorkspacePath?: string) {
  const requested = rawWorkspacePath?.trim() || config.defaultWorkspacePath;
  const resolved = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(config.defaultWorkspacePath, requested);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Terminal workspace is not an existing directory: ${resolved}`);
  }
  const realWorkspace = fs.realpathSync(resolved);
  const realDefaultWorkspace = fs.realpathSync(config.defaultWorkspacePath);
  if (!isWithinDirectory(realWorkspace, realDefaultWorkspace)) {
    throw new Error("Terminal workspace must be inside CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH.");
  }
  return resolved;
}

export function buildCodexTerminalCommand(workspacePath = config.defaultWorkspacePath) {
  return [
    `cd ${shellQuote(workspacePath)}`,
    `CODEX_HOME=${shellQuote(config.codexHome)}`,
    `PATH=${shellQuote(config.desktopTerminal.path)}`,
    `exec ${shellQuote(config.codexCommand)}`,
  ].join(" && ");
}

export function launchCodexInDesktopTerminal(workspacePath?: string) {
  if (!config.desktopTerminal.enabled) throw new DesktopTerminalLaunchDisabledError();
  const resolvedWorkspace = resolveWorkspace(workspacePath);
  const command = buildCodexTerminalCommand(resolvedWorkspace);
  const script = [
    `tell application id ${appleScriptString(config.desktopTerminal.appId)}`,
    "activate",
    `do script ${appleScriptString(command)}`,
    "end tell",
  ].join("\n");

  const child = spawn(config.desktopTerminal.osascriptCommand, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  appendAuditEvent({
    session_id: "desktop-terminal",
    ts: new Date().toISOString(),
    source: "user",
    type: "desktop_terminal.codex.launch_requested",
    message: `Requested Codex desktop terminal launch at ${resolvedWorkspace}.`,
    data: {
      workspace_path: resolvedWorkspace,
      app_id: config.desktopTerminal.appId,
      osascript_pid: child.pid,
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    appendAuditEvent({
      session_id: "desktop-terminal",
      ts: new Date().toISOString(),
      source: "system",
      type: "desktop_terminal.codex.launch_error",
      message: error.message,
      data: { workspace_path: resolvedWorkspace, app_id: config.desktopTerminal.appId },
    });
  });
  const timeout = setTimeout(() => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    appendAuditEvent({
      session_id: "desktop-terminal",
      ts: new Date().toISOString(),
      source: "system",
      type: "desktop_terminal.codex.launch_timeout",
      message: `Desktop terminal launcher exceeded ${config.desktopTerminal.launchTimeoutMs}ms and was stopped.`,
      data: { workspace_path: resolvedWorkspace, app_id: config.desktopTerminal.appId },
    });
  }, config.desktopTerminal.launchTimeoutMs);
  timeout.unref();
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    appendAuditEvent({
      session_id: "desktop-terminal",
      ts: new Date().toISOString(),
      source: "system",
      type: code === 0 ? "desktop_terminal.codex.launch_completed" : "desktop_terminal.codex.launch_failed",
      message: code === 0 ? "Desktop terminal launcher completed." : `Desktop terminal launcher exited with code ${code ?? "null"}${signal ? ` and signal ${signal}` : ""}.`,
      data: {
        workspace_path: resolvedWorkspace,
        app_id: config.desktopTerminal.appId,
        code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      },
    });
  });
  child.unref();

  return {
    ok: true,
    status: "submitted",
    workspace_path: resolvedWorkspace,
    app_id: config.desktopTerminal.appId,
  };
}
