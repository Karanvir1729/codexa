import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { config } from "./config.js";
import { CommandRunner } from "./command-runner.js";
import { getProject, listProjects, upsertProject } from "./project-store.js";
import {
  appendOrchestratorEvent,
  getRunSummary,
  getSession,
  getTask,
  listCommandEvents,
  listTasks,
  upsertRunSummary,
  upsertSession,
  upsertTask,
} from "./store.js";
import { generateRunSummary } from "./summary.js";
import type { PreviewMetadata, ProjectRecord, RunSummaryRecord, SessionState, TaskRecord } from "./types.js";

type PreviewStartResult =
  | { ok: true; preview: PreviewMetadata; task: TaskRecord; project: ProjectRecord; reused: boolean }
  | { ok: false; code: string; message: string; status: number };

function isWithinDirectory(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realpathIfExists(value: string) {
  return fs.existsSync(value) ? fs.realpathSync(value) : null;
}

function configuredWorkspaceRoots() {
  return [config.defaultWorkspacePath, config.newProjectsRoot, ...config.projectRoots]
    .map((root) => realpathIfExists(root))
    .filter((root): root is string => Boolean(root));
}

function ensureAllowedWorkspace(workspacePath: string) {
  const realWorkspace = realpathIfExists(workspacePath);
  if (!realWorkspace || !fs.statSync(realWorkspace).isDirectory()) return null;
  return configuredWorkspaceRoots().some((root) => isWithinDirectory(realWorkspace, root)) ? realWorkspace : null;
}

function localPreviewBaseUrl() {
  return `http://127.0.0.1:${config.port}`;
}

function normalizedMessage(text: string) {
  return text.toLowerCase().replace(/[?.!]/g, "").trim();
}

export function isPreviewRequest(text: string) {
  const input = normalizedMessage(text);
  return /^(please\s+)?(preview it|preview this|preview the app|open it in browser|open this in browser|open the app|show preview|show me the preview)$/.test(input);
}

export function isPreviewQuestion(text: string) {
  const input = normalizedMessage(text);
  return (
    input.includes("what am i looking at") ||
    input.includes("did it load") ||
    input.includes("any console errors") ||
    input.includes("console errors") ||
    input.includes("what files power this page")
  );
}

function latestCompletedTaskForSession(session: SessionState) {
  const activeTask = session.active_task_id ? getTask(session.active_task_id) : null;
  if (activeTask?.status === "completed") return activeTask;
  const projectId = session.current_project_id ?? session.project_id ?? activeTask?.project_id;
  return listTasks(projectId)
    .filter((task) => task.status === "completed")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function safeRelativePath(value: string) {
  const cleaned = value.split("#")[0].split("?")[0].trim();
  if (!cleaned || cleaned.startsWith("http://") || cleaned.startsWith("https://") || cleaned.startsWith("data:") || cleaned.startsWith("mailto:") || cleaned.startsWith("tel:")) return "";
  return cleaned.replace(/^\.?\//, "");
}

function findIndexHtmlCandidates(workspacePath: string, task: TaskRecord) {
  const candidates: string[] = [];
  const summary = getRunSummary(task.task_id);
  for (const file of summary?.files_changed ?? []) {
    if (path.basename(file) === "index.html") candidates.push(path.resolve(workspacePath, file));
  }
  candidates.push(path.join(workspacePath, "index.html"));

  const ignored = new Set(["node_modules", ".git", "dist", "build", ".next"]);
  const scan = (directory: string, depth: number) => {
    if (depth > 2) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === "index.html") candidates.push(fullPath);
      if (entry.isDirectory()) scan(fullPath, depth + 1);
    }
  };
  scan(workspacePath, 0);
  return unique(candidates);
}

function parseReferencedAssets(entryFile: string, workspacePath: string) {
  const html = fs.readFileSync(entryFile, "utf8");
  const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => safeRelativePath(match[1]))
    .filter(Boolean);
  return unique(references.filter((reference) => {
    const resolved = path.resolve(path.dirname(entryFile), reference);
    return isWithinDirectory(resolved, workspacePath) && fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  }).map((reference) => path.relative(workspacePath, path.resolve(path.dirname(entryFile), reference))));
}

