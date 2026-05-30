import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../backend/src/session.js";
import { mergeCodexReport } from "../backend/src/reducer.js";

test("mergeCodexReport updates state and approvals", () => {
  const session = createSession("test task", "/tmp/workspace");
  mergeCodexReport(
    session,
    {
      summary: "Needs approval for npm test",
      status: "needs_approval",
      latest_codex_message: "Waiting on npm test approval",
      files_read: ["package.json"],
      files_modified: ["README.md"],
      commands_requested: ["npm test"],
      commands_completed: [],
      commands_failed: [],
      test_results: [],
      errors: [],
      approval_requests: [{ kind: "shell", command: "npm test", reason: "verify the changes", risk: "low" }],
    },
    "2026-05-25T00:00:00.000Z",
  );

  assert.equal(session.current_status, "waiting_for_approval");
  assert.deepEqual(session.files_read, ["package.json"]);
  assert.deepEqual(session.files_modified, ["README.md"]);
  assert.equal(session.pending_approvals.length, 1);

  mergeCodexReport(
    session,
    {
      summary: "Needs another approval",
      status: "needs_approval",
      latest_codex_message: "Waiting on npm install approval",
      files_read: [],
      files_modified: [],
      commands_requested: ["npm install"],
      commands_completed: [],
      commands_failed: [],
      test_results: [],
      errors: [],
      approval_requests: [{ kind: "install", command: "npm install", reason: "install dependencies", risk: "medium" }],
    },
    "2026-05-25T00:01:00.000Z",
  );

  assert.equal(session.pending_approvals.length, 2);
});

test("mergeCodexReport normalizes approval kind aliases", () => {
  const session = createSession("test task", "/tmp/workspace");
  mergeCodexReport(
    session,
    {
      summary: "Needs read-only shell approval",
      status: "needs_approval",
      latest_codex_message: "Waiting on shell approval",
      files_read: [],
      files_modified: [],
      commands_requested: ["find . -maxdepth 2 -type f"],
      commands_completed: [],
      commands_failed: [],
      test_results: [],
      errors: [],
      approval_requests: [{ kind: "shell_command" as any, command: "find . -maxdepth 2 -type f", reason: "inspect files", risk: "low" }],
    },
    "2026-05-25T00:00:00.000Z",
  );

  assert.equal(session.pending_approvals[0].kind, "shell");
});
