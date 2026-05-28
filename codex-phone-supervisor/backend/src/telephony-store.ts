import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { createSession } from "./session.js";
import { getSession, upsertSession } from "./store.js";

interface TelephonyPeer {
  session_id: string;
  source: "voice" | "sms";
  address: string;
  last_updated: string;
}

interface TelephonyState {
  peers: Record<string, TelephonyPeer>;
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockKey(value: string) {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function withPeerLock<T>(peerKey: string, action: () => T) {
  const lockPath = path.join(path.dirname(config.telephonyStorePath), `${lockKey(peerKey)}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { recursive: false });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - started > config.storeLockTimeoutMs) {
        throw new Error(`Timed out acquiring telephony session lock ${lockPath}`);
      }
      sleepSync(config.storeLockRetryMs);
    }
  }

  try {
    return action();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function readTelephonyStore(): TelephonyState {
  fs.mkdirSync(path.dirname(config.telephonyStorePath), { recursive: true });
  if (!fs.existsSync(config.telephonyStorePath)) return { peers: {} };
  try {
    return JSON.parse(fs.readFileSync(config.telephonyStorePath, "utf8")) as TelephonyState;
  } catch (error) {
    console.error(`Failed to read or parse telephony store at ${config.telephonyStorePath}`, error);
    throw error;
  }
}

function writeTelephonyStore(state: TelephonyState) {
  try {
    fs.mkdirSync(path.dirname(config.telephonyStorePath), { recursive: true });
    const tempPath = `${config.telephonyStorePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
    fs.renameSync(tempPath, config.telephonyStorePath);
  } catch (error) {
    console.error(`Failed to write telephony store at ${config.telephonyStorePath}`, error);
    throw error;
  }
}

export function ensureTelephonySession(peerKey: string, source: "voice" | "sms", address = "") {
  return withPeerLock(peerKey, () => {
    const state = readTelephonyStore();
    const existing = state.peers[peerKey];
    if (existing) {
      const session = getSession(existing.session_id);
      if (session) {
        existing.address = address || existing.address || "";
        existing.last_updated = new Date().toISOString();
        writeTelephonyStore(state);
        return session;
      }
    }

    const session = createSession(`${source} supervisor session`, config.defaultWorkspacePath);
    session.current_status = "idle";
    session.summary_text = "Phone supervisor session is ready.";
    upsertSession(session);
    state.peers[peerKey] = {
      session_id: session.session_id,
      source,
      address,
      last_updated: new Date().toISOString(),
    };
    writeTelephonyStore(state);
    return session;
  });
}

export function findTelephonyPeerForSession(sessionId: string) {
  const state = readTelephonyStore();
  return Object.values(state.peers).find((peer) => peer.session_id === sessionId) ?? null;
}
