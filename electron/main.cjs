const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

app.setName("Codexa");
app.setPath("userData", path.join(app.getPath("appData"), "Codexa"));

const host = "127.0.0.1";
let port = Number(process.env.CODEX_DESKTOP_PORT || "4317");
let backendUrl = `http://${host}:${port}`;

let mainWindow = null;
let backendStarted = false;

function appRoot() {
  return path.resolve(__dirname, "..");
}

function unpackedRoot(root) {
  return app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked") : root;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function canListen(candidatePort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(candidatePort, host);
  });
}

async function choosePort(preferredPort) {
  for (let candidate = preferredPort; candidate < preferredPort + 50; candidate += 1) {
    if (await canListen(candidate)) return candidate;
  }
  throw new Error(`No available loopback port found from ${preferredPort} to ${preferredPort + 49}.`);
}

function macCodexTarget() {
  if (process.arch === "arm64") {
    return {
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
    };
  }
  return {
    packageName: "@openai/codex-darwin-x64",
    triple: "x86_64-apple-darwin",
  };
}

function resolveBundledCodex(root) {
  const { packageName, triple } = macCodexTarget();
  const roots = [unpackedRoot(root), root];
  for (const candidateRoot of roots) {
    const packageRoot = path.join(candidateRoot, "node_modules", packageName);
    const binary = path.join(packageRoot, "vendor", triple, "bin", "codex");
    if (fs.existsSync(binary)) {
      return {
        command: binary,
        pathDir: path.join(packageRoot, "vendor", triple, "codex-path"),
        managedPackageRoot: path.join(candidateRoot, "node_modules", "@openai", "codex"),
      };
    }
  }
  return {
    command: "codex",
    pathDir: "",
    managedPackageRoot: "",
  };
}

function configureSupervisorEnvironment() {
  const root = appRoot();
  const codex = resolveBundledCodex(root);
  const userData = app.getPath("userData");
  const workspaceRoot = ensureDir(process.env.CODEX_DESKTOP_WORKSPACE_ROOT || path.join(os.homedir(), "Codexa Projects"));
  const codexHome = ensureDir(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const storeDir = ensureDir(path.join(userData, "supervisor-store"));
  const frontendDistDir = path.join(root, "frontend", "dist");

  if (codex.pathDir && fs.existsSync(codex.pathDir)) {
    process.env.PATH = `${codex.pathDir}${path.delimiter}${process.env.PATH || ""}`;
  }
  if (codex.managedPackageRoot) {
    process.env.CODEX_MANAGED_BY_NPM = "1";
    process.env.CODEX_MANAGED_PACKAGE_ROOT = codex.managedPackageRoot;
  }

  Object.assign(process.env, {
    CODEX_PHONE_SUPERVISOR_SKIP_ENV_FILES: "1",
    CODEX_PHONE_SUPERVISOR_HOST: host,
    CODEX_PHONE_SUPERVISOR_PORT: String(port),
    CODEX_PHONE_SUPERVISOR_ALLOWED_ORIGINS: `${backendUrl},http://localhost:${port}`,
    CODEX_PHONE_SUPERVISOR_CODEX_COMMAND: codex.command,
    CODEX_PHONE_SUPERVISOR_CODEX_HOME: codexHome,
    CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH: workspaceRoot,
    CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT: workspaceRoot,
    CODEX_PHONE_SUPERVISOR_PROJECT_ROOTS: workspaceRoot,
    CODEX_PHONE_SUPERVISOR_STORE_DIR: storeDir,
    CODEX_PHONE_SUPERVISOR_FRONTEND_DIST_DIR: frontendDistDir,
    CODEX_PHONE_SUPERVISOR_LOCK_TIMEOUT_MS: "5000",
    CODEX_PHONE_SUPERVISOR_LOCK_RETRY_MS: "25",
    CODEX_PHONE_SUPERVISOR_TEST_MODE: "0",
    CODEX_PHONE_SUPERVISOR_PUBLIC_BASE_URL: "",
    CODEX_PHONE_SUPERVISOR_TERMINAL_ENABLED: "0",
    CODEX_PHONE_SUPERVISOR_DESKTOP_TERMINAL_ENABLED: "0",
    TWILIO_VALIDATE_SIGNATURES: "0",
    TWILIO_SMS_ENABLED: "0",
    TWILIO_VOICE_ENABLED: "0",
    SUPERVISOR_MODEL_PROVIDER: "codex_cli",
    WORKER_MODE: "codex_session_local",
    DEFAULT_WORKER_MODE: "codex_session_local",
    HEAD_DEVELOPER_STATE_STORE: "file",
    CODEX_PHONE_SUPERVISOR_GITHUB_REPO_CREATE: "never",
  });

  return {
    apiBase: backendUrl,
    appVersion: app.getVersion(),
    codexCommand: codex.command,
    codexHome,
    isDesktop: true,
    supervisorUserId: `desktop-${os.userInfo().username || "user"}`,
    workspacePath: workspaceRoot,
  };
}

async function startBackend() {
  if (backendStarted) return;
  backendStarted = true;
  const entry = path.join(appRoot(), "dist", "backend", "codex-phone-supervisor", "backend", "src", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`Missing backend build at ${entry}. Run npm run build:desktop first.`);
  }
  await import(pathToFileURL(entry).href);
}

function waitForBackend(timeoutMs = 15000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Backend did not start at ${backendUrl} within ${timeoutMs}ms.`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function createWindow(rendererConfig) {
  const encodedConfig = Buffer.from(JSON.stringify(rendererConfig), "utf8").toString("base64");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: "Codexa",
    webPreferences: {
      additionalArguments: [`--codexa-config=${encodedConfig}`],
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(backendUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.loadURL(`${backendUrl}/#builder`);
}

ipcMain.handle("codexa:open-external", async (_event, url) => {
  const target = String(url || "");
  if (!/^https?:\/\//i.test(target)) return false;
  await shell.openExternal(target);
  return true;
});

app.whenReady().then(async () => {
  try {
    port = await choosePort(port);
    backendUrl = `http://${host}:${port}`;
    const rendererConfig = configureSupervisorEnvironment();
    await startBackend();
    await waitForBackend();
    createWindow(rendererConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Codexa failed to start", message);
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow) mainWindow.show();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
