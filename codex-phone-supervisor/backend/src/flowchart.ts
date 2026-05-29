import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { listProjects } from "./project-store.js";
import {
  getOrchestratorSettings,
  listApprovalRequests,
  listCommandEvents,
  listMcpToolCalls,
  listOrchestratorEvents,
  listOperatorActions,
  listRunSummaries,
  listSessions,
  listTaskGraphs,
  listTasks,
  listWorkerContextPackets,
  listWorkers,
} from "./store.js";
import { workerHeartbeatIsStale } from "./worker-heartbeat.js";
import type {
  Channel,
  CommandEventRecord,
  FlowchartEdge,
  FlowchartNode,
  FlowchartState,
  FlowchartVisualState,
  PendingApproval,
  RunSummaryRecord,
  TaskRecord,
  WorkerRecord,
  PreviewMetadata,
  OperatorActionRecord,
} from "./types.js";

function channelLabel(channel: Channel | null) {
  if (channel === "web_voice") return "Web Voice";
  if (channel === "twilio_sms" || channel === "sms") return "Twilio SMS";
  if (channel === "twilio_call" || channel === "phone") return "Twilio Phone";
  if (channel === "operator") return "Operator";
  return "Web Text";
}

function channelId(channel: string) {
  return `channel:${channel}`;
}

function statusVisualState(status: string): FlowchartVisualState {
  if (/failed|error|blocked/i.test(status)) return "failed";
  if (/waiting|approval/i.test(status)) return "waiting_for_approval";
  if (/running|assigned|started/i.test(status)) return "running";
  if (/planning|queued|starting/i.test(status)) return "planning";
  if (/completed|healthy|idle|stopped/i.test(status)) return status === "idle" || status === "stopped" ? "idle" : "completed";
  if (/warning|stale|expired/i.test(status)) return "warning";
  return "idle";
}

function taskForWorker(tasks: TaskRecord[], worker: WorkerRecord) {
  return worker.task_id ? tasks.find((task) => task.task_id === worker.task_id) ?? null : null;
}

function workerVisualState(worker: WorkerRecord, task: TaskRecord | null, nowMs: number): FlowchartVisualState {
  if (worker.status === "failed") return "failed";
  if (workerHeartbeatIsStale(worker, task, nowMs, 60_000)) return "warning";
  if (workerImageMismatch(worker) || workerVmNameMismatch(worker)) return "warning";
  if (worker.status === "running" || worker.status === "assigned" || worker.status === "starting") return "running";
  return statusVisualState(worker.status);
}

function workerImageMismatch(worker: WorkerRecord) {
  const recorded = worker.recorded_image_uri ?? worker.image_uri;
  const actual = worker.actual_image_uri ?? worker.runtime_image_uri;
  return Boolean(actual && actual !== recorded);
}

function workerVmNameMismatch(worker: WorkerRecord) {
  const recorded = worker.recorded_vm_name;
  const actual = worker.actual_vm_name ?? worker.runtime_vm_name ?? worker.vm_name;
  return Boolean(actual && recorded && actual !== recorded);
}

function commandVisualState(command: CommandEventRecord): FlowchartVisualState {
  if (command.exit_code === null) return "running";
  if (command.exit_code === 0) return "completed";
  if (command.exit_code === 125 || command.risk_level === "high") return "waiting_for_approval";
  return "failed";
}

