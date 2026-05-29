export type SessionStatus = "idle" | "running" | "waiting_for_approval" | "failed" | "completed" | "expired";

export type ApprovalDecision = "approved" | "denied";

export type PublicChannel = "web_text" | "web_voice" | "sms" | "phone" | "operator";

export type Channel = PublicChannel | "twilio_sms" | "twilio_call";

export type PendingActionType =
  | "confirm_create_project"
  | "collect_project_name"
  | "clarify_requirements"
  | "approve_gcp_action"
  | "approve_operator_action"
  | "approve_task_split"
  | "approve_megaplan"
  | "choose_worker_mode"
  | "confirm_deploy"
  | "select_project";

export interface PendingAction {
  type: PendingActionType;
  original_user_goal: string;
  requested_kind: "project" | "website" | "site" | "app" | "agent" | "tool" | "game";
  suggested_project_name?: string;
  description?: string;
  action?: string;
  reason?: string;
  risk_level?: CommandRiskLevel;
  approval_id?: string;
  operator_action_id?: string;
  worker_mode?: WorkerType;
  target_project_id?: string;
  target_task_id?: string;
  target_worker_id?: string;
  target_task_graph_id?: string;
  planning_decision_id?: string;
  proposed_plan?: PlannerDecision | null;
  approved_plan?: ApprovedPlanRecord | null;
  user_approved_worker_count?: number | null;
  user_approved_worker_mode?: WorkerType | null;
  choices?: string[];
  created_at: string;
}

export interface ConversationMessage {
  ts: string;
  role: "user" | "assistant" | "system";
  channel: Channel | null;
  text: string;
}

export type SupervisorModelProvider = "codex_cli" | "gcp_conversation_ai" | "nvidia_nim" | "openai";

export type ApprovalKind =
  | "shell"
  | "network"
  | "install"
  | "delete"
  | "deploy"
  | "git_push"
  | "secret_access"
  | "external_repo"
  | "gcp_resource"
  | "twilio_mutation"
  | "payment_or_billing";

export interface PendingApproval {
  id: string;
  kind: ApprovalKind;
  command: string;
  reason: string;
  risk: "low" | "medium" | "high";
  status: "pending" | ApprovalDecision;
  requested_at: string;
  responded_at?: string;
  project_id?: string;
  session_id?: string;
  approved_by_channel?: Channel;
}

export interface TestResult {
  name: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  details?: string;
}

export interface SupervisorEvent {
  id: string;
  session_id: string;
  ts: string;
  source: "system" | "user" | "codex" | "approval";
  type: string;
  message: string;
  data?: unknown;
}

export interface CodexStructuredReport {
  summary: string;
  status: "completed" | "failed" | "needs_approval" | "running";
  latest_codex_message: string;
  files_read: string[];
  files_modified: string[];
  commands_requested: string[];
  commands_completed: string[];
  commands_failed: string[];
  test_results: TestResult[];
  errors: string[];
  approval_requests: Array<{
    kind: ApprovalKind;
    command: string;
    reason: string;
    risk: "low" | "medium" | "high";
  }>;
}

export interface ProjectCandidate {
  name: string;
  path: string;
  signals: string[];
}

export interface ProjectRecord {
  project_id: string;
  display_name: string;
  workspace_path: string;
  repo_name: string | null;
  git_branch: string | null;
  repo_path?: string | null;
  git_initialized?: boolean;
  github_repo_url?: string | null;
  github_repo_full_name?: string | null;
  github_repo_created?: boolean | null;
  github_repo_error?: string | null;
  github_last_push_at?: string | null;
  github_last_push_error?: string | null;
  default_branch?: string | null;
  latest_commit_hash?: string | null;
  docs_path?: string | null;
  shared_context_path?: string | null;
  documentation_indexed_at?: string | null;
  docs_fresh?: boolean | null;
  docs_stale_reasons?: string[];
  last_active_session_id: string | null;
  available_codex_adapter: "codex_cli";
  latest_preview?: PreviewMetadata | null;
  requirement_summary?: string | null;
  planning_decision_id?: string | null;
  planner_model?: string | null;
  planner_output?: PlannerDecision | null;
  approved_plan?: ApprovedPlanRecord | null;
  approval_status?: "not_required" | "pending" | "approved" | "rejected" | null;
  open_questions?: string[];
  assumptions?: string[];
  design_decision_history?: DesignDecisionRecord[];
  user_approved_worker_count?: number | null;
  user_approved_worker_mode?: WorkerType | null;
  created_at: string;
  updated_at: string;
}

