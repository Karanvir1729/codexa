# Mainstream Voice To Codexa Path

This document is the implementation map for the active voice agent path. It is intentionally function-level and variable-level so future changes reuse the existing bridge instead of creating duplicate runners, duplicate session stores, or a second Codex execution path.

## Runtime Choice

The only mainstream speech path is:

```text
voice_speech_path = supertone_parakeet
```

The old frontend-visible `current` path has been removed from the UI and TypeScript type surface. Backend compatibility still normalizes legacy `current` requests to `supertone_parakeet` so stale local storage or old API callers do not break a live demo, but no new UI should expose `current`.

The mainstream stack is:

```text
Browser voice UI
  -> Pipecat SmallWebRTC
  -> FastAPI voice backend
  -> OpenRouter STT using nvidia/parakeet-tdt-0.6b-v3
  -> NVIDIA/OpenAI-compatible chat model for runtime tool choice
  -> Codexa HTTP bridge for planning/approval/Codex execution
  -> Supertonic local HTTP TTS
  -> Pipecat SmallWebRTC audio out
```

Live local service map:

```text
Browser app and API origin: https://localhost:5173
Codexa backend API:         http://127.0.0.1:4317
Codexa operator UI:         http://127.0.0.1:4318
Supertonic TTS server:      http://127.0.0.1:7788
OpenRouter STT endpoint:    https://openrouter.ai/api/v1/audio/transcriptions
```

Do not put real API keys in this document. Store them in ignored local environment files only.

## Required Configuration

Source: `backend/app/config.py`, class `Settings`.

Mainstream speech path fields:

```python
voice_runtime = "local_pipecat"
voice_behavior_mode = "assistant"
voice_flow_id = "active"
voice_speech_path = "supertone_parakeet"
local_stt_provider = "openrouter"
openrouter_base_url = "https://openrouter.ai/api/v1"
openrouter_stt_model = "nvidia/parakeet-tdt-0.6b-v3"
local_tts_provider = "supertonic"
supertonic_base_url = "http://127.0.0.1:7788"
supertonic_endpoint = "/v1/tts"
supertonic_model = "supertonic-3"
supertonic_voice = "M1"
supertonic_language = "na"
supertonic_steps = 8
supertonic_speed = 1.05
supertonic_max_chunk_length = 300
supertonic_silence_duration = 0.3
supertonic_response_format = "wav"
codex_orchestrator_enabled = True
codex_orchestrator_base_url = "http://127.0.0.1:4317"
```

The exact normalizer is `settings_for_speech_path(settings, speech_path)` in `backend/app/config.py`.

Behavior:

```text
None, "", or "current" -> "supertone_parakeet"
"supertone_parakeet" -> "supertone_parakeet"
anything else -> ValueError
```

The normalizer also forces:

```python
local_tts_provider = "supertonic"
local_tts_voice = settings.supertonic_voice
local_tts_language = settings.supertonic_language
local_tts_text_aggregation_mode = "sentence"
local_audio_output_sample_rate = 44100
```

Demo example config lives in `.env.demo.example`. `.env.example` stays as the
free/local development baseline.

```text
VOICE_SPEECH_PATH=supertone_parakeet
LOCAL_STT_PROVIDER=openrouter
OPENROUTER_STT_MODEL=nvidia/parakeet-tdt-0.6b-v3
SUPERTONIC_BASE_URL=http://127.0.0.1:7788
CODEX_ORCHESTRATOR_ENABLED=true
CODEX_ORCHESTRATOR_BASE_URL=http://127.0.0.1:4317
```

## Frontend Path

Primary files:

```text
frontend/src/App.tsx
frontend/src/FlowStudio.tsx
frontend/src/api.ts
frontend/src/browserAudioMediaManager.ts
```

Usable state in `frontend/src/App.tsx`:

