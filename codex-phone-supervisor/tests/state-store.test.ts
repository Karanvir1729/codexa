import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileStateStore } from "../backend/src/file-state-store.js";
import { FirestoreStateStore, type FirestoreTransportRequest } from "../backend/src/firestore-state-store.js";
import { MemoryStateStore } from "../backend/src/memory-state-store.js";
import type {
  CommandEventRecord,
  McpToolCallRecord,
  OrchestratorEvent,
  ProjectRecord,
  RunSummaryRecord,
  SessionState,
  TaskGraphRecord,
  TaskRecord,
  WorkerRecord,
  WorkerRuntimeCommandRequest,
} from "../backend/src/types.js";

const initialState = {
  defaultWorkerMode: "local" as const,
  allowWorkerModeSwitch: true,
  maxLocalWorkers: 1,
  maxDockerLocalWorkers: 3,
  maxGcpVmWorkers: 10,
  maxGkeJobWorkers: 5,
};

function session(sessionId = "session_store_test"): SessionState {
  return {
    session_id: sessionId,
    user_id: "user_store_test",
    channel: "web_text",
    active_task: "Store test",
    active_task_id: "task_store_test",
    active_worker_id: "worker_store_test",
    current_project_id: "project_store_test",
    current_status: "running",
    status: "running",
    latest_codex_message: "Running store test.",
    files_read: [],
    files_modified: [],
    commands_requested: [],
    commands_completed: [],
    commands_failed: [],
    pending_approvals: [],
    test_results: [],
    errors: [],
    git_diff_summary: "",
    raw_events: [],
    last_updated: "2026-05-26T00:00:00.000Z",
    workspace_path: "/workspace/store-test",
    project_id: "project_store_test",
    pending_action: null,
    pending_action_payload: null,
    created_at: "2026-05-26T00:00:00.000Z",
    summary_text: "",
    latest_summary: "",
    latest_plan: [],
    preferred_worker_mode: null,
    recent_messages: [],
    instruction_history: [],
    project_discovery: {
      status: "selected",
      selected_workspace_path: "/workspace/store-test",
      selected_project_name: "Store Test",
      confidence: "high",
      reason: "Test fixture.",
      last_question: "",
      conversation: [],
    },
  };
}

function project(): ProjectRecord {
  return {
    project_id: "project_store_test",
    display_name: "Store Test",
    workspace_path: "/workspace/store-test",
    repo_name: "store-test",
    git_branch: "main",
    last_active_session_id: "session_store_test",
    available_codex_adapter: "codex_cli",
    created_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T00:00:00.000Z",
  };
}

function task(): TaskRecord {
  return {
    task_id: "task_store_test",
    project_id: "project_store_test",
    user_goal: "Test persistence.",
    normalized_goal: "test persistence",
    status: "completed",
    plan: ["Persist state."],
    worker_id: "worker_store_test",
    codex_run_id: null,
    command_count: 1,
    latest_summary: "Persistence test completed.",
    next_steps: ["Continue."],
    created_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T00:00:01.000Z",
  };
}

function worker(): WorkerRecord {
  return {
    worker_id: "worker_store_test",
    type: "docker_local",
    status: "idle",
    image_uri: "worker:test",
    project_id: "project_store_test",
    task_id: "task_store_test",
    heartbeat_at: "2026-05-26T00:00:01.000Z",
    created_at: "2026-05-26T00:00:00.000Z",
    expires_at: "2026-05-26T01:00:00.000Z",
  };
}

function commandEvent(): CommandEventRecord {
  return {
    event_id: "command_store_test",
    task_id: "task_store_test",
    project_id: "project_store_test",
    worker_id: "worker_store_test",
    command: "node --version",
    cwd: "/workspace/store-test",
    started_at: "2026-05-26T00:00:01.000Z",
    ended_at: "2026-05-26T00:00:02.000Z",
    exit_code: 0,
    stdout_ref: null,
    stderr_ref: null,
    stdout_preview: "v22.0.0",
    stderr_preview: "",
    summary: "Command completed successfully.",
    risk_level: "low",
    approved_by_user: false,
    created_at: "2026-05-26T00:00:01.000Z",
  };
}

function activeCodexEvent(overrides: Partial<CommandEventRecord> = {}): CommandEventRecord {
  return {
    ...commandEvent(),
    event_id: "command_active_codex",
    command: "codex exec --json build",
    ended_at: null,
    exit_code: null,
    stdout_preview: "",
    stderr_preview: "",
    summary: "Command is running.",
    ...overrides,
  };
}