function detectPreviewEntry(workspacePath: string, task: TaskRecord) {
  for (const candidate of findIndexHtmlCandidates(workspacePath, task)) {
    const realCandidate = realpathIfExists(candidate);
    if (!realCandidate || !fs.statSync(realCandidate).isFile()) continue;
    if (!isWithinDirectory(realCandidate, workspacePath)) continue;
    const entryFile = path.relative(workspacePath, realCandidate);
    return {
      entryFile,
      assetPaths: parseReferencedAssets(realCandidate, workspacePath),
      serverType: "static" as const,
    };
  }
  return null;
}

async function logPreviewInspection(preview: PreviewMetadata) {
  const runner = new CommandRunner();
  const paths = unique([preview.entry_file, ...preview.asset_paths]).slice(0, 24);
  return await runner.run({
    task_id: preview.task_id,
    project_id: preview.project_id,
    worker_id: preview.worker_id ?? "preview-local",
    command: "ls",
    args: ["-la", ...paths],
    cwd: preview.workspace_path,
    workspace_path: preview.workspace_path,
    worker_mode: "local",
    timeout_ms: 10_000,
  });
}

function updateSummaryWithPreview(taskId: string, preview: PreviewMetadata) {
  const existing = generateRunSummary(taskId) ?? getRunSummary(taskId);
  if (!existing) return null;
  const previewLine = `Preview: ${preview.preview_url} (${preview.status}; entry ${preview.entry_file}).`;
  const technicalSummary = existing.technical_summary.includes(preview.preview_url)
    ? existing.technical_summary
    : `${existing.technical_summary} ${previewLine}`;
  const nextPlan = existing.next_plan.includes("Inspect the local preview in the browser.")
    ? existing.next_plan
    : ["Inspect the local preview in the browser.", ...existing.next_plan];
  const updated: RunSummaryRecord = {
    ...existing,
    technical_summary: technicalSummary,
    next_plan: nextPlan,
    created_at: new Date().toISOString(),
  };
  upsertRunSummary(updated);
  return updated;
}

function previewResponse(preview: PreviewMetadata) {
  return `Preview is ready at ${preview.preview_url}. It is serving ${preview.entry_file} from ${preview.workspace_path}.`;
}

