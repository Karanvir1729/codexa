import { expect, test } from "@playwright/test";

const appOrigin = process.env.VOICE_TEST_APP_URL ?? "http://localhost:3000";

test("speech-intent rewrites raw speech into a clear user message", async ({ request }) => {
  const rawText =
    "um okay so i have three requests first inspect the files second run tests and third summarize changes after but keep it short";

  const response = await request.post("/api/speech-intent", {
    data: {
      rawText,
      mode: "rewrite",
    },
  });

  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  expect(result.text).toBeTruthy();
  expect(result.text.length).toBeGreaterThan(30);
  expect(result.text.toLowerCase()).toContain("inspect");
  expect(result.text.toLowerCase()).toContain("test");
  expect(result.text.toLowerCase()).toContain("summarize");
  expect(result.mode).toMatch(/rewrite|fallback_raw/);
});

test("speech-intent supports Flow-style dictionary, snippets, backtrack, and list formatting", async ({ request }) => {
  const response = await request.post("/api/speech-intent", {
    data: {
      rawText:
        "um use coat x first inspect files second run tests third meet at two actually three period",
      mode: "format",
      flow: {
        cleanupLevel: "high",
        writingStyle: "bullets",
        languageHint: "en-US",
        dictionary: [{ from: "coat x", to: "Codex", term: "Codex", starred: true }],
        snippets: [{ trigger: "run tests", text: "Run the focused test suite after making the change." }],
      },
    },
  });

  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  expect(result.text).toContain("Codex");
  expect(result.text).toContain("Run the focused test suite");
  expect(result.text).not.toMatch(/\bum\b/i);
  expect(result.text.toLowerCase()).not.toContain("two actually three");
  expect(result.text).toContain("- ");
  expect(result.mode).toBe("format");
  expect(result.flow.dictionary_applied).toEqual(
    expect.arrayContaining([expect.objectContaining({ from: "coat x", to: "Codex" })]),
  );
  expect(result.flow.snippets_applied).toEqual(
    expect.arrayContaining([expect.objectContaining({ trigger: "run tests" })]),
  );
});

test("speech-intent falls back to local Flow formatting when the LLM rewrite is unavailable", async ({ request }) => {
  const response = await request.post("/api/speech-intent", {
    data: {
      rawText: "um can you explain coin three point five comma and keep it short",
      mode: "rewrite",
      flow: {
        cleanupLevel: "high",
        writingStyle: "coding",
        dictionary: [{ from: "coin three point five", to: "Qwen 3.5", term: "Qwen 3.5" }],
      },
    },
  });

  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  expect(result.text).toContain("Qwen 3.5");
  expect(result.mode).toMatch(/rewrite|fallback_flow_format/);
});

test("provider health exposes voice, intent, and speaker identity layers", async ({ request }) => {
  const response = await request.get("/api/providers/health");

  expect(response.ok()).toBeTruthy();
  const health = await response.json();
  expect(health.llm.configuredProvider).toBeTruthy();
  expect(health.stt.configuredProvider).toBeTruthy();
  expect(health.speechIntent.mode).toBeTruthy();
  expect(health.speakerGuard.purpose).toContain("speaker identity");
  expect(health.codexPilot.purpose).toContain("Codex CLI");
  expect(health.codexPilot.workspaceRoot).toBeTruthy();
  expect(health.codexPilot.codexHome).toContain(".codex");
  expect(health.openclaw.purpose).toContain("OpenClaw");
  expect(health.openclaw.purpose).toContain("Codex onboarding");
  expect(health.openclaw.purpose).toContain("No fallback");
});

test("codex pilot status exposes local CLI and app-chat integration", async ({ request }) => {
  const response = await request.get("/api/codex/status");

  expect(response.ok()).toBeTruthy();
  const status = await response.json();
  expect(status.enabled).toBe(true);
  expect(status.command).toContain("codex");
  expect(status.codexHome).toContain(".codex");
  expect(status.sandbox).toBeTruthy();
  expect(status.workspaceRoot).toBeTruthy();
  expect(status.openclaw.available).toBe(true);
  expect(status.defaultControlProvider).toBe("openclaw");
  expect(status.openclaw.codexCliCommand).toContain("codex");
  expect(status.openclaw.codexCliCommand).toBe(status.command);
  expect(status.openclaw.codexHome).toBe(status.codexHome);
  expect(status.appChatRegistration.enabled).toBe(true);
  expect(status.appChatRegistration.command).toContain("codex");
  expect(status.appChatRegistration.codexHome).toBe(status.codexHome);
  expect(status.appChatRegistration.defaultForCodexWrapperInteractions).toBe(true);
  expect(status.appChatRegistration.purpose).toContain("wrapper interactions");
});

