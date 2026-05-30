import { spawnSync } from "node:child_process";
import path from "node:path";
import { config } from "./config.js";
import type { ProjectRecord } from "./types.js";

export type GitHubRepoProvisionResult =
  | {
      status: "created" | "attached" | "existing_remote" | "skipped";
      url: string | null;
      full_name: string | null;
      reason: string;
      command?: string;
    }
  | {
      status: "failed";
      url: null;
      full_name: null;
      reason: string;
      error: string;
      command?: string;
    };

export type GitHubProjectPushResult =
  | {
      status: "pushed" | "no_changes" | "skipped";
      reason: string;
      branch: string | null;
      commit: string | null;
      remote: string | null;
    }
  | {
      status: "failed";
      reason: string;
      error: string;
      branch: string | null;
      commit: string | null;
      remote: string | null;
    };

function summarizeOutput(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 600);
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
    signal: result.signal,
  };
}

function git(workspacePath: string, ...args: string[]) {
  return run("git", args, workspacePath);
}

function gitValue(workspacePath: string, ...args: string[]) {
  const result = git(workspacePath, ...args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitSuccess(workspacePath: string, ...args: string[]) {
  const result = git(workspacePath, ...args);
  return result.status === 0 ? null : summarizeOutput(`${result.stderr}\n${result.stdout}`);
}

export function ensureLocalGitRepository(workspacePath: string) {
  const existingRoot = gitValue(workspacePath, "rev-parse", "--show-toplevel");
  if (existingRoot) return { initialized: false, repoRoot: existingRoot };
  let init = git(workspacePath, "init", "-b", "main");
  if (init.status !== 0) init = git(workspacePath, "init");
  if (init.status !== 0) {
    throw new Error(`Could not initialize git repository at ${workspacePath}: ${summarizeOutput(`${init.stderr}\n${init.stdout}`)}`);
  }
  return { initialized: true, repoRoot: gitValue(workspacePath, "rev-parse", "--show-toplevel") ?? workspacePath };
}

function repoName(input: { slug: string; project: ProjectRecord }) {
  const base = input.project.repo_name || path.basename(input.project.workspace_path) || input.slug;
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || input.slug;
}

function repoTarget(input: { slug: string; project: ProjectRecord }) {
  const name = repoName(input);
  return config.github.owner ? `${config.github.owner}/${name}` : name;
}

function parseGhRepoJson(output: string) {
  try {
    const parsed = JSON.parse(output) as { url?: string; nameWithOwner?: string };
    return {
      url: parsed.url ?? null,
      full_name: parsed.nameWithOwner ?? null,
    };
  } catch {
    return { url: null, full_name: null };
  }
}

function ghAuthIsReady(workspacePath: string) {
  const result = run(config.github.ghCommand, ["auth", "status", "-h", "github.com"], workspacePath);
  return result.status === 0;
}

function statusPaths(workspacePath: string) {
  const result = git(workspacePath, "status", "--porcelain", "-z", "--untracked-files=all");
  if (result.status !== 0) return [];
  const parts = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? "";
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file) paths.push(file);
    if (/R|C/.test(status)) {
      const next = parts[index + 1];
      if (next) {
        paths.push(next);
        index += 1;
      }
    }
  }
  return paths;
}

function blockedGitHubPushFiles(files: string[]) {
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, "/");
    return /(^|\/)\.env(?:$|\.)/i.test(normalized)
      || /(^|\/)(?:auth\.json|credentials(?:\.json)?|service-account(?:\.json)?|private[-_]?key|id_rsa|id_ed25519)$/i.test(normalized)
      || /(^|\/)\.?(?:aws|gcloud|config\/gcloud)\//i.test(normalized)
      || /(^|\/)(?:secrets?|tokens?)(?:\/|$)/i.test(normalized);
  });
}

