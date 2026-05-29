import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { WebSocket } from "ws";

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate TCP port."));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess) {
  const deadline = Date.now() + 15_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Backend did not become healthy: ${lastError}`);
}

function spawnBackend(port: number, storeDir: string) {
  return spawn(process.execPath, ["--import", "tsx", "codex-phone-supervisor/backend/src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_PHONE_SUPERVISOR_HOST: "127.0.0.1",
      CODEX_PHONE_SUPERVISOR_PORT: String(port),
      CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS: "http://127.0.0.1:4318",
      CODEX_PHONE_SUPERVISOR_CODEX_COMMAND: process.execPath,
      CODEX_PHONE_SUPERVISOR_CODEX_HOME: process.cwd(),
      CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH: process.cwd(),
      CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT: process.cwd(),
      CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS: process.cwd(),
      CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "1",
      CODEX_PHONE_SUPERVISOR_TERMINAL_SHELL: "/bin/sh",
      CODEX_PHONE_SUPERVISOR_TERMINAL_SHELL_ARGS: "",
      CODEX_PHONE_SUPERVISOR_TERMINAL_CWD: process.cwd(),
      CODEX_PHONE_SUPERVISOR_TERMINAL_PATH: "/usr/bin:/bin",
      CODEX_PHONE_SUPERVISOR_TERMINAL_WS_PATH: "/terminal/ws",
      CODEX_PHONE_SUPERVISOR_TERMINAL_ALLOW_REMOTE: "0",
      CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
      CODEX_PHONE_SUPERVISOR_STORE_DIR: storeDir,
      CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
      CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
      CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
      CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL: "",
      CODEX_PHONE_SUPERVISOR_TEST_MODE: "1",
      SUPERVISOR_MODEL_PROVIDER: "codex_cli",
        CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL: "deterministic",
      TWILIO_CONVERSATION_RELAY_WS_URL: "",
      TWILIO_SMS_ENABLED: "0",
      TWILIO_VOICE_ENABLED: "0",
      TWILIO_VALIDATE_SIGNATURES: "0",
      TWILIO_AUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("operator terminal websocket runs a command in the configured cwd", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `terminal-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const output = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/ws`, {
        headers: { Origin: "http://127.0.0.1:4318" },
      });
      let text = "";
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for terminal output: ${text}`)), 8000);
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type?: string; data?: string; status?: string };
        if (message.type === "status" && message.status === "connected") {
          ws.send(JSON.stringify({ type: "input", data: "pwd; printf terminal-ok\\n\n" }));
        }
        if (message.type === "output") {
          text += message.data ?? "";
          if (text.includes("terminal-ok")) {
            clearTimeout(timeout);
            ws.close();
            resolve(text);
          }
        }
      });
      ws.on("error", reject);
    });
    assert.match(output, /terminal-ok/);
    assert.match(output, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    child.kill();
  }
});

test("desktop Codex terminal endpoint fails clearly when disabled", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `terminal-disabled-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const response = await fetch(`http://127.0.0.1:${port}/terminal/launch-codex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.match(body, /Desktop terminal launch is disabled/);
  } finally {
    child.kill();
  }
});
