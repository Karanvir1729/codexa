import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const smokeDir = path.join(process.cwd(), "scripts", "smoke");

const smokeScripts = [
  "docker-single-worker-app-smoke",
  "docker-two-worker-static-dashboard-smoke",
  "agent-fullstack-conversation-smoke",
  "preview-smoke",
  "codex-history-smoke",
  "gcp-vm-safe-command-smoke",
];

test("required smoke scripts exist and are executable", () => {
  for (const script of smokeScripts) {
    const scriptPath = path.join(smokeDir, script);
    const stat = fs.statSync(scriptPath);
    assert.ok(stat.isFile(), `${script} should exist`);
    assert.ok((stat.mode & 0o111) !== 0, `${script} should be executable`);
  }
});

test("smoke scripts avoid secret-printing patterns and hardcoded fake Codex output", () => {
  for (const script of [...smokeScripts, "lib.mjs"]) {
    const source = fs.readFileSync(path.join(smokeDir, script), "utf8");
    assert.doesNotMatch(source, /console\.log\(process\.env|process\.stdout\.write\(process\.env/);
    assert.doesNotMatch(source, /sk-[A-Za-z0-9_-]{16,}/);
    assert.doesNotMatch(source, /item\.completed.*agent_message.*files_to_write/s, `${script} must not fake Codex JSON output`);
  }
});

test("smoke scripts encode the required product paths", () => {
  const single = fs.readFileSync(path.join(smokeDir, "docker-single-worker-app-smoke"), "utf8");
  assert.match(single, /index\.html/);
  assert.match(single, /styles\.css/);
  assert.match(single, /script\.js/);
  assert.match(single, /nodeCheck/);
  assert.match(single, /preview/);

  const twoWorker = fs.readFileSync(path.join(smokeDir, "docker-two-worker-static-dashboard-smoke"), "utf8");
  assert.match(twoWorker, /static SaaS dashboard shell/);
  assert.match(twoWorker, /No billing/);
  assert.match(twoWorker, /workers: 2/);
  assert.match(twoWorker, /materialize-codex-files/);
  assert.match(twoWorker, /output_contract/);
  assert.match(twoWorker, /assertNoDuplicateActiveCodex/);

  const fullstack = fs.readFileSync(path.join(smokeDir, "agent-fullstack-conversation-smoke"), "utf8");
  assert.match(fullstack, /SMOKE_APP_NAME/);
  assert.match(fullstack, /sanitizeLabel\(nonce/);
  assert.match(fullstack, /Build a complex full-stack Wordle-style vocabulary game named \$\{appName\}/);

  const gcp = fs.readFileSync(path.join(smokeDir, "gcp-vm-safe-command-smoke"), "utf8");
  assert.match(gcp, /run_worker_command "pwd"/);
  assert.match(gcp, /run_worker_command "node --version"/);
  assert.doesNotMatch(gcp, /\bcodex\s+exec\b/);
});

test("Docker compose runtime does not configure mock supervisor", () => {
  const compose = fs.readFileSync(path.join(process.cwd(), "docker", "docker-compose.local.yml"), "utf8");
  assert.doesNotMatch(compose, /SUPERVISOR_MODEL_PROVIDER:\s*["']?mock/i);
  assert.match(compose, /SUPERVISOR_MODEL_PROVIDER:\s*"\$\{SUPERVISOR_MODEL_PROVIDER:-vertex\}"/);
  assert.match(compose, /VERTEX_PROJECT_ID/);
  assert.match(compose, /VERTEX_LOCATION/);
  assert.match(compose, /VERTEX_MODEL/);
  assert.match(compose, /CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH:\s*"\/generated-projects"/);
  assert.match(compose, /CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS:\s*"\/generated-projects"/);
  assert.match(compose, /\.\.\/tmp\/codex-phone-supervisor-projects:\/generated-projects/);
  assert.doesNotMatch(compose, /CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS:\s*"\/workspace"/);
  assert.match(compose, /GOOGLE_APPLICATION_CREDENTIALS:\s*"\/gcp-adc\/application_default_credentials\.json"/);
  assert.match(compose, /HEAD_DEVELOPER_GOOGLE_APPLICATION_CREDENTIALS_HOST_PATH/);
  assert.doesNotMatch(compose, /application_default_credentials\.json.*[A-Za-z0-9+/]{80,}/);
});
