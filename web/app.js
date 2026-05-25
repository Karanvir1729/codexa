const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const dom = {
  startBtn: document.querySelector("#startBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  interruptBtn: document.querySelector("#interruptBtn"),
  agentState: document.querySelector("#agentState"),
  providerState: document.querySelector("#providerState"),
  liveTranscript: document.querySelector("#liveTranscript"),
  turnState: document.querySelector("#turnState"),
  messages: document.querySelector("#messages"),
  textForm: document.querySelector("#textForm"),
  textInput: document.querySelector("#textInput"),
  micMeter: document.querySelector("#micMeter"),
  vadState: document.querySelector("#vadState"),
  autoSpeakToggle: document.querySelector("#autoSpeakToggle"),
  speechIntentToggle: document.querySelector("#speechIntentToggle"),
  codexPilotToggle: document.querySelector("#codexPilotToggle"),
  codexControlProvider: document.querySelector("#codexControlProvider"),
  flowCleanupLevel: document.querySelector("#flowCleanupLevel"),
  flowWritingStyle: document.querySelector("#flowWritingStyle"),
  flowLanguage: document.querySelector("#flowLanguage"),
  flowDictionary: document.querySelector("#flowDictionary"),
  flowSnippets: document.querySelector("#flowSnippets"),
  flowState: document.querySelector("#flowState"),
  flowHistory: document.querySelector("#flowHistory"),
  codexPilotState: document.querySelector("#codexPilotState"),
  rateSlider: document.querySelector("#rateSlider"),
  sttProvider: document.querySelector("#sttProvider"),
  ttsProvider: document.querySelector("#ttsProvider"),
  userProfile: document.querySelector("#userProfile"),
  userProfileName: document.querySelector("#userProfileName"),
  systemPrompt: document.querySelector("#systemPrompt"),
  projectMode: document.querySelector("#projectMode"),
  projectSelect: document.querySelector("#projectSelect"),
  projectName: document.querySelector("#projectName"),
  sessionSelect: document.querySelector("#sessionSelect"),
  chatTitle: document.querySelector("#chatTitle"),
  loadSessionBtn: document.querySelector("#loadSessionBtn"),
  newSessionBtn: document.querySelector("#newSessionBtn"),
  sessionState: document.querySelector("#sessionState"),
  sessionHistoryList: document.querySelector("#sessionHistoryList"),
  speakerGuardState: document.querySelector("#speakerGuardState"),
  latencyLog: document.querySelector("#latencyLog"),
};

const state = {
  active: false,
  listening: false,
  speaking: false,
  thinking: false,
  interrupted: false,
  transcriptBuffer: "",
  interimTranscript: "",
  messages: [],
  recognition: null,
  recognitionRestartTimer: null,
  turnTimer: null,
  abortController: null,
  micStream: null,
  audioContext: null,
  analyser: null,
  vadFrames: 0,
  quietFrames: 0,
  micVoiceActive: false,
  lastMicVoiceAt: 0,
  lastMicQuietAt: 0,
  voiceRunStartedAt: 0,
  quietRunStartedAt: performance.now(),
  lastRms: 0,
  currentAssistantEl: null,
  currentAssistantText: "",
  currentSpokenText: "",
  recentSpokenText: "",
  lastSpeechEndedAt: 0,
  lastSubmittedUserText: "",
  lastSubmittedAt: 0,
  speakQueue: [],
  speakingUtterance: null,
  ttsBuffer: "",
  ignoreRecognitionUntil: 0,
  ttsAbortController: null,
  audioElement: null,
  bargeInPaused: false,
  bargeInPausedAt: 0,
  bargeInPausedProvider: null,
  currentMetrics: null,
  mediaRecorder: null,
  recordedChunks: [],
  recordingStartedAt: 0,
  recordingMeta: null,
  serverSttInFlight: false,
  speakerGuardAvailable: true,
  userVoiceEnrolled: false,
  assistantVoiceEnrolled: false,
  speakerGuardInFlight: false,
  lastSpeakerDecision: null,
  speakerProfiles: {},
  speechStartWaiter: false,
  assistantSpeechStartedAt: 0,
  assistantTurnInterrupted: false,
  turnTakingProfile: null,
  currentUserId: "user_a",
  speechHistory: [],
  sessions: [],
  projects: ["Current repo"],
  currentSessionId: null,
  currentSessionSummary: null,
};

const TURN_CAPTURE = {
  startVoiceFrames: 4,
  bargeInStartVoiceFrames: 3,
  normalMinMs: 1400,
  normalSilenceMs: 1800,
  normalMaxMs: 45000,
  bargeInMinMs: 900,
  bargeInSilenceMs: 950,
  bargeInMaxMs: 9000,
  assistantStartSilenceMs: 950,
  maxAssistantWaitMs: 9000,
  feedbackWindowMs: 5000,
};

const voiceTestHarness = {
  setSpeakerIdentityAvailable(value) {
    state.speakerGuardAvailable = Boolean(value);
    setSpeakerGuard(state.speakerGuardAvailable ? "test: speaker identity enabled" : "test: speaker identity disabled");
  },
  getSnapshot() {
    return {
      active: state.active,
      speaking: state.speaking,
      thinking: state.thinking,
      bargeInPaused: state.bargeInPaused,
      micVoiceActive: state.micVoiceActive,
      speakerGuardAvailable: state.speakerGuardAvailable,
      currentUserId: state.currentUserId,
      turnTakingProfile: state.turnTakingProfile,
      lastSpeakerDecision: state.lastSpeakerDecision,
    };
  },
};
window.__agenticCodingVoiceTest = voiceTestHarness;

function bargeInEnabled() {
  return false;
}

function setInterruptControlDisabled(disabled) {
  if (dom.interruptBtn) dom.interruptBtn.disabled = disabled;
}

function setAgentState(label, kind = "") {
  dom.agentState.textContent = label;
  dom.agentState.className = `state-pill ${kind}`;
}

function setTurn(text) {
  dom.turnState.textContent = text;
}

function setSpeakerGuard(text) {
  if (dom.speakerGuardState) dom.speakerGuardState.textContent = text;
}

function activeUserId() {
  const raw = dom.userProfile?.value || "user_a";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "user_a";
}

function activeUserName() {
  return (dom.userProfileName?.value || activeUserId().replace(/_/g, " ")).trim();
}

function compactTitle(value, fallback = "Untitled chat") {
  const text = String(value || fallback).replace(/\s+/g, " ").trim() || fallback;
  return text.length > 58 ? `${text.slice(0, 55)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function selectedProjectName() {
  if (dom.projectMode?.value === "new_project") {
    return (dom.projectName?.value || "New project").trim() || "New project";
  }
  return (dom.projectSelect?.value || dom.projectName?.value || "Current repo").trim() || "Current repo";
}

function sessionLabel(session) {
  const updated = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "not saved";
  const turns = Number(session.turnCount || 0);
  return `${session.title || "Untitled chat"} | ${session.projectName || "No project"} | ${turns} turn${turns === 1 ? "" : "s"} | ${updated}`;
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${url} returned ${response.status}`);
  return body;
}

function conversationStorageKey(userId = activeUserId()) {
  return `agentic-coding:conversation:${userId}`;
}

function speechFlowStorageKey(userId = activeUserId()) {
  return `agentic-coding:speech-flow:${userId}`;
}

function speechHistoryStorageKey(userId = activeUserId()) {
  return `agentic-coding:speech-history:${userId}`;
}

function turnTakingStorageKey(userId = activeUserId()) {
  return `agentic-coding:turn-taking:${userId}`;
}

function turnTakingEventsKey(userId = activeUserId()) {
  return `agentic-coding:turn-taking-events:${userId}`;
}

function defaultTurnTakingProfile() {
  return {
    endSilenceMs: TURN_CAPTURE.normalSilenceMs,
    assistantStartSilenceMs: TURN_CAPTURE.assistantStartSilenceMs,
    interruptions: 0,
    earlyInterruptions: 0,
    completedAssistantTurns: 0,
    updatedAt: Date.now(),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadTurnTakingProfile(userId = activeUserId()) {
  try {
    const stored = localStorage.getItem(turnTakingStorageKey(userId));
    state.turnTakingProfile = {
      ...defaultTurnTakingProfile(),
      ...(stored ? JSON.parse(stored) : {}),
    };
  } catch {
    state.turnTakingProfile = defaultTurnTakingProfile();
  }
}

function saveTurnTakingProfile() {
  const profile = state.turnTakingProfile || defaultTurnTakingProfile();
  profile.updatedAt = Date.now();
  localStorage.setItem(turnTakingStorageKey(state.currentUserId), JSON.stringify(profile));
}

function saveTurnTakingEvent(event) {
  try {
    const key = turnTakingEventsKey(state.currentUserId);
    const stored = localStorage.getItem(key);
    const events = stored ? JSON.parse(stored) : [];
    events.push({ ts: Date.now(), ...event });
    localStorage.setItem(key, JSON.stringify(events.slice(-30)));
  } catch {
    // Turn-taking feedback is best-effort local learning.
  }
}

function parseArrowLines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [left, ...rightParts] = line.split(/\s*=>\s*/);
      const right = rightParts.join(" => ").trim();
      return { left: left?.trim() || "", right };
    })
    .filter((entry) => entry.left);
}

