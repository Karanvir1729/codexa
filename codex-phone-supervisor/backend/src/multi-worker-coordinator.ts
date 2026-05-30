import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import { completionGatePassed, evaluateTaskGraphNodeCompletion } from "./completion-gate.js";
import { documentationIndexer } from "./documentation-indexer.js";
import { gitProjectManager } from "./git-project-manager.js";
import { taskComplexityJudge } from "./task-complexity.js";
import { workerManagerFor } from "./workers.js";
import {
  appendOrchestratorEvent,
  getTask,
  getTaskGraph,
  getWorker,
  listCommandEvents,
  listTasks,
  listWorkers,
  upsertTask,
  upsertTaskGraph,
  upsertWorkerContextPacket,
} from "./store.js";
import { getProject } from "./project-store.js";
import type {
  ProjectRecord,
  TaskComplexityDecision,
  TaskGraphNode,
  TaskGraphRecord,
  TaskRecord,
  WorkerContextPacket,
  WorkerOutputContract,
  WorkerType,
} from "./types.js";

const sharedDocFiles = [
  ".head-developer/PROJECT_BRIEF.md",
  ".head-developer/TASK_GRAPH.md",
  ".head-developer/ARCHITECTURE.md",
  ".head-developer/CODE_INDEX.md",
  ".head-developer/FUNCTIONS.md",
  ".head-developer/VARIABLES.md",
  ".head-developer/API_SURFACE.md",
  ".head-developer/STATE_MODEL.md",
  ".head-developer/WORKER_HANDOFFS.md",
  ".head-developer/DECISIONS.md",
  ".head-developer/RUNBOOK.md",
  ".head-developer/VALIDATION.md",
];

function normalizeGoal(goal: string) {
  return goal.trim().toLowerCase().replace(/\s+/g, " ");
}

function taskPlan(goal: string, graph: TaskGraphRecord | null) {
  return [
    `Read shared project docs before acting.`,
    `Understand task goal: ${goal}`,
    graph ? `Follow task graph ${graph.task_graph_id} and respect dependencies.` : "Use single-worker execution.",
    "Work only inside the assigned repo/worktree.",
    "Update .head-developer handoff and validation docs.",
    "Return changed files, validation results, and blockers with command evidence.",
  ];
}

function graphStatus(nodes: TaskGraphNode[]): TaskGraphRecord["status"] {
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.some((node) => node.status === "needs_repair")) return "review";
  if (nodes.length && nodes.every((node) => node.status === "completed")) return "completed";
  if (nodes.length && nodes.every((node) => node.status === "cancelled")) return "cancelled";
  if (nodes.some((node) => node.status === "running")) return "running";
  return "queued";
}

function nodeIdForTitle(title: string, index: number) {
  return `node_${index + 1}_${title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "task"}`;
}

function executionStrategy(decision: TaskComplexityDecision, workerMode: WorkerType): TaskGraphRecord["execution_strategy"] {
  if (!decision.should_split) return "single_worker";
  if (decision.recommended_worker_count <= 1) return "sequential";
  if (decision.parallelizable && config.orchestrator.allowParallelWorkers && (workerMode === "docker_local" || workerMode === "gke_job")) return "parallel_worktrees";
  return "sequential";
}

function dependencyTitles(graph: TaskGraphRecord, node: TaskGraphNode) {
  return node.dependencies.map((title) => graph.nodes.find((candidate) => candidate.title === title || candidate.node_id === title)?.title ?? title);
}

function dependenciesComplete(graph: TaskGraphRecord, node: TaskGraphNode) {
  return dependencyTitles(graph, node).every((title) => {
    const dependency = graph.nodes.find((candidate) => candidate.title === title || candidate.node_id === title);
    return dependency?.status === "completed";
  });
}

function isDocPath(file: string) {
  return file.startsWith(".head-developer/");
}

function isOrchestratorSetupNode(node: TaskGraphNode) {
  if (!/project setup|shared docs/i.test(node.title)) return false;
  const requiredFiles = [
    ...(node.files_expected ?? []),
    ...(node.output_contract?.required_app_files ?? []),
  ];
  return requiredFiles.filter((file) => !isDocPath(file)).length === 0;
}

