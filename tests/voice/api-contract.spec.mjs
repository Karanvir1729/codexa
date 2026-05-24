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

test("provider health exposes voice, intent, and speaker identity layers", async ({ request }) => {
  const response = await request.get("/api/providers/health");

  expect(response.ok()).toBeTruthy();
  const health = await response.json();
  expect(health.llm.configuredProvider).toBeTruthy();
  expect(health.stt.configuredProvider).toBeTruthy();
  expect(health.speechIntent.mode).toBeTruthy();
  expect(health.speakerGuard.purpose).toContain("speaker identity");
});
