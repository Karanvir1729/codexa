import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";

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
      TWILIO_SMS_ENABLED: "0",
      TWILIO_VOICE_ENABLED: "0",
      TWILIO_VALIDATE_SIGNATURES: "0",
      TWILIO_AUTH_TOKEN: "",
      WORKER_MODE: "local",
      DEFAULT_WORKER_MODE: "local",
      ALLOW_WORKER_MODE_SWITCH: "true",
      MAX_LOCAL_WORKERS: "1",
      MAX_DOCKER_LOCAL_WORKERS: "3",
      MAX_GCP_VM_WORKERS: "10",
      HEAD_DEVELOPER_GCP_VM_DRY_RUN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function firstProjectId(port: number) {
  const projectsResponse = await fetch(`http://127.0.0.1:${port}/projects`);
  assert.equal(projectsResponse.status, 200);
  const projectsPayload = await projectsResponse.json() as { projects: Array<{ project_id: string }> };
  assert.ok(projectsPayload.projects.length);
  return projectsPayload.projects[0].project_id;
}

async function createAssignedTask(port: number, projectId: string, workerMode?: "local" | "docker_local" | "gcp_vm") {
  const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      user_goal: `Flowchart worker smoke ${workerMode ?? "default"} ${Date.now()}`,
      assign_worker: true,
      ...(workerMode ? { worker_type: workerMode } : {}),
    }),
  });
  assert.equal(response.status, 201);
  return await response.json() as { task: { task_id: string; status: string; worker_id: string }; worker: { worker_id: string; type: string; status: string } };
}

test("operator action route honors explicit approved_by_user approval", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `operator-route-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const assigned = await createAssignedTask(port, projectId, "local");
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "operator route approval test", workspace_path: process.cwd() }),
    });
    assert.equal(sessionResponse.status, 201);
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };

    const actionResponse = await fetch(`http://127.0.0.1:${port}/operator/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        action_type: "stop_worker",
        user_goal: "approved worker stop",
        project_id: projectId,
        task_id: assigned.task.task_id,
        worker_id: assigned.worker.worker_id,
        approved_by_user: true,
      }),
    });
    assert.equal(actionResponse.status, 200);
    const payload = await actionResponse.json() as { action: { status: string; approval_id?: string | null; requires_approval: boolean; result: { worker?: { status: string } } } };
    assert.equal(payload.action.status, "completed");
    assert.equal(payload.action.approval_id ?? null, null);
    assert.equal(payload.action.requires_approval, false);
    assert.equal(payload.action.result.worker?.status, "stopped");
  } finally {
    child.kill();
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("web text development requests are mediated by the supervisor before Codex tools", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-flow-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectsResponse = await fetch(`http://127.0.0.1:${port}/projects`);
    assert.equal(projectsResponse.status, 200);
    const projectsPayload = await projectsResponse.json() as { projects: Array<{ project_id: string }> };
    assert.ok(projectsPayload.projects.length);

    const message = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "test-web-user",
        channel: "web_text",
        text: "Tell Codex to build and deploy a Cloud Run service for this project.",
        project_id: projectsPayload.projects[0].project_id,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(message.status, 200);
    const messagePayload = await message.json() as { text: string; sessionId: string; requiresApproval?: boolean; approvalId?: string };
    assert.equal(messagePayload.requiresApproval, true);
    assert.ok(messagePayload.approvalId);
    assert.match(messagePayload.text, /Approval required before Codex can run/i);

    const events = await fetch(`http://127.0.0.1:${port}/codex/events?session_id=${messagePayload.sessionId}`);
    assert.equal(events.status, 200);
    const eventsPayload = await events.json() as { events: Array<{ type: string }> };
    assert.ok(
      eventsPayload.events.some((event) => event.type === "supervisor.development.sent_to_codex"),
      "expected the supervisor model path to emit a sent_to_codex event",
    );

    const toolMessage = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: messagePayload.sessionId,
        user_id: "test-web-user",
        channel: "web_text",
        text: "Show me the event timeline.",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(toolMessage.status, 200);
    const toolPayload = await toolMessage.json() as { text: string };
    assert.match(toolPayload.text, /Latest Codex events|No Codex events/i);

    const afterToolEvents = await fetch(`http://127.0.0.1:${port}/codex/events?session_id=${messagePayload.sessionId}`);
    assert.equal(afterToolEvents.status, 200);
    const afterToolEventsPayload = await afterToolEvents.json() as { events: Array<{ type: string }> };
    assert.ok(
      afterToolEventsPayload.events.some((event) => event.type === "supervisor.tool.called"),
      "expected the supervisor model path to run a non-Codex backend tool",
    );
  } finally {
    child.kill();
  }
});

test("web text new-project requests run Codex from the configured repo root", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-new-project-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectName = `cobalt chairs ${port}`;
    const message = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "test-web-user",
        channel: "web_text",
        text: `can you build a website that talks about ${projectName}`,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(message.status, 200);
    const payload = await message.json() as { text: string; sessionId: string };
    assert.match(payload.text, /Creating Cobalt Chairs/);
    assert.match(payload.text, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(payload.text, /Which project do you mean/i);

    const events = await fetch(`http://127.0.0.1:${port}/codex/events?session_id=${payload.sessionId}`);
    assert.equal(events.status, 200);
    const eventsPayload = await events.json() as { events: Array<{ type: string; message: string; data?: { cwd?: string; args?: string[] } }> };
    const cliStarted = eventsPayload.events.find((event) => event.type === "codex.cli.started");
    assert.ok(cliStarted, "expected a Codex CLI start event");
    assert.equal(cliStarted.data?.cwd, process.cwd());
    assert.ok(cliStarted.data?.args?.includes("[worker prompt omitted from UI log]"));
  } finally {
    child.kill();
  }
});

test("web text commerce website requests create a new repo-local project", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-commerce-project-test-${port}`);
  const child = spawnBackend(port, storeDir);
  const productName = `cobalt dumplings ${port}`;
  const expectedProjectName = `Selling Cobalt Dumplings ${port} Website`;
  const expectedProjectSlug = `selling-cobalt-dumplings-${port}-website`;

  try {
    await waitForHealth(port, child);
    const message = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "test-web-user",
        channel: "web_text",
        text: `make a website for selling ${productName}`,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(message.status, 200);
    const payload = await message.json() as { text: string; sessionId: string };
    assert.match(payload.text, new RegExp(`Creating ${expectedProjectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(payload.text, /Which project|What kind of new project|Do you want/i);

    const events = await fetch(`http://127.0.0.1:${port}/codex/events?session_id=${payload.sessionId}`);
    assert.equal(events.status, 200);
    const eventsPayload = await events.json() as { events: Array<{ type: string; message: string; data?: { target_project_path?: string; cwd?: string } }> };
    const cliStarted = eventsPayload.events.find((event) => event.type === "codex.cli.started");
    assert.ok(cliStarted, "expected a Codex CLI start event");
    assert.equal(cliStarted.data?.cwd, process.cwd());
    assert.match(cliStarted.data?.target_project_path ?? "", new RegExp(`${expectedProjectSlug}$`));
  } finally {
    child.kill();
  }
});

