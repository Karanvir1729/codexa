import fs from "node:fs";
import path from "node:path";
import { getTask, getTaskGraph, getWorker, listCommandEvents, upsertRunSummary } from "./store.js";
import type { CommandEventRecord, RunSummaryRecord, TaskGraphNode, TaskRecord } from "./types.js";

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function concreteFiles(values: string[]) {
  const uniqueValues = unique(values);
  const specific = uniqueValues.filter((value) => value !== "." && value !== "./");
  return specific.length ? specific : uniqueValues;
}

function normalizeFilePath(value: string) {
  return value.trim().replace(/^\.\/+/, "").replace(/\\/g, "/");
}

function isDocumentationFile(value: string) {
  const normalized = normalizeFilePath(value);
  return normalized.startsWith(".head-developer/") || normalized === ".head-developer" || /^docs\//i.test(normalized) || /(^|\/)(README|CHANGELOG|RUNBOOK|SECURITY|OPERATIONS)\.md$/i.test(normalized);
}

function isSourceLikeFile(value: string) {
  const normalized = normalizeFilePath(value);
  if (!normalized || isDocumentationFile(normalized)) return false;
  return /\.(html|css|js|jsx|ts|tsx|mjs|cjs|json|svg|png|jpg|jpeg|webp|gif|mdx)$/i.test(normalized)
    || /(^|\/)(src|app|pages|components|scripts|styles|assets)\//i.test(normalized);
}

function listWorkspaceFiles(root: string | null | undefined) {
  if (!root || !fs.existsSync(root)) return [];
  const base = root;
  const files: string[] = [];
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
  function walk(dir: string) {
    if (files.length >= 500) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = normalizeFilePath(path.relative(base, absolute));
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(relative);
      if (files.length >= 500) return;
    }
  }
  walk(root);
  return files.sort();
}

function filesFromCommandEvents(commands: CommandEventRecord[]) {
  return concreteFiles(commands.flatMap((event) => {
    const output = `${event.summary}\n${event.stdout_preview}\n${event.stderr_preview}`;
    const statusMatches = output.match(/(?:modified:|created:|deleted:)\s+([^\n,]+)/gi) ?? [];
    const gitStatusMatches = [...output.matchAll(/^\s*(?:\?\?|[AMDRC?!]{1,2})\s+(.+)$/gm)].map((match) => match[1].trim());
    const jsonMatches = [...output.matchAll(/"files_modified"\s*:\s*\[([^\]]*)\]/g)].flatMap((match) => {
      try {
        return JSON.parse(`[${match[1]}]`) as string[];
      } catch {
        return [];
      }
    });
    return [
      ...statusMatches.map((match) => match.replace(/^(modified:|created:|deleted:)\s+/i, "").trim()),
      ...gitStatusMatches,
      ...jsonMatches,
    ].map(normalizeFilePath);
  }));
}

function graphNodeForTask(task: TaskRecord | null): TaskGraphNode | null {
  if (!task?.task_graph_id || !task.task_graph_node_id) return null;
  const graph = getTaskGraph(task.task_graph_id);
  return graph?.nodes.find((node) => node.node_id === task.task_graph_node_id) ?? null;
}

function isDocumentationNode(node: TaskGraphNode | null) {
  if (!node) return false;
  const text = `${node.title} ${node.goal}`.toLowerCase();
  const expected = [...node.files_expected, ...node.outputs_expected];
  return /project setup|shared docs|validation and review|documentation|handoff/.test(text)
    && expected.length > 0
    && expected.every((item) => isDocumentationFile(item) || /validation|handoff|docs?|review/i.test(item));
}

function isAppBuildTask(task: TaskRecord | null, node: TaskGraphNode | null) {
  const text = `${task?.user_goal ?? ""} ${node?.title ?? ""} ${node?.goal ?? ""} ${node?.outputs_expected.join(" ") ?? ""} ${node?.files_expected.join(" ") ?? ""}`.toLowerCase();
  if (isDocumentationNode(node)) return false;
  return /\b(build|create|implement|add|generate|landing|page|screen|dashboard|settings|billing|auth|login|signup|site|website|app|html|css|javascript|ui)\b/.test(text);
}

function expectedAppFiles(node: TaskGraphNode | null) {
  return unique([
    ...(node?.files_expected ?? []),
    ...(node?.required_app_files ?? []),
    ...(node?.output_contract?.required_app_files ?? []),
  ].map(normalizeFilePath).filter((file) => file && !isDocumentationFile(file)));
}

