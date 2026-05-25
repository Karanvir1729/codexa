const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpDir = path.join(repoRoot, "tmp");
const appPort = Number(process.env.PORT || 3000);
const sttPort = Number(process.env.WHISPERX_PORT || 9001);
const appUrl = process.env.AGENTIC_CODING_APP_URL || `http://localhost:${appPort}`;
const dashboardUrl = `${appUrl.replace(/\/$/, "")}/test-dashboard.html`;
const desktopAppPath = path.join(__dirname, "app.html");
const managedProcesses = [];
const enableVoiceRuntime = process.env.CODEXA_ENABLE_VOICE_RUNTIME === "1";
const currentProjectName = path.basename(repoRoot);
const generatedWorkspaceRoot = path.resolve(process.env.CODEX_WORKSPACE_ROOT || path.join(os.homedir(), "agentic-coding-projects"));
const CODEX_LINK_TIMEOUT_MS = Number(process.env.CODEX_LINK_TIMEOUT_MS || 90000);
const permissionUrls = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  fullDisk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};
const trustedLoadOrigins = new Set([new URL(appUrl).origin]);

let mainWindow = null;
let isQuitting = false;

function ensureTmpDir() {
  fs.mkdirSync(tmpDir, { recursive: true });
}

function appendLog(name, line) {
  ensureTmpDir();
  fs.appendFileSync(path.join(tmpDir, `desktop-${name}.log`), line);
}

function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(600);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function waitForHttp(url, timeoutMs = 45000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve(true);
          return;
        }
        retry();
      });
      req.setTimeout(1200, () => {
        req.destroy();
        retry();
      });
      req.on("error", retry);
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(attempt, 500);
    };

    attempt();
  });
}

