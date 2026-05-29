import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

function loadPlainEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return {};
  const values: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    if (!key) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export default defineConfig(({ mode }) => {
  const root = path.resolve(__dirname);
  const repoRoot = path.resolve(root, "..", "..");
  const env = {
    ...loadEnv(mode, repoRoot, ""),
    ...loadPlainEnvFile(path.join(repoRoot, ".env.codex-phone-supervisor")),
    ...process.env,
  };
  const rawPort = env.CODEX_PHONE_SUPERVISOR_FRONTEND_PORT;
  if (!rawPort) throw new Error("CODEX_PHONE_SUPERVISOR_FRONTEND_PORT is required.");
  const port = Number(rawPort);
  if (!Number.isFinite(port)) throw new Error("CODEX_PHONE_SUPERVISOR_FRONTEND_PORT must be a finite number.");
  for (const name of ["VITE_SUPERVISOR_API_BASE", "VITE_SUPERVISOR_WORKSPACE_PATH", "VITE_SUPERVISOR_USER_ID"]) {
    if (!env[name]?.trim()) throw new Error(`${name} is required.`);
  }

  return {
    plugins: [react()],
    root,
    define: {
      "import.meta.env.VITE_SUPERVISOR_API_BASE": JSON.stringify(env.VITE_SUPERVISOR_API_BASE),
      "import.meta.env.VITE_SUPERVISOR_WORKSPACE_PATH": JSON.stringify(env.VITE_SUPERVISOR_WORKSPACE_PATH),
      "import.meta.env.VITE_SUPERVISOR_USER_ID": JSON.stringify(env.VITE_SUPERVISOR_USER_ID),
    },
    server: {
      port,
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