function summary(): RunSummaryRecord {
  return {
    task_id: "task_store_test",
    executive_summary: "Store test completed.",
    technical_summary: "One command succeeded.",
    commands_run: ["node --version"],
    files_changed: [],
    tests_run: ["node --version"],
    failures: [],
    current_state: "completed",
    next_plan: ["Continue."],
    confidence: "high",
    created_at: "2026-05-26T00:00:03.000Z",
  };
}

function mcpEvent(): McpToolCallRecord {
  return {
    mcp_call_id: "mcp_store_test",
    mcp_server: "head-developer-product-mcp",
    tool_name: "inspect_task_state",
    input_summary: "task_store_test",
    started_at: "2026-05-26T00:00:03.000Z",
    ended_at: "2026-05-26T00:00:04.000Z",
    status: "completed",
    result_summary: "Task inspected.",
    error: null,
    task_id: "task_store_test",
    project_id: "project_store_test",
    session_id: "session_store_test",
    worker_id: "worker_store_test",
  };
}

function event(): OrchestratorEvent {
  return {
    event_id: "event_store_test",
    scope: "task",
    scope_id: "task_store_test",
    type: "task.completed",
    message: "Task completed.",
    created_at: "2026-05-26T00:00:05.000Z",
  };
}

function taskGraph(): TaskGraphRecord {
  return {
    task_graph_id: "task_graph_store_test",
    project_id: "project_store_test",
    root_user_goal: "Build test app.",
    status: "running",
    complexity: {
      complexity: "complex",
      recommended_worker_count: 2,
      should_split: true,
      parallelizable: true,
      reason: "Test graph.",
      suggested_subtasks: [],
      dependency_graph: [],
      risks: [],
      approval_needed: false,
    },
    nodes: [],
    edges: [],
    recommended_worker_count: 2,
    execution_strategy: "parallel_worktrees",
    created_at: "2026-05-26T00:00:00.000Z",
    updated_at: "2026-05-26T00:00:01.000Z",
  };
}

function runtimeCommandRequest(): WorkerRuntimeCommandRequest {
  return {
    request_id: "request_store_test",
    session_id: "session_store_test",
    task_id: "task_store_test",
    project_id: "project_store_test",
    worker_id: "worker_store_test",
    command: "pwd",
    cwd: "/workspace/store-test",
    workspace_path: "/workspace/store-test",
    status: "queued",
    approved_by_user: true,
    created_at: "2026-05-26T00:00:06.000Z",
  };
}

function firestoreMemoryTransport(requests: FirestoreTransportRequest[] = [], documents = new Map<string, unknown>()) {
  return {
    documents,
    transport(request: FirestoreTransportRequest) {
      requests.push(request);
      const collectionDocs = [...documents.entries()].filter(([key]) => key.startsWith(`${request.collection}/`));
      if (request.op === "list") return collectionDocs.slice(0, request.limit ?? collectionDocs.length).map(([, value]) => value);
      if (request.op === "query") {
        return collectionDocs
          .map(([, value]) => value as Record<string, unknown>)
          .filter((value) => (request.filters ?? []).every((filter) => {
            const actual = value[filter.field];
            if (filter.op === "in") return Array.isArray(filter.value) && filter.value.includes(actual);
            return actual === filter.value;
          }))
          .slice(0, request.limit ?? collectionDocs.length);
      }
      const key = `${request.collection}/${request.documentId}`;
      if (request.op === "get") return documents.get(key) ?? null;
      if (request.op === "delete") {
        documents.delete(key);
        return null;
      }
      documents.set(key, JSON.parse(JSON.stringify({ ...(request.payload as Record<string, unknown>), ...(request.index ?? {}) })));
      return request.payload;
    },
  };
}

test("FileStateStore persists state across store instances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-file-test-"));
  const storePath = path.join(dir, "sessions.json");
  const first = new FileStateStore({ storePath, lockTimeoutMs: 1000, lockRetryMs: 5, initialState });

  first.createSession(session());
  first.createProject(project());
  first.createTask(task());
  first.createWorker(worker());
  first.createCommandEvent(commandEvent());
  first.createSummary(summary());
  first.createMcpEvent(mcpEvent());
  first.appendEvent(event());

  const second = new FileStateStore({ storePath, lockTimeoutMs: 1000, lockRetryMs: 5, initialState });
  assert.equal(second.getSession("session_store_test")?.active_task_id, "task_store_test");
  assert.equal(second.getProject("project_store_test")?.display_name, "Store Test");
  assert.equal(second.getTask("task_store_test")?.status, "completed");
  assert.equal(second.getWorker("worker_store_test")?.type, "docker_local");
  assert.equal(second.listCommandEvents({ taskId: "task_store_test" }).length, 1);
  assert.equal(second.getSummary("task_store_test")?.confidence, "high");
  assert.equal(second.listMcpEvents({ sessionId: "session_store_test" }).length, 1);
  assert.equal(second.listEvents("task_store_test").length, 1);
});