test("web text natural app requests create a new repo-local project", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-natural-app-test-${port}`);
  const child = spawnBackend(port, storeDir);
  const useCase = `trail snack planner ${port}`;
  const expectedProjectSlug = `calorie-calculator-for-${useCase.replaceAll(" ", "-")}-app`;

  try {
    await waitForHealth(port, child);
    const message = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "test-web-user",
        channel: "web_text",
        text: `I need a calorie calculator app for ${useCase}`,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(message.status, 200);
    const payload = await message.json() as { text: string; sessionId: string };
    assert.match(payload.text, /Creating Calorie Calculator/);
    assert.doesNotMatch(payload.text, /Would you like to create|Which project/i);

    const events = await fetch(`http://127.0.0.1:${port}/codex/events?session_id=${payload.sessionId}`);
    assert.equal(events.status, 200);
    const eventsPayload = await events.json() as { events: Array<{ type: string; data?: { target_project_path?: string } }> };
    const cliStarted = eventsPayload.events.find((event) => event.type === "codex.cli.started");
    assert.ok(cliStarted, "expected a Codex CLI start event");
    assert.match(cliStarted.data?.target_project_path ?? "", new RegExp(`${expectedProjectSlug}$`));
  } finally {
    child.kill();
  }
});

test("web text vague game requests clarify before creating a project", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-game-handshake-test-${port}`);
  const child = spawnBackend(port, storeDir);
  const gameName = `shooting stars ${port}`;
  const expectedProjectSlug = `shooting-stars-${port}`;

  try {
    await waitForHealth(port, child);
    const firstMessage = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "test-web-user",
        channel: "web_text",
        text: "build a game",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(firstMessage.status, 200);
    const firstPayload = await firstMessage.json() as { text: string; sessionId: string };
    assert.match(firstPayload.text, /what kind of game/i);

    const firstStatus = await fetch(`http://127.0.0.1:${port}/codex/status?session_id=${firstPayload.sessionId}`);
    assert.equal(firstStatus.status, 200);
    const firstStatusPayload = await firstStatus.json() as { session: { pending_action?: { type?: string; original_user_goal?: string } | null } };
    assert.equal(firstStatusPayload.session.pending_action?.type, "collect_project_name");

    const namedProject = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: firstPayload.sessionId,
        user_id: "test-web-user",
        channel: "web_text",
        text: `build a browser puzzle game called ${gameName}`,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(namedProject.status, 200);
    const namedPayload = await namedProject.json() as { text: string; sessionId: string };
    assert.match(namedPayload.text, /Creating Shooting Stars/);

    const events = await fetch(`http://127.0.0.1:${port}/codex/events?session_id=${namedPayload.sessionId}`);
    assert.equal(events.status, 200);
    const eventsPayload = await events.json() as { events: Array<{ type: string; data?: { target_project_path?: string } }> };
    const cliStarted = eventsPayload.events.find((event) => event.type === "codex.cli.started");
    assert.ok(cliStarted, "expected a Codex CLI start event");
    assert.match(cliStarted.data?.target_project_path ?? "", new RegExp(`${expectedProjectSlug}$`));

    const createRequested = eventsPayload.events.find((event) => event.type === "project.create.requested") as { data?: { target_path?: string } } | undefined;
    assert.ok(createRequested, "expected deterministic create_project to run with required args");
    assert.match(createRequested.data?.target_path ?? "", new RegExp(`${expectedProjectSlug}$`));
  } finally {
    child.kill();
  }
});

test("project intake uses Codex decision for follow-up project names", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-project-intake-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const firstMessage = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "test-web-user",
        channel: "web_text",
        text: "Can you make a chess game",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(firstMessage.status, 200);
    const firstPayload = await firstMessage.json() as { text: string; sessionId: string };
    assert.match(firstPayload.text, /what should i call/i);

    const status = await fetch(`http://127.0.0.1:${port}/codex/status?session_id=${firstPayload.sessionId}`);
    assert.equal(status.status, 200);
    const statusPayload = await status.json() as { session: { pending_action?: { type?: string; original_user_goal?: string } | null } };
    assert.equal(statusPayload.session.pending_action?.type, "collect_project_name");
    assert.match(statusPayload.session.pending_action?.original_user_goal ?? "", /chess game/i);

    const namedProject = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: firstPayload.sessionId,
        user_id: "test-web-user",
        channel: "web_text",
        text: "Yes please create a new project and call it jk",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(namedProject.status, 200);
    const namedPayload = await namedProject.json() as { text: string; sessionId: string };
    assert.match(namedPayload.text, /Creating Jk/i);
    assert.doesNotMatch(namedPayload.text, /Project name: Yes please/i);
    assert.doesNotMatch(namedPayload.text, /task graph|output-contract|one worker/i);

    const events = await fetch(`http://127.0.0.1:${port}/codex/events?session_id=${namedPayload.sessionId}`);
    assert.equal(events.status, 200);
    const eventsPayload = await events.json() as { events: Array<{ type: string; message: string; data?: { decision?: { project_name?: string | null }; target_path?: string } }> };
    assert.ok(eventsPayload.events.some((event) => event.type === "project_intake.codex_decision"), "expected Codex project-intake decision event");
    assert.ok(eventsPayload.events.some((event) => event.type === "project.create.requested" && /\/jk$/.test(event.data?.target_path ?? "")));
    assert.ok(!eventsPayload.events.some((event) => /yes-please-create-a-new-project/i.test(event.data?.target_path ?? "")));
  } finally {
    child.kill();
  }
});

test("standalone commerce website request creates a new project even when another project is selected", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-selected-commerce-test-${port}`);
  const child = spawnBackend(port, storeDir);
  const productName = `market dumplings ${port}`;
  const expectedProjectSlug = `selling-market-dumplings-${port}-website`;

  try {
    await waitForHealth(port, child);
    const projectsResponse = await fetch(`http://127.0.0.1:${port}/projects`);
    assert.equal(projectsResponse.status, 200);
    const projectsPayload = await projectsResponse.json() as { projects: Array<{ project_id: string }> };
    assert.ok(projectsPayload.projects.length);

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/supervisor/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "selected project test", workspace_path: process.cwd() }),
    });
    assert.equal(sessionResponse.status, 201);
    const sessionPayload = await sessionResponse.json() as { session_id: string };

    const selectResponse = await fetch(`http://127.0.0.1:${port}/projects/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectsPayload.projects[0].project_id, session_id: sessionPayload.session_id }),
    });
    assert.equal(selectResponse.status, 200);

    const message = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: `make a website for selling ${productName}`,
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(message.status, 200);
    const payload = await message.json() as { text: string; sessionId: string };
    assert.match(payload.text, /Creating Selling Market Dumplings/);
    assert.doesNotMatch(payload.text, /Which project|current project|existing project/i);

    const events = await fetch(`http://127.0.0.1:${port}/codex/events?session_id=${payload.sessionId}`);
    assert.equal(events.status, 200);
    const eventsPayload = await events.json() as { events: Array<{ type: string; data?: { target_project_path?: string } }> };
    const cliStarted = eventsPayload.events.find((event) => event.type === "codex.cli.started");
    assert.ok(cliStarted, "expected a Codex CLI start event");
    assert.match(cliStarted.data?.target_project_path ?? "", new RegExp(`${expectedProjectSlug}$`));
  } finally {
    child.kill();
  }
});