function defaultSpeechFlowConfig() {
  return {
    cleanupLevel: "high",
    writingStyle: "coding",
    languageHint: "auto",
    dictionaryText: dom.flowDictionary?.value || "",
    snippetsText: dom.flowSnippets?.value || "",
  };
}

function parseDictionaryConfig(value) {
  return parseArrowLines(value).map((entry) => {
    if (entry.right) {
      return {
        from: entry.left,
        to: entry.right,
        term: entry.right,
        starred: /!$/.test(entry.left),
      };
    }
    return {
      term: entry.left.replace(/!$/, ""),
      starred: /!$/.test(entry.left),
    };
  });
}

function parseSnippetConfig(value) {
  return parseArrowLines(value)
    .filter((entry) => entry.right)
    .map((entry) => ({ trigger: entry.left, text: entry.right }));
}

function getSpeechFlowConfig() {
  return {
    cleanupLevel: dom.flowCleanupLevel?.value || "high",
    writingStyle: dom.flowWritingStyle?.value || "coding",
    languageHint: dom.flowLanguage?.value || "auto",
    dictionary: parseDictionaryConfig(dom.flowDictionary?.value),
    snippets: parseSnippetConfig(dom.flowSnippets?.value),
  };
}

function saveSpeechFlowConfig() {
  const config = {
    cleanupLevel: dom.flowCleanupLevel?.value || "high",
    writingStyle: dom.flowWritingStyle?.value || "coding",
    languageHint: dom.flowLanguage?.value || "auto",
    dictionaryText: dom.flowDictionary?.value || "",
    snippetsText: dom.flowSnippets?.value || "",
  };
  localStorage.setItem(speechFlowStorageKey(state.currentUserId), JSON.stringify(config));
  renderFlowState();
}

function loadSpeechFlowConfig(userId = activeUserId()) {
  let config = defaultSpeechFlowConfig();
  try {
    const stored = localStorage.getItem(speechFlowStorageKey(userId));
    if (stored) config = { ...config, ...JSON.parse(stored) };
  } catch {
    // Keep defaults if saved config is corrupt.
  }
  if (dom.flowCleanupLevel) dom.flowCleanupLevel.value = config.cleanupLevel || "high";
  if (dom.flowWritingStyle) dom.flowWritingStyle.value = config.writingStyle || "coding";
  if (dom.flowLanguage) dom.flowLanguage.value = config.languageHint || "auto";
  if (dom.flowDictionary) dom.flowDictionary.value = config.dictionaryText || "";
  if (dom.flowSnippets) dom.flowSnippets.value = config.snippetsText || "";
  renderFlowState();
}

function loadSpeechHistory(userId = activeUserId()) {
  try {
    const stored = localStorage.getItem(speechHistoryStorageKey(userId));
    state.speechHistory = stored ? JSON.parse(stored).filter((item) => item?.cleaned || item?.raw) : [];
  } catch {
    state.speechHistory = [];
  }
  renderSpeechHistory();
}

function saveSpeechHistoryItem(item) {
  state.speechHistory.unshift({ ts: Date.now(), ...item });
  state.speechHistory = state.speechHistory.slice(0, 8);
  localStorage.setItem(speechHistoryStorageKey(state.currentUserId), JSON.stringify(state.speechHistory));
  renderSpeechHistory();
}

function renderFlowState(lastIntent = null) {
  if (!dom.flowState) return;
  const config = getSpeechFlowConfig();
  const dictionaryCount = config.dictionary.length;
  const snippetCount = config.snippets.length;
  const last = lastIntent
    ? ` Last: ${lastIntent.changed ? "cleaned" : "unchanged"} via ${lastIntent.mode || "rewrite"}.`
    : "";
  dom.flowState.textContent =
    `Cleanup ${config.cleanupLevel}; style ${config.writingStyle}; language ${config.languageHint}; ` +
    `${dictionaryCount} dictionary item${dictionaryCount === 1 ? "" : "s"}; ` +
    `${snippetCount} snippet${snippetCount === 1 ? "" : "s"}.${last}`;
}

function renderSpeechHistory() {
  if (!dom.flowHistory) return;
  if (!state.speechHistory.length) {
    dom.flowHistory.innerHTML = '<div class="history-item">No speech turns yet.</div>';
    return;
  }
  dom.flowHistory.innerHTML = state.speechHistory
    .slice(0, 5)
    .map((item) => {
      const cleaned = escapeHtml(item.cleaned || item.raw || "");
      const raw = escapeHtml(item.raw || "");
      const changed = item.changed ? "cleaned" : "raw";
      return `<div class="history-item"><strong>${changed}</strong>${cleaned}${item.changed ? `<br><span class="muted">Raw: ${raw}</span>` : ""}</div>`;
    })
    .join("");
}

function turnTakingProfile() {
  if (!state.turnTakingProfile) loadTurnTakingProfile(state.currentUserId);
  return state.turnTakingProfile || defaultTurnTakingProfile();
}

function getEndSilenceMs(isBargeIn = false) {
  if (isBargeIn) return TURN_CAPTURE.bargeInSilenceMs;
  return clamp(Number(turnTakingProfile().endSilenceMs || TURN_CAPTURE.normalSilenceMs), 1200, 3800);
}

function getAssistantStartSilenceMs() {
  return clamp(Number(turnTakingProfile().assistantStartSilenceMs || TURN_CAPTURE.assistantStartSilenceMs), 600, 2600);
}

function micQuietForMs(now = performance.now()) {
  if (state.micVoiceActive) return 0;
  return now - (state.lastMicVoiceAt || state.quietRunStartedAt || now);
}

function endOfTurnConfidence({ elapsed, silenceMs, isBargeIn }) {
  const requiredSilence = getEndSilenceMs(isBargeIn);
  const requiredMin = isBargeIn ? TURN_CAPTURE.bargeInMinMs : TURN_CAPTURE.normalMinMs;
  const silenceScore = clamp(silenceMs / requiredSilence, 0, 1);
  const durationScore = clamp(elapsed / requiredMin, 0, 1);
  return Math.round((silenceScore * 0.78 + durationScore * 0.22) * 100) / 100;
}

function recordTurnTakingInterruption(reason) {
  const profile = turnTakingProfile();
  const msSinceAssistantStart = state.assistantSpeechStartedAt
    ? Math.round(performance.now() - state.assistantSpeechStartedAt)
    : null;
  const early = msSinceAssistantStart !== null && msSinceAssistantStart < TURN_CAPTURE.feedbackWindowMs;

  profile.interruptions += 1;
  if (early) {
    profile.earlyInterruptions += 1;
    profile.endSilenceMs = clamp(profile.endSilenceMs + 260, 1200, 3800);
    profile.assistantStartSilenceMs = clamp(profile.assistantStartSilenceMs + 220, 600, 2600);
  } else {
    profile.assistantStartSilenceMs = clamp(profile.assistantStartSilenceMs + 80, 600, 2600);
  }
  saveTurnTakingProfile();
  saveTurnTakingEvent({
    type: "interruption",
    reason,
    early,
    msSinceAssistantStart,
    assistantTextChars: state.currentAssistantText.length,
    currentSpokenText: state.currentSpokenText.slice(0, 240),
    nextEndSilenceMs: profile.endSilenceMs,
    nextAssistantStartSilenceMs: profile.assistantStartSilenceMs,
  });
}

function recordAssistantCompleted() {
  if (state.assistantTurnInterrupted || !state.assistantSpeechStartedAt) return;
  const profile = turnTakingProfile();
  profile.completedAssistantTurns += 1;
  if (profile.completedAssistantTurns % 4 === 0 && profile.earlyInterruptions === 0) {
    profile.endSilenceMs = clamp(profile.endSilenceMs - 80, 1200, 3800);
    profile.assistantStartSilenceMs = clamp(profile.assistantStartSilenceMs - 60, 600, 2600);
  }
  saveTurnTakingProfile();
}

function saveUserConversation() {
  localStorage.setItem(conversationStorageKey(state.currentUserId), JSON.stringify(state.messages.slice(-24)));
}