export async function startPreviewForSession(sessionId: string): Promise<PreviewStartResult> {
  const session = getSession(sessionId);
  if (!session) return { ok: false, code: "SESSION_NOT_FOUND", message: "Session not found.", status: 404 };
  const task = latestCompletedTaskForSession(session);
  if (!task) return { ok: false, code: "COMPLETED_TASK_NOT_FOUND", message: "No completed task is available to preview yet.", status: 409 };
  const project = getProject(task.project_id);
  if (!project) return { ok: false, code: "PROJECT_NOT_FOUND", message: "Project not found for the completed task.", status: 404 };
  const workspacePath = ensureAllowedWorkspace(project.workspace_path);
  if (!workspacePath) return { ok: false, code: "WORKSPACE_NOT_ALLOWED", message: "The generated workspace is missing or outside configured project roots.", status: 409 };

  if (task.latest_preview?.status && task.latest_preview.status !== "failed") {
    session.latest_codex_message = previewResponse(task.latest_preview);
    session.latest_summary = session.latest_summary || task.latest_summary;
    session.last_updated = new Date().toISOString();
    upsertSession(session);
    return { ok: true, preview: task.latest_preview, task, project, reused: true };
  }

  const entry = detectPreviewEntry(workspacePath, task);
  if (!entry) {
    appendOrchestratorEvent({
      scope: "preview",
      scope_id: task.task_id,
      type: "preview.failed",
      message: "No verified preview entry file was found.",
      data: { task_id: task.task_id, project_id: project.project_id, workspace_path: workspacePath },
    });
    return { ok: false, code: "PREVIEW_ENTRY_NOT_FOUND", message: "I could not find a verified generated app entry file to preview. No index.html was found in the completed task workspace.", status: 409 };
  }

  const now = new Date().toISOString();
  const previewId = `preview_${randomUUID()}`;
  const preview: PreviewMetadata = {
    preview_id: previewId,
    project_id: project.project_id,
    task_id: task.task_id,
    worker_id: task.worker_id,
    workspace_path: workspacePath,
    entry_file: entry.entryFile,
    asset_paths: entry.assetPaths,
    preview_url: `${localPreviewBaseUrl()}/previews/${previewId}/`,
    server_type: entry.serverType,
    status: "starting",
    console_errors: [],
    loaded: false,
    created_at: now,
    updated_at: now,
    summary: `Local static preview prepared for ${entry.entryFile}.`,
  };

  appendOrchestratorEvent({
    scope: "preview",
    scope_id: preview.preview_id,
    type: "preview.started",
    message: `Starting local preview for task ${task.task_id}.`,
    data: preview,
  });

  const commandEvent = await logPreviewInspection(preview);
  preview.command_event_id = commandEvent.event_id;
  preview.status = commandEvent.exit_code === 0 ? "running" : "failed";
  preview.summary = commandEvent.exit_code === 0
    ? `Local preview is serving ${entry.entryFile}; ${entry.assetPaths.length} referenced asset file(s) were verified.`
    : `Preview inspection failed: ${commandEvent.stderr_preview || commandEvent.summary}`;
  preview.updated_at = new Date().toISOString();

  task.latest_preview = preview;
  task.command_count = listCommandEvents({ taskId: task.task_id }).length;
  task.latest_summary = preview.status === "running" ? `${task.latest_summary} Preview ready at ${preview.preview_url}` : task.latest_summary;
  task.next_steps = preview.status === "running" ? unique(["Inspect the local preview in the browser.", ...task.next_steps]) : task.next_steps;
  task.updated_at = preview.updated_at;
  upsertTask(task);

  project.latest_preview = preview;
  project.updated_at = preview.updated_at;
  upsertProject(project);

  updateSummaryWithPreview(task.task_id, preview);

  session.active_task_id = task.task_id;
  session.current_project_id = project.project_id;
  session.project_id = session.project_id ?? project.project_id;
  session.workspace_path = project.workspace_path;
  session.latest_codex_message = preview.status === "running" ? previewResponse(preview) : preview.summary;
  session.latest_summary = session.latest_codex_message;
  session.last_updated = preview.updated_at;
  upsertSession(session);

  appendOrchestratorEvent({
    scope: "preview",
    scope_id: preview.preview_id,
    type: preview.status === "running" ? "preview.ready" : "preview.failed",
    message: preview.summary,
    data: preview,
  });

  return { ok: true, preview, task, project, reused: false };
}

export function findPreview(previewId: string) {
  for (const task of listTasks()) {
    if (task.latest_preview?.preview_id === previewId) return { preview: task.latest_preview, task, project: getProject(task.project_id) };
  }
  for (const project of listProjects()) {
    if (project.latest_preview?.preview_id === previewId) return { preview: project.latest_preview, task: getTask(project.latest_preview.task_id), project };
  }
  return null;
}

function contentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function previewTelemetryScript(previewId: string) {
  const reportPath = `/previews/${previewId}/report`;
  return `<script>
(() => {
  const errors = [];
  const post = () => fetch(${JSON.stringify(reportPath)}, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loaded: document.readyState === "complete", console_errors: errors.slice(-10) })
  }).catch(() => undefined);
  const originalError = console.error.bind(console);
  console.error = (...args) => { errors.push(args.map(String).join(" ")); originalError(...args); post(); };
  window.addEventListener("error", (event) => { errors.push(event.message || "window error"); post(); });
  window.addEventListener("unhandledrejection", (event) => { errors.push(String(event.reason || "unhandled rejection")); post(); });
  window.addEventListener("load", () => { setTimeout(post, 50); });
})();
</script>`;
}

