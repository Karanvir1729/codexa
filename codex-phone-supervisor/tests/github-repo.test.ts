import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function bootstrapEnv(storeDir: string, workspaceRoot: string) {
  return `
    process.env.CODEX_PHONE_SUPERVISOR_HOST = "127.0.0.1";
    process.env.CODEX_PHONE_SUPERVISOR_PORT = "0";
    process.env.CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS = "http://127.0.0.1:4318";
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_COMMAND = process.execPath;
    process.env.CODEX_PHONE_SUPERVISOR_CODEX_HOME = process.cwd();
    process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS = ${JSON.stringify(workspaceRoot)};
    process.env.CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED = "0";
    process.env.CODEX_PHONE_SUPERVISOR_STORE_DIR = ${JSON.stringify(storeDir)};
    process.env.CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR = "codex-phone-supervisor/frontend/dist";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS = "5000";
    process.env.CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS = "25";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_MODE = "1";
    process.env.CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL = "";
    process.env.SUPERVISOR_MODEL_PROVIDER = "codex_cli";
    process.env.CODEX_PHONE_SUPERVISOR_TEST_SUPERVISOR_MODEL = "deterministic";
    process.env.TWILIO_CONVERSATION_RELAY_WS_URL = "";
    process.env.TWILIO_SMS_ENABLED = "0";
    process.env.TWILIO_VOICE_ENABLED = "0";
    process.env.TWILIO_VALIDATE_SIGNATURES = "0";
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.WORKER_MODE = "codex_session_local";
    process.env.DEFAULT_WORKER_MODE = "codex_session_local";
    process.env.ALLOW_WORKER_MODE_SWITCH = "true";
    process.env.HEAD_DEVELOPER_GCP_VM_DRY_RUN = "1";
  `;
}

function runIsolated(script: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    env: { ...process.env, CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1" },
  });
}

test("GitHub-created local projects push generated files to origin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-project-push-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "github-push-smoke");
  const bareRemote = path.join(root, "remote.git");
  fs.mkdirSync(projectDir, { recursive: true });
  spawnSync("git", ["init", "--bare", bareRemote], { encoding: "utf8" });

  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const projectDir = ${JSON.stringify(projectDir)};
    const bareRemote = ${JSON.stringify(bareRemote)};
    spawnSync("git", ["init", "-b", "main"], { cwd: projectDir, encoding: "utf8" });
    spawnSync("git", ["remote", "add", "origin", bareRemote], { cwd: projectDir, encoding: "utf8" });
    fs.writeFileSync(path.join(projectDir, "index.html"), "<h1>GitHub push smoke</h1>\\n");
    fs.writeFileSync(path.join(projectDir, "README.md"), "# GitHub push smoke\\n");
    const { projectRecordForWorkspace } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { pushProjectToGitHub } = await import("./codex-phone-supervisor/backend/src/github-repo.ts");
    const project = projectRecordForWorkspace(projectDir);
    project.github_repo_url = "https://github.com/Karanvir1729/github-push-smoke";
    project.github_repo_full_name = "Karanvir1729/github-push-smoke";
    project.github_repo_created = true;
    const result = pushProjectToGitHub({ project, taskId: "task_github_push_smoke" });
    const files = spawnSync("git", ["--git-dir", bareRemote, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" }).stdout.trim().split(/\\r?\\n/).filter(Boolean);
    console.log(JSON.stringify({ result, files }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { result?: { status?: string; commit?: string }; files?: string[] };
  assert.equal(payload.result?.status, "pushed");
  assert.ok(payload.result?.commit);
  assert.ok(payload.files?.includes("index.html"));
  assert.ok(payload.files?.includes("README.md"));
});

test("GitHub project push refuses secret-looking files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-project-push-secret-"));
  const storeDir = path.join(root, "store");
  const workspaceRoot = path.join(root, "workspace");
  const projectDir = path.join(workspaceRoot, "github-push-secret");
  const bareRemote = path.join(root, "remote.git");
  fs.mkdirSync(projectDir, { recursive: true });
  spawnSync("git", ["init", "--bare", bareRemote], { encoding: "utf8" });

  const script = `
    ${bootstrapEnv(storeDir, workspaceRoot)}
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const projectDir = ${JSON.stringify(projectDir)};
    const bareRemote = ${JSON.stringify(bareRemote)};
    spawnSync("git", ["init", "-b", "main"], { cwd: projectDir, encoding: "utf8" });
    spawnSync("git", ["remote", "add", "origin", bareRemote], { cwd: projectDir, encoding: "utf8" });
    fs.writeFileSync(path.join(projectDir, "index.html"), "<h1>Secret guard</h1>\\n");
    fs.writeFileSync(path.join(projectDir, ".env"), "TOKEN=secret\\n");
    const { projectRecordForWorkspace } = await import("./codex-phone-supervisor/backend/src/project-store.ts");
    const { pushProjectToGitHub } = await import("./codex-phone-supervisor/backend/src/github-repo.ts");
    const project = projectRecordForWorkspace(projectDir);
    project.github_repo_url = "https://github.com/Karanvir1729/github-push-secret";
    project.github_repo_full_name = "Karanvir1729/github-push-secret";
    project.github_repo_created = true;
    const result = pushProjectToGitHub({ project, taskId: "task_github_push_secret" });
    console.log(JSON.stringify({ result }));
  `;

  const result = runIsolated(script);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { result?: { status?: string; error?: string } };
  assert.equal(payload.result?.status, "failed");
  assert.match(payload.result?.error ?? "", /\.env/);
});
