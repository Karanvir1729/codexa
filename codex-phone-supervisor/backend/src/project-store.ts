import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { config } from "./config.js";
import { listProjectCandidates } from "./project-selector.js";
import { slugifyProjectName } from "./project-naming.js";
import { appendOrchestratorEvent, getSession, getStateStore, upsertSession } from "./store.js";
import type { ProjectRecord } from "./types.js";

function gitValue(workspacePath: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd: workspacePath, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function stableProjectId(workspacePath: string) {
  const digest = createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
  return `project_${digest}`;
}

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectSignals(directory: string) {
  return ["package.json", ".git", "pyproject.toml", "Cargo.toml", "go.mod", "README.md"].filter((marker) => fs.existsSync(path.join(directory, marker)));
}

function isGeneratedProjectsContainerProject(project: ProjectRecord) {
  try {
    const realPath = fs.realpathSync(project.workspace_path);
    const newProjectsRoot = fs.realpathSync(config.newProjectsRoot);
    return realPath === newProjectsRoot && projectSignals(realPath).length === 0;
  } catch {
    return false;
  }
}

export function newProjectPathForName(projectName: string) {
  const slug = slugifyProjectName(projectName);
  const root = fs.realpathSync(config.newProjectsRoot);
  const target = path.resolve(root, slug);
  if (!isWithinDirectory(target, root)) {
    throw new Error("New project path must stay inside CODEX_PHONE_SUPERVISOR_NEW_PROJECTS_ROOT.");
  }
  return { slug, target };
}

export function ensureNewProjectDirectory(projectName: string) {
  const { slug, target } = newProjectPathForName(projectName);
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) throw new Error(`New project target exists and is not a directory: ${target}`);
  } else {
    fs.mkdirSync(target, { recursive: true });
  }
  return { slug, workspacePath: fs.realpathSync(target) };
}

export function projectRecordForWorkspace(workspacePath: string, existing?: ProjectRecord): ProjectRecord {
  if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
    throw new Error(`Project workspace does not exist: ${workspacePath}`);
  }
  const realPath = fs.realpathSync(workspacePath);
  const now = new Date().toISOString();
  const repoRoot = gitValue(realPath, "rev-parse", "--show-toplevel");
  const branch = gitValue(realPath, "branch", "--show-current");
  return {
    project_id: existing?.project_id ?? stableProjectId(realPath),
    display_name: existing?.display_name ?? path.basename(realPath),
    workspace_path: realPath,
    repo_name: repoRoot ? path.basename(repoRoot) : path.basename(realPath),
    git_branch: branch,
    repo_path: repoRoot ?? existing?.repo_path ?? realPath,
    git_initialized: Boolean(repoRoot ?? existing?.git_initialized),
    github_repo_url: existing?.github_repo_url ?? null,
    github_repo_full_name: existing?.github_repo_full_name ?? null,
    github_repo_created: existing?.github_repo_created ?? null,
    github_repo_error: existing?.github_repo_error ?? null,
    github_last_push_at: existing?.github_last_push_at ?? null,
    github_last_push_error: existing?.github_last_push_error ?? null,
    default_branch: existing?.default_branch ?? branch ?? "main",
    latest_commit_hash: gitValue(realPath, "rev-parse", "HEAD") ?? existing?.latest_commit_hash ?? null,
    docs_path: existing?.docs_path ?? path.join(realPath, ".head-developer"),
    shared_context_path: existing?.shared_context_path ?? path.join(realPath, ".head-developer", "PROJECT_BRIEF.md"),
    documentation_indexed_at: existing?.documentation_indexed_at ?? null,
    docs_fresh: existing?.docs_fresh ?? null,
    docs_stale_reasons: existing?.docs_stale_reasons ?? [],
    last_active_session_id: existing?.last_active_session_id ?? null,
    available_codex_adapter: "codex_cli",
    latest_preview: existing?.latest_preview ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

export function refreshProjectsFromConfiguredRoots() {
  const store = getStateStore();
  const existingProjects = store.listProjects();
  for (const candidate of listProjectCandidates()) {
    const existing = existingProjects.find((project) => project.workspace_path === candidate.path);
    const record = projectRecordForWorkspace(candidate.path, existing);
    store.updateProject(record);
  }
  return listProjects();
}

export function listProjects(filters: Parameters<ReturnType<typeof getStateStore>["listProjects"]>[0] = {}) {
  return getStateStore()
    .listProjects(filters)
    .filter((project) => !isGeneratedProjectsContainerProject(project))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getProject(projectId: string) {
  return getStateStore().getProject(projectId);
}

export function upsertProject(project: ProjectRecord) {
  return getStateStore().updateProject(project);
}

export function attachSessionToProject(sessionId: string, projectId: string) {
  const session = getSession(sessionId);
  const project = getProject(projectId);
  if (!session) return { error: "Session not found." };
  if (!project) return { error: "Project not found." };

  session.project_id = project.project_id;
  session.current_project_id = project.project_id;
  session.workspace_path = project.workspace_path;
  session.project_discovery.status = "selected";
  session.project_discovery.selected_workspace_path = project.workspace_path;
  session.project_discovery.selected_project_name = project.display_name;
  session.project_discovery.confidence = "high";
  session.project_discovery.last_question = "";
  session.project_discovery.reason = "Session explicitly attached to project.";
  upsertSession(session);

  project.last_active_session_id = sessionId;
  project.updated_at = new Date().toISOString();
  upsertProject(project);
  appendOrchestratorEvent({
    scope: "project",
    scope_id: project.project_id,
    type: "project.selected",
    message: `Selected project ${project.display_name}.`,
    data: { project, session_id: sessionId },
  });

  return { session, project };
}

export function findProjectByWorkspace(workspacePath: string) {
  const realPath = fs.realpathSync(workspacePath);
  return listProjects({ workspacePath: realPath, limit: 1 })[0] ?? null;
}