export function servePreviewAsset(previewId: string, requestPath: string, res: Response) {
  const record = findPreview(previewId);
  if (!record?.preview) {
    res.status(404).json({ error: { code: "PREVIEW_NOT_FOUND", message: "Preview not found." } });
    return;
  }
  const workspacePath = ensureAllowedWorkspace(record.preview.workspace_path);
  if (!workspacePath) {
    res.status(409).json({ error: { code: "WORKSPACE_NOT_ALLOWED", message: "Preview workspace is unavailable." } });
    return;
  }
  const requested = requestPath && requestPath !== "/" ? requestPath.replace(/^\/+/, "") : record.preview.entry_file;
  const decoded = decodeURIComponent(requested);
  const target = path.resolve(workspacePath, decoded);
  if (!isWithinDirectory(target, workspacePath) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.status(404).json({ error: { code: "PREVIEW_ASSET_NOT_FOUND", message: "Preview asset not found." } });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.type(contentType(target));
  if (path.extname(target).toLowerCase() === ".html") {
    const html = fs.readFileSync(target, "utf8");
    const script = previewTelemetryScript(previewId);
    const entryDir = path.dirname(record.preview.entry_file);
    const baseHref = entryDir === "." ? `/previews/${previewId}/` : `/previews/${previewId}/${entryDir.replace(/\\/g, "/")}/`;
    const base = `<base href="${baseHref}">`;
    const withBase = /<base\s/i.test(html)
      ? html
      : html.includes("<head>")
        ? html.replace("<head>", `<head>${base}`)
        : `${base}${html}`;
    res.send(withBase.includes("</body>") ? withBase.replace("</body>", `${script}</body>`) : `${withBase}${script}`);
    return;
  }
  res.sendFile(target);
}

export function recordPreviewReport(previewId: string, report: { loaded?: unknown; console_errors?: unknown; screenshot_path?: unknown }) {
  const record = findPreview(previewId);
  if (!record?.preview || !record.task || !record.project) return null;
  const consoleErrors = Array.isArray(report.console_errors) ? report.console_errors.map(String).filter(Boolean).slice(-20) : record.preview.console_errors;
  const loaded = typeof report.loaded === "boolean" ? report.loaded : record.preview.loaded;
  const screenshotPath = typeof report.screenshot_path === "string" && report.screenshot_path.trim() ? report.screenshot_path.trim() : record.preview.screenshot_path;
  const next: PreviewMetadata = {
    ...record.preview,
    loaded,
    console_errors: consoleErrors,
    screenshot_path: screenshotPath,
    status: consoleErrors.length ? "failed" : loaded ? "loaded" : record.preview.status,
    summary: consoleErrors.length
      ? `Preview loaded with ${consoleErrors.length} browser error(s).`
      : loaded
        ? "Preview loaded in the browser with no reported console errors."
        : record.preview.summary,
    updated_at: new Date().toISOString(),
  };
  record.task.latest_preview = next;
  record.task.command_count = listCommandEvents({ taskId: record.task.task_id }).length;
  record.task.updated_at = next.updated_at;
  upsertTask(record.task);
  record.project.latest_preview = next;
  record.project.updated_at = next.updated_at;
  upsertProject(record.project);
  updateSummaryWithPreview(record.task.task_id, next);
  appendOrchestratorEvent({
    scope: "preview",
    scope_id: previewId,
    type: next.status === "failed" ? "preview.browser.failed" : "preview.browser.checked",
    message: next.summary,
    data: next,
  });
  return next;
}

export function answerPreviewQuestion(session: SessionState, cleaned: string) {
  const input = normalizedMessage(cleaned);
  const task = latestCompletedTaskForSession(session);
  const preview = task?.latest_preview ?? (session.current_project_id ? getProject(session.current_project_id)?.latest_preview : null);
  if (!preview) return "No preview has been started for the latest completed task yet.";
  const files = unique([preview.entry_file, ...preview.asset_paths]);
  if (input.includes("what am i looking at")) {
    return `You are looking at the local preview for task ${preview.task_id}. It is serving ${preview.entry_file} from ${preview.workspace_path}.`;
  }
  if (input.includes("did it load")) {
    if (preview.loaded) return `Yes. The preview reported a browser load at ${preview.preview_url}.`;
    if (preview.status === "failed") return `The preview is marked failed: ${preview.summary}`;
    return `The preview server is ready at ${preview.preview_url}, but no browser load report is recorded yet.`;
  }
  if (input.includes("console errors")) {
    return preview.console_errors.length
      ? `Console errors reported: ${preview.console_errors.join(" | ")}`
      : "No console errors are recorded for the latest preview.";
  }
  if (input.includes("what files power this page")) {
    return files.length ? `Preview files: ${files.join(", ")}.` : `The preview is powered by ${preview.entry_file}.`;
  }
  return "";
}

export function previewChatResponse(result: PreviewStartResult) {
  if (!result.ok) return result.message;
  const reuse = result.reused ? "The existing preview is still available." : "I started a local preview.";
  return `${reuse} ${previewResponse(result.preview)}`;
}