function expectedFileSatisfied(expected: string, observed: string[]) {
  const needle = expected.toLowerCase();
  const hasExtension = /\.[a-z0-9]+$/i.test(needle);
  return observed.some((file) => {
    const candidate = file.toLowerCase();
    if (candidate === needle || candidate.endsWith(`/${needle}`)) return true;
    if (!hasExtension) return candidate.includes(needle) || candidate.startsWith(`${needle}/`);
    return path.posix.basename(candidate) === needle;
  });
}

export interface SummaryCompletionAssessment {
  status: "not_applicable" | "complete" | "incomplete";
  app_node: boolean;
  docs_only: boolean;
  app_files: string[];
  documentation_files: string[];
  missing_expected_app_files: string[];
  reasons: string[];
}

export function assessTaskCompletionForSummary(taskId: string, commands: CommandEventRecord[] = listCommandEvents({ taskId })): SummaryCompletionAssessment {
  const task = getTask(taskId);
  const node = graphNodeForTask(task);
  const filesChanged = filesFromCommandEvents(commands);
  const observedFiles = unique([...filesChanged, ...listWorkspaceFiles(task?.worktree_path)]);
  const documentationFiles = observedFiles.filter(isDocumentationFile);
  const appFiles = observedFiles.filter(isSourceLikeFile);
  const expected = expectedAppFiles(node);
  const missingExpected = expected.filter((file) => !expectedFileSatisfied(file, observedFiles));
  const appNode = isAppBuildTask(task, node);
  const docsOnly = observedFiles.length > 0 && appFiles.length === 0 && documentationFiles.length > 0;
  const openCommands = commands.filter((event) => event.exit_code === null);
  const failedCommands = commands.filter((event) => event.exit_code !== null && event.exit_code !== 0);
  const reasons: string[] = [];

  if (!appNode) {
    return { status: "not_applicable", app_node: false, docs_only: docsOnly, app_files: appFiles, documentation_files: documentationFiles, missing_expected_app_files: [], reasons };
  }
  if (node?.completion_gate?.status === "failed") reasons.push(...node.completion_gate.reasons);
  if (openCommands.length) reasons.push(`${openCommands.length} command event(s) are still open.`);
  if (failedCommands.length) reasons.push(`${failedCommands.length} command event(s) failed.`);
  if (!appFiles.length) reasons.push(docsOnly ? "Only documentation files were observed for an app-building task." : "No app/source files were observed for an app-building task.");
  if (expected.length && expected.length === missingExpected.length) reasons.push(`None of the expected app outputs were observed: ${missingExpected.join(", ")}.`);

  return {
    status: reasons.length ? "incomplete" : "complete",
    app_node: true,
    docs_only: docsOnly,
    app_files: appFiles,
    documentation_files: documentationFiles,
    missing_expected_app_files: missingExpected,
    reasons,
  };
}

export function generateTaskGraphTruthfulnessSummary(taskGraphId: string) {
  const graph = getTaskGraph(taskGraphId);
  if (!graph) return null;
  const assessments = graph.nodes.map((node) => ({ node, assessment: assessTaskCompletionForSummary(node.task_id) }));
  const completedAppNodes = assessments.filter((item) => item.assessment.app_node && item.assessment.status === "complete");
  const incompleteAppNodes = assessments.filter((item) => item.assessment.app_node && item.assessment.status === "incomplete");
  const docsOnlyNodes = assessments.filter((item) => item.assessment.app_node && item.assessment.docs_only);
  const documentationNodes = assessments.filter((item) => !item.assessment.app_node);
  const summary = [
    `Task graph ${graph.task_graph_id} status: ${graph.status}.`,
    `Completed app nodes: ${completedAppNodes.map((item) => item.node.title).join(", ") || "none"}.`,
    `Incomplete app nodes: ${incompleteAppNodes.map((item) => `${item.node.title} (${item.assessment.reasons.join("; ")})`).join(", ") || "none"}.`,
    `Documentation/review nodes: ${documentationNodes.map((item) => item.node.title).join(", ") || "none"}.`,
    docsOnlyNodes.length ? `Docs-only outputs detected: ${docsOnlyNodes.map((item) => item.node.title).join(", ")}.` : "No docs-only app output detected.",
  ].join(" ");
  return {
    task_graph_id: taskGraphId,
    status: incompleteAppNodes.length ? "incomplete" : graph.status,
    completed_app_nodes: completedAppNodes.map((item) => item.node.node_id),
    incomplete_app_nodes: incompleteAppNodes.map((item) => item.node.node_id),
    docs_only_nodes: docsOnlyNodes.map((item) => item.node.node_id),
    documentation_nodes: documentationNodes.map((item) => item.node.node_id),
    summary,
  };
}

