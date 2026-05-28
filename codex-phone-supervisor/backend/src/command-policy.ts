import path from "node:path";
import type { CommandRiskLevel } from "./types.js";

export type CommandPolicyDecision = {
  disposition: "allowed" | "requires_approval" | "blocked";
  risk_level: CommandRiskLevel;
  reason: string;
};

function normalize(command: string) {
  return command.trim().replace(/\s+/g, " ");
}

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shellSegments(command: string) {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellTokens(segment: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function tokenBaseName(token: string) {
  return path.posix.basename(token.replace(/\\/g, "/")).toLowerCase();
}

function commandTokenIndex(tokens: string[]) {
  let index = 0;
  while (index < tokens.length && /^[A-Z_][A-Z0-9_]*=/i.test(tokens[index])) index += 1;
  while (["sudo", "command", "time"].includes(tokenBaseName(tokens[index] ?? ""))) {
    index += 1;
    while (tokens[index]?.startsWith("-")) index += 1;
  }
  return index;
}

function sedFileOperands(args: string[]) {
  const operands: string[] = [];
  let scriptSeen = false;
  let endOfOptions = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (arg === "-e" || arg === "-f")) {
      index += 1;
      scriptSeen = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) continue;
    if (!scriptSeen) {
      scriptSeen = true;
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

function readFileOperands(commandName: string, args: string[]) {
  if (commandName === "sed") return sedFileOperands(args);
  const operands: string[] = [];
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) continue;
    operands.push(arg);
  }
  return operands;
}

function isSensitiveReadTarget(token: string) {
  const cleaned = token.trim().replace(/,+$/, "");
  if (!cleaned || cleaned === "-") return false;
  const normalizedPath = cleaned.replace(/\\/g, "/").toLowerCase();
  const base = normalizedPath.split("/").filter(Boolean).at(-1) ?? normalizedPath;

  if (/^\.env(?:$|\.)/.test(base)) return true;
  if (/(^|\/)(?:\.codex\/auth(?:\.json)?|codex\/auth(?:\.json)?|\.config\/gcloud\/application_default_credentials\.json)$/.test(normalizedPath)) {
    return true;
  }
  if (/(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|\.netrc|\.npmrc|\.pypirc)$/.test(normalizedPath)) return true;
  if (/(^|\/)(?:credentials|auth|token|secret)$/.test(normalizedPath)) return true;
  return /(^|\/)[^/]*(?:application_default_credentials|credentials?|auth|tokens?|secrets?|api[_-]?key|client[_-]?secret|service[_-]?account|private[_-]?key)[^/]*\.(?:json|toml|ya?ml|env|ini|conf|txt|pem|key|p12|p8)$/.test(normalizedPath);
}

function isSensitiveFileRead(command: string) {
  const readCommands = new Set(["cat", "less", "more", "head", "tail", "sed"]);
  for (const segment of shellSegments(command)) {
    const tokens = shellTokens(segment);
    const commandIndex = commandTokenIndex(tokens);
    const commandName = tokenBaseName(tokens[commandIndex] ?? "");
    if (!readCommands.has(commandName)) continue;
    if (readFileOperands(commandName, tokens.slice(commandIndex + 1)).some(isSensitiveReadTarget)) return true;
  }
  return false;
}

function dockerRunArgs(command: string) {
  const runs: string[][] = [];
  for (const segment of shellSegments(command)) {
    const tokens = shellTokens(segment);
    if (tokenBaseName(tokens[0] ?? "") !== "docker") continue;
    const runIndex = tokens.findIndex((token, index) => index > 0 && token === "run");
    if (runIndex !== -1) runs.push(tokens.slice(runIndex + 1));
  }
  return runs;
}

function parseVolumeSource(spec: string) {
  if (!spec || spec.includes("=")) return null;
  const [source, target] = spec.split(":");
  return source ? { source, target: target || "" } : null;
}

function parseMountSource(spec: string) {
  const parts = new Map<string, string>();
  for (const part of spec.split(",")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    parts.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
  }
  const source = parts.get("source") ?? parts.get("src");
  const target = parts.get("target") ?? parts.get("dst") ?? parts.get("destination") ?? "";
  return source ? { source, target } : null;
}

function dockerMounts(args: string[]) {
  const mounts: Array<{ source: string; target: string }> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-v" || arg === "--volume") {
      const parsed = parseVolumeSource(args[index + 1] ?? "");
      if (parsed) mounts.push(parsed);
      index += 1;
      continue;
    }
    if (arg.startsWith("--volume=")) {
      const parsed = parseVolumeSource(arg.slice("--volume=".length));
      if (parsed) mounts.push(parsed);
      continue;
    }
    if (arg.startsWith("-v") && arg.length > 2) {
      const parsed = parseVolumeSource(arg.slice(2));
      if (parsed) mounts.push(parsed);
      continue;
    }
    if (arg === "--mount") {
      const parsed = parseMountSource(args[index + 1] ?? "");
      if (parsed) mounts.push(parsed);
      index += 1;
      continue;
    }
    if (arg.startsWith("--mount=")) {
      const parsed = parseMountSource(arg.slice("--mount=".length));
      if (parsed) mounts.push(parsed);
    }
  }
  return mounts;
}

