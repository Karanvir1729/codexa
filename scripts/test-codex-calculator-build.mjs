#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = process.env.VOICE_TEST_APP_URL || "http://localhost:3000";
const workspaceRoot = path.join(repoRoot, "tmp", "codex-workspaces");
const controlProvider = process.env.CALCULATOR_CONTROL_PROVIDER || "openclaw";

function parseSse(payload) {
  const events = [];
  for (const block of payload.split(/\n\n+/)) {
    let type = "message";
    let data = "";
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("event:")) type = line.slice("event:".length).trim();
      if (line.startsWith("data:")) data += line.slice("data:".length).trim();
    }
    if (!data) continue;
    try {
      events.push({ type, data: JSON.parse(data) });
    } catch {
      events.push({ type, data });
    }
  }
  return events;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function requestCodexBuild(workspace) {
  const prompt = [
    "Build a small browser calculator app in the target workspace.",
    "",
    "This is a generic coding-control smoke test for the agentic coding assistant. Do not modify the voice-assistant repo files.",
    "Create real files, not a plan or pasted-only answer.",
    "",
    "Required contract:",
    "- package.json with a test script: node test/calculator.test.mjs",
    "- index.html",
    "- src/calculator.mjs exporting calculateExpression(expression)",
    "- src/app.js",
    "- src/styles.css",
    "- test/calculator.test.mjs",
    "",
    "Calculator behavior:",
    "- support add, subtract, multiply, divide, parentheses, decimals, and whitespace",
    "- reject invalid expressions instead of using eval unsafely",
    "- browser UI should have number/operator buttons, clear, equals, display, and keyboard entry",
    "",
    "Run npm test from the target workspace before your final answer.",
    "Final answer should summarize files changed and checks run.",
  ].join("\n");

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/codex/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      controlProvider,
      workspaceDir: workspace,
      timeoutMs: Number(process.env.CALCULATOR_CODEX_TIMEOUT_MS || 600000),
      systemPrompt: "You are a concise voice coding pilot.",
      messages: [{ role: "user", content: prompt }],
      client: {
        session_id: "calculator_build_smoke",
        session_title: "Calculator build smoke",
        project_name: "Calculator app smoke",
        project_mode: "new_project",
        user_id: "test",
        user_name: "Test",
        control_provider: controlProvider,
        workspace_dir: workspace,
      },
    }),
  });

  const raw = await response.text();
  if (!response.ok) throw new Error(`Codex endpoint returned ${response.status}: ${raw.slice(0, 800)}`);

  const events = parseSse(raw);
  const errors = events.filter((event) => event.type === "error").map((event) => event.data?.message || String(event.data));
  if (errors.length) throw new Error(`Codex endpoint emitted errors:\n${errors.join("\n")}`);

  const text = events
    .filter((event) => event.type === "token")
    .map((event) => event.data?.text || "")
    .join("")
    .trim();

  return {
    events,
    responseText: text,
  };
}

async function verifyCalculator(workspace) {
  const requiredFiles = [
    "package.json",
    "index.html",
    "src/calculator.mjs",
    "src/app.js",
    "src/styles.css",
    "test/calculator.test.mjs",
  ];
  const missing = [];
  for (const relativePath of requiredFiles) {
    if (!(await fileExists(path.join(workspace, relativePath)))) missing.push(relativePath);
  }
  if (missing.length) throw new Error(`Generated calculator is missing required files: ${missing.join(", ")}`);

  const pkg = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf-8"));
  if (!pkg.scripts?.test?.includes("test/calculator.test.mjs")) {
    throw new Error("package.json must include a test script that runs test/calculator.test.mjs");
  }

  const calculatorSource = await fs.readFile(path.join(workspace, "src", "calculator.mjs"), "utf-8");
  if (/\beval\s*\(|\bFunction\s*\(/.test(calculatorSource)) {
    throw new Error("src/calculator.mjs should parse/evaluate expressions without eval() or Function().");
  }

  await run("npm", ["test"], { cwd: workspace });

  const moduleUrl = `${pathToFileURL(path.join(workspace, "src", "calculator.mjs")).href}?t=${Date.now()}`;
  const calculator = await import(moduleUrl);
  if (typeof calculator.calculateExpression !== "function") {
    throw new Error("src/calculator.mjs must export calculateExpression(expression)");
  }

  const cases = [
    ["2+3*4", 14],
    ["(10 / 2) + 7", 12],
    ["3.5 + 2.5", 6],
    ["18 - 4 * 2", 10],
  ];
  for (const [expression, expected] of cases) {
    const actual = calculator.calculateExpression(expression);
    if (Math.abs(actual - expected) > 1e-9) {
      throw new Error(`calculateExpression(${JSON.stringify(expression)}) returned ${actual}; expected ${expected}`);
    }
  }
}

async function main() {
  const workspace = path.join(workspaceRoot, `calculator-smoke-${Date.now()}`);
  await fs.mkdir(workspace, { recursive: true });

  const startedAt = performance.now();
  const result = await requestCodexBuild(workspace);
  await verifyCalculator(workspace);

  const durationMs = Math.round(performance.now() - startedAt);
  console.log(`PASS ${controlProvider} calculator build smoke: ${durationMs} ms`);
  console.log(`workspace=${workspace}`);
  console.log(`response_excerpt=${result.responseText.slice(0, 400).replace(/\s+/g, " ") || "(empty)"}`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace,
        durationMs,
        eventTypes: result.events.map((event) => event.type),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
