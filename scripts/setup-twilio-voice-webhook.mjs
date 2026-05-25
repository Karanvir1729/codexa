import fs from "node:fs";

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

function upsertEnv(text, key, value) {
  const line = `${key}=${value ?? ""}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, line);
  return `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

async function getNgrokPublicUrl() {
  const response = await fetch("http://127.0.0.1:4040/api/tunnels");
  if (!response.ok) throw new Error(`ngrok API returned ${response.status}`);
  const payload = await response.json();
  const tunnel = payload.tunnels?.find((item) => item.proto === "https") ?? payload.tunnels?.[0];
  if (!tunnel?.public_url) throw new Error("No ngrok public URL found.");
  return tunnel.public_url;
}

const text = fs.readFileSync(envPath, "utf8");
const env = { ...process.env, ...parseEnv(text) };

const accountSid = env.TWILIO_ACCOUNT_SID;
const authToken = env.TWILIO_AUTH_TOKEN;
const phoneNumberSid = env.TWILIO_PHONE_NUMBER_SID;

if (!accountSid || !authToken || !phoneNumberSid) {
  throw new Error("Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER_SID in .env.");
}

const baseUrl = env.TWILIO_WEBHOOK_BASE_URL || env.PIPECAT_PUBLIC_URL || (await getNgrokPublicUrl());
const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
const voiceUrl = `${normalizedBaseUrl}/`;
const wsUrl = `wss://${new URL(normalizedBaseUrl).host}/ws`;

const response = await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${phoneNumberSid}.json`,
  {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      VoiceUrl: voiceUrl,
      VoiceMethod: "POST",
    }),
  },
);

const body = await response.text();
if (!response.ok) {
  throw new Error(`Twilio webhook update failed ${response.status}: ${body.slice(0, 500)}`);
}

let next = text;
next = upsertEnv(next, "TWILIO_WEBHOOK_BASE_URL", normalizedBaseUrl);
next = upsertEnv(next, "PIPECAT_PUBLIC_WS_URL", wsUrl);
fs.writeFileSync(envPath, next, { mode: 0o600 });

console.log("twilio_voice_webhook_configured");
console.log(`voice_url=${voiceUrl}`);
console.log(`media_stream_ws=${wsUrl}`);
