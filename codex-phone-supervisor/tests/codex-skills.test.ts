import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function runIsolated(script: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    env: { ...process.env, CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
    maxBuffer: 10 * 1024 * 1024,
  });
}

test("Codex skill inventory reports discovered and missing critical skills", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "skill-inventory-home-"));
  fs.mkdirSync(path.join(codexHome, "skills", "megaplan"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "skills", "megaplan", "SKILL.md"), "# Megaplan\n");
  fs.mkdirSync(path.join(codexHome, "plugins", "cache", "openai-bundled", "browser", "1.0.0", "skills", "browser"), { recursive: true });
  fs.writeFileSync(path.join(codexHome, "plugins", "cache", "openai-bundled", "browser", "1.0.0", "skills", "browser", "SKILL.md"), "# Browser\n");

  const script = `
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = process.execPath;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = ${JSON.stringify(codexHome)};
    process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH = ${JSON.stringify(codexHome)};
    process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT = ${JSON.stringify(codexHome)};
    process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS = ${JSON.stringify(codexHome)};
    process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR = ${JSON.stringify(path.join(codexHome, "store"))};
    process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR = "codex-phone-supervisor/frontend/dist";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS = "5000";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS = "25";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE = "1";
    process.env.CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL = "";
    process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED = "0";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.WORKER_MODE = "codex_session_local";
    process.env.DEFAULT_WORKER_MODE = "codex_session_local";
    const { buildCodexSkillInventory, getCodexSkillInventory } = await import("./codex-phone-supervisor/backend/src/codex-skills.ts");
    const custom = buildCodexSkillInventory(${JSON.stringify(codexHome)}, ["megaplan", "browser", "github"]);
    const configured = getCodexSkillInventory();
    console.log(JSON.stringify({ custom, configured }));
  `;
  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as {
    custom?: {
      status?: string;
      total_discovered?: number;
      skill_names?: string[];
      critical_present?: string[];
      critical_missing?: string[];
    };
    configured?: { status?: string; critical_present?: string[]; critical_missing?: string[] };
  };
  assert.equal(payload.custom?.status, "missing_critical_skills");
  assert.equal(payload.custom?.total_discovered, 2);
  assert.deepEqual(payload.custom?.skill_names, ["browser", "megaplan"]);
  assert.deepEqual(payload.custom?.critical_present, ["megaplan", "browser"]);
  assert.deepEqual(payload.custom?.critical_missing, ["github"]);
  assert.equal(payload.configured?.status, "missing_critical_skills");
});