function validationCommandsFor(expectedFiles: string[]) {
  const commands = ["find . -maxdepth 4 -type f | sort"];
  for (const file of expectedFiles) {
    if (isDocPath(file)) continue;
    if (/^[\w./-]+\.[\w-]+$/.test(file)) commands.push(`test -f ${file}`);
  }
  commands.push("node --check script.js when script.js exists");
  commands.push("node --check scripts/*.js when scripts directory exists");
  return Array.from(new Set(commands));
}

function buildOutputContract(input: {
  title: string;
  filesExpected: string[];
  outputsExpected: string[];
  provided?: WorkerOutputContract;
}): WorkerOutputContract {
  const docFiles = input.filesExpected.filter(isDocPath);
  const requiredAppFiles = input.filesExpected.filter((file) => !isDocPath(file));
  const appNode = requiredAppFiles.length > 0 && !/project setup|shared docs/i.test(input.title);
  return {
    required_app_files: input.provided?.required_app_files?.length ? input.provided.required_app_files : requiredAppFiles,
    allowed_doc_files: input.provided?.allowed_doc_files?.length ? input.provided.allowed_doc_files : Array.from(new Set([...sharedDocFiles, ...docFiles])),
    expected_user_visible_output: input.provided?.expected_user_visible_output?.length
      ? input.provided.expected_user_visible_output
      : appNode
        ? [`User-visible ${input.title.toLowerCase()} implementation`, ...input.outputsExpected]
        : input.outputsExpected,
    validation_commands: input.provided?.validation_commands?.length ? input.provided.validation_commands : validationCommandsFor(input.filesExpected),
    acceptance_checks: input.provided?.acceptance_checks?.length
      ? input.provided.acceptance_checks
      : [
        "Required app/source files exist in the assigned repo or worktree.",
        "Validation commands were run or a blocker was reported with command evidence.",
        "Changed files and validation results are recorded in the worker handoff.",
        appNode ? "At least one non-.head-developer app/source file changed." : "Required documentation files were updated.",
      ],
    completion_criteria: input.provided?.completion_criteria?.length
      ? input.provided.completion_criteria
      : [
        appNode
          ? "Do not report the task complete if only .head-developer docs changed."
          : "Documentation updates must reflect the actual project/task state.",
        "Report incomplete or blocked work honestly instead of claiming success.",
      ],
    docs_only_is_insufficient: input.provided?.docs_only_is_insufficient ?? appNode,
  };
}

export class MultiWorkerCoordinator {
  judge(goal: string, project: ProjectRecord | null = null) {
    return taskComplexityJudge.evaluate({
      user_goal: goal,
      current_project: project,
      active_tasks: project ? listTasks(project.project_id) : [],
      active_workers: listWorkers(),
    });
  }

