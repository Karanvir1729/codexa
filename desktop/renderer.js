const state = {
  enabled: false,
  sessions: [],
  currentSession: null,
  messages: [],
  sending: false,
};

const dom = {
  connectionLabel: document.querySelector("#connectionLabel"),
  enableBtn: document.querySelector("#enableBtn"),
  linkCodexBtn: document.querySelector("#linkCodexBtn"),
  permissionsBtn: document.querySelector("#permissionsBtn"),
  newChatBtn: document.querySelector("#newChatBtn"),
  projectList: document.querySelector("#projectList"),
  chatTitle: document.querySelector("#chatTitle"),
  messages: document.querySelector("#messages"),
  input: document.querySelector("#input"),
  sendBtn: document.querySelector("#sendBtn"),
  statusBtn: document.querySelector("#statusBtn"),
  openCodexBtn: document.querySelector("#openCodexBtn"),
  infoBtn: document.querySelector("#infoBtn"),
  infoDialog: document.querySelector("#infoDialog"),
  closeInfoBtn: document.querySelector("#closeInfoBtn"),
  permissionsDialog: document.querySelector("#permissionsDialog"),
  closePermissionsBtn: document.querySelector("#closePermissionsBtn"),
};

function compact(value, fallback = "Untitled") {
  const text = String(value || fallback).replace(/\s+/g, " ").trim() || fallback;
  return text.length > 44 ? `${text.slice(0, 41)}...` : text;
}

function groupSessions(sessions) {
  return sessions.reduce((groups, session) => {
    const project = session.projectName || "Current project";
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(session);
    return groups;
  }, new Map());
}

function setConnection(text, enabled = state.enabled) {
  state.enabled = enabled;
  dom.connectionLabel.textContent = text;
  dom.enableBtn.textContent = enabled ? "Enabled" : "Enable";
  dom.enableBtn.classList.toggle("on", enabled);
}

function renderSessions() {
  const groups = groupSessions(state.sessions);
  if (!groups.size) {
    dom.projectList.innerHTML = `<p class="empty">No chats.</p>`;
    return;
  }

  dom.projectList.innerHTML = [...groups.entries()]
    .map(([project, sessions]) => {
      const buttons = sessions
        .map((session, index) => {
          const active = session.id === state.currentSession?.id ? " active" : "";
          return `<button class="chat-button${active}" data-session-id="${escapeHtml(session.id)}">
            <span class="chat-name">${escapeHtml(compact(session.title || "Untitled chat"))}</span>
            <span class="chat-count">⌘${index + 1}</span>
          </button>`;
        })
        .join("");
      return `<section class="project-group">
        <h3 class="project-title">${escapeHtml(compact(project, "Project"))}</h3>
        ${buttons}
      </section>`;
    })
    .join("");
}

