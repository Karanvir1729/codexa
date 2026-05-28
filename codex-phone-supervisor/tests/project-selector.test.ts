import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("project discovery hides an empty generated-projects container root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generated-projects-root-"));
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-selector-store-"));
  const appDir = path.join(root, "small-notes-app");
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, "package.json"), "{}\n");

  const script = `
    process.env.CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES = "1";
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = process.execPath;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH = ${JSON.stringify(root)};
    process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT = ${JSON.stringify(root)};
    process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS = ${JSON.stringify(root)};
    process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR = ${JSON.stringify(storeDir)};
    process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR = "codex-phone-supervisor/frontend/dist";
    process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS = "5000";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS = "25";
    process.env.CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL = "";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE = "1";
    process.env.SUPERVISOR_MODEL_PROVIDER = "vertex";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL = "deterministic";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
    const { listProjectCandidates } = await import("./codex-phone-supervisor/backend/src/project-selector.ts");
    const { refreshProjectsFromConfiguredRoots } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    console.log(JSON.stringify({
      candidates: listProjectCandidates(),
      projects: refreshProjectsFromConfiguredRoots(),
    }));
  `;

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    env: { ...process.env, CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout) as {
    candidates: Array<{ name: string; path: string }>;
    projects: Array<{ display_name: string; workspace_path: string }>;
  };
  const candidates = payload.candidates;
  assert.deepEqual(candidates.map((item) => item.name), ["small-notes-app"]);
  assert.equal(candidates[0]?.path, fs.realpathSync(appDir));
  assert.deepEqual(payload.projects.map((item) => item.display_name), ["small-notes-app"]);
  assert.equal(payload.projects[0]?.workspace_path, fs.realpathSync(appDir));
});
