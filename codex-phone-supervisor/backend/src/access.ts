import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AccessSummary } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prototypeRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(prototypeRoot, "..");

type AccessSummaryOptions = {
  repoRoot?: string;
  codexCommand?: string;
};

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 512 * 1024,
  });
}

function maybeGit(cwd: string, ...args: string[]) {
  const result = run("git", args, cwd);
  return result.status === 0 ? result.stdout.trim() : "";
}

function requireConfiguredValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to build the Codex access summary.`);
  return value;
}

function resolveFromRepo(value: string, root: string) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

export function getCodexAccessSummary(workspacePath?: string, options: AccessSummaryOptions = {}): AccessSummary {
  const effectiveRepoRoot = options.repoRoot ?? repoRoot;
  const effectiveWorkspacePath = workspacePath?.trim()
    ? workspacePath
    : resolveFromRepo(requireConfiguredValue("CODEX_PHONE_SUPERVISOR_WORKSPACE_PATH"), effectiveRepoRoot);
  const codexCommand = options.codexCommand ?? requireConfiguredValue("CODEX_PHONE_SUPERVISOR_CODEX_COMMAND");
  const gitTop = maybeGit(effectiveWorkspacePath, "rev-parse", "--show-toplevel");
  const gitBranch = maybeGit(effectiveWorkspacePath, "branch", "--show-current") || null;
  const gitStatus = maybeGit(effectiveWorkspacePath, "status", "--short") || "Not a git repo or no status available.";
  const repoName = gitTop ? path.basename(gitTop) : null;
  const configFiles = [
    ".codex/config.toml",
    ".env",
    ".env.example",
    ".mcp.json",
    "package.json",
    "tsconfig.json",
    "codex-phone-supervisor/tsconfig.json",
  ]
    .map((name) => path.join(effectiveRepoRoot, name))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => path.relative(effectiveRepoRoot, filePath));

  const codexVersion = run(codexCommand, ["--version"], effectiveWorkspacePath);
  const envNames = Object.keys(process.env)
    .filter(Boolean)
    .sort();

  let cleanliness: "clean" | "dirty" | "unknown" = "unknown";
  if (gitTop) cleanliness = gitStatus.trim() ? "dirty" : "clean";

  return {
    workspace_path: effectiveWorkspacePath,
    repo_name: repoName,
    current_branch: gitBranch,
    git_status: gitStatus,
    environment_variable_names: envNames,
    detectable_config_files: configFiles,
    codex_cli_installed: codexVersion.status === 0,
    codex_version: codexVersion.status === 0 ? codexVersion.stdout.trim() : null,
    workspace_cleanliness: cleanliness,
    approval_policy: {
      network_requires_approval: true,
      shell_requires_approval: true,
      destructive_requires_approval: true,
    },
  };
}

export function gitDiffSummary(workspacePath: string, files: string[] = []) {
  const args = ["diff", "--stat"];
  if (files.length) args.push("--", ...files);
  const result = maybeGit(workspacePath, ...args);
  return result || "No diff available.";
}