export type CloudSessionStatus = SessionStatus | "active" | "cancelled";

export interface CloudSession {
  session_id: string;
  user_id: string | null;
  channel: PublicChannel;
  current_project_id: string | null;
  active_task_id: string | null;
  pending_action: PendingAction | null;
  pending_action_payload: Record<string, unknown> | null;
  status: CloudSessionStatus;
  created_at: string;
  updated_at: string;
}

export interface CloudProject {
  project_id: string;
  name: string;
  slug: string;
  repo_url?: string;
  workspace_uri: string;
  active_task_id: string | null;
  active_worker_id: string | null;
  latest_summary: string;
  latest_plan: string;
  created_at: string;
  updated_at: string;
}

export type TaskStatus = "queued" | "planning" | "running" | "waiting_for_approval" | "failed" | "completed" | "cancelled";

export interface TaskRecord {
  task_id: string;
  project_id: string;
  user_goal: string;
  normalized_goal: string;
  status: TaskStatus;
  plan: string[];
  worker_id: string | null;
  codex_run_id: string | null;
  command_count: number;
  latest_summary: string;
  next_steps: string[];
  task_graph_id?: string | null;
  task_graph_node_id?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
  worker_context_packet_id?: string | null;
  in_flight_action?: "codex_exec" | null;
  active_command_event_id?: string | null;
  command_lease_id?: string | null;
  command_lease_owner?: string | null;
  command_lease_attempt_id?: string | null;
  command_lease_acquired_at?: string | null;
  command_lease_expires_at?: string | null;
  completion_gate_status?: "passed" | "failed" | "not_applicable" | null;
  completion_gate_reasons?: string[];
  completion_gate_missing_required_app_files?: string[];
  completion_gate_docs_only?: boolean | null;
  latest_preview?: PreviewMetadata | null;
  execution_backend?: "codex_session_local" | "worker_orchestrator" | null;
  local_state_path?: string | null;
  codex_subagents?: LocalCodexSubagentReport[];
  codex_flowchart_summary?: LocalCodexFlowchartSummary | null;
  codex_flowchart_json_path?: string | null;
  local_validation_result?: LocalCodexValidationResult | null;
  files_changed?: string[];
  final_summary?: string | null;
  codex_session_id?: string | null;
  codex_rollout_path?: string | null;
  codex_rollout_host_path?: string | null;
  codex_rollout_relative_path?: string | null;
  codex_home?: string | null;
  codex_home_host_path?: string | null;
  codex_history_kind?: "interactive" | "exec" | null;
  codex_resume_command?: string | null;
  codex_prompt_excerpt?: string | null;
  codex_model?: string | null;
  codex_started_at?: string | null;
  codex_completed_at?: string | null;
  codex_history_confidence?: string | null;
  codex_history_verification_command?: string | null;
  created_at: string;
  updated_at: string;
}

export interface LocalCodexSubagentReport {
  name: string;
  responsibility: string;
  status: "waiting" | "running" | "completed" | "failed" | "skipped" | "unknown";
  changed_files: string[];
  validation: string[];
  summary: string;
}

export type LocalCodexFlowchartNodeKind =
  | "user_request"
  | "requirement_summary"
  | "plan"
  | "codex_session"
  | "subagent"
  | "validation"
  | "preview"
  | "final_summary";

export interface LocalCodexFlowchartNodeReport {
  id: string;
  kind: LocalCodexFlowchartNodeKind;
  label: string;
  status: string;
  summary: string;
  depends_on: string[];
}

export interface LocalCodexFlowchartEdgeReport {
  from: string;
  to: string;
  label: string;
}

export interface LocalCodexFlowchartSummary {
  title: string;
  overview: string;
  nodes: LocalCodexFlowchartNodeReport[];
  edges: LocalCodexFlowchartEdgeReport[];
}

export interface LocalCodexValidationCommandResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  exit_code: number | null;
  summary: string;
}

export interface LocalCodexValidationResult {
  status: "passed" | "failed";
  validated_at: string;
  required_files_exist: boolean;
  docs_updated: boolean;
  docs_only_success_rejected: boolean;
  preview_loaded: boolean | null;
  files_changed: string[];
  app_files: string[];
  documentation_files: string[];
  commands: LocalCodexValidationCommandResult[];
  failures: string[];
  warnings: string[];
  summary: string;
}

export type PreviewServerType = "static" | "vite" | "next" | "custom";
export type PreviewStatus = "starting" | "running" | "loaded" | "failed" | "stopped";

export interface PreviewMetadata {
  preview_id: string;
  project_id: string;
  task_id: string;
  worker_id: string | null;
  workspace_path: string;
  entry_file: string;
  asset_paths: string[];
  preview_url: string;
  server_type: PreviewServerType;
  status: PreviewStatus;
  command_event_id?: string;
  console_errors: string[];
  screenshot_path?: string;
  loaded: boolean;
  created_at: string;
  updated_at: string;
  summary: string;
}

export interface ProjectArtifactFileRecord {
  artifact_id: string;
  project_id: string;
  task_id: string;
  worker_id: string;
  path: string;
  content_base64: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
}

export type WorkerType = "codex_session_local" | "local" | "docker_local" | "gcp_vm" | "gke_job";

export type WorkerStatus = "starting" | "idle" | "assigned" | "running" | "failed" | "stopping" | "stopped" | "expired";

export interface WorkerRecord {
  worker_id: string;
  type: WorkerType;
  status: WorkerStatus;
  vm_name?: string;
  recorded_vm_name?: string;
  actual_vm_name?: string;
  runtime_vm_name?: string;
  machine_type?: string;
  image_uri: string;
  recorded_image_uri?: string;
  actual_image_uri?: string;
  actual_image_digest?: string;
  actual_worker_mode?: WorkerType;
  runtime_image_uri?: string;
  runtime_image_digest?: string;
  startup_attempt_id?: string;
  run_attempt_id?: string;
  container_started_at?: string;
  worker_runtime_version?: string;
  codex_home?: string;
  codex_home_host_path?: string;
  codex_history_sessions_path?: string;
  codex_auth_method?: string;
  codex_auth_secret_resource?: string;
  codex_auth_validated_at?: string;
  codex_auth_validation_status?: "validated" | "not_configured" | "failed";
  docker_container_id?: string;
  docker_container_name?: string;
  last_runtime_report_at?: string;
  runtime_metadata_updated_at?: string;
  metadata_verified_from_runtime?: boolean;
  project_id?: string;
  task_id?: string;
  heartbeat_at: string | null;
  created_at: string;
  expires_at: string;
  metadata?: Record<string, unknown>;
}

export type TaskComplexity = "simple" | "moderate" | "complex";

export interface TaskComplexityDecision {
  complexity: TaskComplexity;
  recommended_worker_count: number;
  should_split: boolean;
  parallelizable: boolean;
  reason: string;
  suggested_subtasks: Array<{
    title: string;
    goal: string;
    dependencies: string[];
    outputs_expected: string[];
    files_expected: string[];
    output_contract?: WorkerOutputContract;
    required_app_files: string[];
    allowed_doc_files: string[];
    expected_user_visible_output: string[];
    validation_commands: string[];
    acceptance_checks: string[];
    completion_criteria: string[];
    parallel_group?: string;
  }>;
  dependency_graph: Array<{
    from: string;
    to: string;
    relationship: TaskGraphEdgeRelationship;
  }>;
  risks: string[];
  approval_needed: boolean;
}

export type TaskGraphStatus = "proposed" | "queued" | "running" | "review" | "completed" | "failed" | "cancelled";
export type TaskGraphNodeStatus = "queued" | "blocked" | "running" | "review" | "needs_repair" | "completed" | "failed" | "cancelled";
export type TaskGraphEdgeRelationship = "blocks" | "informs" | "reviews" | "merges_into";

