#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const stateDir = path.join(repoRoot, "data", "test-runs");
const latestPath = path.join(stateDir, "dev-loop-latest.json");

const defaultSuites = ["preflight", "eval", "api", "ui"];
const sourceGlobs = [
  "server.mjs",
  "desktop/main.cjs",
  "web/app.js",
  "web/index.html",
  "web/styles.css",
  "web/sw.js",
  "scripts",
  "tests",
  "services",
  "package.json",
  "package-lock.json",
];

function parseArgs(argv) {
  const args = {
    cycles: Number(process.env.DEV_LOOP_CYCLES || 1),
    watch: false,
    intervalMs: Number(process.env.DEV_LOOP_INTERVAL_MS || 1500),
    suites: defaultSuites,
  };

  for (const arg of argv) {
    if (arg === "--watch") args.watch = true;
    if (arg.startsWith("--cycles=")) args.cycles = Number(arg.slice("--cycles=".length));
    if (arg.startsWith("--interval-ms=")) args.intervalMs = Number(arg.slice("--interval-ms=".length));
    if (arg.startsWith("--suites=")) {
      args.suites = arg
        .slice("--suites=".length)
        .split(",")
        .map((suite) => suite.trim())
        .filter(Boolean);
    }
  }

  if (!Number.isFinite(args.cycles) || args.cycles < 1) args.cycles = 1;
  if (!Number.isFinite(args.intervalMs) || args.intervalMs < 500) args.intervalMs = 1500;
  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function runCommand(label, command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    console.log(`\n[dev-loop] ${label}`);
    console.log(`[dev-loop] $ ${[command, ...args].join(" ")}`);

    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        HEADLESS: process.env.HEADLESS ?? "1",
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
        label,
        command: [command, ...args].join(" "),
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
    child.on("exit", (exitCode) => {
      resolve({
        label,
        command: [command, ...args].join(" "),
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - startedAt),
      });
    });
  });
}

async function writeLoopState(state) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(latestPath, JSON.stringify(state, null, 2));
}

async function runCycle(cycleNumber, suites) {
  const cycle = {
    id: `dev-loop-${Date.now()}-${cycleNumber}`,
    cycleNumber,
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    durationMs: null,
    checks: [],
  };
  const startedAt = performance.now();
  await writeLoopState(cycle);

  const checks = [
    {
      label: "Syntax checks",
      command: "node",
      args: ["--check", "server.mjs"],
    },
    {
      label: "Desktop shell syntax",
      command: "node",
      args: ["--check", "desktop/main.cjs"],
    },
    {
      label: "Frontend syntax",
      command: "node",
      args: ["--check", "web/app.js"],
    },
    {
      label: "Voice test runner",
      command: "node",
      args: ["scripts/voice-test-runner.mjs", `--id=${cycle.id}`, `--suites=${suites.join(",")}`],
    },
  ];

  for (const check of checks) {
    const result = await runCommand(check.label, check.command, check.args);
    cycle.checks.push({
      label: result.label,
      command: result.command,
      status: result.exitCode === 0 ? "passed" : "failed",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutTail: result.stdout.slice(-6000),
      stderrTail: result.stderr.slice(-6000),
    });
    cycle.status = cycle.checks.some((item) => item.status === "failed") ? "failed" : "running";
    await writeLoopState(cycle);
    if (result.exitCode !== 0) break;
  }

  cycle.status = cycle.checks.some((item) => item.status === "failed") ? "failed" : "passed";
  cycle.finishedAt = nowIso();
  cycle.durationMs = Math.round(performance.now() - startedAt);
  await writeLoopState(cycle);

  console.log(`\n[dev-loop] cycle ${cycleNumber} ${cycle.status} in ${cycle.durationMs} ms`);
  return cycle;
}

async function listFiles(target) {
  const fullPath = path.join(repoRoot, target);
  const stat = await fs.stat(fullPath).catch(() => null);
  if (!stat) return [];
  if (!stat.isDirectory()) return [fullPath];

  const entries = await fs.readdir(fullPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => listFiles(path.relative(repoRoot, path.join(fullPath, entry.name)))),
  );
  return nested.flat();
}

async function sourceFingerprint() {
  const files = (await Promise.all(sourceGlobs.map(listFiles))).flat();
  const stats = await Promise.all(
    files.map(async (file) => {
      const stat = await fs.stat(file).catch(() => null);
      return stat ? `${file}:${stat.mtimeMs}:${stat.size}` : `${file}:missing`;
    }),
  );
  return stats.sort().join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let lastFingerprint = await sourceFingerprint();
  let failed = false;

  for (let cycle = 1; cycle <= args.cycles; cycle += 1) {
    const result = await runCycle(cycle, args.suites);
    if (result.status !== "passed") {
      failed = true;
      break;
    }
  }

  if (!args.watch) {
    if (failed) process.exit(1);
    return;
  }

  console.log(`\n[dev-loop] watch mode active; polling every ${args.intervalMs} ms.`);
  while (true) {
    await sleep(args.intervalMs);
    const nextFingerprint = await sourceFingerprint();
    if (nextFingerprint === lastFingerprint) continue;
    lastFingerprint = nextFingerprint;
    await runCycle(Date.now(), args.suites);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
