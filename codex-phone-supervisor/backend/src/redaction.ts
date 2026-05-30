import type { CommandEventRecord } from "./types.js";

const REDACTED = "[redacted]";

const sensitiveObjectKey =
  /^(?:access_token|refresh_token|id_token|auth_token|api_key|apikey|apiKey|client_secret|password|secret|token|credential|credentials|cookie|session_token|private_key)$/i;
const sensitiveAssignment =
  /\b([A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|ID_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|SECRET|CREDENTIALS?|COOKIE|SESSION_TOKEN)[A-Z0-9_]*\s*=\s*)([^\s"'\\]+)/gi;
const sensitiveBareAssignment =
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token|credential|credentials|cookie|session[_-]?token)\s*=\s*)([^\s"'\\]+)/gi;
const sensitiveHeader = /\b(authorization\s*:\s*bearer\s+)([^\s"'\\]+)/gi;
const sensitiveJson =
  /(["']?(?:access_token|refresh_token|id_token|api[_-]?key|apiKey|client_secret|password|secret|token|credential|cookie)["']?\s*[:=]\s*)(["'])([^"']+)(["'])/gi;
const openAiKey = /\bsk-(?:proj|svcacct|admin)?-[A-Za-z0-9_-]{8,}\b/g;
const genericOpenAiKey = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{16,}\b/g;
const githubToken = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g;
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const localCodexVmHomePath = /(?:\/[^\s"'\\]+)*\/?\.codex-vm-home(?:\/[^\s"'\\]*)?/g;
const workerCodexAuthFilePath = /\/codex-home\/(?:auth\.json|config\.toml|version\.json|models_cache\.json)(?:[^\s"'\\]*)?/g;

export function redactSensitiveText(value: string) {
  if (!value) return value;
  return value
    .replace(sensitiveAssignment, `$1${REDACTED}`)
    .replace(sensitiveBareAssignment, `$1${REDACTED}`)
    .replace(sensitiveHeader, `$1${REDACTED}`)
    .replace(sensitiveJson, `$1$2${REDACTED}$4`)
    .replace(openAiKey, REDACTED)
    .replace(genericOpenAiKey, REDACTED)
    .replace(githubToken, REDACTED)
    .replace(jwt, REDACTED)
    .replace(localCodexVmHomePath, `.codex-vm-home/${REDACTED}`)
    .replace(workerCodexAuthFilePath, `/codex-home/${REDACTED}`);
}

export function redactSensitiveJson<T>(value: T): T {
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveJson(item)) as T;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = sensitiveObjectKey.test(key) ? REDACTED : redactSensitiveJson(item);
  }
  return redacted as T;
}

export function redactCommandEvent(event: CommandEventRecord): CommandEventRecord {
  return redactSensitiveJson({
    ...event,
    command: redactSensitiveText(event.command),
    stdout_preview: redactSensitiveText(event.stdout_preview),
    stderr_preview: redactSensitiveText(event.stderr_preview),
    summary: redactSensitiveText(event.summary),
  });
}
