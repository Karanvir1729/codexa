import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { appendOrchestratorEvent } from "./store.js";
import { upsertProject } from "./project-store.js";
import type { ProjectRecord } from "./types.js";

export const DOCUMENTATION_INDEX_FILES = [
  "CODE_INDEX.md",
  "FUNCTIONS.md",
  "VARIABLES.md",
  "API_SURFACE.md",
  "STATE_MODEL.md",
  "WORKER_HANDOFFS.md",
  "VALIDATION.md",
] as const;

export const WORKER_CONTEXT_DOC_FILES = [
  "PROJECT_BRIEF.md",
  "TASK_GRAPH.md",
  "ARCHITECTURE.md",
  "CODE_INDEX.md",
  "FUNCTIONS.md",
  "VARIABLES.md",
  "STATE_MODEL.md",
  "WORKER_HANDOFFS.md",
] as const;

type DocFile = typeof DOCUMENTATION_INDEX_FILES[number];

interface CodeFunction {
  name: string;
  file: string;
  exported: boolean;
  purpose: string;
  inputs: string[];
  output: string;
  side_effects: string[];
  calls_into: string[];
  called_by: string[];
  related_task_worker: string;
  coverage: string;
}

interface ImportantVariable {
  name: string;
  file: string;
  kind: "constant" | "variable" | "env" | "css_variable" | "css_class" | "interface_field" | "state_field";
  defined_at: string;
  used_at: string[];
  allowed_values: string;
  default_value: string;
  risk_notes: string;
}

interface ApiRoute {
  method: string;
  route: string;
  file: string;
  request_shape: string;
  response_shape: string;
  auth_requirements: string;
  side_effects: string;
  related_state_models: string[];
  related_events: string[];
}

interface StateModelField {
  model: string;
  field: string;
  type: string;
  file: string;
  lifecycle: string;
  writer: string;
  reader: string;
  default_value: string;
  required: string;
  migration_notes: string;
}

interface FileIndexEntry {
  file: string;
  purpose: string;
  exports: string[];
  functions: string[];
  variables: string[];
  dom_selectors: string[];
  css_classes: string[];
  assets: string[];
}

export interface DocumentationFreshnessReport {
  docs_fresh: boolean;
  missing_docs: string[];
  missing_changed_files: string[];
  missing_functions: string[];
  missing_variables: string[];
  missing_routes: string[];
  missing_state_fields: string[];
  missing_validation: string[];
  recommended_follow_up_task: string | null;
}