function mountHostPath(source: string, cwd: string) {
  if (source === "~" || source.startsWith("~/") || source.startsWith("$HOME")) return source;
  if (path.isAbsolute(source)) return path.resolve(source);
  if (source.startsWith(".") || source.includes("/")) return path.resolve(cwd, source);
  return null;
}

function includesDockerSocket(value: string) {
  return /(^|\/)(?:var\/run|run)\/docker\.sock$/i.test(value.replace(/\\/g, "/"));
}

function classifyDockerRun(command: string, cwd: string, workspacePath: string, approvedByUser: boolean): CommandPolicyDecision | null {
  for (const args of dockerRunArgs(command)) {
    if (args.some((arg) => arg === "--privileged" || /^--privileged=(?:1|true|yes)$/i.test(arg))) {
      return {
        disposition: "blocked",
        risk_level: "blocked",
        reason: "Privileged Docker containers are blocked.",
      };
    }

    for (const mount of dockerMounts(args)) {
      if (includesDockerSocket(mount.source) || includesDockerSocket(mount.target)) {
        return {
          disposition: "blocked",
          risk_level: "blocked",
          reason: "Mounting the Docker socket is blocked.",
        };
      }
      const hostPath = mountHostPath(mount.source, cwd);
      if (hostPath === path.parse(path.resolve(cwd)).root) {
        return {
          disposition: "blocked",
          risk_level: "blocked",
          reason: "Mounting the host root filesystem into Docker is blocked.",
        };
      }
      if (hostPath && (hostPath.startsWith("~") || hostPath.startsWith("$HOME") || !isWithinDirectory(path.resolve(hostPath), path.resolve(workspacePath)))) {
        return approvedByUser
          ? {
              disposition: "allowed",
              risk_level: "high",
              reason: "Host filesystem Docker mount was explicitly approved by the user.",
            }
          : {
              disposition: "requires_approval",
              risk_level: "high",
              reason: "Docker host filesystem mounts outside the workspace require approval.",
            };
      }
    }
  }
  return null;
}

