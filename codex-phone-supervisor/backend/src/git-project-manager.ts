import fs from "node:fs";
import path from "node:path";
import { CommandRunner } from "./command-runner.js";
import { documentationIndexer, DOCUMENTATION_INDEX_FILES, WORKER_CONTEXT_DOC_FILES } from "./documentation-indexer.js";
import { appendOrchestratorEvent } from "./store.js";
import { upsertProject } from "./project-store.js";
import type { CommandEventRecord, ProjectRecord, TaskGraphRecord, TaskRecord, WorkerRecord } from "./types.js";

const BASE_DOC_FILES = [
  "PROJECT_BRIEF.md",
  "TASK_GRAPH.md",
  "ARCHITECTURE.md",
  "WORKER_HANDOFFS.md",
  "DECISIONS.md",
  "RUNBOOK.md",
  "VALIDATION.md",
] as const;

const DOC_FILES = [...BASE_DOC_FILES, ...DOCUMENTATION_INDEX_FILES.filter((file) => !BASE_DOC_FILES.includes(file as typeof BASE_DOC_FILES[number]))] as const;

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
}

function read(filePath: string) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function ensureInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes project root: ${candidate}`);
  }
}

function renderTaskGraph(graph: TaskGraphRecord | null) {
  if (!graph) return "No task graph has been created yet.\n";
  return [
    `# Task Graph`,
    ``,
    `Root goal: ${graph.root_user_goal}`,
    `Status: ${graph.status}`,
    `Strategy: ${graph.execution_strategy}`,
    ``,
    `## Nodes`,
    ...graph.nodes.map((node) => `- ${node.title}: ${node.status}; task ${node.task_id}; dependencies: ${node.dependencies.join(", ") || "none"}; worker: ${node.assigned_worker_id ?? "unassigned"}; worktree: ${node.worktree_path ?? "main"}`),
    ``,
    `## Edges`,
    ...(graph.edges.length ? graph.edges.map((edge) => `- ${edge.from_node_id} ${edge.relationship} ${edge.to_node_id}`) : ["- none"]),
    ``,
  ].join("\n");
}

export class GitProjectManager {
  private runner = new CommandRunner();

  docsDir(project: ProjectRecord) {
    return project.docs_path || path.join(project.workspace_path, ".head-developer");
  }

  async ensureProjectRepo(project: ProjectRecord, task: Pick<TaskRecord, "task_id" | "project_id">, workerId = "orchestrator") {
    fs.mkdirSync(project.workspace_path, { recursive: true });
    const commands: CommandEventRecord[] = [];
    if (!fs.existsSync(path.join(project.workspace_path, ".git"))) {
      commands.push(await this.runner.run({
        task_id: task.task_id,
        project_id: task.project_id,
        worker_id: workerId,
        command: "git",
        args: ["init", "-b", project.default_branch || "main"],
        cwd: project.workspace_path,
        workspace_path: project.workspace_path,
        timeout_ms: 60_000,
      }));
      appendOrchestratorEvent({
        scope: "git",
        scope_id: project.project_id,
        type: "project_repo.created",
        message: `Initialized git repo for ${project.display_name}.`,
        data: { project_id: project.project_id, repo_path: project.workspace_path },
      });
    }
    project.repo_path = project.workspace_path;
    project.git_initialized = true;
    project.default_branch = project.default_branch || "main";
    project.repo_name = project.repo_name || path.basename(project.workspace_path);
    project.git_branch = project.git_branch || project.default_branch;
    project.docs_path = this.docsDir(project);
    project.shared_context_path = path.join(project.docs_path, "PROJECT_BRIEF.md");
    project.updated_at = new Date().toISOString();
    upsertProject(project);
    return { project, commands };
  }

  ensureSharedDocs(project: ProjectRecord, graph: TaskGraphRecord | null, rootGoal: string) {
    const docsDir = this.docsDir(project);
    fs.mkdirSync(docsDir, { recursive: true });
    const defaults: Record<typeof BASE_DOC_FILES[number], string> = {
      "PROJECT_BRIEF.md": `# Project Brief\n\nUser goal: ${rootGoal}\n\nTarget audience: To be refined from user conversation.\n\nCurrent product scope: ${rootGoal}\n\nConstraints:\n- Workers must stay inside the project repo or assigned worktree.\n- Do not claim success without command, file, or preview evidence.\n\nLatest status: ${graph?.status ?? "initialized"}.\n`,
      "TASK_GRAPH.md": renderTaskGraph(graph),
      "ARCHITECTURE.md": `# Architecture\n\nStack: To be inferred by workers from repo files.\n\nImportant files:\n- .head-developer/PROJECT_BRIEF.md\n- .head-developer/TASK_GRAPH.md\n\nDesign decisions:\n- Keep implementation scoped to the project repo.\n`,
      "WORKER_HANDOFFS.md": `# Worker Handoffs\n\nNo worker handoffs recorded yet.\n`,
      "DECISIONS.md": `# Decisions\n\n- Initialized shared Head Developer project memory.\n`,
      "RUNBOOK.md": `# Runbook\n\nHow to run: inspect generated project files and use recorded validation commands.\n\nHow to test: run the validation commands recorded in .head-developer/VALIDATION.md.\n\nKnown issues: none recorded yet.\n`,
      "VALIDATION.md": `# Validation\n\nNo validation command has completed yet.\n`,
    };
    for (const file of BASE_DOC_FILES) {
      const target = path.join(docsDir, file);
      ensureInside(target, project.workspace_path);
      if (!fs.existsSync(target)) fs.writeFileSync(target, defaults[file]);
    }
    fs.writeFileSync(path.join(docsDir, "TASK_GRAPH.md"), renderTaskGraph(graph));
    project.docs_path = docsDir;
    project.shared_context_path = path.join(docsDir, "PROJECT_BRIEF.md");
    project.updated_at = new Date().toISOString();
    upsertProject(project);
    appendOrchestratorEvent({
      scope: "docs",
      scope_id: project.project_id,
      type: "project_docs.updated",
      message: `Updated shared project docs for ${project.display_name}.`,
      data: { project_id: project.project_id, docs_path: docsDir, files: [...BASE_DOC_FILES] },
    });
    documentationIndexer.updateProjectDocs(project);
    return [...DOC_FILES].map((file) => path.join(docsDir, file));
  }

