import fs from "node:fs";

const sourcePath = "docs/architecture/agentic-coding-feedback-state-machine.excalidraw";
const outPath = "docs/architecture/agentic-coding-node-level-architecture.excalidraw";
const clipPath = "docs/architecture/agentic-coding-node-level-architecture.clipboard.json";

const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const files = source.files ?? {};

let counter = 0;
const uid = (prefix) => `${prefix}_${String(++counter).padStart(4, "0")}`;

const C = {
  ink: "#111827",
  muted: "#475569",
  red: "#dc2626",
  redBg: "#fff1f2",
  blue: "#2563eb",
  blueBg: "#eff6ff",
  green: "#16a34a",
  greenDark: "#166534",
  greenBg: "#ecfdf5",
  orange: "#ea580c",
  orangeBg: "#fff7ed",
  teal: "#0f766e",
  tealBg: "#f0fdfa",
  sky: "#0284c7",
  skyBg: "#f0f9ff",
  purple: "#7c3aed",
  purpleBg: "#f5f3ff",
  gray: "#64748b",
  grayBg: "#f8fafc",
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
    seed: 300000 + counter,
    version: 1,
    versionNonce: 900000 + counter,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
}

function rect(x, y, w, h, stroke, bg, opts = {}) {
  return el("rectangle", x, y, w, h, {
    strokeColor: stroke,
    backgroundColor: bg,
    strokeWidth: opts.strokeWidth ?? 3,
    strokeStyle: opts.strokeStyle ?? "solid",
    roundness: { type: opts.roundness ?? 3 },
  });
}

