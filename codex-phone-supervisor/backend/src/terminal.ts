import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { appendAuditEvent } from "./store.js";

type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "interrupt" }
  | { type: "resize"; cols: number; rows: number };

function parseRequestPath(rawUrl: string | undefined) {
  if (!rawUrl) return { pathname: "", searchParams: new URLSearchParams() };
  const [pathname, query = ""] = rawUrl.split("?");
  return { pathname, searchParams: new URLSearchParams(query) };
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string) {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function parseClientMessage(raw: Buffer) {
  const text = raw.toString("utf8");
  const parsed = JSON.parse(text) as TerminalClientMessage;
  if (parsed.type === "input" && typeof parsed.data === "string") return parsed;
  if (parsed.type === "interrupt") return parsed;
  if (parsed.type === "resize" && Number.isFinite(parsed.cols) && Number.isFinite(parsed.rows)) return parsed;
  throw new Error("Unsupported terminal message.");
}

function terminalEnv() {
  return {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? "",
    SHELL: config.terminal.shell,
    PATH: config.terminal.path,
    PWD: config.terminal.cwd,
    CODEX_HOME: config.codexHome,
    NO_COLOR: "0",
    FORCE_COLOR: "1",
  };
}

function startShell() {
  return spawn(config.terminal.shell, config.terminal.shellArgs, {
    cwd: config.terminal.cwd,
    env: terminalEnv(),
    stdio: "pipe",
  });
}

function wireShell(ws: WebSocket, child: ChildProcessWithoutNullStreams, connectionId: string) {
  send(ws, {
    type: "status",
    status: "connected",
    cwd: config.terminal.cwd,
    shell: config.terminal.shell,
    shell_args: config.terminal.shellArgs,
  });

  child.stdout.on("data", (chunk) => send(ws, { type: "output", stream: "stdout", data: chunk.toString("utf8") }));
  child.stderr.on("data", (chunk) => send(ws, { type: "output", stream: "stderr", data: chunk.toString("utf8") }));
  child.on("error", (error) => {
    send(ws, { type: "error", message: error.message });
    appendAuditEvent({
      session_id: connectionId,
      ts: new Date().toISOString(),
      source: "system",
      type: "terminal.error",
      message: error.message,
    });
  });
  child.on("close", (code, signal) => {
    send(ws, { type: "status", status: "closed", code, signal });
    appendAuditEvent({
      session_id: connectionId,
      ts: new Date().toISOString(),
      source: "system",
      type: "terminal.closed",
      message: `Terminal shell closed with code ${code ?? "null"}${signal ? ` and signal ${signal}` : ""}.`,
      data: { code, signal },
    });
    ws.close();
  });
}

function handleTerminalConnection(ws: WebSocket, request: IncomingMessage) {
  const connectionId = `terminal:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const origin = request.headers.origin || "";
  appendAuditEvent({
    session_id: connectionId,
    ts: new Date().toISOString(),
    source: "system",
    type: "terminal.connected",
    message: `Local operator terminal connected from ${origin || "unknown origin"}.`,
    data: {
      cwd: config.terminal.cwd,
      shell: config.terminal.shell,
      origin,
    },
  });

  const child = startShell();
  wireShell(ws, child, connectionId);

  ws.on("message", (raw) => {
    try {
      const message = parseClientMessage(raw as Buffer);
      if (message.type === "input") {
        child.stdin.write(message.data);
        appendAuditEvent({
          session_id: connectionId,
          ts: new Date().toISOString(),
          source: "user",
          type: "terminal.input",
          message: `Operator sent ${message.data.length} byte(s) to the terminal.`,
        });
      }
      if (message.type === "interrupt") {
        child.kill("SIGINT");
        appendAuditEvent({
          session_id: connectionId,
          ts: new Date().toISOString(),
          source: "user",
          type: "terminal.interrupt",
          message: "Operator sent SIGINT to the terminal.",
        });
      }
    } catch (error) {
      send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });

  ws.on("close", () => {
    if (!child.killed) child.kill("SIGHUP");
  });
}

export function setupTerminalWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = parseRequestPath(request.url);
    if (!config.terminal.enabled || url.pathname !== config.terminal.wsPath) return;
    const origin = request.headers.origin || "";
    if (!origin || !config.allowedOrigins.includes(origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", handleTerminalConnection);
}
