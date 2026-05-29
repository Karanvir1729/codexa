import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export const CRITICAL_LOCAL_CODEX_SKILLS = [
  "megaplan",
  "codex-flowchart-summary",
  "browser",
  "computer-use",
  "github",
  "playwright",
] as const;

export type CodexSkillInventoryStatus = "ready" | "missing_critical_skills" | "unavailable";

export interface CodexSkillInventory {
  status: CodexSkillInventoryStatus;
  codex_home_exists: boolean;
  total_discovered: number;
  skill_names: string[];
  critical_present: string[];
  critical_missing: string[];
}

function addSkillFromPath(skills: Set<string>, skillPath: string) {
  const normalized = skillPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const index = parts.lastIndexOf("skills");
  const parent = parts.at(-2);
  if (index !== -1 && parts[index + 1]) {
    skills.add(parts[index + 1]);
  } else if (parent) {
    skills.add(parent);
  }
}

function walkSkillFiles(root: string, skills: Set<string>, depth = 0) {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      addSkillFromPath(skills, absolute);
    } else if (entry.isDirectory()) {
      walkSkillFiles(absolute, skills, depth + 1);
    }
  }
}

export function buildCodexSkillInventory(codexHome: string, criticalSkills: readonly string[] = CRITICAL_LOCAL_CODEX_SKILLS): CodexSkillInventory {
  const exists = fs.existsSync(codexHome) && fs.statSync(codexHome).isDirectory();
  if (!exists) {
    return {
      status: "unavailable",
      codex_home_exists: false,
      total_discovered: 0,
      skill_names: [],
      critical_present: [],
      critical_missing: [...criticalSkills],
    };
  }
  const skills = new Set<string>();
  walkSkillFiles(codexHome, skills);
  const skillNames = [...skills].sort((a, b) => a.localeCompare(b));
  const skillNameSet = new Set(skillNames);
  const criticalPresent = criticalSkills.filter((skill) => skillNameSet.has(skill));
  const criticalMissing = criticalSkills.filter((skill) => !skillNameSet.has(skill));
  return {
    status: criticalMissing.length ? "missing_critical_skills" : "ready",
    codex_home_exists: true,
    total_discovered: skillNames.length,
    skill_names: skillNames,
    critical_present: criticalPresent,
    critical_missing: criticalMissing,
  };
}

export function getCodexSkillInventory() {
  return buildCodexSkillInventory(config.codexHome);
}
