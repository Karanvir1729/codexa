const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const tmpDir = path.join(repoRoot, "tmp");
const appPort = Number(process.env.PORT || 3000);
const sttPort = Number(process.env.WHISPERX_PORT || 9001);
const appUrl = process.env.AGENTIC_CODING_APP_URL || `http://localhost:${appPort}`;
const dashboardUrl = `${appUrl.replace(/\/$/, "")}/test-dashboard.html`;
const managedProcesses = [];

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
      label: "Coding Agent",
      submenu: [
        {
          label: "Voice App",
          accelerator: "CmdOrCtrl+1",
          click: () => mainWindow?.loadURL(appUrl),
        },
        {
          label: "Test Dashboard",
          accelerator: "CmdOrCtrl+2",
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 720,
    title: "Agentic Coding Assistant",
    backgroundColor: "#f6f7fb",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const session = mainWindow.webContents.session;
  session.clearCache().catch(() => {});
  session
    .clearStorageData({ storages: ["serviceworkers", "cachestorage"] })
    .catch(() => {});
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });
  session.setPermissionCheckHandler((_webContents, permission) => permission === "media");

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", () => {
    if (process.platform === "darwin" && !isQuitting) {
      mainWindow = null;
    }
  });

  mainWindow.loadURL(appUrl);
}

function stopManagedProcesses() {
  for (const { name, child } of managedProcesses) {
    if (child.killed || child.exitCode !== null) continue;
    appendLog(name, "\n[desktop] stopping managed process\n");
    child.kill("SIGTERM");
  }
}

app.setName("Agentic Coding Assistant");

app.whenReady().then(async () => {
  buildMenu();
  try {
    await ensurePythonSttService();
    await ensureNodeApiService();
    createWindow();
  } catch (error) {
    dialog.showErrorBox(
      "Agentic Coding Assistant failed to start",
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