test("stale session requests return structured SESSION_NOT_FOUND errors", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-stale-session-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const missingSessionId = `missing-${port}`;
    const summary = await fetch(`http://127.0.0.1:${port}/codex/summary?session_id=${missingSessionId}`);
    assert.equal(summary.status, 404);
    const summaryPayload = await summary.json() as { error?: { code?: string; message?: string } };
    assert.equal(summaryPayload.error?.code, "SESSION_NOT_FOUND");

    const message = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: missingSessionId,
        user_id: "test-web-user",
        channel: "web_text",
        text: "what is happening?",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(message.status, 404);
    const messagePayload = await message.json() as { error?: { code?: string; message?: string } };
    assert.equal(messagePayload.error?.code, "SESSION_NOT_FOUND");
    assert.equal(messagePayload.error?.message, "Session not found.");
  } finally {
    child.kill();
  }
});

test("task API assigns a dry-run GCP VM worker without creating cloud resources", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `web-text-gcp-worker-dry-run-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectsResponse = await fetch(`http://127.0.0.1:${port}/projects`);
    assert.equal(projectsResponse.status, 200);
    const projectsPayload = await projectsResponse.json() as { projects: Array<{ project_id: string }> };
    assert.ok(projectsPayload.projects.length);

    const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectsPayload.projects[0].project_id,
        user_goal: "Run a safe worker smoke command",
        assign_worker: true,
        worker_type: "gcp_vm",
      }),
    });
    assert.equal(taskResponse.status, 201);
    const payload = await taskResponse.json() as { task: { status: string; worker_id?: string }; worker: { type: string; status: string; metadata?: { dry_run?: boolean } } };
    assert.equal(payload.task.status, "running");
    assert.equal(payload.worker.type, "gcp_vm");
    assert.equal(payload.worker.status, "running");
    assert.equal(payload.worker.metadata?.dry_run, true);
  } finally {
    child.kill();
  }
});

test("flowchart state is generated from real project task worker command and summary state", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `flowchart-real-state-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const assigned = await createAssignedTask(port, projectId, "local");

    const commandEvent = {
      event_id: `cmd_${port}`,
      task_id: assigned.task.task_id,
      project_id: projectId,
      worker_id: assigned.worker.worker_id,
      command: "npm run typecheck",
      cwd: process.cwd(),
      started_at: new Date(Date.now() - 500).toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "typecheck passed",
      stderr_preview: "",
      summary: "Command completed successfully.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date().toISOString(),
    };
    const eventResponse = await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandEvent),
    });
    assert.equal(eventResponse.status, 202);

    const resultResponse = await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: assigned.task.task_id, status: "completed", summary: "Flowchart smoke completed." }),
    });
    assert.equal(resultResponse.status, 200);

    const flowchartResponse = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`);
    assert.equal(flowchartResponse.status, 200);
    const flowchart = await flowchartResponse.json() as { nodes: Array<{ id: string; type: string; visual_state: string; detail: any }>; edges: Array<{ from: string; to: string; label: string }> };
    assert.ok(flowchart.nodes.some((node) => node.id === `task:${assigned.task.task_id}` && node.type === "task"));
    assert.ok(flowchart.nodes.some((node) => node.id === `worker:${assigned.worker.worker_id}` && node.type === "worker"));
    assert.ok(flowchart.nodes.some((node) => node.id === `command:${commandEvent.event_id}` && node.type === "command" && node.visual_state === "completed"));
    assert.ok(flowchart.nodes.some((node) => node.id === `summary:${assigned.task.task_id}` && node.type === "summary"));
    assert.ok(flowchart.edges.some((edge) => edge.from === `task:${assigned.task.task_id}` && edge.to === `worker:${assigned.worker.worker_id}`));
    assert.ok(flowchart.edges.some((edge) => edge.from === `worker:${assigned.worker.worker_id}` && edge.to === `command:${commandEvent.event_id}`));
  } finally {
    child.kill();
  }
});

test("preview action serves a verified generated static app and adds flowchart preview state", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `preview-static-test-store-${port}`);
  const workspaceDir = path.join(process.cwd(), "tmp", `preview-static-app-${port}`);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "index.html"), [
    "<!doctype html>",
    "<html><head><title>Tea Shop</title><link rel=\"stylesheet\" href=\"styles.css\"></head>",
    "<body><main><h1>Tea Shop</h1><button id=\"order\">Order tea</button></main><script src=\"script.js\"></script></body></html>",
  ].join(""));
  fs.writeFileSync(path.join(workspaceDir, "styles.css"), "body { font-family: sans-serif; } main { color: #234; }");
  fs.writeFileSync(path.join(workspaceDir, "script.js"), "document.getElementById('order')?.addEventListener('click', () => console.log('tea'));\n");
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectResponse = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_uri: workspaceDir }),
    });
    assert.equal(projectResponse.status, 201);
    const projectPayload = await projectResponse.json() as { project: { project_id: string } };

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "preview static app", channel: "web_text", user_id: "test-web-user", workspace_path: workspaceDir }),
    });
    assert.equal(sessionResponse.status, 201);
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };

    const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        project_id: projectPayload.project.project_id,
        user_goal: "Build a simple landing page for a tea shop.",
        assign_worker: true,
        worker_type: "local",
      }),
    });
    assert.equal(taskResponse.status, 201);
    const assigned = await taskResponse.json() as { task: { task_id: string }; worker: { worker_id: string } };

    const commandEvent = {
      event_id: `cmd_preview_codex_${port}`,
      task_id: assigned.task.task_id,
      project_id: projectPayload.project.project_id,
      worker_id: assigned.worker.worker_id,
      command: "codex exec --json Build a tea shop landing page",
      cwd: workspaceDir,
      started_at: new Date(Date.now() - 1000).toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "?? index.html\n?? styles.css\n?? script.js\n",
      stderr_preview: "",
      summary: "Codex created generated app files.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date().toISOString(),
    };
    assert.equal((await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandEvent),
    })).status, 202);
    assert.equal((await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: assigned.task.task_id, status: "completed", summary: "Tea app completed." }),
    })).status, 200);

    const previewMessage = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "Preview it",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(previewMessage.status, 200);
    const previewPayload = await previewMessage.json() as { text: string };
    assert.match(previewPayload.text, /\/previews\/preview_/);
    const previewUrl = previewPayload.text.match(/http:\/\/127\.0\.0\.1:\d+\/previews\/preview_[^.\s]+\/?/)?.[0];
    assert.ok(previewUrl, "expected preview URL in chat response");

    const htmlResponse = await fetch(previewUrl);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, /Tea Shop/);
    assert.match(html, /preview_/);

    const previewId = previewUrl.match(/\/previews\/(preview_[^/]+)\//)?.[1];
    assert.ok(previewId);
    const reportResponse = await fetch(`http://127.0.0.1:${port}/previews/${previewId}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loaded: true, console_errors: [] }),
    });
    assert.equal(reportResponse.status, 200);

    const flowchart = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`).then((response) => response.json()) as { nodes: Array<{ id: string; type: string; status: string; detail: any }>; edges: Array<{ from: string; to: string; label: string }> };
    assert.ok(flowchart.nodes.some((node) => node.type === "preview" && node.id === `preview:${previewId}` && node.status === "loaded"));
    assert.ok(flowchart.edges.some((edge) => edge.from === `task:${assigned.task.task_id}` && edge.to === `preview:${previewId}`));
    assert.ok(flowchart.edges.some((edge) => edge.to === `preview:${previewId}` && edge.label === "preview command"));

    const taskState = await fetch(`http://127.0.0.1:${port}/tasks/${assigned.task.task_id}`).then((response) => response.json()) as { task: { command_count: number; latest_preview?: { loaded: boolean; entry_file: string; asset_paths: string[] } }; commands: Array<{ command: string; exit_code: number | null }> };
    assert.equal(taskState.task.latest_preview?.loaded, true);
    assert.equal(taskState.task.latest_preview?.entry_file, "index.html");
    assert.deepEqual(taskState.task.latest_preview?.asset_paths.sort(), ["script.js", "styles.css"]);
    assert.ok(taskState.commands.some((command) => command.command.startsWith("ls -la") && command.exit_code === 0), "expected preview inspection command to be logged");
    assert.equal(taskState.task.command_count, taskState.commands.length);

    const filesQuestion = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "What files power this page?",
        timestamp: new Date().toISOString(),
      }),
    }).then((response) => response.json()) as { text: string };
    assert.match(filesQuestion.text, /index\.html/);
    assert.match(filesQuestion.text, /styles\.css/);
    assert.match(filesQuestion.text, /script\.js/);
  } finally {
    child.kill();
  }
});

