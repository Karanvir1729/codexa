const apiBase = process.env.CODEX_PHONE_SUPERVISOR_API_BASE?.trim();
const userId = process.env.CODEX_PHONE_SUPERVISOR_SIM_USER_ID?.trim();
if (!apiBase) {
  console.error("CODEX_PHONE_SUPERVISOR_API_BASE is required.");
  process.exit(1);
}
if (!userId) {
  console.error("CODEX_PHONE_SUPERVISOR_SIM_USER_ID is required.");
  process.exit(1);
}

async function readJsonResponse(res: Response) {
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const [, , sessionId, ...rest] = process.argv;
  const text = rest.join(" ").trim();
  if (!sessionId || !text) {
    console.error("Usage: npm run phone -- <session_id> \"what changed?\"");
    process.exit(1);
  }

  try {
    const response = await fetch(`${apiBase}/call/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        user_id: userId,
        channel: "web_voice",
        text,
        timestamp: new Date().toISOString(),
      }),
    }).then(readJsonResponse);
    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    console.error(`Phone simulator request failed for session ${sessionId}:`, error);
    process.exit(1);
  }
}

void main();