  readSharedDocs(project: ProjectRecord) {
    const docsDir = this.docsDir(project);
    return Object.fromEntries(WORKER_CONTEXT_DOC_FILES.map((file) => [`.head-developer/${file}`, read(path.join(docsDir, file))]));
  }

  async createWorktree(project: ProjectRecord, task: Pick<TaskRecord, "task_id" | "project_id">, nodeTitle: string, workerId: string) {
    const repoPath = project.repo_path || project.workspace_path;
    const branchName = `worker/${slug(nodeTitle)}-${task.task_id.slice(5, 13)}`;
    const worktreeRoot = path.resolve(`${repoPath}.worktrees`);
    const worktreePath = path.join(worktreeRoot, slug(`${nodeTitle}-${task.task_id.slice(5, 13)}`));
    fs.mkdirSync(worktreeRoot, { recursive: true });
    if (!fs.existsSync(worktreePath)) {
      const event = await this.runner.run({
        task_id: task.task_id,
        project_id: task.project_id,
        worker_id: workerId,
        command: "git",
        args: ["worktree", "add", "-b", branchName, worktreePath],
        cwd: repoPath,
        workspace_path: repoPath,
        timeout_ms: 120_000,
      });
      appendOrchestratorEvent({
        scope: "git",
        scope_id: task.task_id,
        type: event.exit_code === 0 ? "git.worktree.created" : "git.merge.failed",
        message: event.exit_code === 0 ? `Created worktree ${worktreePath}.` : `Failed to create worktree ${worktreePath}.`,
        data: { command_event_id: event.event_id, branch_name: branchName, worktree_path: worktreePath },
      });
    }
    return { branch_name: branchName, worktree_path: worktreePath };
  }

  async commitProjectDocs(project: ProjectRecord, task: Pick<TaskRecord, "task_id" | "project_id">, worker: Pick<WorkerRecord, "worker_id"> | null = null) {
    const workerId = worker?.worker_id ?? "orchestrator";
    const repoPath = project.repo_path || project.workspace_path;
    const events: CommandEventRecord[] = [];
    events.push(await this.runner.run({ task_id: task.task_id, project_id: task.project_id, worker_id: workerId, command: "git", args: ["config", "user.email", "head-developer@example.local"], cwd: repoPath, workspace_path: repoPath, timeout_ms: 30_000 }));
    events.push(await this.runner.run({ task_id: task.task_id, project_id: task.project_id, worker_id: workerId, command: "git", args: ["config", "user.name", "Head Developer"], cwd: repoPath, workspace_path: repoPath, timeout_ms: 30_000 }));
    events.push(await this.runner.run({ task_id: task.task_id, project_id: task.project_id, worker_id: workerId, command: "git", args: ["add", ".head-developer"], cwd: repoPath, workspace_path: repoPath, timeout_ms: 30_000 }));
    const commit = await this.runner.run({
      task_id: task.task_id,
      project_id: task.project_id,
      worker_id: workerId,
      command: "git",
      args: ["commit", "-m", `Initialize Head Developer docs for ${task.task_id}`],
      cwd: repoPath,
      workspace_path: repoPath,
      timeout_ms: 60_000,
    });
    events.push(commit);
    const rev = await this.runner.run({ task_id: task.task_id, project_id: task.project_id, worker_id: workerId, command: "git", args: ["rev-parse", "HEAD"], cwd: repoPath, workspace_path: repoPath, timeout_ms: 30_000 });
    events.push(rev);
    if (rev.exit_code === 0 && rev.stdout_preview.trim()) {
      project.latest_commit_hash = rev.stdout_preview.trim();
      project.updated_at = new Date().toISOString();
      upsertProject(project);
      appendOrchestratorEvent({
        scope: "git",
        scope_id: project.project_id,
        type: "git.commit.created",
        message: `Recorded commit ${project.latest_commit_hash}.`,
        data: { project_id: project.project_id, commit: project.latest_commit_hash, task_id: task.task_id },
      });
    }
    return events;
  }
}

export const gitProjectManager = new GitProjectManager();