function renderMessages() {
  dom.messages.innerHTML = "";
  if (state.currentSessionSummary) {
    addMessage(
      "system",
      `Active chat: ${state.currentSessionSummary.title || "Untitled chat"} | ${state.currentSessionSummary.projectName || "No project"}`,
    );
  } else {
    addMessage("system", "Choose an existing chat or start a new project chat before using the voice agent.");
  }
  for (const message of state.messages) addMessage(message.role, message.content);
}

function renderSessionUi() {
  if (!dom.sessionSelect) return;

  const projectNames = [...new Set(["Current repo", ...state.projects, ...state.sessions.map((session) => session.projectName).filter(Boolean)])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  dom.projectSelect.innerHTML = projectNames
    .map((project) => `<option value="${escapeHtml(project)}">${escapeHtml(project)}</option>`)
    .join("");
  const currentProject = selectedProjectName();
  if (projectNames.includes(currentProject)) dom.projectSelect.value = currentProject;

  const filteredSessions = state.sessions.filter((session) => {
    if (dom.projectMode?.value === "new_project") return true;
    return !currentProject || session.projectName === currentProject;
  });
  dom.sessionSelect.innerHTML = filteredSessions.length
    ? filteredSessions.map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(sessionLabel(session))}</option>`).join("")
    : '<option value="">No saved chats for this project</option>';
  if (state.currentSessionId && filteredSessions.some((session) => session.id === state.currentSessionId)) {
    dom.sessionSelect.value = state.currentSessionId;
  }
  dom.loadSessionBtn.disabled = !dom.sessionSelect.value;

  if (dom.projectMode?.value === "new_project") {
    dom.projectSelect.disabled = true;
    dom.projectName.disabled = false;
    if (!dom.projectName.value || dom.projectName.value === "Current repo") dom.projectName.value = "New project";
  } else {
    dom.projectSelect.disabled = false;
    dom.projectName.disabled = true;
    dom.projectName.value = dom.projectSelect.value || "Current repo";
  }

  if (state.currentSessionSummary) {
    dom.sessionState.textContent = `Working in ${state.currentSessionSummary.projectName}: ${state.currentSessionSummary.title}`;
  } else {
    dom.sessionState.textContent = "Pick an existing chat or start a new one.";
  }

  if (dom.sessionHistoryList) {
    dom.sessionHistoryList.innerHTML = state.sessions.length
      ? state.sessions
          .slice(0, 8)
          .map((session) => {
            const source = session.source === "phone_bridge" ? "phone" : session.source || "browser";
            const detail = session.lastUserText ? session.lastUserText : "No user turn saved yet.";
            return `<button type="button" class="history-item history-button" data-session-id="${escapeHtml(session.id)}">
              <strong>${escapeHtml(session.title || "Untitled chat")}</strong>
              <span>${escapeHtml(session.projectName || "No project")} · ${escapeHtml(source)} · ${session.turnCount || 0} turns</span>
              <span class="muted">${escapeHtml(compactTitle(detail, "No user turn saved yet."))}</span>
            </button>`;
          })
          .join("")
      : '<div class="history-item">No saved calls or chats yet.</div>';
  }
}

async function refreshSessions() {
  try {
    const data = await apiJson("/api/sessions");
    state.sessions = data.sessions || [];
    state.projects = data.projects || [];
    renderSessionUi();
  } catch (error) {
    if (dom.sessionState) dom.sessionState.textContent = `Session history unavailable: ${error.message}`;
  }
}

function sessionCreatePayload(source = "browser") {
  const projectName = selectedProjectName();
  const title = (dom.chatTitle?.value || "").trim() || `${projectName} voice chat`;
  return {
    projectMode: dom.projectMode?.value === "new_project" ? "new_project" : "existing_project",
    projectName,
    title,
    userId: state.currentUserId,
    userName: activeUserName(),
    source,
  };
}

async function createSession(source = "browser") {
  const data = await apiJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify(sessionCreatePayload(source)),
  });
  state.currentSessionId = data.session.id;
  state.currentSessionSummary = data.session;
  state.messages = [];
  saveUserConversation();
  dom.chatTitle.value = "";
  await refreshSessions();
  renderMessages();
  setTurn(`Chat ready: ${data.session.title}.`);
  return data.session;
}

async function loadSession(sessionId = dom.sessionSelect?.value) {
  if (!sessionId) return null;
  const data = await apiJson(`/api/sessions/${sessionId}`);
  state.currentSessionId = data.session.id;
  state.currentSessionSummary = data.session;
  state.messages = (data.session.messages || [])
    .filter((message) => ["user", "assistant", "system"].includes(message.role) && typeof message.content === "string")
    .map((message) => ({ role: message.role, content: message.content }));
  if (dom.projectMode) dom.projectMode.value = data.session.projectMode || "existing_project";
  if (dom.projectName) dom.projectName.value = data.session.projectName || "Current repo";
  if (dom.projectSelect) {
    dom.projectSelect.value = data.session.projectName || "Current repo";
    if (dom.projectSelect.value !== data.session.projectName) {
      state.projects = [...new Set([...state.projects, data.session.projectName].filter(Boolean))];
    }
  }
  renderMessages();
  await refreshSessions();
  setTurn(`Opened chat: ${data.session.title}.`);
  return data.session;
}

async function ensureActiveSession(source = "browser") {
  if (state.currentSessionId) return state.currentSessionSummary;
  return createSession(source);
}

function appendSessionMessage(role, content, meta = {}) {
  if (!state.currentSessionId || !content?.trim()) return Promise.resolve();
  return apiJson(`/api/sessions/${state.currentSessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      role,
      content,
      source: meta.source || "browser",
      route: meta.route || (useCodexPilot() ? "codex_pilot" : "assistant_llm"),
    }),
  })
    .then((data) => {
      state.currentSessionSummary = data.session;
      return refreshSessions();
    })
    .catch((error) => {
      if (dom.sessionState) dom.sessionState.textContent = `Session save failed: ${error.message}`;
    });
}

function loadUserConversation(userId = activeUserId()) {
  try {
    const stored = localStorage.getItem(conversationStorageKey(userId));
    state.messages = stored ? JSON.parse(stored).filter((m) => m?.role && typeof m.content === "string") : [];
  } catch {
    state.messages = [];
  }
}

function ensureUserProfileOption(profileId, profileName = profileId) {
  if (!dom.userProfile) return;
  const existing = [...dom.userProfile.options].find((option) => option.value === profileId);
  if (existing) {
    existing.textContent = profileName;
    return;
  }
  const option = document.createElement("option");
  option.value = profileId;
  option.textContent = profileName;
  dom.userProfile.appendChild(option);
}

function hasAnySpeakerProfile() {
  return Object.values(state.speakerProfiles).some((profile) => Number(profile?.samples ?? 0) > 0) || state.userVoiceEnrolled;
}

function hasActiveSpeakerProfile() {
  return Boolean(state.speakerProfiles[state.currentUserId]?.samples) || state.userVoiceEnrolled;
}

function updateActiveSpeakerState() {
  state.userVoiceEnrolled = Boolean(state.speakerProfiles[state.currentUserId]?.samples);
}

function activateUserProfile(profileId, profileName = profileId, opts = {}) {
  if (!profileId) return;
  saveUserConversation();
  ensureUserProfileOption(profileId, profileName);
  if (dom.userProfile) dom.userProfile.value = profileId;
  if (dom.userProfileName) dom.userProfileName.value = profileName;
  state.currentUserId = activeUserId();
  if (!state.currentSessionId) loadUserConversation(state.currentUserId);
  loadTurnTakingProfile(state.currentUserId);
  loadSpeechFlowConfig(state.currentUserId);
  loadSpeechHistory(state.currentUserId);
  if (!state.currentSessionId) renderMessages();
  updateActiveSpeakerState();
  const profile = state.speakerProfiles[state.currentUserId];
  if (profile?.samples) {
    setSpeakerGuard(`${profile.name || activeUserName()}: ${profile.samples} saved voice sample${profile.samples === 1 ? "" : "s"}`);
  } else {
    setSpeakerGuard(`profile ${state.currentUserId}: voiceprint will update on next spoken turn`);
  }
  if (opts.announce) {
    addMessage("system", `Speaker matched ${activeUserName()}; routed this turn to that user's memory.`);
  }
  renderSessionUi();
}

function selectedUserLabel() {
  return dom.userProfile?.selectedOptions?.[0]?.textContent?.trim() || activeUserName();
}

function switchUserProfile(event) {
  const profileId = activeUserId();
  const profileName =
    event?.target === dom.userProfileName
      ? activeUserName()
      : state.speakerProfiles[profileId]?.name || selectedUserLabel();
  activateUserProfile(profileId, profileName);
  loadSpeakerProfiles();
}

