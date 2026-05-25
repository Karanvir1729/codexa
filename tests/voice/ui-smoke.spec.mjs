import { expect, test } from "@playwright/test";

test("main voice UI exposes installable speech-layer controls", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Interruptible desktop voice tutor" })).toBeVisible();
  await expect(page.locator("#codexPilotToggle")).toBeVisible();
  await expect(page.locator("#codexControlProvider")).toBeVisible();
  await expect(page.locator("#codexControlProvider")).toContainText("OpenClaw controls Codex/system");
  await expect(page.locator("#flowCleanupLevel")).toBeVisible();
  await expect(page.locator("#flowWritingStyle")).toBeVisible();
  await expect(page.locator("#flowDictionary")).toContainText("derivitives");
  await expect(page.locator("#flowSnippets")).toContainText("quiz me");
  await expect(page.getByRole("heading", { name: "Choose a project and chat" })).toBeVisible();
  await expect(page.locator("#projectMode")).toBeVisible();
  await expect(page.locator("#sessionSelect")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start new chat" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Test dashboard" })).toBeVisible();

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test("test dashboard can read latest run state", async ({ page }) => {
  await page.goto("/test-dashboard.html");

  await expect(page.getByRole("heading", { name: "Tutor-Tron Test Dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run quick suite" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run full suite" })).toBeVisible();
  await expect(page.locator("#suiteList")).toBeVisible();
});
