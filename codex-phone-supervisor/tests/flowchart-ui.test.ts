import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("dashboard flowchart nodes are clickable and open the details panel", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "codex-phone-supervisor", "frontend", "src", "main.tsx"), "utf8");
  assert.match(source, /data-testid="cloud-orchestrator-flowchart"/);
  assert.match(source, /data-testid=\{`flow-node-\$\{node\.type\}`\}/);
  assert.match(source, /onClick=\{\(\) => setSelectedNodeId\(node\.id\)\}/);
  assert.match(source, /data-testid="flow-node-details"/);
  assert.match(source, /JSON\.stringify\(selectedNode\.detail/);
});