function text(x, y, w, value, size = 18, color = C.ink, opts = {}) {
  const lines = String(value).split("\n").length;
  const lineHeight = opts.lineHeight ?? 1.15;
  return el("text", x, y, w, Math.ceil(size * lineHeight * lines), {
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
  return el("image", x, y, size, size, {
    strokeColor: "transparent",
    backgroundColor: "transparent",
    strokeWidth: 1,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
  });
}

function arrow(x, y, points, color, opts = {}) {
  return el("arrow", x, y, 0, 0, {
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

function lane(a, x, y, w, h, title, stroke, bg, subtitle = "") {
  a.push(rect(x, y, w, h, stroke, bg, { strokeStyle: "dashed", strokeWidth: 3 }));
  a.push(text(x + 24, y + 20, w - 48, title, 27, stroke, { align: "left" }));
  if (subtitle) a.push(text(x + 24, y + 55, w - 48, subtitle, 15, stroke, { align: "left" }));
}

function card(a, x, y, w, h, title, body, stroke, bg = "#ffffff", opts = {}) {
  a.push(rect(x, y, w, h, stroke, bg, { strokeWidth: opts.strokeWidth ?? 2 }));
  if (opts.fileId) a.push(image(x + 18, y + 20, opts.iconSize ?? 44, opts.fileId));
  const tx = opts.fileId ? x + 74 : x + 16;
  const tw = opts.fileId ? w - 92 : w - 32;
  a.push(text(tx, y + 15, tw, title, opts.titleSize ?? 17, stroke, { align: "left" }));
  if (body) a.push(text(tx, y + 47, tw, body, opts.bodySize ?? 13, opts.bodyColor ?? C.ink, { align: "left", lineHeight: 1.15 }));
}

function smallService(a, x, y, w, fileId, title, body, color) {
  a.push(image(x + (w - 42) / 2, y, 42, fileId));
  a.push(text(x, y + 48, w, title, 14, color));
  if (body) a.push(text(x, y + 70, w, body, 11, C.muted));
}

function stateBox(a, x, y, w, h, title, body) {
  a.push(rect(x, y, w, h, C.green, "#ffffff", { strokeWidth: 3 }));
  a.push(text(x + 10, y + 12, w - 20, title, 16, C.greenDark));
  if (body) a.push(text(x + 12, y + 52, w - 24, body, 12, C.greenDark));
}

function label(a, x, y, w, value, color, size = 13, opts = {}) {
  a.push(text(x, y, w, value, size, color, opts));
}

const a = [];

// Title.
a.push(text(60, 34, 980, "Agentic Coding Voice Agent", 46, C.ink, { align: "left" }));
a.push(text(65, 92, 820, "Fast live coding assistance + async eval-gated strategy promotion.", 22, "#334155", { align: "left" }));
card(a, 995, 34, 170, 76, "Daily", "WebRTC voice\nturn-taking", C.orange, "#ffffff", { fileId: "file_mic", iconSize: 32, titleSize: 15, bodySize: 10 });
card(a, 1180, 34, 170, 76, "Cekura", "replay evals\nregression gates", C.green, "#ffffff", { fileId: "file_eval", iconSize: 32, titleSize: 15, bodySize: 10 });
card(a, 1365, 34, 170, 76, "NVIDIA", "NIM APIs now\nGPU later", C.red, "#ffffff", { fileId: "file_vllm", iconSize: 32, titleSize: 15, bodySize: 10 });
card(a, 1550, 34, 170, 76, "GCP now", "Cloud Run\nprototype", C.blue, "#ffffff", { fileId: "file_cloudwatch", iconSize: 32, titleSize: 15, bodySize: 10 });
card(a, 1735, 34, 170, 76, "AWS target", "ECS/RDS/S3\nproduction", C.purple, "#ffffff", { fileId: "file_docker", iconSize: 32, titleSize: 15, bodySize: 10 });

// Layer 1.
lane(a, 45, 145, 1880, 210, "1. USER DEVICE + DAILY / TWILIO INGRESS", C.orange, C.orangeBg, "Two entry paths: browser sessions use WebRTC/Daily; phone-based coding assistance uses Twilio. Both stay colocated with the same realtime voice pipeline.");
card(a, 75, 225, 185, 90, "React Client", "coding UI\ndeveloper profile", C.orange, "#ffffff", { fileId: "file_browser" });
card(a, 285, 225, 185, 90, "WebRTC Mic", "Daily media\nlow jitter", C.orange, "#ffffff", { fileId: "file_mic" });
card(a, 495, 225, 230, 90, "Local Signal Models", "VAD | interruption\noptional failure pattern", C.orange, "#ffffff", { fileId: "file_webgpu" });
card(a, 750, 225, 185, 90, "Phrase Cache", "TTS fallback\nsafe prompts", C.orange, "#ffffff", { fileId: "file_localcache" });

card(a, 960, 225, 110, 90, "Twilio", "PSTN/SIP\nphone", C.orange, "#ffffff", { fileId: "file_mic", iconSize: 34, titleSize: 14, bodySize: 11 });
card(a, 1110, 225, 165, 90, "Cloud LB", "optional\nAPI/frontend", "#b45309", "#ffffff", { fileId: "file_gateway", iconSize: 34, titleSize: 14, bodySize: 11 });
card(a, 1320, 225, 210, 90, "Session Router", "stickiness\nassigned voice node", "#b45309", "#ffffff", { fileId: "file_gateway" });
card(a, 1560, 225, 150, 90, "GCP Events", "client signal\ningress", C.blue, "#ffffff", { fileId: "file_dlq", iconSize: 34, titleSize: 14, bodySize: 11 });
card(a, 1735, 225, 150, 90, "AWS Target", "ALB/NLB\nRoute 53 + GA", C.purple, "#ffffff", { fileId: "file_cloudwatch", iconSize: 34, titleSize: 14, bodySize: 10 });

// Layer 2.
lane(a, 45, 385, 1880, 270, "2. LOW-LATENCY REALTIME VOICE LAYER: DAILY / PIPECAT / TWILIO", C.red, C.redBg, "Do not split this path across clouds: Developer -> WebRTC/Twilio -> Pipecat -> ASR -> LLM -> TTS -> Developer.");
card(a, 85, 465, 270, 120, "Pipecat Voice Pool", "colocated media workers\nWebRTC + PSTN ingress", C.red, "#ffffff", { fileId: "file_pipecat", iconSize: 54, titleSize: 19 });
card(a, 385, 465, 250, 120, "Barge-in + Interrupts", "local VAD + Riva EOU\ncancel LLM/TTS stream", C.red, "#ffffff", { fileId: "file_mic", iconSize: 54, titleSize: 19 });
card(a, 665, 465, 245, 120, "Session State", "current concept\ntask confidence\nactive failure pattern\nguidance history", C.blue, "#ffffff", { fileId: "file_cache", iconSize: 54, titleSize: 19 });
card(a, 940, 465, 270, 120, "Active Coding\nStrategy Cache", "promoted strategy only\nfast Redis lookup", C.green, "#ffffff", { fileId: "file_cache", iconSize: 54, titleSize: 19 });

card(a, 1260, 450, 170, 145, "ASR", "NVIDIA Riva\nor hosted API", "#991b1b", "#ffffff", { fileId: "file_asr", titleSize: 18 });
card(a, 1450, 450, 190, 145, "LLM/VLM", "NVIDIA NIM API\nself-host later", "#991b1b", "#ffffff", { fileId: "file_vllm", titleSize: 18 });
card(a, 1660, 450, 170, 145, "TTS", "Riva / hosted API\nstreaming audio", "#991b1b", "#ffffff", { fileId: "file_tts", titleSize: 18 });
label(a, 1260, 410, 620, "NVIDIA-hosted NIM APIs first; self-hosted NIM/Riva on GPU later", "#991b1b", 17, { align: "left" });

a.push(rect(75, 598, 1050, 52, C.red, "#ffffff", { strokeWidth: 2 }));
a.push(text(92, 606, 160, "Deploy at Scale", 14, C.red, { align: "left" }));
a.push(text(238, 604, 860, "Pipecat/Daily realtime orchestration + Twilio telephony for browser and phone-based coding assistance.\nOne pipeline: WebRTC/Twilio -> Pipecat -> ASR -> LLM -> TTS; barge-in, fallback routing, latency/dropped-turn telemetry.", 11, C.ink, { align: "left", lineHeight: 1.12 }));

// Critical red path.
a.push(arrow(220, 315, [[0, 0], [0, 75], [-20, 0], [0, 72]], C.red, { strokeWidth: 5 }));
a.push(arrow(1012, 315, [[0, 0], [0, 50], [-760, 0], [0, 100]], C.red, { strokeWidth: 4 }));
label(a, 80, 360, 280, "Browser/WebRTC developer session", C.red, 13, { align: "left" });
label(a, 770, 360, 260, "Phone call via Twilio telephony", C.red, 13, { align: "left" });
a.push(arrow(330, 525, [[0, 0], [55, 0]], C.red, { strokeWidth: 5 }));
a.push(arrow(635, 525, [[0, 0], [30, 0]], C.red, { strokeWidth: 5 }));
a.push(arrow(910, 525, [[0, 0], [30, 0]], C.red, { strokeWidth: 5 }));
a.push(arrow(1210, 525, [[0, 0], [50, 0]], C.red, { strokeWidth: 5 }));
a.push(arrow(1430, 525, [[0, 0], [20, 0]], C.red, { strokeWidth: 5 }));
a.push(arrow(1640, 525, [[0, 0], [20, 0]], C.red, { strokeWidth: 5 }));
label(a, 1370, 620, 480, "spoken response streams back over the same WebRTC session", C.red, 15, { align: "left" });
a.push(arrow(845, 315, [[0, 0], [0, 62], [-300, 0], [0, 88]], C.blue, { strokeStyle: "dashed", strokeWidth: 3 }));
label(a, 500, 365, 280, "client_signal.detected", C.blue, 13);
a.push(arrow(1770, 595, [[0, 0], [0, 35], [-1530, 0], [0, -315]], C.gray, { strokeStyle: "dotted", strokeWidth: 3 }));
label(a, 1170, 640, 330, "fallback routing: cached phrase or alternate TTS", C.gray, 13);

// Redis event plane.
a.push(rect(45, 690, 1880, 115, C.blue, C.blueBg, { strokeStyle: "dashed", strokeWidth: 3 }));
a.push(text(70, 715, 740, "REDIS ON GCP MEMORystore NOW -> AWS ELASTICACHE LATER", 21, C.blue, { align: "left" }));
a.push(text(840, 718, 780, "Events: transcript.final | failure_mode.detected | strategy.failed | eval_case.generated | strategy.promoted | strategy.rollback", 14, C.blue, { align: "left" }));
card(a, 80, 750, 250, 42, "Memorystore Redis", "streams + hot context", C.blue, "#ffffff", { fileId: "file_redis", iconSize: 30, titleSize: 14, bodySize: 11 });
card(a, 365, 750, 230, 42, "Retry / DLQ", "idempotency keys", C.blue, "#ffffff", { fileId: "file_dlq", iconSize: 30, titleSize: 14, bodySize: 11 });
card(a, 1570, 745, 285, 50, "Active Coding Strategy Cache", "only promoted versions", C.green, "#ffffff", { fileId: "file_cache", iconSize: 34, titleSize: 14, bodySize: 11 });
a.push(arrow(800, 585, [[0, 0], [0, 105]], C.blue, { strokeStyle: "dashed", strokeWidth: 3 }));
label(a, 820, 660, 260, "transcript + voice telemetry", C.blue, 12, { align: "left" });
a.push(arrow(1705, 745, [[0, 0], [-590, -160]], C.green, { strokeStyle: "dashed", strokeWidth: 4 }));
label(a, 1230, 645, 300, "orchestrator reads active strategy", C.greenDark, 14, { align: "left" });

// Layer 3.
lane(a, 45, 835, 1880, 310, "3. HORIZONTALLY SCALED ASYNC LEARNING AGENTS", C.teal, C.tealBg, "Agents consume Redis Streams and write typed events back. They are not a direct chain.");
card(a, 90, 925, 330, 130, "Developer State Agent", "task confidence\nfailure pattern / failure mode detector\nconfusion + frustration signal", C.teal, "#ffffff", { fileId: "file_worker", iconSize: 52, titleSize: 19 });
card(a, 460, 925, 330, 130, "RAG Retrieval Agent", "NVIDIA embed/rerank\nsimilar failures\nconcept + failure mode memory", C.teal, "#ffffff", { fileId: "file_rag", iconSize: 52, titleSize: 19 });
card(a, 830, 925, 430, 130, "SCIP Optimization Layer", "selects guidance, analogy, quiz, retry with plan\nunder latency + confidence constraints", C.teal, "#ffffff", { fileId: "file_scip", iconSize: 52, titleSize: 18 });
card(a, 1300, 925, 285, 130, "Cekura Eval Worker", "simulation + replay\nbaseline comparison\nregression gate", C.green, "#ffffff", { fileId: "file_eval", iconSize: 52, titleSize: 18 });
card(a, 1615, 915, 250, 150, "Dashboard Proof", "eval result\nregression status\npromoted version\nrollback state", C.purple, "#ffffff", { fileId: "file_grafana", iconSize: 50, titleSize: 19 });

const agentCenters = [255, 625, 1045, 1442];
for (const cx of agentCenters) {
  a.push(arrow(cx, 805, [[0, 0], [0, 120]], C.blue, { strokeStyle: "dashed", strokeWidth: 3 }));
  a.push(arrow(cx + 28, 925, [[0, 0], [0, -120]], C.blue, { strokeStyle: "dashed", strokeWidth: 2, endArrowhead: null }));
}
label(a, 105, 1080, 300, "developer_state.updated", C.blue, 13, { align: "left" });
label(a, 485, 1080, 300, "similar_failure.retrieved", C.blue, 13, { align: "left" });
label(a, 845, 1080, 330, "scip.action_selected", C.teal, 13, { align: "left" });
label(a, 1318, 1080, 250, "promotion.decision", C.greenDark, 13, { align: "left" });

// Layer 4: central loop.
lane(a, 45, 1185, 1880, 325, "4. CEKURA-STYLE SELF-IMPROVEMENT LOOP: Failure -> Promoted Coding Strategy", C.green, C.greenBg, "Simulation, replay, regression testing, monitoring, and gated promotion. The assistant improves by promoting tested strategy versions, not by live fine-tuning.");
const stateY = 1275;
const stateW = 205;
const stateGap = 22;
const states = [
  ["Observed Failure", "transcript + trace"],
  ["Failure Mode Classified", "failure-mode tag"],
  ["Candidate Strategy", "prompt/tool policy"],
  ["Replay Eval Generated", "Cekura scenario"],
  ["Tested Against Baseline", "old vs new"],
  ["Promoted Strategy", "Cloud SQL version"],
  ["Active Strategy Cache", "Redis hot path"],
  ["Next Similar Session", "better explanation"],
];
for (let i = 0; i < states.length; i += 1) {
  const x = 80 + i * (stateW + stateGap);
  stateBox(a, x, stateY, stateW, 96, states[i][0], states[i][1]);
  if (i < states.length - 1) {
    a.push(arrow(x + stateW, stateY + 48, [[0, 0], [stateGap, 0]], C.green, { strokeWidth: 5 }));
  }
}
a.push(rect(1000, 1410, 360, 54, C.gray, "#ffffff", { strokeWidth: 3 }));
a.push(text(1018, 1424, 328, "Failed Eval / Regression Detected\nRejected or Rolled Back", 15, C.gray));
a.push(arrow(1145, stateY + 96, [[0, 0], [0, 39]], C.gray, { strokeStyle: "dotted", strokeWidth: 4 }));
a.push(arrow(1000, 1437, [[0, 0], [-445, 0], [0, -74]], C.gray, { strokeStyle: "dotted", strokeWidth: 3 }));
label(a, 620, 1418, 250, "strategy.rollback", C.gray, 13);

card(a, 70, 1400, 375, 82, "Learning Outcome Metrics", "follow-up answer correctness | fewer guidance steps | failure pattern resolved\nlower latency | higher confidence | better rubric score", C.green, "#ffffff", { titleSize: 17, bodySize: 12 });
a.push(arrow(1715, stateY, [[0, 0], [0, -480]], C.green, { strokeWidth: 5 }));
label(a, 1730, 1070, 150, "only passing\nstrategies affect\nlive coding assistance", C.greenDark, 14, { align: "left" });

// Layer 5.
lane(a, 45, 1545, 1880, 300, "5. GCP PROTOTYPE CONTROL PLANE + AWS PRODUCTION TARGET", C.sky, C.skyBg, "Prototype can run on GCP for speed. Production target maps to AWS. Realtime voice stays colocated; async eval/replay can run in either cloud.");
card(a, 75, 1630, 235, 92, "Prototype Deploy:\nGCP Cloud Run", "backend API\ndashboard API\nasync workers\nAWS: ECS/Fargate", C.sky, "#ffffff", { fileId: "file_docker", iconSize: 42, titleSize: 15, bodySize: 10 });
card(a, 335, 1630, 210, 92, "Artifact Registry\n+ Cloud Build", "containers + CI/CD\nAWS: ECR/CodeBuild", C.sky, "#ffffff", { fileId: "file_docker", iconSize: 42, titleSize: 15, bodySize: 10 });
card(a, 570, 1630, 220, 92, "Cloud SQL Postgres", "strategies, sessions,\neval results\nAWS: RDS/Aurora", C.blue, "#ffffff", { fileId: "file_aurora", iconSize: 42, titleSize: 16, bodySize: 10 });
card(a, 815, 1630, 205, 92, "Cloud Storage", "replay traces\naudio snippets\neval artifacts\nAWS: S3", C.gray, "#ffffff", { fileId: "file_s3", iconSize: 42, titleSize: 16, bodySize: 10 });
card(a, 1045, 1630, 205, 92, "Secret Manager", "API keys\nservice config\nAWS: Secrets/SSM", C.teal, "#ffffff", { fileId: "file_key", iconSize: 42, titleSize: 16, bodySize: 10 });
card(a, 1275, 1630, 250, 92, "Cloud Logging /\nMonitoring / Trace", "latency, errors,\nworker telemetry\nAWS: CloudWatch/X-Ray", C.purple, "#ffffff", { fileId: "file_cloudwatch", iconSize: 42, titleSize: 15, bodySize: 10 });
card(a, 1550, 1630, 300, 92, "Vertex AI / NVIDIA NIM\nExperiments", "not blocking realtime unless latency passes\nAWS: Bedrock/SageMaker/GPU EC2", C.red, "#ffffff", { fileId: "file_vllm", iconSize: 42, titleSize: 15, bodySize: 10 });
card(a, 75, 1742, 600, 90, "AWS Production Target Map", "Cloud Run -> ECS/App Runner\nMemorystore -> ElastiCache/MemoryDB\nCloud SQL -> RDS/Aurora", C.purple, "#ffffff", { titleSize: 15, bodySize: 10 });
card(a, 700, 1742, 600, 90, "Storage + Observability Target", "Cloud Storage -> S3\nLogs/Trace -> CloudWatch/X-Ray/OTel\nSecrets -> Secrets Manager / Parameter Store", C.purple, "#ffffff", { titleSize: 15, bodySize: 10 });
card(a, 1325, 1742, 525, 90, "Realtime Placement Rule", "Do not split live voice across clouds.\nKeep WebRTC/Twilio, Pipecat, ASR, LLM, and TTS colocated.", C.red, "#ffffff", { titleSize: 15, bodySize: 10 });

// Main-diagram legend and note.
a.push(rect(45, 1875, 1880, 92, C.gray, C.grayBg, { strokeStyle: "dashed", strokeWidth: 3 }));
a.push(text(70, 1898, 1020, "Hybrid-cloud note: GCP prototype for speed; AWS target for production. Realtime voice stays colocated.", 16, C.gray, { align: "left" }));
a.push(text(70, 1928, 1050, "Async eval/replay workers can move clouds because they do not block live coding assistance.", 15, C.gray, { align: "left" }));
a.push(text(1135, 1898, 720, "Legend: red = realtime | blue dashed = async event/data | green = eval-gated promotion | gray dotted = fallback/rollback", 14, C.gray, { align: "left" }));
a.push(text(1135, 1928, 720, "Daily + Twilio = voice ingress | Cekura = eval loop | NVIDIA = model runtime | GCP now -> AWS target", 14, C.gray, { align: "left" }));

const doc = {
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: a,
  appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
  files,
};

fs.writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
fs.writeFileSync(clipPath, `${JSON.stringify({ type: "excalidraw/clipboard", elements: a, files }, null, 2)}\n`);
console.log(`Wrote ${outPath} with ${a.length} elements`);
