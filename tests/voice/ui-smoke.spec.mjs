import { expect, test } from "@playwright/test";

test("website is a simple Mac installer", async ({ page }) => {
  let launchCalled = false;
  await page.route("**/api/desktop/launch-token", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ token: "test-launch-token", expiresInMs: 300000 }),
    }),
  );
  await page.route("**/api/desktop/launch", (route) => {
    launchCalled = true;
    expect(route.request().headers()["x-desktop-launch-token"]).toBe("test-launch-token");
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ status: "launching", app: "Codexa Mac app" }),
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Codexa" })).toBeVisible();
  await page.getByRole("button", { name: "Install for Mac" }).click();
  await expect(page.getByText("Opened.")).toBeVisible();
  expect(launchCalled).toBe(true);
  await page.getByRole("button", { name: "Info" }).click();
  await expect(page.getByText("keeps work inside the current Codex project")).toBeVisible();

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThan(0);
});

test("test dashboard can read latest run state", async ({ page }) => {
  await page.goto("/test-dashboard.html");

  await expect(page.getByRole("heading", { name: "Codexa Test Dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run quick suite" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Codex build smoke" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run full suite" })).toBeVisible();
  await expect(page.locator("#suiteList")).toBeVisible();
});