test("FileStateStore recovers from a stale lock left by a crashed process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-stale-lock-test-"));
  const storePath = path.join(dir, "sessions.json");
  const lockPath = `${storePath}.lock`;
  fs.mkdirSync(lockPath, { recursive: true });
  const staleDate = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleDate, staleDate);

  const store = new FileStateStore({ storePath, lockTimeoutMs: 100, lockRetryMs: 5, initialState });
  store.createSession(session("session_after_stale_lock"));

  assert.equal(store.getSession("session_after_stale_lock")?.session_id, "session_after_stale_lock");
  assert.equal(fs.existsSync(lockPath), false);
});

test("FirestoreStateStore maps typed state to migration-safe collections", () => {
  const requests: FirestoreTransportRequest[] = [];
  const { transport } = firestoreMemoryTransport(requests);
  const store = new FirestoreStateStore({
    projectId: "test-project",
    databaseId: "(default)",
    collectionPrefix: "hd_test",
    initialState,
    transport,
  });

  store.createSession(session());
  store.createProject(project());
  store.createTask(task());
  store.createWorker(worker());
  store.createCommandEvent(commandEvent());
  store.createSummary(summary());
  store.createMcpEvent(mcpEvent());
  store.appendEvent(event());

  assert.equal(store.getSession("session_store_test")?.project_id, "project_store_test");
  assert.equal(store.listCommandEvents({ workerId: "worker_store_test" })[0]?.event_id, "command_store_test");
  assert.equal(store.getSummary("task_store_test")?.executive_summary, "Store test completed.");
  assert.equal(store.listMcpEvents({ taskId: "task_store_test" })[0]?.tool_name, "inspect_task_state");
  assert.equal(store.listEvents("task_store_test")[0]?.type, "task.completed");

  const touchedCollections = new Set(requests.map((request) => request.collection));
  for (const collection of [
    "hd_test_sessions",
    "hd_test_projects",
    "hd_test_tasks",
    "hd_test_workers",
    "hd_test_command_events",
    "hd_test_summaries",
    "hd_test_mcp_events",
    "hd_test_events",
  ]) {
    assert.ok(touchedCollections.has(collection), `expected Firestore collection ${collection}`);
  }
});

test("FirestoreStateStore hot path lookups use targeted get/query operations instead of full scans", () => {
  const requests: FirestoreTransportRequest[] = [];
  const { transport } = firestoreMemoryTransport(requests);
  const store = new FirestoreStateStore({
    projectId: "test-project",
    databaseId: "(default)",
    collectionPrefix: "hd_hot",
    initialState,
    transport,
  });

  store.createSession({ ...session(), active_task_id: "task_store_test", active_worker_id: "worker_store_test" });
  store.createProject(project());
  store.createTask({ ...task(), status: "running" });
  store.createWorker({ ...worker(), status: "running", type: "gke_job" });
  store.createTaskGraph(taskGraph());
  store.createWorkerRuntimeCommandRequest(runtimeCommandRequest());
  store.createCommandEvent(commandEvent());

  const reader = new FirestoreStateStore({
    projectId: "test-project",
    databaseId: "(default)",
    collectionPrefix: "hd_hot",
    initialState,
    transport,
  });
  requests.length = 0;
  assert.equal(reader.getProject("project_store_test")?.display_name, "Store Test");
  assert.equal(reader.listProjects({ workspacePath: "/workspace/store-test", limit: 1 })[0]?.project_id, "project_store_test");
  assert.equal(reader.listTasks("project_store_test")[0]?.task_id, "task_store_test");
  assert.equal(reader.listTaskGraphs("project_store_test")[0]?.task_graph_id, "task_graph_store_test");
  assert.equal(reader.listWorkers({ type: "gke_job", active: true })[0]?.worker_id, "worker_store_test");
  assert.equal(reader.listWorkerRuntimeCommandRequests({ workerId: "worker_store_test", status: "queued" })[0]?.request_id, "request_store_test");
  assert.equal(reader.listCommandEvents({ taskId: "task_store_test" })[0]?.event_id, "command_store_test");
  assert.equal(reader.listSessions({ taskId: "task_store_test", workerId: "worker_store_test" })[0]?.session_id, "session_store_test");

  const scanned = requests.filter((request) => request.op === "list");
  assert.deepEqual(scanned, [], "hot paths for POST /projects, POST /tasks, task graph creation, worker callbacks, and command events must not list whole collections");
  assert.ok(requests.some((request) => request.op === "get" && request.collection === "hd_hot_projects" && request.documentId === "project_store_test"));
  assert.ok(requests.some((request) => request.op === "query" && request.collection === "hd_hot_projects" && request.filters?.some((filter) => filter.field === "workspace_path")));
  assert.ok(requests.some((request) => request.op === "query" && request.collection === "hd_hot_tasks" && request.filters?.some((filter) => filter.field === "project_id")));
  assert.ok(requests.some((request) => request.op === "query" && request.collection === "hd_hot_task_graphs" && request.filters?.some((filter) => filter.field === "project_id")));
  assert.ok(requests.some((request) => request.op === "query" && request.collection === "hd_hot_command_events" && request.filters?.some((filter) => filter.field === "task_id")));
  assert.ok(requests.some((request) => request.op === "query" && request.collection === "hd_hot_sessions" && request.filters?.some((filter) => filter.field === "active_task_id")));
});