async function apiJson(pathname, options = {}) {
  const response = await fetch(`${appUrl.replace(/\/$/, "")}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `${pathname} returned ${response.status}`);
  return data;
}

function safeSessionTitle(value, fallback = "Codexa chat") {
  const text = String(value || fallback).replace(/\s+/g, " ").trim() || fallback;
  return text.length > 58 ? `${text.slice(0, 55)}...` : text;
}

function safeProjectSlug(value, fallback = "codexa-project") {
  return String(value || fallback)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72) || fallback;
}

function inferNewProjectRoute(userText, session = null) {
  const text = String(userText || "").replace(/\s+/g, " ").trim();
  const newProjectIntent =
    /\b(new|brand new|separate|standalone|fresh)\b.{0,80}\b(project|app|website|site|game|repo|repository)\b/i.test(text) ||
    /\b(create|make|build|start|scaffold|generate)\b.{0,80}\b(project|app|website|site|game|repo|repository)\b/i.test(text);
  if (!newProjectIntent && session?.projectMode === "new_project" && session.workspaceDir) {
    return {
      projectMode: "new_project",
      projectName: session.projectName || path.basename(session.workspaceDir),
      workspaceDir: session.workspaceDir,
      shouldStartSession: false,
    };
  }

  if (!newProjectIntent) {
    return {
      projectMode: "existing_project",
      projectName: currentProjectName,
      workspaceDir: repoRoot,
      shouldStartSession: false,
    };
  }

  const named =
    text.match(/\b(?:named|called|name it|project named|project called)\s+["']?([a-zA-Z0-9][a-zA-Z0-9 _-]{1,80})["']?/i)?.[1] ||
    text.match(/\b(?:for|called)\s+(?:a\s+)?([a-zA-Z0-9][a-zA-Z0-9 _-]{1,80}?)(?:\s+(?:using|with|in|and|that|which|please|$))/i)?.[1] ||
    text.match(/\b([a-zA-Z0-9][a-zA-Z0-9_-]{2,80})\b(?=\s+(?:using|with|in)\b)/i)?.[1];
  const slug = safeProjectSlug(named || safeSessionTitle(text, "codexa-project"));
  const workspaceDir = path.join(generatedWorkspaceRoot, slug);
  return {
    projectMode: "new_project",
    projectName: slug,
    workspaceDir,
    shouldStartSession:
      !session ||
      session.projectMode !== "new_project" ||
      !session.workspaceDir ||
      path.resolve(session.workspaceDir) !== path.resolve(workspaceDir),
  };
}

function desktopSessionPayload(overrides = {}) {
  return {
    projectMode: overrides.projectMode || "existing_project",
    projectName: overrides.projectName || currentProjectName,
    workspaceDir: overrides.workspaceDir || repoRoot,
    title: safeSessionTitle(overrides.title || "Codexa desktop chat"),
    userId: "desktop_user",
    userName: osUserName(),
    source: "desktop_app",
  };
}

function filterDesktopSessions(sessions = []) {
  const allowed = new Set([currentProjectName, "Current repo"]);
  return sessions.filter((session) => {
    if (session.source === "test") return false;
    return allowed.has(session.projectName || "Current repo") || session.projectMode === "new_project" || session.source === "desktop_app";
  });
}

function osUserName() {
  return process.env.USER || process.env.LOGNAME || "Mac user";
}

function isTrustedNavigationUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return path.resolve(decodeURIComponent(parsed.pathname)) === path.resolve(desktopAppPath);
    return ["http:", "https:"].includes(parsed.protocol) && trustedLoadOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

function openTrustedExternalUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) return false;
    shell.openExternal(parsed.toString());
    return true;
  } catch {
    return false;
  }
}

function latestUserMessage(messages = []) {
  return [...messages].reverse().find((message) => message?.role === "user" && message.content)?.content || "";
}

function messagesWithLatestUserMessage(messages = [], userText = "") {
  const safeMessages = Array.isArray(messages)
    ? messages.filter((message) => message && typeof message.content === "string" && ["user", "assistant", "system"].includes(message.role))
    : [];
  const latestUser = [...safeMessages].reverse().find((message) => message.role === "user");
  if (latestUser?.content?.trim() === userText.trim()) return safeMessages;
  return [...safeMessages, { role: "user", content: userText }];
}

function parseSseEvents(raw) {
  const events = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    let type = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) continue;
    try {
      events.push({ type, data: JSON.parse(dataLines.join("\n")) });
    } catch {
      events.push({ type, data: { text: dataLines.join("\n") } });
    }
  }
  return events;
}

async function streamCodexTurn(sender, { sessionId, text, messages = [] }) {
  const userText = String(text || "").trim();
  if (!userText) throw new Error("Empty message.");

  let session = null;
  if (sessionId) {
    session = (await apiJson(`/api/sessions/${encodeURIComponent(sessionId)}`)).session;
  }

  const route = inferNewProjectRoute(userText, session);
  if (!session || route.shouldStartSession) {
    session = (await apiJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify(
        desktopSessionPayload({
          title: userText,
          projectMode: route.projectMode,
          projectName: route.projectName,
          workspaceDir: route.workspaceDir,
        }),
      ),
    })).session;
  }
  const workspaceDir = session.workspaceDir || route.workspaceDir || repoRoot;
  const projectMode = session.projectMode || route.projectMode || "existing_project";
  const projectName = session.projectName || route.projectName || currentProjectName;

  const knownMessages = Array.isArray(messages) && messages.length
    ? messages
    : (session.messages || []).filter((message) => ["user", "assistant", "system"].includes(message.role));
  const nextMessages = messagesWithLatestUserMessage(knownMessages, userText);

  await apiJson(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      role: "user",
      content: userText,
      source: "desktop_app",
      route: "codex_pilot",
    }),
  });

  sender.send("assistant:event", { type: "status", text: "Codex working...", session });

  const response = await fetch(`${appUrl.replace(/\/$/, "")}/api/codex/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: nextMessages,
      systemPrompt:
        "You are Codex controlled through Codexa, a tiny Mac wrapper. Do the requested coding/system work through OpenClaw/Codex, keep the user-facing response concise, and mirror meaningful work into Codex Desktop.",
      client: {
        user_id: "desktop_user",
        user_name: osUserName(),
        session_id: session.id,
        session_title: session.title,
        project_name: projectName,
        project_mode: projectMode,
        workspace_dir: workspaceDir,
        route: "desktop_app_codex_wrapper",
        control_provider: "openclaw",
      },
      controlProvider: "openclaw",
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(body || `Codex returned ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let lastMeta = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const event of parseSseEvents(parts.join("\n\n"))) {
      if (event.type === "token" && event.data.text) {
        assistantText += event.data.text;
        sender.send("assistant:event", { type: "token", text: event.data.text, session });
      }
      if (event.type === "warning" || event.type === "error") {
        sender.send("assistant:event", { type: "status", text: event.data.message || event.type, session });
      }
      if (event.type === "meta") {
        lastMeta = event.data;
        if (event.data.provider === "codex_activity_mirror" || event.data.provider === "codex_app_chat_registration") {
          sender.send("assistant:event", { type: "status", text: "Mirrored to Codex Desktop.", session, meta: event.data });
        }
      }
    }
  }

  if (buffer.trim()) {
    for (const event of parseSseEvents(buffer)) {
      if (event.type === "token" && event.data.text) assistantText += event.data.text;
    }
  }

  if (assistantText.trim()) {
    await apiJson(`/api/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        role: "assistant",
        content: assistantText.trim(),
        source: "desktop_app",
        route: "codex_pilot",
      }),
    });
  }

  const refreshed = (await apiJson(`/api/sessions/${encodeURIComponent(session.id)}`)).session;
  sender.send("assistant:event", { type: "done", text: assistantText.trim(), session: refreshed, meta: lastMeta });
  return { session: refreshed, text: assistantText.trim(), meta: lastMeta };
}