function durationMs(startedAt: string, endedAt: string | null) {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function preview(value: string, max = 160) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function summaryText(value: string, max = 180) {
  return preview(String(value || "")
    .replace(/`[^`]*`/g, "implementation detail")
    .replace(/(?:^|[\s(])(?:\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/]|[\w.-]+\/)[^\s,;:)]+/g, " project file")
    .replace(/\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|html|css|md|svg|png|jpe?g|webp|gif|ico|yml|yaml)\b/gi, "project file")
    .replace(/\\+$/g, "")
    .replace(/\s+/g, " ")
    .trim(), max);
}

function subagentAdvisorSummaryTextForFlowchart(advisor: NonNullable<TaskRecord["codex_subagent_advisor"]>) {
  const suggestions = advisor.suggested_subagents
    .map((item) => `${item.name}: ${item.responsibility}`)
    .join("; ");
  return suggestions ? `${advisor.summary} Suggested lanes: ${suggestions}.` : advisor.summary;
}

const localFlowchartSummaryKinds = new Set([
  "user_request",
  "requirement_summary",
  "plan",
  "megaplan",
  "approval",
  "codex_session",
  "subagent_advisor",
  "subagent",
  "flowchart_maker",
  "validation",
  "preview",
  "quality_check",
  "final_summary",
]);

type NormalizedLocalFlowchartSummary = NonNullable<TaskRecord["codex_flowchart_summary"]>;

function firstLocalSummaryNodeId(summary: NormalizedLocalFlowchartSummary, kind: string) {
  return summary.nodes.find((node) => node.kind === kind)?.id ?? "";
}

function localSummaryKindStatus(summary: NormalizedLocalFlowchartSummary, kind: string) {
  return summary.nodes.find((node) => node.kind === kind)?.status ?? "";
}

function addLocalSummaryEdge(edges: NormalizedLocalFlowchartSummary["edges"], from: string, to: string, label: string) {
  if (!from || !to || from === to) return;
  if (edges.some((edge) => edge.from === from && edge.to === to)) return;
  edges.push({ from, to, label });
}

function withLocalSystemProcessNodes(summary: NormalizedLocalFlowchartSummary, qualityCheck?: TaskRecord["codex_quality_check"] | null): NormalizedLocalFlowchartSummary {
  const nodes = [...summary.nodes];
  const edges = [...summary.edges];
  const hasKind = (kind: string) => nodes.some((node) => node.kind === kind);
  const requestId = firstLocalSummaryNodeId(summary, "user_request") || nodes[0]?.id || "";
  const requirementsId = firstLocalSummaryNodeId(summary, "requirement_summary");
  const planId = firstLocalSummaryNodeId(summary, "plan");
  const codexSessionId = firstLocalSummaryNodeId(summary, "codex_session");
  const validationId = firstLocalSummaryNodeId(summary, "validation");
  const previewId = firstLocalSummaryNodeId(summary, "preview");
  const finalSummaryId = firstLocalSummaryNodeId(summary, "final_summary");
  const preMegaplanId = planId || requirementsId || requestId;

  if (!hasKind("megaplan")) {
    nodes.push({
      id: "megaplan",
      kind: "megaplan",
      label: "Megaplan skill",
      status: "created",
      summary: "Codex turns clarified requirements into an approval-ready Megaplan.",
      depends_on: preMegaplanId ? [preMegaplanId] : [],
    });
  }
  if (!hasKind("approval")) {
    nodes.push({
      id: "approval-gate",
      kind: "approval",
      label: "Approval gate",
      status: "approved",
      summary: "Complex work waits for user approval before implementation starts.",
      depends_on: ["megaplan"],
    });
  }
  if (!hasKind("subagent_advisor")) {
    const codexStatus = localSummaryKindStatus(summary, "codex_session");
    const currentApprovalId = nodes.find((node) => node.kind === "approval")?.id ?? "";
    nodes.push({
      id: "subagent-advisor",
      kind: "subagent_advisor",
      label: "Subagent advisor",
      status: /running|working|in progress/i.test(codexStatus) ? "watching" : "updated",
      summary: "Parallel Codex process watches for useful internal subagent opportunities.",
      depends_on: codexSessionId ? [codexSessionId] : currentApprovalId ? [currentApprovalId] : [],
    });
  }
  if (!hasKind("flowchart_maker")) {
    const codexStatus = localSummaryKindStatus(summary, "codex_session");
    const currentSubagentAdvisorId = nodes.find((node) => node.kind === "subagent_advisor")?.id ?? "";
    nodes.push({
      id: "flowchart-maker",
      kind: "flowchart_maker",
      label: "Flowchart maker",
      status: /running|working|in progress/i.test(codexStatus) ? "running" : "updated",
      summary: "Parallel Codex process converts live summaries into this graph.",
      depends_on: [codexSessionId, currentSubagentAdvisorId].filter(Boolean),
    });
  }
  if (!hasKind("quality_check")) {
    nodes.push({
      id: "quality-check",
      kind: "quality_check",
      label: "Quality check",
      status: qualityCheck?.status ?? "pending",
      summary: summaryText(qualityCheck?.summary ?? "Final Codex quality checker audits the result against the Megaplan, functionality, validation evidence, and UI quality.", 220),
      depends_on: [previewId || validationId || codexSessionId].filter(Boolean),
    });
  }

  const megaplanId = nodes.find((node) => node.kind === "megaplan")?.id ?? "";
  const approvalId = nodes.find((node) => node.kind === "approval")?.id ?? "";
  const subagentAdvisorId = nodes.find((node) => node.kind === "subagent_advisor")?.id ?? "";
  const flowchartMakerId = nodes.find((node) => node.kind === "flowchart_maker")?.id ?? "";
  const qualityCheckId = nodes.find((node) => node.kind === "quality_check")?.id ?? "";
  const currentValidationId = nodes.find((node) => node.kind === "validation")?.id ?? "";
  const currentPreviewId = nodes.find((node) => node.kind === "preview")?.id ?? "";
  addLocalSummaryEdge(edges, preMegaplanId, megaplanId, "megaplan");
  addLocalSummaryEdge(edges, megaplanId, approvalId, "approval");
  addLocalSummaryEdge(edges, approvalId, codexSessionId, "starts");
  addLocalSummaryEdge(edges, codexSessionId || approvalId, subagentAdvisorId, "subagent advice");
  addLocalSummaryEdge(edges, codexSessionId, flowchartMakerId, "summarizes");
  addLocalSummaryEdge(edges, subagentAdvisorId, flowchartMakerId, "advisor input");
  addLocalSummaryEdge(edges, currentPreviewId || currentValidationId || codexSessionId, qualityCheckId, "quality check");
  addLocalSummaryEdge(edges, qualityCheckId, finalSummaryId, "quality gate");
  addLocalSummaryEdge(edges, flowchartMakerId, finalSummaryId, "updates");

  return { ...summary, nodes, edges };
}

function normalizeLocalFlowchartSummary(value: unknown): NonNullable<TaskRecord["codex_flowchart_summary"]> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.map((item, index) => {
      const node = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const kind = typeof node.kind === "string" && localFlowchartSummaryKinds.has(node.kind) ? node.kind : "subagent";
      const id = summaryText(String(node.id || `${kind}-${index + 1}`), 64).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `${kind}-${index + 1}`;
      return {
        id,
        kind: kind as NonNullable<TaskRecord["codex_flowchart_summary"]>["nodes"][number]["kind"],
        label: summaryText(String(node.label || kind.replace(/_/g, " ")), 64),
        status: summaryText(String(node.status || "recorded"), 48),
        summary: summaryText(String(node.summary || ""), 220),
        depends_on: Array.isArray(node.depends_on)
          ? node.depends_on.map((dependency) => String(dependency || "").trim()).filter(Boolean)
          : [],
      };
    }).filter((node) => node.label)
    : [];
  if (!nodes.length) return null;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(record.edges)
    ? record.edges.map((item) => {
      const edge = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        from: String(edge.from || "").trim(),
        to: String(edge.to || "").trim(),
        label: summaryText(String(edge.label || "next"), 32),
      };
    }).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    : [];
  return {
    title: summaryText(String(record.title || "Codex implementation flow"), 120),
    overview: summaryText(String(record.overview || ""), 500),
    nodes,
    edges,
  };
}

function readLocalCodexFlowchartJson(task: TaskRecord) {
  const flowchartJsonPath = task.codex_flowchart_json_path;
  if (!flowchartJsonPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(flowchartJsonPath, "utf8")) as { flowchart?: unknown };
    return normalizeLocalFlowchartSummary(parsed.flowchart ?? parsed);
  } catch {
    return null;
  }
}

function localCodexFlowchartSummary(task: TaskRecord) {
  const summary = readLocalCodexFlowchartJson(task) ?? task.codex_flowchart_summary ?? null;
  return summary ? withLocalSystemProcessNodes(summary, task.codex_quality_check ?? null) : null;
}

function localSummaryNodeType(kind: string): FlowchartNode["type"] {
  if (kind === "plan") return "codex_plan";
  if (kind === "megaplan") return "codex_plan";
  if (kind === "approval") return "user_approval";
  if (kind === "subagent_advisor") return "subagent_advisor";
  if (kind === "subagent") return "codex_subagent";
  if (kind === "flowchart_maker") return "flowchart_maker";
  if (kind === "user_request") return "user_request";
  if (kind === "requirement_summary") return "requirement_summary";
  if (kind === "codex_session") return "codex_session";
  if (kind === "validation") return "validation";
  if (kind === "preview") return "preview";
  if (kind === "quality_check") return "quality_check";
  if (kind === "final_summary") return "final_summary";
  return "codex_subagent";
}

function localSummaryColumn(kind: string) {
  if (kind === "user_request") return 2;
  if (kind === "requirement_summary") return 3;
  if (kind === "plan") return 4;
  if (kind === "megaplan") return 4;
  if (kind === "approval") return 5;
  if (kind === "codex_session") return 5;
  if (kind === "subagent_advisor") return 6;
  if (kind === "subagent") return 7;
  if (kind === "flowchart_maker") return 7;
  if (kind === "validation") return 7;
  if (kind === "preview") return 8;
  if (kind === "quality_check") return 9;
  if (kind === "final_summary") return 10;
  return 6;
}

function localSummaryVisualState(status: string): FlowchartVisualState {
  if (/fail|blocked/i.test(status)) return "failed";
  if (/running|in progress|working|watching/i.test(status)) return "running";
  if (/waiting|approval/i.test(status)) return "waiting_for_approval";
  if (/approved|created|updated|complete|done|pass|loaded|ready|received|summarized/i.test(status)) return "completed";
  return "planning";
}

function addNode(nodes: FlowchartNode[], node: Omit<FlowchartNode, "position">, index: number, column: number) {
  if (nodes.some((existing) => existing.id === node.id)) return;
  nodes.push({
    ...node,
    position: { x: 32 + column * 245, y: 28 + index * 154 },
  });
}

function addEdge(edges: FlowchartEdge[], from: string, to: string, label: string) {
  if (!from || !to || from === to) return;
  const id = `${from}->${to}:${label}`;
  if (edges.some((edge) => edge.id === id)) return;
  edges.push({ id, from, to, label });
}

function latestTaskForProject(tasks: TaskRecord[], projectId: string) {
  return tasks.filter((task) => task.project_id === projectId).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;
}

function latestCommandForWorker(commands: CommandEventRecord[], workerId: string) {
  return commands.filter((command) => command.worker_id === workerId).sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null;
}

function summaryForTask(summaries: RunSummaryRecord[], taskId: string) {
  return summaries.find((summary) => summary.task_id === taskId) ?? null;
}

function previewVisualState(preview: PreviewMetadata): FlowchartVisualState {
  if (preview.status === "failed") return "failed";
  if (preview.status === "loaded") return "completed";
  if (preview.status === "starting" || preview.status === "running") return "running";
  return "idle";
}

function actionNodeType(action: OperatorActionRecord): FlowchartNode["type"] {
  if (["start_worker", "stop_worker", "restart_worker", "assign_worker", "cleanup_idle_workers"].includes(action.action_type)) return "worker_control";
  if (["run_worker_command", "run_project_command", "inspect_command"].includes(action.action_type)) return "command_action";
  if (["tail_worker_logs", "tail_task_logs", "tail_api_logs"].includes(action.action_type)) return "log_inspection";
  if (action.action_type === "inspect_codex_history") return "codex_history";
  return "operator_action";
}

export function buildFlowchartState(): FlowchartState {
  const generatedAt = new Date().toISOString();
  const nowMs = Date.now();
  const sessions = listSessions();
  const projects = listProjects();
  const tasks = listTasks();
  const workers = listWorkers();
  const commands = listCommandEvents();
  const mcpCalls = listMcpToolCalls();
  const operatorActions = listOperatorActions();
  const taskGraphs = listTaskGraphs();
  const contextPackets = listWorkerContextPackets();
  const summaries = listRunSummaries();
  const approvals = listApprovalRequests();
  const events = listOrchestratorEvents().slice(-100);
  const settings = getOrchestratorSettings();
  const localCodexTasks = tasks.filter((task) => task.execution_backend === "codex_session_local");
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];

  const supportedChannels: Array<{ key: string; label: string }> = [
    { key: "web_text", label: "Web Text" },
    { key: "web_voice", label: "Web Voice" },
    { key: "twilio_sms", label: "Twilio SMS" },
    { key: "twilio_call", label: "Twilio Phone" },
  ];
  supportedChannels.forEach((channel, index) => {
    const channelSessions = sessions.filter((session) => channelLabel(session.channel).toLowerCase() === channel.label.toLowerCase());
    addNode(nodes, {
      id: channelId(channel.key),
      type: "channel",
      label: channel.label,
      status: channelSessions.length ? "active" : "idle",
      visual_state: channelSessions.length ? "completed" : "idle",
      badges: [`${channelSessions.length} sessions`],
      summary: channelSessions[0]?.latest_codex_message || "No active message.",
      detail: { channel: channel.key, sessions: channelSessions.map((session) => session.session_id) },
    }, index, 0);
  });

  const latestDecision = [...events].reverse().find((event) => event.type.startsWith("orchestrator.decision")) ?? events.at(-1) ?? null;
  addNode(nodes, {
    id: "orchestrator:control-plane",
    type: "orchestrator",
    label: "Codex CLI Orchestrator",
    status: tasks.some((task) => task.status === "running") ? "running" : tasks.some((task) => task.status === "queued" || task.status === "planning") ? "planning" : "idle",
    visual_state: tasks.some((task) => task.status === "running") ? "running" : tasks.some((task) => task.status === "failed") ? "failed" : "planning",
    badges: ["codex_session_local", "Codex CLI", "internal subagents"],
    summary: localCodexTasks.length ? "Streaming a real local Codex CLI session. Subagent nodes are Codex-internal logical responsibilities." : latestDecision?.message || "Waiting for local Codex CLI activity.",
    detail: {
      latest_decision: latestDecision,
      current_plan: tasks[0]?.plan ?? [],
      active_sessions: sessions.map((session) => session.session_id),
      active_tasks: tasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)).map((task) => task.task_id),
      local_codex_tasks: localCodexTasks.map((task) => task.task_id),
      orchestrator: "Codex CLI",
      subagents: "Codex internal logical subagents",
      source_of_truth: "local repo",
    },
  }, 1, 1);

  sessions.slice(0, 8).forEach((session, index) => {
    const sessionNodeId = `session:${session.session_id}`;
    addNode(nodes, {
      id: sessionNodeId,
      type: "session",
      label: `Session ${session.session_id.slice(0, 8)}`,
      status: session.current_status,
      visual_state: statusVisualState(session.current_status),
      badges: [channelLabel(session.channel), session.pending_action?.type ?? "no pending action"],
      summary: session.latest_codex_message || session.summary_text || session.active_task,
      detail: { session },
    }, index, 1);
    addEdge(edges, channelId(session.channel === "web_voice" ? "web_voice" : session.channel === "twilio_sms" || session.channel === "sms" ? "twilio_sms" : session.channel === "twilio_call" || session.channel === "phone" ? "twilio_call" : "web_text"), sessionNodeId, "user channel");
    addEdge(edges, sessionNodeId, "orchestrator:control-plane", "session state");

    const plannerDecision = session.planner_output ?? null;
    const planningId = session.planning_decision_id ?? plannerDecision?.planning_decision_id ?? null;
    if (planningId && plannerDecision) {
      const requestSummary = session.pending_action?.original_user_goal
        || session.active_task
        || plannerDecision.requirements_summary
        || session.summary_text;
      const requirementsSummary = plannerDecision.requirements_summary || requestSummary;
      const userRequestNodeId = `user_request:${planningId}`;
      addNode(nodes, {
        id: userRequestNodeId,
        type: "user_request",
        label: "User request",
        status: "received",
        visual_state: "completed",
        badges: [channelLabel(session.channel)],
        summary: requestSummary,
        detail: {
          session_id: session.session_id,
          user_request: requestSummary,
        },
      }, index * 8 - 0.25, 2);
      addEdge(edges, sessionNodeId, userRequestNodeId, "user request");
      const requirementNodeId = `requirement_summary:${planningId}`;
      addNode(nodes, {
        id: requirementNodeId,
        type: "requirement_summary",
        label: "Requirements",
        status: requirementsSummary ? "summarized" : "missing",
        visual_state: requirementsSummary ? "completed" : "warning",
        badges: ["planner context"],
        summary: requirementsSummary,
        detail: { session_id: session.session_id, requirements_summary: requirementsSummary },
      }, index * 8, 2);
      addEdge(edges, userRequestNodeId, requirementNodeId, "requirements");

      const decisionNodeId = `planner_decision:${planningId}`;
      addNode(nodes, {
        id: decisionNodeId,
        type: "planner_decision",
        label: plannerDecision.decision_type,
        status: session.approval_status ?? (plannerDecision.requires_user_approval ? "pending approval" : "ready"),
        visual_state: plannerDecision.requires_user_approval ? "waiting_for_approval" : plannerDecision.execution_allowed ? "planning" : "idle",
        badges: [session.planner_model ?? "planner", `${Math.round(plannerDecision.confidence * 100)}%`, plannerDecision.risk_level],
        summary: plannerDecision.reason,
        detail: { session_id: session.session_id, planner_model: session.planner_model, decision: plannerDecision },
      }, index * 8 + 1, 2);
      addEdge(edges, requirementNodeId, decisionNodeId, "planner decision");

      if (plannerDecision.subagent_advice) {
        const advisorNodeId = `subagent_advisor:${planningId}`;
        addNode(nodes, {
          id: advisorNodeId,
          type: "subagent_advisor",
          label: "Subagent advisor",
          status: plannerDecision.subagent_advice.recommended ? "use_subagents" : "single_lane_ok",
          visual_state: "completed",
          badges: ["fast Codex advisor", plannerDecision.subagent_advice.source],
          summary: plannerDecision.subagent_advice.user_check_in || plannerDecision.subagent_advice.reason,
          detail: {
            session_id: session.session_id,
            subagent_advice: plannerDecision.subagent_advice,
            kind: "subagent_advisor",
            status: plannerDecision.subagent_advice.recommended ? "use_subagents" : "single_lane_ok",
            summary: plannerDecision.subagent_advice.user_check_in || plannerDecision.subagent_advice.reason,
          },
        }, index * 8 + 1.5, 3);
        addEdge(edges, decisionNodeId, advisorNodeId, "subagent advice");
      }

      if (plannerDecision.open_questions.length || plannerDecision.decision_type === "ask_clarification") {
        const questionNodeId = `clarification_question:${planningId}`;
        addNode(nodes, {
          id: questionNodeId,
          type: "clarification_question",
          label: "Clarification",
          status: "waiting",
          visual_state: "waiting_for_approval",
          badges: [`${plannerDecision.open_questions.length || 1} question`],
          summary: plannerDecision.open_questions.join(" | ") || plannerDecision.user_visible_response,
          detail: { questions: plannerDecision.open_questions, response: plannerDecision.user_visible_response },
        }, index * 8 + 2, 3);
        addEdge(edges, decisionNodeId, questionNodeId, "ask user");
      }

      if (plannerDecision.proposed_design) {
        const designNodeId = `proposed_design:${planningId}`;
        addNode(nodes, {
          id: designNodeId,
          type: "proposed_design",
          label: "Design",
          status: "proposed",
          visual_state: "planning",
          badges: ["model proposed"],
          summary: plannerDecision.proposed_design,
          detail: { proposed_design: plannerDecision.proposed_design, assumptions: plannerDecision.assumptions },
        }, index * 8 + 3, 3);
        addEdge(edges, decisionNodeId, designNodeId, "design");
      }

      if (session.pending_action?.type === "approve_megaplan") {
        const megaplanNodeId = `megaplan:${planningId}`;
        addNode(nodes, {
          id: megaplanNodeId,
          type: "codex_plan",
          label: "Megaplan",
          status: "pending approval",
          visual_state: "waiting_for_approval",
          badges: ["megaplan skill", "approval gate"],
          summary: "The Megaplan skill created the Markdown plan and Codex is waiting for approval.",
          detail: {
            session_id: session.session_id,
            project_id: session.project_id ?? session.current_project_id,
            kind: "megaplan",
            status: "pending approval",
          },
        }, index * 8 + 3.5, 3);
        addEdge(edges, decisionNodeId, megaplanNodeId, "megaplan");
        if (plannerDecision.subagent_advice) addEdge(edges, `subagent_advisor:${planningId}`, megaplanNodeId, "advisor input");
      }

      if (plannerDecision.proposed_task_split.length) {
        const splitNodeId = `task_split_proposal:${planningId}`;
        addNode(nodes, {
          id: splitNodeId,
          type: "task_split_proposal",
          label: "Task Split",
          status: plannerDecision.requires_user_approval ? "pending approval" : "ready",
          visual_state: plannerDecision.requires_user_approval ? "waiting_for_approval" : "planning",
          badges: [`${plannerDecision.proposed_task_split.length} tasks`, `${plannerDecision.recommended_worker_count} workers`, plannerDecision.recommended_worker_mode],
          summary: plannerDecision.proposed_task_split.map((item) => item.title).join(" | "),
          detail: { proposed_task_split: plannerDecision.proposed_task_split, validation: plannerDecision.proposed_task_split.flatMap((item) => item.validation) },
        }, index * 8 + 4, 3);
        addEdge(edges, decisionNodeId, splitNodeId, "proposal");
      }

      if (session.pending_action || plannerDecision.requires_user_approval || session.approval_status) {
        const approvalNodeId = `user_approval:${planningId}`;
        const approvalStatus = session.pending_action ? "pending" : session.approval_status ?? "not_required";
        addNode(nodes, {
          id: approvalNodeId,
          type: "user_approval",
          label: "User Approval",
          status: approvalStatus,
          visual_state: approvalStatus === "approved" || approvalStatus === "not_required" ? "completed" : approvalStatus === "rejected" ? "failed" : "waiting_for_approval",
          badges: [plannerDecision.requires_user_approval ? "required" : "not required", plannerDecision.risk_level],
          summary: session.pending_action?.reason ?? plannerDecision.approval_reason ?? approvalStatus,
          detail: { session_id: session.session_id, pending_action: session.pending_action, approval_status: session.approval_status, planner_decision_id: planningId },
        }, index * 8 + 5, 4);
        addEdge(edges, session.pending_action?.type === "approve_megaplan" ? `megaplan:${planningId}` : decisionNodeId, approvalNodeId, "approval");
      }

      if (session.approved_plan) {
        const approvedNodeId = `approved_plan:${planningId}`;
        addNode(nodes, {
          id: approvedNodeId,
          type: "approved_plan",
          label: "Approved Plan",
          status: "approved",
          visual_state: "completed",
          badges: [`${session.approved_plan.worker_count} workers`, session.approved_plan.worker_mode],
          summary: session.approved_plan.requirements_summary,
          detail: { approved_plan: session.approved_plan },
        }, index * 8 + 6, 4);
        addEdge(edges, `user_approval:${planningId}`, approvedNodeId, "approved");
      }

      const linkedGraph = taskGraphs.find((graph) => graph.planning_decision_id === planningId) ?? null;
      if (linkedGraph) {
        const executionNodeId = `execution_start:${planningId}`;
        addNode(nodes, {
          id: executionNodeId,
          type: "execution_start",
          label: "Execution Start",
          status: linkedGraph.status,
          visual_state: statusVisualState(linkedGraph.status),
          badges: [linkedGraph.execution_strategy, `${linkedGraph.nodes.length} nodes`],
          summary: `Task graph ${linkedGraph.task_graph_id} created from planner decision ${planningId}.`,
          detail: { task_graph_id: linkedGraph.task_graph_id, planning_decision_id: planningId },
        }, index * 8 + 7, 4);
        addEdge(edges, session.approved_plan ? `approved_plan:${planningId}` : `planner_decision:${planningId}`, executionNodeId, "execution");
        addEdge(edges, executionNodeId, `task_graph:${linkedGraph.task_graph_id}`, "task graph");
      }
    }
  });

  projects.slice(0, 8).forEach((project, index) => {
    const task = latestTaskForProject(tasks, project.project_id);
    const projectNodeId = `project:${project.project_id}`;
    addNode(nodes, {
      id: projectNodeId,
      type: "project",
      label: project.display_name,
      status: task?.status ?? "idle",
      visual_state: statusVisualState(task?.status ?? "idle"),
      badges: [project.repo_name ?? "workspace", project.git_branch ?? "no branch"],
      summary: task ? `${task.task_id}: ${task.user_goal}` : project.workspace_path,
      detail: { project, latest_task: task },
    }, index, 2);
    addEdge(edges, "orchestrator:control-plane", projectNodeId, "project");

    const docsDir = project.docs_path || path.join(project.workspace_path, ".head-developer");
    const docsExist = fs.existsSync(docsDir);
    const docsStatus = docsExist ? project.docs_fresh === false ? "stale" : "indexed" : "missing";
    const docsNodeId = `project_docs:${project.project_id}`;
    addNode(nodes, {
      id: docsNodeId,
      type: "project_docs",
      label: ".head-developer docs",
      status: docsStatus,
      visual_state: docsStatus === "stale" ? "warning" : docsStatus === "missing" ? "failed" : "completed",
      badges: [docsExist ? "project memory" : "missing", project.docs_fresh === false ? "stale" : "fresh"],
      summary: docsDir,
      detail: {
        project_id: project.project_id,
        docs_path: docsDir,
        indexed_at: project.documentation_indexed_at ?? null,
        docs_fresh: project.docs_fresh ?? null,
        stale_reasons: project.docs_stale_reasons ?? [],
      },
    }, index, 4);
    addEdge(edges, projectNodeId, docsNodeId, "project docs");

    const docNodes: Array<{ type: FlowchartNode["type"]; id: string; file: string; label: string }> = [
      { type: "code_index", id: `code_index:${project.project_id}`, file: "CODE_INDEX.md", label: "Code Index" },
      { type: "function_docs", id: `function_docs:${project.project_id}`, file: "FUNCTIONS.md", label: "Function Docs" },
      { type: "variable_docs", id: `variable_docs:${project.project_id}`, file: "VARIABLES.md", label: "Variable Docs" },
      { type: "state_model_docs", id: `state_model_docs:${project.project_id}`, file: "STATE_MODEL.md", label: "State Model Docs" },
      { type: "worker_handoff", id: `worker_handoff:${project.project_id}`, file: "WORKER_HANDOFFS.md", label: "Worker Handoff" },
    ];
    docNodes.forEach((doc, docIndex) => {
      const target = path.join(docsDir, doc.file);
      const exists = fs.existsSync(target);
      addNode(nodes, {
        id: doc.id,
        type: doc.type,
        label: doc.label,
        status: exists ? "available" : "missing",
        visual_state: exists ? "completed" : "warning",
        badges: [`.head-developer/${doc.file}`],
        summary: target,
        detail: {
          project_id: project.project_id,
          file: `.head-developer/${doc.file}`,
          path: target,
          exists,
          content_preview: exists ? preview(fs.readFileSync(target, "utf8"), 600) : "",
        },
      }, index * 6 + docIndex, 5);
      addEdge(edges, docsNodeId, doc.id, "docs section");
    });
  });

  tasks.slice(0, 10).forEach((task, index) => {
    const taskNodeId = `task:${task.task_id}`;
    addNode(nodes, {
      id: taskNodeId,
      type: "task",
      label: `Task ${task.task_id.slice(5, 13)}`,
      status: task.status,
      visual_state: statusVisualState(task.status),
      badges: task.execution_backend === "codex_session_local"
        ? ["one local Codex orchestrator", `${task.command_count} commands`]
        : [task.worker_id ? "assigned" : "unassigned", `${task.command_count} commands`],
      summary: task.user_goal,
      detail: {
        task,
        commands: commands.filter((command) => command.task_id === task.task_id),
        summary: summaryForTask(summaries, task.task_id),
      },
    }, index, 3);
    addEdge(edges, "orchestrator:control-plane", taskNodeId, "task");
    addEdge(edges, `project:${task.project_id}`, taskNodeId, "latest task");
  });

  localCodexTasks.slice(0, 8).forEach((task, index) => {
    const generatedSummary = localCodexFlowchartSummary(task);
    if (generatedSummary?.nodes.length) {
      const summary = generatedSummary;
      const summaryNodeIds = new Set(summary.nodes.map((node) => node.id));
      const perKindCount = new Map<string, number>();
      const firstNode = summary.nodes[0];
      summary.nodes.forEach((node, nodeIndex) => {
        const kindIndex = perKindCount.get(node.kind) ?? 0;
        perKindCount.set(node.kind, kindIndex + 1);
        const nodeId = `codex_flow:${task.task_id}:${node.id}`;
        addNode(nodes, {
          id: nodeId,
          type: localSummaryNodeType(node.kind),
          label: summaryText(node.label, 64),
          status: summaryText(node.status, 48),
          visual_state: localSummaryVisualState(node.status),
          badges: node.kind === "subagent" ? ["Codex-chosen subagent"] : [node.kind.replace(/_/g, " ")],
          summary: summaryText(node.summary),
          detail: {
            kind: node.kind,
            label: summaryText(node.label, 120),
            status: summaryText(node.status, 80),
            summary: summaryText(node.summary, 500),
            flowchart_title: summaryText(summary.title, 120),
            flowchart_overview: summaryText(summary.overview, 500),
          },
        }, index * 12 + kindIndex + nodeIndex * 0.01, localSummaryColumn(node.kind));
      });
      if (firstNode) addEdge(edges, "orchestrator:control-plane", `codex_flow:${task.task_id}:${firstNode.id}`, "Codex summary");
      for (const node of summary.nodes) {
        for (const dependency of node.depends_on) {
          if (summaryNodeIds.has(dependency)) addEdge(edges, `codex_flow:${task.task_id}:${dependency}`, `codex_flow:${task.task_id}:${node.id}`, "next");
        }
      }
      for (const edge of summary.edges) {
        if (summaryNodeIds.has(edge.from) && summaryNodeIds.has(edge.to)) {
          addEdge(edges, `codex_flow:${task.task_id}:${edge.from}`, `codex_flow:${task.task_id}:${edge.to}`, summaryText(edge.label, 32) || "next");
        }
      }
      const liveSubagents = (task.codex_subagents ?? []).filter((subagent) => subagent.name?.trim());
      if (liveSubagents.length && !summary.nodes.some((node) => node.kind === "subagent")) {
        const codexSessionSummaryNode = summary.nodes.find((node) => node.kind === "codex_session");
        const sessionNodeId = codexSessionSummaryNode
          ? `codex_flow:${task.task_id}:${codexSessionSummaryNode.id}`
          : `codex_flow:${task.task_id}:live-codex-session`;
        if (!codexSessionSummaryNode) {
          addNode(nodes, {
            id: sessionNodeId,
            type: "codex_session",
            label: "Codex CLI session",
            status: task.status,
            visual_state: statusVisualState(task.status),
            badges: ["live Codex updates"],
            summary: "Codex has reported live internal subagent updates for this local session.",
            detail: {
              kind: "codex_session",
              status: task.status,
              summary: "Codex has reported live internal subagent updates for this local session.",
            },
          }, index * 12, 5);
          if (firstNode) addEdge(edges, `codex_flow:${task.task_id}:${firstNode.id}`, sessionNodeId, "Codex session");
        }
        liveSubagents.forEach((subagent, subagentIndex) => {
          const subagentId = summaryText(subagent.name, 48).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `subagent-${subagentIndex + 1}`;
          const nodeId = `codex_flow:${task.task_id}:live-${subagentId}`;
          addNode(nodes, {
            id: nodeId,
            type: "codex_subagent",
            label: summaryText(subagent.name, 64),
            status: summaryText(subagent.status, 48),
            visual_state: localSummaryVisualState(subagent.status),
            badges: ["Codex-chosen subagent"],
            summary: summaryText(subagent.summary || subagent.responsibility),
            detail: {
              kind: "subagent",
              label: summaryText(subagent.name, 120),
              status: summaryText(subagent.status, 80),
              summary: summaryText(subagent.summary || subagent.responsibility, 500),
            },
          }, index * 12 + subagentIndex + 1, 6);
          addEdge(edges, sessionNodeId, nodeId, "subagent");
        });
      }
      return;
    }

    const pendingRequestNodeId = `codex_flow_pending:${task.task_id}:user-request`;
    const pendingRequirementsNodeId = `codex_flow_pending:${task.task_id}:requirements`;
    const sessionNodeId = `codex_flow_pending:${task.task_id}:codex-session`;
    const liveSubagents = (task.codex_subagents ?? []).filter((subagent) => subagent.name?.trim());
    const subagentAdvisor = task.codex_subagent_advisor ?? null;
    const qualityCheck = task.codex_quality_check ?? null;
    const pendingSummary = task.status === "running"
      ? liveSubagents.length
        ? "Live Codex subagent updates are visible while the parallel flowchart JSON is being regenerated."
        : "A separate short-lived Codex session is generating this browser flowchart from live implementation updates."
      : "This local Codex run does not have a generated flowchart summary yet.";
    addNode(nodes, {
      id: pendingRequestNodeId,
      type: "user_request",
      label: "User request",
      status: "received",
      visual_state: "completed",
      badges: ["request"],
      summary: summaryText(task.user_goal),
      detail: {
        kind: "user_request",
        status: "received",
        summary: summaryText(task.user_goal, 500),
      },
    }, index * 12, 1);
    addNode(nodes, {
      id: pendingRequirementsNodeId,
      type: "requirement_summary",
      label: "Requirements",
      status: task.status === "running" ? "summarized" : "pending",
      visual_state: task.status === "running" ? "completed" : "planning",
      badges: ["requirements"],
      summary: summaryText(task.user_goal),
      detail: {
        kind: "requirement_summary",
        status: task.status === "running" ? "summarized" : "pending",
        summary: summaryText(task.user_goal, 500),
      },
    }, index * 12 + 0.1, 2);
    const pendingMegaplanNodeId = `codex_flow_pending:${task.task_id}:megaplan`;
    addNode(nodes, {
      id: pendingMegaplanNodeId,
      type: "codex_plan",
      label: "Megaplan skill",
      status: "created",
      visual_state: "completed",
      badges: ["megaplan skill"],
      summary: "Codex turns clarified requirements into an approval-ready Megaplan.",
      detail: {
        kind: "megaplan",
        status: "created",
        summary: "Codex turns clarified requirements into an approval-ready Megaplan.",
      },
    }, index * 12 + 0.2, 3);
    const pendingApprovalNodeId = `codex_flow_pending:${task.task_id}:approval-gate`;
    addNode(nodes, {
      id: pendingApprovalNodeId,
      type: "user_approval",
      label: "Approval gate",
      status: "approved",
      visual_state: "completed",
      badges: ["approval gate"],
      summary: "Complex work waits for user approval before implementation starts.",
      detail: {
        kind: "approval",
        status: "approved",
        summary: "Complex work waits for user approval before implementation starts.",
      },
    }, index * 12 + 0.3, 4);
    addNode(nodes, {
      id: sessionNodeId,
      type: "codex_session",
      label: "Codex CLI session",
      status: task.status === "running" ? "running" : "summary pending",
      visual_state: task.status === "running" ? "running" : "planning",
      badges: [liveSubagents.length ? "live Codex updates" : "one local Codex session"],
      summary: pendingSummary,
      detail: {
        kind: "codex_session",
        status: task.status === "running" ? "running" : "summary pending",
        summary: pendingSummary,
      },
    }, index * 12 + 0.4, 5);
    addEdge(edges, "orchestrator:control-plane", pendingRequestNodeId, "request");
    addEdge(edges, pendingRequestNodeId, pendingRequirementsNodeId, "requirements");
    addEdge(edges, pendingRequirementsNodeId, pendingMegaplanNodeId, "megaplan");
    addEdge(edges, pendingMegaplanNodeId, pendingApprovalNodeId, "approval");
    addEdge(edges, pendingApprovalNodeId, sessionNodeId, "starts");
    const pendingSubagentAdvisorNodeId = `codex_flow_pending:${task.task_id}:subagent-advisor`;
    addNode(nodes, {
      id: pendingSubagentAdvisorNodeId,
      type: "subagent_advisor",
      label: "Subagent advisor",
      status: subagentAdvisor?.status ?? (task.status === "running" ? "watching" : "summary pending"),
      visual_state: task.status === "running" ? "running" : "planning",
      badges: ["parallel Codex advisor"],
      summary: subagentAdvisor
        ? summaryText(subagentAdvisorSummaryTextForFlowchart(subagentAdvisor))
        : "Separate short-lived Codex process watches for places where Codex could use internal subagents.",
      detail: {
        kind: "subagent_advisor",
        status: subagentAdvisor?.status ?? (task.status === "running" ? "watching" : "summary pending"),
        summary: subagentAdvisor
          ? summaryText(subagentAdvisorSummaryTextForFlowchart(subagentAdvisor), 500)
          : "Separate short-lived Codex process watches for places where Codex could use internal subagents.",
      },
    }, index * 12 + 0.6, 6);
    addEdge(edges, sessionNodeId, pendingSubagentAdvisorNodeId, "subagent advice");
    const pendingFlowchartMakerNodeId = `codex_flow_pending:${task.task_id}:flowchart-maker`;
    addNode(nodes, {
      id: pendingFlowchartMakerNodeId,
      type: "flowchart_maker",
      label: "Flowchart maker",
      status: task.status === "running" ? "running" : "summary pending",
      visual_state: task.status === "running" ? "running" : "planning",
      badges: ["parallel Codex flowchart"],
      summary: "Separate short-lived Codex process turns live implementation summaries into this graph.",
      detail: {
        kind: "flowchart_maker",
        status: task.status === "running" ? "running" : "summary pending",
        summary: "Separate short-lived Codex process turns live implementation summaries into this graph.",
      },
    }, index * 12 + 0.75, 7);
    addEdge(edges, sessionNodeId, pendingFlowchartMakerNodeId, "flowchart");
    addEdge(edges, pendingSubagentAdvisorNodeId, pendingFlowchartMakerNodeId, "advisor input");
    const pendingValidationNodeId = `codex_flow_pending:${task.task_id}:validation`;
    addNode(nodes, {
      id: pendingValidationNodeId,
      type: "validation",
      label: "Validation",
      status: task.local_validation_result?.status ?? (task.status === "running" ? "waiting" : "summary pending"),
      visual_state: task.local_validation_result ? localSummaryVisualState(task.local_validation_result.status) : "planning",
      badges: ["local validation"],
      summary: task.local_validation_result?.summary
        ? summaryText(task.local_validation_result.summary)
        : "Local validation waits for Codex implementation output.",
      detail: {
        kind: "validation",
        status: task.local_validation_result?.status ?? (task.status === "running" ? "waiting" : "summary pending"),
        summary: task.local_validation_result?.summary
          ? summaryText(task.local_validation_result.summary, 500)
          : "Local validation waits for Codex implementation output.",
      },
    }, index * 12 + 0.9, 8);
    addEdge(edges, sessionNodeId, pendingValidationNodeId, "validation");
    const pendingPreviewNodeId = `codex_flow_pending:${task.task_id}:preview`;
    addNode(nodes, {
      id: pendingPreviewNodeId,
      type: "preview",
      label: "Preview",
      status: task.latest_preview?.status ?? "waiting",
      visual_state: task.latest_preview ? previewVisualState(task.latest_preview) : "planning",
      badges: ["local preview"],
      summary: task.latest_preview?.summary
        ? summaryText(task.latest_preview.summary)
        : "Local preview starts when validation passes and an app entry is available.",
      detail: {
        kind: "preview",
        status: task.latest_preview?.status ?? "waiting",
        summary: task.latest_preview?.summary
          ? summaryText(task.latest_preview.summary, 500)
          : "Local preview starts when validation passes and an app entry is available.",
      },
    }, index * 12 + 0.95, 9);
    addEdge(edges, pendingValidationNodeId, pendingPreviewNodeId, "preview");
    const pendingQualityNodeId = `codex_flow_pending:${task.task_id}:quality-check`;
    addNode(nodes, {
      id: pendingQualityNodeId,
      type: "quality_check",
      label: "Quality check",
      status: qualityCheck?.status ?? "waiting",
      visual_state: qualityCheck ? localSummaryVisualState(qualityCheck.status) : "planning",
      badges: ["final Codex reviewer"],
      summary: qualityCheck?.summary
        ? summaryText(qualityCheck.summary)
        : "Final Codex quality checker verifies Megaplan fit, functionality, validation evidence, and UI quality.",
      detail: {
        kind: "quality_check",
        status: qualityCheck?.status ?? "waiting",
        summary: qualityCheck?.summary
          ? summaryText(qualityCheck.summary, 500)
          : "Final Codex quality checker verifies Megaplan fit, functionality, validation evidence, and UI quality.",
      },
    }, index * 12 + 1, 10);
    addEdge(edges, pendingPreviewNodeId, pendingQualityNodeId, "quality check");
    const pendingFinalNodeId = `codex_flow_pending:${task.task_id}:final-summary`;
    addNode(nodes, {
      id: pendingFinalNodeId,
      type: "final_summary",
      label: "Final summary",
      status: task.final_summary ? task.status : "waiting",
      visual_state: task.final_summary ? statusVisualState(task.status) : "planning",
      badges: ["grounded summary"],
      summary: task.final_summary ? summaryText(task.final_summary) : "Final summary waits for validation and quality-check evidence.",
      detail: {
        kind: "final_summary",
        status: task.final_summary ? task.status : "waiting",
        summary: task.final_summary ? summaryText(task.final_summary, 500) : "Final summary waits for validation and quality-check evidence.",
      },
    }, index * 12 + 1.05, 11);
    addEdge(edges, pendingQualityNodeId, pendingFinalNodeId, "final summary");
    liveSubagents.forEach((subagent, subagentIndex) => {
      const subagentId = summaryText(subagent.name, 48).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || `subagent-${subagentIndex + 1}`;
      const nodeId = `codex_flow:${task.task_id}:live-${subagentId}`;
      addNode(nodes, {
        id: nodeId,
        type: "codex_subagent",
        label: summaryText(subagent.name, 64),
        status: summaryText(subagent.status, 48),
        visual_state: localSummaryVisualState(subagent.status),
        badges: ["Codex-chosen subagent"],
        summary: summaryText(subagent.summary || subagent.responsibility),
        detail: {
          kind: "subagent",
          label: summaryText(subagent.name, 120),
          status: summaryText(subagent.status, 80),
          summary: summaryText(subagent.summary || subagent.responsibility, 500),
        },
      }, index * 12 + subagentIndex + 1, 7);
      addEdge(edges, sessionNodeId, nodeId, "subagent");
    });
  });

  taskGraphs.slice(0, 6).forEach((graph, index) => {
    const graphNodeId = `task_graph:${graph.task_graph_id}`;
    addNode(nodes, {
      id: graphNodeId,
      type: "task_graph",
      label: `Task Graph ${graph.task_graph_id.slice(11, 19)}`,
      status: graph.status,
      visual_state: statusVisualState(graph.status),
      badges: [graph.complexity.complexity, graph.execution_strategy, `${graph.nodes.length} subtasks`],
      summary: graph.complexity.reason,
      detail: { task_graph: graph, recommended_worker_count: graph.recommended_worker_count },
    }, index, 3);
    addEdge(edges, "orchestrator:control-plane", graphNodeId, "task graph");
    addEdge(edges, `project:${graph.project_id}`, graphNodeId, "project plan");

    const project = projects.find((item) => item.project_id === graph.project_id);
    if (project?.docs_path) {
      const docsNodeId = `shared_docs:${project.project_id}`;
      addNode(nodes, {
        id: docsNodeId,
        type: "shared_docs",
        label: ".head-developer docs",
        status: "updated",
        visual_state: "completed",
        badges: ["shared context", "project memory"],
        summary: project.docs_path,
        detail: {
          docs_path: project.docs_path,
          shared_context_path: project.shared_context_path,
          files: ["PROJECT_BRIEF.md", "TASK_GRAPH.md", "ARCHITECTURE.md", "WORKER_HANDOFFS.md", "DECISIONS.md", "RUNBOOK.md", "VALIDATION.md"],
        },
      }, index, 4);
      addEdge(edges, `project:${project.project_id}`, docsNodeId, "shared docs");
      addEdge(edges, docsNodeId, graphNodeId, "context");
    }

    graph.nodes.slice(0, 10).forEach((node, nodeIndex) => {
      const nodeId = `task_graph_node:${node.node_id}`;
      const packet = contextPackets.find((item) => item.task_id === node.task_id || item.node_id === node.node_id) ?? null;
      addNode(nodes, {
        id: nodeId,
        type: "task_graph_node",
        label: node.title,
        status: node.status,
        visual_state: statusVisualState(node.status),
        badges: [
          node.dependencies.length ? `${node.dependencies.length} deps` : "ready",
          node.assigned_worker_id ? "assigned" : "unassigned",
          node.worktree_path ? "worktree" : "main repo",
        ],
        summary: node.goal,
        detail: { task_graph_node: node, context_packet: packet },
      }, index * 10 + nodeIndex, 4);
      addEdge(edges, graphNodeId, nodeId, "subtask");
      addEdge(edges, nodeId, `task:${node.task_id}`, "task record");
      addEdge(edges, `project_docs:${graph.project_id}`, nodeId, "docs -> next worker context");
      addEdge(edges, `code_index:${graph.project_id}`, nodeId, "code context");
      addEdge(edges, `function_docs:${graph.project_id}`, nodeId, "function context");
      addEdge(edges, `variable_docs:${graph.project_id}`, nodeId, "variable context");
      addEdge(edges, `state_model_docs:${graph.project_id}`, nodeId, "state context");
      if (node.assigned_worker_id) addEdge(edges, nodeId, `worker:${node.assigned_worker_id}`, "assigned worker");
      if (node.worktree_path) {
        const worktreeNodeId = `worktree:${node.node_id}`;
        addNode(nodes, {
          id: worktreeNodeId,
          type: "worktree",
          label: node.branch_name ?? "Worker worktree",
          status: "assigned",
          visual_state: "running",
          badges: ["isolated writes"],
          summary: node.worktree_path,
          detail: { branch_name: node.branch_name, worktree_path: node.worktree_path, task_id: node.task_id, worker_id: node.assigned_worker_id ?? null },
        }, index * 10 + nodeIndex, 5);
        addEdge(edges, nodeId, worktreeNodeId, "writes");
        if (node.assigned_worker_id) addEdge(edges, `worker:${node.assigned_worker_id}`, worktreeNodeId, "workspace");
      }
    });

    if (graph.nodes.length > 1) {
      const reviewNodeId = `merge_review:${graph.task_graph_id}`;
      addNode(nodes, {
        id: reviewNodeId,
        type: "merge_review",
        label: "Merge / Review",
        status: graph.status === "completed" ? "completed" : graph.status === "failed" ? "failed" : "waiting",
        visual_state: graph.status === "completed" ? "completed" : graph.status === "failed" ? "failed" : "planning",
        badges: [graph.execution_strategy],
        summary: "Collect worker outputs, detect merge conflicts, and produce the global summary.",
        detail: { task_graph_id: graph.task_graph_id, strategy: graph.execution_strategy },
      }, index, 9);
      for (const node of graph.nodes) addEdge(edges, `task_graph_node:${node.node_id}`, reviewNodeId, "review");
    }
  });

  workers.slice(0, 10).forEach((worker, index) => {
    const command = latestCommandForWorker(commands, worker.worker_id);
    const currentTask = taskForWorker(tasks, worker);
    const workerNodeId = `worker:${worker.worker_id}`;
    const stale = workerHeartbeatIsStale(worker, currentTask, nowMs, 60_000);
    const imageMismatch = workerImageMismatch(worker);
    const vmNameMismatch = workerVmNameMismatch(worker);
    const recordedImage = worker.recorded_image_uri ?? worker.image_uri;
    const actualImage = worker.actual_image_uri ?? worker.runtime_image_uri;
    const runtimeImageSummary = imageMismatch
      ? `Recorded image ${preview(recordedImage, 54)} differs from actual runtime image ${preview(actualImage ?? "", 54)}.`
      : "";
    addNode(nodes, {
      id: workerNodeId,
      type: "worker",
      label: `Worker ${worker.worker_id.slice(7, 15)}`,
      status: stale ? "stale heartbeat" : imageMismatch ? "image mismatch" : vmNameMismatch ? "vm name mismatch" : worker.status,
      visual_state: workerVisualState(worker, currentTask, nowMs),
      badges: [
        worker.type.toUpperCase().replace("_", " "),
        stale ? "STALE" : imageMismatch ? "IMAGE MISMATCH" : worker.status.toUpperCase(),
        worker.startup_attempt_id ? `attempt ${worker.startup_attempt_id}` : "",
      ].filter(Boolean),
      summary: runtimeImageSummary || (command?.command ? preview(command.command) : "No active command."),
      detail: {
        worker,
        mode: worker.type,
        vm_name: worker.actual_vm_name ?? worker.runtime_vm_name ?? worker.vm_name ?? null,
        recorded_vm_name: worker.recorded_vm_name ?? null,
        actual_vm_name: worker.actual_vm_name ?? worker.runtime_vm_name ?? null,
        runtime_vm_name: worker.runtime_vm_name ?? worker.actual_vm_name ?? null,
        vm_name_mismatch: vmNameMismatch,
        machine_type: worker.machine_type ?? null,
        image_uri: worker.image_uri,
        worker_mode: worker.actual_worker_mode ?? worker.type,
        actual_worker_mode: worker.actual_worker_mode ?? worker.type,
        recorded_image_uri: recordedImage,
        actual_image_uri: actualImage ?? null,
        runtime_image_uri: worker.runtime_image_uri ?? worker.actual_image_uri ?? null,
        actual_image_digest: worker.actual_image_digest ?? worker.runtime_image_digest ?? null,
        runtime_image_digest: worker.runtime_image_digest ?? worker.actual_image_digest ?? null,
        image_mismatch: imageMismatch,
        startup_attempt_id: worker.startup_attempt_id ?? null,
        run_attempt_id: worker.run_attempt_id ?? worker.startup_attempt_id ?? null,
        container_started_at: worker.container_started_at ?? null,
        worker_runtime_version: worker.worker_runtime_version ?? null,
        docker_container_id: worker.docker_container_id ?? null,
        docker_container_name: worker.docker_container_name ?? null,
        codex_home: worker.codex_home ?? null,
        codex_home_host_path: worker.codex_home_host_path ?? null,
        codex_history_sessions_path: worker.codex_history_sessions_path ?? null,
        codex_auth_method: worker.codex_auth_method ?? null,
        codex_auth_secret_resource: worker.codex_auth_secret_resource ?? null,
        codex_auth_validated_at: worker.codex_auth_validated_at ?? null,
        codex_auth_validation_status: worker.codex_auth_validation_status ?? null,
        metadata_verified_from_runtime: Boolean(worker.metadata_verified_from_runtime),
        last_runtime_report_at: worker.last_runtime_report_at ?? worker.runtime_metadata_updated_at ?? null,
        runtime_metadata_updated_at: worker.runtime_metadata_updated_at ?? worker.last_runtime_report_at ?? null,
        current_task: currentTask,
        heartbeat: worker.heartbeat_at,
        uptime_ms: Math.max(0, nowMs - Date.parse(worker.created_at)),
        logs: commands.filter((commandEvent) => commandEvent.worker_id === worker.worker_id).map((commandEvent) => commandEvent.summary),
      },
    }, index, 4);
    if (worker.task_id) addEdge(edges, `task:${worker.task_id}`, workerNodeId, "assigned worker");
  });

  mcpCalls.slice(-12).reverse().forEach((call, index) => {
    const nodeId = `mcp:${call.mcp_call_id}`;
    addNode(nodes, {
      id: nodeId,
      type: "mcp_action",
      label: call.tool_name,
      status: call.status,
      visual_state: call.status === "failed" ? "failed" : call.status === "running" ? "running" : "completed",
      badges: [call.mcp_server, call.ended_at ? `${durationMs(call.started_at, call.ended_at) ?? 0}ms` : "running"],
      summary: call.error ? call.error : call.result_summary || "MCP tool call recorded.",
      detail: {
        mcp_call: call,
        tool_name: call.tool_name,
        server: call.mcp_server,
        duration_ms: call.ended_at ? durationMs(call.started_at, call.ended_at) : durationMs(call.started_at, null),
        linked_task: call.task_id ? tasks.find((task) => task.task_id === call.task_id) ?? null : null,
        linked_worker: call.worker_id ? workers.find((worker) => worker.worker_id === call.worker_id) ?? null : null,
        linked_project: call.project_id ? projects.find((project) => project.project_id === call.project_id) ?? null : null,
      },
    }, index, 6);
    addEdge(edges, "orchestrator:control-plane", nodeId, "mcp action");
    if (call.project_id) addEdge(edges, `project:${call.project_id}`, nodeId, "mcp project");
    if (call.task_id) addEdge(edges, `task:${call.task_id}`, nodeId, "mcp task");
    if (call.worker_id) addEdge(edges, nodeId, `worker:${call.worker_id}`, "mcp worker");
  });

  operatorActions.slice(-14).reverse().forEach((action, index) => {
    const nodeId = `operator_action:${action.action_id}`;
    addNode(nodes, {
      id: nodeId,
      type: actionNodeType(action),
      label: action.action_type,
      status: action.status,
      visual_state: statusVisualState(action.status),
      badges: [
        action.risk_level,
        action.requires_approval ? "approval" : "typed action",
        action.completed_at ? `${durationMs(action.started_at, action.completed_at) ?? 0}ms` : "running",
      ],
      summary: action.error ?? (typeof action.result?.message === "string" ? action.result.message : action.user_goal),
      detail: {
        operator_action: action,
        user_request: action.user_goal,
        parsed_intent: action.normalized_intent,
        action_type: action.action_type,
        target_worker: action.worker_id ? workers.find((worker) => worker.worker_id === action.worker_id) ?? null : null,
        target_task: action.task_id ? tasks.find((task) => task.task_id === action.task_id) ?? null : null,
        target_command: action.command_id ? commands.find((command) => command.event_id === action.command_id) ?? null : null,
        risk_level: action.risk_level,
        approval_status: action.approval_id ? approvals.find((approval) => approval.approval_id === action.approval_id)?.status ?? "unknown" : "not_required",
        result: action.result,
        error: action.error,
      },
    }, index, 5);
    addEdge(edges, `session:${action.session_id}`, nodeId, "user message");
    addEdge(edges, nodeId, "orchestrator:control-plane", "typed action");
    if (action.project_id) addEdge(edges, nodeId, `project:${action.project_id}`, "project");
    if (action.task_id) addEdge(edges, nodeId, `task:${action.task_id}`, "task");
    if (action.worker_id) addEdge(edges, nodeId, `worker:${action.worker_id}`, "worker");
    if (action.command_id) addEdge(edges, nodeId, `command:${action.command_id}`, "command event");
    if (action.approval_id) addEdge(edges, nodeId, `approval:${action.approval_id}`, "approval");
  });

  commands.slice(-12).reverse().forEach((command, index) => {
    const commandNodeId = `command:${command.event_id}`;
    addNode(nodes, {
      id: commandNodeId,
      type: "command",
      label: preview(command.command, 42) || "Command",
      status: command.exit_code === null ? "running" : `exit ${command.exit_code}`,
      visual_state: commandVisualState(command),
      badges: [command.risk_level, command.exit_code === null ? "running" : `exit ${command.exit_code}`],
      summary: command.summary,
      detail: {
        command,
        duration_ms: durationMs(command.started_at, command.ended_at),
        worker_mode: command.worker_mode ?? null,
        actual_image_uri: command.actual_image_uri ?? null,
        actual_image_digest: command.actual_image_digest ?? null,
        vm_name: command.vm_name ?? null,
        startup_attempt_id: command.startup_attempt_id ?? null,
        run_attempt_id: command.run_attempt_id ?? null,
        container_started_at: command.container_started_at ?? null,
        worker_runtime_version: command.worker_runtime_version ?? null,
        docker_container_id: command.docker_container_id ?? null,
        docker_container_name: command.docker_container_name ?? null,
        runtime_metadata_verified: Boolean(command.runtime_metadata_verified),
        codex_session_id: command.codex_session_id ?? null,
        codex_rollout_path: command.codex_rollout_path ?? null,
        codex_rollout_host_path: command.codex_rollout_host_path ?? null,
        codex_rollout_relative_path: command.codex_rollout_relative_path ?? null,
        codex_home: command.codex_home ?? null,
        codex_home_host_path: command.codex_home_host_path ?? null,
        codex_auth_method: command.codex_auth_method ?? null,
        codex_auth_secret_resource: command.codex_auth_secret_resource ?? null,
        codex_auth_validated_at: command.codex_auth_validated_at ?? null,
        codex_auth_validation_status: command.codex_auth_validation_status ?? null,
        codex_history_kind: command.codex_history_kind ?? null,
        codex_resume_command: command.codex_resume_command ?? null,
        codex_prompt_excerpt: command.codex_prompt_excerpt ?? null,
        codex_model: command.codex_model ?? null,
        codex_started_at: command.codex_started_at ?? null,
        codex_completed_at: command.codex_completed_at ?? null,
        codex_history_confidence: command.codex_history_confidence ?? null,
        codex_history_verification_command: command.codex_history_verification_command ?? null,
        codex_visibility_mirror_created: Boolean(command.codex_visibility_mirror_created),
        stdout: command.stdout_preview,
        stderr: command.stderr_preview,
      },
    }, index, 7);
    addEdge(edges, `worker:${command.worker_id}`, commandNodeId, "runs");
    if (command.worker_id === "codex_session_local" || command.worker_mode === "codex_session_local") {
      addEdge(edges, `codex_session:${command.task_id}`, commandNodeId, "runs");
    }
    const artifactNodeId = `artifact:${command.event_id}`;
    addNode(nodes, {
      id: artifactNodeId,
      type: "artifact",
      label: "Files / Logs / Results",
      status: command.exit_code === 0 ? "recorded" : command.exit_code === null ? "streaming" : "needs review",
      visual_state: command.exit_code === 0 ? "completed" : command.exit_code === null ? "running" : "warning",
      badges: [command.stdout_ref || command.stderr_ref ? "log refs" : "previews"],
      summary: preview(command.stdout_preview || command.stderr_preview || command.summary),
      detail: { stdout_ref: command.stdout_ref, stderr_ref: command.stderr_ref, stdout_preview: command.stdout_preview, stderr_preview: command.stderr_preview },
    }, index, 8);
    addEdge(edges, commandNodeId, artifactNodeId, "files/logs/results");
  });

  const previews = tasks
    .map((task) => task.latest_preview)
    .filter((item): item is PreviewMetadata => Boolean(item))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  previews.slice(0, 10).forEach((item, index) => {
    const previewNodeId = `preview:${item.preview_id}`;
    addNode(nodes, {
      id: previewNodeId,
      type: "preview",
      label: `Preview ${item.preview_id.slice(8, 16)}`,
      status: item.status,
      visual_state: previewVisualState(item),
      badges: [item.server_type, item.loaded ? "loaded" : "not loaded", item.console_errors.length ? `${item.console_errors.length} errors` : "no console errors"],
      summary: item.summary,
      detail: { preview: item, url: item.preview_url, files: [item.entry_file, ...item.asset_paths] },
    }, index, 9);
    addEdge(edges, `task:${item.task_id}`, previewNodeId, "preview");
    if (item.command_event_id) addEdge(edges, `command:${item.command_event_id}`, previewNodeId, "preview command");
  });

  summaries.slice(0, 10).forEach((summary, index) => {
    const summaryNodeId = `summary:${summary.task_id}`;
    addNode(nodes, {
      id: summaryNodeId,
      type: "summary",
      label: `Summary ${summary.task_id.slice(5, 13)}`,
      status: summary.current_state,
      visual_state: statusVisualState(summary.current_state),
      badges: [summary.confidence],
      summary: summary.executive_summary,
      detail: { summary, next_action: summary.next_plan[0] ?? "" },
    }, index, 10);
    addEdge(edges, `task:${summary.task_id}`, summaryNodeId, "summary");
    const taskCommands = commands.filter((command) => command.task_id === summary.task_id);
    for (const command of taskCommands.slice(-2)) addEdge(edges, `artifact:${command.event_id}`, summaryNodeId, "results");
    const previewForSummary = previews.find((item) => item.task_id === summary.task_id);
    if (previewForSummary) addEdge(edges, `preview:${previewForSummary.preview_id}`, summaryNodeId, "preview result");
  });

  const sessionApprovals = sessions.flatMap((session) => session.pending_approvals.map((approval: PendingApproval) => ({ session, approval })));
  [...approvals.map((approval) => ({ approval, session: null })), ...sessionApprovals]
    .filter((item) => item.approval.status === "pending")
    .slice(0, 8)
    .forEach((item, index) => {
      const approvalId = "approval_id" in item.approval ? item.approval.approval_id : item.approval.id;
      const requestedAction = "requested_action" in item.approval ? item.approval.requested_action : item.approval.command;
      const approvalNodeId = `approval:${approvalId}`;
      addNode(nodes, {
        id: approvalNodeId,
        type: "approval",
        label: "Approval Required",
        status: "pending",
        visual_state: "waiting_for_approval",
        badges: ["pending", "user decision"],
        summary: requestedAction,
        detail: { approval: item.approval, session_id: item.session?.session_id ?? null },
      }, index, 11);
      if (item.session) addEdge(edges, approvalNodeId, channelId(item.session.channel === "web_voice" ? "web_voice" : item.session.channel === "twilio_sms" ? "twilio_sms" : item.session.channel === "twilio_call" ? "twilio_call" : "web_text"), "request approval");
      if ("task_id" in item.approval) addEdge(edges, `task:${item.approval.task_id}`, approvalNodeId, "approval");
    });

  return {
    generated_at: generatedAt,
    worker_settings: settings,
    model_providers: config.modelProviders,
    nodes,
    edges,
    events,
  };
}
