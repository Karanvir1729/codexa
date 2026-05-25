import fs from "node:fs";

const sourcePath = "docs/architecture/agentic-coding-feedback-state-machine.excalidraw";
const judgeOut = "docs/architecture/agentic-coding-hackathon-architecture.excalidraw";
const judgeClip = "docs/architecture/agentic-coding-hackathon-architecture.clipboard.json";
const appendixOut = "docs/architecture/agentic-coding-technical-appendix.excalidraw";
const appendixClip = "docs/architecture/agentic-coding-technical-appendix.clipboard.json";

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const files = source.files ?? {};

let counter = 0;
const uid = (prefix) => `${prefix}_${String(++counter).padStart(4, "0")}`;

const C = {
  ink: "#111827",
  muted: "#475569",
  red: "#dc2626",
  redDark: "#991b1b",
  redBg: "#fff1f2",
  blue: "#2563eb",
  blueDark: "#1d4ed8",
  blueBg: "#eff6ff",
  green: "#16a34a",
  greenDark: "#166534",
  greenBg: "#ecfdf5",
  teal: "#0f766e",
  tealBg: "#f0fdfa",
  orange: "#ea580c",
  orangeBg: "#fff7ed",
  purple: "#7c3aed",
  purpleBg: "#f5f3ff",
  gray: "#64748b",
  grayBg: "#f8fafc",
  yellow: "#ca8a04",
  yellowBg: "#fefce8",
};

