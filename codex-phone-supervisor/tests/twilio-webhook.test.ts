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

async function waitForMessage(messages: string[], predicate: (message: string) => boolean, label: string) {
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for websocket message: ${label}. Received: ${messages.join(" | ")}`);
}

test("Twilio SMS and voice webhooks return TwiML without running Codex", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `twilio-webhook-test-${port}`);
  const child = spawn(process.execPath, ["--import", "tsx", "codex-phone-supervisor/backend/src/index.ts"], {
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
      CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
      CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
      CODEX_PHONE_SUPERVISOR_STORE_DIR: storeDir,
      CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
      CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
      CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
      CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL: "",
      CODEX_PHONE_SUPERVISOR_TEST_MODE: "1",
      SUPERVISOR_MODEL_PROVIDER: "codex_cli",
        CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL: "deterministic",
      TWILIO_CONVERSATION_RELAY_WS_URL: `ws://127.0.0.1:${port}/twilio/conversation-relay`,
      TWILIO_SMS_ENABLED: "1",
      TWILIO_VOICE_ENABLED: "1",
      TWILIO_VALIDATE_SIGNATURES: "0",
      TWILIO_AUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth(port, child);
    const projectsResponse = await fetch(`http://127.0.0.1:${port}/projects`);
    assert.equal(projectsResponse.status, 200);
    const projectsPayload = await projectsResponse.json() as { projects: Array<{ project_id: string }> };
    assert.ok(projectsPayload.projects.length);

    const webText = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "test-web-user",
        channel: "web_text",
        text: "what is Codex doing?",
        project_id: projectsPayload.projects[0].project_id,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(webText.status, 200);
    assert.match((await webText.json() as { text: string }).text, /Codex is/);

    const sms = await fetch(`http://127.0.0.1:${port}/twilio/sms`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: "+15551234567", Body: "" }),
    });
    assert.equal(sms.status, 200);
    assert.match(await sms.text(), /<Message>/);

    const voice = await fetch(`http://127.0.0.1:${port}/twilio/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA_TEST_CALL", From: "+15551234567" }),
    });
    assert.equal(voice.status, 200);
    assert.match(await voice.text(), /ConversationRelay/);
  } finally {
    child.kill();
  }
});

test("Twilio voice webhook returns TwiML when voice is disabled", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `twilio-disabled-test-${port}`);
  const child = spawn(process.execPath, ["--import", "tsx", "codex-phone-supervisor/backend/src/index.ts"], {
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
      CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
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
      TWILIO_SMS_ENABLED: "1",
      TWILIO_VOICE_ENABLED: "0",
      TWILIO_VALIDATE_SIGNATURES: "0",
      TWILIO_AUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth(port, child);
    const voice = await fetch(`http://127.0.0.1:${port}/twilio/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA_TEST_CALL", From: "+15551234567" }),
    });
    assert.equal(voice.status, 200);
    assert.equal(voice.headers.get("content-type")?.includes("text/xml"), true);
    assert.match(await voice.text(), /voice calls are not enabled/i);
  } finally {
    child.kill();
  }
});

test("Twilio ConversationRelay socket receives grounded progress updates", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `twilio-progress-test-${port}`);
  const child = spawn(process.execPath, ["--import", "tsx", "codex-phone-supervisor/backend/src/index.ts"], {
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
      CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
      CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
      CODEX_PHONE_SUPERVISOR_STORE_DIR: storeDir,
      CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
      CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
      CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
      CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL: "",
      CODEX_PHONE_SUPERVISOR_TEST_MODE: "1",
      SUPERVISOR_MODEL_PROVIDER: "codex_cli",
        CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL: "deterministic",
      TWILIO_CONVERSATION_RELAY_WS_URL: `ws://127.0.0.1:${port}/twilio/conversation-relay`,
      TWILIO_SMS_ENABLED: "1",
      TWILIO_VOICE_ENABLED: "1",
      TWILIO_VALIDATE_SIGNATURES: "0",
      TWILIO_AUTH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ws: WebSocket | undefined;
  try {
    await waitForHealth(port, child);
    const voice = await fetch(`http://127.0.0.1:${port}/twilio/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ CallSid: "CA_PROGRESS_CALL", From: "+15557654321" }),
    });
    assert.equal(voice.status, 200);
    const twiml = await voice.text();
    const relayUrl = twiml.match(/url="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(relayUrl);
    const sessionId = new URL(relayUrl).searchParams.get("session_id");
    assert.ok(sessionId);

    const messages: string[] = [];
    ws = new WebSocket(relayUrl);
    ws.on("message", (raw) => messages.push(String(raw)));
    await new Promise<void>((resolve, reject) => {
      ws?.once("open", resolve);
      ws?.once("error", reject);
    });

    const projectsResponse = await fetch(`http://127.0.0.1:${port}/projects`);
    assert.equal(projectsResponse.status, 200);
    const projectsPayload = await projectsResponse.json() as { projects: Array<{ project_id: string }> };
    const projectId = projectsPayload.projects[0].project_id;
    const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        project_id: projectId,
        user_goal: "Twilio progress socket smoke",
        normalized_goal: "twilio progress socket smoke",
        assign_worker: true,
        worker_type: "local",
      }),
    });
    assert.equal(taskResponse.status, 201);
    const taskPayload = await taskResponse.json() as { task: { task_id: string }; worker: { worker_id: string } };

    const taskProgress = await waitForMessage(messages, (message) => message.includes(taskPayload.task.task_id), "task progress");
    assert.match(taskProgress, /"type":"text"/);

    const commandEventId = `cmd_twilio_${Date.now()}`;
    const commandResponse = await fetch(`http://127.0.0.1:${port}/workers/${taskPayload.worker.worker_id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: commandEventId,
        task_id: taskPayload.task.task_id,
        project_id: projectId,
        worker_id: taskPayload.worker.worker_id,
        command: "pwd",
        cwd: process.cwd(),
        started_at: new Date(Date.now() - 200).toISOString(),
        ended_at: new Date().toISOString(),
        exit_code: 0,
        stdout_ref: null,
        stderr_ref: null,
        stdout_preview: process.cwd(),
        stderr_preview: "",
        summary: "Printed workspace path for Twilio progress smoke.",
        risk_level: "low",
        approved_by_user: false,
        created_at: new Date().toISOString(),
      }),
    });
    assert.equal(commandResponse.status, 202);
    const commandProgress = await waitForMessage(messages, (message) => message.includes("pwd completed successfully"), "command progress");
    assert.doesNotMatch(commandProgress, /stdout_preview/);
  } finally {
    ws?.close();
    child.kill();
  }
});
