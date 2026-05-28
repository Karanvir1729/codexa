import type {
  OrchestratorSettings,
  PersistedState,
  WorkerType,
} from "./types.js";

export interface InitialStateOptions {
  defaultWorkerMode: WorkerType;
  allowWorkerModeSwitch: boolean;
  maxLocalWorkers: number;
  maxDockerLocalWorkers: number;
  maxGcpVmWorkers: number;
  maxGkeJobWorkers: number;
}

export function initialOrchestratorSettings(options: InitialStateOptions): OrchestratorSettings {
  return {
    default_worker_mode: options.defaultWorkerMode,
    allow_worker_mode_switch: options.allowWorkerModeSwitch,
    max_local_workers: options.maxLocalWorkers,
    max_docker_local_workers: options.maxDockerLocalWorkers,
    max_gcp_vm_workers: options.maxGcpVmWorkers,
    max_gke_job_workers: options.maxGkeJobWorkers,
    updated_at: new Date().toISOString(),
  };
}

export function emptyPersistedState(options: InitialStateOptions): PersistedState {
  return {
    sessions: {},
    projects: {},
    tasks: {},
    workers: {},
    command_events: {},
    run_summaries: {},
    approval_requests: {},
    orchestrator_events: [],
    orchestrator_settings: initialOrchestratorSettings(options),
    mcp_tool_calls: {},
    operator_actions: {},
    task_graphs: {},
    worker_context_packets: {},
    worker_runtime_command_requests: {},
    project_artifacts: {},
  };
}

export function normalizePersistedState(parsed: Partial<PersistedState>, options: InitialStateOptions): PersistedState {
  return {
    sessions: parsed.sessions ?? {},
    projects: parsed.projects ?? {},
    tasks: parsed.tasks ?? {},
    workers: parsed.workers ?? {},
    command_events: parsed.command_events ?? {},
    run_summaries: parsed.run_summaries ?? {},
    approval_requests: parsed.approval_requests ?? {},
    orchestrator_events: parsed.orchestrator_events ?? [],
    orchestrator_settings: {
      ...initialOrchestratorSettings(options),
      ...(parsed.orchestrator_settings ?? {}),
    },
    mcp_tool_calls: parsed.mcp_tool_calls ?? {},
    operator_actions: parsed.operator_actions ?? {},
    task_graphs: parsed.task_graphs ?? {},
    worker_context_packets: parsed.worker_context_packets ?? {},
    worker_runtime_command_requests: parsed.worker_runtime_command_requests ?? {},
    project_artifacts: parsed.project_artifacts ?? {},
  };
}