function el(type, x, y, width, height, extra = {}) {
  return {
    id: uid(type),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: C.ink,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: 400000 + counter,
    version: 1,
    versionNonce: 800000 + counter,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
}

function rect(a, x, y, w, h, stroke, bg, opts = {}) {
  const e = el("rectangle", x, y, w, h, {
    strokeColor: stroke,
    backgroundColor: bg,
    strokeWidth: opts.strokeWidth ?? 2,
    strokeStyle: opts.strokeStyle ?? "solid",
    roundness: { type: opts.roundness ?? 3 },
  });
  a.push(e);
  return e;
}

function text(a, x, y, w, value, size = 18, color = C.ink, opts = {}) {
  const lines = String(value).split("\n").length;
  const lineHeight = opts.lineHeight ?? 1.15;
  const e = el("text", x, y, w, Math.ceil(size * lineHeight * lines), {
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
  a.push(e);
  return e;
}

function image(a, x, y, size, fileId) {
  if (!files[fileId]) return null;
  const e = el("image", x, y, size, size, {
    strokeColor: "transparent",
    backgroundColor: "transparent",
    strokeWidth: 1,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
  });
  a.push(e);
  return e;
}

function arrow(a, x, y, points, color, opts = {}) {
  const e = el("arrow", x, y, 0, 0, {
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
  a.push(e);
  return e;
}

function lane(a, x, y, w, h, title, stroke, bg, subtitle = "") {
  rect(a, x, y, w, h, stroke, bg, { strokeWidth: 3, strokeStyle: "dashed" });
  text(a, x + 24, y + 18, w - 48, title, 25, stroke, { align: "left" });
  if (subtitle) text(a, x + 24, y + 52, w - 48, subtitle, 14, stroke, { align: "left" });
}

function card(a, x, y, w, h, title, body, stroke, bg = "#ffffff", opts = {}) {
  rect(a, x, y, w, h, stroke, bg, { strokeWidth: opts.strokeWidth ?? 2 });
  if (opts.fileId) image(a, x + 15, y + 18, opts.iconSize ?? 42, opts.fileId);
  const tx = opts.fileId ? x + 68 : x + 16;
  const tw = opts.fileId ? w - 84 : w - 32;
  text(a, tx, y + 14, tw, title, opts.titleSize ?? 16, stroke, { align: "left", lineHeight: 1.08 });
  if (body) text(a, tx, y + (opts.bodyY ?? 48), tw, body, opts.bodySize ?? 12, opts.bodyColor ?? C.ink, { align: "left", lineHeight: 1.15 });
}

function state(a, x, y, w, h, title, body, num) {
  rect(a, x, y, w, h, C.green, "#ffffff", { strokeWidth: 3 });
  if (num) {
    rect(a, x + 10, y + 10, 28, 28, C.green, C.greenBg, { strokeWidth: 2 });
    text(a, x + 10, y + 13, 28, num, 15, C.greenDark);
  }
  text(a, x + (num ? 46 : 12), y + 14, w - (num ? 58 : 24), title, 15, C.greenDark, { align: "left" });
  if (body) text(a, x + 12, y + 50, w - 24, body, 11, C.greenDark, { align: "left" });
}

function lineLabel(a, x, y, w, value, color = C.muted, size = 12) {
  text(a, x, y, w, value, size, color, { align: "left" });
}

function writeDoc(outPath, clipPath, elements) {
  const doc = {
    type: "excalidraw",
    version: 2,
    source: "https://excalidraw.com",
    elements,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
  fs.writeFileSync(clipPath, `${JSON.stringify({ type: "excalidraw/clipboard", elements, files }, null, 2)}\n`);
  console.log(`Wrote ${outPath} with ${elements.length} elements`);
}

function buildJudgeDiagram() {
  counter = 0;
  const a = [];

  text(a, 55, 34, 1060, "Agentic Coding Voice Agent: Modular Production Architecture", 39, C.ink, { align: "left" });
  text(
    a,
    60,
    84,
    1130,
    "Production-grade coding voice agent: live coding assistance stays fast while async agents learn from failures,\nrun evals, and safely promote better coding strategies.",
    18,
    "#334155",
    { align: "left" },
  );

  card(a, 1246, 30, 118, 82, "Daily", "WebRTC", C.orange, "#ffffff", { fileId: "file_mic", iconSize: 30, titleSize: 13, bodySize: 10 });
  card(a, 1378, 30, 118, 82, "Cekura", "evals", C.green, "#ffffff", { fileId: "file_eval", iconSize: 30, titleSize: 13, bodySize: 10 });
  card(a, 1510, 30, 132, 82, "NVIDIA", "NIM + NeMo", C.red, "#ffffff", { fileId: "file_vllm", iconSize: 30, titleSize: 13, bodySize: 10 });
  card(a, 1656, 30, 112, 82, "GCP now", "prototype", C.blue, "#ffffff", { fileId: "file_cloudwatch", iconSize: 30, titleSize: 13, bodySize: 10 });
  card(a, 1782, 30, 112, 82, "AWS later", "target", C.purple, "#ffffff", { fileId: "file_docker", iconSize: 30, titleSize: 13, bodySize: 10 });

  lane(
    a,
    45,
    145,
    1880,
    176,
    "1. USER DEVICE + PROTOTYPE EDGE / INGRESS: GCP Cloud Run + optional Twilio/Daily ingress",
    C.orange,
    C.orangeBg,
    "Two entry paths converge into the same colocated realtime coding assistance pipeline.",
  );
  card(a, 82, 218, 245, 75, "Browser Session", "React client\nDaily / WebRTC", C.orange, "#ffffff", { fileId: "file_browser", iconSize: 36 });
  card(a, 362, 218, 245, 75, "Phone Session", "Twilio telephony\nPSTN / SIP", C.orange, "#ffffff", { fileId: "file_mic", iconSize: 36 });
  card(a, 660, 212, 325, 88, "Daily / Twilio Ingress", "media + session handoff\nroutes to voice services", C.orange, "#ffffff", { fileId: "file_gateway", iconSize: 42, titleSize: 17 });
  card(a, 1030, 212, 325, 88, "Cloud Run Session Router", "tokens, stickiness,\nregion guidance", C.blue, "#ffffff", { fileId: "file_nlb", iconSize: 42, titleSize: 17 });
  card(a, 1398, 212, 430, 88, "Local Lightweight Models", "VAD | interruption detector | phrase cache\noptional WebGPU failure pattern classifier", C.orange, "#ffffff", { fileId: "file_webgpu", iconSize: 42, titleSize: 17 });

  lane(
    a,
    45,
    350,
    1880,
    250,
    "2. DAILY / PIPECAT-COMPATIBLE REALTIME VOICE ORCHESTRATION",
    C.red,
    C.redBg,
    "CRITICAL PATH: sub-second response path. Realtime voice stays colocated to avoid latency.",
  );
  card(a, 86, 435, 250, 92, "Prototype Voice Services", "Cloud Run / Compute Engine\nAWS target: ECS/Fargate or EC2 ASG", C.red, "#ffffff", { fileId: "file_pipecat", iconSize: 46, titleSize: 16, bodySize: 11 });
  card(a, 372, 435, 215, 92, "Barge-in Node", "interrupts cancel\nLLM/TTS streams", C.red, "#ffffff", { fileId: "file_mic", iconSize: 46, titleSize: 16 });
  card(a, 623, 435, 210, 92, "ASR Router", "streaming ASR\nRiva optional later", C.redDark, "#ffffff", { fileId: "file_asr", iconSize: 46, titleSize: 16 });
  card(a, 868, 435, 260, 92, "Coding Agent LLM Runtime", "fast server model\nNIM API first", C.redDark, "#ffffff", { fileId: "file_vllm", iconSize: 46, titleSize: 16 });
  card(a, 1164, 435, 210, 92, "TTS Router", "streaming TTS\ncached fallback", C.redDark, "#ffffff", { fileId: "file_tts", iconSize: 46, titleSize: 16 });
  card(a, 1420, 412, 415, 130, "Deploy at Scale", "Pipecat/Daily realtime orchestration\n+ Twilio telephony for browser/phone.\nTurn-taking, interruptions,\nfallback routing, latency telemetry.", C.red, "#ffffff", { titleSize: 18, bodySize: 11, bodyY: 48 });
  arrow(a, 205, 293, [[0, 0], [0, 23], [455, 23], [455, -37]], C.red, { strokeWidth: 5 });
  arrow(a, 607, 256, [[0, 0], [53, 0]], C.red, { strokeWidth: 5 });
  arrow(a, 985, 256, [[0, 0], [45, 0]], C.red, { strokeWidth: 5 });
  arrow(a, 1190, 300, [[0, 0], [0, 50]], C.red, { strokeWidth: 5 });
  lineLabel(a, 94, 560, 520, "1. Developer speaks through browser/WebRTC or phone/Twilio", C.red, 14);
  arrow(a, 336, 481, [[0, 0], [36, 0]], C.red, { strokeWidth: 5 });
  arrow(a, 587, 481, [[0, 0], [36, 0]], C.red, { strokeWidth: 5 });
  arrow(a, 833, 481, [[0, 0], [35, 0]], C.red, { strokeWidth: 5 });
  arrow(a, 1128, 481, [[0, 0], [36, 0]], C.red, { strokeWidth: 5 });
  arrow(a, 1374, 481, [[0, 0], [60, 0]], C.red, { strokeWidth: 5 });
  lineLabel(a, 820, 545, 420, "2. Realtime assistant responds without waiting for async workers", C.red, 14);

  lane(
    a,
    45,
    630,
    1880,
    152,
    "3. REDIS STREAMS + HOT CONTEXT PLANE",
    C.blue,
    C.blueBg,
    "GCP now: Memorystore Redis or Upstash Redis. AWS later: ElastiCache Redis / MemoryDB.",
  );
  card(a, 82, 695, 430, 58, "Redis Streams Event Bus", "transcript.final | failure_mode.detected | strategy.failed\neval_case.generated | strategy.promoted", C.blue, "#ffffff", { fileId: "file_redis", iconSize: 32, titleSize: 15, bodySize: 9 });
  card(a, 548, 695, 310, 58, "Session + Developer State", "concept | task confidence | active failure pattern | guidance history", C.blue, "#ffffff", { fileId: "file_cache", iconSize: 32, titleSize: 15, bodySize: 10 });
  card(a, 894, 682, 330, 84, "Active Coding Strategy Cache", "only promoted strategy versions\nused by live assistant", C.green, "#ffffff", { fileId: "file_cache", iconSize: 42, titleSize: 15, bodySize: 11 });
  card(a, 1310, 695, 300, 58, "Retry / DLQ", "consumer groups + idempotency", C.blue, "#ffffff", { fileId: "file_dlq", iconSize: 32, titleSize: 15, bodySize: 10 });
  card(a, 1645, 690, 230, 68, "Events Trigger", "3. failure mode/confusion\n4. Redis event emitted", C.blue, "#ffffff", { titleSize: 15, bodySize: 11 });
  arrow(a, 729, 527, [[0, 0], [0, 168]], C.blue, { strokeStyle: "dashed", strokeWidth: 3 });
  arrow(a, 1058, 682, [[0, 0], [-52, -155]], C.green, { strokeStyle: "dashed", strokeWidth: 4 });
  lineLabel(a, 1018, 610, 310, "fast read: selected strategy", C.greenDark, 13);

  lane(
    a,
    45,
    815,
    1880,
    214,
    "4. HORIZONTALLY SCALED ASYNC LEARNING AGENTS",
    C.teal,
    C.tealBg,
    "Agents communicate through Redis Streams, not direct service chaining. Heavy work stays off the live voice path.",
  );
  card(a, 92, 898, 270, 78, "Developer State + Failure Mode", "task confidence, confusion,\nfailure-mode tags", C.teal, "#ffffff", { fileId: "file_worker", iconSize: 40, titleSize: 15, bodySize: 11 });
  card(a, 398, 898, 270, 78, "RAG / Memory Agent", "similar failures\nQdrant + NeMo rerank", C.teal, "#ffffff", { fileId: "file_rag", iconSize: 40, titleSize: 15, bodySize: 11 });
  card(a, 704, 898, 330, 78, "Strategy + SCIP Agent", "guidance | analogy | example | quiz\nmax learning gain under constraints", C.teal, "#ffffff", { fileId: "file_scip", iconSize: 40, titleSize: 15, bodySize: 10 });
  card(a, 1070, 898, 325, 78, "Cekura-style Eval Worker", "simulation, replay,\nregression testing, monitoring", C.green, "#ffffff", { fileId: "file_eval", iconSize: 40, titleSize: 15, bodySize: 11 });
  card(a, 1432, 878, 395, 118, "NVIDIA Model Runtime Layer", "hosted NIM APIs first; self-hosted GPU later\nNIM LLM: strategy/eval reasoning\nNeMo Retriever: embedding/reranking\nRiva ASR/TTS optional later path", C.red, "#ffffff", { fileId: "file_vllm", iconSize: 42, titleSize: 15, bodySize: 10 });
  for (const cx of [227, 533, 869, 1232]) {
    arrow(a, cx, 782, [[0, 0], [0, 116]], C.blue, { strokeStyle: "dashed", strokeWidth: 3 });
    arrow(a, cx + 26, 898, [[0, 0], [0, -116]], C.blue, { strokeStyle: "dashed", strokeWidth: 2, endArrowhead: null });
  }
  lineLabel(a, 96, 1000, 300, "5. Async agents analyze failure", C.teal, 13);
  lineLabel(a, 710, 1000, 360, "SCIP: next coding assistance action under latency + confidence constraints", C.teal, 13);

  lane(
    a,
    45,
    1065,
    1880,
    292,
    "5. SELF-IMPROVEMENT LOOP: Developer Failure -> Promoted Coding Strategy",
    C.green,
    C.greenBg,
    "Cekura-style replay, simulation, regression testing, monitoring, and eval-gated promotion.",
  );
  const sw = 210;
  const sg = 18;
  const sy = 1160;
  const loop = [
    ["Observed Failure", "session trace"],
    ["Failure Mode Classified", "failure-mode tag"],
    ["Candidate Coding\nStrategy", "prompt/tool policy"],
    ["Replay Eval\nGenerated", "similar scenario"],
    ["Tested Against\nBaseline", "candidate vs old"],
    ["Promoted Strategy", "versioned policy"],
    ["Active Strategy\nCache", "Redis hot path"],
    ["Next Similar Developer\nGets Better Explanation", "live reuse"],
  ];
  loop.forEach(([title, body], i) => {
    const x = 72 + i * (sw + sg);
    state(a, x, sy, sw, 88, title, body, String(i + 1));
    if (i < loop.length - 1) arrow(a, x + sw, sy + 44, [[0, 0], [sg, 0]], C.green, { strokeWidth: 4 });
  });
  rect(a, 1098, 1284, 360, 46, C.gray, "#ffffff", { strokeWidth: 3 });
  text(a, 1114, 1294, 328, "Failed Eval / Regression -> Rejected or Rolled Back", 13, C.gray);
  arrow(a, 1278, sy + 88, [[0, 0], [0, 36]], C.gray, { strokeStyle: "dotted", strokeWidth: 4 });
  arrow(a, 1098, 1307, [[0, 0], [-382, 0], [0, -59]], C.gray, { strokeStyle: "dotted", strokeWidth: 3 });
  arrow(a, 1492, sy, [[0, 0], [-430, -394]], C.green, { strokeWidth: 5 });
  lineLabel(a, 1006, 1332, 420, "7. Passing strategy promoted into hot cache", C.greenDark, 13);
  lineLabel(a, 1588, 1266, 260, "8. Next similar developer gets improved explanation", C.greenDark, 13);
  card(a, 72, 1268, 430, 60, "Learning Outcome Metrics", "follow-up correctness | fewer guidance steps | failure pattern resolved\nlatency | confidence | rubric score", C.green, "#ffffff", { titleSize: 15, bodySize: 10 });
  lineLabel(a, 948, 1136, 340, "6. Candidate strategy evaluated before promotion", C.greenDark, 13);

  lane(
    a,
    45,
    1395,
    1880,
    250,
    "6. MEMORY, DEPLOYMENT, OBSERVABILITY, AND PROOF",
    C.purple,
    C.purpleBg,
    "GCP for one-week prototype speed. AWS target remains explicit for production story.",
  );
  card(a, 82, 1478, 300, 72, "Memory + Replay Data", "Qdrant vector memory\nCloud SQL Postgres now / Aurora or RDS later\nCloud Storage now / S3 later", C.purple, "#ffffff", { fileId: "file_qdrant", iconSize: 42, titleSize: 15, bodySize: 10 });
  card(a, 420, 1478, 330, 72, "Container Deploy", "GCP Cloud Run now / ECS-Fargate later\nArtifact Registry -> ECR\nSecret Manager -> AWS Secrets Manager", C.blue, "#ffffff", { fileId: "file_docker", iconSize: 42, titleSize: 15, bodySize: 10 });
  card(a, 788, 1478, 300, 72, "Cloud Logging + Monitoring", "now: Cloud Logging / Monitoring / Trace\nlater: CloudWatch + OTel", C.purple, "#ffffff", { fileId: "file_cloudwatch", iconSize: 42, titleSize: 15, bodySize: 10 });
  card(a, 1126, 1462, 310, 100, "Dashboard Proof", "live transcript\nfailure mode detected\nstrategy selected\neval before/after\npromoted version + rollback state", C.green, "#ffffff", { fileId: "file_grafana", iconSize: 42, titleSize: 15, bodySize: 10 });
  card(a, 1475, 1448, 365, 124, "Cloud-portable deployment path", "Cloud Run -> ECS Fargate / App Runner\nCloud SQL -> RDS / Aurora\nMemorystore -> ElastiCache / MemoryDB\nCloud Storage -> S3\nLogging/Monitoring -> CloudWatch + OTel", C.purple, "#ffffff", { titleSize: 16, bodySize: 11 });

  rect(a, 45, 1680, 1880, 80, C.gray, C.grayBg, { strokeWidth: 2, strokeStyle: "dashed" });
  text(a, 70, 1702, 940, "Hybrid-cloud rule: realtime voice path stays colocated.\nAsync eval/replay workers can run cross-cloud because they do not block live coding assistance.", 14, C.gray, { align: "left" });
  text(a, 1090, 1700, 720, "Legend: red solid = synchronous realtime | blue dashed = async events\ngreen = eval-gated promotion | gray dotted = fallback/rollback", 14, C.gray, { align: "left" });
  text(a, 1090, 1728, 720, "Daily = realtime voice | Cekura = eval/monitor/replay | NVIDIA = model runtime | GCP now -> AWS later", 14, C.gray, { align: "left" });

  return a;
}

function buildTechnicalAppendix() {
  counter = 0;
  const a = [];
  text(a, 55, 34, 970, "Agentic Coding Technical Appendix: Node-Level Prototype Architecture", 36, C.ink, { align: "left" });
  text(a, 60, 82, 1270, "Detailed implementation view: Redis shards/streams, event contracts, deployment options, retry/DLQ, model runtimes, and data stores.", 17, C.muted, { align: "left" });

  lane(a, 45, 130, 1880, 210, "A. USER + EDGE NODES", C.orange, C.orangeBg, "Browser and phone sessions route into one colocated realtime pipeline.");
  card(a, 88, 212, 230, 80, "Browser Client", "React + WebRTC\nlocal VAD", C.orange, "#ffffff", { fileId: "file_browser", iconSize: 40 });
  card(a, 350, 212, 230, 80, "Phone Client", "Twilio PSTN/SIP\nstreaming audio", C.orange, "#ffffff", { fileId: "file_mic", iconSize: 40 });
  card(a, 622, 205, 280, 94, "Ingress Router", "Daily / Twilio tokens\nCloud Run API", C.orange, "#ffffff", { fileId: "file_gateway", iconSize: 42 });
  card(a, 945, 205, 320, 94, "GCP Edge Option", "Cloud Load Balancing only if needed\nAWS target: ALB/NLB + Route 53 + GA", C.blue, "#ffffff", { fileId: "file_nlb", iconSize: 42, titleSize: 15, bodySize: 10 });
  card(a, 1308, 205, 470, 94, "Colocation Rule", "Keep WebRTC/Twilio, Pipecat, ASR, LLM, and TTS in the same low-latency region.\nAsync eval/replay can move across clouds.", C.red, "#ffffff", { titleSize: 16, bodySize: 11 });
  arrow(a, 318, 252, [[0, 0], [32, 0]], C.red, { strokeWidth: 4 });
  arrow(a, 580, 252, [[0, 0], [42, 0]], C.red, { strokeWidth: 4 });

  lane(a, 45, 370, 1880, 260, "B. REALTIME VOICE CONTAINER POOL", C.red, C.redBg, "Prototype Voice Services: Cloud Run / Compute Engine containers. AWS target: ECS/Fargate or EC2 ASG.");
  for (let i = 0; i < 3; i += 1) {
    const x = 88 + i * 350;
    card(a, x, 462, 305, 96, `Voice Service Node ${i + 1}`, "Pipecat worker\nbarge-in controller\nsession state cache", C.red, "#ffffff", { fileId: "file_pipecat", iconSize: 42, titleSize: 16, bodySize: 11 });
  }
  card(a, 1165, 430, 170, 130, "ASR", "streaming\nRiva optional", C.redDark, "#ffffff", { fileId: "file_asr", iconSize: 44 });
  card(a, 1375, 430, 210, 130, "Coding Agent LLM", "fast NIM API\nself-host later", C.redDark, "#ffffff", { fileId: "file_vllm", iconSize: 44 });
  card(a, 1625, 430, 170, 130, "TTS", "streaming\nfallback cache", C.redDark, "#ffffff", { fileId: "file_tts", iconSize: 44 });
  arrow(a, 1030, 510, [[0, 0], [135, 0]], C.red, { strokeWidth: 5 });
  arrow(a, 1335, 495, [[0, 0], [40, 0]], C.red, { strokeWidth: 5 });
  arrow(a, 1585, 495, [[0, 0], [40, 0]], C.red, { strokeWidth: 5 });
  lineLabel(a, 1180, 580, 600, "Synchronous media path; trace latency, dropped turns, interruption success.", C.red, 13);

  lane(a, 45, 660, 1880, 250, "C. REDIS STREAMS + HOT CONTEXT PLANE", C.blue, C.blueBg, "GCP now: Memorystore Redis or Upstash Redis. AWS later: ElastiCache Redis / MemoryDB.");
  card(a, 90, 745, 260, 86, "Stream Shard A", "transcript.final\nclient_signal.detected", C.blue, "#ffffff", { fileId: "file_redis", iconSize: 38 });
  card(a, 390, 745, 260, 86, "Stream Shard B", "failure_mode.detected\nstrategy.failed", C.blue, "#ffffff", { fileId: "file_redis", iconSize: 38 });
  card(a, 690, 745, 260, 86, "Stream Shard C", "eval_case.generated\nstrategy.promoted", C.blue, "#ffffff", { fileId: "file_redis", iconSize: 38 });
  card(a, 1010, 733, 300, 110, "Hot Context Cache", "session context\ndeveloper learning state\nactive strategy", C.blue, "#ffffff", { fileId: "file_cache", iconSize: 42 });
  card(a, 1365, 733, 230, 110, "Retry + DLQ", "dead letters\nidempotency keys\nbackoff", C.blue, "#ffffff", { fileId: "file_dlq", iconSize: 42 });
  card(a, 1645, 733, 230, 110, "Command Stream", "scip.action_selected\nstrategy.rollback", C.blue, "#ffffff", { fileId: "file_dlq", iconSize: 42 });
  arrow(a, 240, 630, [[0, 0], [0, 115]], C.blue, { strokeStyle: "dashed", strokeWidth: 3 });
  arrow(a, 1160, 733, [[0, 0], [-255, -173]], C.green, { strokeStyle: "dashed", strokeWidth: 4 });

  lane(a, 45, 940, 1880, 260, "D. ASYNC AGENT WORKER NODE POOL", C.teal, C.tealBg, "Worker replicas consume Redis Streams through consumer groups and publish typed events back.");
  for (let i = 0; i < 3; i += 1) {
    const x = 90 + i * 580;
    card(a, x, 1028, 510, 96, `Async Agent Node ${i + 1}`, "Developer State | Failure Mode | RAG | Similar Developer | SCIP | Eval Generation | Auto-Improvement", C.teal, "#ffffff", { fileId: "file_worker", iconSize: 46, titleSize: 17, bodySize: 11 });
    arrow(a, x + 250, 910, [[0, 0], [0, 118]], C.blue, { strokeStyle: "dashed", strokeWidth: 3 });
    arrow(a, x + 280, 1028, [[0, 0], [0, -118]], C.blue, { strokeStyle: "dashed", strokeWidth: 2, endArrowhead: null });
  }
  card(a, 90, 1140, 340, 40, "HTTP: /internal/turns/plan", "low-latency assistant action request", C.gray, "#ffffff", { titleSize: 13, bodySize: 10 });
  card(a, 465, 1140, 340, 40, "Event Envelope", "event_id, session_id, schema_version, idempotency_key", C.gray, "#ffffff", { titleSize: 13, bodySize: 10 });
  card(a, 840, 1140, 340, 40, "Promotion API", "POST /internal/strategies/promote", C.gray, "#ffffff", { titleSize: 13, bodySize: 10 });

  lane(a, 45, 1230, 1880, 300, "E. MEMORY, MODEL RUNTIME, AND EVAL DATA", C.purple, C.purpleBg, "Durable stores and heavy model calls are outside the live voice path unless latency tests pass.");
  card(a, 90, 1324, 270, 92, "Qdrant Vector DB", "codebase knowledge\nfailure patterns\ndeveloper memory\nstrategy outcomes", C.purple, "#ffffff", { fileId: "file_qdrant", iconSize: 44 });
  card(a, 395, 1324, 290, 92, "Cassandra / Keyspaces Ring", "cohort patterns\nfailure mode counters\nlow-latency reads", C.purple, "#ffffff", { fileId: "file_redis", iconSize: 44 });
  card(a, 720, 1324, 280, 92, "Cloud SQL Postgres", "strategy registry\nsession metadata\neval results\nAWS: RDS/Aurora", C.blue, "#ffffff", { fileId: "file_aurora", iconSize: 44 });
  card(a, 1035, 1324, 260, 92, "Cloud Storage", "audio snippets\nfailure traces\nreplay artifacts\nAWS: S3", C.gray, "#ffffff", { fileId: "file_s3", iconSize: 44 });
  card(a, 1330, 1324, 250, 92, "NVIDIA Runtime", "NIM LLM\nNeMo Retriever\nRiva later", C.red, "#ffffff", { fileId: "file_vllm", iconSize: 44 });
  card(a, 1615, 1324, 260, 92, "Eval Runner", "simulation\nbaseline compare\nrollback on regression", C.green, "#ffffff", { fileId: "file_eval", iconSize: 44 });
  arrow(a, 1445, 1200, [[0, 0], [0, 124]], C.green, { strokeStyle: "dashed", strokeWidth: 3 });

  lane(a, 45, 1560, 1880, 255, "F. DEPLOYMENT + OBSERVABILITY", C.gray, C.grayBg, "Container Deploy: GCP Cloud Run now / ECS-Fargate later.");
  card(a, 90, 1650, 300, 86, "GCP Prototype", "Cloud Run | Artifact Registry | Cloud Build/GitHub Actions | Secret Manager", C.blue, "#ffffff", { fileId: "file_docker", iconSize: 44 });
  card(a, 430, 1650, 320, 86, "AWS Production Target", "ECS Fargate/App Runner | ECR | RDS/Aurora | S3 | ElastiCache", C.purple, "#ffffff", { fileId: "file_docker", iconSize: 44 });
  card(a, 790, 1650, 330, 86, "Observability", "Cloud Logging + Monitoring now\nCloudWatch + OTel later\nlatency + eval regression alerts", C.gray, "#ffffff", { fileId: "file_cloudwatch", iconSize: 44 });
  card(a, 1160, 1650, 300, 86, "Dashboard Proof", "transcript | failure mode | strategy | eval before/after | promoted version", C.green, "#ffffff", { fileId: "file_grafana", iconSize: 44 });
  card(a, 1500, 1650, 320, 86, "Rollback Guard", "candidate rejected unless replay eval beats baseline and monitoring stays healthy", C.green, "#ffffff", { fileId: "file_gate", iconSize: 44 });

  return a;
}

writeDoc(judgeOut, judgeClip, buildJudgeDiagram());
writeDoc(appendixOut, appendixClip, buildTechnicalAppendix());
