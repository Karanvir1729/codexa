import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { classifyCommand } from "../backend/src/command-policy.js";

const workspace = path.join(process.cwd(), "codex-phone-supervisor");

test("command policy allows normal project commands inside the workspace", () => {
  const decision = classifyCommand("npm run typecheck", workspace, workspace);
  assert.equal(decision.disposition, "allowed");
  assert.equal(decision.risk_level, "low");
});

test("command policy keeps safe repo inspection commands low risk", () => {
  for (const command of ["git status --short", "cat package.json", "sed -n '1,20p' README.md", "node --version"]) {
    const decision = classifyCommand(command, workspace, workspace);
    assert.equal(decision.disposition, "allowed", command);
    assert.equal(decision.risk_level, "low", command);
  }
});

test("command policy allows static HTML parser validation", () => {
  const decision = classifyCommand("python3 -m html.parser index.html", workspace, workspace);
  assert.equal(decision.disposition, "allowed");
  assert.equal(decision.risk_level, "low");
});

test("command policy allows internal Codex file materialization inside the workspace", () => {
  const decision = classifyCommand("node /state/runtime/materialize-codex-files.mjs /state/runtime/task.files-to-write.json", workspace, workspace);
  assert.equal(decision.disposition, "allowed");
  assert.equal(decision.risk_level, "low");
});

test("command policy requires approval for install commands", () => {
  const decision = classifyCommand("npm install left-pad", workspace, workspace);
  assert.equal(decision.disposition, "requires_approval");
  assert.equal(decision.risk_level, "medium");
});

test("command policy requires approval for destructive commands", () => {
  const decision = classifyCommand("rm -rf dist", workspace, workspace);
  assert.equal(decision.disposition, "requires_approval");
  assert.equal(decision.risk_level, "high");
});

test("command policy blocks credential dumping", () => {
  const decision = classifyCommand("cat ~/.config/gcloud/application_default_credentials.json", workspace, workspace);
  assert.equal(decision.disposition, "blocked");
  assert.equal(decision.risk_level, "blocked");
});

test("command policy blocks .env reads", () => {
  for (const command of ["cat .env", "cat .env.local", "cat .env.*", "head -n 5 ./.env.production", "sed -n '1,20p' ../.env"]) {
    const decision = classifyCommand(command, workspace, workspace);
    assert.notEqual(decision.risk_level, "low", command);
    assert.notEqual(decision.disposition, "allowed", command);
  }
});

test("command policy blocks auth and credential file reads", () => {
  for (const command of [
    "cat ~/.codex/auth.json",
    "cat ~/.config/gcloud/application_default_credentials.json",
    "cat credentials.json",
    "tail -n 20 service-account.json",
    "less ~/.netrc",
  ]) {
    const decision = classifyCommand(command, workspace, workspace);
    assert.notEqual(decision.risk_level, "low", command);
    assert.notEqual(decision.disposition, "allowed", command);
  }
});

test("command policy blocks privileged Docker containers", () => {
  const decision = classifyCommand("docker run --privileged alpine id", workspace, workspace);
  assert.notEqual(decision.risk_level, "low");
  assert.notEqual(decision.disposition, "allowed");
});

test("command policy blocks Docker host root mounts", () => {
  for (const command of [
    "docker run -v /:/host alpine ls /host",
    "docker run --mount type=bind,source=/,target=/host alpine ls /host",
  ]) {
    const decision = classifyCommand(command, workspace, workspace);
    assert.equal(decision.disposition, "blocked", command);
    assert.equal(decision.risk_level, "blocked", command);
  }
});

test("command policy blocks Docker socket mounts", () => {
  for (const command of [
    "docker run -v /var/run/docker.sock:/var/run/docker.sock alpine docker ps",
    "docker run --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock alpine docker ps",
  ]) {
    const decision = classifyCommand(command, workspace, workspace);
    assert.equal(decision.disposition, "blocked", command);
    assert.equal(decision.risk_level, "blocked", command);
  }
});

test("command policy approval-gates broad Docker host filesystem mounts", () => {
  const decision = classifyCommand("docker run -v /Users:/host-users alpine ls /host-users", workspace, workspace);
  assert.equal(decision.disposition, "requires_approval");
  assert.equal(decision.risk_level, "high");
});

test("command policy does not scan codex prompt prose as shell syntax", () => {
  const command = [
    "codex exec --json",
    `-C ${workspace}`,
    "-s workspace-write",
    "You are the Head Developer. Do not read secrets. Update settings copy.",
  ].join(" ");
  const decision = classifyCommand(command, workspace, workspace);
  assert.equal(decision.disposition, "allowed");
});

test("command policy requires approval outside the workspace", () => {
  const decision = classifyCommand("ls", "/tmp", workspace);
  assert.equal(decision.disposition, "requires_approval");
  assert.equal(decision.risk_level, "high");
});
