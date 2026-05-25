import fs from "node:fs";
import { spawn } from "node:child_process";

const envPath = ".env";

function parseEnv(text) {
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

async function getNgrokPublicHost() {
  const response = await fetch("http://127.0.0.1:4040/api/tunnels");
  if (!response.ok) throw new Error(`ngrok API returned ${response.status}`);
  const payload = await response.json();
  const tunnel = payload.tunnels?.find((item) => item.proto === "https") ?? payload.tunnels?.[0];
  if (!tunnel?.public_url) throw new Error("No ngrok public URL found.");
  return new URL(tunnel.public_url).host;
}

const env = {
  ...process.env,
  ...(fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf8")) : {}),
};

const port = env.PHONE_BOT_PORT || "7860";
const publicUrl = env.PIPECAT_PUBLIC_URL || env.TWILIO_WEBHOOK_BASE_URL || "";
const proxyHost = publicUrl ? new URL(publicUrl).host : await getNgrokPublicHost();

const args = [
  "services/pipecat_twilio_bot.py",
  "-t",
  "twilio",
  "--host",
  "0.0.0.0",
  "--port",
  port,
  "-x",
  proxyHost,
];

const child = spawn(".venv-pipecat/bin/python", args, {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
