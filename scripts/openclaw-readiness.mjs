#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const codexCommand =
  process.env.CODEX_PILOT_COMMAND?.trim() ||
  path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("exit", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function summarizePlugins(raw) {
  try {
    const parsed = JSON.parse(raw);
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    const codex = plugins.find((plugin) => plugin.id === "codex" || /codex/i.test(plugin.name || ""));
    return {
      total: plugins.length,
      codex: codex
        ? {
            id: codex.id,
            name: codex.name,
            enabled: codex.enabled,
            status: codex.status,
            providerIds: codex.providerIds || [],
            toolNames: codex.toolNames || [],
          }
        : null,
    };
  } catch {
    return { total: 0, codex: null };
  }
}

async function main() {
  const checks = [];

  const version = await run("npx", ["openclaw", "--version"]);
  checks.push({
    name: "OpenClaw CLI",
    ok: version.exitCode === 0,
    detail: (version.stdout || version.stderr).trim().split("\n")[0] || "not available",
  });

  const plugins = await run("npx", ["openclaw", "plugins", "list", "--json"]);
  const pluginSummary = summarizePlugins(plugins.stdout);
  checks.push({
    name: "OpenClaw Codex plugin",
    ok: plugins.exitCode === 0 && Boolean(pluginSummary.codex?.enabled) && pluginSummary.codex?.status === "loaded",
    detail: pluginSummary.codex
      ? `${pluginSummary.codex.name} loaded as provider ${pluginSummary.codex.providerIds.join(",") || "none"}`
      : "Codex plugin missing; run: npx openclaw plugins install @openclaw/codex",
  });

  const codexVersion = fs.existsSync(codexCommand) ? await run(codexCommand, ["--version"]) : { exitCode: 1, stdout: "", stderr: "missing" };
  checks.push({
    name: "Codex CLI coding engine",
    ok: codexVersion.exitCode === 0,
    detail:
      codexVersion.exitCode === 0
        ? `${codexCommand} -> ${(codexVersion.stdout || codexVersion.stderr).trim().split("\n")[0]}`
        : `Codex CLI missing or unavailable at ${codexCommand}`,
  });

  const doctor = await run("npx", [
    "openclaw",
    "doctor",
    "--lint",
    "--non-interactive",
    "--no-workspace-suggestions",
    "--severity-min",
    "error",
  ]);
  checks.push({
    name: "OpenClaw doctor error lint",
    ok: doctor.exitCode === 0,
    detail: doctor.exitCode === 0
      ? "read-only error lint passed"
      : (doctor.stderr || doctor.stdout).trim().split("\n").slice(-1)[0],
  });

  const gateway = await run("npx", ["openclaw", "gateway", "status"]);
  checks.push({
    name: "OpenClaw gateway",
    ok: gateway.exitCode === 0 && /running|reachable|healthy/i.test(`${gateway.stdout}\n${gateway.stderr}`),
    detail:
      gateway.exitCode === 0
        ? (gateway.stdout.trim().split("\n").find((line) => /running|reachable|healthy|port/i.test(line)) || "status command completed")
        : "gateway is not running yet; start with: npx openclaw gateway --dev --bind loopback run",
  });

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  const requiredOk = checks.filter((check) => check.name !== "OpenClaw gateway").every((check) => check.ok);
  const summary = {
    ok: requiredOk,
    gatewayRunning: checks.find((check) => check.name === "OpenClaw gateway")?.ok || false,
    checks,
    nextStep: requiredOk
      ? "Start the OpenClaw gateway when you want the coding assistant to hand off full-system actions."
      : "Fix failed OpenClaw readiness checks before routing voice actions through OpenClaw.",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!requiredOk) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
