const dom = {
  runQuickBtn: document.querySelector("#runQuickBtn"),
  runPhoneBtn: document.querySelector("#runPhoneBtn"),
  runOpenClawBtn: document.querySelector("#runOpenClawBtn"),
  runFullBtn: document.querySelector("#runFullBtn"),
  latestStatus: document.querySelector("#latestStatus"),
  latestMeta: document.querySelector("#latestMeta"),
  passRate: document.querySelector("#passRate"),
  passMeta: document.querySelector("#passMeta"),
  activeRun: document.querySelector("#activeRun"),
  activeMeta: document.querySelector("#activeMeta"),
  updatedAt: document.querySelector("#updatedAt"),
  suiteList: document.querySelector("#suiteList"),
  parsedResults: document.querySelector("#parsedResults"),
  historyList: document.querySelector("#historyList"),
};

const quickSuites = ["preflight", "eval", "api", "ui", "bench"];
const phoneSuites = ["phone"];
const openClawSuites = ["openclaw"];
const fullSuites = ["preflight", "eval", "api", "ui", "bench", "phone", "openclaw", "acoustic"];

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "--";
  if (ms < 1000) return `${ms} ms`;
  return `${Math.round(ms / 100) / 10}s`;
}

function statusClass(status) {
  return ["passed", "failed", "running", "pending", "skipped"].includes(status) ? status : "pending";
}

function renderLatest(payload) {
  const latest = payload.latest;
  const active = payload.active;

  dom.activeRun.textContent = active ? "Running" : "Idle";
  dom.activeMeta.textContent = active ? `${active.id} started ${new Date(active.startedAt).toLocaleTimeString()}` : "No active test process.";
  dom.runQuickBtn.disabled = Boolean(active);
  dom.runPhoneBtn.disabled = Boolean(active);
  dom.runOpenClawBtn.disabled = Boolean(active);
  dom.runFullBtn.disabled = Boolean(active);

  if (!latest) {
    dom.latestStatus.textContent = "No run yet";
    dom.latestMeta.textContent = "Run a quick suite to generate confidence data.";
    dom.passRate.textContent = "--";
    dom.passMeta.textContent = "No suites completed.";
    dom.updatedAt.textContent = "Not loaded.";
    dom.suiteList.innerHTML = '<div class="suite"><strong>No suites yet</strong><span>Run a suite from the top-right controls.</span></div>';
    dom.parsedResults.textContent = "No parsed results yet.";
    return;
  }

  const summary = latest.summary || {};
  const completed = Number(summary.passed || 0) + Number(summary.failed || 0) + Number(summary.skipped || 0);
  const rate = completed ? Math.round((Number(summary.passed || 0) / completed) * 100) : 0;

  dom.latestStatus.textContent = latest.status || "unknown";
  dom.latestMeta.textContent = `${latest.id} | ${formatDuration(latest.durationMs)} | ${latest.finishedAt ? new Date(latest.finishedAt).toLocaleString() : "in progress"}`;
  dom.passRate.textContent = completed ? `${rate}%` : "--";
  dom.passMeta.textContent = `${summary.passed || 0} passed, ${summary.failed || 0} failed, ${summary.skipped || 0} skipped`;
  dom.updatedAt.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  dom.suiteList.innerHTML = (latest.suites || [])
    .map((suite) => `
      <div class="suite">
        <span class="pill ${statusClass(suite.status)}">${suite.status}</span>
        <div>
          <strong>${suite.name}</strong>
          <small>${suite.category} | ${suite.required ? "required" : "optional"}</small>
        </div>
        <span>${formatDuration(suite.durationMs)}</span>
        <small>${suite.exitCode === null || suite.exitCode === undefined ? "--" : `exit ${suite.exitCode}`}</small>
      </div>
    `)
    .join("");

  const parsedSuites = (latest.suites || [])
    .filter((suite) => suite.parsed)
    .map((suite) => ({
      suite: suite.id,
      status: suite.status,
      parsed: suite.parsed,
    }));
  const failedLogs = (latest.suites || [])
    .filter((suite) => suite.status === "failed")
    .map((suite) => ({
      suite: suite.id,
      stderr: suite.stderr,
      stdout: suite.stdout,
    }));
  dom.parsedResults.textContent = JSON.stringify(parsedSuites.length ? parsedSuites : failedLogs, null, 2);
}

function renderHistory(history) {
  if (!history.length) {
    dom.historyList.innerHTML = '<div class="history-item">No run history yet.</div>';
    return;
  }
  dom.historyList.innerHTML = history
    .slice(0, 10)
    .map((run) => `
      <div class="history-item">
        <strong>${run.status} | ${run.id}</strong>
        <span>${run.summary?.passed || 0}/${run.summary?.total || 0} passed | ${formatDuration(run.durationMs)}</span><br />
        <small>${run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "in progress"}</small>
      </div>
    `)
    .join("");
}

async function refresh() {
  const [latestResponse, historyResponse] = await Promise.all([
    fetch("/api/test-runs/latest"),
    fetch("/api/test-runs/history"),
  ]);
  renderLatest(await latestResponse.json());
  renderHistory((await historyResponse.json()).history || []);
}

async function startRun(suites) {
  const response = await fetch("/api/test-runs/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suites }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Run failed to start: ${response.status}`);
  }
  await refresh();
}

dom.runQuickBtn.addEventListener("click", async () => {
  try {
    await startRun(quickSuites);
  } catch (error) {
    dom.parsedResults.textContent = error instanceof Error ? error.message : String(error);
  }
});

dom.runPhoneBtn.addEventListener("click", async () => {
  try {
    await startRun(phoneSuites);
  } catch (error) {
    dom.parsedResults.textContent = error instanceof Error ? error.message : String(error);
  }
});

dom.runOpenClawBtn.addEventListener("click", async () => {
  try {
    await startRun(openClawSuites);
  } catch (error) {
    dom.parsedResults.textContent = error instanceof Error ? error.message : String(error);
  }
});

dom.runFullBtn.addEventListener("click", async () => {
  try {
    await startRun(fullSuites);
  } catch (error) {
    dom.parsedResults.textContent = error instanceof Error ? error.message : String(error);
  }
});

refresh().catch((error) => {
  dom.parsedResults.textContent = error instanceof Error ? error.message : String(error);
});
setInterval(refresh, 2500);
