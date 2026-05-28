import type { ProjectDiscoveryTurn } from "./types.js";

const buildIntent = /\b(build|create|make|start|scaffold|generate)\b/i;
const requestIntent = /\b(?:i\s+)?(?:need|want|would like|am looking for|looking for)\b/i;
const projectWords = /\b(project|website|site|app|agent|tool|game|landing page)\b/i;

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function slugifyProjectName(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!slug) throw new Error("Project name must include at least one letter or number.");
  return slug;
}

function cleanProjectName(value: string) {
  return value
    .replace(/\b(the|a|an)\b/gi, " ")
    .replace(/\b(project|website|site|app|agent)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractName(text: string) {
  const quoted = text.match(/["“]([^"”]{2,80})["”]/);
  if (quoted?.[1]) return quoted[1].trim();

  const called = text.match(/\b(?:called|named)\s+["“']?([a-z0-9][a-z0-9 _-]{1,80})/i);
  if (called?.[1]) return called[1].replace(/[.?!].*$/, "").trim();

  const requested = text.match(/\b(?:i\s+)?(?:need|want|would like|am looking for|looking for)\s+(?:a|an|the)?\s*([a-z0-9][a-z0-9 _-]{1,80}?)\s+(project|website|site|app|agent|tool|game)\b/i);
  if (requested?.[1] && requested[2]) {
    const subject = cleanProjectName(requested[1].replace(/[.?!].*$/, ""));
    const afterKind = text.slice((requested.index ?? 0) + requested[0].length);
    const purpose = afterKind.match(/^\s+(?:for|about)\s+([a-z0-9][a-z0-9 _-]{1,80})/i)?.[1]?.replace(/[.?!].*$/, "");
    const cleanedPurpose = purpose ? cleanProjectName(purpose) : "";
    const kind = /website|site/i.test(requested[2]) ? "website" : /agent/i.test(requested[2]) ? "agent" : /game/i.test(requested[2]) ? "game" : "app";
    if (subject) return [subject, cleanedPurpose ? `for ${cleanedPurpose}` : "", kind].filter(Boolean).join(" ");
  }

  const about = text.match(/\b(?:talks? about|about|for)\s+([a-z0-9][a-z0-9 _-]{1,80})/i);
  if (about?.[1]) {
    const subject = cleanProjectName(about[1].replace(/[.?!].*$/, ""));
    if (subject) return /\blanding page\b/i.test(text) ? `${subject} landing page` : projectWords.test(text) ? `${subject} website` : subject;
  }

  const nounBeforeProject = text.match(/\b([a-z0-9][a-z0-9 _-]{1,50})\s+(project|website|site|app|agent|game)\b/i);
  if (nounBeforeProject?.[1]) {
    const subject = cleanProjectName(nounBeforeProject[1]);
    if (subject && !buildIntent.test(subject)) return `${subject} ${nounBeforeProject[2]}`;
  }

  return "";
}

export function inferNewProjectSpec(text: string, _conversation: ProjectDiscoveryTurn[] = []) {
  const hasIntent = (
    buildIntent.test(text) && (projectWords.test(text) || /\bnew\b/i.test(text))
  ) || (
    requestIntent.test(text) && projectWords.test(text)
  );
  if (!hasIntent) return null;

  const latestName = extractName(text);
  if (!latestName) {
    return {
      needsName: true,
      displayName: "",
      slug: "",
      assistantMessage: "What should I call the new project?",
    };
  }

  const slug = slugifyProjectName(latestName);
  return {
    needsName: false,
    displayName: titleFromSlug(slug),
    slug,
    assistantMessage: `Creating a new project: ${titleFromSlug(slug)}.`,
  };
}