function renderMessages() {
  dom.chatTitle.textContent = state.currentSession
    ? `${state.currentSession.projectName || "Project"} / ${state.currentSession.title || "Chat"}`
    : "Pick chat.";

  if (!state.currentSession && !state.messages.length) {
    dom.messages.innerHTML = `<p class="empty">Pick chat.</p>`;
    return;
  }

  dom.messages.innerHTML = state.messages
    .filter((message) => ["user", "assistant", "status"].includes(message.role))
    .map((message) => `<div class="message ${message.role}">${escapeHtml(message.content || "")}</div>`)
    .join("");
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function refreshSessions() {
  const result = await window.assistant.listSessions();
  state.sessions = result.sessions || [];
  renderSessions();
}

async function enable() {
  setConnection("Starting...");
  const result = await window.assistant.enable();
  state.sessions = result.sessions || [];
  setConnection(result.codexStatus?.available ? "Codex connected" : "Codex unavailable", true);
  renderSessions();
  if (!state.currentSession && state.sessions[0]) await loadSession(state.sessions[0].id);
}

async function linkCodex() {
  if (!state.enabled) await enable();
  dom.linkCodexBtn.disabled = true;
  dom.linkCodexBtn.textContent = "Linking...";
  try {
    const result = await window.assistant.linkCodex();
    setConnection(result.ok ? "Codex linked" : result.message, state.enabled);
    pushMessage("status", result.ok ? "Codex linked." : result.message);
    await refreshSessions();
  } finally {
    dom.linkCodexBtn.disabled = false;
    dom.linkCodexBtn.textContent = "Link Codex";
  }
}

async function loadSession(sessionId) {
  const result = await window.assistant.loadSession(sessionId);
  if (!result?.session) return;
  state.currentSession = result.session;
  state.messages = (result.session.messages || []).filter((message) => ["user", "assistant"].includes(message.role));
  renderSessions();
  renderMessages();
}

async function newSession() {
  const result = await window.assistant.newSession({ title: "Codexa chat" });
  state.currentSession = result.session;
  state.messages = [];
  await refreshSessions();
  renderMessages();
  dom.input.focus();
}

function pushMessage(role, content) {
  state.messages.push({ role, content });
  renderMessages();
}

async function sendText(text, extraContext = null) {
  if (!text.trim() || state.sending) return;
  if (!state.enabled) await enable();
  state.sending = true;
  dom.sendBtn.disabled = true;
  dom.input.disabled = true;
  const priorMessages = state.messages.filter((message) => ["user", "assistant"].includes(message.role));
  pushMessage("user", text);
  const conversation = [...priorMessages, { role: "user", content: text }];
  const assistant = { role: "assistant", content: "" };
  state.messages.push(assistant);
  renderMessages();

  try {
    const messages = extraContext
      ? [{ role: "system", content: `Computer status snapshot:\n${JSON.stringify(extraContext, null, 2)}` }, ...conversation]
      : conversation;
    const result = await window.assistant.send({
      sessionId: state.currentSession?.id || null,
      text,
      messages,
    });
    state.currentSession = result.session;
    assistant.content = result.text || assistant.content || "Done.";
    await refreshSessions();
  } catch (error) {
    assistant.content = error instanceof Error ? error.message : String(error);
  } finally {
    state.sending = false;
    dom.sendBtn.disabled = false;
    dom.input.disabled = false;
    dom.input.value = "";
    renderMessages();
    dom.input.focus();
  }
}

async function computerStatus() {
  if (!state.enabled) await enable();
  const status = await window.assistant.systemStatus();
  const summary = [
    `${status.machine.hostname} · ${status.machine.platform}`,
    `Uptime ${status.machine.uptime} · load ${status.machine.loadAverage.join(", ")}`,
    `Memory ${status.machine.memory.freeGb} GB free of ${status.machine.memory.totalGb} GB`,
    status.machine.disk ? `Disk ${status.machine.disk.capacity} used, ${status.machine.disk.available} free` : null,
    status.machine.frontmostApp ? `Front app ${status.machine.frontmostApp}` : null,
    `Repo ${status.repo.dirtyFiles ? `${status.repo.dirtyFiles} changed file(s)` : "clean"}`,
  ].filter(Boolean).join("\n");
  pushMessage("status", summary);
  await sendText("Give me a concise status update for this computer.", status);
}

window.assistant.onEvent((event) => {
  if (event.type === "status" && event.text) setConnection(event.text, true);
  if (event.type === "token") {
    const last = state.messages[state.messages.length - 1];
    if (last?.role === "assistant") {
      last.content += event.text;
      renderMessages();
    }
  }
});

dom.enableBtn.addEventListener("click", () => enable().catch((error) => setConnection(error.message || "Failed", false)));
dom.linkCodexBtn.addEventListener("click", () => linkCodex().catch((error) => pushMessage("status", error.message)));
dom.permissionsBtn.addEventListener("click", () => dom.permissionsDialog.showModal());
dom.newChatBtn.addEventListener("click", () => newSession().catch((error) => pushMessage("status", error.message)));
dom.projectList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-session-id]");
  if (!button) return;
  loadSession(button.dataset.sessionId).catch((error) => pushMessage("status", error.message));
});
dom.sendBtn.addEventListener("click", () => sendText(dom.input.value));
dom.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendText(dom.input.value);
  }
});
dom.statusBtn.addEventListener("click", () => computerStatus().catch((error) => pushMessage("status", error.message)));
dom.openCodexBtn.addEventListener("click", () => window.assistant.openCodex());
dom.infoBtn.addEventListener("click", () => dom.infoDialog.showModal());
dom.closeInfoBtn.addEventListener("click", () => dom.infoDialog.close());
dom.closePermissionsBtn.addEventListener("click", () => dom.permissionsDialog.close());
dom.permissionsDialog.addEventListener("click", (event) => {
  const button = event.target.closest("[data-permission]");
  if (!button) return;
  window.assistant.openPermission(button.dataset.permission);
});

enable().catch(() => {
  setConnection("Off", false);
  renderSessions();
  renderMessages();
});