test("state stores reject duplicate active codex exec command events for one task", () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-duplicate-codex-test-"));
  const stores = [
    new MemoryStateStore(initialState),
    new FileStateStore({ storePath: path.join(fileDir, "state.json"), lockTimeoutMs: 1000, lockRetryMs: 5, initialState }),
  ];

  for (const store of stores) {
    store.createCommandEvent(activeCodexEvent({ event_id: `${store.kind}_codex_one`, worker_id: `${store.kind}_worker_one` }));
    assert.throws(
      () => store.createCommandEvent(activeCodexEvent({ event_id: `${store.kind}_codex_two`, worker_id: `${store.kind}_worker_two` })),
      /Refusing duplicate active codex exec/,
    );
    assert.equal(store.listCommandEvents({ taskId: "task_store_test" }).filter((event) => event.exit_code === null && /codex exec/.test(event.command)).length, 1);
  }
});

test("state stores claim worker tasks by writing the command lease atomically", () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-store-claim-test-"));
  const stores = [
    new MemoryStateStore(initialState),
    new FileStateStore({ storePath: path.join(fileDir, "state.json"), lockTimeoutMs: 1000, lockRetryMs: 5, initialState }),
  ];

  for (const store of stores) {
    const claimTask = {
      ...task(),
      status: "running" as const,
      command_lease_id: null,
      command_lease_owner: null,
      command_lease_attempt_id: null,
      command_lease_acquired_at: null,
      command_lease_expires_at: null,
    };
    const claimWorker = { ...worker(), status: "running" as const };
    store.createTask(claimTask);
    store.createWorker(claimWorker);

    const first = store.claimWorkerTask({
      worker_id: claimWorker.worker_id,
      task_id: claimTask.task_id,
      runtime: { startup_attempt_id: "attempt_one", run_attempt_id: "attempt_one" },
      now_iso: "2026-05-26T00:00:02.000Z",
      lease_ttl_ms: 15 * 60 * 1000,
    });
    const second = store.claimWorkerTask({
      worker_id: claimWorker.worker_id,
      task_id: claimTask.task_id,
      runtime: { startup_attempt_id: "attempt_two", run_attempt_id: "attempt_two" },
      now_iso: "2026-05-26T00:00:03.000Z",
      lease_ttl_ms: 15 * 60 * 1000,
    });

    assert.equal(first.decision, "claimed");
    assert.equal(store.getTask(claimTask.task_id)?.command_lease_attempt_id, "attempt_one");
    assert.equal(second.decision, "blocked_by_active_command");
    assert.equal(store.getTask(claimTask.task_id)?.command_lease_attempt_id, "attempt_one");
  }
});

test("FirestoreStateStore rejects duplicate active codex exec command events for one task", () => {
  const { transport } = firestoreMemoryTransport();
  const store = new FirestoreStateStore({
    projectId: "test-project",
    databaseId: "(default)",
    collectionPrefix: "hd_test_duplicate",
    initialState,
    transport,
  });

  store.createCommandEvent(activeCodexEvent({ event_id: "firestore_codex_one", worker_id: "worker_one" }));
  assert.throws(
    () => store.createCommandEvent(activeCodexEvent({ event_id: "firestore_codex_two", worker_id: "worker_two" })),
    /Refusing duplicate active codex exec/,
  );
  assert.equal(store.listCommandEvents({ taskId: "task_store_test" }).filter((event) => event.exit_code === null && /codex exec/.test(event.command)).length, 1);
});