```ts
speechPath: VoiceSpeechPath
voiceMode: "assistant" | "flow"
voiceInputMode: "vad" | "push_to_talk"
conversationId: string
voicePhase: "Idle" | "Listening" | "Processing" | "Speaking"
voiceRuntime: VoiceRuntimeProfileResponse | null
voicePreflight: VoicePreflight | null
codexSyncedFlowchart: VoiceCodexStatusResponse["flowchart"] | null
variableBadges: Array<{ id: string; key: string; before: unknown; after: unknown }>
turns: Array<{ id: string; role: "user" | "assistant"; content: string }>
```

The speech path type is now:

```ts
export type VoiceSpeechPath = "supertone_parakeet";
```

The `Current` speech-path button has been removed from both `App.tsx` and `FlowStudio.tsx`. The active UI option is Supertonic.

Frontend API functions in `frontend/src/api.ts`:

```ts
getHealth()
getVoicePreflight(voiceSpeechPath)
prepareVoice(voiceSpeechPath)
getWebRTCIceConfig()
getVoiceRuntimeProfile()
runVoiceTextTurn(payload)
synthesizeVoiceTextAudio(payload)
getVoiceCodexOrchestratorStatus(conversationId)
runVoiceTextSuite(payload)
```

Live WebRTC connect path:

```text
App.tsx connect handler
  -> prepareVoice(speechPath)
  -> getWebRTCIceConfig()
  -> new SmallWebRTCTransport(...)
  -> new PipecatClient(...)
  -> client.connect({
       requestData: {
         conversation_id,
         voice_behavior_mode: voiceMode,
         voice_flow_id,
         voice_speech_path: speechPath,
         input_mode: voiceInputMode
       }
     })
  -> POST /api/offer
```

Important frontend events:

```text
RTVIMessage type "user-transcription" appends user transcript turns.
RTVIMessage type "bot-transcription" appends assistant turns.
Remote audio track is attached through BrowserAudioMediaManager.
Codexa status/flowchart refresh uses getVoiceCodexOrchestratorStatus(conversationId).
Variable badge popups compare runtime profile snapshots and then expire.
```

## Backend HTTP Endpoints

Source: `backend/app/main.py`.

Mainstream voice endpoints:

```text
GET  /health
GET  /api/voice/preflight?voice_speech_path=supertone_parakeet
POST /api/voice/prepare
GET  /api/webrtc/ice-config
POST /api/offer
PATCH /api/offer
GET  /api/voice/runtime-profile
POST /api/voice/text-test/turn
POST /api/voice/text-test/audio
POST /api/voice/text-test/run
GET  /api/voice/codex-orchestrator/status?conversation_id=...
```

Endpoint details:

```text
/health
  Returns effective providers and settings, including:
  voice_speech_path, local_stt_provider, local_tts_provider,
  codex_orchestrator_enabled, codex_orchestrator_base_url.

/api/voice/preflight
  Calls settings_for_speech_path(...).
  Checks OpenRouter STT model availability when LOCAL_STT_PROVIDER=openrouter.
  Checks Supertonic health when LOCAL_TTS_PROVIDER=supertonic.

/api/voice/prepare
  Calls settings_for_speech_path(...).
  Prepares LLM runtime and dependency readiness before connect.

/api/offer
  Receives SmallWebRTC offer from the browser.
  Reads requestData.voice_speech_path and normalizes it.
  Starts run_browser_pipecat_voice_agent(...).

/api/voice/text-test/turn
  Runs the full assistant/Codexa logic with text as assumed STT.
  This is the safest deterministic test surface for the full plan-first bridge.

/api/voice/text-test/audio
  Synthesizes the returned assistant/Codexa text through Supertonic.
  This endpoint intentionally requires the Supertonic path.

/api/voice/codex-orchestrator/status
  Pulls Codexa session status and filtered flowchart state for one voice conversation.
```

## Live Pipecat Pipeline

Primary file: `backend/app/local_voice_runtime.py`.

Entry point for browser voice:

