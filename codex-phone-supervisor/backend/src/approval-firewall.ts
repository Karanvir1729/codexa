import type { ApprovalKind } from "./types.js";

export type ApprovalRisk = "low" | "medium" | "high";

export type ApprovalClassification = {
  requiresApproval: boolean;
  kind?: ApprovalKind;
  risk?: ApprovalRisk;
  reason?: string;
};

const rules: Array<{ kind: ApprovalKind; risk: ApprovalRisk; pattern: RegExp; reason: string }> = [
  { kind: "install", risk: "medium", pattern: /\b(npm|pnpm|yarn|pip|uv|brew)\s+(install|add)\b/i, reason: "Package installs change the local dependency/runtime surface." },
  { kind: "network", risk: "medium", pattern: /\b(curl|wget|fetch|scp|rsync|ssh)\b/i, reason: "Network access can send or retrieve data outside the workspace." },
  { kind: "delete", risk: "high", pattern: /\b(rm\s+-rf|rm\s|unlink|delete file|trash)\b/i, reason: "File deletion can destroy workspace data." },
  { kind: "git_push", risk: "high", pattern: /\bgit\s+push\b/i, reason: "Git push publishes changes outside the local workspace." },
  { kind: "gcp_resource", risk: "high", pattern: /\bgcloud\s+(run|pubsub|secrets|artifacts|services|projects|storage|sql|firestore)\b/i, reason: "GCP resource changes can create, mutate, or delete cloud resources." },
  { kind: "deploy", risk: "high", pattern: /\b(deploy|vercel\s+deploy|firebase\s+deploy|cloud\s+run\s+deploy)\b/i, reason: "Deploys publish software or infrastructure changes." },
  { kind: "secret_access", risk: "high", pattern: /\b(secret|credential|api key|token|password)\b/i, reason: "Secret or credential access can expose sensitive values." },
  { kind: "external_repo", risk: "medium", pattern: /\b(git\s+clone|gh\s+repo|outside workspace)\b/i, reason: "External repository access touches code outside the selected project." },
  { kind: "twilio_mutation", risk: "high", pattern: /\btwilio\b.*\b(update|create|delete|incoming-phone-numbers|webhook)\b/i, reason: "Twilio number or webhook mutations affect live communication routes." },
  { kind: "payment_or_billing", risk: "high", pattern: /\b(billing|payment|invoice|stripe|charge|subscription)\b/i, reason: "Payment and billing actions can affect money movement or invoices." },
];

export function classifyApproval(action: string): ApprovalClassification {
  for (const rule of rules) {
    if (rule.pattern.test(action)) {
      return {
        requiresApproval: true,
        kind: rule.kind,
        risk: rule.risk,
        reason: rule.reason,
      };
    }
  }
  return { requiresApproval: false };
}