export interface DocumentationIndexResult {
  docs_path: string;
  files_written: string[];
  file_entries: FileIndexEntry[];
  functions: CodeFunction[];
  variables: ImportantVariable[];
  api_routes: ApiRoute[];
  state_fields: StateModelField[];
  freshness: DocumentationFreshnessReport;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
  ".css",
  ".json",
  ".md",
  ".svg",
]);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function safeRead(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function ensureInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Documentation path escapes project root: ${candidate}`);
  }
}

function walkFiles(root: string) {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(relative);
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return files.sort();
}

function markdownList(values: string[], fallback = "- none") {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : fallback;
}

function table(headers: string[], rows: string[][]) {
  const escape = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...(rows.length ? rows.map((row) => `| ${row.map(escape).join(" | ")} |`) : [`| ${headers.map(() => "none").join(" | ")} |`]),
  ].join("\n");
}

function nodeName(node: ts.Node) {
  const named = node as ts.Node & { name?: ts.Node };
  return named.name && ts.isIdentifier(named.name) ? named.name.text : "";
}

function hasExport(node: ts.Node) {
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
}

function jsKind(file: string) {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function firstJsDocText(node: ts.Node, source: ts.SourceFile) {
  const ranges = ts.getLeadingCommentRanges(source.getFullText(), node.getFullStart()) ?? [];
  const jsDoc = ranges
    .map((range) => source.getFullText().slice(range.pos, range.end))
    .find((comment) => comment.startsWith("/**"));
  return jsDoc
    ? jsDoc.replace(/^\/\*\*|\*\/$/g, "").split(/\r?\n/).map((line) => line.replace(/^\s*\*\s?/, "").trim()).filter(Boolean)[0] ?? ""
    : "";
}

function parameterText(parameters: ts.NodeArray<ts.ParameterDeclaration>, source: ts.SourceFile) {
  return parameters.map((param) => {
    const name = param.name.getText(source);
    const type = param.type?.getText(source) ?? "inferred";
    return `${name}: ${type}`;
  });
}

function returnText(node: ts.SignatureDeclarationBase, source: ts.SourceFile) {
  return node.type?.getText(source) ?? "inferred/unspecified";
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function collectCalls(node: ts.Node, source: ts.SourceFile) {
  const calls: string[] = [];
  function visit(child: ts.Node) {
    if (ts.isCallExpression(child)) {
      const expression = child.expression.getText(source);
      if (!expression.startsWith("console.") && !expression.startsWith("Math.")) calls.push(expression);
    }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return unique(calls).slice(0, 20);
}

function inspectCodeFile(root: string, file: string) {
  const absolute = path.join(root, file);
  const text = safeRead(absolute);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, jsKind(file));
  const functions: CodeFunction[] = [];
  const variables: ImportantVariable[] = [];
  const exports: string[] = [];
  const apiRoutes: ApiRoute[] = [];
  const stateFields: StateModelField[] = [];
  const knownNames: string[] = [];

  function addFunction(name: string, node: ts.Node, parameters: string[], output: string, exported: boolean) {
    if (!name) return;
    knownNames.push(name);
    if (exported) exports.push(name);
    functions.push({
      name,
      file,
      exported,
      purpose: firstJsDocText(node, source) || `Declared implementation in ${file}.`,
      inputs: parameters,
      output,
      side_effects: /fs\.|fetch\(|append|write|upsert|create|delete|spawn|exec|process\.env/.test(node.getText(source))
        ? ["May update state, files, network calls, or process environment based on body references."]
        : ["No obvious side effects detected from static scan."],
      calls_into: collectCalls(node, source),
      called_by: [],
      related_task_worker: "Project-wide code index; specific worker attribution is in WORKER_HANDOFFS.md when recorded.",
      coverage: "Coverage is inferred from recorded validation commands when available.",
    });
  }

  function addVariable(name: string, kind: ImportantVariable["kind"], node: ts.Node, exported = false) {
    if (!name) return;
    if (exported) exports.push(name);
    variables.push({
      name,
      file,
      kind,
      defined_at: file,
      used_at: [],
      allowed_values: "not declared in source",
      default_value: node.getText(source).slice(0, 160),
      risk_notes: kind === "env" ? "Changing this may alter runtime configuration." : "Changing this may affect module behavior.",
    });
  }

  function interfaceFields(node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration) {
    const model = nodeName(node);
    if (!model) return;
    if (hasExport(node)) exports.push(model);
    if (ts.isInterfaceDeclaration(node)) {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue;
        const field = member.name.getText(source);
        const type = member.type?.getText(source) ?? "unknown";
        stateFields.push({
          model,
          field,
          type,
          file,
          lifecycle: "Defined in TypeScript interface.",
          writer: "Writers should be located by usage search.",
          reader: "Readers should be located by usage search.",
          default_value: "not declared in interface",
          required: member.questionToken ? "optional" : "required",
          migration_notes: "Preserve compatibility when changing persisted fields.",
        });
        variables.push({
          name: `${model}.${field}`,
          file,
          kind: /Session|Project|Task|Worker|Command|Summary|Approval|State|Graph/.test(model) ? "state_field" : "interface_field",
          defined_at: file,
          used_at: [],
          allowed_values: type,
          default_value: "not declared in type",
          risk_notes: "Changing this field can break callers or persisted state.",
        });
      }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node)) {
      addFunction(nodeName(node), node, parameterText(node.parameters, source), returnText(node, source), hasExport(node));
    } else if (ts.isMethodDeclaration(node)) {
      addFunction(nodeName(node), node, parameterText(node.parameters, source), returnText(node, source), hasExport(node));
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExport(node);
      for (const declaration of node.declarationList.declarations) {
        const name = declaration.name.getText(source);
        if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          addFunction(name, declaration, parameterText(declaration.initializer.parameters, source), returnText(declaration.initializer, source), exported);
        } else if (/^[A-Z0-9_]+$/.test(name) || exported || node.declarationList.flags & ts.NodeFlags.Const) {
          addVariable(name, "constant", declaration, exported);
        }
      }
    } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const name = nodeName(node);
      if (name && hasExport(node)) exports.push(name);
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) interfaceFields(node);
    }

    if (ts.isPropertyAccessExpression(node) && node.getText(source).startsWith("process.env.")) {
      addVariable(node.name.text, "env", node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);

  for (const match of text.matchAll(/\b(app|router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
    apiRoutes.push({
      method: match[2].toUpperCase(),
      route: match[3],
      file,
      request_shape: "Inspect handler parameters/body validation in source.",
      response_shape: "Inspect res.json/res.send calls in source.",
      auth_requirements: /auth|authorization|bearer|requireAuth/i.test(text) ? "auth-related code detected" : "no auth check detected by static scan",
      side_effects: /upsert|write|create|delete|append/i.test(text) ? "state or filesystem side effects detected" : "no obvious side effects detected",
      related_state_models: unique(stateFields.map((field) => field.model)),
      related_events: unique([...text.matchAll(/type:\s*["'`]([^"'`]+)["'`]/g)].map((item) => item[1])),
    });
  }

  for (const fn of functions) {
    fn.called_by = functions
      .filter((candidate) => candidate.name !== fn.name && candidate.calls_into.some((call) => call.includes(fn.name)))
      .map((candidate) => candidate.name);
  }

  return { functions, variables: uniqueVariables(variables), exports: unique(exports), apiRoutes, stateFields };
}

