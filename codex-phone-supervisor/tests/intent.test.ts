import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../backend/src/session.js";
import { answerStateQuestion } from "../backend/src/intent.js";

test("state intent answers what Codex is currently working on", () => {
  const session = createSession("Add streak counters", "/tmp/workspace");
  session.current_status = "running";
  session.latest_codex_message = "Inspecting habit tracker files.";

  const answer = answerStateQuestion(session, "what is Codex currently working on?");

  assert.match(answer, /Codex is running/);
  assert.match(answer, /Active task: Add streak counters/);
  assert.match(answer, /Inspecting habit tracker files/);
});

test("state intent includes pending approval when Codex is blocked", () => {
  const session = createSession("Enhance habit tracker", "/tmp/workspace");
  session.current_status = "waiting_for_approval";
  session.latest_codex_message = "I need read-only inspection approval.";
  session.pending_approvals.push({
    id: "approval_1",
    kind: "shell",
    command: "find . -maxdepth 3 -type f",
    reason: "Inspect project files before editing.",
    risk: "low",
    status: "pending",
    requested_at: "2026-05-26T00:00:00.000Z",
    session_id: session.session_id,
  });

  const answer = answerStateQuestion(session, "what's codex working on?");

  assert.match(answer, /waiting_for_approval/);
  assert.match(answer, /Waiting for approval: find \. -maxdepth 3 -type f/);
});

test("state intent does not hijack implementation requests mentioning a status badge", () => {
  const session = createSession("Build demo app", "/tmp/workspace");

  const answer = answerStateQuestion(session, "Build an index.html with a green status badge.");

  assert.equal(answer, "");
});
