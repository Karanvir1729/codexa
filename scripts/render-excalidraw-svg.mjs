import fs from "node:fs";
import path from "node:path";

const [input, svgOut, htmlOut] = process.argv.slice(2);
if (!input || !svgOut) {
  console.error("Usage: node scripts/render-excalidraw-svg.mjs input.excalidraw output.svg [output.html]");
  process.exit(1);
}

const doc = JSON.parse(fs.readFileSync(input, "utf8"));
const elements = (doc.elements ?? []).filter((e) => !e.isDeleted);
const files = doc.files ?? {};

const escapeXml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function elementBounds(e) {
  if (e.type === "arrow" || e.type === "line") {
    const xs = e.points.map((p) => e.x + p[0]);
    const ys = e.points.map((p) => e.y + p[1]);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }
  return {
    minX: e.x,
    minY: e.y,
    maxX: e.x + (e.width ?? 0),
    maxY: e.y + (e.height ?? 0),
  };
}

const bounds = elements.reduce(
  (acc, e) => {
    const b = elementBounds(e);
    acc.minX = Math.min(acc.minX, b.minX);
    acc.minY = Math.min(acc.minY, b.minY);
    acc.maxX = Math.max(acc.maxX, b.maxX);
    acc.maxY = Math.max(acc.maxY, b.maxY);
    return acc;
  },
  { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
);

const pad = 35;
const viewX = Math.floor(bounds.minX - pad);
const viewY = Math.floor(bounds.minY - pad);
const viewW = Math.ceil(bounds.maxX - bounds.minX + pad * 2);
const viewH = Math.ceil(bounds.maxY - bounds.minY + pad * 2);

const colors = [...new Set(elements.filter((e) => e.type === "arrow" || e.type === "line").map((e) => e.strokeColor ?? "#111827"))];
const defs = colors
  .map((c) => {
    const id = `arrow-${c.replace(/[^a-zA-Z0-9]/g, "")}`;
    return `<marker id="${id}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="${escapeXml(c)}"/></marker>`;
  })
  .join("");

function dash(e) {
  if (e.strokeStyle === "dashed") return ' stroke-dasharray="10 8"';
  if (e.strokeStyle === "dotted") return ' stroke-dasharray="3 8" stroke-linecap="round"';
  return "";
}

function marker(e) {
  if (!e.endArrowhead) return "";
  const id = `arrow-${(e.strokeColor ?? "#111827").replace(/[^a-zA-Z0-9]/g, "")}`;
  return ` marker-end="url(#${id})"`;
}

function renderText(e) {
  const fontSize = e.fontSize ?? 18;
  const lineHeight = e.lineHeight ?? 1.15;
  const lines = String(e.text ?? "").split("\n");
  const anchor = e.textAlign === "left" ? "start" : e.textAlign === "right" ? "end" : "middle";
  const x = e.textAlign === "left" ? e.x : e.textAlign === "right" ? e.x + e.width : e.x + e.width / 2;
  const y = e.y + fontSize;
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : fontSize * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");
  return `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="600" fill="${escapeXml(e.strokeColor ?? "#111827")}" text-anchor="${anchor}">${tspans}</text>`;
}

function render(e) {
  if (e.type === "rectangle") {
    const rx = e.roundness ? 12 : 0;
    return `<rect x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" rx="${rx}" fill="${escapeXml(e.backgroundColor ?? "transparent")}" stroke="${escapeXml(e.strokeColor ?? "#111827")}" stroke-width="${e.strokeWidth ?? 2}"${dash(e)} />`;
  }
  if (e.type === "text") return renderText(e);
  if (e.type === "image") {
    const data = files[e.fileId]?.dataURL;
    if (!data) return "";
    return `<image x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" href="${escapeXml(data)}"/>`;
  }
  if (e.type === "arrow" || e.type === "line") {
    const points = e.points.map((p) => `${e.x + p[0]},${e.y + p[1]}`).join(" ");
    return `<polyline points="${points}" fill="none" stroke="${escapeXml(e.strokeColor ?? "#111827")}" stroke-width="${e.strokeWidth ?? 2}"${dash(e)}${marker(e)} />`;
  }
  return "";
}

const svg = `<!doctype svg>
<svg xmlns="http://www.w3.org/2000/svg" width="${viewW}" height="${viewH}" viewBox="${viewX} ${viewY} ${viewW} ${viewH}">
<defs>${defs}</defs>
<rect x="${viewX}" y="${viewY}" width="${viewW}" height="${viewH}" fill="#fff"/>
${elements.map(render).join("\n")}
</svg>
`;

fs.mkdirSync(path.dirname(svgOut), { recursive: true });
fs.writeFileSync(svgOut, svg);
if (htmlOut) {
  fs.writeFileSync(htmlOut, `<!doctype html><html><body style="margin:0;background:white">${svg}</body></html>`);
}
console.log(`Rendered ${svgOut}`);
