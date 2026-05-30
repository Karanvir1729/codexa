import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { parseCodexJsonl, extractFinalAgentText } from "./parser.js";
import { appendAuditEvent, appendOrchestratorEvent, getSession, upsertSession } from "./store.js";
import { applySupervisorEvent, mergeCodexReport } from "./reducer.js";
import { gitDiffSummary } from "./access.js";
import { findProjectByWorkspace, projectRecordForWorkspace, upsertProject } from "./project-store.js";
import type { CodexStructuredReport, SessionState, SupervisorEvent } from "./types.js";

const activeRuns = new Map<string, { startedAt: number }>();

type CodexRunOptions = {
  approvedCommand?: string;
  newProject?: {
    displayName: string;
    slug: string;
    targetPath: string;
  };
};

function buildSchemaFile(sessionId: string) {
  fs.mkdirSync(config.runtimeDir, { recursive: true });
  const schemaPath = path.join(config.runtimeDir, `${sessionId}.schema.json`);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "status",
      "latest_codex_message",
      "files_read",
      "files_modified",
      "commands_requested",
      "commands_completed",
      "commands_failed",
      "test_results",
      "errors",
      "approval_requests",
    ],
    properties: {
      summary: { type: "string" },
      status: { type: "string", enum: ["completed", "failed", "needs_approval", "running"] },
      latest_codex_message: { type: "string" },
      files_read: { type: "array", items: { type: "string" } },
      files_modified: { type: "array", items: { type: "string" } },
      commands_requested: { type: "array", items: { type: "string" } },
      commands_completed: { type: "array", items: { type: "string" } },
      commands_failed: { type: "array", items: { type: "string" } },
      test_results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "status", "details"],
          properties: {
            name: { type: "string" },
            status: { type: "string", enum: ["passed", "failed", "skipped", "unknown"] },
            details: { type: ["string", "null"] },
          },
        },
      },
      errors: { type: "array", items: { type: "string" } },
      approval_requests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "command", "reason", "risk"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "shell",
                "network",
                "install",
                "delete",
                "deploy",
                "git_push",
                "secret_access",
                "external_repo",
                "gcp_resource",
                "twilio_mutation",
                "payment_or_billing",
              ],
            },
            command: { type: "string" },
            reason: { type: "string" },
            risk: { type: "string", enum: ["low", "medium", "high"] },
          },
        },
      },
    },
  };
  fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
  return schemaPath;
}