test("worker artifact file handoff persists app files into the project workspace", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `artifact-handoff-test-store-${port}`);
  const workspaceDir = path.join(process.cwd(), "tmp", `artifact-handoff-app-${port}`);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const attachResponse = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_uri: workspaceDir }),
    });
    assert.ok([200, 201].includes(attachResponse.status));
    const attachPayload = await attachResponse.json() as { project: { project_id: string } };

    const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: attachPayload.project.project_id, user_goal: "Create static app.", assign_worker: true }),
    });
    assert.equal(taskResponse.status, 201);
    const taskPayload = await taskResponse.json() as { task: { task_id: string }; worker: { worker_id: string } };

    const html = "<!doctype html><title>Artifact App</title><main>artifact handoff ok</main>";
    const uploadResponse = await fetch(`http://127.0.0.1:${port}/workers/${taskPayload.worker.worker_id}/artifacts/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: taskPayload.task.task_id,
        project_id: attachPayload.project.project_id,
        files: [{ path: "index.html", content_base64: Buffer.from(html).toString("base64") }],
      }),
    });
    assert.equal(uploadResponse.status, 202);
    assert.equal(fs.readFileSync(path.join(workspaceDir, "index.html"), "utf8"), html);

    const artifactResponse = await fetch(`http://127.0.0.1:${port}/projects/${attachPayload.project.project_id}/artifacts/files`);
    assert.equal(artifactResponse.status, 200);
    const artifactPayload = await artifactResponse.json() as { files: Array<{ path: string; content_base64: string }> };
    const restored = artifactPayload.files.find((file) => file.path === "index.html");
    assert.ok(restored);
    assert.equal(Buffer.from(restored.content_base64, "base64").toString("utf8"), html);
    fs.writeFileSync(path.join(workspaceDir, "local-only.html"), "<p>local only</p>");
    const persistedOnlyResponse = await fetch(`http://127.0.0.1:${port}/projects/${attachPayload.project.project_id}/artifacts/files?source=persisted`);
    assert.equal(persistedOnlyResponse.status, 200);
    const persistedOnlyPayload = await persistedOnlyResponse.json() as { files: Array<{ path: string }> };
    assert.ok(persistedOnlyPayload.files.some((file) => file.path === "index.html"));
    assert.ok(!persistedOnlyPayload.files.some((file) => file.path === "local-only.html"));
  } finally {
    child.kill();
  }
});

