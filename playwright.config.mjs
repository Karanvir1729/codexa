import { defineConfig } from "@playwright/test";

const baseURL = process.env.VOICE_TEST_APP_URL ?? "http://localhost:3000";
const channel = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";

export default defineConfig({
  testDir: "tests",
  timeout: 180_000,
  outputDir: "test-results/artifacts",
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "test-results/html-report", open: "never" }]],
  use: {
    baseURL,
    channel,
    headless: process.env.HEADLESS === "1",
    permissions: ["microphone"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