function runSync(command, args, options = {}) {
  try {
    const result = require("node:child_process").spawnSync(command, args, {
      cwd: options.cwd || repoRoot,
      encoding: "utf8",
      timeout: options.timeout || 3500,
      maxBuffer: options.maxBuffer || 1024 * 512,
    });
    return {
      ok: result.status === 0,
      stdout: String(result.stdout || "").trim(),
      stderr: String(result.stderr || "").trim(),
      status: result.status,
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), status: 1 };
  }
}

function parseDf(stdout) {
  const line = stdout.split("\n").filter(Boolean)[1] || "";
  const parts = line.trim().split(/\s+/);
  return parts.length >= 9
    ? { size: parts[1], used: parts[2], available: parts[3], capacity: parts[4], mount: parts.slice(8).join(" ") }
    : null;
}

async function collectSystemStatus() {
  const os = require("node:os");
  const uptimeSeconds = Math.round(os.uptime());
  const df = runSync("df", ["-H", "/"]);
  const frontmost = runSync("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
  const battery = runSync("pmset", ["-g", "batt"]);
  const top = runSync("bash", ["-lc", "ps -Ao %cpu,%mem,comm -r | head -n 6"]);
  const git = runSync("git", ["status", "--short"], { cwd: repoRoot });

  let api = null;
  let codex = null;
  try {
    api = await apiJson("/api/status");
    codex = await apiJson("/api/codex/status");
  } catch (error) {
    api = { error: error instanceof Error ? error.message : String(error) };
  }

  return {
    generatedAt: new Date().toISOString(),
    machine: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      uptimeSeconds,
      uptime: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
      loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
      memory: {
        totalGb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
        freeGb: Number((os.freemem() / 1024 ** 3).toFixed(2)),
      },
      disk: df.ok ? parseDf(df.stdout) : null,
      battery: battery.stdout || battery.stderr,
      frontmostApp: frontmost.stdout || null,
      topProcesses: top.stdout.split("\n").slice(1).map((line) => line.trim()).filter(Boolean),
    },
    repo: {
      path: repoRoot,
      dirtyFiles: git.ok && git.stdout ? git.stdout.split("\n").length : 0,
      status: git.stdout || "clean",
    },
    services: {
      apiPort: appPort,
      sttPort,
      api,
      codex,
      managed: managedProcesses.map(({ name, child }) => ({
        name,
        pid: child.pid,
        running: child.exitCode === null,
      })),
    },
  };
}

async function linkCodexDesktopChat() {
  await ensureNodeApiService();
  const codexStatus = await apiJson("/api/codex/status");
  const command = codexStatus?.appChatRegistration?.command || codexStatus?.command;
  if (!command || !fs.existsSync(command)) {
    return {
      ok: false,
      message: "Codex unavailable",
      command: command || null,
      workspace: repoRoot,
    };
  }

  const message = [
    "Codexa wrapper link check.",
    "",
    `Workspace: ${repoRoot}`,
    "This message links Codexa to the existing Codex project chat.",
    "Do not modify files. Reply with a concise confirmation.",
  ].join("\n");
  const result = runSync(command, ["debug", "app-server", "send-message-v2", message], {
    cwd: repoRoot,
    timeout: CODEX_LINK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return {
    ok: result.ok,
    message: result.ok ? "Codex linked" : (result.stderr || "Codex link failed"),
    command,
    workspace: repoRoot,
  };
}

function spawnManaged(name, command, args, env = {}) {
  ensureTmpDir();
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(appPort),
      WHISPERX_URL: process.env.WHISPERX_URL || `http://127.0.0.1:${sttPort}`,
      SPEAKER_GUARD_URL: process.env.SPEAKER_GUARD_URL || `http://127.0.0.1:${sttPort}`,
      SPEECH_FLOW_URL: process.env.SPEECH_FLOW_URL || `http://127.0.0.1:${sttPort}`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => appendLog(name, chunk.toString()));
  child.stderr.on("data", (chunk) => appendLog(name, chunk.toString()));
  child.on("exit", (code, signal) => appendLog(name, `\n[exit code=${code} signal=${signal}]\n`));
  managedProcesses.push({ name, child });
  return child;
}

function pythonCommand() {
  const venvPython = path.join(repoRoot, ".venv-whisperx", "bin", "python");
  if (fs.existsSync(venvPython)) return venvPython;
  return process.env.PYTHON || "python3.12";
}

async function ensurePythonSttService() {
  if (await isPortOpen(sttPort)) {
    appendLog("stt", `[desktop] Reusing existing Python STT service on ${sttPort}\n`);
    return;
  }

  spawnManaged("stt", pythonCommand(), [
    path.join(repoRoot, "services", "whisperx_adapter.py"),
    "--port",
    String(sttPort),
  ]);
  await waitForHttp(`http://127.0.0.1:${sttPort}/health`);
}

async function ensureNodeApiService() {
  if (await isPortOpen(appPort)) {
    appendLog("api", `[desktop] Reusing existing coding assistant API on ${appPort}\n`);
    return;
  }

  spawnManaged("api", process.execPath, [path.join(repoRoot, "server.mjs")]);
  await waitForHttp(`${appUrl.replace(/\/$/, "")}/api/providers/health`);
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Codexa",
      submenu: [
        {
          label: "Codexa",
          accelerator: "CmdOrCtrl+1",
          click: () => mainWindow?.loadFile(desktopAppPath),
        },
        {
          label: "Open Codex",
          click: () => shell.openPath("/Applications/Codex.app"),
        },
        {
          label: "Web Console",
          accelerator: "CmdOrCtrl+2",
          click: () => mainWindow?.loadURL(appUrl),
        },
        {
          label: "Test Dashboard",
          click: () => mainWindow?.loadURL(dashboardUrl),
        },
        {
          label: "Provider Health JSON",
          click: () => mainWindow?.loadURL(`${appUrl.replace(/\/$/, "")}/api/providers/health`),
        },
        { type: "separator" },
        {
          label: "Open Logs Folder",
          click: () => shell.openPath(tmpDir),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 560,
    minHeight: 520,
    title: "Codexa",
    backgroundColor: "#0b0b0c",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const session = mainWindow.webContents.session;
  await session.clearCache().catch(() => {});
  await session.clearStorageData({ storages: ["serviceworkers", "cachestorage"] }).catch(() => {});
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  session.setPermissionCheckHandler((_webContents, permission) => permission === "media");

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openTrustedExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedNavigationUrl(url)) event.preventDefault();
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", () => {
    if (process.platform === "darwin" && !isQuitting) {
      mainWindow = null;
    }
  });

  await mainWindow.loadFile(desktopAppPath);
}

