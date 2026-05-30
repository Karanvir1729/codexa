import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

type CodexDeviceLoginStatus = "starting" | "pending" | "completed" | "failed" | "cancelled";

type CodexDeviceLogin = {
  login_id: string;
  status: CodexDeviceLoginStatus;
  verification_url: string;
  user_code: string;
  message: string;
  started_at: string;
  expires_at: string;
  completed_at: string | null;
  exit_code: number | null;
  process: ChildProcess | null;
};

const ansiPattern = /\u001b\[[0-9;]*m/g;
let activeDeviceLogin: CodexDeviceLogin | null = null;

function stripAnsi(value: string) {
  return value.replace(ansiPattern, "");
}

function codexEnv() {
  return {
    ...process.env,
    CODEX_HOME: config.codexHome,
  };
}

function publicDeviceLogin(login: CodexDeviceLogin) {
  return {
    login_id: login.login_id,
    status: login.status,
    verification_url: login.verification_url,
    user_code: login.user_code,
    message: login.message,
    started_at: login.started_at,
    expires_at: login.expires_at,
    completed_at: login.completed_at,
    exit_code: login.exit_code,
  };
}

function updateDeviceLoginFromOutput(login: CodexDeviceLogin, raw: string) {
  const text = stripAnsi(raw);
  login.message = `${login.message}\n${text}`.trim().slice(-4000);
  const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device\b/)?.[0];
  const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/)?.[0];
  if (url) login.verification_url = url;
  if (code) login.user_code = code;
  if (login.verification_url && login.user_code && login.status === "starting") {
    login.status = "pending";
  }
}

function runCodex(args: string[], timeoutMs: number) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(config.codexCommand, args, {
      env: codexEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += stripAnsi(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      output += stripAnsi(String(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.trim() });
    });
  });
}

export async function readCodexLoginStatus() {
  const result = await runCodex(["login", "status"], 8000).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 1, output: message };
  });
  const statusText = result.output || (result.code === 0 ? "Logged in." : "Not logged in.");
  return {
    logged_in: result.code === 0 && /logged in/i.test(statusText),
    status_text: statusText,
    codex_command: config.codexCommand,
    codex_home: config.codexHome,
  };
}

export function getCodexDeviceLogin(loginId?: string) {
  if (!activeDeviceLogin) return null;
  if (loginId && activeDeviceLogin.login_id !== loginId) return null;
  return publicDeviceLogin(activeDeviceLogin);
}

export function startCodexDeviceLogin() {
  if (activeDeviceLogin && ["starting", "pending"].includes(activeDeviceLogin.status)) {
    return publicDeviceLogin(activeDeviceLogin);
  }

  const now = Date.now();
  const login: CodexDeviceLogin = {
    login_id: randomUUID(),
    status: "starting",
    verification_url: "",
    user_code: "",
    message: "",
    started_at: new Date(now).toISOString(),
    expires_at: new Date(now + 15 * 60 * 1000).toISOString(),
    completed_at: null,
    exit_code: null,
    process: null,
  };
  activeDeviceLogin = login;

  const child = spawn(config.codexCommand, ["login", "--device-auth"], {
    env: codexEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  login.process = child;

  child.stdout.on("data", (chunk) => updateDeviceLoginFromOutput(login, String(chunk)));
  child.stderr.on("data", (chunk) => updateDeviceLoginFromOutput(login, String(chunk)));
  child.on("error", (error) => {
    login.status = "failed";
    login.completed_at = new Date().toISOString();
    login.message = `${login.message}\n${error.message}`.trim();
  });
  child.on("exit", (code) => {
    login.exit_code = code;
    login.completed_at = new Date().toISOString();
    login.process = null;
    if (login.status === "cancelled") return;
    login.status = code === 0 ? "completed" : "failed";
  });

  return publicDeviceLogin(login);
}

export function cancelCodexDeviceLogin(loginId: string) {
  if (!activeDeviceLogin || activeDeviceLogin.login_id !== loginId) return null;
  if (activeDeviceLogin.process) {
    activeDeviceLogin.status = "cancelled";
    activeDeviceLogin.completed_at = new Date().toISOString();
    activeDeviceLogin.process.kill("SIGTERM");
    activeDeviceLogin.process = null;
  }
  return publicDeviceLogin(activeDeviceLogin);
}
