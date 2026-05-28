import fs from "node:fs";
import path from "node:path";
import type { CommandEventRecord, WorkerContextPacket } from "./types.js";

export interface AppOutputValidationInput {
  workspacePath: string;
  allFiles: string[];
  changedFiles: string[];
  taskGoal: string;
  context?: WorkerContextPacket | null;
  validationEvents?: CommandEventRecord[];
}

export interface AppOutputValidationResult {
  isAppNode: boolean;
  passed: boolean;
  summary: string;
  failures: string[];
  warnings: string[];
  requiredPages: string[];
  htmlFiles: string[];
  cssFiles: string[];
  jsFiles: string[];
  missingRequiredPages: string[];
  missingExpectedFiles: string[];
  missingAssetReferences: string[];
  missingJsChecks: string[];
  weakValidationOnly: boolean;
  docsOnlyOutput: boolean;
}

const DOC_FILE_PATTERN = /(^|\/)(\.head-developer\/|README\.md$|CHANGELOG\.md$|docs\/)/i;
const STATIC_SOURCE_PATTERN = /\.(html?|css|js|mjs|cjs|ts|tsx|jsx|svg|png|jpe?g|webp|gif|ico|json)$/i;
const INFRA_FILE_PATTERN = /(^|\/)(Dockerfile|Containerfile|\.dockerignore|docker-compose(?:\.[^.\/]+)?\.ya?ml|compose\.ya?ml|Makefile|k8s\/|kubernetes\/|deploy\/|\.github\/workflows\/)/i;

