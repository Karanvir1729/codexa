import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord } from "./types.js";

export const SUPERVISOR_PROJECT_MARKER_RELATIVE_PATH = path.join(".head-developer", "codex-supervisor-project.json");

export interface SupervisorProjectMarker {
  created_by: "codex-phone-supervisor";
  project_id: string;
  created_by_session_id: string | null;
  created_at: string;
}

export function supervisorProjectMarkerPath(workspacePath: string) {
  return path.join(workspacePath, SUPERVISOR_PROJECT_MARKER_RELATIVE_PATH);
}

export function readSupervisorProjectMarker(workspacePath: string): SupervisorProjectMarker | null {
  const markerPath = supervisorProjectMarkerPath(workspacePath);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<SupervisorProjectMarker>;
    if (parsed.created_by !== "codex-phone-supervisor") return null;
    if (typeof parsed.project_id !== "string" || !parsed.project_id.trim()) return null;
    return {
      created_by: "codex-phone-supervisor",
      project_id: parsed.project_id,
      created_by_session_id: typeof parsed.created_by_session_id === "string" ? parsed.created_by_session_id : null,
      created_at: typeof parsed.created_at === "string" && parsed.created_at.trim() ? parsed.created_at : "",
    };
  } catch {
    return null;
  }
}

export function writeSupervisorProjectMarker(input: {
  workspacePath: string;
  projectId: string;
  sessionId: string | null;
  createdAt?: string;
}) {
  const markerPath = supervisorProjectMarkerPath(input.workspacePath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const marker: SupervisorProjectMarker = {
    created_by: "codex-phone-supervisor",
    project_id: input.projectId,
    created_by_session_id: input.sessionId,
    created_at: input.createdAt ?? new Date().toISOString(),
  };
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return marker;
}

export function isCodexSupervisorCreatedProject(project: ProjectRecord, workspacePath: string) {
  if (project.created_by_codex_supervisor === true) return true;
  const marker = readSupervisorProjectMarker(workspacePath);
  return Boolean(marker && marker.project_id === project.project_id);
}
