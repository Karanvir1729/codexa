import fs from "node:fs";
import path from "node:path";

export function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function loadRepoEnv(repoRoot = process.cwd()) {
  const envPath = path.join(repoRoot, ".env");
  return {
    ...process.env,
    ...(fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : {}),
  };
}

export function maskSecret(value) {
  if (!value) return "missing";
  if (value.length <= 8) return "set";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
