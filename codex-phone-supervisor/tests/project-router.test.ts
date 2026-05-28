import test from "node:test";
import assert from "node:assert/strict";
import { routeProjectFromMessage } from "../backend/src/project-router.js";
import type { ProjectRecord } from "../backend/src/types.js";

function project(overrides: Partial<ProjectRecord>): ProjectRecord {
  return {
    project_id: overrides.project_id ?? "project_a",
    display_name: overrides.display_name ?? "Codex Phone Supervisor",
    workspace_path: overrides.workspace_path ?? "/workspace/codex-phone-supervisor",
    repo_name: overrides.repo_name ?? "codex-phone-supervisor",
    git_branch: overrides.git_branch ?? "main",
    last_active_session_id: overrides.last_active_session_id ?? null,
    available_codex_adapter: "codex_cli",
    created_at: overrides.created_at ?? "2026-05-25T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-05-25T00:00:00.000Z",
  };
}

test("project router selects explicit project mention", () => {
  const decision = routeProjectFromMessage("Use phone supervisor", [
    project({ project_id: "phone", display_name: "Phone Supervisor" }),
    project({ project_id: "daybot", display_name: "Daybot" }),
  ]);
  assert.equal(decision.status, "selected");
  if (decision.status === "selected") assert.equal(decision.project.project_id, "phone");
});

test("project router asks targeted clarification when ambiguous", () => {
  const decision = routeProjectFromMessage("What is Codex doing?", [
    project({ project_id: "phone", display_name: "Phone Supervisor", updated_at: "2026-05-25T02:00:00.000Z" }),
    project({ project_id: "daybot", display_name: "Daybot", updated_at: "2026-05-25T01:00:00.000Z" }),
  ]);
  assert.equal(decision.status, "needs_clarification");
  if (decision.status === "needs_clarification") {
    assert.match(decision.question, /Which project/);
    assert.equal(decision.candidates[0].project_id, "phone");
  }
});
