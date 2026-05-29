import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const configImport = `await import(${JSON.stringify(pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/config.ts")).href)})`;
const tsxLoader = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;

function isolatedCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cps-config-test-"));
}

function baseRuntimeEnv(extra: Record<string, string> = {}) {
  const cwd = process.cwd();
  return {
    CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1",
    CODEX_PHONE_SUPERVISOR_STORE_DIR: "tmp/config-test-store",
    CODEX_PHONE_SUPERVISOR_HOST: "127.0.0.1",
    CODEX_PHONE_SUPERVISOR_PORT: "4317",
    CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS: "http://127.0.0.1:4318",
    CODEX_PHONE_SUPERVISOR_CODEX_COMMAND: process.execPath,
    CODEX_PHONE_SUPERVISOR_CODEX_HOME: cwd,
    CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH: cwd,
    CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT: cwd,
    CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS: cwd,
    CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
    CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
    CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
    CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
    CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
    CODEX_PHONE_SUPERVISOR_TEST_MODE: "0",
    TWILIO_VALIDATE_SIGNATURES: "0",
    TWILIO_SMS_ENABLED: "0",
    TWILIO_VOICE_ENABLED: "0",
    ...extra,
  };
}

test("config import fails clearly when required env is missing", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", configImport],
    {
      cwd: isolatedCwd(),
      env: { CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /CODEX_PHONE_SUPERVISOR_STORE_DIR is required/);
});