  createTaskGraph(
    project: ProjectRecord,
    rootUserGoal: string,
    workerMode: WorkerType,
    options: {
      decision?: TaskComplexityDecision;
      planning?: Pick<
        TaskGraphRecord,
        | "requirement_summary"
        | "planning_decision_id"
        | "planner_model"
        | "planner_output"
        | "approved_plan"
        | "approval_status"
        | "open_questions"
        | "assumptions"
        | "design_decision_history"
        | "user_approved_worker_count"
        | "user_approved_worker_mode"
      >;
    } = {},
  ): TaskGraphRecord {
    const decision = options.decision ?? this.judge(rootUserGoal, project);
    const now = new Date().toISOString();
    const taskGraphId = `task_graph_${randomUUID()}`;
    const strategy = executionStrategy(decision, workerMode);
    const graphShell: TaskGraphRecord = {
      task_graph_id: taskGraphId,
      project_id: project.project_id,
      root_user_goal: rootUserGoal,
      status: options.planning?.approval_status === "approved" ? "queued" : decision.approval_needed ? "proposed" : "queued",
      complexity: decision,
      nodes: [],
      edges: decision.dependency_graph.map((edge) => ({
        from_node_id: edge.from,
        to_node_id: edge.to,
        relationship: edge.relationship,
      })),
      recommended_worker_count: decision.recommended_worker_count,
      execution_strategy: strategy,
      requirement_summary: options.planning?.requirement_summary ?? null,
      planning_decision_id: options.planning?.planning_decision_id ?? null,
      planner_model: options.planning?.planner_model ?? null,
      planner_output: options.planning?.planner_output ?? null,
      approved_plan: options.planning?.approved_plan ?? null,
      approval_status: options.planning?.approval_status ?? null,
      open_questions: options.planning?.open_questions ?? [],
      assumptions: options.planning?.assumptions ?? [],
      design_decision_history: options.planning?.design_decision_history ?? [],
      user_approved_worker_count: options.planning?.user_approved_worker_count ?? null,
      user_approved_worker_mode: options.planning?.user_approved_worker_mode ?? null,
      created_at: now,
      updated_at: now,
    };

    const nodes = decision.suggested_subtasks.map((item, index) => {
      const nodeId = nodeIdForTitle(item.title, index);
      const task: TaskRecord = {
        task_id: `task_${randomUUID()}`,
        project_id: project.project_id,
        user_goal: item.goal,
        normalized_goal: normalizeGoal(item.goal),
        status: item.dependencies.length ? "queued" : "queued",
        plan: taskPlan(item.goal, graphShell),
        worker_id: null,
        codex_run_id: null,
        command_count: 0,
        latest_summary: "Task graph node is queued.",
        next_steps: ["Wait for dependency clearance.", "Assign a worker."],
        task_graph_id: taskGraphId,
        task_graph_node_id: nodeId,
        branch_name: null,
        worktree_path: null,
        worker_context_packet_id: null,
        created_at: now,
        updated_at: now,
      };
      upsertTask(task);
      appendOrchestratorEvent({
        scope: "task_graph",
        scope_id: taskGraphId,
        type: "task_graph.node.created",
        message: `Created task graph node ${item.title}.`,
        data: { node_id: nodeId, task },
      });
      const outputContract = buildOutputContract({
        title: item.title,
        filesExpected: item.files_expected,
        outputsExpected: item.outputs_expected,
        provided: item.output_contract,
      });
      return {
        node_id: nodeId,
        task_id: task.task_id,
        title: item.title,
        goal: item.goal,
        assigned_worker_id: null,
        status: "queued" as const,
        dependencies: item.dependencies,
        outputs_expected: item.outputs_expected,
        files_expected: item.files_expected,
        output_contract: outputContract,
        required_app_files: outputContract.required_app_files,
        allowed_doc_files: outputContract.allowed_doc_files,
        expected_user_visible_output: outputContract.expected_user_visible_output,
        validation_commands: outputContract.validation_commands,
        acceptance_checks: outputContract.acceptance_checks,
        completion_criteria: outputContract.completion_criteria,
        completion_gate: null,
        branch_name: null,
        worktree_path: null,
        summary: "Queued.",
        created_at: now,
        updated_at: now,
      };
    });

    const graph: TaskGraphRecord = { ...graphShell, nodes };
    upsertTaskGraph(graph);
    gitProjectManager.ensureSharedDocs(project, graph, rootUserGoal);
    appendOrchestratorEvent({
      scope: "task_graph",
      scope_id: graph.task_graph_id,
      type: "task_graph.created",
      message: `Created task graph for ${project.display_name}.`,
      data: graph,
    });
    appendOrchestratorEvent({
      scope: "task_graph",
      scope_id: graph.task_graph_id,
      type: "multi_worker.plan.created",
      message: `Plan: ${decision.complexity}; ${nodes.length} node(s); strategy ${strategy}.`,
      data: { graph, decision },
    });
    return graph;
  }

  async prepareProject(project: ProjectRecord, graph: TaskGraphRecord) {
    const firstTask = getTask(graph.nodes[0]?.task_id);
    if (!firstTask) return project;
    const result = await gitProjectManager.ensureProjectRepo(project, firstTask);
    gitProjectManager.ensureSharedDocs(result.project, graph, graph.root_user_goal);
    await gitProjectManager.commitProjectDocs(result.project, firstTask);
    return getProject(project.project_id) ?? result.project;
  }