```python
run_browser_pipecat_voice_agent(
    webrtc_connection,
    settings,
    db,
    prompt_repo,
    session_id,
    voice_behavior_mode,
    voice_flow_id,
    input_mode,
)
```

This creates:

```python
LocalVoiceConversationRecorder(
    channel="browser_pipecat",
    transport_name="pipecat.smallwebrtc",
    conversation_id=session_id,
)
SmallWebRTCTransport(
    audio_in_enabled=True,
    audio_out_enabled=True,
    audio_in_sample_rate=settings.local_audio_input_sample_rate,
    audio_out_sample_rate=settings.local_audio_output_sample_rate,
    audio_out_10ms_chunks=settings.local_audio_output_10ms_chunks,
    audio_out_end_silence_secs=settings.local_audio_output_end_silence_secs,
    audio_in_passthrough=True,
)
```

The main pipeline builder is `_run_voice_pipeline(...)`.

Important local runtime functions:

```python
require_openai_compatible_llm(settings)
build_system_instruction(settings, prompt_repo)
create_local_stt_service(settings)
create_local_tts_service(settings)
load_runtime_profile(db, settings)
save_runtime_profile(db, profile)
runtime_command_context(profile, settings, user_text, codex_session_active=...)
parse_voice_runtime_command(text)
fallback_runtime_command_for_request(...)
execute_voice_runtime_actions(...)
render_expression_tags(...)
```

STT is selected by:

```python
create_local_stt_service(settings)
```

For the mainstream path:

```python
settings.local_stt_provider == "openrouter"
```

This returns:

```python
("openrouter", OpenRouterSTTService(...))
```

TTS is selected by:

```python
create_local_tts_service(settings)
```

For the mainstream path:

```python
settings.local_tts_provider == "supertonic"
```

This returns:

```python
("supertonic", SupertonicTTSService(...))
```

The streaming LLM service is created as:

```python
VoiceOpenAILLMService(
    api_key=settings.active_api_key,
    base_url=settings.active_base_url,
    settings=OpenAILLMService.Settings(
        model=settings.active_model,
        system_instruction=build_system_instruction(settings, prompt_repo),
        temperature=settings.llm_temperature,
        top_p=settings.llm_top_p,
        max_tokens=settings.max_completion_tokens,
    ),
)
```

## OpenRouter Parakeet STT

Primary file: `backend/app/openrouter_stt.py`.

Usable class and methods:

```python
OpenRouterSTTOptions
OpenRouterSTTService
OpenRouterSTTService.run_stt(audio)
OpenRouterSTTService._transcribe(audio)
```

Mainstream constructor variables:

```python
base_url=settings.openrouter_base_url
api_key=settings.openrouter_api_key
model=settings.openrouter_stt_model
language=_language_or_auto(settings.local_stt_language or settings.local_voice_language)
temperature=settings.local_stt_temperature
sample_rate=settings.local_audio_input_sample_rate
timeout_seconds=settings.openrouter_stt_timeout_seconds
site_url=settings.openrouter_site_url
app_title=settings.openrouter_app_title
```

Request shape sent to OpenRouter:

```json
{
  "model": "nvidia/parakeet-tdt-0.6b-v3",
  "input_audio": {
    "data": "base64-wav-audio",
    "format": "wav"
  },
  "language": "optional-language",
  "temperature": 0
}
```

Response handling:

```text
run_stt()
  -> _transcribe()
  -> response.json()
  -> text = result["text"].strip()
  -> yield TranscriptionFrame(text, user_id, timestamp, language, result)
```

The Pipecat transcript frame then reaches the user transcript capture in `_run_voice_pipeline`, which records the user turn through `LocalVoiceConversationRecorder.record_turn(...)`.

## Supertonic TTS

Primary file: `backend/app/supertonic_tts.py`.

Usable class and methods:

```python
SupertonicTTSService
create_supertonic_tts_service(settings, text_aggregation_mode=None)
supertonic_healthcheck(settings)
SupertonicTTSService.warmup()
SupertonicTTSService.run_tts(text, context_id)
SupertonicTTSService.apply_runtime_profile(profile)
SupertonicTTSService.current_params()
SupertonicTTSService.drain_render_history()
SupertonicTTSService.last_payload()
```

Mainstream constructor variables:

```python
base_url=settings.supertonic_base_url
endpoint=settings.supertonic_endpoint
model=settings.supertonic_model
voice=settings.supertonic_voice
language=settings.supertonic_language
steps=settings.supertonic_steps
speed=settings.supertonic_speed
max_chunk_length=settings.supertonic_max_chunk_length
silence_duration=settings.supertonic_silence_duration
response_format=settings.supertonic_response_format
timeout_seconds=settings.supertonic_timeout_seconds
sample_rate=settings.local_audio_output_sample_rate
expression_mode=settings.supertonic_expression_mode
max_expression_tags_per_utterance=settings.supertonic_max_expression_tags_per_utterance
```

Supertonic request shape:

```json
{
  "text": "rendered assistant text",
  "voice": "M1",
  "lang": "na",
  "steps": 8,
  "speed": 1.05,
  "max_chunk_length": 300,
  "silence_duration": 0.3,
  "response_format": "wav"
}
```

Audio handling:

```text
run_tts()
  -> render_expression_tags(...)
  -> POST http://127.0.0.1:7788/v1/tts
  -> _decode_wav(...)
  -> verify mono 16-bit WAV
  -> resample to output sample rate when needed
  -> yield TTSAudioRawFrame(...)
```

Runtime speed changes are applied through `SupertonicTTSService.apply_runtime_profile(...)` and `set_speed(...)`. The model does not hardcode “faster” or “slower”; it emits runtime actions such as:

```json
{"tool":"increment_tts_speed","args":{"delta":-0.2,"reason":"user_requested_slower_speech"}}
```

The executor updates the runtime profile, and the live TTS service consumes the updated profile.

## Runtime Tool Protocol

Primary files:

```text
backend/app/voice_self_observe.py
backend/app/voice_runtime_executor.py
backend/app/voice_runtime_controls.py
```

Model prompt builder:

```python
runtime_command_context(
    profile,
    settings,
    user_text,
    codex_session_active=False,
)
```

Allowed tool names when Codexa is enabled:

```text
set_tts_speed
increment_tts_speed
set_expression_mode
set_response_length
set_model_profile
get_voice_runtime_status
delegate_to_codex_orchestrator
get_codex_orchestrator_status
```

Required Codexa tool shape:

```json
{
  "tool": "delegate_to_codex_orchestrator",
  "args": {
    "goal": "user_goal",
    "mode": "plan_first",
    "reason": "brief_reason"
  }
}
```

Status tool shape:

```json
{
  "tool": "get_codex_orchestrator_status",
  "args": {
    "reason": "brief_reason"
  }
}
```

Execution function:

```python
execute_voice_runtime_actions(
    db,
    settings,
    profile,
    actions,
    conversation_id,
    user_text,
    transcript,
    bridge=None,
)
```

Execution behavior:

```text
1. Split sync runtime actions from Codexa actions.
2. Reject TTS speed actions unless voice_speed_intent(user_text) detects a speed request.
3. Apply local TTS/runtime actions through execute_runtime_actions(...).
4. Route Codexa actions through CodexOrchestratorBridge.
5. Return VoiceRuntimeExecution with:
   - updated profile
   - action statuses
   - optional response_text from Codexa
   - codex metadata
```

## Voice To Codexa Bridge

Primary file: `backend/app/codex_orchestrator.py`.

Runtime tool names:

```python
CODEX_ORCHESTRATOR_RUNTIME_TOOLS = {
    "delegate_to_codex_orchestrator",
    "get_codex_orchestrator_status",
}
```

Usable intent detectors:

```python
is_codex_approval_response(text)
is_codex_status_request(text)
is_codex_task_request(text)
is_codex_orchestrator_request(text)
has_codex_orchestrator_session(db, conversation_id)
```

Bridge class:

```python
class CodexOrchestratorBridge:
    load_mapping(conversation_id)
    health()
    delegate(conversation_id, user_text, transcript, mode="plan_first")
    status(conversation_id)
    flowchart(conversation_id)
```

Stored bridge mapping table:

```sql
codex_orchestrator_sessions(
  conversation_id TEXT PRIMARY KEY,
  codex_session_id TEXT,
  codex_project_id TEXT,
  codex_task_id TEXT,
  codex_worker_id TEXT,
  requires_approval INTEGER,
  approval_id TEXT,
  last_status TEXT,
  last_response TEXT,
  metadata_json TEXT,
  created_at TEXT,
  updated_at TEXT
)
```

Plan-first first-turn packaging:

```python
CodexOrchestratorBridge._codexa_text(
    conversation_id,
    user_text,
    transcript,
    mode,
)
```

Generated instruction includes:

```text
Codexa voice bridge request. Take my recent chatlogs and decide what the user is asking for.
Plan-first rule: ask concise Codexa planning questions as needed. If enough detail is known,
give the final plan and ask for explicit approval. Do not start implementation, create files,
modify files, deploy, install packages, or run Codex implementation until the user explicitly approves
after hearing the final plan.
Voice conversation id: ...
Recent chatlogs:
...
Latest user request: ...
```

HTTP payload to Codexa:

```json
{
  "user_id": "voice-agent:{conversation_id}",
  "channel": "web_voice",
  "text": "plan-first packaged text or exact follow-up text",
  "timestamp": "ISO timestamp",
  "external_conversation_id": "{conversation_id}",
  "session_id": "existing Codexa session id when mapped",
  "project_id": "existing Codexa project id when mapped"
}
```

Bridge calls:

```text
GET  {codex_orchestrator_base_url}/health
POST {codex_orchestrator_base_url}/agent/chat
GET  {codex_orchestrator_base_url}/codex/status?session_id=...
GET  {codex_orchestrator_base_url}/orchestrator/flowchart
```

The bridge compacts status and flowchart data before returning it to the voice UI. Approval ids prefer the live pending action from Codexa over stale stored mapping values.

## Text Voice Test Path

Primary file: `backend/app/voice_text_test.py`.

Entry point:

```python
run_voice_text_turn(
    message,
    conversation_id,
    settings,
    db,
    prompt_repo,
    agent,
    flow_runtime,
    voice_behavior_mode="assistant",
    input_mode="push_to_talk",
)
```

Purpose:

```text
Use text as assumed STT, run the same runtime tools and Codexa bridge,
record turns/events/latency, and optionally synthesize the returned text
through /api/voice/text-test/audio.
```

Important data returned to the frontend:

```json
{
  "conversation_id": "...",
  "message": "assistant or Codexa text",
  "runtime_actions": [],
  "runtime_action_status": [],
  "codex": {
    "codex_session_id": "...",
    "codex_project_id": "...",
    "requires_approval": true,
    "approval_id": "approve_megaplan"
  },
  "providers": {
    "runtime_action_source": "codex-orchestrator",
    "voice_speech_path": "supertone_parakeet",
    "configured_stt_provider": "openrouter",
    "configured_tts_provider": "supertonic"
  }
}
```

Audio endpoint:

```python
build_voice_text_tts_payload(settings, profile, text, user_text="")
```

This requires `settings.local_tts_provider == "supertonic"`.

## Codexa HTTP Flow

Codexa source checkout used for this integration:

```text
/private/tmp/codexa-karan-changes.6iwUhv
```

Main Codexa API file:

```text
codex-phone-supervisor/backend/src/index.ts
```

HTTP entrypoint used by voice:

```ts
app.post("/agent/chat", async (req, res) => {
  const result = await handleUserMessage({
    userId,
    channel,
    text,
    timestamp,
    sessionId,
    projectId,
    externalConversationId,
  });
  res.json(result);
});
```

Codexa agent entry:

```ts
handleUserMessage(message)
```

Source:

```text
codex-phone-supervisor/backend/src/agent-core.ts
```

Flow:

```text
handleUserMessage(...)
  -> validate userId/channel/text/timestamp
  -> resolveSession(message)
     -> existing session_id if provided
     -> project.last_active_session_id if project_id provided
     -> createDiscoverySession(message) otherwise
  -> handleSupervisorMessage(session.session_id, message.text, message.channel)
  -> return {
       text,
       sessionId,
       projectId,
       taskId,
       workerId,
       requiresApproval,
       approvalId
     }
```

Supported channel for this bridge:

```text
web_voice
```

## Codexa Supervisor Flow

Primary file:

```text
codex-phone-supervisor/backend/src/supervisor-tools.ts
```

Main function:

```ts
handleSupervisorMessage(sessionId, text, channel)
```

High-level order:

```text
1. Load session with getSession(sessionId).
2. rememberConversationMessage(session, "user", cleaned, channel).
3. syncConversationState(session).
4. upsertSession(session).
5. appendAuditEvent(...).
6. appendOrchestratorEvent(session.message.received).
7. appendOrchestratorEvent(orchestrator.decision.started).
8. handlePendingConversationAction(session, cleaned, channel).
9. handleConversationControl(session, cleaned, channel).
10. handleNewProjectIntent(session, cleaned).
11. handleProjectDiscovery(...) if project is not selected.
12. answerStateQuestion(session, cleaned).
13. readOnlyConversationResponse(cleaned).
14. approval follow-up handling.
15. startWorkerBackedProject(...) or handleDevelopmentTurn(...).
16. finalConversationResponse(...).
```

Reusable Codexa tools/hooks:

```ts
list_projects()
select_project(projectId, sessionId)
get_codex_status(sessionId)
get_codex_events(sessionId)
get_codex_summary(sessionId)
get_codex_access_summary(sessionId)
send_codex_instruction(sessionId, instruction)
create_project(sessionId, projectName, description, options)
respond_to_approval(sessionId, approvalId, decision, channel)
approve_action(approvalId, sessionId, channel)
deny_action(approvalId, sessionId, channel)
handleSupervisorMessage(sessionId, text, channel)
```

Project intake path:

```text
handleNewProjectIntent(...)
  -> resolveProjectIntake(...)
  -> create_project(...)
  -> ensureNewProjectDirectory(...)
  -> ensureLocalGitRepository(...)
  -> ensureGitHubRepositoryForProject(...) when enabled
  -> upsertProject(...)
  -> select_project(...)
```

Planning path:

```text
handleDevelopmentTurn(...) or startWorkerBackedProject(...)
  -> agenticPlanningController.decide(...)
  -> queueLocalMegaplanApproval(...) when worker mode is codex_session_local
  -> writeMegaplan(...)
  -> setPendingAction(type="approve_megaplan")
```

Pending clarification path:

```text
handlePendingConversationAction(...)
  -> if pending.type == "clarify_requirements":
       expandResearchClarificationAnswer(...)
       updatedGoal = original_user_goal + "Technical requirements from user: ..."
       agenticPlanningController.decide(...)
       queueLocalMegaplanApproval(...) or ask again
```

The research-loop fix lives here:

```ts
isResearchClarificationContext(session, pending)
expandResearchClarificationAnswer(session, pending, text)
```

`"Yes."` in a pending research clarification expands to:

```text
Conduct product, domain, UX, and technical research before the Megaplan.
Use reasonable comparable websites and current best practices if the user did not name sources.
```

## Codexa Planner Flow

Primary file:

```text
codex-phone-supervisor/backend/src/agentic-planning.ts
```