export interface WorkerOutputContract {
  required_app_files: string[];
  allowed_doc_files: string[];
  expected_user_visible_output: string[];
  validation_commands: string[];
  acceptance_checks: string[];
  completion_criteria: string[];
  docs_only_is_insufficient: boolean;
}

export interface TaskGraphNodeCompletionGate {
  status: "passed" | "failed" | "not_applicable";
  evaluated_at: string;
  reasons: string[];
  changed_files: string[];
  app_files: string[];
  docs_only: boolean;
  missing_required_app_files: string[];
  validation_commands_run: string[];
  missing_validation_commands: string[];
}

export interface TaskGraphNode {
  node_id: string;
  task_id: string;
  title: string;
  goal: string;
  assigned_worker_id?: string | null;
  status: TaskGraphNodeStatus;
  dependencies: string[];
  outputs_expected: string[];
  files_expected: string[];
  output_contract?: WorkerOutputContract;
  required_app_files: string[];
  allowed_doc_files: string[];
  expected_user_visible_output: string[];
  validation_commands: string[];
  acceptance_checks: string[];
  completion_criteria: string[];
  completion_gate?: TaskGraphNodeCompletionGate | null;
  repair_task_for_node_id?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
  summary: string;
  created_at: string;
  updated_at: string;
}

export interface TaskGraphEdge {
  from_node_id: string;
  to_node_id: string;
  relationship: TaskGraphEdgeRelationship;
}

