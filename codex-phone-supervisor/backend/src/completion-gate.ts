import type { CommandEventRecord, TaskGraphNode, TaskGraphNodeCompletionGate } from "./types.js";

const DEFAULT_DOC_PREFIXES = [".head-developer/", "docs/"];
const DEFAULT_DOC_FILES = new Set(["README.md", "CHANGELOG.md"]);

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function eventText(event: CommandEventRecord) {
  return `${event.summary}\n${event.stdout_preview}\n${event.stderr_preview}`;
}

function extractChangedFiles(events: CommandEventRecord[]) {
  return unique(events.flatMap((event) => {
    const output = eventText(event);
    const statusMatches = output.match(/(?:modified:|created:|deleted:)\s+([^\n,]+)/gi) ?? [];
    const shortStatusMatches = [...output.matchAll(/^\s*(?:\?\?|[AMDRC?!]{1,2})\s+(.+)$/gm)].map((match) => match[1].trim());
    const jsonMatches = [...output.matchAll(/"files_modified"\s*:\s*\[([^\]]*)\]/g)].flatMap((match) => {
      try {
        return JSON.parse(`[${match[1]}]`) as string[];
      } catch {
        return [];
      }
    });
    return [
      ...statusMatches.map((match) => match.replace(/^(modified:|created:|deleted:)\s+/i, "").trim()),
      ...shortStatusMatches,
      ...jsonMatches,
    ].map(normalizePath);
  }));
}

function wildcardToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(filePath: string, pattern: string) {
  const file = normalizePath(filePath).toLowerCase();
  const expected = normalizePath(pattern).toLowerCase();
  if (!expected) return false;
  if (expected.includes("*")) return wildcardToRegExp(expected).test(file);
  if (expected.endsWith("/")) return file.startsWith(expected);
  if (expected.includes("/") || /\.[a-z0-9]+$/i.test(expected)) return file === expected || file.endsWith(`/${expected}`);
  return file.includes(expected);
}

function isDocFile(filePath: string, node: TaskGraphNode) {
  const normalized = normalizePath(filePath);
  return DEFAULT_DOC_FILES.has(normalized)
    || DEFAULT_DOC_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || (node.allowed_doc_files ?? []).some((pattern) => matchesPattern(normalized, pattern));
}

function isAppOutputNode(node: TaskGraphNode) {
  const contract = node.output_contract;
  if (contract?.docs_only_is_insufficient === false) return false;
  const required = unique([...(contract?.required_app_files ?? []), ...(node.required_app_files ?? [])]);
  const hasRequiredAppFile = required.some((file) => !isDocFile(file, node));
  const nodeText = `${node.title} ${node.goal}`;
  if (!hasRequiredAppFile && /project setup|documentation|docs|architecture|handoff|validation|brief|runbook/i.test(nodeText)) {
    return false;
  }
  return Boolean(
    contract?.docs_only_is_insufficient
      || node.required_app_files?.length
      || node.expected_user_visible_output?.length
      || /landing|screen|dashboard|settings|billing|page|app|ui|website|site/i.test(nodeText),
  );
}

function commandWasRun(events: CommandEventRecord[], expected: string) {
  const normalized = normalizeValidationCommand(expected).toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return events.some((event) => event.exit_code === 0 && event.command.toLowerCase().replace(/\s+/g, " ").includes(normalized));
}

function normalizeValidationCommand(command: string) {
  return command
    .replace(/\s+when\b.*$/i, "")
    .trim();
}

function isExecutableValidationCommand(command: string) {
  const normalized = normalizeValidationCommand(command);
  if (!normalized) return false;
  if (/^(verify|ensure|confirm|check that|inspect|open|manual|look for)\b/i.test(normalized)) return false;
  return /^(npm|pnpm|yarn|node|npx|bun|deno|python|python3|pytest|vitest|playwright|tsc|eslint|find|test|grep|rg|curl|git|docker)\b/i.test(normalized)
    || /^[\w./-]+\s+(--?[\w-]+|\S+\.(?:js|ts|tsx|jsx|html|css|json|md)\b)/i.test(normalized);
}

export function evaluateTaskGraphNodeCompletion(input: {
  node: TaskGraphNode;
  commandEvents: CommandEventRecord[];
  now?: string;
}): TaskGraphNodeCompletionGate {
  const now = input.now ?? new Date().toISOString();
  const node = input.node;
  const events = input.commandEvents;
  const changedFiles = extractChangedFiles(events);
  const appFiles = changedFiles.filter((file) => !isDocFile(file, node));
  const docsOnly = changedFiles.length > 0 && appFiles.length === 0;
  const required = unique([...(node.output_contract?.required_app_files ?? []), ...(node.required_app_files ?? [])]);
  const validationCommands = unique([...(node.output_contract?.validation_commands ?? []), ...(node.validation_commands ?? [])])
    .filter(isExecutableValidationCommand)
    .map(normalizeValidationCommand);
  const validationCommandsRun = validationCommands.filter((command) => commandWasRun(events, command));
  const missingRequiredAppFiles = required.filter((pattern) => !appFiles.some((file) => matchesPattern(file, pattern)));
  const missingValidationCommands = validationCommands.filter((command) => !validationCommandsRun.includes(command));
  const appNode = isAppOutputNode(node);
  const reasons: string[] = [];

  if (!appNode) {
    return {
      status: "not_applicable",
      evaluated_at: now,
      reasons: ["Node is documentation/setup/review work and does not require app output."],
      changed_files: changedFiles,
      app_files: appFiles,
      docs_only: docsOnly,
      missing_required_app_files: [],
      validation_commands_run: validationCommandsRun,
      missing_validation_commands: [],
    };
  }

  if (!changedFiles.length) reasons.push("No changed files were reported by command events.");
  if (docsOnly) reasons.push("Only documentation files changed; docs-only output is insufficient for this app-building node.");
  if (!appFiles.length) reasons.push("No non-documentation app files were reported.");
  if (missingRequiredAppFiles.length) reasons.push(`Missing required app file evidence: ${missingRequiredAppFiles.join(", ")}.`);
  if (missingValidationCommands.length) reasons.push(`Missing required validation command evidence: ${missingValidationCommands.join(", ")}.`);

  return {
    status: reasons.length ? "failed" : "passed",
    evaluated_at: now,
    reasons,
    changed_files: changedFiles,
    app_files: appFiles,
    docs_only: docsOnly,
    missing_required_app_files: missingRequiredAppFiles,
    validation_commands_run: validationCommandsRun,
    missing_validation_commands: missingValidationCommands,
  };
}

export function completionGatePassed(result: TaskGraphNodeCompletionGate) {
  return result.status === "passed" || result.status === "not_applicable";
}
