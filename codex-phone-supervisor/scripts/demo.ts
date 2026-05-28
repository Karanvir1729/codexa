const apiBase = process.env.CODEX_PHONE_SUPERVISOR_API_BASE?.trim();
const workspacePath = process.env.CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH?.trim();
const userId = process.env.CODEX_PHONE_SUPERVISOR_SIM_USER_ID?.trim();

if (!apiBase) throw new Error("CODEX_PHONE_SUPERVISOR_API_BASE is required.");
if (!workspacePath) throw new Error("CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH is required.");
if (!userId) throw new Error("CODEX_PHONE_SUPERVISOR_SIM_USER_ID is required.");

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
  const start = await fetch(`${apiBase}/codex/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace_path: workspacePath,
      task: "Create or update tmp/codex-phone-supervisor-demo.md with a short note describing this repo. Do not run shell commands unless you need approval.",
    }),
  }).then(readJsonResponse);

  const sessionId = start.session_id;
  console.log(`session_id=${sessionId}`);

  for (;;) {
    const status = await fetch(`${apiBase}/codex/status?session_id=${encodeURIComponent(sessionId)}`).then(readJsonResponse);
    const session = status.session;
    console.log(`status=${session.current_status} latest=${session.latest_codex_message || "(none)"}`);
    if (["completed", "failed", "waiting_for_approval"].includes(session.current_status)) break;
    await sleep(2000);
  }

  const changed = await fetch(`${apiBase}/call/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      user_id: userId,
      channel: "web_text",
      text: "what changed?",
      timestamp: new Date().toISOString(),
    }),
  }).then(readJsonResponse);
  console.log(`voice_response=${changed.text}`);

  const summary = await fetch(`${apiBase}/codex/summary?session_id=${encodeURIComponent(sessionId)}`).then(readJsonResponse);
  console.log(JSON.stringify(summary, null, 2));
}

void main();
