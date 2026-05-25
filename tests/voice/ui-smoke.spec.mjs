import { expect, test } from "@playwright/test";

test("main voice UI exposes installable speech-layer controls", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Talk to your computer. Codex does the work." })).toBeVisible();
  await expect(page.locator("#codexPilotToggle")).toBeVisible();
  await expect(page.locator("#codexPilotToggle")).toBeChecked();
  await expect(page.locator("#codexControlProvider")).toBeVisible();
  await expect(page.locator("#codexControlProvider")).toContainText("OpenClaw controls Codex/system");
  await expect(page.locator("#codexControlProvider")).toHaveValue("openclaw");
  await expect(page.locator("#flowCleanupLevel")).toBeVisible();
  await expect(page.locator("#flowWritingStyle")).toBeVisible();
  await expect(page.locator("#flowDictionary")).toContainText("Codex");
  await expect(page.locator("#flowSnippets")).toContainText("run tests");
  await expect(page.getByRole("heading", { name: "Pick the project before you speak" })).toBeVisible();
  await expect(page.locator("#projectMode")).toBeVisible();
  await expect(page.locator("#sessionSelect")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start chat" })).toBeVisible();
  await expect(page.locator("#textInput")).toHaveAttribute("aria-describedby", "textRouteNote");
  await expect(page.locator("#textRouteNote")).toContainText("same project, chat, OpenClaw/Codex route");
  await expect(page.locator("#telephonyState")).toContainText("Twilio:");
  await expect(page.getByText("Phone/SMS")).toBeVisible();
  await expect(page.getByRole("link", { name: "Test dashboard" })).toBeVisible();

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test("test dashboard can read latest run state", async ({ page }) => {
  await page.goto("/test-dashboard.html");

  await expect(page.getByRole("heading", { name: "Agentic Coding Assistant Test Dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run quick suite" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex build smoke" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run full suite" })).toBeVisible();
  await expect(page.locator("#suiteList")).toBeVisible();
});

test("typed request can infer and create a new project", async ({ page }) => {
  await page.route("**/api/codex/exec", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: [
        'event: meta\ndata: {"provider":"openclaw","model":"test","workspace":"/tmp/inferred"}',
        'event: token\ndata: {"text":"Created the inferred React project."}',
        'event: done\ndata: {}',
        "",
      ].join("\n\n"),
    }),
  );

  await page.goto("/");
  await page.locator("#textInput").fill("Make a new project aimed at making a website for a barbershop, using React.");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator("#sessionState")).toContainText("Barbershop React Website");
  await expect(page.locator("#projectMode")).toHaveValue("new_project");
  await expect(page.locator("#projectName")).toHaveValue("Barbershop React Website");
  await expect(page.locator("#messages")).toContainText("Created the inferred React project.");
});

test("spoken assistant output strips noisy technical artifacts", async ({ page }) => {
  await page.goto("/");

  const cleaned = await page.evaluate(() =>
    window.__agenticCodingVoiceTest.speechSafeText(
      "Done. event: token thread_019e5dc8435771b2b12dbf586e090a03 /Users/karanvirkhanna/tmp/project-8e0a07d7-67d3-4188-b619-8fc87c7c3b02 1732554778123456789 [App.jsx](/Users/me/App.jsx)",
    ),
  );

  expect(cleaned).toContain("Done.");
  expect(cleaned).toContain("App.jsx");
  expect(cleaned).not.toContain("/Users/");
  expect(cleaned).not.toContain("8e0a07d7");
  expect(cleaned).not.toContain("1732554778123456789");
});