test("static server rejects traversal and malformed paths", async ({ request }) => {
  const traversal = await request.get("/..%2Fserver.mjs");
  expect(traversal.status()).toBe(404);

  const nestedTraversal = await request.get("/assets/..%2F..%2Fserver.mjs");
  expect(nestedTraversal.status()).toBe(404);

  const malformed = await request.get("/%E0%A4%A");
  expect(malformed.status()).toBe(404);
});

test("desktop launch requires same-origin one-time token", async ({ request }) => {
  const crossOriginLaunch = await request.post("/api/desktop/launch", {
    headers: { Origin: "https://attacker.example" },
  });
  expect(crossOriginLaunch.status()).toBe(403);

  const missingTokenLaunch = await request.post("/api/desktop/launch", {
    headers: { Origin: appOrigin },
  });
  expect(missingTokenLaunch.status()).toBe(403);

  const tokenResponse = await request.get("/api/desktop/launch-token", {
    headers: { Referer: `${appOrigin}/` },
  });
  expect(tokenResponse.ok()).toBeTruthy();
  const token = await tokenResponse.json();
  expect(token.token).toBeTruthy();

  const invalidTokenLaunch = await request.post("/api/desktop/launch", {
    headers: {
      Origin: appOrigin,
      "X-Desktop-Launch-Token": "not-a-real-token",
    },
  });
  expect(invalidTokenLaunch.status()).toBe(403);
});

test("openclaw status exposes the system-control adapter", async ({ request }) => {
  const response = await request.get("/api/openclaw/status");

  expect(response.ok()).toBeTruthy();
  const status = await response.json();
  expect(status.available).toBe(true);
  expect(status.command).toContain("openclaw");
  expect(status.controllerModel).toBeTruthy();
  expect(status.controllerModel).toContain("openai/");
  expect(status.codexHome).toContain(".codex");
  expect(status.codexCliCommand).toContain("Codex.app");
  expect(status.purpose).toContain("control Codex");
  expect(status.purpose).toContain("No fallback");
});

test("twilio webhooks expose voice stream TwiML and SMS bridge TwiML", async ({ request }) => {
  const statusResponse = await request.get("/api/twilio/status");
  expect(statusResponse.ok()).toBeTruthy();
  const status = await statusResponse.json();
  expect(status.voiceWebhookPath).toBe("/api/twilio/voice");
  expect(status.smsWebhookPath).toBe("/api/twilio/sms");
  expect(status.smsRuntime).toContain("OpenClaw/Codex");

  const voice = await request.post("/api/twilio/voice");
  expect(voice.ok()).toBeTruthy();
  const voiceXml = await voice.text();
  expect(voiceXml).toContain("<Response>");
  expect(voiceXml).toContain("<Connect>");
  expect(voiceXml).toContain("<Stream");
  expect(voiceXml).toContain("wss://");

  const sms = await request.post("/api/twilio/sms", {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    data: "From=%2B15555550100&To=%2B15555550199&Body=no-sms%20smoke%20test",
  });
  expect(sms.ok()).toBeTruthy();
  const smsXml = await sms.text();
  expect(smsXml).toContain("<Message>no-sms webhook ready</Message>");
});

test("voice sessions persist project chat history", async ({ request }) => {
  const projectName = `Test project ${Date.now()}`;
  const create = await request.post("/api/sessions", {
    data: {
      projectMode: "new_project",
      projectName,
      title: "API session smoke",
      userId: "user_a",
      userName: "User A",
      source: "test",
    },
  });
  expect(create.ok()).toBeTruthy();
  const created = await create.json();
  expect(created.session.projectName).toBe(projectName);

  const append = await request.post(`/api/sessions/${created.session.id}/messages`, {
    data: {
      role: "user",
      content: "Can you keep this chat in history?",
      source: "test",
      route: "assistant_llm",
    },
  });
  expect(append.ok()).toBeTruthy();

  const loaded = await request.get(`/api/sessions/${created.session.id}`);
  expect(loaded.ok()).toBeTruthy();
  const session = await loaded.json();
  expect(session.session.messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: "user", content: "Can you keep this chat in history?" })]),
  );

  const list = await request.get("/api/sessions");
  expect(list.ok()).toBeTruthy();
  const history = await list.json();
  expect(history.projects).toContain(projectName);
  expect(history.sessions.some((item) => item.id === created.session.id)).toBe(true);
});