test("preview action restores persisted artifacts when the local workspace copy is missing", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `preview-artifact-restore-store-${port}`);
  const workspaceDir = path.join(process.cwd(), "tmp", `preview-artifact-restore-app-${port}`);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const attachResponse = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_uri: workspaceDir }),
    });
    assert.equal(attachResponse.status, 201);
    const attachPayload = await attachResponse.json() as { project: { project_id: string } };

    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "artifact restore preview", channel: "web_text", user_id: "test-web-user", workspace_path: workspaceDir }),
    });
    assert.equal(sessionResponse.status, 201);
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };

    const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        project_id: attachPayload.project.project_id,
        user_goal: "Create a static artifact-backed preview app.",
        assign_worker: true,
        worker_type: "local",
      }),
    });
    assert.equal(taskResponse.status, 201);
    const taskPayload = await taskResponse.json() as { task: { task_id: string }; worker: { worker_id: string } };

    const html = "<!doctype html><html><head><title>Restored</title><link rel=\"stylesheet\" href=\"styles.css\"></head><body><h1>restored artifact preview</h1><script src=\"script.js\"></script></body></html>";
    const css = "body { font-family: sans-serif; }";
    const js = "window.artifactPreviewLoaded = true;\n";
    const uploadResponse = await fetch(`http://127.0.0.1:${port}/workers/${taskPayload.worker.worker_id}/artifacts/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: taskPayload.task.task_id,
        project_id: attachPayload.project.project_id,
        files: [
          { path: "index.html", content_base64: Buffer.from(html).toString("base64") },
          { path: "styles.css", content_base64: Buffer.from(css).toString("base64") },
          { path: "script.js", content_base64: Buffer.from(js).toString("base64") },
        ],
      }),
    });
    assert.equal(uploadResponse.status, 202);
    fs.rmSync(path.join(workspaceDir, "index.html"), { force: true });
    fs.rmSync(path.join(workspaceDir, "styles.css"), { force: true });
    fs.rmSync(path.join(workspaceDir, "script.js"), { force: true });

    assert.equal((await fetch(`http://127.0.0.1:${port}/workers/${taskPayload.worker.worker_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: taskPayload.task.task_id, status: "completed", summary: "Artifact-backed app completed." }),
    })).status, 200);

    const previewResponse = await fetch(`http://127.0.0.1:${port}/sessions/${sessionPayload.session.session_id}/preview`, { method: "POST" });
    assert.equal(previewResponse.status, 201);
    const previewPayload = await previewResponse.json() as { preview: { preview_url: string; entry_file: string; asset_paths: string[] } };
    assert.equal(previewPayload.preview.entry_file, "index.html");
    assert.deepEqual(previewPayload.preview.asset_paths.sort(), ["script.js", "styles.css"]);
    assert.equal(fs.readFileSync(path.join(workspaceDir, "index.html"), "utf8"), html);

    const htmlResponse = await fetch(previewPayload.preview.preview_url);
    assert.equal(htmlResponse.status, 200);
    assert.match(await htmlResponse.text(), /restored artifact preview/);

    const updatedJs = "window.artifactPreviewLoaded = 'fresh';\n";
    const updateResponse = await fetch(`http://127.0.0.1:${port}/workers/${taskPayload.worker.worker_id}/artifacts/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: taskPayload.task.task_id,
        project_id: attachPayload.project.project_id,
        files: [{ path: "script.js", content_base64: Buffer.from(updatedJs).toString("base64") }],
      }),
    });
    assert.equal(updateResponse.status, 202);
    fs.writeFileSync(path.join(workspaceDir, "script.js"), "window.artifactPreviewLoaded = 'stale';\n");

    const scriptResponse = await fetch(`${previewPayload.preview.preview_url}script.js`);
    assert.equal(scriptResponse.status, 200);
    assert.equal(await scriptResponse.text(), updatedJs);
    fs.writeFileSync(path.join(workspaceDir, "script.js"), "window.artifactPreviewLoaded = 'stale again';\n");
    const cachedScriptResponse = await fetch(`${previewPayload.preview.preview_url}script.js`);
    assert.equal(cachedScriptResponse.status, 200);
    assert.equal(await cachedScriptResponse.text(), updatedJs);
  } finally {
    child.kill();
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("preview action refuses to fake a preview when no verified entry file exists", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `preview-missing-entry-store-${port}`);
  const workspaceDir = path.join(process.cwd(), "tmp", `preview-missing-entry-app-${port}`);
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "readme.md"), "No app entry here.");
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectResponse = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_uri: workspaceDir }),
    });
    const projectPayload = await projectResponse.json() as { project: { project_id: string } };
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "missing entry preview", channel: "web_text", user_id: "test-web-user", workspace_path: workspaceDir }),
    });
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };
    const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        project_id: projectPayload.project.project_id,
        user_goal: "Build an app without an index.",
        assign_worker: true,
        worker_type: "local",
      }),
    });
    const assigned = await taskResponse.json() as { task: { task_id: string }; worker: { worker_id: string } };
    await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: assigned.task.task_id, status: "completed", summary: "No previewable files were created." }),
    });

    const previewResponse = await fetch(`http://127.0.0.1:${port}/sessions/${sessionPayload.session.session_id}/preview`, { method: "POST" });
    assert.equal(previewResponse.status, 409);
    const payload = await previewResponse.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "PREVIEW_ENTRY_NOT_FOUND");
    assert.match(payload.error.message, /could not find/i);
  } finally {
    child.kill();
  }
});

test("worker mode switching affects only new tasks", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `flowchart-worker-mode-switch-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);

    let modeResponse = await fetch(`http://127.0.0.1:${port}/orchestrator/worker-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker_mode: "local" }),
    });
    assert.equal(modeResponse.status, 200);
    const localAssigned = await createAssignedTask(port, projectId);
    assert.equal(localAssigned.worker.type, "local");

    modeResponse = await fetch(`http://127.0.0.1:${port}/orchestrator/worker-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker_mode: "gcp_vm" }),
    });
    assert.equal(modeResponse.status, 200);
    const gcpAssigned = await createAssignedTask(port, projectId);
    assert.equal(gcpAssigned.worker.type, "gcp_vm");

    const flowchart = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`).then((response) => response.json()) as { nodes: Array<{ id: string; type: string; badges: string[] }> };
    const localWorker = flowchart.nodes.find((node) => node.id === `worker:${localAssigned.worker.worker_id}`);
    const gcpWorker = flowchart.nodes.find((node) => node.id === `worker:${gcpAssigned.worker.worker_id}`);
    assert.ok(localWorker?.badges.some((badge) => /LOCAL/.test(badge)));
    assert.ok(gcpWorker?.badges.some((badge) => /GCP/.test(badge)));
  } finally {
    child.kill();
  }
});

test("docker worker node appears when worker mode is docker_local", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `flowchart-docker-worker-mode-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const assigned = await createAssignedTask(port, projectId, "docker_local");
    const flowchart = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`).then((response) => response.json()) as { nodes: Array<{ id: string; type: string; badges: string[] }> };
    const dockerWorker = flowchart.nodes.find((node) => node.id === `worker:${assigned.worker.worker_id}`);
    assert.equal(dockerWorker?.type, "worker");
    assert.ok(dockerWorker?.badges.some((badge) => /DOCKER/.test(badge)));
  } finally {
    child.kill();
  }
});

