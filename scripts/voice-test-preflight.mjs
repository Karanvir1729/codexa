#!/usr/bin/env node
import { access } from "node:fs/promises";

const appUrl = process.env.VOICE_TEST_APP_URL ?? "http://localhost:3000";

async function checkUrl(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  return response;
}

async function main() {
  const checks = [];

  if (process.platform !== "darwin") {
    checks.push({
      name: "macOS speaker command",
      ok: false,
      detail: "Acoustic test uses /usr/bin/say and currently expects macOS.",
    });
  } else {
    try {
      await access("/usr/bin/say");
      checks.push({ name: "macOS speaker command", ok: true, detail: "/usr/bin/say found" });
    } catch (error) {
      checks.push({ name: "macOS speaker command", ok: false, detail: error.message });
    }
  }

  try {
    await checkUrl(appUrl, "Agentic coding assistant app");
    checks.push({ name: "Agentic coding assistant app", ok: true, detail: appUrl });
  } catch (error) {
    checks.push({ name: "Agentic coding assistant app", ok: false, detail: error.message });
  }

  try {
    const response = await checkUrl(`${appUrl.replace(/\/$/, "")}/api/providers/health`, "Provider health");
    const health = await response.json();
    checks.push({
      name: "WhisperX STT",
      ok: Boolean(health.stt?.whisperxConfigured),
      detail: health.stt?.whisperxUrl || "not configured",
    });
    checks.push({
      name: "Speech intent rewrite",
      ok: Boolean(health.speechIntent?.mode),
      detail: `${health.speechIntent?.provider || "unknown"} / ${health.speechIntent?.mode || "unknown"}`,
    });
    checks.push({
      name: "Speaker identity",
      ok: Boolean(health.speakerGuard?.configured),
      detail: health.speakerGuard?.targetModel || "not configured",
    });
  } catch (error) {
    checks.push({ name: "Provider health", ok: false, detail: error.message });
  }

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  if (checks.some((check) => !check.ok)) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