  buildWorkerContext(project: ProjectRecord, graph: TaskGraphRecord, node: TaskGraphNode, workerId?: string | null): WorkerContextPacket {
    const now = new Date().toISOString();
    documentationIndexer.updateProjectDocs(project);
    const docs = gitProjectManager.readSharedDocs(project);
    const outputContract = node.output_contract ?? buildOutputContract({
      title: node.title,
      filesExpected: node.files_expected,
      outputsExpected: node.outputs_expected,
    });
    const packet: WorkerContextPacket = {
      context_packet_id: `context_${randomUUID()}`,
      task_graph_id: graph.task_graph_id,
      node_id: node.node_id,
      task_id: node.task_id,
      project_id: project.project_id,
      worker_id: workerId ?? null,
      project_brief: docs[".head-developer/PROJECT_BRIEF.md"] || graph.root_user_goal,
      current_task_goal: node.goal,
      task_graph_node: node,
      dependencies_completed: dependencyTitles(graph, node).filter((title) => graph.nodes.find((candidate) => candidate.title === title)?.status === "completed"),
      relevant_docs: docs,
      allowed_roots: [node.worktree_path || project.workspace_path],
      branch_name: node.branch_name ?? null,
      worktree_path: node.worktree_path ?? null,
      expected_files: node.files_expected,
      validation_commands: outputContract.validation_commands,
      output_contract: outputContract,
      constraints: [
        "Read shared docs first.",
        "Use CODE_INDEX.md, FUNCTIONS.md, VARIABLES.md, and STATE_MODEL.md to understand existing files before changing them.",
        "Work only inside the assigned repo/worktree.",
        "Do not overwrite unrelated work.",
        "Do not claim success without command/file evidence.",
        outputContract.docs_only_is_insufficient ? "Updating .head-developer docs alone is not sufficient for this task." : "Keep documentation updates grounded in actual work.",
      ],
      expected_output: node.outputs_expected,
      commands_allowed: ["codex exec", "git status", "git diff", "node --check", "npm test/build/lint/typecheck when configured"],
      validation_expectations: [
        "Run the validation commands from the output contract when applicable.",
        "Update .head-developer/VALIDATION.md with commands, exit codes, and results.",
        "Ensure changed files/functions/config/state are reflected in CODE_INDEX.md, FUNCTIONS.md, VARIABLES.md, API_SURFACE.md, or STATE_MODEL.md.",
      ],
      handoff_instructions: [
        "Update .head-developer/WORKER_HANDOFFS.md with changed files, blockers, and next steps.",
        "Update documentation indexes after code changes; stale docs require a follow-up docs task.",
        "If required app files are missing, mark the handoff incomplete and explain what remains.",
      ],
      requirement_summary: graph.requirement_summary ?? null,
      planning_decision_id: graph.planning_decision_id ?? null,
      planner_output: graph.planner_output ?? null,
      approved_plan: graph.approved_plan ?? null,
      user_approved_worker_count: graph.user_approved_worker_count ?? null,
      user_approved_worker_mode: graph.user_approved_worker_mode ?? null,
      created_at: now,
      updated_at: now,
    };
    upsertWorkerContextPacket(packet);
    appendOrchestratorEvent({
      scope: "worker_context",
      scope_id: packet.context_packet_id,
      type: "worker_context.created",
      message: `Created worker context for ${node.title}.`,
      data: packet,
    });
    return packet;
  }

  readyNodes(graph: TaskGraphRecord) {
    return graph.nodes.filter((node) => node.status === "queued" && dependenciesComplete(graph, node));
  }