function uniqueVariables(values: ImportantVariable[]) {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = `${item.kind}:${item.file}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inspectStaticFile(root: string, file: string) {
  const absolute = path.join(root, file);
  const text = safeRead(absolute);
  const ext = path.extname(file);
  const selectors: string[] = [];
  const cssClasses: string[] = [];
  const variables: ImportantVariable[] = [];
  const functions: CodeFunction[] = [];
  const assets: string[] = [];

  if (ext === ".html") {
    selectors.push(...[...text.matchAll(/\bid=["']([^"']+)["']/g)].map((item) => `#${item[1]}`));
    selectors.push(...[...text.matchAll(/\bclass=["']([^"']+)["']/g)].flatMap((item) => item[1].split(/\s+/).map((name) => `.${name}`)));
    assets.push(...[...text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((item) => item[1]).filter((value) => !value.startsWith("http") && !value.startsWith("#")));
  }

  if (ext === ".css") {
    variables.push(...[...text.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g)].map((item) => ({
      name: `--${item[1]}`,
      file,
      kind: "css_variable" as const,
      defined_at: file,
      used_at: [],
      allowed_values: "CSS value",
      default_value: item[2].trim(),
      risk_notes: "Changing this can alter visual styling.",
    })));
    cssClasses.push(...[...text.matchAll(/\.([a-zA-Z0-9_-]+)\s*[{,]/g)].map((item) => `.${item[1]}`));
  }

  if (CODE_EXTENSIONS.has(ext)) {
    for (const match of text.matchAll(/addEventListener\(\s*["'`]([^"'`]+)["'`]/g)) {
      functions.push({
        name: `event handler: ${match[1]}`,
        file,
        exported: false,
        purpose: `DOM event handler registered for ${match[1]}.`,
        inputs: [`${match[1]} event`],
        output: "DOM side effects",
        side_effects: ["Updates the page in response to browser events."],
        calls_into: [],
        called_by: ["browser event loop"],
        related_task_worker: "Project-wide static app scan.",
        coverage: "Validate with browser preview and JS syntax checks.",
      });
    }
    selectors.push(...[...text.matchAll(/querySelector(All)?\(\s*["'`]([^"'`]+)["'`]/g)].map((item) => item[2]));
    variables.push(...[...text.matchAll(/\b(const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g)].map((item) => ({
      name: item[2],
      file,
      kind: item[1] === "const" ? "constant" as const : "variable" as const,
      defined_at: file,
      used_at: [],
      allowed_values: "JavaScript runtime value",
      default_value: "see source initializer",
      risk_notes: "Changing this can alter browser behavior.",
    })));
  }

  return { selectors: unique(selectors), cssClasses: unique(cssClasses), variables: uniqueVariables(variables), functions, assets: unique(assets) };
}

function purposeForFile(file: string) {
  if (file.endsWith(".html")) return "Static page entry or document structure.";
  if (file.endsWith(".css")) return "Stylesheet for layout, theme, and responsive behavior.";
  if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file)) return "Executable source module.";
  if (file.endsWith(".json")) return "Configuration or structured data.";
  if (file.endsWith(".md")) return "Project documentation.";
  if (file.endsWith(".svg")) return "Static visual asset.";
  return "Project file.";
}

function validationCommands(files: string[]) {
  const commands = new Set<string>();
  if (files.some((file) => file.endsWith(".js"))) commands.add("node --check script.js or node --check <changed-js-file>");
  if (files.includes("package.json")) commands.add("npm test/build/lint/typecheck when configured");
  if (files.some((file) => file.endsWith(".html"))) commands.add("Open/preview static HTML and verify assets load.");
  return [...commands];
}

function renderCodeIndex(result: Omit<DocumentationIndexResult, "docs_path" | "files_written" | "freshness">, validation: string[]) {
  return [
    "# Code Index",
    "",
    "Generated from a real repository scan. Do not treat docs-only changes as app completion.",
    "",
    "## File Tree",
    markdownList(result.file_entries.map((entry) => entry.file)),
    "",
    "## Important Files",
    table(["File", "Purpose", "Key exports", "Key functions", "Important variables/classes", "Assets/selectors"], result.file_entries.map((entry) => [
      entry.file,
      entry.purpose,
      entry.exports.join(", ") || "none",
      entry.functions.join(", ") || "none",
      [...entry.variables, ...entry.css_classes].join(", ") || "none",
      [...entry.assets, ...entry.dom_selectors].join(", ") || "none",
    ])),
    "",
    "## Data Flow",
    result.api_routes.length
      ? "Browser/client or API inputs enter the routes listed in API_SURFACE.md; state fields are listed in STATE_MODEL.md."
      : "No backend API routes detected. Static pages load HTML, CSS, JavaScript, and local assets directly.",
    "",
    "## Event Flow",
    result.functions.some((fn) => fn.name.startsWith("event handler:"))
      ? markdownList(result.functions.filter((fn) => fn.name.startsWith("event handler:")).map((fn) => `${fn.file}: ${fn.name}`))
      : "- No DOM event handlers detected.",
    "",
    "## API Endpoints",
    result.api_routes.length ? markdownList(result.api_routes.map((route) => `${route.method} ${route.route} (${route.file})`)) : "- none detected",
    "",
    "## Command Entry Points",
    markdownList(validation),
    "",
    "## Known Fragile Areas",
    "- Documentation freshness depends on rerunning DocumentationIndexer after code changes.",
    "- Generated app tasks must produce app files and validation evidence; docs-only output is incomplete.",
    "",
  ].join("\n");
}

function renderFunctions(functions: CodeFunction[]) {
  return [
    "# Functions",
    "",
    "Generated from TypeScript/JavaScript AST scans plus static DOM event detection.",
    "",
    table(["Function", "File", "Purpose", "Inputs", "Outputs", "Side effects", "Called by", "Calls into", "Related task/worker", "Coverage"], functions.map((fn) => [
      fn.name,
      fn.file,
      fn.purpose,
      fn.inputs.join(", ") || "none",
      fn.output,
      fn.side_effects.join("; "),
      fn.called_by.join(", ") || "none detected",
      fn.calls_into.join(", ") || "none detected",
      fn.related_task_worker,
      fn.coverage,
    ])),
    "",
  ].join("\n");
}

function renderVariables(variables: ImportantVariable[]) {
  return [
    "# Variables",
    "",
    "Generated from source declarations, CSS variables/classes, environment references, and type fields.",
    "",
    table(["Name", "Kind", "Defined", "Used", "Allowed/default", "Risk notes"], variables.map((variable) => [
      variable.name,
      variable.kind,
      variable.defined_at,
      variable.used_at.join(", ") || variable.file,
      `${variable.allowed_values}; default: ${variable.default_value}`,
      variable.risk_notes,
    ])),
    "",
  ].join("\n");
}

function renderApiSurface(routes: ApiRoute[]) {
  return [
    "# API Surface",
    "",
    table(["Method", "Route", "File", "Request shape", "Response shape", "Auth", "Side effects", "State/events"], routes.map((route) => [
      route.method,
      route.route,
      route.file,
      route.request_shape,
      route.response_shape,
      route.auth_requirements,
      route.side_effects,
      [...route.related_state_models, ...route.related_events].join(", ") || "none detected",
    ])),
    "",
  ].join("\n");
}

function renderStateModel(fields: StateModelField[]) {
  return [
    "# State Model",
    "",
    "Generated from TypeScript interfaces and type fields detected in the project.",
    "",
    table(["Model", "Field", "Type", "Lifecycle", "Writer", "Reader", "Default", "Required", "Migration notes"], fields.map((field) => [
      field.model,
      field.field,
      field.type,
      field.lifecycle,
      field.writer,
      field.reader,
      field.default_value,
      field.required,
      field.migration_notes,
    ])),
    "",
  ].join("\n");
}

function renderValidation(files: string[], commands: string[]) {
  return [
    "# Validation",
    "",
    "DocumentationIndexer validation recommendations are derived from real files in the repo.",
    "",
    "## Recommended Commands",
    markdownList(commands),
    "",
    "## Files Considered",
    markdownList(files),
    "",
  ].join("\n");
}

function renderWorkerHandoffs(existing: string) {
  if (existing.trim()) return existing;
  return "# Worker Handoffs\n\nNo worker handoffs recorded yet.\n";
}

function freshnessFor(docsDir: string, files: string[], result: Omit<DocumentationIndexResult, "docs_path" | "files_written" | "freshness">, validation: string[], changedFiles: string[] = []): DocumentationFreshnessReport {
  const missingDocs = DOCUMENTATION_INDEX_FILES.filter((file) => !fs.existsSync(path.join(docsDir, file)));
  const codeIndex = safeRead(path.join(docsDir, "CODE_INDEX.md"));
  const functionsDoc = safeRead(path.join(docsDir, "FUNCTIONS.md"));
  const variablesDoc = safeRead(path.join(docsDir, "VARIABLES.md"));
  const apiDoc = safeRead(path.join(docsDir, "API_SURFACE.md"));
  const stateDoc = safeRead(path.join(docsDir, "STATE_MODEL.md"));
  const validationDoc = safeRead(path.join(docsDir, "VALIDATION.md"));
  const changed = changedFiles.length ? changedFiles : files.filter((file) => !file.startsWith(".head-developer/"));
  const missingChangedFiles = changed.filter((file) => !codeIndex.includes(file));
  const missingFunctions = result.functions.map((fn) => fn.name).filter((name) => !functionsDoc.includes(name));
  const missingVariables = result.variables.map((variable) => variable.name).filter((name) => !variablesDoc.includes(name) && !stateDoc.includes(name));
  const missingRoutes = result.api_routes
    .filter((route) => !apiDoc.includes(route.method) || !apiDoc.includes(route.route))
    .map((route) => `${route.method} ${route.route}`);
  const missingStateFields = result.state_fields
    .filter((field) => !((stateDoc.includes(field.model) && stateDoc.includes(field.field)) || variablesDoc.includes(`${field.model}.${field.field}`)))
    .map((field) => `${field.model}.${field.field}`);
  const missingValidation = validation.filter((command) => !validationDoc.includes(command));
  const stale = [...missingDocs, ...missingChangedFiles, ...missingFunctions, ...missingVariables, ...missingRoutes, ...missingStateFields, ...missingValidation];
  return {
    docs_fresh: stale.length === 0,
    missing_docs: missingDocs,
    missing_changed_files: missingChangedFiles,
    missing_functions: missingFunctions,
    missing_variables: missingVariables,
    missing_routes: missingRoutes,
    missing_state_fields: missingStateFields,
    missing_validation: missingValidation,
    recommended_follow_up_task: stale.length ? "Update .head-developer documentation so changed files, functions, variables, routes, state fields, validation, and handoffs are represented." : null,
  };
}

export class DocumentationIndexer {
  docsDir(project: ProjectRecord) {
    return project.docs_path || path.join(project.workspace_path, ".head-developer");
  }

  scan(project: ProjectRecord): Omit<DocumentationIndexResult, "docs_path" | "files_written" | "freshness"> & { validation_commands: string[] } {
    const root = project.repo_path || project.workspace_path;
    const files = walkFiles(root);
    const entries = new Map<string, FileIndexEntry>();
    const functions: CodeFunction[] = [];
    const variables: ImportantVariable[] = [];
    const apiRoutes: ApiRoute[] = [];
    const stateFields: StateModelField[] = [];

    for (const file of files) {
      const ext = path.extname(file);
      const entry: FileIndexEntry = {
        file,
        purpose: purposeForFile(file),
        exports: [],
        functions: [],
        variables: [],
        dom_selectors: [],
        css_classes: [],
        assets: [],
      };

      if (CODE_EXTENSIONS.has(ext)) {
        const inspected = inspectCodeFile(root, file);
        functions.push(...inspected.functions);
        variables.push(...inspected.variables);
        apiRoutes.push(...inspected.apiRoutes);
        stateFields.push(...inspected.stateFields);
        entry.exports.push(...inspected.exports);
        entry.functions.push(...inspected.functions.map((fn) => fn.name));
        entry.variables.push(...inspected.variables.map((variable) => variable.name));
      }

      if ([".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) {
        const inspected = inspectStaticFile(root, file);
        functions.push(...inspected.functions);
        variables.push(...inspected.variables);
        entry.dom_selectors.push(...inspected.selectors);
        entry.css_classes.push(...inspected.cssClasses);
        entry.assets.push(...inspected.assets);
        entry.functions.push(...inspected.functions.map((fn) => fn.name));
        entry.variables.push(...inspected.variables.map((variable) => variable.name));
      }

      entries.set(file, {
        ...entry,
        exports: unique(entry.exports),
        functions: unique(entry.functions),
        variables: unique(entry.variables),
        dom_selectors: unique(entry.dom_selectors),
        css_classes: unique(entry.css_classes),
        assets: unique(entry.assets),
      });
    }

    const dedupedFunctions = functions.filter((fn, index, all) => all.findIndex((item) => item.file === fn.file && item.name === fn.name) === index);
    const dedupedVariables = uniqueVariables(variables);
    return {
      file_entries: [...entries.values()],
      functions: dedupedFunctions,
      variables: dedupedVariables,
      api_routes: apiRoutes,
      state_fields: stateFields,
      validation_commands: validationCommands(files),
    };
  }

  updateProjectDocs(project: ProjectRecord, options: { changedFiles?: string[]; taskId?: string; workerId?: string } = {}): DocumentationIndexResult {
    const docsDir = this.docsDir(project);
    fs.mkdirSync(docsDir, { recursive: true });
    ensureInside(docsDir, project.workspace_path);
    const scan = this.scan(project);
    const base = {
      file_entries: scan.file_entries,
      functions: scan.functions,
      variables: scan.variables,
      api_routes: scan.api_routes,
      state_fields: scan.state_fields,
    };
    const docs: Record<DocFile, string> = {
      "CODE_INDEX.md": renderCodeIndex(base, scan.validation_commands),
      "FUNCTIONS.md": renderFunctions(scan.functions),
      "VARIABLES.md": renderVariables(scan.variables),
      "API_SURFACE.md": renderApiSurface(scan.api_routes),
      "STATE_MODEL.md": renderStateModel(scan.state_fields),
      "WORKER_HANDOFFS.md": renderWorkerHandoffs(safeRead(path.join(docsDir, "WORKER_HANDOFFS.md"))),
      "VALIDATION.md": renderValidation(scan.file_entries.map((entry) => entry.file), scan.validation_commands),
    };

    const filesWritten: string[] = [];
    for (const file of DOCUMENTATION_INDEX_FILES) {
      const target = path.join(docsDir, file);
      ensureInside(target, project.workspace_path);
      fs.writeFileSync(target, docs[file]);
      filesWritten.push(target);
    }
    const freshness = freshnessFor(docsDir, scan.file_entries.map((entry) => entry.file), base, scan.validation_commands, options.changedFiles ?? []);
    project.docs_path = docsDir;
    project.shared_context_path = project.shared_context_path || path.join(docsDir, "PROJECT_BRIEF.md");
    project.documentation_indexed_at = new Date().toISOString();
    project.docs_fresh = freshness.docs_fresh;
    project.docs_stale_reasons = [
      ...freshness.missing_docs,
      ...freshness.missing_changed_files,
      ...freshness.missing_functions,
      ...freshness.missing_variables,
      ...freshness.missing_routes,
      ...freshness.missing_state_fields,
      ...freshness.missing_validation,
    ];
    project.updated_at = new Date().toISOString();
    upsertProject(project);
    appendOrchestratorEvent({
      scope: "docs",
      scope_id: project.project_id,
      type: freshness.docs_fresh ? "project_docs.indexed" : "project_docs.stale",
      message: freshness.docs_fresh ? `Documentation index is fresh for ${project.display_name}.` : `Documentation index is stale for ${project.display_name}.`,
      data: {
        project_id: project.project_id,
        task_id: options.taskId ?? null,
        worker_id: options.workerId ?? null,
        docs_path: docsDir,
        files: DOCUMENTATION_INDEX_FILES,
        freshness,
      },
    });
    return {
      docs_path: docsDir,
      files_written: filesWritten,
      ...base,
      freshness,
    };
  }

  checkFreshness(project: ProjectRecord, changedFiles: string[] = []): DocumentationFreshnessReport {
    const docsDir = this.docsDir(project);
    const scan = this.scan(project);
    return freshnessFor(docsDir, scan.file_entries.map((entry) => entry.file), scan, scan.validation_commands, changedFiles);
  }
}

export const documentationIndexer = new DocumentationIndexer();