export function ensureGitHubRepositoryForProject(input: {
  project: ProjectRecord;
  slug: string;
  description: string;
}): GitHubRepoProvisionResult {
  if (config.github.repoCreate === "never") {
    return {
      status: "skipped",
      url: null,
      full_name: null,
      reason: "GitHub repo creation is disabled.",
    };
  }

  const workspacePath = input.project.workspace_path;
  const origin = gitValue(workspacePath, "remote", "get-url", "origin");
  if (origin) {
    return {
      status: "existing_remote",
      url: /^https?:\/\//i.test(origin) ? origin : null,
      full_name: null,
      reason: "The local repo already has an origin remote.",
    };
  }

  if (!ghAuthIsReady(workspacePath)) {
    const reason = "GitHub CLI is not authenticated for github.com.";
    if (config.github.repoCreate === "always") {
      return { status: "failed", url: null, full_name: null, reason, error: reason };
    }
    return { status: "skipped", url: null, full_name: null, reason };
  }

  const target = repoTarget({ slug: input.slug, project: input.project });
  const visibilityFlag = `--${config.github.repoVisibility}`;
  const createArgs = [
    "repo",
    "create",
    target,
    visibilityFlag,
    "--source",
    workspacePath,
    "--remote",
    "origin",
    "--description",
    input.description.slice(0, 350),
  ];
  const create = run(config.github.ghCommand, createArgs, workspacePath);
  if (create.status !== 0) {
    return {
      status: "failed",
      url: null,
      full_name: null,
      reason: "GitHub repo creation failed.",
      error: summarizeOutput(`${create.stderr}\n${create.stdout}`),
      command: `${config.github.ghCommand} ${createArgs.join(" ")}`,
    };
  }

  const view = run(config.github.ghCommand, ["repo", "view", target, "--json", "url,nameWithOwner"], workspacePath);
  const parsed = view.status === 0 ? parseGhRepoJson(view.stdout) : { url: null, full_name: null };
  const remote = gitValue(workspacePath, "remote", "get-url", "origin");
  return {
    status: remote ? "created" : "attached",
    url: parsed.url ?? (remote && /^https?:\/\//i.test(remote) ? remote : null),
    full_name: parsed.full_name,
    reason: "Created GitHub repository and attached it as origin.",
    command: `${config.github.ghCommand} ${createArgs.join(" ")}`,
  };
}

export function pushProjectToGitHub(input: {
  project: ProjectRecord;
  taskId: string;
  message?: string;
}): GitHubProjectPushResult {
  const workspacePath = input.project.workspace_path;
  const remote = gitValue(workspacePath, "remote", "get-url", "origin");
  const branch = gitValue(workspacePath, "branch", "--show-current") || input.project.default_branch || "main";
  if (!input.project.github_repo_url || input.project.github_repo_created !== true) {
    return {
      status: "skipped",
      reason: "Automatic GitHub push is limited to repos created by this supervisor.",
      branch,
      commit: null,
      remote,
    };
  }
  if (!remote) {
    return {
      status: "failed",
      reason: "GitHub repo is attached in project state but no origin remote is configured.",
      error: "Missing origin remote.",
      branch,
      commit: null,
      remote,
    };
  }
  const changedPaths = statusPaths(workspacePath);
  const blocked = blockedGitHubPushFiles(changedPaths);
  if (blocked.length) {
    return {
      status: "failed",
      reason: "Refusing to push because the project contains files that look like secrets or credentials.",
      error: `Blocked file(s): ${blocked.join(", ")}`,
      branch,
      commit: null,
      remote,
    };
  }
  const emailError = gitSuccess(workspacePath, "config", "user.email", "head-developer@example.local");
  if (emailError) return { status: "failed", reason: "Could not configure git user.email.", error: emailError, branch, commit: null, remote };
  const nameError = gitSuccess(workspacePath, "config", "user.name", "Head Developer");
  if (nameError) return { status: "failed", reason: "Could not configure git user.name.", error: nameError, branch, commit: null, remote };
  const addError = gitSuccess(workspacePath, "add", "-A");
  if (addError) return { status: "failed", reason: "Could not stage generated project files.", error: addError, branch, commit: null, remote };
  const diff = git(workspacePath, "diff", "--cached", "--quiet");
  if (diff.status === 0) {
    const commit = gitValue(workspacePath, "rev-parse", "HEAD");
    return {
      status: "no_changes",
      reason: "No generated project changes needed pushing.",
      branch,
      commit,
      remote,
    };
  }
  const commitMessage = input.message || `Build project via local Codex (${input.taskId})`;
  const commit = git(workspacePath, "commit", "-m", commitMessage);
  if (commit.status !== 0) {
    return {
      status: "failed",
      reason: "Could not commit generated project files before pushing to GitHub.",
      error: summarizeOutput(`${commit.stderr}\n${commit.stdout}`),
      branch,
      commit: null,
      remote,
    };
  }
  const commitHash = gitValue(workspacePath, "rev-parse", "HEAD");
  const push = git(workspacePath, "push", "-u", "origin", branch);
  if (push.status !== 0) {
    return {
      status: "failed",
      reason: "Could not push generated project files to GitHub.",
      error: summarizeOutput(`${push.stderr}\n${push.stdout}`),
      branch,
      commit: commitHash,
      remote,
    };
  }
  return {
    status: "pushed",
    reason: "Committed and pushed generated project files to GitHub.",
    branch,
    commit: commitHash,
    remote,
  };
}
