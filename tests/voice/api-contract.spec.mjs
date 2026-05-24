import { expect, test } from "@playwright/test";

test("speech-intent rewrites raw speech into a clear user message", async ({ request }) => {
  const rawText =
    "um okay so i have three questions first explain derivatives second use an example and third quiz me after but like keep it short";

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
  expect(result.text.toLowerCase()).toContain("derivatives");
  expect(result.text.toLowerCase()).toContain("example");
  expect(result.text.toLowerCase()).toContain("quiz");
  expect(result.mode).toMatch(/rewrite|fallback_raw/);
});

test("speech-intent supports Flow-style dictionary, snippets, backtrack, and list formatting", async ({ request }) => {
  const response = await request.post("/api/speech-intent", {
    data: {
      rawText:
        "um explain derivitives first use a simple analogy second quiz me third meet at two actually three period",
      mode: "format",
      flow: {
        cleanupLevel: "high",
        writingStyle: "bullets",
        languageHint: "en-US",
        dictionary: [{ from: "derivitives", to: "derivatives", term: "derivatives", starred: true }],
        snippets: [{ trigger: "quiz me", text: "Ask me one short diagnostic question." }],
      },
    },
  });

  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  expect(result.text.toLowerCase()).toContain("derivatives");
  expect(result.text).toContain("Ask me one short diagnostic question");
  expect(result.text.toLowerCase()).not.toContain("um");
  expect(result.text.toLowerCase()).not.toContain("two actually three");
  expect(result.text).toContain("- ");
  expect(result.mode).toBe("format");
  expect(result.flow.dictionary_applied).toEqual(
    expect.arrayContaining([expect.objectContaining({ from: "derivitives", to: "derivatives" })]),
  );
  expect(result.flow.snippets_applied).toEqual(
    expect.arrayContaining([expect.objectContaining({ trigger: "quiz me" })]),
  );
});

test("speech-intent falls back to local Flow formatting when the LLM rewrite is unavailable", async ({ request }) => {
  const response = await request.post("/api/speech-intent", {
    data: {
      rawText: "um can you explain coin three point five comma and keep it short",
      mode: "rewrite",
      flow: {
        cleanupLevel: "high",
        writingStyle: "tutor",
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
});
