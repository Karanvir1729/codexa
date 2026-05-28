import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord, TaskComplexityDecision, TaskGraphEdgeRelationship, TaskRecord, WorkerOutputContract, WorkerRecord } from "./types.js";

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function repoFiles(project: ProjectRecord | null) {
  if (!project?.workspace_path || !fs.existsSync(project.workspace_path)) return [];
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".next", "dist", "build"].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(project!.workspace_path, absolute);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push(relative);
      if (files.length >= 80) return;
    }
  }
  walk(project.workspace_path);
  return files.sort();
}

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

function contract(input: Partial<WorkerOutputContract> = {}): WorkerOutputContract {
  return {
    required_app_files: input.required_app_files ?? [],
    allowed_doc_files: input.allowed_doc_files ?? sharedDocFiles,
    expected_user_visible_output: input.expected_user_visible_output ?? [],
    validation_commands: input.validation_commands ?? [],
    acceptance_checks: input.acceptance_checks ?? [],
    completion_criteria: input.completion_criteria ?? [],
    docs_only_is_insufficient: input.docs_only_is_insufficient ?? Boolean(input.required_app_files?.length || input.expected_user_visible_output?.length),
  };
}

function subtask(
  title: string,
  goal: string,
  dependencies: string[] = [],
  filesExpected: string[] = [],
  outputsExpected: string[] = [],
  outputContract: WorkerOutputContract = contract(),
) {
  return {
    title,
    goal,
    dependencies,
    files_expected: filesExpected,
    outputs_expected: outputsExpected.length ? outputsExpected : [`Completed ${title.toLowerCase()} work with command/file evidence.`],
    output_contract: outputContract,
    required_app_files: outputContract.required_app_files,
    allowed_doc_files: outputContract.allowed_doc_files,
    expected_user_visible_output: outputContract.expected_user_visible_output,
    validation_commands: outputContract.validation_commands,
    acceptance_checks: outputContract.acceptance_checks,
    completion_criteria: outputContract.completion_criteria,
  };
}

function edge(from: string, to: string, relationship: TaskGraphEdgeRelationship = "blocks") {
  return { from, to, relationship };
}