function buildPrompt(session: SessionState, instruction: string, options: CodexRunOptions = {}) {
  const approvedCommand = options.approvedCommand;
  const approvalContext = approvedCommand
    ? `You are explicitly approved to run exactly this previously requested action if still needed: ${approvedCommand}`
    : "Do not run shell commands, network actions, package installs, deploys, git push, file deletions, secret access, credential access, payment or billing actions, GCP resource creation/deletion/mutation, Twilio number/webhook mutation, or commands outside the current workspace unless they are explicitly approved in prior context. If one is needed, do not execute it. Instead, return it in approval_requests and stop.";
  const newProjectContext = options.newProject
    ? [
        `Create a new project directory named exactly: ${options.newProject.slug}`,
        `The target path must be: ${options.newProject.targetPath}`,
        "All project files for this task must be inside that new directory.",
        "Do not write project files outside that directory except for the final structured report.",
      ].join("\n")
    : "";

  return [
    "You are Codex Phone Supervisor's coding worker.",
    "Work only inside the current workspace.",
    "You may inspect files and modify files in the workspace.",
    newProjectContext,
    approvalContext,
    "Never auto-approve risky actions.",
    "At the end, return only JSON matching the provided output schema.",
    "Report all files you read or modified, all commands you want to run, any commands you completed, any failures, and any approval requests.",
    session.summary_text ? `Prior session summary: ${session.summary_text}` : "",
    `Current task: ${instruction}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseStructuredReport(text: string): CodexStructuredReport {
  const failureReport: CodexStructuredReport = {
    summary: text || "No summary available.",
    status: "failed",
    latest_codex_message: text || "No message available.",
    files_read: [],
    files_modified: [],
    commands_requested: [],
    commands_completed: [],
    commands_failed: [],
    test_results: [],
    errors: text ? [] : ["Codex returned an empty response."],
    approval_requests: [],
  };

  if (!text) return failureReport;
  try {
    return JSON.parse(text) as CodexStructuredReport;
  } catch {
    return {
      ...failureReport,
      summary: text,
      latest_codex_message: text,
      errors: ["Codex returned non-JSON output."],
    };
  }
}

function appendSessionEvent(session: SessionState, type: string, source: SupervisorEvent["source"], message: string, data?: unknown) {
  const event: SupervisorEvent = {
    id: randomUUID(),
    session_id: session.session_id,
    ts: new Date().toISOString(),
    source,
    type,
    message,
    data,
  };
  applySupervisorEvent(session, event);
  appendAuditEvent({
    session_id: event.session_id,
    ts: event.ts,
    source: event.source,
    type: event.type,
    message: event.message,
    data: event.data,
  });
}

function stderrErrorText(stderr: string) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/\bWARN\b/.test(line))
    .filter((line) => !/^Reading additional input from stdin\.?$/i.test(line))
    .filter((line) => !/failed to load skill .*invalid description: exceeds maximum length/i.test(line));
  return lines.join("\n");
}

export async function runCodexSession(sessionId: string, instruction: string, options: CodexRunOptions = {}) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found.`);
  if (activeRuns.has(sessionId)) throw new Error(`Session ${sessionId} is already running.`);
  const executionWorkspace = options.newProject ? config.newProjectsRoot : session.workspace_path;

  activeRuns.set(sessionId, { startedAt: Date.now() });
  try {
    session.current_status = "running";
    session.status = "running";
    session.active_task = instruction;
    session.pending_approvals = [];
    session.errors = [];
    session.instruction_history.push({ ts: new Date().toISOString(), text: instruction, source: options.approvedCommand ? "approval" : "instruct" });
    appendSessionEvent(session, "task.started", "system", `Started Codex task: ${instruction}`);
    upsertSession(session);

    const schemaPath = buildSchemaFile(sessionId);
    const args = [
      "exec",
      "--json",
      "--output-schema",
      schemaPath,
      "-C",
      executionWorkspace,
      "-s",
      "workspace-write",
      buildPrompt(session, instruction, options),
    ];
    const visibleArgs = args.map((arg, index) => (index === args.length - 1 ? "[worker prompt omitted from UI log]" : arg));

    appendSessionEvent(session, "codex.cli.started", "system", `codex ${visibleArgs.join(" ")}`, {
      command: config.codexCommand,
      args: visibleArgs,
      cwd: executionWorkspace,
      target_project_path: options.newProject?.targetPath,
      prompt_chars: args[args.length - 1].length,
    });
    upsertSession(session);

    const child = spawn(config.codexCommand, args, {
      cwd: executionWorkspace,
      env: {
        ...process.env,
        CODEX_HOME: config.codexHome,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        const closed = getSession(sessionId);
        if (closed) {
          appendSessionEvent(closed, "codex.cli.exited", "system", `codex exited with code ${code ?? "null"}${signal ? ` and signal ${signal}` : ""}.`, {
            code,
            signal,
          });
          upsertSession(closed);
        }
        resolve();
      });
    });

    const fresh = getSession(sessionId);
    if (!fresh) throw new Error(`Session ${sessionId} disappeared.`);
    if (stdout.trim()) appendSessionEvent(fresh, "codex.cli.stdout", "codex", stdout.trim().slice(-12000), { truncated_to_last_chars: 12000 });
    if (stderr.trim()) appendSessionEvent(fresh, "codex.cli.stderr", "codex", stderr.trim().slice(-8000), { truncated_to_last_chars: 8000 });
    const events = parseCodexJsonl(`${stdout}\n${stderr}`);
    for (const parsed of events) {
      appendSessionEvent(fresh, parsed.type, "codex", parsed.type, parsed);
    }
    const finalText = extractFinalAgentText(events);
    const report = parseStructuredReport(finalText);
    mergeCodexReport(fresh, report, new Date().toISOString());
    fresh.git_diff_summary = gitDiffSummary(fresh.workspace_path, fresh.files_modified);
    const stderrErrors = stderrErrorText(stderr);
    if (stderrErrors) fresh.errors = [...new Set([...fresh.errors, stderrErrors.slice(-1000)])];
    if (options.newProject) {
      if (fs.existsSync(options.newProject.targetPath) && fs.statSync(options.newProject.targetPath).isDirectory()) {
        const existing = findProjectByWorkspace(options.newProject.targetPath);
        const project = projectRecordForWorkspace(options.newProject.targetPath, existing ?? undefined);
        project.display_name = options.newProject.displayName;
        project.last_active_session_id = fresh.session_id;
        project.updated_at = new Date().toISOString();
        upsertProject(project);
        appendOrchestratorEvent({
          scope: "project",
          scope_id: project.project_id,
          type: "project.created",
          message: `Created project ${project.display_name}.`,
          data: project,
        });
        fresh.project_id = project.project_id;
        fresh.current_project_id = project.project_id;
        fresh.workspace_path = project.workspace_path;
        fresh.project_discovery.status = "selected";
        fresh.project_discovery.selected_workspace_path = project.workspace_path;
        fresh.project_discovery.selected_project_name = project.display_name;
        fresh.project_discovery.confidence = "high";
        fresh.project_discovery.reason = "New project was created by Codex CLI under the configured root repository.";
      } else {
        fresh.current_status = "failed";
        fresh.status = "failed";
        fresh.errors = [...new Set([...fresh.errors, `Codex did not create expected project directory: ${options.newProject.targetPath}`])];
      }
    }
    if (fresh.current_status !== "failed" && report.status === "completed" && !report.approval_requests.length) fresh.current_status = "completed";
    if (report.status === "failed") fresh.current_status = "failed";
    fresh.status = fresh.current_status;
    if (fresh.files_modified.length) {
      appendOrchestratorEvent({
        scope: "project",
        scope_id: fresh.project_id ?? fresh.session_id,
        type: "files.changed",
        message: `${fresh.files_modified.length} file(s) changed.`,
        data: { files_changed: fresh.files_modified, session_id: fresh.session_id, project_id: fresh.project_id },
      });
    }
    appendSessionEvent(fresh, "task.completed", "system", report.summary || "Codex run finished.", report);
    upsertSession(fresh);
    return fresh;
  } finally {
    activeRuns.delete(sessionId);
  }
}