test("worker heartbeat records actual runtime image digest VM name and rerun attempt metadata", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `worker-runtime-metadata-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const assigned = await createAssignedTask(port, projectId, "gcp_vm");
    const runtimeImage = "us-central1-docker.pkg.dev/teamtiffy1729/head-developer/worker:runtime-rerun";
    const runtimeDigest = "sha256:1234567890abcdef";
    const runtimeVmName = "hd-worker-actual-rerun";
    const startupAttemptId = "attempt-rerun-002";
    const containerStartedAt = new Date().toISOString();
    const runtimeVersion = "runtime-test-version";

    const heartbeatResponse = await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: assigned.task.task_id,
        project_id: projectId,
        worker_type: "gcp_vm",
        actual_worker_mode: "gcp_vm",
        actual_worker_image_uri: runtimeImage,
        actual_worker_image_digest: runtimeDigest,
        actual_vm_name: runtimeVmName,
        machine_type: "e2-standard-2",
        startup_attempt_id: startupAttemptId,
        run_attempt_id: startupAttemptId,
        container_started_at: containerStartedAt,
        worker_runtime_version: runtimeVersion,
        codex_auth_method: "secret_manager_api_key",
        codex_auth_secret_resource: "projects/test-project/secrets/codex-api-key/versions/latest",
        codex_auth_validated_at: containerStartedAt,
        codex_auth_validation_status: "validated",
      }),
    });
    assert.equal(heartbeatResponse.status, 200);
    const heartbeat = await heartbeatResponse.json() as {
      worker: {
        image_uri: string;
        recorded_image_uri?: string;
        actual_image_uri?: string;
        actual_image_digest?: string;
        actual_vm_name?: string;
        actual_worker_mode?: string;
        machine_type?: string;
        startup_attempt_id?: string;
        run_attempt_id?: string;
        container_started_at?: string;
        worker_runtime_version?: string;
        codex_auth_method?: string;
        codex_auth_secret_resource?: string;
        codex_auth_validation_status?: string;
        last_runtime_report_at?: string;
        runtime_metadata_updated_at?: string;
        metadata_verified_from_runtime?: boolean;
        metadata?: { image_mismatch?: boolean; vm_name_mismatch?: boolean };
      };
    };

    assert.notEqual(heartbeat.worker.image_uri, runtimeImage);
    assert.equal(heartbeat.worker.recorded_image_uri, heartbeat.worker.image_uri);
    assert.equal(heartbeat.worker.actual_image_uri, runtimeImage);
    assert.equal(heartbeat.worker.actual_image_digest, runtimeDigest);
    assert.equal(heartbeat.worker.actual_vm_name, runtimeVmName);
    assert.equal(heartbeat.worker.actual_worker_mode, "gcp_vm");
    assert.equal(heartbeat.worker.machine_type, "e2-standard-2");
    assert.equal(heartbeat.worker.startup_attempt_id, startupAttemptId);
    assert.equal(heartbeat.worker.run_attempt_id, startupAttemptId);
    assert.equal(heartbeat.worker.container_started_at, containerStartedAt);
    assert.equal(heartbeat.worker.worker_runtime_version, runtimeVersion);
    assert.equal(heartbeat.worker.codex_auth_method, "secret_manager_api_key");
    assert.equal(heartbeat.worker.codex_auth_secret_resource, "projects/test-project/secrets/codex-api-key/versions/latest");
    assert.equal(heartbeat.worker.codex_auth_validation_status, "validated");
    assert.ok(heartbeat.worker.last_runtime_report_at);
    assert.ok(heartbeat.worker.runtime_metadata_updated_at);
    assert.equal(heartbeat.worker.metadata_verified_from_runtime, true);
    assert.equal(heartbeat.worker.metadata?.image_mismatch, true);

    const commandEvent = {
      event_id: `cmd_runtime_metadata_${port}`,
      task_id: assigned.task.task_id,
      project_id: projectId,
      worker_id: assigned.worker.worker_id,
      command: "pwd",
      cwd: process.cwd(),
      started_at: new Date(Date.now() - 500).toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: process.cwd(),
      stderr_preview: "",
      summary: "Command completed.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date().toISOString(),
    };
    await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandEvent),
    });
    const commands = await fetch(`http://127.0.0.1:${port}/tasks/${assigned.task.task_id}/commands`).then((response) => response.json()) as {
      commands: Array<{
        event_id: string;
        worker_mode?: string;
        actual_image_uri?: string;
        actual_image_digest?: string;
        vm_name?: string;
        startup_attempt_id?: string;
        container_started_at?: string;
        worker_runtime_version?: string;
        runtime_metadata_verified?: boolean;
        codex_auth_method?: string;
        codex_auth_validation_status?: string;
      }>;
    };
    const storedCommand = commands.commands.find((item) => item.event_id === commandEvent.event_id);
    assert.equal(storedCommand?.worker_mode, "gcp_vm");
    assert.equal(storedCommand?.actual_image_uri, runtimeImage);
    assert.equal(storedCommand?.actual_image_digest, runtimeDigest);
    assert.equal(storedCommand?.vm_name, runtimeVmName);
    assert.equal(storedCommand?.startup_attempt_id, startupAttemptId);
    assert.equal(storedCommand?.container_started_at, containerStartedAt);
    assert.equal(storedCommand?.worker_runtime_version, runtimeVersion);
    assert.equal(storedCommand?.codex_auth_method, "secret_manager_api_key");
    assert.equal(storedCommand?.codex_auth_validation_status, "validated");
    assert.equal(storedCommand?.runtime_metadata_verified, true);

    await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: assigned.task.task_id,
        status: "completed",
        summary: "Runtime metadata command completed.",
        actual_worker_mode: "gcp_vm",
        actual_worker_image_uri: runtimeImage,
        actual_worker_image_digest: runtimeDigest,
        actual_vm_name: runtimeVmName,
        startup_attempt_id: startupAttemptId,
        container_started_at: containerStartedAt,
        worker_runtime_version: runtimeVersion,
        codex_auth_method: "secret_manager_api_key",
        codex_auth_secret_resource: "projects/test-project/secrets/codex-api-key/versions/latest",
        codex_auth_validated_at: containerStartedAt,
        codex_auth_validation_status: "validated",
      }),
    });
    const summary = await fetch(`http://127.0.0.1:${port}/tasks/${assigned.task.task_id}/summary`).then((response) => response.json()) as {
      summary: { technical_summary: string };
    };
    assert.match(summary.summary.technical_summary, /Worker mode: gcp_vm/);
    assert.match(summary.summary.technical_summary, new RegExp(runtimeImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const recordedImagePattern = heartbeat.worker.image_uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(summary.summary.technical_summary, new RegExp(`Actual runtime image: ${recordedImagePattern}`));

    const flowchart = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`).then((response) => response.json()) as {
      nodes: Array<{ id: string; type: string; status: string; visual_state: string; badges: string[]; summary: string; detail: Record<string, unknown> }>;
    };
    const workerNode = flowchart.nodes.find((node) => node.id === `worker:${assigned.worker.worker_id}`);
    assert.equal(workerNode?.type, "worker");
    assert.equal(workerNode?.visual_state, "warning");
    assert.match(workerNode?.status ?? "", /image mismatch/i);
    assert.ok(workerNode?.badges.some((badge) => /IMAGE MISMATCH/.test(badge)));
    assert.match(workerNode?.summary ?? "", /Recorded image .* differs from actual runtime image/i);
    assert.equal(workerNode?.detail.recorded_image_uri, heartbeat.worker.image_uri);
    assert.equal(workerNode?.detail.actual_image_uri, runtimeImage);
    assert.equal(workerNode?.detail.actual_image_digest, runtimeDigest);
    assert.equal(workerNode?.detail.actual_vm_name, runtimeVmName);
    assert.equal(workerNode?.detail.startup_attempt_id, startupAttemptId);
    assert.equal(workerNode?.detail.container_started_at, containerStartedAt);
    assert.equal(workerNode?.detail.worker_runtime_version, runtimeVersion);
    assert.equal(workerNode?.detail.codex_auth_method, "secret_manager_api_key");
    assert.equal(workerNode?.detail.codex_auth_validation_status, "validated");
    assert.equal(workerNode?.detail.metadata_verified_from_runtime, true);
    assert.equal(workerNode?.detail.image_mismatch, true);
    const commandNode = flowchart.nodes.find((node) => node.id === `command:${commandEvent.event_id}`);
    assert.equal(commandNode?.detail.actual_image_uri, runtimeImage);
    assert.equal(commandNode?.detail.actual_image_digest, runtimeDigest);
    assert.equal(commandNode?.detail.vm_name, runtimeVmName);
    assert.equal(commandNode?.detail.startup_attempt_id, startupAttemptId);
    assert.equal(commandNode?.detail.codex_auth_method, "secret_manager_api_key");
    assert.equal(commandNode?.detail.codex_auth_validation_status, "validated");
    assert.equal(commandNode?.detail.runtime_metadata_verified, true);
  } finally {
    child.kill();
  }
});

test("stale worker heartbeat changes worker node to warning", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `flowchart-stale-worker-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const assigned = await createAssignedTask(port, projectId, "local");
    const storePath = path.join(storeDir, "sessions.json");
    const state = JSON.parse(fs.readFileSync(storePath, "utf8"));
    state.workers[assigned.worker.worker_id].heartbeat_at = new Date(Date.now() - 120_000).toISOString();
    fs.writeFileSync(storePath, JSON.stringify(state, null, 2));

    const flowchart = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`).then((response) => response.json()) as { nodes: Array<{ id: string; visual_state: string; status: string }> };
    const worker = flowchart.nodes.find((node) => node.id === `worker:${assigned.worker.worker_id}`);
    assert.equal(worker?.visual_state, "warning");
    assert.match(worker?.status ?? "", /stale/i);
  } finally {
    child.kill();
  }
});

test("failed command changes command task and worker visual state", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `flowchart-failed-command-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const assigned = await createAssignedTask(port, projectId, "local");
    const commandEvent = {
      event_id: `cmd_failed_${port}`,
      task_id: assigned.task.task_id,
      project_id: projectId,
      worker_id: assigned.worker.worker_id,
      command: "npm run test",
      cwd: process.cwd(),
      started_at: new Date(Date.now() - 500).toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: 1,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "",
      stderr_preview: "test failed",
      summary: "Command exited with code 1.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date().toISOString(),
    };
    await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandEvent),
    });
    await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: assigned.task.task_id, status: "failed", summary: "Tests failed." }),
    });

    const flowchart = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`).then((response) => response.json()) as { nodes: Array<{ id: string; visual_state: string }> };
    assert.equal(flowchart.nodes.find((node) => node.id === `command:${commandEvent.event_id}`)?.visual_state, "failed");
    assert.equal(flowchart.nodes.find((node) => node.id === `task:${assigned.task.task_id}`)?.visual_state, "failed");
    assert.equal(flowchart.nodes.find((node) => node.id === `worker:${assigned.worker.worker_id}`)?.visual_state, "failed");
  } finally {
    child.kill();
  }
});

test("conversation status answers are grounded in task worker command and summary state", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `conversation-grounded-status-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "conversation status", channel: "web_text", user_id: "test-web-user" }),
    });
    assert.equal(sessionResponse.status, 201);
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };

    const taskResponse = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        project_id: projectId,
        user_goal: "Conversation control-room grounded smoke",
        assign_worker: true,
        worker_type: "local",
      }),
    });
    assert.equal(taskResponse.status, 201);
    const assigned = await taskResponse.json() as { task: { task_id: string }; worker: { worker_id: string } };
    const commandEvent = {
      event_id: `cmd_conversation_${port}`,
      task_id: assigned.task.task_id,
      project_id: projectId,
      worker_id: assigned.worker.worker_id,
      command: "node --version",
      cwd: process.cwd(),
      started_at: new Date(Date.now() - 500).toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: "v22.0.0",
      stderr_preview: "",
      summary: "Node version command completed.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date().toISOString(),
    };
    await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandEvent),
    });
    await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: assigned.task.task_id, status: "completed", summary: "Conversation smoke completed." }),
    });

    const statusMessage = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "What commands ran?",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(statusMessage.status, 200);
    const statusPayload = await statusMessage.json() as { text: string; taskId?: string; workerId?: string };
    assert.match(statusPayload.text, /node --version/);
    assert.equal(statusPayload.taskId, assigned.task.task_id);
    assert.equal(statusPayload.workerId, assigned.worker.worker_id);

    const sessionState = await fetch(`http://127.0.0.1:${port}/sessions/${sessionPayload.session.session_id}`).then((response) => response.json()) as { session: { active_task_id: string; active_worker_id: string; recent_messages: Array<{ role: string; text: string }> } };
    assert.equal(sessionState.session.active_task_id, assigned.task.task_id);
    assert.equal(sessionState.session.active_worker_id, assigned.worker.worker_id);
    assert.ok(sessionState.session.recent_messages.some((message) => message.role === "user" && /What commands ran/i.test(message.text)));
    assert.ok(sessionState.session.recent_messages.some((message) => message.role === "assistant" && /node --version/i.test(message.text)));

    const flowchart = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`).then((response) => response.json()) as { nodes: Array<{ id: string; type: string }>; edges: Array<{ from: string; to: string; label: string }> };
    assert.ok(flowchart.nodes.some((node) => node.id === `session:${sessionPayload.session.session_id}`));
    assert.ok(flowchart.nodes.some((node) => node.id === `command:${commandEvent.event_id}`));
    assert.ok(flowchart.edges.some((edge) => edge.from === `worker:${assigned.worker.worker_id}` && edge.to === `command:${commandEvent.event_id}`));
  } finally {
    child.kill();
  }
});

test("conversation worker mode switching affects future tasks without stopping the active task", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `conversation-worker-mode-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "worker mode conversation", channel: "web_text", user_id: "test-web-user" }),
    });
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };
    const firstTask = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        project_id: projectId,
        user_goal: "Run first task locally",
        assign_worker: true,
        worker_type: "local",
      }),
    }).then((response) => response.json()) as { worker: { worker_id: string; type: string; status: string } };
    assert.equal(firstTask.worker.type, "local");

    const switchResponse = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "Switch future tasks to GCP workers",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(switchResponse.status, 200);
    const switchPayload = await switchResponse.json() as { text: string };
    assert.match(switchPayload.text, /Future tasks will use GCP VM/i);
    assert.match(switchPayload.text, /did not stop/i);

    const secondTask = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        project_id: projectId,
        user_goal: "Run second task in configured mode",
        assign_worker: true,
      }),
    }).then((response) => response.json()) as { worker: { worker_id: string; type: string; metadata?: { dry_run?: boolean } } };
    assert.equal(secondTask.worker.type, "gcp_vm");
    assert.equal(secondTask.worker.metadata?.dry_run, true);

    const workers = await fetch(`http://127.0.0.1:${port}/workers`).then((response) => response.json()) as { workers: Array<{ worker_id: string; type: string; status: string }> };
    const firstWorker = workers.workers.find((worker) => worker.worker_id === firstTask.worker.worker_id);
    assert.equal(firstWorker?.type, "local");
    assert.notEqual(firstWorker?.status, "stopped");
  } finally {
    child.kill();
  }
});

