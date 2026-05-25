import fs from "node:fs";

const sourcePath = "docs/architecture/agentic-coding-feedback-state-machine.excalidraw";
const outPath = "docs/architecture/agentic-coding-feedback-state-machine.excalidraw";
const clipPath = "docs/architecture/agentic-coding-feedback-state-machine.clipboard.json";

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const files = source.files ?? {};

let n = 0;
function id(prefix) {
  n += 1;
  return `${prefix}_${String(n).padStart(4, "0")}`;
}

function base(type, x, y, width, height, extra = {}) {
  return {
    id: id(type),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#111827",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: 100000 + n,
    version: 1,
    versionNonce: 900000 + n,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
}

function rect(x, y, w, h, stroke, bg, opts = {}) {
  return base("rectangle", x, y, w, h, {
    strokeColor: stroke,
    backgroundColor: bg,
    strokeWidth: opts.strokeWidth ?? 3,
    strokeStyle: opts.strokeStyle ?? "solid",
    roundness: { type: opts.roundness ?? 3 },
  });
}

function text(x, y, w, value, size = 18, color = "#111827", opts = {}) {
  const lines = value.split("\n").length;
  const lineHeight = opts.lineHeight ?? 1.15;
  return base("text", x, y, w, Math.ceil(size * lineHeight * lines), {
    strokeColor: color,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    text: value,
    fontSize: size,
    fontFamily: 1,
    textAlign: opts.align ?? "center",
    verticalAlign: opts.valign ?? "middle",
    containerId: null,
    originalText: value,
    lineHeight,
    baseline: Math.floor(size * 0.76),
  });
}

function image(x, y, size, fileId) {
  return base("image", x, y, size, size, {
    strokeColor: "transparent",
    backgroundColor: "transparent",
    strokeWidth: 1,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
  });
}

function iconBlock(elements, x, y, fileId, title, sub = "", opts = {}) {
  const size = opts.size ?? 76;
  const labelW = opts.labelW ?? 150;
  elements.push(image(x + (labelW - size) / 2, y, size, fileId));
  elements.push(text(x, y + size + 10, labelW, title, opts.titleSize ?? 17, opts.color ?? "#111827"));
  if (sub) {
    elements.push(text(x, y + size + 42, labelW, sub, opts.subSize ?? 13, opts.subColor ?? "#374151"));
  }
}

function arrow(x, y, points, color, opts = {}) {
  return base("arrow", x, y, 0, 0, {
    strokeColor: color,
    backgroundColor: "transparent",
    strokeWidth: opts.strokeWidth ?? 4,
    strokeStyle: opts.strokeStyle ?? "solid",
    roundness: { type: 2 },
    points,
    startBinding: null,
    endBinding: null,
    lastCommittedPoint: null,
    startArrowhead: opts.startArrowhead ?? null,
    endArrowhead: opts.endArrowhead ?? "arrow",
  });
}

function label(elements, x, y, w, value, color, size = 14, opts = {}) {
  elements.push(text(x, y, w, value, size, color, opts));
}

function laneTitle(elements, x, y, w, title, color) {
  elements.push(text(x, y, w, title, 25, color, { align: "left" }));
}

const els = [];

// Title
els.push(text(70, 40, 780, "Agentic Coding Voice Agent", 48, "#111827", { align: "left" }));
els.push(text(
  75,
  104,
  1640,
  "Modular production microservices architecture. Red path stays low-latency; green improvement loop is eval-gated before it reaches live coding assistance.",
  24,
  "#334155",
  { align: "left" },
));

// Top lanes
els.push(rect(60, 165, 380, 360, "#f97316", "#fff7ed", { strokeStyle: "dashed" }));
laneTitle(els, 82, 188, 330, "USER DEVICE / BROWSER", "#ea580c");
els.push(rect(480, 165, 390, 360, "#d97706", "#fffbeb", { strokeStyle: "dashed" }));
laneTitle(els, 502, 188, 330, "AWS EDGE / INGRESS", "#b45309");
els.push(rect(910, 165, 1290, 360, "#ef4444", "#fff1f2", { strokeStyle: "dashed" }));
laneTitle(els, 934, 188, 530, "REAL-TIME CRITICAL PATH", "#dc2626");
els.push(text(1575, 192, 560, "CRITICAL PATH: keep voice latency low", 21, "#dc2626"));

// User/browser icons
iconBlock(els, 95, 260, "file_browser", "React Web App", "developer UI", { color: "#111827" });
iconBlock(els, 250, 260, "file_mic", "WebRTC Client", "audio stream", { color: "#111827" });
iconBlock(els, 95, 405, "file_webgpu", "Local Models", "VAD / confusion / topic", { color: "#111827", size: 68, subSize: 12 });
iconBlock(els, 250, 405, "file_localcache", "Local TTS Cache", "fallback phrases", { color: "#111827", size: 68, subSize: 12 });

// Edge icons
iconBlock(els, 508, 260, "file_route53", "Route 53", "latency DNS", { labelW: 110 });
iconBlock(els, 638, 260, "file_accel", "Global Accel.", "edge POPs", { labelW: 120 });
iconBlock(els, 780, 260, "file_nlb", "NLB", "TLS ingress", { labelW: 95 });
iconBlock(els, 635, 405, "file_gateway", "Voice Gateway", "EC2 replicas", { labelW: 150, size: 74 });

// Critical path icons
iconBlock(els, 940, 282, "file_pipecat", "Pipecat", "workers xN", { labelW: 130, size: 74 });
iconBlock(els, 1100, 282, "file_asr", "ASR Router", "Riva primary", { labelW: 135, size: 74 });
iconBlock(els, 1265, 282, "file_orch", "Coding Agent Orchestrator", "live context", { labelW: 170, size: 74 });
iconBlock(els, 1470, 282, "file_vllm", "vLLM / Triton", "G5 GPU", { labelW: 145, size: 74 });
iconBlock(els, 1660, 282, "file_tts", "TTS Router", "primary/fallback", { labelW: 150, size: 74 });
els.push(rect(1180, 450, 610, 54, "#ef4444", "#fff", { strokeWidth: 2 }));
els.push(text(1190, 464, 590, "Fast path only: L1 context cache + RAG-lite + response planner", 19, "#7f1d1d"));
els.push(rect(1050, 450, 95, 54, "#64748b", "#fff", { strokeWidth: 2, strokeStyle: "dotted" }));
els.push(text(1060, 464, 75, "ASR\nfallback", 14, "#475569"));
els.push(rect(1830, 450, 150, 54, "#64748b", "#fff", { strokeWidth: 2, strokeStyle: "dotted" }));
els.push(text(1840, 464, 130, "TTS/cache\nfallback", 14, "#475569"));

// Critical arrows
els.push(arrow(190, 326, [[0, 0], [58, 0]], "#ef4444", { strokeWidth: 5 }));
label(els, 170, 292, 120, "developer speaks", "#b91c1c", 14);
els.push(arrow(345, 326, [[0, 0], [170, 0]], "#ef4444", { strokeWidth: 5 }));
label(els, 356, 294, 150, "WebRTC audio", "#b91c1c", 14);
els.push(arrow(610, 326, [[0, 0], [52, 0]], "#ef4444", { strokeWidth: 5 }));
els.push(arrow(745, 326, [[0, 0], [55, 0]], "#ef4444", { strokeWidth: 5 }));
els.push(arrow(820, 392, [[0, 0], [-112, 64]], "#ef4444", { strokeWidth: 5 }));
label(els, 720, 424, 170, "session routed", "#b91c1c", 14);
els.push(arrow(785, 448, [[0, 0], [172, -93]], "#ef4444", { strokeWidth: 5 }));
label(els, 845, 392, 145, "media frames", "#b91c1c", 14);
els.push(arrow(1040, 326, [[0, 0], [90, 0]], "#ef4444", { strokeWidth: 5 }));
label(els, 1040, 293, 110, "ASR text", "#991b1b", 14);
els.push(arrow(1210, 326, [[0, 0], [90, 0]], "#ef4444", { strokeWidth: 5 }));
label(els, 1210, 293, 110, "plan move", "#991b1b", 14);
els.push(arrow(1405, 326, [[0, 0], [100, 0]], "#ef4444", { strokeWidth: 5 }));
label(els, 1415, 293, 110, "LLM tokens", "#991b1b", 14);
els.push(arrow(1600, 326, [[0, 0], [100, 0]], "#ef4444", { strokeWidth: 5 }));
label(els, 1620, 293, 110, "speech out", "#991b1b", 14);
els.push(arrow(1740, 262, [[0, 0], [-1470, 0]], "#ef4444", { strokeWidth: 4 }));
label(els, 915, 228, 520, "spoken response returned through Pipecat + WebRTC", "#ef4444", 20);
els.push(arrow(1122, 438, [[0, 0], [0, 44]], "#64748b", { strokeStyle: "dotted", strokeWidth: 3 }));
els.push(arrow(1734, 438, [[0, 0], [140, 44]], "#64748b", { strokeStyle: "dotted", strokeWidth: 3 }));

// Event/context backbone
els.push(rect(60, 570, 2140, 220, "#2563eb", "#eff6ff", { strokeStyle: "dashed" }));
laneTitle(els, 82, 596, 770, "SHARED EVENT + HOT CONTEXT BACKBONE", "#2563eb");
iconBlock(els, 1025, 646, "file_redis", "Redis Streams", "events + commands", { labelW: 160, size: 76, color: "#1e40af" });
iconBlock(els, 805, 646, "file_dlq", "DLQ + Retry", "idempotency keys", { labelW: 150, size: 72, color: "#1e40af" });
iconBlock(els, 1245, 646, "file_cache", "Redis Cache", "session context", { labelW: 150, size: 72, color: "#1e40af" });
iconBlock(els, 1640, 646, "file_cache", "Hot Strategy Cache", "active version", { labelW: 185, size: 76, color: "#166534" });
iconBlock(els, 1450, 646, "file_scip", "SCIP Optimizer", "action constraints", { labelW: 170, size: 72, color: "#1e40af" });
els.push(rect(220, 635, 500, 92, "#2563eb", "#fff", { strokeWidth: 2 }));
els.push(text(
  245,
  650,
  450,
  "Feedback-loop trigger events\nstrategy.failed | failure_mode.detected | eval_case.generated\nscip.action_selected | strategy.promoted | strategy.rollback",
  17,
  "#1d4ed8",
));

// Backbone arrows
els.push(arrow(1345, 420, [[0, 0], [0, 210]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
label(els, 1362, 527, 245, "emit transcript + strategy events", "#2563eb", 15, { align: "left" });
els.push(arrow(305, 485, [[0, 0], [0, 145], [700, 20]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
label(els, 180, 545, 190, "client signals", "#2563eb", 15);
els.push(arrow(1185, 686, [[0, 0], [60, 0]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
els.push(arrow(1400, 686, [[0, 0], [56, 0]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
els.push(arrow(1520, 646, [[0, 0], [-138, -215]], "#16a34a", { strokeStyle: "dashed", strokeWidth: 4 }));
label(els, 1390, 535, 360, "active strategy read by orchestrator", "#15803d", 17);

// Feedback state machine
els.push(rect(60, 835, 2140, 355, "#16a34a", "#ecfdf5", { strokeStyle: "dashed" }));
laneTitle(els, 82, 860, 1280, "ASYNC CONTROL PLANE: STRATEGY LIFECYCLE — does not block voice response", "#16a34a");
els.push(text(1510, 860, 600, "Only promoted strategy versions affect live coding assistance", 23, "#15803d"));

const stateY = 940;
const stateW = 220;
const stateH = 96;
const stateXs = [120, 375, 630, 885, 1140, 1395];
const states = [
  ["Observed Failure", "failure mode + failed strategy", "file_worker", "Failure Mode\nDetection Agent"],
  ["Improvement Proposed", "new strategy vNext", "file_eval", "Eval Generation\nAgent"],
  ["Pending Eval", "eval from trace", "file_gate", "Auto-Improvement\nAgent"],
  ["Tested", "old vs new scored", "file_eval", "Regression Eval\nRunner"],
  ["Promoted", "score improves", "file_gate", "Strategy Promotion\nGate"],
  ["Active Strategy", "served from cache", "file_redis", "Writes Active\nVersion"],
];
for (let i = 0; i < states.length; i += 1) {
  const [title, sub, fileId, svc] = states[i];
  const x = stateXs[i];
  els.push(rect(x, stateY, stateW, stateH, "#16a34a", "#f0fdf4", { strokeWidth: 3 }));
  els.push(text(x + 12, stateY + 18, stateW - 24, title, 21, "#065f46"));
  els.push(text(x + 12, stateY + 58, stateW - 24, sub, 15, "#166534"));
  if (i < states.length - 1) {
    els.push(arrow(x + stateW, stateY + 48, [[0, 0], [34, 0]], "#16a34a", { strokeWidth: 4 }));
  }
  iconBlock(els, x + 40, 1062, fileId, svc, "", { labelW: 140, size: 58, color: "#111827", titleSize: 15 });
}

// Trigger from event bus into lifecycle.
els.push(arrow(1105, 762, [[0, 0], [-875, 170]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 4 }));
label(els, 125, 825, 210, "strategy.failed\nfailure_mode.detected", "#2563eb", 16);

// Promotion into cache.
els.push(arrow(1505, 940, [[0, 0], [230, -208], [0, -72]], "#16a34a", { strokeWidth: 5 }));
label(els, 1780, 820, 210, "strategy.promoted", "#15803d", 17);

// Rollback/rejection branch.
els.push(rect(948, 1104, 250, 62, "#64748b", "#ffffff", { strokeWidth: 3 }));
els.push(text(960, 1117, 226, "Rejected / Rollback\nregression or weak evidence", 17, "#475569"));
els.push(arrow(995, 1036, [[0, 0], [0, 65]], "#64748b", { strokeStyle: "dotted", strokeWidth: 4 }));
label(els, 1008, 1060, 155, "eval regression", "#64748b", 14, { align: "left" });
els.push(arrow(948, 1135, [[0, 0], [-430, 0], [0, -98]], "#7c3aed", { strokeStyle: "dotted", strokeWidth: 3 }));
label(els, 570, 1104, 250, "strategy.rollback event", "#7c3aed", 15);

// Dashboard proof.
els.push(rect(1740, 930, 365, 198, "#7c3aed", "#ffffff", { strokeWidth: 3 }));
els.push(text(1762, 950, 320, "Dashboard Proof", 21, "#6d28d9"));
els.push(text(
  1780,
  992,
  285,
  "transcript\nfailure mode tag\nSCIP action\ngenerated eval\nbefore / after\npromoted strategy",
  16,
  "#111827",
));

// Durable memory writes
els.push(rect(60, 1230, 1465, 255, "#0284c7", "#f0f9ff", { strokeStyle: "dashed" }));
laneTitle(els, 82, 1254, 980, "DURABLE MEMORY WRITES FROM THE FEEDBACK LOOP", "#0284c7");
iconBlock(els, 110, 1342, "file_s3", "S3 / MinIO", "failure traces", { labelW: 175, size: 72 });
iconBlock(els, 390, 1342, "file_aurora", "Aurora Postgres", "strategy registry", { labelW: 190, size: 72 });
iconBlock(els, 680, 1342, "file_qdrant", "Qdrant", "eval + strategy vectors", { labelW: 190, size: 72 });
iconBlock(els, 965, 1342, "file_key", "Keyspaces RF=3", "cohort + failure modes", { labelW: 190, size: 72 });
iconBlock(els, 1248, 1342, "file_rag", "Embedding + KB", "ingestion workers", { labelW: 190, size: 72 });

// Clean, mostly vertical durable-write arrows.
els.push(arrow(230, 1124, [[0, 0], [0, 215]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
label(els, 155, 1206, 170, "session evidence", "#2563eb", 14);
els.push(arrow(485, 1124, [[0, 0], [0, 215]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
label(els, 408, 1206, 160, "strategy version", "#2563eb", 14);
els.push(arrow(740, 1124, [[0, 0], [25, 215]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
label(els, 700, 1206, 130, "eval case", "#2563eb", 14);
els.push(arrow(995, 1124, [[0, 0], [65, 215]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
label(els, 1015, 1206, 150, "cohort memory", "#2563eb", 14);
els.push(arrow(1260, 1124, [[0, 0], [95, 215]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 3 }));
label(els, 1260, 1206, 180, "new embeddings", "#2563eb", 14);

// Observability / deployment
els.push(rect(1565, 1230, 635, 255, "#7c3aed", "#faf5ff", { strokeStyle: "dashed" }));
laneTitle(els, 1588, 1254, 560, "OBSERVABILITY + DEPLOYMENT", "#7c3aed");
iconBlock(els, 1610, 1342, "file_docker", "Docker Swarm", "EC2 ASGs", { labelW: 175, size: 72 });
iconBlock(els, 1805, 1342, "file_cloudwatch", "CloudWatch", "latency alerts", { labelW: 165, size: 72 });
iconBlock(els, 1982, 1342, "file_grafana", "Prometheus", "Grafana + OTel", { labelW: 175, size: 72 });
els.push(text(1605, 1460, 545, "Tracks p95 latency, queue lag, fallback rate, eval regression, strategy rollback", 15, "#6d28d9"));

// Legend
els.push(rect(60, 1530, 2140, 72, "#94a3b8", "#ffffff", { strokeWidth: 2 }));
els.push(arrow(105, 1566, [[0, 0], [95, 0]], "#ef4444", { strokeWidth: 5, endArrowhead: null }));
els.push(text(220, 1549, 310, "solid red = synchronous voice/media", 19, "#334155", { align: "left" }));
els.push(arrow(610, 1566, [[0, 0], [95, 0]], "#2563eb", { strokeStyle: "dashed", strokeWidth: 4, endArrowhead: null }));
els.push(text(725, 1549, 310, "dashed blue = async events/data", 19, "#334155", { align: "left" }));
els.push(arrow(1105, 1566, [[0, 0], [95, 0]], "#16a34a", { strokeWidth: 5, endArrowhead: null }));
els.push(text(1220, 1549, 350, "green = eval-gated strategy lifecycle", 19, "#334155", { align: "left" }));
els.push(arrow(1640, 1566, [[0, 0], [95, 0]], "#64748b", { strokeStyle: "dotted", strokeWidth: 4, endArrowhead: null }));
els.push(text(1755, 1549, 330, "dotted = fallback / rollback", 19, "#334155", { align: "left" }));

const doc = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: els,
  appState: {
    gridSize: null,
    viewBackgroundColor: "#ffffff",
  },
  files,
};

fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
fs.writeFileSync(clipPath, `${JSON.stringify({ type: "excalidraw/clipboard", elements: els, files }, null, 2)}\n`);
console.log(`Wrote ${outPath} with ${els.length} elements`);
