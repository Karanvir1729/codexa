#!/usr/bin/env node

import path from "node:path";
import { loadRepoEnv, maskSecret } from "./lib/env.mjs";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const env = loadRepoEnv(repoRoot);

function twimlHasStream(text) {
  return /<\s*Connect[\s>]/i.test(text) && /<\s*Stream[\s>]/i.test(text) && /wss:\/\//i.test(text);
}

async function checkHttpPost(url, label) {
  const response = await fetch(url, { method: "POST" });
  const text = await response.text();
  return {
    name: label,
    ok: response.ok && twimlHasStream(text),
    detail: response.ok ? `HTTP ${response.status}, TwiML stream ${twimlHasStream(text) ? "found" : "missing"}` : `HTTP ${response.status}`,
    status: response.status,
  };
}

async function checkNgrok(baseUrl) {
  const response = await fetch("http://127.0.0.1:4040/api/tunnels");
  const payload = await response.json();
  const tunnels = payload.tunnels || [];
  const expectedHost = baseUrl ? new URL(baseUrl).host : null;
  const tunnel = expectedHost
    ? tunnels.find((item) => {
        try {
          return new URL(item.public_url).host === expectedHost;
        } catch {
          return false;
        }
      })
    : tunnels.find((item) => item.proto === "https") || tunnels[0];
  return {
    name: "ngrok tunnel",
    ok: Boolean(tunnel?.public_url),
    detail: tunnel?.public_url ? `public URL ${tunnel.public_url}` : "no public tunnel visible on localhost:4040",
  };
}

async function checkTwilioWebhook(baseUrl) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const phoneNumberSid = env.TWILIO_PHONE_NUMBER_SID;
  if (!accountSid || !authToken || !phoneNumberSid) {
    return {
      name: "Twilio number webhook",
      ok: false,
      detail: `missing Twilio env: sid=${maskSecret(accountSid)}, token=${maskSecret(authToken)}, phoneSid=${maskSecret(phoneNumberSid)}`,
    };
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${phoneNumberSid}.json`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
    },
  );
  const payload = await response.json().catch(() => ({}));
  const expected = `${baseUrl.replace(/\/$/, "")}/`;
  return {
    name: "Twilio number webhook",
    ok: response.ok && payload.voice_url === expected && payload.voice_method === "POST",
    detail: response.ok
      ? `voice_url ${payload.voice_url === expected ? "matches" : "does not match"}, method=${payload.voice_method}`
      : `Twilio API returned ${response.status}`,
  };
}

async function main() {
  const port = env.PHONE_BOT_PORT || "7860";
  const baseUrl = (env.TWILIO_WEBHOOK_BASE_URL || env.PIPECAT_PUBLIC_URL || "").replace(/\/$/, "");
  const checks = [];

  checks.push(await checkHttpPost(`http://127.0.0.1:${port}/`, "local Pipecat TwiML endpoint").catch((error) => ({
    name: "local Pipecat TwiML endpoint",
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  })));

  checks.push(await checkNgrok(baseUrl).catch((error) => ({
    name: "ngrok tunnel",
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  })));

  if (baseUrl) {
    checks.push(await checkHttpPost(`${baseUrl}/`, "public TwiML endpoint").catch((error) => ({
      name: "public TwiML endpoint",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })));
    checks.push(await checkTwilioWebhook(baseUrl).catch((error) => ({
      name: "Twilio number webhook",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    })));
  } else {
    checks.push({ name: "public TwiML endpoint", ok: false, detail: "TWILIO_WEBHOOK_BASE_URL is not configured" });
    checks.push({ name: "Twilio number webhook", ok: false, detail: "TWILIO_WEBHOOK_BASE_URL is not configured" });
  }

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  const ok = checks.every((check) => check.ok);
  console.log(JSON.stringify({ ok, checks }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