test("worker mode phrase inside a build request does not hijack implementation routing", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `conversation-worker-mode-build-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "worker mode build conversation", channel: "web_text", user_id: "test-web-user" }),
    });
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };
    const selectResponse = await fetch(`http://127.0.0.1:${port}/projects/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionPayload.session.session_id, project_id: projectId }),
    });
    assert.equal(selectResponse.status, 200);

    const buildResponse = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "Build a static SaaS dashboard with landing, login, dashboard, and settings. Use Docker Local workers.",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(buildResponse.status, 200);
    const buildPayload = await buildResponse.json() as { text: string };
    assert.doesNotMatch(buildPayload.text, /^Future tasks will use Docker local worker mode/i);
    assert.match(buildPayload.text, /Approve this plan|Task graph|worker/i);

    const sessionState = await fetch(`http://127.0.0.1:${port}/sessions/${sessionPayload.session.session_id}`).then((response) => response.json()) as {
      session: { pending_action?: { type?: string; worker_mode?: string } | null; preferred_worker_mode?: string | null };
    };
    assert.equal(sessionState.session.pending_action?.type, "approve_task_split");
    assert.equal(sessionState.session.pending_action?.worker_mode, "docker_local");
  } finally {
    child.kill();
  }
});

test("new project planner approval remains pending until the user approves", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `new-project-planner-approval-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "new project planner approval", channel: "web_text", user_id: "test-web-user" }),
    });
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };
    const projectId = await firstProjectId(port);
    const selectResponse = await fetch(`http://127.0.0.1:${port}/projects/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionPayload.session.session_id, project_id: projectId }),
    });
    assert.equal(selectResponse.status, 200);

    const buildResponse = await fetch(`http://127.0.0.1:${port}/sessions/${sessionPayload.session.session_id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "web_text",
        text: "Build a static SaaS dashboard with landing, login, dashboard, and settings named PlannerApprovalSmoke. Use Docker Local workers.",
      }),
    });
    assert.equal(buildResponse.status, 200);
    const buildPayload = await buildResponse.json() as { response: string };
    assert.match(buildPayload.response, /Before I start, here is what I understand/i);
    assert.match(buildPayload.response, /Does this match what you want/i);
    assert.match(buildPayload.response, /Reply `approve` to start, or tell me what to change/i);

    const sessionState = await fetch(`http://127.0.0.1:${port}/sessions/${sessionPayload.session.session_id}`).then((response) => response.json()) as {
      session: {
        approval_status?: string | null;
        pending_action?: { type?: string; worker_mode?: string; target_project_id?: string } | null;
      };
    };
    assert.equal(sessionState.session.approval_status, "pending");
    assert.equal(sessionState.session.pending_action?.type, "approve_task_split");
    assert.equal(sessionState.session.pending_action?.worker_mode, "docker_local");
    assert.ok(sessionState.session.pending_action?.target_project_id);
  } finally {
    child.kill();
  }
});