export function generateRunSummary(taskId: string): RunSummaryRecord {
  const task = getTask(taskId);
  const worker = task?.worker_id ? getWorker(task.worker_id) : null;
  const commands = listCommandEvents({ taskId });
  const completed = commands.filter((event) => event.exit_code === 0);
  const failed = commands.filter((event) => event.exit_code !== null && event.exit_code !== 0);
  const testsRun = commands
    .filter((event) => /\b(test|typecheck|lint|pytest|node\s+--check|npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build)\b/i.test(event.command))
    .map((event) => event.command);
  const filesChanged = filesFromCommandEvents(commands);
  const completion = assessTaskCompletionForSummary(taskId, commands);
  const workerActualImage = worker?.actual_image_uri ?? worker?.runtime_image_uri;
  const workerRecordedImage = worker?.recorded_image_uri ?? worker?.image_uri;
  const codexCommand = commands.find((event) => /\bcodex\s+exec\b/.test(event.command));
  const codexHistoryNote = codexCommand?.codex_rollout_relative_path || codexCommand?.codex_session_id
    ? ` Codex history: ${codexCommand.codex_session_id ? `session ${codexCommand.codex_session_id}` : ""}${codexCommand.codex_rollout_relative_path ? `${codexCommand.codex_session_id ? "; " : ""}${codexCommand.codex_rollout_relative_path}` : ""}.`
    : "";
  const workerRuntimeNote = workerActualImage
    ? ` Worker mode: ${worker?.actual_worker_mode ?? worker?.type}. Actual runtime image: ${workerActualImage}${worker?.actual_image_digest || worker?.runtime_image_digest ? ` (${worker.actual_image_digest ?? worker.runtime_image_digest})` : ""}.${workerRecordedImage && workerActualImage !== workerRecordedImage ? ` Recorded launch image differs: ${workerRecordedImage}.` : ""}${worker?.codex_auth_method ? ` Codex auth: ${worker.codex_auth_method}${worker.codex_auth_validation_status ? ` (${worker.codex_auth_validation_status})` : ""}.` : ""}`
    : "";
  const completionNote = completion.status === "incomplete"
    ? ` Completion gate: incomplete. ${completion.reasons.join(" ")}${completion.app_files.length ? ` App files observed: ${completion.app_files.join(", ")}.` : ""}${completion.documentation_files.length ? ` Documentation files observed: ${completion.documentation_files.join(", ")}.` : ""}`
    : completion.status === "complete"
      ? ` Completion gate: app output observed${completion.app_files.length ? ` (${completion.app_files.join(", ")})` : ""}.`
      : "";
  const executivePrefix = completion.status === "incomplete" ? "Task incomplete" : `Task ${task?.status ?? taskId}`;
  const summaryFailures = [
    ...failed.map((event) => `${event.command}: ${event.summary}`),
    ...(completion.status === "incomplete" ? completion.reasons.map((reason) => `Completion gate: ${reason}`) : []),
  ];

  const summary: RunSummaryRecord = {
    task_id: taskId,
    executive_summary: task
      ? `${executivePrefix}: ${task.user_goal}`
      : `Task ${taskId} has ${commands.length} recorded command event(s).`,
    technical_summary: commands.length
      ? `${commands.length} command event(s) recorded; ${completed.length} succeeded and ${failed.length} failed or need approval.${filesChanged.length ? ` Files changed: ${filesChanged.join(", ")}.` : ""}${testsRun.length ? ` Validation: ${testsRun.join(", ")}.` : ""}${completionNote}${workerRuntimeNote}${codexHistoryNote}`
      : `No command events are recorded yet.${completionNote}${workerRuntimeNote}${codexHistoryNote}`,
    commands_run: commands.map((event) => event.command),
    files_changed: filesChanged,
    tests_run: unique(testsRun),
    failures: summaryFailures,
    current_state: completion.status === "incomplete" ? "incomplete" : task?.status ?? (failed.length ? "failed" : completed.length ? "completed" : "queued"),
    next_plan: completion.status === "incomplete"
      ? ["Repair missing app output before marking this node complete.", "Rerun validation after real app files are generated."]
      : task?.next_steps?.length ? task.next_steps : failed.length ? ["Inspect failed command output.", "Adjust the implementation or request approval if needed."] : ["Continue with the next planned task."],
    confidence: commands.length ? (failed.length || completion.status === "incomplete" ? "medium" : "high") : "low",
    created_at: new Date().toISOString(),
  };

  upsertRunSummary(summary);
  return summary;
}

export function voiceFriendlySummary(summary: RunSummaryRecord) {
  const happened = summary.executive_summary;
  const status = `Current status is ${summary.current_state}.`;
  const next = summary.failures.length
    ? `Next action is to address ${summary.failures.length} failure${summary.failures.length === 1 ? "" : "s"}.`
    : `Next action is ${summary.next_plan[0] ?? "to continue the plan"}.`;
  return `${happened} ${status} ${next}`;
}
