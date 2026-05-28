import type { ProjectRecord } from "./types.js";

export type ProjectRouteDecision =
  | { status: "selected"; project: ProjectRecord; reason: string }
  | { status: "needs_clarification"; question: string; candidates: ProjectRecord[]; reason: string };

function normalize(value: string) {
  return value.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

export function routeProjectFromMessage(text: string, projects: ProjectRecord[], activeProjectId?: string | null): ProjectRouteDecision {
  const input = normalize(text);
  const explicit = projects.find((project) => {
    const names = [project.display_name, project.repo_name ?? ""].filter(Boolean).map(normalize);
    return names.some((name) => name && input.includes(name));
  });
  if (explicit) return { status: "selected", project: explicit, reason: "explicit_user_mention" };

  if (/\b(current project|this project|current repo|this repo|here)\b/.test(input) && activeProjectId) {
    const active = projects.find((project) => project.project_id === activeProjectId);
    if (active) return { status: "selected", project: active, reason: "active_session_reference" };
  }

  const recent = [...projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const candidates = recent ? [recent, ...projects.filter((project) => project.project_id !== recent.project_id).slice(0, 4)] : [];
  const names = candidates.map((project) => project.display_name).join(", ");
  return {
    status: "needs_clarification",
    question: names ? `Which project do you mean? I see ${names}.` : "Which project should I attach this Codex session to?",
    candidates,
    reason: "no_project_match",
  };
}