test("conversation MCP actions are logged and rendered in the flowchart", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `conversation-mcp-actions-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "mcp conversation", channel: "web_text", user_id: "test-web-user" }),
    });
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };

    const listResponse = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "What GCP workers are running?",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json() as { text: string };
    assert.match(listPayload.text, /GCP VM workers|GCP workers/i);

    const cleanupResponse = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "Clean up expired workers",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(cleanupResponse.status, 200);
    const cleanupPayload = await cleanupResponse.json() as { text: string };
    assert.match(cleanupPayload.text, /Approve cleanup/i);

    const explainResponse = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "explain first",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(explainResponse.status, 200);
    const explainPayload = await explainResponse.json() as { text: string };
    assert.match(explainPayload.text, /needs approval/i);

    const approveResponse = await fetch(`http://127.0.0.1:${port}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        user_id: "test-web-user",
        channel: "web_text",
        text: "approve",
        timestamp: new Date().toISOString(),
      }),
    });
    assert.equal(approveResponse.status, 200);
    const approvePayload = await approveResponse.json() as { text: string };
    assert.match(approvePayload.text, /Approved cleanup/i);

    const sessionState = await fetch(`http://127.0.0.1:${port}/sessions/${sessionPayload.session.session_id}`).then((response) => response.json()) as { session: { pending_action: unknown } };
    assert.equal(sessionState.session.pending_action, null);

    const flowchart = await fetch(`http://127.0.0.1:${port}/orchestrator/flowchart`).then((response) => response.json()) as { nodes: Array<{ type: string; label: string }>; edges: Array<{ label: string }> };
    assert.ok(flowchart.nodes.some((node) => node.type === "mcp_action" && node.label === "list_gcp_workers"));
    assert.ok(flowchart.nodes.some((node) => node.type === "mcp_action" && node.label === "cleanup_expired_workers"));
    assert.ok(flowchart.edges.some((edge) => edge.label === "mcp action"));
  } finally {
    child.kill();
  }
});

test("progress broadcaster records live updates from real task worker command and summary events", async () => {
  const port = await freePort();
  const storeDir = path.join(process.cwd(), "tmp", `progress-broadcaster-http-test-${port}`);
  const child = spawnBackend(port, storeDir);

  try {
    await waitForHealth(port, child);
    const projectId = await firstProjectId(port);
    const sessionResponse = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "progress broadcaster", channel: "web_text", user_id: "test-web-user" }),
    });
    const sessionPayload = await sessionResponse.json() as { session: { session_id: string } };
    const assigned = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionPayload.session.session_id,
        project_id: projectId,
        user_goal: "Progress broadcaster event smoke",
        assign_worker: true,
        worker_type: "local",
      }),
    }).then((response) => response.json()) as { task: { task_id: string }; worker: { worker_id: string } };

    const commandEvent = {
      event_id: `cmd_progress_${port}`,
      task_id: assigned.task.task_id,
      project_id: projectId,
      worker_id: assigned.worker.worker_id,
      command: "pwd",
      cwd: process.cwd(),
      started_at: new Date(Date.now() - 250).toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: 0,
      stdout_ref: null,
      stderr_ref: null,
      stdout_preview: process.cwd(),
      stderr_preview: "",
      summary: "Printed the workspace path.",
      risk_level: "low",
      approved_by_user: false,
      created_at: new Date().toISOString(),
    };
    const eventResponse = await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandEvent),
    });
    assert.equal(eventResponse.status, 202);
    const resultResponse = await fetch(`http://127.0.0.1:${port}/workers/${assigned.worker.worker_id}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: assigned.task.task_id, status: "completed", summary: "Progress smoke completed." }),
    });
    assert.equal(resultResponse.status, 200);

    const sessionState = await fetch(`http://127.0.0.1:${port}/sessions/${sessionPayload.session.session_id}`).then((response) => response.json()) as { session: { raw_events: Array<{ type: string; message: string; data?: { source_event_type?: string; task_id?: string; worker_id?: string; project_id?: string } }>; recent_messages: Array<{ role: string; text: string }> } };
    const progress = sessionState.session.raw_events.filter((event) => event.type === "progress.update");
    assert.ok(progress.some((event) => event.data?.source_event_type === "task.created"));
    assert.ok(progress.some((event) => event.data?.source_event_type === "worker.started"));
    assert.ok(progress.some((event) => event.data?.source_event_type === "command.completed" && /pwd/.test(event.message)));
    assert.ok(progress.some((event) => event.data?.source_event_type === "summary.generated"));
    assert.ok(progress.some((event) => event.data?.task_id === assigned.task.task_id));
    assert.ok(progress.some((event) => event.data?.worker_id === assigned.worker.worker_id));
    assert.ok(progress.some((event) => event.data?.project_id === projectId));
    assert.ok(sessionState.session.recent_messages.some((message) => message.role === "assistant" && /pwd|Task/.test(message.text)));
  } finally {
    child.kill();
  }
});