export class TaskComplexityJudge {
  evaluate(input: {
    user_goal: string;
    current_project?: ProjectRecord | null;
    active_tasks?: TaskRecord[];
    active_workers?: WorkerRecord[];
  }): TaskComplexityDecision {
    const goal = normalize(input.user_goal);
    const files = repoFiles(input.current_project ?? null);
    const moduleKeywords = [
      "auth",
      "login",
      "signup",
      "dashboard",
      "admin",
      "billing",
      "stripe",
      "settings",
      "database",
      "api",
      "tests",
      "preview",
      "deploy",
      "saas",
    ].filter((keyword) => goal.includes(keyword));
    const explicitMulti = /\b(with|including|and)\b/.test(goal) && moduleKeywords.length >= 3;
    const simpleLanding = /\b(simple|basic|small|tiny)?\s*(landing page|website|site)\b/.test(goal) && moduleKeywords.length <= 1 && !/\b(auth|billing|admin|dashboard|database|api)\b/.test(goal);
    const noBillingRequested = /\b(no billing|without billing|no stripe|without stripe)\b/.test(goal);
    const noBackendRequested = /\b(no backend|static only|static html|html\/css\/js only)\b/.test(goal);
    const activeTaskRisk = (input.active_tasks ?? []).some((task) => !["completed", "failed", "cancelled"].includes(task.status));
    const staticOnly = /\b(static|html|css|js|javascript|single page|single-page|multi-page|shell)\b/.test(goal) || noBackendRequested;
    const staticSaasShell = staticOnly
      && /\bsaas\b/.test(goal)
      && /\bdashboard\b/.test(goal)
      && /\b(landing|login|settings)\b/.test(goal)
      && noBillingRequested;

    if (simpleLanding) {
      return {
        complexity: "simple",
        recommended_worker_count: 1,
        should_split: false,
        parallelizable: false,
        reason: "The request is a single static website surface with no independent modules.",
        suggested_subtasks: [
          subtask(
            "Build landing page",
            input.user_goal,
            [],
            ["index.html", "styles.css", "script.js"],
            ["Generated user-visible landing page files", "Validation command result"],
            contract({
              required_app_files: ["index.html", "styles.css"],
              expected_user_visible_output: ["A visible landing page matching the user request."],
              validation_commands: ["node --check"],
              acceptance_checks: ["index.html exists", "CSS is referenced", "JS validates when present"],
              completion_criteria: ["At least one non-documentation app file is created or changed.", "Required static app files exist."],
            }),
          ),
        ],
        dependency_graph: [],
        risks: activeTaskRisk ? ["An active task already exists for this project; schedule sequentially."] : [],
        approval_needed: false,
      };
    }

    if (staticSaasShell) {
      const subtasks = [
        subtask(
          "Project setup and shared docs",
          "Create or update the static SaaS shell repo and shared Head Developer docs.",
          [],
          [".head-developer/PROJECT_BRIEF.md", ".head-developer/TASK_GRAPH.md"],
          ["Initialized project repo and shared docs."],
          contract({
            allowed_doc_files: sharedDocFiles,
            acceptance_checks: ["Shared docs exist"],
            completion_criteria: ["Project repo and shared docs are initialized by orchestrator command evidence."],
            docs_only_is_insufficient: false,
          }),
        ),
        subtask(
          "Landing and login pages",
          "Build the static landing page and login page for the SaaS dashboard shell.",
          ["Project setup and shared docs"],
          ["index.html", "login.html", "styles/public.css", "scripts/public.js"],
          ["Landing page and login page are visible and linked."],
          contract({
            required_app_files: ["index.html", "login.html"],
            expected_user_visible_output: ["Landing page", "Login page"],
            validation_commands: ["node --check scripts/public.js"],
            acceptance_checks: ["index.html exists", "login.html exists", "CSS/JS assets are linked", "JS validation passed"],
            completion_criteria: ["Non-documentation landing/login files are created or changed."],
          }),
        ),
        subtask(
          "Dashboard and settings pages",
          "Build the static dashboard page and settings page for the SaaS dashboard shell.",
          ["Project setup and shared docs"],
          ["dashboard.html", "settings.html", "styles/app.css", "scripts/app.js"],
          ["Dashboard page and settings page are visible and linked."],
          contract({
            required_app_files: ["dashboard.html", "settings.html"],
            expected_user_visible_output: ["Dashboard page", "Settings page"],
            validation_commands: ["node --check scripts/app.js"],
            acceptance_checks: ["dashboard.html exists", "settings.html exists", "CSS/JS assets are linked", "JS validation passed"],
            completion_criteria: ["Non-documentation dashboard/settings files are created or changed."],
          }),
        ),
        subtask(
          "Validation and review",
          "Run validation, review changed files, and update project handoff docs.",
          ["Landing and login pages", "Dashboard and settings pages"],
          [".head-developer/VALIDATION.md", ".head-developer/WORKER_HANDOFFS.md"],
          ["Validation results and handoff docs are updated."],
          contract({
            allowed_doc_files: sharedDocFiles,
            validation_commands: ["node --check scripts/public.js", "node --check scripts/app.js"],
            acceptance_checks: ["Validation evidence is recorded"],
            completion_criteria: ["Validation commands are represented in .head-developer/VALIDATION.md."],
            docs_only_is_insufficient: false,
          }),
        ),
      ];
      return {
        complexity: "complex",
        recommended_worker_count: activeTaskRisk ? 1 : 2,
        should_split: true,
        parallelizable: !activeTaskRisk,
        reason: "The request is a static multi-page SaaS shell with independent public and app surfaces; billing/backend work is explicitly excluded.",
        suggested_subtasks: subtasks,
        dependency_graph: [
          edge("Project setup and shared docs", "Landing and login pages"),
          edge("Project setup and shared docs", "Dashboard and settings pages"),
          edge("Landing and login pages", "Validation and review", "informs"),
          edge("Dashboard and settings pages", "Validation and review", "informs"),
        ],
        risks: activeTaskRisk ? ["Active project work is already running; avoid parallel writes."] : [],
        approval_needed: false,
      };
    }

    const subtasks = [
      subtask(
        "Project setup and shared docs",
        "Create or update the app scaffold and shared Head Developer docs.",
        [],
        [".head-developer/PROJECT_BRIEF.md", ".head-developer/TASK_GRAPH.md"],
        ["Initialized project repo and shared docs."],
        contract({
          allowed_doc_files: sharedDocFiles,
          acceptance_checks: ["Shared docs exist"],
          completion_criteria: ["Project repo and shared docs are initialized by orchestrator command evidence."],
          docs_only_is_insufficient: false,
        }),
      ),
      subtask(
        "Landing and marketing pages",
        "Build the public landing page and navigation shell.",
        ["Project setup and shared docs"],
        ["index.html", "styles.css", "script.js", "src"],
        ["Public landing page and navigation shell are visible."],
        contract({
          required_app_files: ["index.html"],
          expected_user_visible_output: ["Landing page", "Navigation"],
          validation_commands: ["node --check"],
          acceptance_checks: ["Landing page entry file exists", "Navigation shell is represented in app files"],
          completion_criteria: ["Non-documentation app files are created or changed.", "Required landing entry file exists."],
        }),
      ),
      subtask(
        "Auth screens",
        "Build login/signup screens and mocked authenticated state.",
        ["Project setup and shared docs"],
        ["auth", "login", "signup"],
        ["Login/signup screens are visible."],
        contract({
          required_app_files: ["auth", "login", "signup"],
          expected_user_visible_output: ["Login screen", "Signup screen"],
          validation_commands: ["node --check"],
          acceptance_checks: ["Auth screen files exist", "Mock auth state code validates"],
          completion_criteria: ["Non-documentation auth files are created or changed."],
        }),
      ),
      subtask(
        "Dashboard and settings",
        "Build dashboard layout, settings page, and core app navigation.",
        ["Project setup and shared docs"],
        ["dashboard", "settings"],
        ["Dashboard layout and settings page are visible."],
        contract({
          required_app_files: ["dashboard", "settings"],
          expected_user_visible_output: ["Dashboard", "Settings"],
          validation_commands: ["node --check"],
          acceptance_checks: ["Dashboard files exist", "Settings files exist"],
          completion_criteria: ["Non-documentation dashboard/settings files are created or changed."],
        }),
      ),
      ...(noBillingRequested ? [] : [subtask(
        "Billing surface",
        "Build fake billing/pricing page without live Stripe calls.",
        ["Auth screens"],
        ["billing", "pricing"],
        ["Fake billing or pricing page is visible."],
        contract({
          required_app_files: ["billing", "pricing"],
          expected_user_visible_output: ["Billing", "Pricing"],
          validation_commands: ["node --check"],
          acceptance_checks: ["Billing/pricing files exist", "No live Stripe calls are required"],
          completion_criteria: ["Non-documentation billing/pricing files are created or changed."],
        }),
      )]),
      subtask(
        "Validation and review",
        "Run validation, review changed files, and update project handoff docs.",
        noBillingRequested ? ["Landing and marketing pages", "Dashboard and settings"] : ["Landing and marketing pages", "Dashboard and settings", "Billing surface"],
        [".head-developer/VALIDATION.md", ".head-developer/WORKER_HANDOFFS.md"],
        ["Validation results and handoff docs are updated."],
        contract({
          allowed_doc_files: sharedDocFiles,
          validation_commands: ["node --check", "npm test", "npm run build"],
          acceptance_checks: ["Validation evidence is recorded"],
          completion_criteria: ["Validation commands are represented in .head-developer/VALIDATION.md."],
          docs_only_is_insufficient: false,
        }),
      ),
    ];

    const complex = explicitMulti || moduleKeywords.length >= 4 || goal.length > 160 || /\b(full|complete|production|platform)\b/.test(goal);
    const edges = [
      edge("Project setup and shared docs", "Landing and marketing pages"),
      edge("Project setup and shared docs", "Auth screens"),
      edge("Project setup and shared docs", "Dashboard and settings"),
      ...(noBillingRequested ? [] : [edge("Auth screens", "Billing surface")]),
      edge("Landing and marketing pages", "Validation and review", "informs"),
      edge("Dashboard and settings", "Validation and review", "informs"),
      ...(noBillingRequested ? [] : [edge("Billing surface", "Validation and review", "informs")]),
    ];

    return {
      complexity: complex ? "complex" : "moderate",
      recommended_worker_count: complex ? 2 : 1,
      should_split: true,
      parallelizable: complex && !activeTaskRisk,
      reason: complex
        ? "The request has multiple major modules that can be planned as a task graph."
        : "The request has more than one implementation area, but a single worker can still handle it safely.",
      suggested_subtasks: complex ? subtasks : subtasks.slice(0, 3),
      dependency_graph: complex ? edges : edges.slice(0, 2),
      risks: [
        ...(files.length ? ["Existing project files may be touched; use worktrees or sequential execution to avoid overwrites."] : []),
        ...(goal.includes("stripe") || goal.includes("deploy") ? ["Billing/deployment actions require approval before live external changes."] : []),
        ...(activeTaskRisk ? ["Active project work is already running; avoid parallel writes."] : []),
      ],
      approval_needed: complex || goal.includes("stripe") || goal.includes("deploy"),
    };
  }
}

export const taskComplexityJudge = new TaskComplexityJudge();
