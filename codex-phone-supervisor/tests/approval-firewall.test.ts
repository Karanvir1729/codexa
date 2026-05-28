import test from "node:test";
import assert from "node:assert/strict";
import { classifyApproval } from "../backend/src/approval-firewall.js";

test("approval firewall gates GCP resource changes", () => {
  const classification = classifyApproval("gcloud run deploy codex-phone-supervisor");
  assert.equal(classification.requiresApproval, true);
  assert.equal(classification.kind, "gcp_resource");
  assert.equal(classification.risk, "high");
});

test("approval firewall gates Twilio webhook mutation", () => {
  const classification = classifyApproval("twilio incoming-phone-numbers update webhook");
  assert.equal(classification.requiresApproval, true);
  assert.equal(classification.kind, "twilio_mutation");
});

test("approval firewall allows simple status questions", () => {
  const classification = classifyApproval("what changed in this project?");
  assert.equal(classification.requiresApproval, false);
});

test("approval firewall does not gate negated deploy constraints", () => {
  const classification = classifyApproval("Use static files only and do not deploy the generated app.");
  assert.equal(classification.requiresApproval, false);
});