Main object:

```ts
agenticPlanningController
```

Important functions:

```ts
parsePlannerDecision(value)
detectConversationPressure(input)
hasResearchDecision(input)
needsResearchClarification(input, decision)
enforceResearchClarification(input, decision)
adaptDecisionForConversationPressure(input, decision)
optimizePlannerDecisionForSpeed(input, decision)
agenticPlanningController.decide(...)
agenticPlanningController.approvedPlan(decision, channel)
agenticPlanningController.createApprovedGraphAndStart(...)
```

Planner decision fields:

```ts
planning_decision_id
decision_type
confidence
reason
user_visible_response
requirements_summary
open_questions
assumptions
proposed_design
proposed_task_split
recommended_worker_count
recommended_worker_mode
requires_user_approval
approval_reason
risk_level
next_action
execution_allowed
subagent_advice
```

Research decision detection accepts:

```text
no research
skip research
without research
do not research
research first
do research
conduct research
competitor research
product research
domain research
UX research
look up
browse
search the web
how other/similar/competitor websites look/work/feel/are designed
bare yes/no answers when the pending assistant context is a research question before Megaplan
```

If research preference is missing for a relevant product/app build, `enforceResearchClarification(...)` asks:

```text
Before I write the Megaplan, should Codex conduct product, domain, UX, or technical research first?
If yes, tell me the topics or sources that matter; otherwise I will proceed without research.
```

The voice bridge must pass user follow-ups back to the same Codexa session so `handlePendingConversationAction(...)` can resolve that pending question instead of starting a new planning session.

## Megaplan Approval And Codex Execution

Local Codex mode constant:

```ts
LOCAL_CODEX_BACKEND = "codex_session_local"
```

Megaplan approval queue:

```ts
queueLocalMegaplanApproval({
  session,
  project,
  userGoal,
  decision,
  selectedExistingProject,
})
```

This function:

```text
1. Adds subagent advice with withSubagentAdvice(...).
2. Forces recommended_worker_mode to codex_session_local.
3. Forces recommended_worker_count to 1.
4. Forces requires_user_approval=true.
5. Writes MEGAPLAN.md with writeMegaplan(...).
6. Sets pending_action.type="approve_megaplan".
7. Sets session.current_status="waiting_for_approval".
8. Sets session.approval_status="pending".
```

Approval follow-up path:

```text
Voice user says "approve"
  -> voice runtime detects active Codexa session
  -> delegate_to_codex_orchestrator with exact user text
  -> CodexOrchestratorBridge.delegate(...)
  -> POST /agent/chat with session_id
  -> handleSupervisorMessage(...)
  -> handlePendingConversationAction(...)
  -> pending.type == "approve_megaplan"
  -> agenticPlanningController.approvedPlan(...)
  -> startLocalCodexSession(...)
```

Local Codex start:

```ts
startLocalCodexSession({
  session,
  project,
  userGoal,
  plannerDecision,
  approvedPlan,
})
```

This function:

```text
1. Builds the local Codex implementation prompt.
2. Creates a Codexa task.
3. Initializes .head-developer docs.
4. Marks the session running.
5. Emits local_codex_session.queued.
6. Starts completeLocalCodexRun(...) asynchronously.
```

Legacy direct instruction hook:

```ts
send_codex_instruction(sessionId, instruction)
```

Use it only when Codexa has already selected a project and the instruction is concrete. The voice bridge should normally use `/agent/chat`, not this hook directly.

## Flowchart Sync

Voice backend:

```python
CodexOrchestratorBridge.flowchart(conversation_id)
```

Codexa backend:

```ts
GET /orchestrator/flowchart
  -> buildFlowchartState()
```

Voice bridge filtering:

```text
_filter_flowchart(raw, mapping)
  -> keep nodes mentioning codex_session_id, codex_project_id, codex_task_id, or codex_worker_id
  -> compact node detail
  -> keep edges where both endpoints remain
  -> return at most 24 nodes and 48 edges
```