  private completeOrchestratorSetupNodes(project: ProjectRecord, graph: TaskGraphRecord) {
    const completed: TaskGraphNode[] = [];
    for (const node of this.readyNodes(graph)) {
      if (!isOrchestratorSetupNode(node)) continue;
      const task = getTask(node.task_id);
      if (!task) continue;
      const now = new Date().toISOString();
      task.status = "completed";
      task.latest_summary = "Project repo and shared Head Developer docs were initialized by orchestrator command events.";
      task.next_steps = ["Start dependent worker subtasks.", "Keep workers inside their assigned worktrees."];
      task.updated_at = now;
      upsertTask(task);
      node.status = "completed";
      node.summary = task.latest_summary;
      node.completion_gate = {
        status: "not_applicable",
        evaluated_at: now,
        reasons: ["Orchestrator setup node completed by repo/docs command evidence."],
        changed_files: node.files_expected,
        app_files: [],
        docs_only: true,
        missing_required_app_files: [],
        validation_commands_run: [],
        missing_validation_commands: [],
      };
      node.updated_at = now;
      completed.push(node);
      appendOrchestratorEvent({
        scope: "task_graph",
        scope_id: graph.task_graph_id,
        type: "task_graph.node.completed",
        message: `Completed orchestration setup node ${node.title}.`,
        data: { node, task_id: task.task_id, source: "orchestrator_repo_docs_commands" },
      });
    }
    if (completed.length) {
      graph.status = graphStatus(graph.nodes);
      graph.updated_at = new Date().toISOString();
      upsertTaskGraph(graph);
      gitProjectManager.ensureSharedDocs(project, graph, graph.root_user_goal);
    }
    return completed;
  }

  async startReadyWork(taskGraphId: string, workerMode: WorkerType, requestedWorkers?: number) {
    const graph = getTaskGraph(taskGraphId);
    if (!graph) throw new Error(`Task graph not found: ${taskGraphId}`);
    const project = getProject(graph.project_id);
    if (!project) throw new Error(`Project not found: ${graph.project_id}`);
    const maxWorkers = Math.max(1, Math.min(
      requestedWorkers ?? graph.recommended_worker_count,
      config.orchestrator.maxParallelWorkers,
      workerMode === "docker_local"
        ? config.orchestrator.maxDockerLocalWorkers
        : workerMode === "gcp_vm"
          ? config.orchestrator.maxGcpVmWorkers
          : workerMode === "gke_job"
            ? config.orchestrator.maxGkeJobWorkers
            : config.orchestrator.maxLocalWorkers,
    ));
    this.completeOrchestratorSetupNodes(project, graph);
    const ready = this.readyNodes(graph);
    const assignable = graph.execution_strategy === "parallel_worktrees" ? ready.slice(0, maxWorkers) : ready.slice(0, 1);
    const assignments = [];
    const manager = workerManagerFor(workerMode);
    await manager.enforceWorkerLimits();
    for (const node of assignable) {
      const task = getTask(node.task_id);
      if (!task) continue;
      let worktree = { branch_name: node.branch_name ?? null, worktree_path: node.worktree_path ?? null };
      if (workerMode === "gke_job") {
        worktree = { branch_name: null, worktree_path: "/workspace" };
        node.branch_name = null;
        node.worktree_path = worktree.worktree_path;
        task.branch_name = null;
        task.worktree_path = worktree.worktree_path;
      } else if (graph.execution_strategy === "parallel_worktrees") {
        worktree = await gitProjectManager.createWorktree(project, task, node.title, "orchestrator");
        node.branch_name = worktree.branch_name;
        node.worktree_path = worktree.worktree_path;
        task.branch_name = worktree.branch_name;
        task.worktree_path = worktree.worktree_path;
      } else {
        task.worktree_path = project.workspace_path;
        task.branch_name = project.git_branch ?? project.default_branch ?? null;
      }
      const worker = await manager.createWorker(task.task_id, task.project_id, workerMode);
      const packet = this.buildWorkerContext(project, graph, { ...node, ...worktree }, worker.worker_id);
      task.worker_context_packet_id = packet.context_packet_id;
      task.plan = taskPlan(task.user_goal, graph);
      task.next_steps = ["Worker assigned.", "Run Codex with shared docs context."];
      upsertTask(task);
      await manager.assignTask(worker.worker_id, task.task_id);
      const assignedWorker = getWorker(worker.worker_id) ?? worker;
      node.assigned_worker_id = assignedWorker.worker_id;
      node.status = "running";
      node.summary = `Assigned to ${workerMode} worker ${assignedWorker.worker_id}.`;
      node.updated_at = new Date().toISOString();
      assignments.push({ node, task: getTask(task.task_id) ?? task, worker: assignedWorker, context: packet });
      appendOrchestratorEvent({
        scope: "task_graph",
        scope_id: graph.task_graph_id,
        type: "task_graph.node.assigned",
        message: `Assigned ${node.title} to ${assignedWorker.worker_id}.`,
        data: { node, task_id: task.task_id, worker_id: assignedWorker.worker_id },
      });
    }
    graph.status = graphStatus(graph.nodes);
    graph.updated_at = new Date().toISOString();
    upsertTaskGraph(graph);
    gitProjectManager.ensureSharedDocs(project, graph, graph.root_user_goal);
    appendOrchestratorEvent({
      scope: "task_graph",
      scope_id: graph.task_graph_id,
      type: "multi_worker.execution.started",
      message: `Started ${assignments.length} task graph node(s).`,
      data: { task_graph_id: graph.task_graph_id, worker_mode: workerMode, assignments },
    });
    return { graph, assignments };
  }

