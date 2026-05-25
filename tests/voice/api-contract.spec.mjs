import { expect, test } from "@playwright/test";

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
  expect(health.codexPilot.purpose).toContain("Codex exec");
  expect(health.codexPilot.workspaceRoot).toBeTruthy();
  expect(health.openclaw.purpose).toContain("OpenClaw");
});

test("codex pilot status exposes local exec integration", async ({ request }) => {
  const response = await request.get("/api/codex/status");

  expect(response.ok()).toBeTruthy();
  const status = await response.json();
  expect(status.enabled).toBe(true);
  expect(status.command).toContain("codex");
  expect(status.sandbox).toBeTruthy();
  expect(status.workspaceRoot).toBeTruthy();
  expect(status.openclaw.available).toBe(true);
  expect(status.defaultControlProvider).toBe("openclaw");
});

test("openclaw status exposes the system-control adapter", async ({ request }) => {
  const response = await request.get("/api/openclaw/status");

  expect(response.ok()).toBeTruthy();
  const status = await response.json();
  expect(status.available).toBe(true);
  expect(status.command).toContain("openclaw");
  expect(status.purpose).toContain("control Codex");
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