function normalized(value: string) {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function isDocFile(file: string) {
  return DOC_FILE_PATTERN.test(file);
}

function safeRead(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function appSignalText(input: AppOutputValidationInput) {
  const node = input.context?.task_graph_node;
  return normalized([
    input.taskGoal,
    node?.title ?? "",
    node?.goal ?? "",
    ...(node?.files_expected ?? []),
    ...(node?.outputs_expected ?? []),
    ...(input.context?.expected_output ?? []),
  ].join(" "));
}

function expectedFiles(input: AppOutputValidationInput) {
  return [
    ...(input.context?.task_graph_node.files_expected ?? []),
    ...(input.context?.task_graph_node.outputs_expected ?? []),
    ...(input.context?.expected_output ?? []),
  ].map((item) => item.trim()).filter(Boolean);
}

function isAppNode(input: AppOutputValidationInput) {
  const signal = appSignalText(input);
  if (/\b(project setup|shared docs|validation and review|review changed files|handoff docs)\b/i.test(signal)) return false;
  return /\b(app|website|site|page|screen|dashboard|auth|login|signup|settings|billing|pricing|navigation|html|css|javascript|static|frontend|ui)\b/.test(signal) ||
    expectedFiles(input).some((item) => STATIC_SOURCE_PATTERN.test(item));
}

function requiredPages(input: AppOutputValidationInput) {
  const contractSignals = [
    ...(input.context?.output_contract.required_app_files ?? []),
    ...(input.context?.output_contract.expected_user_visible_output ?? []),
    ...(input.context?.expected_files ?? []),
    ...(input.context?.task_graph_node.files_expected ?? []),
  ];
  const signal = appSignalText(input);
  const expected = contractSignals.length ? contractSignals : expectedFiles(input);
  const pages = new Set<string>();
  for (const item of expected) {
    const value = normalized(item);
    if (/\bindex\.?html\b/.test(value) || /\blanding\b/.test(value)) pages.add("landing");
    if (/\bauth\b|\blogin\b|\bsign ?up\b/.test(value)) pages.add("auth");
    if (/\bdashboard\b/.test(value)) pages.add("dashboard");
    if (/\bsettings\b/.test(value)) pages.add("settings");
    if (/\bbilling\b|\bpricing\b/.test(value)) pages.add("billing");
  }
  if (contractSignals.length && pages.size) return [...pages];
  if (/\blanding\b|\bmarketing\b/.test(signal)) pages.add("landing");
  if (/\bauth\b|\blogin\b|\bsign ?up\b/.test(signal)) pages.add("auth");
  if (/\bdashboard\b/.test(signal)) pages.add("dashboard");
  if (/\bsettings\b/.test(signal)) pages.add("settings");
  if (/\bbilling\b|\bpricing\b/.test(signal)) pages.add("billing");
  return [...pages];
}

function htmlMatchesPage(page: string, file: string, text: string) {
  const fileText = normalized(file);
  const bodyText = normalized(text);
  if (page === "landing") return fileText.endsWith("index.html") || /\blanding\b|\bhome\b/.test(fileText) || /\blanding\b|\bhero\b|\bwelcome\b/.test(bodyText);
  if (page === "auth") return /\bauth\b|\blogin\b|\bsignup\b|\bsign-in\b|\bsign-up\b/.test(fileText) || /\blogin\b|\bsign in\b|\bsign up\b|\bauth\b/.test(bodyText);
  if (page === "dashboard") return /\bdashboard\b/.test(fileText) || /\bdashboard\b/.test(bodyText);
  if (page === "settings") return /\bsettings\b/.test(fileText) || /\bsettings\b/.test(bodyText);
  if (page === "billing") return /\bbilling\b|\bpricing\b/.test(fileText) || /\bbilling\b|\bpricing\b|\bplan\b/.test(bodyText);
  return false;
}

function referencedAssets(html: string) {
  const refs: string[] = [];
  const attrPattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(html))) refs.push(match[1]);
  return refs.filter((ref) => {
    if (/^(https?:|mailto:|tel:|data:|#)/i.test(ref)) return false;
    return /\.(css|js|mjs|svg|png|jpe?g|webp|gif|ico)$/i.test(ref.split(/[?#]/)[0] ?? "");
  });
}

function assetExists(workspacePath: string, htmlFile: string, ref: string) {
  const cleanRef = ref.split(/[?#]/)[0] ?? ref;
  const strippedRef = cleanRef.replace(/^\/+/, "");
  const htmlDir = path.dirname(path.join(workspacePath, htmlFile));
  const candidates = [
    path.resolve(workspacePath, strippedRef),
    path.resolve(htmlDir, cleanRef.startsWith("/") ? strippedRef : cleanRef),
  ];
  return candidates.some((candidate) => {
    const relative = path.relative(workspacePath, candidate);
    return !relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(candidate);
  });
}

function commandIsWeak(command: string) {
  return /^(ls|git\s+status)\b/i.test(command.trim());
}

function wildcardToRegExp(pattern: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(filePath: string, pattern: string) {
  const file = filePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const expected = pattern.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (!expected) return false;
  if (expected.includes("*")) return wildcardToRegExp(expected).test(file);
  if (expected.endsWith("/")) return file.startsWith(expected);
  if (expected.includes("/") || /\.[a-z0-9]+$/i.test(expected)) return file === expected || file.endsWith(`/${expected}`);
  return file.includes(expected);
}

function concreteExpectedFiles(input: AppOutputValidationInput) {
  return [
    ...(input.context?.output_contract.required_app_files ?? []),
    ...(input.context?.task_graph_node.required_app_files ?? []),
    ...(input.context?.expected_files ?? []),
    ...(input.context?.task_graph_node.files_expected ?? []),
  ]
    .map((item) => item.trim())
    .filter((item) => /\.(html?|css|js|mjs|cjs|svg|png|jpe?g|webp|gif|ico|json)$/i.test(item));
}

function isInfraFile(file: string) {
  return INFRA_FILE_PATTERN.test(file);
}

function expectsOnlyInfrastructure(input: AppOutputValidationInput) {
  const expected = expectedFiles(input);
  return expected.length > 0 && expected.every((item) => isInfraFile(item) || isDocFile(item));
}

function changedOnlyInfrastructure(input: AppOutputValidationInput) {
  return input.changedFiles.length > 0 && input.changedFiles.every((file) => isInfraFile(file) || isDocFile(file));
}

function requiresHtmlSurface(input: AppOutputValidationInput, pages: string[]) {
  if (pages.length) return true;
  const expected = concreteExpectedFiles(input);
  if (expected.some((item) => /\.html?$/i.test(item))) return true;
  if (expectsOnlyInfrastructure(input) || changedOnlyInfrastructure(input)) return false;
  const signal = appSignalText(input);
  return /\b(frontend|ui|page|screen|website|site|static|html|css|browser|landing|dashboard|login|settings|navigation)\b/.test(signal);
}

function jsCheckCommands(validationEvents: CommandEventRecord[]) {
  return validationEvents
    .filter((event) => /^node\s+--check\b/i.test(event.command) && event.exit_code === 0)
    .map((event) => event.command);
}

export function validateAppOutput(input: AppOutputValidationInput): AppOutputValidationResult {
  const htmlFiles = input.allFiles.filter((file) => /\.html?$/i.test(file));
  const cssFiles = input.allFiles.filter((file) => /\.css$/i.test(file));
  const jsFiles = input.allFiles.filter((file) => /\.(js|mjs|cjs)$/i.test(file));
  const validationEvents = input.validationEvents ?? [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const isApp = isAppNode(input);
  const docsOnlyOutput = input.changedFiles.length > 0 && input.changedFiles.every(isDocFile);
  const weakValidationOnly = validationEvents.length > 0 && validationEvents.every((event) => commandIsWeak(event.command));
  const pages = requiredPages(input);
  const expectedConcreteFiles = concreteExpectedFiles(input);
  const needsHtmlSurface = isApp && requiresHtmlSurface(input, pages);
  const htmlTexts = htmlFiles.map((file) => ({ file, text: safeRead(path.join(input.workspacePath, file)) }));
  const missingRequiredPages = pages.filter((page) => !htmlTexts.some(({ file, text }) => htmlMatchesPage(page, file, text)));
  const missingExpectedFiles = expectedConcreteFiles.filter((pattern) => !input.allFiles.some((file) => matchesPattern(file, pattern)));
  const missingAssetReferences: string[] = [];

  if (needsHtmlSurface && !htmlFiles.length) failures.push("No HTML file was generated for an app-building task.");
  if (isApp && docsOnlyOutput) failures.push("Only documentation files changed; app-building nodes require user-visible app files.");
  if (isApp && weakValidationOnly) failures.push("Weak validation only: ls/git status is not sufficient for app-building nodes.");
  for (const page of missingRequiredPages) failures.push(`Missing required static page or section: ${page}.`);
  for (const pattern of missingExpectedFiles) failures.push(`Missing expected static app file: ${pattern}.`);

  let referencedCss = false;
  let referencedJs = false;
  for (const { file, text } of htmlTexts) {
    for (const ref of referencedAssets(text)) {
      if (/\.css(?:[?#]|$)/i.test(ref)) referencedCss = true;
      if (/\.(js|mjs|cjs)(?:[?#]|$)/i.test(ref)) referencedJs = true;
      if (!assetExists(input.workspacePath, file, ref)) missingAssetReferences.push(`${file} -> ${ref}`);
    }
  }
  if (missingAssetReferences.length) failures.push(`Missing referenced asset(s): ${missingAssetReferences.join(", ")}.`);
  if (needsHtmlSurface && cssFiles.length && !referencedCss) failures.push("Generated CSS exists but no HTML page references a CSS file.");
  if (needsHtmlSurface && jsFiles.length && !referencedJs) failures.push("Generated JavaScript exists but no HTML page references a JavaScript file.");

  const successfulJsChecks = jsCheckCommands(validationEvents);
  const missingJsChecks = jsFiles.filter((file) => !successfulJsChecks.some((command) => command.includes(file)));
  for (const file of missingJsChecks) failures.push(`Missing successful node --check validation for ${file}.`);
  if (isApp && !validationEvents.length) warnings.push("No validation command event was recorded.");

  const passed = failures.length === 0;
  return {
    isAppNode: isApp,
    passed,
    summary: passed
      ? `Static app validation passed: ${htmlFiles.length} HTML, ${cssFiles.length} CSS, ${jsFiles.length} JS file(s); ${successfulJsChecks.length} JS syntax check(s).`
      : `Static app validation failed: ${failures.join(" ")}`,
    failures,
    warnings,
    requiredPages: pages,
    htmlFiles,
    cssFiles,
    jsFiles,
    missingRequiredPages,
    missingExpectedFiles,
    missingAssetReferences,
    missingJsChecks,
    weakValidationOnly,
    docsOnlyOutput,
  };
}