export interface TaskGraphRecord {
  task_graph_id: string;
  project_id: string;
  root_user_goal: string;
  status: TaskGraphStatus;
  complexity: TaskComplexityDecision;
  nodes: TaskGraphNode[];
  edges: TaskGraphEdge[];
  recommended_worker_count: number;
  execution_strategy: "single_worker" | "sequential" | "parallel_worktrees";
  requirement_summary?: string | null;
  planning_decision_id?: string | null;
  planner_model?: string | null;
  planner_output?: PlannerDecision | null;
  approved_plan?: ApprovedPlanRecord | null;
  approval_status?: "not_required" | "pending" | "approved" | "rejected" | null;
  open_questions?: string[];
  assumptions?: string[];
  design_decision_history?: DesignDecisionRecord[];
  user_approved_worker_count?: number | null;
  user_approved_worker_mode?: WorkerType | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerContextPacket {
  context_packet_id: string;
  task_graph_id: string;
  node_id: string;
  task_id: string;
  project_id: string;
  worker_id?: string | null;
  project_brief: string;
  current_task_goal: string;
  task_graph_node: TaskGraphNode;
  dependencies_completed: string[];
  relevant_docs: Record<string, string>;
  allowed_roots: string[];
  branch_name?: string | null;
  worktree_path?: string | null;
  expected_files: string[];
  validation_commands: string[];
  output_contract: WorkerOutputContract;
  constraints: string[];
  expected_output: string[];
  commands_allowed: string[];
  validation_expectations: string[];
  handoff_instructions: string[];
  requirement_summary?: string | null;
  planning_decision_id?: string | null;
  planner_output?: PlannerDecision | null;
  approved_plan?: ApprovedPlanRecord | null;
  user_approved_worker_count?: number | null;
  user_approved_worker_mode?: WorkerType | null;
  created_at: string;
  updated_at: string;
}

export type WorkerRuntimeCommandRequestStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface WorkerRuntimeCommandRequest {
  request_id: string;
  session_id?: string | null;
  task_id: string;
  project_id: string;
  worker_id: string;
  command: string;
  cwd: string;
  workspace_path: string;
  status: WorkerRuntimeCommandRequestStatus;
  approved_by_user: boolean;
  created_at: string;
  claimed_at?: string | null;
  claimed_by_attempt_id?: string | null;
  completed_at?: string | null;
  command_event_id?: string | null;
  error?: string | null;
}

export type CommandRiskLevel = "low" | "medium" | "high" | "blocked";

export interface CommandEventRecord {
  event_id: string;
  task_id: string;
  project_id: string;
  worker_id: string;
  worker_mode?: WorkerType;
  actual_image_uri?: string;
  actual_image_digest?: string;
  vm_name?: string;
  docker_container_id?: string;
  docker_container_name?: string;
  startup_attempt_id?: string;
  run_attempt_id?: string;
  container_started_at?: string;
  worker_runtime_version?: string;
  runtime_metadata_verified?: boolean;
  codex_session_id?: string | null;
  codex_rollout_path?: string | null;
  codex_rollout_host_path?: string | null;
  codex_rollout_relative_path?: string | null;
  codex_home?: string | null;
  codex_home_host_path?: string | null;
  codex_auth_method?: string | null;
  codex_auth_secret_resource?: string | null;
  codex_auth_validated_at?: string | null;
  codex_auth_validation_status?: "validated" | "not_configured" | "failed" | null;
  codex_history_kind?: "interactive" | "exec" | null;
  codex_resume_command?: string | null;
  codex_prompt_excerpt?: string | null;
  codex_model?: string | null;
  codex_started_at?: string | null;
  codex_completed_at?: string | null;
  codex_history_confidence?: string | null;
  codex_history_verification_command?: string | null;
  codex_visibility_mirror_id?: string | null;
  codex_visibility_mirror_prompt?: string | null;
  codex_visibility_mirror_created?: boolean;
  command: string;
  cwd: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  stdout_ref: string | null;
  stderr_ref: string | null;
  stdout_preview: string;
  stderr_preview: string;
  summary: string;
  risk_level: CommandRiskLevel;
  approved_by_user: boolean;
  created_at: string;
}

export interface RunSummaryRecord {
  task_id: string;
  executive_summary: string;
  technical_summary: string;
  commands_run: string[];
  files_changed: string[];
  tests_run: string[];
  failures: string[];
  current_state: string;
  next_plan: string[];
  confidence: "low" | "medium" | "high";
  created_at: string;
}

export interface ApprovalRequestRecord {
  approval_id: string;
  task_id: string;
  project_id: string;
  requested_action: string;
  reason: string;
  risk_level: CommandRiskLevel;
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  resolved_at: string | null;
}

export type OperatorActionType =
  | "inspect_system"
  | "list_workers"
  | "inspect_worker"
  | "start_worker"
  | "stop_worker"
  | "restart_worker"
  | "assign_worker"
  | "cancel_task"
  | "retry_task"
  | "run_worker_command"
  | "run_project_command"
  | "inspect_task"
  | "inspect_command"
  | "tail_worker_logs"
  | "tail_task_logs"
  | "tail_api_logs"
  | "open_preview"
  | "cleanup_idle_workers"
  | "inspect_codex_history"
  | "inspect_project_docs"
  | "inspect_functions"
  | "inspect_variables"
  | "inspect_state_model"
  | "inspect_handoff"
  | "update_project_docs"
  | "summarize_current_state"
  | "request_approval";

export type OperatorActionStatus = "queued" | "running" | "waiting_for_approval" | "completed" | "failed" | "rejected" | "blocked";

export interface OperatorActionRecord {
  action_id: string;
  action_type: OperatorActionType;
  session_id: string;
  project_id?: string | null;
  task_id?: string | null;
  worker_id?: string | null;
  command_id?: string | null;
  approval_id?: string | null;
  user_goal: string;
  normalized_intent: string;
  input: Record<string, unknown>;
  risk_level: CommandRiskLevel;
  requires_approval: boolean;
  status: OperatorActionStatus;
  started_at: string;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface OrchestratorSettings {
  default_worker_mode: WorkerType;
  allow_worker_mode_switch: boolean;
  max_local_workers: number;
  max_docker_local_workers: number;
  max_gcp_vm_workers: number;
  max_gke_job_workers: number;
  updated_at: string;
}

export interface ModelProviderIndicators {
  supervisor_model_provider: string;
  planner_model_provider: string;
  worker_code_model: string;
}

export interface OrchestratorEvent {
  event_id: string;
  scope: "session" | "project" | "task" | "task_graph" | "worker" | "worker_context" | "command" | "approval" | "mcp" | "preview" | "operator_action" | "git" | "docs" | "planning";
  scope_id: string;
  type: string;
  message: string;
  data?: unknown;
  created_at: string;
}

export interface McpToolCallRecord {
  mcp_call_id: string;
  mcp_server: string;
  tool_name: string;
  input_summary: string;
  started_at: string;
  ended_at: string | null;
  status: "running" | "completed" | "failed";
  result_summary: string;
  error: string | null;
  task_id?: string;
  project_id?: string;
  session_id?: string;
  worker_id?: string;
}

export type FlowchartNodeType =
  | "channel"
  | "session"
  | "orchestrator"
  | "project"
  | "task"
  | "worker"
  | "command"
  | "summary"
  | "approval"
  | "artifact"
  | "mcp_action"
  | "preview"
  | "operator_action"
  | "worker_control"
  | "command_action"
  | "log_inspection"
  | "codex_history"
  | "task_graph"
  | "task_graph_node"
  | "worktree"
  | "shared_docs"
  | "project_docs"
  | "code_index"
  | "function_docs"
  | "variable_docs"
  | "state_model_docs"
  | "worker_handoff"
  | "merge_review"
  | "requirement_summary"
  | "clarification_question"
  | "planner_decision"
  | "proposed_design"
  | "task_split_proposal"
  | "user_approval"
  | "approved_plan"
  | "execution_start"
  | "user_request"
  | "codex_plan"
  | "codex_session"
  | "codex_subagent"
  | "files_changed"
  | "validation"
  | "final_summary";

export type FlowchartVisualState = "idle" | "planning" | "waiting_for_approval" | "completed" | "failed" | "running" | "warning";

export interface FlowchartNode {
  id: string;
  type: FlowchartNodeType;
  label: string;
  status: string;
  visual_state: FlowchartVisualState;
  badges: string[];
  summary: string;
  detail: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface FlowchartEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface FlowchartState {
  generated_at: string;
  worker_settings: OrchestratorSettings;
  model_providers: ModelProviderIndicators;
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
  events: OrchestratorEvent[];
}

export interface ProjectDiscoveryTurn {
  ts: string;
  role: "user" | "assistant";
  text: string;
}

export interface ProjectDiscoveryState {
  status: "collecting" | "selected";
  selected_workspace_path: string | null;
  selected_project_name: string | null;
  confidence: "low" | "medium" | "high" | null;
  reason: string;
  last_question: string;
  conversation: ProjectDiscoveryTurn[];
}

export type PlannerDecisionType =
  | "answer_status_question"
  | "ask_clarification"
  | "summarize_requirements"
  | "propose_design"
  | "propose_task_split"
  | "request_user_approval"
  | "start_simple_task"
  | "start_multi_worker_task"
  | "revise_plan"
  | "wait_for_user"
  | "continue_execution"
  | "request_risky_action_approval"
  | "explain_blocker";

export type PlannerNextAction = "none" | "create_project" | "create_task_graph" | "launch_workers" | "answer_only";

export interface PlannerTaskSplitItem {
  title: string;
  goal: string;
  can_run_parallel: boolean;
  depends_on: string[];
  expected_files: string[];
  validation: string[];
}

export interface CodexSubagentAdvice {
  recommended: boolean;
  confidence: number;
  reason: string;
  user_check_in: string;
  suggested_responsibilities: string[];
  source: "codex_cli" | "planner_context";
  error?: string | null;
}

export interface PlannerDecision {
  planning_decision_id?: string;
  decision_type: PlannerDecisionType;
  confidence: number;
  reason: string;
  user_visible_response: string;
  requirements_summary: string;
  open_questions: string[];
  assumptions: string[];
  proposed_design: string;
  proposed_task_split: PlannerTaskSplitItem[];
  recommended_worker_count: number;
  recommended_worker_mode: WorkerType;
  requires_user_approval: boolean;
  approval_reason: string;
  risk_level: CommandRiskLevel;
  next_action: PlannerNextAction;
  execution_allowed: boolean;
  subagent_advice?: CodexSubagentAdvice | null;
}

export interface ApprovedPlanRecord {
  planning_decision_id: string;
  approved_at: string;
  approved_by_channel?: Channel | null;
  requirements_summary: string;
  proposed_design: string;
  proposed_task_split: PlannerTaskSplitItem[];
  worker_count: number;
  worker_mode: WorkerType;
  approval_reason: string;
  risk_level: CommandRiskLevel;
  subagent_advice?: CodexSubagentAdvice | null;
}

export interface DesignDecisionRecord {
  planning_decision_id: string;
  ts: string;
  decision_type: PlannerDecisionType;
  reason: string;
  requirements_summary: string;
  assumptions: string[];
  open_questions: string[];
  worker_count: number;
  worker_mode: WorkerType;
  approval_status: "not_required" | "pending" | "approved" | "rejected";
}

export interface SessionState {
  session_id: string;
  user_id: string | null;
  channel: Channel | null;
  active_task: string;
  active_task_id: string | null;
  active_worker_id: string | null;
  current_project_id: string | null;
  current_status: SessionStatus;
  status: SessionStatus;
  latest_codex_message: string;
  files_read: string[];
  files_modified: string[];
  commands_requested: string[];
  commands_completed: string[];
  commands_failed: string[];
  pending_approvals: PendingApproval[];
  test_results: TestResult[];
  errors: string[];
  git_diff_summary: string;
  raw_events: SupervisorEvent[];
  last_updated: string;
  workspace_path: string;
  project_id: string | null;
  pending_action: PendingAction | null;
  pending_action_payload: Record<string, unknown> | null;
  created_at: string;
  summary_text: string;
  latest_summary: string;
  latest_plan: string[];
  preferred_worker_mode: WorkerType | null;
  recent_messages: ConversationMessage[];
  instruction_history: Array<{ ts: string; text: string; source: "start" | "instruct" | "call" | "approval" }>;
  project_discovery: ProjectDiscoveryState;
  requirement_summary?: string | null;
  planning_decision_id?: string | null;
  planner_model?: string | null;
  planner_output?: PlannerDecision | null;
  approved_plan?: ApprovedPlanRecord | null;
  approval_status?: "not_required" | "pending" | "approved" | "rejected" | null;
  open_questions?: string[];
  assumptions?: string[];
  design_decision_history?: DesignDecisionRecord[];
  user_approved_worker_count?: number | null;
  user_approved_worker_mode?: WorkerType | null;
  codex_conversation_session_id?: string | null;
  codex_conversation_resume_command?: string | null;
  codex_conversation_mirrored_at?: string | null;
  codex_conversation_mirror_error?: string | null;
}

export interface PersistedState {
  sessions: Record<string, SessionState>;
  projects: Record<string, ProjectRecord>;
  tasks: Record<string, TaskRecord>;
  workers: Record<string, WorkerRecord>;
  command_events: Record<string, CommandEventRecord>;
  run_summaries: Record<string, RunSummaryRecord>;
  approval_requests: Record<string, ApprovalRequestRecord>;
  orchestrator_events: OrchestratorEvent[];
  orchestrator_settings: OrchestratorSettings | null;
  mcp_tool_calls: Record<string, McpToolCallRecord>;
  operator_actions: Record<string, OperatorActionRecord>;
  task_graphs: Record<string, TaskGraphRecord>;
  worker_context_packets: Record<string, WorkerContextPacket>;
  worker_runtime_command_requests: Record<string, WorkerRuntimeCommandRequest>;
  project_artifacts: Record<string, ProjectArtifactFileRecord>;
}

export interface UserMessage {
  userId: string;
  channel: Channel;
  text: string;
  sessionId?: string;
  projectId?: string;
  externalConversationId?: string;
  timestamp: string;
}

export interface AgentResponse {
  text: string;
  sessionId?: string;
  projectId?: string;
  taskId?: string;
  workerId?: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

export interface AccessSummary {
  workspace_path: string;
  repo_name: string | null;
  current_branch: string | null;
  git_status: string;
  environment_variable_names: string[];
  detectable_config_files: string[];
  codex_cli_installed: boolean;
  codex_version: string | null;
  workspace_cleanliness: "clean" | "dirty" | "unknown";
  approval_policy: {
    network_requires_approval: boolean;
    shell_requires_approval: boolean;
    destructive_requires_approval: boolean;
  };
}
