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
  rateSlider: document.querySelector("#rateSlider"),
  ttsProvider: document.querySelector("#ttsProvider"),
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
  currentMetrics: null,
};

function setAgentState(label, kind = "") {
  dom.agentState.textContent = label;
  dom.agentState.className = `state-pill ${kind}`;
}

function setTurn(text) {
  dom.turnState.textContent = text;
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

async function updateProviderStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (data.ttsProvider && dom.ttsProvider) dom.ttsProvider.value = data.ttsProvider;
    if (data.openaiConfigured) {
      dom.providerState.textContent = `LLM: ${data.provider}; TTS: ${data.ttsProvider}; Fish: ${data.fishConfigured ? "ready" : "not configured"}`;
    } else {
      dom.providerState.textContent = `LLM: ${data.provider}, Ollama: ${data.ollamaModel}; TTS: ${data.ttsProvider}; fallback ready`;
    }
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

  dom.latencyLog.innerHTML = `
    <div><dt>Turn</dt><dd>${elapsed} ms</dd></div>
    <div><dt>First token</dt><dd>${firstToken}</dd></div>
    <div><dt>First speech</dt><dd>${firstSpeech}</dd></div>
    <div><dt>TTS provider</dt><dd>${ttsLabel}</dd></div>
  `;
}

function updateLiveTranscript() {
  const joined = `${state.transcriptBuffer} ${state.interimTranscript}`.trim();
  dom.liveTranscript.textContent = joined || "Listening...";
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
    `${state.currentSpokenText} ${state.recentSpokenText} ${state.currentAssistantText.slice(-1400)}`,
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
  if (hasInterruptIntent(value)) return true;

  // Full arbitrary barge-in is unreliable with browser TTS on speakers. Allow it
  // only when the recognizer is confident and the words do not resemble the
  // tutor's current audio.
  return words.length >= 5 && confidence >= 0.55 && tutorEchoScore(value) < 0.28;
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

  const isVoice = rms > 0.045;
  dom.vadState.textContent = isVoice ? "voice" : "quiet";

  state.vadFrames = isVoice ? state.vadFrames + 1 : 0;
  if (state.speaking && isVoice) dom.vadState.textContent = "voice / echo guard";

  requestAnimationFrame(tickMicMeter);
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
      if (state.speaking && dom.bargeInToggle.checked && hasInterruptIntent(heardText)) {
        interruptTutor("verbal interrupt");
        if (!finalText.trim() || isPureInterruptCommand(finalText)) {
          state.interimTranscript = "";
          state.transcriptBuffer = "";
          updateLiveTranscript();
          return;
        }
      } else if (isLikelyTutorEcho(heardText)) {
        state.interimTranscript = "";
        dom.vadState.textContent = "echo ignored";
        updateLiveTranscript();
        return;
      } else if (state.speaking) {
        if (dom.bargeInToggle.checked && isVerbalBargeIn(heardText, maxConfidence)) {
          interruptTutor("verbal interrupt");
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
    if (!state.active) return;
    clearTimeout(state.recognitionRestartTimer);
    state.recognitionRestartTimer = setTimeout(() => {
      try {
        recognition.start();
        state.listening = true;
      } catch {
        // Chrome throws if recognition is already starting.
      }
    }, 220);
  };

  return recognition;
}

function scheduleTurnSubmit() {
  clearTimeout(state.turnTimer);
  state.turnTimer = setTimeout(() => {
    const text = state.transcriptBuffer.trim();
    if (!text || state.thinking) return;
    state.transcriptBuffer = "";
    state.interimTranscript = "";
    updateLiveTranscript();
    sendUserTurn(text);
  }, 850);
}

async function startVoiceSession() {
  state.active = true;
  state.interrupted = false;
  dom.startBtn.disabled = true;
  dom.stopBtn.disabled = false;
  dom.interruptBtn.disabled = false;
  setAgentState("Listening", "listening");
  setTurn('Ask a question. While Tutor-Tron is speaking, say "wait" or "stop" to interrupt.');

  addMessage("system", "Voice session started. Try: “Why is this hypergeometric and not binomial?”");

  try {
    await initMicMeter();
  } catch (error) {
    setTurn("Microphone permission failed. Typed fallback still works.");
  }

  if (!supportsSpeechRecognition()) {
    setTurn("Speech recognition is unavailable in this browser. Use typed fallback.");
    return;
  }

  state.recognition = state.recognition ?? createRecognition();
  try {
    state.recognition.start();
    state.listening = true;
  } catch {
    // Already started.
  }
}

function stopVoiceSession() {
  state.active = false;
  state.listening = false;
  clearTimeout(state.turnTimer);
  clearTimeout(state.recognitionRestartTimer);
  state.recognition?.stop();
  interruptTutor("session stopped", { silent: true });
  dom.startBtn.disabled = false;
  dom.stopBtn.disabled = true;
  dom.interruptBtn.disabled = true;
  setAgentState("Idle", "");
  setTurn("Session stopped.");
}

function interruptTutor(reason, opts = {}) {
  if (!state.speaking && !state.thinking && !state.abortController) return;
  state.interrupted = true;
  state.abortController?.abort();
  state.abortController = null;
  state.thinking = false;
  state.speaking = false;
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

async function sendUserTurn(text) {
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
        client: {
          voice_rate: Number(dom.rateSlider.value),
          auto_speak: dom.autoSpeakToggle.checked,
          barge_in: dom.bargeInToggle.checked,
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
      if (event.type === "warning") {
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
  if (!state.speakingUtterance) speakNext();
}

async function speakNext() {
  if (!state.speakQueue.length) {
    state.speaking = false;
    state.speakingUtterance = null;
    state.currentSpokenText = "";
    state.lastSpeechEndedAt = Date.now();
    if (!state.active) dom.interruptBtn.disabled = true;
    if (!state.thinking && state.active) {
      setAgentState("Listening", "listening");
      setTurn("Listening for your next question.");
    }
    return;
  }

  const text = state.speakQueue.shift();
  state.currentSpokenText = text;
  state.recentSpokenText = `${state.recentSpokenText} ${text}`.slice(-1800);
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
  state.currentSpokenText = text;
  state.recentSpokenText = `${state.recentSpokenText} ${text}`.slice(-1800);
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
      const previous = dom.ttsProvider.value;
      dom.ttsProvider.value = "browser";
      enqueueSpeech(text);
      dom.ttsProvider.value = previous;
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
dom.textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = dom.textInput.value.trim();
  dom.textInput.value = "";
  sendUserTurn(text);
});

updateProviderStatus();
if (!supportsSpeechRecognition()) {
  setTurn("Speech recognition unavailable. Typed fallback is ready.");
}