async function loadSpeakerProfiles() {
  if (!state.speakerGuardAvailable) return;
  try {
    const response = await fetch("/api/speaker/profiles");
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "speaker profiles unavailable");
    state.speakerProfiles = Object.fromEntries(
      (result.profiles || [])
        .filter((profile) => profile?.id)
        .map((profile) => [profile.id, profile]),
    );
    for (const profile of Object.values(state.speakerProfiles)) {
      ensureUserProfileOption(profile.id, profile.name || profile.id);
    }
    updateActiveSpeakerState();
    const active = state.speakerProfiles[state.currentUserId];
    if (active?.samples) {
      setSpeakerGuard(`${active.name || active.id}: ${active.samples} saved voice sample${active.samples === 1 ? "" : "s"}`);
    }
  } catch (error) {
    state.speakerGuardAvailable = false;
    setSpeakerGuard(`offline: ${error instanceof Error ? error.message : "speaker profile service failed"}`);
  }
}

function addMessage(role, content = "") {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.textContent = content;
  dom.messages.appendChild(el);
  dom.messages.scrollTop = dom.messages.scrollHeight;
  return el;
}

function appendMessage(el, text) {
  el.textContent += text;
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function supportsSpeechRecognition() {
  return Boolean(SpeechRecognition);
}

function useServerStt() {
  return dom.sttProvider?.value === "whisperx";
}

function useSpeechIntentRewrite() {
  return dom.speechIntentToggle?.checked !== false;
}

function useCodexPilot() {
  return Boolean(dom.codexPilotToggle?.checked);
}

function selectedControlProvider() {
  return dom.codexControlProvider?.value || "openclaw";
}

function selectedControlProviderLabel() {
  const value = selectedControlProvider();
  if (value === "openclaw") return "OpenClaw control plane";
  if (value === "auto") return "OpenClaw with Codex fallback";
  return "direct Codex CLI";
}

function compactWorkspacePath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const workspaceMarker = "/tmp/codex-workspaces/";
  const workspaceIndex = text.indexOf(workspaceMarker);
  if (workspaceIndex >= 0) return `tmp/codex-workspaces/${text.slice(workspaceIndex + workspaceMarker.length)}`;
  const repoMarker = "/tutor-tron-voice/";
  const repoIndex = text.indexOf(repoMarker);
  if (repoIndex >= 0) return text.slice(repoIndex + repoMarker.length);
  return text;
}

function setCodexPilotState(text) {
  if (dom.codexPilotState) dom.codexPilotState.textContent = text;
}

async function updateProviderStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (data.ttsProvider && dom.ttsProvider) dom.ttsProvider.value = data.ttsProvider;
    if (data.sttProvider && dom.sttProvider) dom.sttProvider.value = data.sttProvider;
    dom.providerState.textContent =
      `LLM: ${data.provider} / ${data.ollamaModel}; ` +
      `STT: ${data.sttProvider}; ` +
      `Intent: ${data.speechIntentMode || "rewrite"}; ` +
      `TTS: ${data.ttsProvider}${data.fishConfigured ? " / Fish ready" : " / Fish not configured"}; ` +
      `Codex: ${data.codexPilotAvailable ? "ready" : "unavailable"}; ` +
      `OpenClaw: ${data.openclawAvailable ? "ready" : "unavailable"}`;
    setCodexPilotState(
      data.codexPilotAvailable
        ? `Ready: ${selectedControlProviderLabel()}. Codex sandbox ${data.codexPilotSandbox || "workspace-write"}; OpenClaw ${data.openclawAvailable ? "available" : "unavailable"}.`
        : "Unavailable: install local Codex CLI with npm install, or set CODEX_PILOT_COMMAND.",
    );
  } catch {
    dom.providerState.textContent = "provider: server unavailable";
    setCodexPilotState("Unavailable: server status check failed.");
  }
}

function resetMetrics(inputText) {
  state.currentMetrics = {
    inputText,
    startedAt: performance.now(),
    firstTokenAt: null,
    firstSpeechAt: null,
    ttsProvider: dom.ttsProvider.value,
    sttProvider: dom.sttProvider.value,
    ttsChunks: [],
  };
  renderMetrics();
}

function renderMetrics() {
  const metrics = state.currentMetrics;
  if (!metrics) return;
  const elapsed = Math.round(performance.now() - metrics.startedAt);
  const firstToken = metrics.firstTokenAt ? `${Math.round(metrics.firstTokenAt - metrics.startedAt)} ms` : "--";
  const firstSpeech = metrics.firstSpeechAt ? `${Math.round(metrics.firstSpeechAt - metrics.startedAt)} ms` : "--";
  const lastTts = metrics.ttsChunks.at(-1);
  const ttsLabel = lastTts ? `${metrics.ttsProvider} (${lastTts.ms} ms)` : metrics.ttsProvider;
  const guard = state.lastSpeakerDecision
    ? `${state.lastSpeakerDecision.is_user ? "matched" : "blocked"} (${Math.round(((state.lastSpeakerDecision.profile_match?.similarity ?? state.lastSpeakerDecision.user_similarity) ?? 0) * 100) / 100})`
    : hasActiveSpeakerProfile()
      ? "profile saved"
      : "not enrolled";
  const turnTaking = `${Math.round(getEndSilenceMs())} ms end / ${Math.round(getAssistantStartSilenceMs())} ms speak`;

  dom.latencyLog.innerHTML = `
    <div><dt>Turn</dt><dd>${elapsed} ms</dd></div>
    <div><dt>First token</dt><dd>${firstToken}</dd></div>
    <div><dt>First speech</dt><dd>${firstSpeech}</dd></div>
    <div><dt>STT provider</dt><dd>${metrics.sttProvider}</dd></div>
    <div><dt>Speaker identity</dt><dd>${guard}</dd></div>
    <div><dt>Turn-taking</dt><dd>${turnTaking}</dd></div>
    <div><dt>TTS provider</dt><dd>${ttsLabel}</dd></div>
  `;
}

function updateLiveTranscript() {
  const joined = `${state.transcriptBuffer} ${state.interimTranscript}`.trim();
  dom.liveTranscript.textContent = joined || (useServerStt() ? "Listening for a turn..." : "Listening...");
}

