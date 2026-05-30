import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl, extractFinalAgentText } from "../backend/src/parser.js";

test("parseCodexJsonl ignores non-json noise", () => {
  const parsed = parseCodexJsonl([
    "warn line",
    "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
    "{\"type\":\"turn.completed\"}",
  ].join("\n"));

  assert.equal(parsed.length, 2);
  assert.equal(extractFinalAgentText(parsed), "hello");
});