test("runtime config defaults to local Codex CLI supervisor", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", `${configImport}; console.log(JSON.stringify({ provider: (await import(${JSON.stringify(pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/config.ts")).href)})).config.supervisorModelProvider, modelProviders: (await import(${JSON.stringify(pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/config.ts")).href)})).config.modelProviders }));`],
    {
      cwd: isolatedCwd(),
      env: baseRuntimeEnv(),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.provider, "codex_cli");
  assert.deepEqual(payload.modelProviders, {
    supervisor_model_provider: "Codex CLI",
    planner_model_provider: "Codex CLI",
    worker_code_model: "Codex CLI",
  });
  assert.doesNotMatch(JSON.stringify(payload), /secret|token/i);
});

test("runtime config accepts codex_home_bundle auth and does not default to API-key auth", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", `${configImport}; const { config } = await import(${JSON.stringify(pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/config.ts")).href)}); console.log(JSON.stringify({ method: config.codexAuth.method, homePath: config.codexAuth.homePath, hasHomeBundleSecret: Boolean(config.codexAuth.homeBundleSecret), apiKeySecret: config.codexAuth.apiKeySecret || null }));`],
    {
      cwd: isolatedCwd(),
      env: baseRuntimeEnv({
        HEAD_DEVELOPER_CODEX_AUTH_METHOD: "codex_home_bundle",
        HEAD_DEVELOPER_CODEX_HOME: "/codex-home",
        HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET: "codex-vm-home-bundle",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.deepEqual(payload, {
    method: "codex_home_bundle",
    homePath: "/codex-home",
    hasHomeBundleSecret: true,
    apiKeySecret: null,
  });
});

test("runtime config defaults GCP VM workers to the dedicated worker service account", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", `${configImport}; const { config } = await import(${JSON.stringify(pathToFileURL(path.resolve("codex-phone-supervisor/backend/src/config.ts")).href)}); console.log(JSON.stringify({ workerServiceAccountEmail: config.gcp.workerServiceAccountEmail }));`],
    {
      cwd: isolatedCwd(),
      env: baseRuntimeEnv({
        GCP_PROJECT_ID: "gcp-project",
      }),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as Record<string, unknown>;
  assert.equal(payload.workerServiceAccountEmail, "worker-vm-sa@gcp-project.iam.gserviceaccount.com");
});

test("runtime config rejects unknown Codex auth methods with the allowed runtime list", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", configImport],
    {
      cwd: isolatedCwd(),
      env: baseRuntimeEnv({
        HEAD_DEVELOPER_CODEX_AUTH_METHOD: "mock",
      }),
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /HEAD_DEVELOPER_CODEX_AUTH_METHOD must be one of: none, codex_home_bundle, secret_manager_api_key/);
});

test("runtime config rejects mock supervisor provider", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", configImport],
    {
      cwd: isolatedCwd(),
      env: baseRuntimeEnv({ SUPERVISOR_MODEL_PROVIDER: "mock" }),
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /SUPERVISOR_MODEL_PROVIDER must be one of: codex_cli, gcp_conversation_ai, nvidia_nim, openai/);
});

test("Twilio voice enabled requires an explicit ConversationRelay URL", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", configImport],
    {
      cwd: isolatedCwd(),
      env: {
        CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1",
        CODEX_PHONE_SUPERVISOR_STORE_DIR: "tmp/config-test-store",
        CODEX_PHONE_SUPERVISOR_HOST: "127.0.0.1",
        CODEX_PHONE_SUPERVISOR_PORT: "4317",
        CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS: "http://127.0.0.1:4318",
        CODEX_PHONE_SUPERVISOR_CODEX_COMMAND: process.execPath,
        CODEX_PHONE_SUPERVISOR_CODEX_HOME: process.cwd(),
        CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH: process.cwd(),
        CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT: process.cwd(),
        CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS: process.cwd(),
        CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
        CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
        CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
        CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
        CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
        CODEX_PHONE_SUPERVISOR_TEST_MODE: "1",
        SUPERVISOR_MODEL_PROVIDER: "codex_cli",
        CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL: "deterministic",
        TWILIO_VALIDATE_SIGNATURES: "0",
        TWILIO_SMS_ENABLED: "1",
        TWILIO_VOICE_ENABLED: "1",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /TWILIO_CONVERSATION_RELAY_WS_URL is required/);
});

test("terminal enabled requires explicit shell configuration", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", configImport],
    {
      cwd: isolatedCwd(),
      env: {
        CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1",
        CODEX_PHONE_SUPERVISOR_STORE_DIR: "tmp/config-test-store",
        CODEX_PHONE_SUPERVISOR_HOST: "127.0.0.1",
        CODEX_PHONE_SUPERVISOR_PORT: "4317",
        CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS: "http://127.0.0.1:4318",
        CODEX_PHONE_SUPERVISOR_CODEX_COMMAND: process.execPath,
        CODEX_PHONE_SUPERVISOR_CODEX_HOME: process.cwd(),
        CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH: process.cwd(),
        CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT: process.cwd(),
        CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS: process.cwd(),
        CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "1",
        CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
        CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
        CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
        CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
        CODEX_PHONE_SUPERVISOR_TEST_MODE: "1",
        SUPERVISOR_MODEL_PROVIDER: "codex_cli",
        CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL: "deterministic",
        TWILIO_VALIDATE_SIGNATURES: "0",
        TWILIO_SMS_ENABLED: "0",
        TWILIO_VOICE_ENABLED: "0",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /CODEX_PHONE_SUPERVISOR_TERMINAL_SHELL is required/);
});

test("desktop terminal enabled requires explicit osascript configuration", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "-e", configImport],
    {
      cwd: isolatedCwd(),
      env: {
        CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1",
        CODEX_PHONE_SUPERVISOR_STORE_DIR: "tmp/config-test-store",
        CODEX_PHONE_SUPERVISOR_HOST: "127.0.0.1",
        CODEX_PHONE_SUPERVISOR_PORT: "4317",
        CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS: "http://127.0.0.1:4318",
        CODEX_PHONE_SUPERVISOR_CODEX_COMMAND: process.execPath,
        CODEX_PHONE_SUPERVISOR_CODEX_HOME: process.cwd(),
        CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH: process.cwd(),
        CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT: process.cwd(),
        CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS: process.cwd(),
        CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
        CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "1",
        CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: "codex-phone-supervisor/frontend/dist",
        CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
        CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
        CODEX_PHONE_SUPERVISOR_TEST_MODE: "1",
        SUPERVISOR_MODEL_PROVIDER: "codex_cli",
        CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL: "deterministic",
        TWILIO_VALIDATE_SIGNATURES: "0",
        TWILIO_SMS_ENABLED: "0",
        TWILIO_VOICE_ENABLED: "0",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /CODEX_PHONE_SUPERVISOR_OSASCRIPT_COMMAND is required/);
});