  async createAndMaybeStart(project: ProjectRecord, rootUserGoal: string, workerMode: WorkerType, options: { autoStart?: boolean; workers?: number } = {}) {
    const graph = this.createTaskGraph(project, rootUserGoal, workerMode);
    const shouldPrepareProject = workerMode !== "gke_job";
    const preparedProject = shouldPrepareProject ? await this.prepareProject(project, graph) : getProject(project.project_id) ?? project;
    if (!options.autoStart || graph.status === "proposed") return { graph, project: preparedProject, assignments: [] };
    const started = await this.startReadyWork(graph.task_graph_id, workerMode, options.workers);
    return { graph: started.graph, project: preparedProject, assignments: started.assignments };
  }

  async advanceAfterTaskResult(task: TaskRecord, workerMode: WorkerType) {
    if (!task.task_graph_id || !task.task_graph_node_id) return { graph: null, assignments: [] };
    const graph = getTaskGraph(task.task_graph_id);
    if (!graph) return { graph: null, assignments: [] };
    const node = graph.nodes.find((item) => item.node_id === task.task_graph_node_id);
    if (!node) return { graph, assignments: [] };
    let gateFailed = false;
    if (task.status === "completed") {
      const completionGate = evaluateTaskGraphNodeCompletion({
        node,
        commandEvents: listCommandEvents({ taskId: task.task_id }),
      });
      node.completion_gate = completionGate;
      task.completion_gate_status = completionGate.status;
      task.completion_gate_reasons = completionGate.reasons;
      task.completion_gate_missing_required_app_files = completionGate.missing_required_app_files;
      task.completion_gate_docs_only = completionGate.docs_only;
      if (completionGatePassed(completionGate)) {
        node.status = "completed";
        node.summary = node.repair_task_for_node_id
          ? `${node.title} completed and repaired ${node.repair_task_for_node_id}.`
          : node.summary;
        const repairedNode = node.repair_task_for_node_id
          ? graph.nodes.find((candidate) => candidate.node_id === node.repair_task_for_node_id)
          : null;
        if (repairedNode?.status === "needs_repair") {
          repairedNode.status = "completed";
          repairedNode.summary = `Repaired by ${node.title}.`;
          repairedNode.completion_gate = completionGate;
          repairedNode.updated_at = new Date().toISOString();
          const repairedTask = getTask(repairedNode.task_id);
          if (repairedTask) {
            repairedTask.status = "completed";
            repairedTask.latest_summary = repairedNode.summary;
            repairedTask.next_steps = ["Repair completed.", "Continue dependent task graph nodes."];
            repairedTask.updated_at = repairedNode.updated_at;
            upsertTask(repairedTask);
          }
        }
        task.updated_at = new Date().toISOString();
        upsertTask(task);
      } else {
        gateFailed = true;
        node.status = "needs_repair";
        task.status = "failed";
        task.latest_summary = `Completion gate failed for ${node.title}: ${completionGate.reasons.join(" ")}`;
        task.next_steps = ["Create a repair task for missing app output.", "Do not mark this graph complete until output contract evidence exists."];
        task.updated_at = new Date().toISOString();
        upsertTask(task);
        const repairNodeId = `${node.node_id}_repair`;
        if (!graph.nodes.some((candidate) => candidate.node_id === repairNodeId)) {
          const now = new Date().toISOString();
          const repairTask: TaskRecord = {
            task_id: `task_${randomUUID()}`,
            project_id: task.project_id,
            user_goal: `Repair incomplete output for ${node.title}. ${completionGate.reasons.join(" ")}`,
            normalized_goal: normalizeGoal(`Repair incomplete output for ${node.title}. ${completionGate.reasons.join(" ")}`),
            status: "queued",
            plan: taskPlan(`Repair incomplete output for ${node.title}.`, graph),
            worker_id: null,
            codex_run_id: null,
            command_count: 0,
            latest_summary: "Repair task queued because the completion gate rejected the previous output.",
            next_steps: ["Assign a worker to produce the missing app/source files.", "Rerun validation after repair."],
            task_graph_id: graph.task_graph_id,
            task_graph_node_id: repairNodeId,
            branch_name: null,
            worktree_path: null,
            worker_context_packet_id: null,
            created_at: now,
            updated_at: now,
          };
          const repairNode: TaskGraphNode = {
            ...node,
            node_id: repairNodeId,
            task_id: repairTask.task_id,
            title: `Repair ${node.title}`,
            goal: repairTask.user_goal,
            assigned_worker_id: null,
            status: "queued",
            dependencies: node.dependencies,
            completion_gate: null,
            repair_task_for_node_id: node.node_id,
            branch_name: null,
            worktree_path: null,
            summary: repairTask.latest_summary,
            created_at: now,
            updated_at: now,
          };
          upsertTask(repairTask);
          node.repair_task_for_node_id = repairNodeId;
          graph.nodes.push(repairNode);
          graph.edges.push({ from_node_id: node.node_id, to_node_id: repairNodeId, relationship: "reviews" });
          appendOrchestratorEvent({
            scope: "task_graph",
            scope_id: graph.task_graph_id,
            type: "task_graph.node.created",
            message: `Created repair node for ${node.title}.`,
            data: { node: repairNode, task: repairTask, completion_gate: completionGate },
          });
        }
      }
    } else {
      node.status = task.status === "failed"
        ? "failed"
        : task.status === "cancelled"
          ? "cancelled"
          : node.status;
    }
    node.summary = task.latest_summary;
    node.updated_at = new Date().toISOString();
    graph.status = graphStatus(graph.nodes);
    if (graph.status === "failed" || graph.status === "cancelled") {
      const now = new Date().toISOString();
      for (const remaining of graph.nodes) {
        if (remaining.status !== "queued" && remaining.status !== "blocked") continue;
        const remainingTask = getTask(remaining.task_id);
        remaining.status = "cancelled";
        remaining.summary = `Cancelled because task graph ${graph.task_graph_id} is ${graph.status}.`;
        remaining.updated_at = now;
        if (remainingTask) {
          remainingTask.status = "cancelled";
          remainingTask.latest_summary = remaining.summary;
          remainingTask.next_steps = ["Resolve the failed task graph before retrying this node."];
          remainingTask.updated_at = now;
          upsertTask(remainingTask);
        }
      }
      graph.status = graphStatus(graph.nodes);
    }
    graph.updated_at = new Date().toISOString();
    upsertTaskGraph(graph);
    const project = getProject(graph.project_id);
    if (project) gitProjectManager.ensureSharedDocs(project, graph, graph.root_user_goal);
    appendOrchestratorEvent({
      scope: "task_graph",
      scope_id: graph.task_graph_id,
      type: node.status === "completed" ? "task_graph.node.completed" : node.status === "failed" ? "task_graph.node.failed" : node.status === "needs_repair" ? "task_graph.node.needs_repair" : "task_graph.node.cancelled",
      message: `${node.title} is ${node.status}.`,
      data: { node, task_id: task.task_id, completion_gate: node.completion_gate ?? null },
    });
    if (graph.status === "completed" || graph.status === "failed") {
      appendOrchestratorEvent({
        scope: "task_graph",
        scope_id: graph.task_graph_id,
        type: graph.status === "completed" ? "multi_worker.execution.completed" : "multi_worker.execution.failed",
        message: `Task graph ${graph.task_graph_id} is ${graph.status}.`,
        data: graph,
      });
      return { graph, assignments: [] };
    }
    if (gateFailed || task.status !== "completed") return { graph, assignments: [] };
    return this.startReadyWork(graph.task_graph_id, workerMode);
  }
}

export const multiWorkerCoordinator = new MultiWorkerCoordinator();
