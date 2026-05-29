import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { config } from "./config.js";
import { workerHeartbeatIsStale } from "./worker-heartbeat.js";
import {
  appendAuditEvent,
  appendOrchestratorEvent,
  getRunSummary,
  getSession,
  getTask,
  getWorker,
  listCommandEvents,
  listOrchestratorEvents,
  listSessions,
  listTasks,
  subscribeOrchestratorEvents,
  upsertSession,
} from "./store.js";
import { findTelephonyPeerForSession } from "./telephony-store.js";
import type { Channel, OrchestratorEvent, SessionState, SupervisorEvent, TaskRecord, WorkerRecord } from "./types.js";

type ProgressSink = {
  channel: Channel;
  send: (text: string) => void;
};

const TEXT_SILENCE_MS = 25_000;
const VOICE_SILENCE_MS = 25_000;
const STALE_HEARTBEAT_MS = 60_000;
const SMS_MAJOR_EVENT_MS = 60_000;

const sinksBySession = new Map<string, Set<ProgressSink>>();
let unsubscribeStoreEvents: (() => boolean) | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let twilioClient: ReturnType<typeof twilio> | null = null;
const smsLastSentAt = new Map<string, number>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function truncate(value: string, max = 260) {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

function formatDuration(value: unknown) {
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function normalizeProgressText(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function progressKind(sourceType: string, text: string) {
  if (sourceType === "worker.stale" || /stale heartbeat|has not sent a heartbeat/i.test(text)) return "stale_heartbeat";
  if (sourceType === "silence.watchdog") return "latest_known_state";
  return sourceType;
}

function commandFromEvent(event: OrchestratorEvent) {
  const data = asRecord(event.data);
  const command = typeof data.command === "string" ? data.command : "";
  const exitCode = typeof data.exit_code === "number" ? data.exit_code : data.exit_code === null ? null : undefined;
  const summary = typeof data.summary === "string" ? data.summary : event.message;
  return { command, exitCode, summary };
}

function taskFromEvent(event: OrchestratorEvent) {
  const data = asRecord(event.data);
  const task = asRecord(data.task);
  const taskId = typeof data.task_id === "string"
    ? data.task_id
    : typeof task.task_id === "string"
      ? task.task_id
      : event.scope === "task"
        ? event.scope_id
        : "";
  return taskId ? getTask(taskId) : null;
}

function workerFromEvent(event: OrchestratorEvent) {
  const data = asRecord(event.data);
  const worker = asRecord(data.worker);
  const workerId = typeof data.worker_id === "string"
    ? data.worker_id
    : typeof worker.worker_id === "string"
      ? worker.worker_id
      : event.scope === "worker"
        ? event.scope_id
        : "";
  return workerId ? getWorker(workerId) : null;
}

function activeTaskForSession(session: SessionState) {
  if (session.active_task_id) {
    const task = getTask(session.active_task_id);
    if (task) return task;
  }
  const projectId = session.current_project_id ?? session.project_id;
  return projectId ? listTasks(projectId)[0] ?? null : null;
}

function activeWorkerForSession(session: SessionState, task?: TaskRecord | null) {
  if (session.active_worker_id) {
    const worker = getWorker(session.active_worker_id);
    if (worker) return worker;
  }
  return task?.worker_id ? getWorker(task.worker_id) : null;
}

function latestCommandForTask(taskId: string | null | undefined) {
  if (!taskId) return null;
  return listCommandEvents({ taskId }).at(-1) ?? null;
}

function progressStateVersion(session: SessionState, source: { task_id?: string; worker_id?: string }, kind?: string) {
  const task = source.task_id ? getTask(source.task_id) : activeTaskForSession(session);
  const worker = source.worker_id ? getWorker(source.worker_id) : activeWorkerForSession(session, task);
  const command = latestCommandForTask(task?.task_id);
  if (kind === "stale_heartbeat") {
    return [
      `task:${task?.task_id ?? source.task_id ?? ""}`,
      `task_status:${task?.status ?? ""}`,
      `worker:${worker?.worker_id ?? source.worker_id ?? ""}`,
      `worker_status:${worker?.status ?? ""}`,
      `heartbeat:${worker?.heartbeat_at ?? ""}`,
    ].join("|");
  }
  return [
    `task:${task?.task_id ?? source.task_id ?? ""}`,
    `task_status:${task?.status ?? ""}`,
    `worker:${worker?.worker_id ?? source.worker_id ?? ""}`,
    `worker_status:${worker?.status ?? ""}`,
    `command:${command?.event_id ?? ""}`,
    `command_exit:${command?.exit_code ?? "running"}`,
  ].join("|");
}

function progressDedupeKey(
  session: SessionState,
  text: string,
  source: { type: string; task_id?: string; worker_id?: string },
) {
  const kind = progressKind(source.type, text);
  const stateVersion = progressStateVersion(session, source, kind);
  return {
    kind,
    stateVersion,
    key: [
      session.session_id,
      source.task_id ?? session.active_task_id ?? "",
      source.worker_id ?? session.active_worker_id ?? "",
      kind,
      normalizeProgressText(text),
      stateVersion,
    ].join("|"),
  };
}

function duplicateProgressByState(
  session: SessionState,
  text: string,
  source: { type: string; task_id?: string; worker_id?: string },
  nowMs: number,
) {
  const dedupe = progressDedupeKey(session, text, source);
  for (const event of [...session.raw_events].reverse()) {
    if (event.type !== "progress.update") continue;
    const data = asRecord(event.data);
    if (data.progress_dedupe_key !== dedupe.key) continue;
    if (dedupe.kind === "stale_heartbeat" || dedupe.kind === "latest_known_state") return true;
    const eventMs = Date.parse(event.ts);
    return Number.isFinite(eventMs) && nowMs - eventMs < TEXT_SILENCE_MS;
  }
  return false;
}

function latestProgressAt(session: SessionState) {
  const progressEvents = session.raw_events.filter((event) => event.type === "progress.update");
  const recentAssistant = (session.recent_messages ?? []).filter((message) => message.role === "assistant");
  const timestamps = [
    ...progressEvents.map((event) => Date.parse(event.ts)),
    ...recentAssistant.map((message) => Date.parse(message.ts)),
  ].filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : 0;
}

function sessionsForEvent(event: OrchestratorEvent) {
  const data = asRecord(event.data);
  const explicitSessionId = typeof data.session_id === "string" ? data.session_id : "";
  const task = taskFromEvent(event);
  const worker = workerFromEvent(event);
  const taskId = task?.task_id ?? (typeof data.task_id === "string" ? data.task_id : "");
  const workerId = worker?.worker_id ?? (typeof data.worker_id === "string" ? data.worker_id : "");
  const sessionIds = new Set<string>();
  if (event.scope === "session") sessionIds.add(event.scope_id);
  if (explicitSessionId) sessionIds.add(explicitSessionId);
  for (const session of listSessions()) {
    if (taskId && session.active_task_id === taskId) sessionIds.add(session.session_id);
    if (workerId && session.active_worker_id === workerId) sessionIds.add(session.session_id);
    if (task?.project_id && (session.current_project_id === task.project_id || session.project_id === task.project_id)) sessionIds.add(session.session_id);
  }
  return [...sessionIds].map((sessionId) => getSession(sessionId)).filter((session): session is SessionState => Boolean(session));
}

function isMajorForVoice(eventType: string) {
  return [
    "task.created",
    "project_intake.codex_started",
    "project_intake.codex_completed",
    "project_intake.failed",
    "planner.codex_cli.started",
    "planner.codex_cli.completed",
    "planner.codex_cli.failed",
    "subagent_advisor.codex_cli.started",
    "subagent_advisor.codex_cli.completed",
    "subagent_advisor.codex_cli.failed",
    "subagent_advisor.codex_cli.timed_out",
    "megaplan.created",
    "worker.started",
    "worker.stale",
    "worker.failed",
    "worker.stopped",
    "command.started",
    "command.completed",
    "command.failed",
    "approval.requested",
    "summary.generated",
    "task.completed",
    "task.failed",
  ].includes(eventType);
}

function isMajorForSms(eventType: string) {
  return [
    "task.created",
    "worker.started",
    "worker.stale",
    "command.failed",
    "approval.requested",
    "summary.generated",
    "task.completed",
    "task.failed",
    "worker.failed",
    "worker.stopped",
  ].includes(eventType);
}

function progressTextForEvent(event: OrchestratorEvent, session: SessionState, channel: Channel | null) {
  const task = taskFromEvent(event) ?? activeTaskForSession(session);
  const worker = workerFromEvent(event) ?? activeWorkerForSession(session, task);
  const voice = channel === "web_voice" || channel === "twilio_call" || channel === "phone";
  const data = asRecord(event.data);

  if (event.type === "session.message.received") return voice ? "I heard you. I’m checking the current state." : "Received your message. I’m checking the orchestrator state now.";
  if (event.type === "orchestrator.decision.started") return voice ? "I’m planning the next step." : "Planning the next orchestrator step from the current session state.";
  if (event.type === "project_intake.codex_started") return voice ? "Codex is deciding the project target." : "Codex is checking whether this is a new repo, a repo correction, or a normal follow-up.";
  if (event.type === "project_intake.codex_completed") {
    const duration = formatDuration(data.duration_ms);
    return duration ? `Project intake finished in ${duration}.` : "Project intake finished.";
  }
  if (event.type === "project_intake.failed") return `Project intake failed: ${truncate(event.message, voice ? 120 : 220)}`;
  if (event.type === "planner.codex_cli.started") return voice ? "Codex is drafting the technical plan." : "Codex is drafting the technical requirements, responsibility split, and Megaplan inputs.";
  if (event.type === "planner.codex_cli.completed") {
    const duration = formatDuration(data.duration_ms);
    return duration ? `Codex planning finished in ${duration}.` : "Codex planning finished.";
  }
  if (event.type === "planner.codex_cli.failed") return `Codex planning failed: ${truncate(event.message, voice ? 120 : 220)}`;
  if (event.type === "subagent_advisor.codex_cli.started") return voice ? "Codex is checking whether internal subagents are useful." : "Codex is running a short read-only subagent advisor check before the approval gate.";
  if (event.type === "subagent_advisor.codex_cli.completed") {
    const duration = formatDuration(data.duration_ms);
    return duration ? `Subagent advisor finished in ${duration}.` : "Subagent advisor finished.";
  }
  if (event.type === "subagent_advisor.codex_cli.failed") return `Subagent advisor failed; using conservative planner context: ${truncate(event.message, voice ? 120 : 220)}`;
  if (event.type === "subagent_advisor.codex_cli.timed_out") return "Subagent advisor hit the 5 second cap; Codex will continue with the conservative planner context and still ask before implementation.";
  if (event.type === "github.repo.ready") return "GitHub repo is ready and attached as the project origin.";
  if (event.type === "github.repo.failed") return `GitHub repo creation failed: ${truncate(event.message, voice ? 120 : 220)}`;
  if (event.type === "megaplan.created") return "Megaplan is ready for approval.";
  if (event.type === "task.created") return task ? `Created task ${task.task_id}: ${truncate(task.user_goal, 120)}.` : event.message;
  if (event.type === "task.planned") return task ? `Planned task ${task.task_id}. Next step: ${task.next_steps[0] ?? task.plan[0] ?? "assign a worker"}.` : event.message;
  if (event.type === "worker.created") {
    return worker ? `Created ${worker.type} worker ${worker.worker_id}.` : event.message;
  }
  if (event.type === "worker.started") {
    return worker ? `${worker.type} worker ${worker.worker_id} is ${worker.status}.` : event.message;
  }
  if (event.type === "worker.heartbeat") {
    return worker ? `Heartbeat received from ${worker.type} worker ${worker.worker_id}.` : event.message;
  }
  if (event.type === "worker.stale") {
    return worker ? `Worker ${worker.worker_id} has not sent a heartbeat recently. I’m marking it stale and checking the latest logs.` : event.message;
  }
  if (event.type === "worker.failed") return worker ? `Worker ${worker.worker_id} reported a failure.` : event.message;
  if (event.type === "worker.stopped") return worker ? `Worker ${worker.worker_id} stopped.` : event.message;
  if (event.type === "command.started") {
    const command = commandFromEvent(event);
    return command.command ? `The worker is running ${command.command}.` : event.message;
  }
  if (event.type === "command.completed") {
    const command = commandFromEvent(event);
    return command.command ? `${command.command} completed successfully.` : event.message;
  }
  if (event.type === "command.failed") {
    const command = commandFromEvent(event);
    return command.command ? `${command.command} failed. ${truncate(command.summary, voice ? 120 : 220)}` : event.message;
  }
  if (event.type === "files.changed") {
    const files = Array.isArray(data.files_changed) ? data.files_changed.map(String) : [];
    return files.length ? `Files changed: ${files.slice(0, voice ? 2 : 5).join(", ")}${files.length > (voice ? 2 : 5) ? "..." : ""}.` : event.message;
  }
  if (event.type === "approval.requested") return voice ? "I need your approval before continuing." : `Approval required: ${truncate(event.message, 220)}`;
  if (event.type === "summary.generated") {
    const summary = task ? getRunSummary(task.task_id) : null;
    return summary ? (voice ? `${summary.executive_summary} Next: ${summary.next_plan[0] ?? "continue"}.` : summary.executive_summary) : event.message;
  }
  if (event.type === "task.completed") return task ? `Task ${task.task_id} completed. ${truncate(task.latest_summary, voice ? 120 : 220)}` : event.message;
  if (event.type === "task.failed") return task ? `Task ${task.task_id} failed. ${truncate(task.latest_summary, voice ? 120 : 220)}` : event.message;
  return "";
}

function shouldPublishForChannel(event: OrchestratorEvent, session: SessionState) {
  const channel = session.channel;
  if (channel === "twilio_sms" || channel === "sms") return isMajorForSms(event.type);
  if (channel === "web_voice" || channel === "twilio_call" || channel === "phone") return isMajorForVoice(event.type);
  if (event.type === "worker.heartbeat") return Date.now() - latestProgressAt(session) >= TEXT_SILENCE_MS;
  return Boolean(progressTextForEvent(event, session, channel));
}

function sendToBrowserOrRelaySinks(sessionId: string, text: string) {
  for (const sink of sinksBySession.get(sessionId) ?? []) {
    try {
      sink.send(text);
    } catch {
      // Session timeline still records the update. A dead sink is removed on disconnect.
    }
  }
}

function sendSmsIfConfigured(session: SessionState, text: string) {
  const peer = findTelephonyPeerForSession(session.session_id);
  if (!peer || peer.source !== "sms" || !peer.address) return;
  if (!config.twilioSmsEnabled || !config.twilioAccountSid || !config.twilioAuthToken) return;
  if (!config.twilioMessagingServiceSid && !config.twilioFromNumber) return;
  const now = Date.now();
  if (now - (smsLastSentAt.get(session.session_id) ?? 0) < SMS_MAJOR_EVENT_MS) return;
  twilioClient ??= twilio(config.twilioAccountSid, config.twilioAuthToken);
  smsLastSentAt.set(session.session_id, now);
  void twilioClient.messages.create({
    to: peer.address,
    body: text,
    ...(config.twilioMessagingServiceSid ? { messagingServiceSid: config.twilioMessagingServiceSid } : { from: config.twilioFromNumber }),
  }).catch((error) => {
    appendAuditEvent({
      session_id: session.session_id,
      ts: new Date().toISOString(),
      source: "system",
      type: "progress.sms.failed",
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export function publishProgressUpdate(
  session: SessionState,
  text: string,
  source: { event_id: string; type: string; task_id?: string; project_id?: string; worker_id?: string },
  channelOverride?: Channel | null,
) {
  const duplicate = session.raw_events.some((event) => event.type === "progress.update" && asRecord(event.data).source_event_id === source.event_id);
  if (duplicate) return null;
  const now = new Date().toISOString();
  const dedupe = progressDedupeKey(session, text, source);
  if (duplicateProgressByState(session, text, source, Date.parse(now))) return null;
  const event: SupervisorEvent = {
    id: randomUUID(),
    session_id: session.session_id,
    ts: now,
    source: "system",
    type: "progress.update",
    message: text,
    data: {
      source_event_id: source.event_id,
      source_event_type: source.type,
      progress_kind: dedupe.kind,
      progress_state_version: dedupe.stateVersion,
      progress_dedupe_key: dedupe.key,
      task_id: source.task_id ?? session.active_task_id,
      project_id: source.project_id ?? session.current_project_id ?? session.project_id,
      worker_id: source.worker_id ?? session.active_worker_id,
    },
  };
  appendAuditEvent({
    session_id: event.session_id,
    ts: event.ts,
    source: event.source,
    type: event.type,
    message: event.message,
    data: event.data,
  });
  session.raw_events = [...session.raw_events, event].slice(-400);
  session.recent_messages = [
    ...(session.recent_messages ?? []),
    {
      ts: now,
      role: "assistant" as const,
      channel: channelOverride ?? session.channel ?? null,
      text,
    },
  ].slice(-30);
  session.latest_codex_message = text;
  session.last_updated = now;
  upsertSession(session);
  appendOrchestratorEvent({
    scope: "session",
    scope_id: session.session_id,
    type: "progress.update",
    message: text,
    data: {
      session_id: session.session_id,
      source_event_id: source.event_id,
      source_event_type: source.type,
      progress_kind: dedupe.kind,
      progress_state_version: dedupe.stateVersion,
      progress_dedupe_key: dedupe.key,
      task_id: source.task_id ?? session.active_task_id,
      project_id: source.project_id ?? session.current_project_id ?? session.project_id,
      worker_id: source.worker_id ?? session.active_worker_id,
    },
  });
  sendToBrowserOrRelaySinks(session.session_id, text);
  if (session.channel === "twilio_sms" || session.channel === "sms") sendSmsIfConfigured(session, text);
  return event;
}

function handleOrchestratorEvent(event: OrchestratorEvent) {
  if (event.type === "progress.update" || event.type === "command.event" || event.type === "mcp.tool.started" || event.type === "mcp.tool.completed") return;
  const task = taskFromEvent(event);
  const worker = workerFromEvent(event);
  for (const session of sessionsForEvent(event)) {
    if (!shouldPublishForChannel(event, session)) continue;
    const text = progressTextForEvent(event, session, session.channel);
    if (!text) continue;
    publishProgressUpdate(session, text, {
      event_id: event.event_id,
      type: event.type,
      task_id: task?.task_id,
      project_id: task?.project_id ?? worker?.project_id,
      worker_id: worker?.worker_id,
    });
  }
}

function watchdogText(session: SessionState, task: TaskRecord, worker: WorkerRecord | null, stale: boolean) {
  const commands = listCommandEvents({ taskId: task.task_id });
  const latestCommand = commands.at(-1);
  if (stale && worker) return `Worker ${worker.worker_id} has not sent a heartbeat in over 60 seconds. Last known status: ${worker.status}.`;
  if (latestCommand?.exit_code === null) return `Still running ${latestCommand.command} on worker ${latestCommand.worker_id}. Waiting for the command result.`;
  if (worker) return `Still working on task ${task.task_id}. Worker ${worker.worker_id} is ${worker.status}. Next expected step: ${task.next_steps[0] ?? "another worker event"}.`;
  return `Still working on task ${task.task_id}. No worker is assigned yet. Next expected step: ${task.next_steps[0] ?? "worker assignment"}.`;
}

export function runSilenceWatchdogOnce(nowMs = Date.now()) {
  for (const session of listSessions()) {
    const task = activeTaskForSession(session);
    if (!task || !["queued", "planning", "running", "waiting_for_approval"].includes(task.status)) continue;
    const worker = activeWorkerForSession(session, task);
    const stale = workerHeartbeatIsStale(worker, task, nowMs, STALE_HEARTBEAT_MS);
    const staleStateVersion = worker ? progressStateVersion(session, { task_id: task.task_id, worker_id: worker.worker_id }) : "";
    if (stale && worker) {
      const staleAlreadyRecorded = listOrchestratorEvents(worker.worker_id)
        .filter((event) => event.type === "worker.stale")
        .some((event) => asRecord(event.data).stale_state_version === staleStateVersion);
      if (!staleAlreadyRecorded) {
        appendOrchestratorEvent({
          scope: "worker",
          scope_id: worker.worker_id,
          type: "worker.stale",
          message: `Worker ${worker.worker_id} has a stale heartbeat.`,
          data: { worker, task_id: task.task_id, session_id: session.session_id, stale_state_version: staleStateVersion },
        });
        continue;
      }
    }

    const silenceMs = session.channel === "twilio_sms" || session.channel === "sms" ? SMS_MAJOR_EVENT_MS : session.channel === "web_voice" || session.channel === "twilio_call" || session.channel === "phone" ? VOICE_SILENCE_MS : TEXT_SILENCE_MS;
    if (nowMs - latestProgressAt(session) < silenceMs) continue;
    publishProgressUpdate(session, watchdogText(session, task, worker, false), {
      event_id: `watchdog:${session.session_id}:${Math.floor(nowMs / silenceMs)}`,
      type: "silence.watchdog",
      task_id: task.task_id,
      project_id: task.project_id,
      worker_id: worker?.worker_id,
    });
  }
}

export function registerProgressSink(sessionId: string, sink: ProgressSink) {
  const sinks = sinksBySession.get(sessionId) ?? new Set<ProgressSink>();
  sinks.add(sink);
  sinksBySession.set(sessionId, sinks);
  return () => {
    const current = sinksBySession.get(sessionId);
    if (!current) return;
    current.delete(sink);
    if (!current.size) sinksBySession.delete(sessionId);
  };
}

export function startProgressBroadcaster() {
  if (!unsubscribeStoreEvents) unsubscribeStoreEvents = subscribeOrchestratorEvents(handleOrchestratorEvent);
  if (process.env.HEAD_DEVELOPER_PROGRESS_WATCHDOG_ENABLED !== "1" && process.env.HEAD_DEVELOPER_STATE_STORE === "firestore") return;
  if (!watchdogTimer) {
    watchdogTimer = setInterval(() => {
      try {
        runSilenceWatchdogOnce();
      } catch (error) {
        console.error(`Progress watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 10_000);
  }
}

export function stopProgressBroadcasterForTests() {
  if (unsubscribeStoreEvents) unsubscribeStoreEvents();
  unsubscribeStoreEvents = null;
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  sinksBySession.clear();
  smsLastSentAt.clear();
  twilioClient = null;
}