export function classifyCommand(command: string, cwd: string, workspacePath: string, approvedByUser = false): CommandPolicyDecision {
  const normalized = normalize(command);
  const lowered = normalized.toLowerCase();
  const resolvedCwd = path.resolve(cwd);
  const resolvedWorkspace = path.resolve(workspacePath);

  if (!isWithinDirectory(resolvedCwd, resolvedWorkspace) && !approvedByUser) {
    return {
      disposition: "requires_approval",
      risk_level: "high",
      reason: "Commands outside the assigned workspace require approval.",
    };
  }

  if (
    /^(printenv|env|set)(\s|$)/i.test(normalized) ||
    isSensitiveFileRead(normalized)
  ) {
    return {
      disposition: "blocked",
      risk_level: "blocked",
      reason: "The command could expose secrets or credential files.",
    };
  }

  const dockerDecision = classifyDockerRun(normalized, resolvedCwd, resolvedWorkspace, approvedByUser);
  if (dockerDecision) return dockerDecision;

  const approvalRules: Array<{ pattern: RegExp; risk: CommandRiskLevel; reason: string }> = [
    { pattern: /\brm\s+-rf\b|\bgcloud\b[\s\S]*\bdelete\b|\bterraform\s+destroy\b/i, risk: "high", reason: "Destructive delete operations require approval." },
    { pattern: /\bgcloud\b[\s\S]*\b(add-iam-policy-binding|set-iam-policy|roles\/owner|roles\/editor)\b/i, risk: "high", reason: "Broad IAM mutations require approval." },
    { pattern: /\bgcloud\s+run\s+deploy\b[\s\S]*(--allow-unauthenticated|--ingress\s+all)/i, risk: "high", reason: "Public unauthenticated production exposure requires approval." },
    { pattern: /\b(gcloud\s+container|kubectl|helm)\b/i, risk: "high", reason: "Kubernetes or GKE creation is out of scope for v1 without approval." },
    { pattern: /\b(A100|H100|L4|T4|gpu|accelerator)\b/i, risk: "high", reason: "GPU resources require explicit approval." },
    { pattern: /\bgit\s+push\b[\s\S]*\b(main|master)\b/i, risk: "high", reason: "Pushing directly to the primary branch requires approval." },
    { pattern: /\b(secret|secrets)\b[\s\S]*\b(delete|destroy|versions\s+destroy|rotate)\b/i, risk: "high", reason: "Secret deletion or rotation requires approval." },
    { pattern: /^(npm|pnpm|yarn)\s+(install|add)\b/i, risk: "medium", reason: "Installing dependencies can mutate the workspace and requires approval." },
  ];

  for (const rule of approvalRules) {
    if (rule.pattern.test(normalized) && !approvedByUser) {
      return { disposition: "requires_approval", risk_level: rule.risk, reason: rule.reason };
    }
  }

  const safeRules: RegExp[] = [
    /^pwd$/i,
    /^ls(\s|$)/i,
    /^(cat|head|tail|sed)\s/i,
    /^git\s+(status|diff|log|show|rev-parse|branch)\b/i,
    /^git\s+init\b/i,
    /^git\s+config\s+(user\.name|user\.email)\b/i,
    /^git\s+add\b/i,
    /^git\s+commit\b/i,
    /^git\s+worktree\s+(add|list)\b/i,
    /^git\s+checkout\s+-b\b/i,
    /^(npm|pnpm|yarn)\s+(test|run\s+(build|test|typecheck|lint)|build|test|lint)\b/i,
    /^python\s+-m\s+pytest\b/i,
    /^node\s+--check\b/i,
    /^node\s+--version$/i,
    /^node\s+\/state\/runtime\/materialize-codex-files\.mjs\b/i,
    /^docker\s+(build|run)\b/i,
    /^codex\s+exec\b/i,
    /^gcloud\s+[\w-]+\s+(list|describe|get-iam-policy)\b/i,
    /^gcloud\s+(services\s+enable|artifacts\s+repositories\s+create|run\s+deploy|compute\s+instances\s+create|pubsub\s+(topics|subscriptions)\s+create|storage\s+(buckets\s+create|cp)|firestore\s+databases\s+create|tasks\s+queues\s+create)\b/i,
  ];

  if (safeRules.some((rule) => rule.test(normalized))) {
    return { disposition: "allowed", risk_level: "low", reason: "Command matches the approved workspace command policy." };
  }

  if (approvedByUser) {
    return { disposition: "allowed", risk_level: "medium", reason: "Command was explicitly approved by the user." };
  }

  return {
    disposition: "requires_approval",
    risk_level: "medium",
    reason: "Command is not in the low-risk allowlist.",
  };
}
