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

function summarizeOutput(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 600);
}

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
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

