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
  bargeInToggle: document.querySelector("#bargeInToggle"),
  speechIntentToggle: document.querySelector("#speechIntentToggle"),
  rateSlider: document.querySelector("#rateSlider"),
  sttProvider: document.querySelector("#sttProvider"),
  ttsProvider: document.querySelector("#ttsProvider"),
  studentProfile: document.querySelector("#studentProfile"),
  studentProfileName: document.querySelector("#studentProfileName"),
  systemPrompt: document.querySelector("#systemPrompt"),
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
  currentStudentId: "user_a",
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

window.__tutorTronVoiceTest = {
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
      currentStudentId: state.currentStudentId,
      turnTakingProfile: state.turnTakingProfile,
      lastSpeakerDecision: state.lastSpeakerDecision,
    };
  },
};

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

function activeStudentId() {
  const raw = dom.studentProfile?.value || "user_a";
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "user_a";
}

function activeStudentName() {
  return (dom.studentProfileName?.value || activeStudentId().replace(/_/g, " ")).trim();
}

function conversationStorageKey(studentId = activeStudentId()) {
  return `tutor-tron:conversation:${studentId}`;
}

function turnTakingStorageKey(studentId = activeStudentId()) {
  return `tutor-tron:turn-taking:${studentId}`;
}

function turnTakingEventsKey(studentId = activeStudentId()) {
  return `tutor-tron:turn-taking-events:${studentId}`;
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

function loadTurnTakingProfile(studentId = activeStudentId()) {
  try {
    const stored = localStorage.getItem(turnTakingStorageKey(studentId));
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
  localStorage.setItem(turnTakingStorageKey(state.currentStudentId), JSON.stringify(profile));
}

function saveTurnTakingEvent(event) {
  try {
    const key = turnTakingEventsKey(state.currentStudentId);
    const stored = localStorage.getItem(key);
    const events = stored ? JSON.parse(stored) : [];
    events.push({ ts: Date.now(), ...event });
    localStorage.setItem(key, JSON.stringify(events.slice(-30)));
  } catch {
    // Turn-taking feedback is best-effort local learning.
  }
}

function turnTakingProfile() {
  if (!state.turnTakingProfile) loadTurnTakingProfile(state.currentStudentId);
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

function saveStudentConversation() {
  localStorage.setItem(conversationStorageKey(state.currentStudentId), JSON.stringify(state.messages.slice(-24)));
}

function loadStudentConversation(studentId = activeStudentId()) {
  try {
    const stored = localStorage.getItem(conversationStorageKey(studentId));
    state.messages = stored ? JSON.parse(stored).filter((m) => m?.role && typeof m.content === "string") : [];
  } catch {
    state.messages = [];
  }
}

function ensureStudentProfileOption(profileId, profileName = profileId) {
  if (!dom.studentProfile) return;
  const existing = [...dom.studentProfile.options].find((option) => option.value === profileId);
  if (existing) {
    existing.textContent = profileName;
    return;
  }
  const option = document.createElement("option");
  option.value = profileId;
  option.textContent = profileName;
  dom.studentProfile.appendChild(option);
}

function hasAnySpeakerProfile() {
  return Object.values(state.speakerProfiles).some((profile) => Number(profile?.samples ?? 0) > 0) || state.userVoiceEnrolled;
}

function hasActiveSpeakerProfile() {
  return Boolean(state.speakerProfiles[state.currentStudentId]?.samples) || state.userVoiceEnrolled;
}

function updateActiveSpeakerState() {
  state.userVoiceEnrolled = Boolean(state.speakerProfiles[state.currentStudentId]?.samples);
}

function activateStudentProfile(profileId, profileName = profileId, opts = {}) {
  if (!profileId) return;
  saveStudentConversation();
  ensureStudentProfileOption(profileId, profileName);
  if (dom.studentProfile) dom.studentProfile.value = profileId;
  if (dom.studentProfileName) dom.studentProfileName.value = profileName;
  state.currentStudentId = activeStudentId();
  loadStudentConversation(state.currentStudentId);
  loadTurnTakingProfile(state.currentStudentId);
  dom.messages.innerHTML = "";
  addMessage("system", `Active student profile: ${activeStudentName()} (${state.currentStudentId}).`);
  updateActiveSpeakerState();
  const profile = state.speakerProfiles[state.currentStudentId];
  if (profile?.samples) {
    setSpeakerGuard(`${profile.name || activeStudentName()}: ${profile.samples} saved voice sample${profile.samples === 1 ? "" : "s"}`);
  } else {
    setSpeakerGuard(`profile ${state.currentStudentId}: voiceprint will update on next spoken turn`);
  }
  if (opts.announce) {
    addMessage("system", `Speaker matched ${activeStudentName()}; routed this turn to that student's memory.`);
  }
}

function selectedStudentLabel() {
  return dom.studentProfile?.selectedOptions?.[0]?.textContent?.trim() || activeStudentName();
}

function switchStudentProfile(event) {
  const profileId = activeStudentId();
  const profileName =
    event?.target === dom.studentProfileName
      ? activeStudentName()
      : state.speakerProfiles[profileId]?.name || selectedStudentLabel();
  activateStudentProfile(profileId, profileName);
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
      ensureStudentProfileOption(profile.id, profile.name || profile.id);
    }
    updateActiveSpeakerState();
    const active = state.speakerProfiles[state.currentStudentId];
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
      `TTS: ${data.ttsProvider}${data.fishConfigured ? " / Fish ready" : " / Fish not configured"}`;
  } catch {
    dom.providerState.textContent = "provider: server unavailable";
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
  return /\b(stop|wait|pause|hold on|hang on|actually|interrupt|let me|one second|i don t|i do not|i m confused|im confused|confused|that s wrong|thats wrong|wrong|can i ask|let me ask|tutor stop|tutor tron stop)\b/.test(text);
}

function isPureInterruptCommand(value) {
  return /^(stop|wait|pause|hold on|hang on|one second|tutor stop|tutor tron stop)$/.test(normalizeSpeechText(value));
}

function tutorEchoScore(value) {
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

function isLikelyTutorEcho(value) {
  return tutorEchoScore(value) >= 0.58;
}

function isVerbalBargeIn(value, confidence = 0) {
  const words = speechWords(value);
  if (hasInterruptIntent(value) && tutorEchoScore(value) < 0.85) return true;

  return words.length >= 5 && confidence >= 0.55 && tutorEchoScore(value) < 0.28;
}

function cleanedBargeInText(value) {
  const phrases = [
    "tutor tron stop",
    "tutor stop",
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

  const voiceThreshold = state.speaking ? 0.052 : 0.034;
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
    ? (state.speaking ? "barge-in?" : "voice")
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
        "X-User-Id": activeStudentId(),
        "X-User-Name": activeStudentName(),
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
        ensureStudentProfileOption(profile.id, profile.name || profile.id);
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
        ? `barge-in accepted: ${(profile?.name || activeStudentName())} ${Math.round(((profile?.similarity ?? result.user_similarity) ?? 0) * 100) / 100}`
        : `blocked likely tutor echo: ${result.reason}`,
    );
    renderMetrics();
    return result;
  });
}

function speakerGuardRejects(decision) {
  if (!decision || !hasAnySpeakerProfile()) return false;
  return !decision.is_user;
}

function pauseTutorForBargeInCandidate() {
  if (state.bargeInPaused || !dom.bargeInToggle.checked || (!state.speaking && !state.speakingUtterance && !state.audioElement)) {
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
  setTurn("Paused tutor for possible interruption. Keep talking.");
}

function resumeTutorAfterRejectedBargeIn(reason = "not user speech") {
  if (!state.bargeInPaused) return;

  state.bargeInPaused = false;
  state.bargeInPausedAt = 0;
  const provider = state.bargeInPausedProvider;
  state.bargeInPausedProvider = null;

  if (provider === "remote" && state.audioElement) {
    state.audioElement.play().catch(() => {
      setTurn("Tutor audio could not resume after rejected interruption.");
    });
  } else if (speechSynthesis.paused) {
    speechSynthesis.resume();
  }

  if (state.active && state.speaking) {
    setAgentState("Speaking", "speaking");
    setTurn(`Resuming tutor; interruption rejected (${reason}).`);
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
  if (meta.bargeIn && dom.bargeInToggle.checked && startedWhileSpeaking) {
    pauseTutorForBargeInCandidate();
  } else {
    setTurn(meta.bargeIn ? "Checking interruption..." : "Recording your turn...");
  }
}

function stopTurnRecording(reason) {
  if (!state.mediaRecorder || state.mediaRecorder.state === "inactive") return;
  state.recordingMeta = { ...(state.recordingMeta ?? {}), stopReason: reason };
  state.mediaRecorder.stop();
}

function handleServerSttVad(isVoice) {
  if (!state.micStream || state.serverSttInFlight) return;
  if (state.speaking && Date.now() < state.ignoreRecognitionUntil) return;
  const recorderActive = Boolean(state.mediaRecorder);
  const elapsed = performance.now() - state.recordingStartedAt;
  const isBargeIn = Boolean(state.recordingMeta?.bargeIn);
  const minMs = isBargeIn ? TURN_CAPTURE.bargeInMinMs : TURN_CAPTURE.normalMinMs;
  const maxMs = isBargeIn ? TURN_CAPTURE.bargeInMaxMs : TURN_CAPTURE.normalMaxMs;
  const startFrames = state.speaking ? TURN_CAPTURE.bargeInStartVoiceFrames : TURN_CAPTURE.startVoiceFrames;
  const silenceMs = micQuietForMs();
  const turnEndConfidence = endOfTurnConfidence({ elapsed, silenceMs, isBargeIn });

  if (!recorderActive && isVoice && state.vadFrames >= startFrames) {
    startTurnRecording({ bargeIn: state.speaking || state.thinking });
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
        student_id: state.currentStudentId,
        student_name: activeStudentName(),
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

  setTurn(useSpeechIntentRewrite() ? "Structuring your speech into a clear request..." : "Sending transcript to tutor...");
  const intent = await rewriteSpeechIntent(trimmed, meta);
  const finalText = intent.text.trim() || trimmed;

  if (intent.changed) {
    state.transcriptBuffer = finalText;
    state.interimTranscript = "";
    updateLiveTranscript();
    setTurn("Interpreted your speech. Sending to tutor...");
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
          "X-User-Id": activeStudentId(),
          "X-User-Name": activeStudentName(),
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
      if (meta.bargeIn) resumeTutorAfterRejectedBargeIn("no speech detected");
      return;
    }

    const wasDuringTutorAudio = meta.startedWhileSpeaking || meta.bargeIn || Date.now() - state.lastSpeechEndedAt < 1800;
    if (wasDuringTutorAudio) {
      const echo = isLikelyTutorEcho(text);
      const guardRejected = speakerGuardRejects(speakerDecision);
      const verifiedStudentSpeaker = speakerDecision?.is_user === true;
      if (guardRejected) {
        state.transcriptBuffer = "";
        updateLiveTranscript();
        setTurn("Ignored overlapping audio: speaker identity did not match a saved student profile.");
        resumeTutorAfterRejectedBargeIn("speaker mismatch");
        return;
      }
      if (verifiedStudentSpeaker && (state.speaking || state.thinking)) {
        interruptTutor("verified student barge-in");
      }
      if (hasInterruptIntent(text)) {
        interruptTutor("verbal interrupt");
        if (isPureInterruptCommand(text)) {
          state.transcriptBuffer = "";
          updateLiveTranscript();
          return;
        }
      } else if (echo && !verifiedStudentSpeaker) {
        state.transcriptBuffer = "";
        updateLiveTranscript();
        setTurn("Ignored tutor audio picked up by the mic.");
        resumeTutorAfterRejectedBargeIn("tutor echo");
        return;
      } else if (state.speaking || meta.bargeIn) {
        interruptTutor("verbal interrupt");
      }
    }

    if (speakerDecision?.is_user && speakerDecision.profile_match?.id && speakerDecision.profile_match.id !== state.currentStudentId) {
      activateStudentProfile(speakerDecision.profile_match.id, speakerDecision.profile_match.name, { announce: true });
    }

    if (!wasDuringTutorAudio) enrollUserVoice(blob);

    state.transcriptBuffer = "";
    updateLiveTranscript();
    await submitSpeechTurn(text, { source: "whisperx", bargeIn: Boolean(meta.bargeIn) });
  } catch (error) {
    if (meta.bargeIn) resumeTutorAfterRejectedBargeIn("transcription failed");
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
    if (state.speaking && dom.bargeInToggle.checked && Date.now() > state.ignoreRecognitionUntil) {
      setTurn("Speech detected during tutor output. Waiting for non-echo words.");
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
    if (state.speaking && Date.now() < state.ignoreRecognitionUntil) return;

    const withinEchoTail = Date.now() - state.lastSpeechEndedAt < 2500;
    if ((state.speaking || withinEchoTail) && heardText) {
      const echo = isLikelyTutorEcho(heardText);
      if (echo && !hasInterruptIntent(heardText)) {
        state.interimTranscript = "";
        dom.vadState.textContent = "echo ignored";
        updateLiveTranscript();
        return;
      }

      if (state.speaking) {
        if (dom.bargeInToggle.checked && isVerbalBargeIn(heardText, maxConfidence)) {
          interruptTutor("verbal interrupt");
          if (!finalText.trim() || isPureInterruptCommand(finalText)) {
            state.interimTranscript = "";
            state.transcriptBuffer = "";
            updateLiveTranscript();
            return;
          }
        } else {
          setTurn('To interrupt verbally, say "wait", "stop", or "hold on" first.');
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
  state.active = true;
  state.interrupted = false;
  dom.startBtn.disabled = true;
  dom.stopBtn.disabled = false;
  dom.interruptBtn.disabled = false;
  setAgentState("Listening", "listening");
  setTurn(
    useServerStt()
      ? 'Ask anything. Pause for about a second when you are done. WhisperX will transcribe and clean the turn.'
      : 'Ask anything. Pause for about a second when you are done. Browser STT is active.',
  );

  addMessage("system", "Voice session started. Ask Tutor-Tron any prompt; the system prompt in the left panel controls behavior.");
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
  interruptTutor("session stopped", { silent: true });
  dom.startBtn.disabled = false;
  dom.stopBtn.disabled = true;
  dom.interruptBtn.disabled = true;
  setAgentState("Idle", "");
  setTurn("Session stopped.");
}

function interruptTutor(reason, opts = {}) {
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
  if (!state.active) dom.interruptBtn.disabled = true;
  if (!opts.silent) {
    setAgentState("Interrupted", "interrupted");
    setTurn(`Tutor interrupted: ${reason}. Listening for your correction.`);
    setTimeout(() => {
      if (state.active && !state.thinking && !state.speaking) setAgentState("Listening", "listening");
    }, 700);
  }
}

async function sendUserTurn(text, meta = {}) {
  if (!text.trim()) return;

  const normalizedTurn = normalizeSpeechText(text);
  if (normalizedTurn === state.lastSubmittedUserText && performance.now() - state.lastSubmittedAt < 2500) return;
  state.lastSubmittedUserText = normalizedTurn;
  state.lastSubmittedAt = performance.now();

  interruptTutor("new user turn", { silent: true });
  dom.interruptBtn.disabled = false;
  state.interrupted = false;
  state.thinking = true;
  resetMetrics(text);
  setAgentState("Thinking", "thinking");
  setTurn("Streaming tutor response...");

  state.messages.push({ role: "user", content: text });
  saveStudentConversation();
  addMessage("user", text);

  state.currentAssistantText = "";
  state.currentAssistantEl = addMessage("assistant", "");
  state.ttsBuffer = "";
  state.abortController = new AbortController();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.messages,
        systemPrompt: dom.systemPrompt.value.trim(),
        client: {
          student_id: state.currentStudentId,
          student_name: activeStudentName(),
          stt_provider: dom.sttProvider.value,
          voice_rate: Number(dom.rateSlider.value),
          auto_speak: dom.autoSpeakToggle.checked,
          barge_in: dom.bargeInToggle.checked,
          raw_speech_text: meta.rawText || null,
          speech_intent: meta.speechIntent || null,
        },
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
      saveStudentConversation();
    }
    state.abortController = null;
    state.thinking = false;
    flushTtsBuffer();
    if (!state.speaking && state.active) {
      setAgentState("Listening", "listening");
      setTurn("Listening for your next question.");
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
      if (event.type === "meta") {
        dom.providerState.textContent = `provider: ${event.data.provider} / ${event.data.model}`;
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
    if (!state.active) dom.interruptBtn.disabled = true;
    if (!state.thinking && state.active) {
      setAgentState("Listening", "listening");
      setTurn("Listening for your next question.");
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
    dom.interruptBtn.disabled = false;
    state.ignoreRecognitionUntil = Date.now() + 650;
    if (state.currentMetrics && !state.currentMetrics.firstSpeechAt) {
      state.currentMetrics.firstSpeechAt = performance.now();
      renderMetrics();
    }
    setAgentState("Speaking", "speaking");
    setTurn('Tutor is speaking. Say "wait" or "stop" to interrupt.');
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
  dom.interruptBtn.disabled = false;
  state.ignoreRecognitionUntil = Date.now() + 650;
  setAgentState("Speaking", "speaking");
  setTurn(`${provider} TTS is speaking. Say "wait" or "stop" to interrupt.`);

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
dom.interruptBtn.addEventListener("click", () => interruptTutor("manual interrupt"));
dom.sttProvider.addEventListener("change", () => {
  if (!state.active) return;
  if (useServerStt()) stopBrowserRecognition();
  else startBrowserRecognition();
  updateLiveTranscript();
});
dom.studentProfile.addEventListener("change", switchStudentProfile);
dom.studentProfileName.addEventListener("change", switchStudentProfile);
dom.textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = dom.textInput.value.trim();
  dom.textInput.value = "";
  sendUserTurn(text);
});

switchStudentProfile();
updateProviderStatus();
if (!supportsSpeechRecognition()) {
  setTurn("Browser speech recognition unavailable. WhisperX or typed fallback is ready.");
}