function setupIpcHandlers() {
  ipcMain.handle("assistant:enable", async () => {
    await ensureNodeApiService();
    const [status, codexStatus, sessions] = await Promise.all([
      apiJson("/api/status"),
      apiJson("/api/codex/status"),
      apiJson("/api/sessions"),
    ]);
    return {
      enabled: true,
      status,
      codexStatus,
      sessions: filterDesktopSessions(sessions.sessions || []),
      projects: [currentProjectName],
      currentProject: currentProjectName,
      workspace: repoRoot,
    };
  });

  ipcMain.handle("assistant:list-sessions", async () => {
    const sessions = await apiJson("/api/sessions");
    return {
      ...sessions,
      sessions: filterDesktopSessions(sessions.sessions || []),
      projects: [currentProjectName],
      currentProject: currentProjectName,
      workspace: repoRoot,
    };
  });

  ipcMain.handle("assistant:load-session", async (_event, sessionId) => {
    if (!sessionId) return null;
    return apiJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
  });

  ipcMain.handle("assistant:new-session", async (_event, input = {}) => {
    return apiJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify(desktopSessionPayload(input)),
    });
  });

  ipcMain.handle("assistant:send", async (event, input = {}) => {
    return streamCodexTurn(event.sender, input);
  });

  ipcMain.handle("assistant:system-status", async () => collectSystemStatus());

  ipcMain.handle("assistant:link-codex", async () => linkCodexDesktopChat());

  ipcMain.handle("assistant:open-permission", async (_event, key) => {
    const url = permissionUrls[key] || permissionUrls.accessibility;
    return shell.openExternal(url);
  });

  ipcMain.handle("assistant:open-codex", async () => shell.openPath("/Applications/Codex.app"));

  ipcMain.handle("assistant:open-logs", async () => {
    ensureTmpDir();
    return shell.openPath(tmpDir);
  });
}

function stopManagedProcesses() {
  for (const { name, child } of managedProcesses) {
    if (child.killed || child.exitCode !== null) continue;
    appendLog(name, "\n[desktop] stopping managed process\n");
    child.kill("SIGTERM");
  }
}

app.setName("Codexa");

app.whenReady().then(async () => {
  setupIpcHandlers();
  buildMenu();
  try {
    if (enableVoiceRuntime) await ensurePythonSttService();
    await ensureNodeApiService();
    await createWindow();
  } catch (error) {
    dialog.showErrorBox(
      "Codexa failed to start",
      `${error instanceof Error ? error.message : String(error)}\n\nCheck tmp/desktop-api.log and tmp/desktop-stt.log.`,
    );
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) createWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  stopManagedProcesses();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
