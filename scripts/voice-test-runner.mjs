#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const runsDir = path.join(repoRoot, "data", "test-runs");
const historyPath = path.join(runsDir, "history.json");
const latestPath = path.join(runsDir, "latest.json");

const suiteRegistry = {
  preflight: {
    id: "preflight",
    name: "Environment preflight",
    category: "health",
    command: ["node", ["scripts/voice-test-preflight.mjs"]],
    required: true,
  },
  eval: {
    id: "eval",
    name: "Deterministic voice evals",
    category: "eval",
    command: ["node", ["scripts/voice-eval-suite.mjs"]],
    required: true,
  },
  api: {
    id: "api",
    name: "API contract tests",
    category: "contract",
    command: ["npx", ["playwright", "test", "tests/voice/api-contract.spec.mjs"]],
    required: true,
  },
  ui: {
    id: "ui",
    name: "Browser UI smoke tests",
    category: "ui",
    command: ["npx", ["playwright", "test", "tests/voice/ui-smoke.spec.mjs"]],
    required: true,
    env: { HEADLESS: "1" },
  },
  bench: {
    id: "bench",
    name: "Voice-loop latency benchmark",
    category: "latency",
    command: ["node", ["scripts/bench-voice-loop.mjs"]],
    required: false,
  },
  phone: {
    id: "phone",
    name: "No-call phone Codex bridge",
    category: "phone",
    command: ["node", ["scripts/test-phone-codex-bridge.mjs"]],
    required: false,
  },
  phone_stack: {
    id: "phone_stack",
    name: "Twilio/Pipecat stack readiness",
    category: "phone",
    command: ["node", ["scripts/test-phone-stack.mjs"]],
    required: false,
  },
  openclaw: {
    id: "openclaw",
    name: "OpenClaw system-control readiness",
    category: "system-control",
    command: ["node", ["scripts/openclaw-readiness.mjs"]],
    required: false,
  },
  acoustic: {
    id: "acoustic",
    name: "Speaker-to-mic acoustic interruption test",
    category: "acoustic",
    command: ["npm", ["run", "test:voice:acoustic"]],
    required: false,
  },
};

function parseArgs(argv) {
  const args = {
    id: `run-${Date.now()}`,
    suites: ["preflight", "eval", "api", "ui", "bench"],
  };
  for (const arg of argv) {
    if (arg.startsWith("--id=")) args.id = arg.slice("--id=".length);
    if (arg.startsWith("--suites=")) {
      args.suites = arg
        .slice("--suites=".length)
        .split(",")
        .map((suite) => suite.trim())
        .filter(Boolean);
    }
    if (arg === "--include-acoustic" && !args.suites.includes("acoustic")) {
      args.suites.push("acoustic");
    }
  }
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function summarizeSuites(suites) {
  return {
    total: suites.length,
    passed: suites.filter((suite) => suite.status === "passed").length,
    failed: suites.filter((suite) => suite.status === "failed").length,
    skipped: suites.filter((suite) => suite.status === "skipped").length,
    running: suites.filter((suite) => suite.status === "running").length,
    pending: suites.filter((suite) => suite.status === "pending").length,
  };
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

async function writeRun(run) {
  await fs.mkdir(runsDir, { recursive: true });
  const runPath = path.join(runsDir, `${run.id}.json`);
  await fs.writeFile(runPath, JSON.stringify(run, null, 2));
  await fs.writeFile(latestPath, JSON.stringify(run, null, 2));

  const history = await readJsonFile(historyPath, []);
  const summary = {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    summary: run.summary,
    suiteIds: run.suites.map((suite) => suite.id),
  };
  const nextHistory = [summary, ...history.filter((item) => item.id !== run.id)].slice(0, 50);
  await fs.writeFile(historyPath, JSON.stringify(nextHistory, null, 2));
}

function extractJsonPayload(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed.endsWith("}")) return null;
  const first = trimmed.indexOf("{");
  if (first === -1) return null;
  try {
    return JSON.parse(trimmed.slice(first));
  } catch {
    return null;
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        VOICE_TEST_APP_URL: process.env.VOICE_TEST_APP_URL ?? "http://localhost:3000",
        BENCH_BASE_URL: process.env.BENCH_BASE_URL ?? process.env.VOICE_TEST_APP_URL ?? "http://localhost:3000",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    child.on("exit", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selected = args.suites.map((id) => suiteRegistry[id]).filter(Boolean);
  const unknown = args.suites.filter((id) => !suiteRegistry[id]);
  if (unknown.length) throw new Error(`Unknown suite id(s): ${unknown.join(", ")}`);

  const run = {
    id: args.id,
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    durationMs: null,
    summary: { total: selected.length, passed: 0, failed: 0, skipped: 0, running: 0, pending: selected.length },
    suites: selected.map((suite) => ({
      id: suite.id,
      name: suite.name,
      category: suite.category,
      required: suite.required,
      status: "pending",
      command: [suite.command[0], ...suite.command[1]].join(" "),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      parsed: null,
      stdout: "",
      stderr: "",
    })),
  };

  await writeRun(run);
  const startedAt = performance.now();

  for (let index = 0; index < selected.length; index += 1) {
    const suite = selected[index];
    run.suites[index].status = "running";
    run.suites[index].startedAt = nowIso();
    run.summary = summarizeSuites(run.suites);
    await writeRun(run);

    const [command, commandArgs] = suite.command;
    const result = await runCommand(command, commandArgs, { env: suite.env });
    const parsed = extractJsonPayload(result.stdout);

    run.suites[index] = {
      ...run.suites[index],
      status: result.exitCode === 0 ? "passed" : "failed",
      finishedAt: nowIso(),
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      parsed,
      stdout: result.stdout.slice(-12000),
      stderr: result.stderr.slice(-12000),
    };
    run.summary = summarizeSuites(run.suites);
    await writeRun(run);
  }

  run.status = run.summary.failed > 0 ? "failed" : "passed";
  run.finishedAt = nowIso();
  run.durationMs = Math.round(performance.now() - startedAt);
  run.summary = summarizeSuites(run.suites);
  await writeRun(run);

  console.log(JSON.stringify(run, null, 2));
  if (run.status === "failed") process.exit(1);
}

main().catch(async (error) => {
  const failedRun = {
    id: `failed-${Date.now()}`,
    status: "failed",
    startedAt: nowIso(),
    finishedAt: nowIso(),
    durationMs: 0,
    summary: { total: 0, passed: 0, failed: 1, skipped: 0, running: 0, pending: 0 },
    suites: [],
    error: error instanceof Error ? error.message : String(error),
  };
  await writeRun(failedRun).catch(() => {});
  console.error(error);
  process.exit(1);
});
