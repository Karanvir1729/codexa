import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

const sayVoice = process.env.VOICE_TEST_SAY_VOICE ?? "Samantha";
const userUtterance =
  process.env.VOICE_TEST_USER_UTTERANCE ??
  "Explain how you would debug a failing unit test. Use a short example, then tell me the next command.";
const longSystemPrompt =
  process.env.VOICE_TEST_SYSTEM_PROMPT ??
  "You are an agentic coding assistant in an acoustic end-to-end test. Answer the user's coding request in three short spoken sentences.";

async function ensureSayAvailable() {
  await access("/usr/bin/say");
}

function speakThroughMacSpeaker(text) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/say", ["-v", sayVoice, text], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`say exited with code ${code}`));
    });
  });
}

async function waitForNewUserTurn(page, previousCount, label) {
  await expect
    .poll(async () => page.locator("#messages .message.user").count(), {
      message: `waiting for ${label} to become a user message`,
      timeout: 120_000,
      intervals: [1000, 1500, 2500],
    })
    .toBeGreaterThan(previousCount);

  return page.locator("#messages .message.user").nth(previousCount).textContent();
}

test.describe("acoustic browser voice loop", () => {
  test.skip(process.platform !== "darwin", "The acoustic test uses macOS /usr/bin/say to play speech through the user's speaker.");

  test("speaker-to-mic prompt is accepted without overlap capture", async ({ page }, testInfo) => {
    await ensureSayAvailable();

    await page.goto("/");
    await page.selectOption("#sttProvider", "whisperx");
    await page.selectOption("#ttsProvider", "browser");
    await page.fill("#systemPrompt", longSystemPrompt);
    await page.locator("#speechIntentToggle").setChecked(true);
    await page.locator("#autoSpeakToggle").setChecked(true);

    await page.getByRole("button", { name: /start voice session/i }).click();
    await expect(page.locator("#agentState")).toContainText(/Listening|Idle|Thinking|Speaking/, { timeout: 20_000 });

    const userCountBeforePrompt = await page.locator("#messages .message.user").count();
    await speakThroughMacSpeaker(userUtterance);
    const firstUserTurn = await waitForNewUserTurn(page, userCountBeforePrompt, "speaker prompt");
    await testInfo.attach("speaker-prompt-user-turn.txt", {
      body: firstUserTurn ?? "",
      contentType: "text/plain",
    });
    expect(firstUserTurn?.toLowerCase()).toMatch(/debug|failing|unit|test|command/);

    await expect(page.locator("#messages .message.assistant").last()).not.toHaveText("", { timeout: 140_000 });

    await expect
      .poll(async () => page.locator("#turnState").textContent(), {
        message: "waiting for voice loop to return to listening",
        timeout: 60_000,
      })
      .toMatch(/Listening|Speaking|Interpreted/i);

    const turnTakingProfile = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) => candidate.startsWith("agentic-coding:turn-taking:"));
      return key ? JSON.parse(localStorage.getItem(key) || "{}") : null;
    });
    await testInfo.attach("turn-taking-profile.json", {
      body: JSON.stringify(turnTakingProfile, null, 2),
      contentType: "application/json",
    });
    expect(turnTakingProfile).toBeTruthy();
  });
});