function normalizeSpeechText(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function speechWords(value) {
  return normalizeSpeechText(value).split(" ").filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsSpeechPhrase(reference, candidate) {
  if (!candidate) return false;
  return new RegExp(`(?:^|\\s)${escapeRegExp(candidate)}(?:\\s|$)`).test(reference);
}

function hasInterruptIntent(value) {
  const text = normalizeSpeechText(value);
  return /\b(stop|wait|pause|hold on|hang on|actually|interrupt|let me|one second|i don t|i do not|i m confused|im confused|confused|that s wrong|thats wrong|wrong|can i ask|let me ask|assistant stop|coding agent stop)\b/.test(text);
}

function isPureInterruptCommand(value) {
  return /^(stop|wait|pause|hold on|hang on|one second|assistant stop|coding agent stop)$/.test(normalizeSpeechText(value));
}

function assistantEchoScore(value) {
  const candidate = normalizeSpeechText(value);
  if (!candidate) return 1;

  const words = speechWords(candidate);
  const reference = normalizeSpeechText(
    `${state.currentSpokenText} ${state.recentSpokenText} ${state.currentAssistantText.slice(-1800)}`,
  );
  if (!reference) return 0;
  if (containsSpeechPhrase(reference, candidate)) return 1;
  if (words.length < 3) return 0;

  const referenceWords = new Set(speechWords(reference));
  return words.filter((word) => referenceWords.has(word)).length / words.length;
}

function isLikelyAssistantEcho(value) {
  return assistantEchoScore(value) >= 0.58;
}

function isVerbalBargeIn(value, confidence = 0) {
  const words = speechWords(value);
  if (hasInterruptIntent(value) && assistantEchoScore(value) < 0.85) return true;

  return words.length >= 5 && confidence >= 0.55 && assistantEchoScore(value) < 0.28;
}

function cleanedBargeInText(value) {
  const phrases = [
    "coding agent stop",
    "assistant stop",
    "hold on",
    "hang on",
    "one second",
    "actually",
    "wait",
    "stop",
    "pause",
    "i don't",
    "i do not",
    "i'm confused",
    "im confused",
    "let me",
    "can i ask",
  ];
  const lowered = value.toLowerCase();
  const match = phrases
    .map((phrase) => ({ phrase, index: lowered.indexOf(phrase) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)[0];
  return match ? value.slice(match.index).trim() : value.trim();
}

async function initMicMeter() {
  if (state.micStream) return;
  state.micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(state.micStream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 1024;
  source.connect(state.analyser);
  tickMicMeter();
}

function tickMicMeter() {
  if (!state.analyser) return;

  const data = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  const rms = Math.sqrt(sum / data.length);
  const pct = Math.min(100, Math.round(rms * 420));
  dom.micMeter.style.width = `${pct}%`;

  const voiceThreshold = 0.034;
  const isVoice = rms > voiceThreshold;
  const now = performance.now();

  if (isVoice) {
    if (!state.micVoiceActive) state.voiceRunStartedAt = now;
    state.micVoiceActive = true;
    state.lastMicVoiceAt = now;
  } else {
    if (state.micVoiceActive) state.quietRunStartedAt = now;
    state.micVoiceActive = false;
    state.lastMicQuietAt = now;
  }
  state.lastRms = rms;

  const quietFor = micQuietForMs(now);
  dom.vadState.textContent = isVoice
    ? (state.speaking ? "assistant speaking" : "voice")
    : `quiet ${Math.max(0, Math.round(quietFor / 100) / 10)}s`;

  state.vadFrames = isVoice ? state.vadFrames + 1 : 0;
  state.quietFrames = isVoice ? 0 : state.quietFrames + 1;
  if (useServerStt() && state.active) handleServerSttVad(isVoice);

  requestAnimationFrame(tickMicMeter);
}

function supportedRecordingType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((type) => window.MediaRecorder?.isTypeSupported(type)) ?? "";
}

async function postSpeakerAudio(action, blob) {
  if (!state.speakerGuardAvailable || !blob?.size) return null;

  try {
    const response = await fetch(`/api/speaker/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": blob.type || "audio/webm",
        "X-Audio-Format": blob.type || "webm",
        "X-User-Id": activeUserId(),
        "X-User-Name": activeUserName(),
      },
      body: blob,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `speaker identity ${action} failed`);
    return result;
  } catch (error) {
    state.speakerGuardAvailable = false;
    setSpeakerGuard(`offline: ${error instanceof Error ? error.message : "speaker identity failed"}`);
    return null;
  }
}

async function resetSpeakerProfiles() {
  if (!state.speakerGuardAvailable) return;
  try {
    await fetch("/api/speaker/reset", { method: "POST" });
    state.userVoiceEnrolled = false;
    state.assistantVoiceEnrolled = false;
    state.lastSpeakerDecision = null;
    setSpeakerGuard("waiting for user voiceprint");
  } catch {
    state.speakerGuardAvailable = false;
    setSpeakerGuard("offline");
  }
}

function enrollUserVoice(blob) {
  if (!blob?.size || blob.size < 2000 || state.speakerGuardInFlight) return;
  state.speakerGuardInFlight = true;
  setSpeakerGuard(state.userVoiceEnrolled ? "updating user voiceprint..." : "enrolling user voiceprint...");
  postSpeakerAudio("enroll", blob)
    .then((result) => {
      if (!result) return;
      state.userVoiceEnrolled = true;
      const profile = result.persistent_profile;
      if (profile?.id) {
        state.speakerProfiles[profile.id] = profile;
        ensureUserProfileOption(profile.id, profile.name || profile.id);
      }
      setSpeakerGuard(
        profile
          ? `${profile.name}: ${profile.samples} voice sample${profile.samples === 1 ? "" : "s"} saved`
          : `user voiceprint: ${result.samples} sample${result.samples === 1 ? "" : "s"}`,
      );
    })
    .finally(() => {
      state.speakerGuardInFlight = false;
      renderMetrics();
    });
}

function enrollAssistantVoice(blob) {
  if (!blob?.size || blob.size < 2000 || !state.speakerGuardAvailable) return;
  postSpeakerAudio("enroll-assistant", blob).then((result) => {
    if (!result) return;
    state.assistantVoiceEnrolled = true;
    setSpeakerGuard(
      state.userVoiceEnrolled
        ? `user + assistant profiles ready`
        : `assistant profile: ${result.samples} sample${result.samples === 1 ? "" : "s"}`,
    );
  });
}

function classifyBargeInSpeaker(blob) {
  if (!state.speakerGuardAvailable || !blob?.size || !hasAnySpeakerProfile()) return Promise.resolve(null);
  setSpeakerGuard("classifying barge-in voice...");
  return postSpeakerAudio("classify", blob).then((result) => {
    if (!result) return null;
    state.lastSpeakerDecision = result;
    const profile = result.profile_match;
    setSpeakerGuard(
      result.is_user
        ? `barge-in accepted: ${(profile?.name || activeUserName())} ${Math.round(((profile?.similarity ?? result.user_similarity) ?? 0) * 100) / 100}`
        : `blocked likely assistant echo: ${result.reason}`,
    );
    renderMetrics();
    return result;
  });
}

function speakerGuardRejects(decision) {
  if (!decision || !hasAnySpeakerProfile()) return false;
  return !decision.is_user;
}

function pauseAssistantForBargeInCandidate() {
  if (state.bargeInPaused || !bargeInEnabled() || (!state.speaking && !state.speakingUtterance && !state.audioElement)) {
    return;
  }

  state.bargeInPaused = true;
  state.bargeInPausedAt = performance.now();
  state.bargeInPausedProvider = state.audioElement ? "remote" : "browser";

  if (state.audioElement && !state.audioElement.paused) {
    state.audioElement.pause();
  } else if (speechSynthesis.speaking && !speechSynthesis.paused) {
    speechSynthesis.pause();
  }

  setAgentState("Listening", "listening");
  setTurn("Paused assistant for possible interruption. Keep talking.");
}

function resumeAssistantAfterRejectedBargeIn(reason = "not user speech") {
  if (!state.bargeInPaused) return;

  state.bargeInPaused = false;
  state.bargeInPausedAt = 0;
  const provider = state.bargeInPausedProvider;
  state.bargeInPausedProvider = null;

  if (provider === "remote" && state.audioElement) {
    state.audioElement.play().catch(() => {
      setTurn("Assistant audio could not resume after rejected interruption.");
    });
  } else if (speechSynthesis.paused) {
    speechSynthesis.resume();
  }

  if (state.active && state.speaking) {
    setAgentState("Speaking", "speaking");
    setTurn(`Resuming assistant; interruption rejected (${reason}).`);
  }
}

function startTurnRecording(meta = {}) {
  if (!state.micStream || state.mediaRecorder || state.serverSttInFlight || !window.MediaRecorder) return;
  const mimeType = supportedRecordingType();
  const startedWhileSpeaking = state.speaking || state.thinking;
  state.recordedChunks = [];
  state.recordingStartedAt = performance.now();
  state.recordingMeta = {
    startedWhileSpeaking,
    ...meta,
  };

  try {
    state.mediaRecorder = new MediaRecorder(state.micStream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    setTurn(`Recorder unavailable: ${error.message}`);
    return;
  }

  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size) state.recordedChunks.push(event.data);
  };
  state.mediaRecorder.onstop = () => {
    const recordingDurationMs = Math.round(performance.now() - state.recordingStartedAt);
    const blob = new Blob(state.recordedChunks, { type: state.mediaRecorder?.mimeType || mimeType || "audio/webm" });
    const metaForTurn = { ...(state.recordingMeta ?? {}), recordingDurationMs };
    state.mediaRecorder = null;
    state.recordingMeta = null;
    state.recordedChunks = [];
    if (!state.active || metaForTurn.stopReason === "session stopped") return;
    transcribeRecordedTurn(blob, metaForTurn);
  };

  state.mediaRecorder.start(120);
  state.listening = true;
  if (meta.bargeIn && bargeInEnabled() && startedWhileSpeaking) {
    pauseAssistantForBargeInCandidate();
  } else {
    setTurn("Recording your turn...");
  }
}

function stopTurnRecording(reason) {
  if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") return;
  state.recordingMeta = { ...(state.recordingMeta ?? {}), stopReason: reason };
  state.mediaRecorder.stop();
}

function handleServerSttVad(isVoice) {
  if (!state.micStream || state.serverSttInFlight) return;
  const withinAssistantTail = Date.now() - state.lastSpeechEndedAt < 1600;
  if (state.speaking || state.thinking || state.speechStartWaiter || withinAssistantTail || Date.now() < state.ignoreRecognitionUntil) {
    return;
  }
  const recorderActive = Boolean(state.mediaRecorder);
  const elapsed = performance.now() - state.recordingStartedAt;
  const isBargeIn = false;
  const minMs = TURN_CAPTURE.normalMinMs;
  const maxMs = TURN_CAPTURE.normalMaxMs;
  const startFrames = TURN_CAPTURE.startVoiceFrames;
  const silenceMs = micQuietForMs();
  const turnEndConfidence = endOfTurnConfidence({ elapsed, silenceMs, isBargeIn });

  if (!recorderActive && isVoice && state.vadFrames >= startFrames) {
    startTurnRecording({ bargeIn: false });
    return;
  }

  if (recorderActive && !isVoice && elapsed >= minMs && turnEndConfidence >= 0.98) {
    stopTurnRecording("silence");
    return;
  }

  if (recorderActive && elapsed >= maxMs) {
    stopTurnRecording("max window");
  }
}

async function rewriteSpeechIntent(rawText, meta = {}) {
  const text = rawText.trim();
  if (!text || !useSpeechIntentRewrite()) {
    return { text, rawText: text, changed: false, mode: "raw" };
  }

  try {
    const response = await fetch("/api/speech-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rawText: text,
        mode: "rewrite",
        source: meta.source || dom.sttProvider.value,
        barge_in: Boolean(meta.bargeIn),
        user_id: state.currentUserId,
        user_name: activeUserName(),
        flow: getSpeechFlowConfig(),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `speech rewrite failed: ${response.status}`);
    return {
      text: String(result.text || text).trim() || text,
      rawText: text,
      changed: Boolean(result.changed),
      mode: result.mode || "rewrite",
      provider: result.provider,
      model: result.model,
      duration_ms: result.duration_ms,
      flow: result.flow,
    };
  } catch (error) {
    setTurn(`Speech cleanup unavailable; using raw transcript. ${error instanceof Error ? error.message : ""}`.trim());
    return { text, rawText: text, changed: false, mode: "fallback_raw" };
  }
}

function withTimeout(promise, ms, fallbackValue) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(fallbackValue), ms);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function submitSpeechTurn(rawText, meta = {}) {
  const trimmed = rawText.trim();
  if (!trimmed) return;

  setTurn(useSpeechIntentRewrite() ? "Structuring your speech into a clear request..." : "Sending transcript to assistant...");
  const intent = await rewriteSpeechIntent(trimmed, meta);
  const finalText = intent.text.trim() || trimmed;
  renderFlowState(intent);
  saveSpeechHistoryItem({
    raw: trimmed,
    cleaned: finalText,
    changed: intent.changed || finalText !== trimmed,
    mode: intent.mode,
    provider: intent.provider,
    dictionary_applied: intent.flow?.dictionary_applied || [],
    snippets_applied: intent.flow?.snippets_applied || [],
  });

  if (intent.changed) {
    state.transcriptBuffer = finalText;
    state.interimTranscript = "";
    updateLiveTranscript();
    setTurn("Interpreted your speech. Sending to assistant...");
  }

  sendUserTurn(finalText, { rawText: trimmed, speechIntent: intent });
}

async function transcribeRecordedTurn(blob, meta = {}) {
  if (!blob.size || blob.size < 1200) return;
  state.serverSttInFlight = true;
  state.interimTranscript = "Transcribing...";
  updateLiveTranscript();
  setTurn(meta.bargeIn ? "Speaker identity + WhisperX are checking interruption..." : "WhisperX is transcribing your turn...");

  try {
    const speakerDecisionPromise = meta.bargeIn
      ? withTimeout(classifyBargeInSpeaker(blob), 6500, null)
      : Promise.resolve(null);
    const sttPromise = withTimeout(fetch("/api/stt", {
        method: "POST",
        headers: {
          "Content-Type": blob.type || "audio/webm",
          "X-Audio-Format": blob.type || "webm",
          "X-User-Id": activeUserId(),
          "X-User-Name": activeUserName(),
        },
        body: blob,
      }),
      60000,
      null,
    )
      .then(async (response) => {
        if (!response) throw new Error("STT timed out");
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `STT failed: ${response.status}`);
        return result;
      });

    const [speakerDecision, result] = await Promise.all([speakerDecisionPromise, sttPromise]);

    const rawText = String(result.text ?? "").trim();
    const text = meta.bargeIn ? cleanedBargeInText(rawText) : rawText;
    state.transcriptBuffer = text;
    state.interimTranscript = "";
    updateLiveTranscript();

    if (!text) {
      setTurn("No speech detected.");
      if (meta.bargeIn) resumeAssistantAfterRejectedBargeIn("no speech detected");
      return;
    }

    const wasDuringAssistantAudio = meta.startedWhileSpeaking || meta.bargeIn || Date.now() - state.lastSpeechEndedAt < 1800;
    if (wasDuringAssistantAudio) {
      const echo = isLikelyAssistantEcho(text);
      const guardRejected = speakerGuardRejects(speakerDecision);
      const verifiedUserSpeaker = speakerDecision?.is_user === true;
      if (guardRejected) {
        state.transcriptBuffer = "";
        updateLiveTranscript();
        setTurn("Ignored overlapping audio: speaker identity did not match a saved user profile.");
        resumeAssistantAfterRejectedBargeIn("speaker mismatch");
        return;
      }
      if (verifiedUserSpeaker && (state.speaking || state.thinking)) {
        interruptAssistant("verified user barge-in");
      }
      if (hasInterruptIntent(text)) {
        interruptAssistant("verbal interrupt");
        if (isPureInterruptCommand(text)) {
          state.transcriptBuffer = "";
          updateLiveTranscript();
          return;
        }
      } else if (echo && !verifiedUserSpeaker) {
        state.transcriptBuffer = "";
        updateLiveTranscript();
        setTurn("Ignored assistant audio picked up by the mic.");
        resumeAssistantAfterRejectedBargeIn("assistant echo");
        return;
      } else if (state.speaking || meta.bargeIn) {
        interruptAssistant("verbal interrupt");
      }
    }

    if (speakerDecision?.is_user && speakerDecision.profile_match?.id && speakerDecision.profile_match.id !== state.currentUserId) {
      activateUserProfile(speakerDecision.profile_match.id, speakerDecision.profile_match.name, { announce: true });
    }

    if (!wasDuringAssistantAudio) enrollUserVoice(blob);

    state.transcriptBuffer = "";
    updateLiveTranscript();
    await submitSpeechTurn(text, { source: "whisperx", bargeIn: Boolean(meta.bargeIn) });
  } catch (error) {
    if (meta.bargeIn) resumeAssistantAfterRejectedBargeIn("transcription failed");
    const message = error instanceof Error ? error.message : "STT failed";
    setTurn(`${message}. Switching to browser STT fallback.`);
    if (dom.sttProvider) dom.sttProvider.value = "browser";
    startBrowserRecognition();
  } finally {
    state.serverSttInFlight = false;
    state.interimTranscript = "";
    updateLiveTranscript();
  }
}

function createRecognition() {
  if (!supportsSpeechRecognition()) return null;

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onaudiostart = () => {
    if (state.active) setTurn("Microphone is active.");
  };

  recognition.onspeechstart = () => {
    if ((state.speaking || state.thinking) && Date.now() > state.ignoreRecognitionUntil) {
      setTurn("Assistant is responding; mic turns resume after it finishes.");
    }
  };

  recognition.onresult = (event) => {
    if (useServerStt()) return;
    let finalText = "";
    let interim = "";
    let maxConfidence = 0;

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? "";
      maxConfidence = Math.max(maxConfidence, result[0]?.confidence ?? 0);
      if (result.isFinal) finalText += text;
      else interim += text;
    }

    const heardText = (finalText || interim).trim();
    if (state.speaking || state.thinking || Date.now() < state.ignoreRecognitionUntil) {
      state.interimTranscript = "";
      updateLiveTranscript();
      return;
    }

    const withinEchoTail = Date.now() - state.lastSpeechEndedAt < 2500;
    if ((state.speaking || withinEchoTail) && heardText) {
      const echo = isLikelyAssistantEcho(heardText);
      if (echo && !hasInterruptIntent(heardText)) {
        state.interimTranscript = "";
        dom.vadState.textContent = "echo ignored";
        updateLiveTranscript();
        return;
      }

      if (state.speaking) {
        if (bargeInEnabled() && isVerbalBargeIn(heardText, maxConfidence)) {
          interruptAssistant("verbal interrupt");
          if (!finalText.trim() || isPureInterruptCommand(finalText)) {
            state.interimTranscript = "";
            state.transcriptBuffer = "";
            updateLiveTranscript();
            return;
          }
        } else {
          setTurn("Assistant is speaking; the next voice turn starts after it finishes.");
          return;
        }
      }
    }

    if (finalText.trim()) {
      state.transcriptBuffer = `${state.transcriptBuffer} ${finalText}`.trim();
      state.interimTranscript = "";
      scheduleTurnSubmit();
    } else {
      state.interimTranscript = interim.trim();
    }

    updateLiveTranscript();
  };

  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    setTurn(`Speech recognition warning: ${event.error}`);
  };

  recognition.onend = () => {
    state.listening = false;
    if (!state.active || useServerStt()) return;
    clearTimeout(state.recognitionRestartTimer);
    state.recognitionRestartTimer = setTimeout(startBrowserRecognition, 220);
  };

  return recognition;
}

function startBrowserRecognition() {
  if (!state.active || useServerStt() || !supportsSpeechRecognition()) return;
  state.recognition = state.recognition ?? createRecognition();
  try {
    state.recognition.start();
    state.listening = true;
  } catch {
    // Chrome throws if recognition is already starting.
  }
}

function stopBrowserRecognition() {
  clearTimeout(state.recognitionRestartTimer);
  try {
    state.recognition?.stop();
  } catch {
    // Browser recognizer may already be stopped.
  }
}

function scheduleTurnSubmit() {
  clearTimeout(state.turnTimer);
  state.turnTimer = setTimeout(async () => {
    const text = state.transcriptBuffer.trim();
    if (!text || state.thinking) return;
    state.transcriptBuffer = "";
    state.interimTranscript = "";
    updateLiveTranscript();
    await submitSpeechTurn(text, { source: "browser" });
  }, 1600);
}

async function startVoiceSession() {
  await ensureActiveSession("browser_voice");
  state.active = true;
  state.interrupted = false;
  dom.startBtn.disabled = true;
  dom.stopBtn.disabled = false;
  setInterruptControlDisabled(false);
  setAgentState("Listening", "listening");
  setTurn(
    useServerStt()
      ? 'Ask anything. Pause for about a second when you are done. WhisperX will transcribe and clean the turn.'
      : 'Ask anything. Pause for about a second when you are done. Browser STT is active.',
  );

  addMessage("system", `Voice session started in ${state.currentSessionSummary?.projectName || "this project"}.`);
  await loadSpeakerProfiles();

  try {
    await initMicMeter();
  } catch {
    setTurn("Microphone permission failed. Typed fallback still works.");
    return;
  }

  if (useServerStt()) {
    stopBrowserRecognition();
    updateLiveTranscript();
    return;
  }

  if (!supportsSpeechRecognition()) {
    setTurn("Browser speech recognition is unavailable. Use WhisperX or typed fallback.");
    return;
  }

  startBrowserRecognition();
}

function stopVoiceSession() {
  state.active = false;
  state.listening = false;
  clearTimeout(state.turnTimer);
  stopBrowserRecognition();
  stopTurnRecording("session stopped");
  interruptAssistant("session stopped", { silent: true });
  dom.startBtn.disabled = false;
  dom.stopBtn.disabled = true;
  setInterruptControlDisabled(true);
  setAgentState("Idle", "");
  setTurn("Session stopped.");
  if (state.currentSessionId) {
    fetch(`/api/sessions/${state.currentSessionId}/end`, { method: "POST" })
      .then(() => refreshSessions())
      .catch(() => {});
  }
}

function interruptAssistant(reason, opts = {}) {
  if (!state.speaking && !state.thinking && !state.abortController) return;
  const shouldLearnFromInterruption =
    !opts.silent &&
    reason !== "session stopped" &&
    reason !== "new user turn" &&
    (state.speaking || state.speakingUtterance || state.audioElement || state.currentSpokenText);
  if (shouldLearnFromInterruption) {
    state.assistantTurnInterrupted = true;
    recordTurnTakingInterruption(reason);
  }
  state.interrupted = true;
  state.abortController?.abort();
  state.abortController = null;
  state.thinking = false;
  state.speaking = false;
  state.bargeInPaused = false;
  state.bargeInPausedAt = 0;
  state.bargeInPausedProvider = null;
  state.speakQueue = [];
  state.ttsBuffer = "";
  speechSynthesis.cancel();
  state.ttsAbortController?.abort();
  state.ttsAbortController = null;
  if (state.audioElement) {
    state.audioElement.pause();
    state.audioElement.src = "";
    state.audioElement = null;
  }
  if (!state.active) setInterruptControlDisabled(true);
  if (!opts.silent) {
    setAgentState("Interrupted", "interrupted");
    setTurn(`Assistant interrupted: ${reason}. Listening for your correction.`);
    setTimeout(() => {
      if (state.active && !state.thinking && !state.speaking) setAgentState("Listening", "listening");
    }, 700);
  }
}

async function sendUserTurn(text, meta = {}) {
  if (!text.trim()) return;
  await ensureActiveSession(meta.source === "browser" || meta.source === "whisperx" ? "browser_voice" : "typed");

  const normalizedTurn = normalizeSpeechText(text);
  if (normalizedTurn === state.lastSubmittedUserText && performance.now() - state.lastSubmittedAt < 2500) return;
  state.lastSubmittedUserText = normalizedTurn;
  state.lastSubmittedAt = performance.now();

  interruptAssistant("new user turn", { silent: true });
  setInterruptControlDisabled(false);
  state.interrupted = false;
  state.thinking = true;
  resetMetrics(text);
  setAgentState("Thinking", "thinking");
  setTurn(useCodexPilot() ? `Handing this turn to ${selectedControlProviderLabel()}...` : "Streaming assistant response...");

  state.messages.push({ role: "user", content: text });
  saveUserConversation();
  appendSessionMessage("user", text, {
    source: meta.source || "typed",
    route: useCodexPilot() ? "codex_pilot" : "assistant_llm",
  });
  addMessage("user", text);

  state.currentAssistantText = "";
  state.currentAssistantEl = addMessage("assistant", "");
  state.ttsBuffer = "";
  state.abortController = new AbortController();

  try {
    const endpoint = useCodexPilot() ? "/api/codex/exec" : "/api/chat";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.messages,
        systemPrompt: dom.systemPrompt.value.trim(),
        client: {
          user_id: state.currentUserId,
          user_name: activeUserName(),
          session_id: state.currentSessionId,
          session_title: state.currentSessionSummary?.title || null,
          project_name: state.currentSessionSummary?.projectName || selectedProjectName(),
          project_mode: state.currentSessionSummary?.projectMode || dom.projectMode?.value || "existing_project",
          stt_provider: dom.sttProvider.value,
          voice_rate: Number(dom.rateSlider.value),
          auto_speak: dom.autoSpeakToggle.checked,
          barge_in: false,
          raw_speech_text: meta.rawText || null,
          speech_intent: meta.speechIntent || null,
          speech_flow: getSpeechFlowConfig(),
          route: useCodexPilot() ? "codex_pilot" : "assistant_llm",
          control_provider: selectedControlProvider(),
        },
        controlProvider: selectedControlProvider(),
      }),
      signal: state.abortController.signal,
    });

    await readSse(response);
  } catch (error) {
    if (error.name !== "AbortError") {
      appendMessage(state.currentAssistantEl, "\n[Model error. Try again.]");
      setTurn("Model request failed.");
    }
  } finally {
    if (state.currentAssistantText.trim()) {
      state.messages.push({ role: "assistant", content: state.currentAssistantText.trim() });
      saveUserConversation();
      appendSessionMessage("assistant", state.currentAssistantText.trim(), {
        source: meta.source || "typed",
        route: useCodexPilot() ? "codex_pilot" : "assistant_llm",
      });
    }
    state.abortController = null;
    state.thinking = false;
    flushTtsBuffer();
    if (!state.speaking && state.active) {
      setAgentState("Listening", "listening");
      setTurn("Listening for your next coding request.");
    }
  }
}

async function readSse(response) {
  if (!response.ok || !response.body) throw new Error(`Bad response: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const raw of events) {
      const event = parseSse(raw);
      if (!event) continue;
      if (event.type === "token" && event.data.text) {
        if (!state.currentMetrics.firstTokenAt) {
          state.currentMetrics.firstTokenAt = performance.now();
          renderMetrics();
        }
        receiveAssistantToken(event.data.text);
      }
      if (event.type === "warning" || event.type === "error") {
        setTurn(event.data.message);
      }
      if (event.type === "codex_event") {
        setTurn(`Codex ${event.data.status || "event"}: ${event.data.label || "tool"}`);
      }
      if (event.type === "meta") {
        dom.providerState.textContent = `provider: ${event.data.provider} / ${event.data.model}`;
        if (event.data.provider === "codex") {
          const details = [
            event.data.workspace ? `workspace ${compactWorkspacePath(event.data.workspace)}` : null,
            event.data.threadId ? `thread ${event.data.threadId}` : null,
            event.data.sandbox ? `sandbox ${event.data.sandbox}` : null,
            event.data.durationMs ? `${event.data.durationMs} ms` : null,
          ].filter(Boolean).join("; ");
          setCodexPilotState(details ? `Codex pilot active: ${details}` : "Codex pilot active.");
        }
        if (event.data.provider === "openclaw") {
          const details = [
            event.data.workspace ? `workspace ${compactWorkspacePath(event.data.workspace)}` : null,
            event.data.sessionKey ? `session ${event.data.sessionKey}` : null,
            event.data.mode ? `${event.data.mode} mode` : null,
            event.data.runner ? `runner ${event.data.runner}` : null,
            event.data.durationMs ? `${event.data.durationMs} ms` : null,
          ].filter(Boolean).join("; ");
          setCodexPilotState(details ? `OpenClaw control active: ${details}` : "OpenClaw control active.");
        }
      }
    }
  }
}

function parseSse(raw) {
  let type = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  return { type, data: JSON.parse(data) };
}

function receiveAssistantToken(text) {
  state.currentAssistantText += text;
  appendMessage(state.currentAssistantEl, text);

  if (dom.autoSpeakToggle.checked) {
    state.ttsBuffer += text;
    maybeSpeakBufferedText();
  }
}

function maybeSpeakBufferedText() {
  const boundary = state.ttsBuffer.search(/[.!?]\s/);
  const tooLong = state.ttsBuffer.length > 150;
  if (boundary === -1 && !tooLong) return;

  const cut = boundary === -1 ? state.ttsBuffer.length : boundary + 1;
  const chunk = state.ttsBuffer.slice(0, cut).trim();
  state.ttsBuffer = state.ttsBuffer.slice(cut).trimStart();
  if (chunk) enqueueSpeech(chunk);
}

function flushTtsBuffer() {
  const chunk = state.ttsBuffer.trim();
  state.ttsBuffer = "";
  if (chunk && dom.autoSpeakToggle.checked) enqueueSpeech(chunk);
}

function enqueueSpeech(text) {
  state.speakQueue.push(text);
  if (!state.speakingUtterance && !state.audioElement && !state.speechStartWaiter) speakNext();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocialSilenceBeforeSpeech() {
  if (!state.active || !state.micStream) return true;
  if (state.speechStartWaiter) return false;

  state.speechStartWaiter = true;
  const requiredQuietMs = getAssistantStartSilenceMs();
  const startedAt = performance.now();

  try {
    while (state.active && !state.interrupted) {
      const quietFor = micQuietForMs();
      const canSpeak =
        !state.mediaRecorder &&
        !state.serverSttInFlight &&
        !state.micVoiceActive &&
        quietFor >= requiredQuietMs;

      if (canSpeak) return true;

      if (performance.now() - startedAt > TURN_CAPTURE.maxAssistantWaitMs && !state.mediaRecorder && !state.serverSttInFlight) {
        return true;
      }

      setAgentState("Listening", "listening");
      setTurn(`Holding response until you finish. Quiet for ${Math.round(quietFor)} / ${Math.round(requiredQuietMs)} ms.`);
      await sleep(120);
    }
    return false;
  } finally {
    state.speechStartWaiter = false;
  }
}

async function speakNext() {
  if (!state.speakQueue.length) {
    state.speaking = false;
    state.speakingUtterance = null;
    state.currentSpokenText = "";
    state.lastSpeechEndedAt = Date.now();
    recordAssistantCompleted();
    state.assistantSpeechStartedAt = 0;
    if (!state.active) setInterruptControlDisabled(true);
    if (!state.thinking && state.active) {
      setAgentState("Listening", "listening");
      setTurn("Listening for your next coding request.");
    }
    return;
  }

  const text = state.speakQueue.shift();
  const canSpeak = await waitForSocialSilenceBeforeSpeech();
  if (!canSpeak) {
    if (text) state.speakQueue.unshift(text);
    return;
  }
  state.currentSpokenText = text;
  state.recentSpokenText = `${state.recentSpokenText} ${text}`.slice(-2200);
  const provider = dom.ttsProvider.value;
  if (provider !== "browser") {
    await speakRemote(text, provider);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = Number(dom.rateSlider.value);
  utterance.pitch = 1;
  utterance.volume = 1;
  utterance.onstart = () => {
    state.speaking = true;
    state.assistantTurnInterrupted = false;
    state.assistantSpeechStartedAt = performance.now();
    state.speakingUtterance = utterance;
    setInterruptControlDisabled(false);
    state.ignoreRecognitionUntil = Date.now() + 650;
    if (state.currentMetrics && !state.currentMetrics.firstSpeechAt) {
      state.currentMetrics.firstSpeechAt = performance.now();
      renderMetrics();
    }
    setAgentState("Speaking", "speaking");
    setTurn("Assistant is speaking. Mic turns resume when it finishes.");
  };
  utterance.onend = () => {
    state.speakingUtterance = null;
    state.lastSpeechEndedAt = Date.now();
    speakNext();
  };
  utterance.onerror = () => {
    state.speakingUtterance = null;
    state.lastSpeechEndedAt = Date.now();
    speakNext();
  };
  speechSynthesis.speak(utterance);
}

async function speakRemote(text, provider) {
  const startedAt = performance.now();
  state.speaking = true;
  state.assistantTurnInterrupted = false;
  state.assistantSpeechStartedAt = performance.now();
  state.currentSpokenText = text;
  state.recentSpokenText = `${state.recentSpokenText} ${text}`.slice(-2200);
  state.speakingUtterance = null;
  state.ttsAbortController = new AbortController();
  setInterruptControlDisabled(false);
  state.ignoreRecognitionUntil = Date.now() + 650;
  setAgentState("Speaking", "speaking");
  setTurn(`${provider} TTS is speaking. Mic turns resume when it finishes.`);

  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        text,
        speed: Number(dom.rateSlider.value),
      }),
      signal: state.ttsAbortController.signal,
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `${provider} TTS failed`);
    }

    const blob = await response.blob();
    enrollAssistantVoice(blob);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.audioElement = audio;

    await new Promise((resolve, reject) => {
      audio.onplay = () => {
        if (state.currentMetrics && !state.currentMetrics.firstSpeechAt) {
          state.currentMetrics.firstSpeechAt = performance.now();
        }
        state.currentMetrics?.ttsChunks.push({
          provider,
          ms: Math.round(performance.now() - startedAt),
          chars: text.length,
        });
        renderMetrics();
      };
      audio.onended = resolve;
      audio.onerror = reject;
      audio.play().catch(reject);
    });

    URL.revokeObjectURL(url);
    state.lastSpeechEndedAt = Date.now();
  } catch (error) {
    if (error.name !== "AbortError") {
      setTurn(`${provider} TTS unavailable; falling back to browser voice.`);
      dom.ttsProvider.value = "browser";
      enqueueSpeech(text);
      return;
    }
  } finally {
    state.ttsAbortController = null;
    state.audioElement = null;
  }

  speakNext();
}

dom.startBtn.addEventListener("click", startVoiceSession);
dom.stopBtn.addEventListener("click", stopVoiceSession);
dom.interruptBtn?.addEventListener("click", () => interruptAssistant("manual interrupt"));
dom.codexPilotToggle?.addEventListener("change", () => {
  setTurn(useCodexPilot() ? `Codex pilot mode enabled through ${selectedControlProviderLabel()}.` : "Codex pilot mode disabled. Using assistant LLM path.");
});
dom.codexControlProvider?.addEventListener("change", () => {
  setCodexPilotState(`Selected: ${selectedControlProviderLabel()}.`);
  if (useCodexPilot()) setTurn(`Next Codex pilot turn will use ${selectedControlProviderLabel()}.`);
});
dom.sttProvider.addEventListener("change", () => {
  if (!state.active) return;
  if (useServerStt()) stopBrowserRecognition();
  else startBrowserRecognition();
  updateLiveTranscript();
});
dom.userProfile.addEventListener("change", switchUserProfile);
dom.userProfileName.addEventListener("change", switchUserProfile);
dom.projectMode?.addEventListener("change", renderSessionUi);
dom.projectSelect?.addEventListener("change", () => {
  if (dom.projectName) dom.projectName.value = dom.projectSelect.value;
  renderSessionUi();
});
dom.projectName?.addEventListener("input", renderSessionUi);
dom.newSessionBtn?.addEventListener("click", () => {
  createSession("browser").catch((error) => {
    dom.sessionState.textContent = `Could not start chat: ${error.message}`;
  });
});
dom.loadSessionBtn?.addEventListener("click", () => {
  loadSession().catch((error) => {
    dom.sessionState.textContent = `Could not open chat: ${error.message}`;
  });
});
dom.sessionHistoryList?.addEventListener("click", (event) => {
  const target = event.target.closest("[data-session-id]");
  if (!target) return;
  loadSession(target.dataset.sessionId).catch((error) => {
    dom.sessionState.textContent = `Could not open chat: ${error.message}`;
  });
});
[dom.flowCleanupLevel, dom.flowWritingStyle, dom.flowLanguage, dom.flowDictionary, dom.flowSnippets]
  .filter(Boolean)
  .forEach((element) => {
    element.addEventListener("change", saveSpeechFlowConfig);
    element.addEventListener("input", saveSpeechFlowConfig);
  });
dom.textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = dom.textInput.value.trim();
  dom.textInput.value = "";
  sendUserTurn(text);
});

switchUserProfile();
refreshSessions();
updateProviderStatus();
if (!supportsSpeechRecognition()) {
  setTurn("Browser speech recognition unavailable. WhisperX or typed fallback is ready.");
}

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Installability is best-effort; voice runtime still works without the service worker.
  });
}