Frontend state:

```ts
codexSyncedFlowchart
```

Use this state to render the voice-agent screen flowchart after a Codex task starts or when status refresh returns Codexa nodes.

## Persistence And Observability

Voice SQLite tables:

```text
conversations
turns
interaction_events
latency_traces
codex_orchestrator_sessions
```

Recorder:

```python
LocalVoiceConversationRecorder
```

Usable methods:

```python
start()
update_metadata(patch)
record_turn(role, content, latency_ms=None, metrics=None)
transcript(limit=30)
record_latency_trace(...)
record_interaction_event(...)
```

Important recorded event names:

```text
user_transcribed
llm_request_started
llm_completed
voice_runtime_action_started
voice_runtime_action_completed
tts_simulated
supertonic_tts_request
```

Runtime profile storage:

```python
load_runtime_profile(db, settings)
save_runtime_profile(db, profile)
merge_runtime_profile(settings, stored)
default_runtime_profile(settings)
voice_runtime_status(profile)
```

Runtime profile fields the UI can safely display:

```text
active_model_profile
llm.current_model
tts.provider
tts.voice
tts.speed
tts.steps
tts.max_chunk_length
tts.silence_duration
tts.expression_mode
latency.last_first_audio_ms
latency.rolling_avg_first_audio_ms
turn_taking.vad_enabled
turn_taking.push_to_talk_enabled
quality.recent_failure_types
debug.last_supertonic_payload
debug.last_codex_orchestrator
```

## Testing Surface

Backend unit tests:

```bash
PYTHONPATH=backend pytest backend/tests/test_feedback_loop.py
PYTHONPATH=backend pytest backend/tests/test_codex_orchestrator.py
PYTHONPATH=backend pytest backend/tests/test_voice_text_test.py
PYTHONPATH=backend pytest backend/tests
```

Frontend typecheck:

```bash
cd frontend && npx tsc --noEmit
```

Codexa tests from the Codexa checkout:

```bash
cd /private/tmp/codexa-karan-changes.6iwUhv
npm run typecheck
npm test
```

Live smoke checks:

```bash
curl -skS https://localhost:5173/health
curl -skS 'https://localhost:5173/api/voice/preflight?voice_speech_path=supertone_parakeet'
curl -sS http://127.0.0.1:4317/health
curl -skS 'https://localhost:5173/api/voice/codex-orchestrator/status?conversation_id=...'
```

Text voice Codexa smoke:

```bash
curl -skS -X POST https://localhost:5173/api/voice/text-test/turn \
  -H 'Content-Type: application/json' \
  --data '{"message":"Build a simple website for my plumbing tools business.","voice_speech_path":"supertone_parakeet","voice_behavior_mode":"assistant"}'
```

Text TTS smoke:

```bash
curl -skS -o /tmp/voice-text-audio.wav \
  -X POST https://localhost:5173/api/voice/text-test/audio \
  -H 'Content-Type: application/json' \
  --data '{"text":"Codexa is ready for approval.","voice_speech_path":"supertone_parakeet"}'
test -s /tmp/voice-text-audio.wav
```

## Rules For Future Changes

Use the existing bridge:

```text
Voice task intent -> delegate_to_codex_orchestrator -> CodexOrchestratorBridge -> /agent/chat
```

Do not add:

```text
another Codex runner in the voice repo
another Codexa session table
another approval model
another hardcoded planning script
another non-Supertonic mainstream speech path
```

When adding a feature:

```text
1. Put voice/UI runtime state in the runtime profile when it changes during a call.
2. Put Codexa project/session/task identity in codex_orchestrator_sessions.
3. Put actual project planning/execution in Codexa.
4. Keep implementation gated behind approve_megaplan.
5. Keep TTS through Supertonic for audible browser and text-test paths.
6. Add a text-test case first, then live WebRTC smoke.
```
