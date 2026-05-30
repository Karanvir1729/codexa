from __future__ import annotations

import time
import uuid
import sqlite3
from dataclasses import dataclass, field
from typing import Any, Mapping

from .codex_orchestrator import has_codex_orchestrator_session
from .config import Settings, get_settings
from .db import Database, dumps, loads
from .feedback import FeedbackLearner, PromptRepository
from .flow_runtime import FlowRepository, FlowRuntime
from .llm import make_llm_client
from .voice_runtime_controls import (
    VOICE_EMOTION_CODES,
    consume_emotion_prefix,
    emotion_code_for_tone,
    emotion_code_for_turn,
    next_voice_speed,
    prefix_emotion_code,
    voice_speed_intent,
    voice_speed_label,
    voice_tone_intent,
)
from .voice_self_observe import (
    VoiceInputMode,
    apply_runtime_adaptation,
    build_learning_record,
    choose_model_profile,
    classify_voice_turn,
    clean_angle_tags,
    fallback_runtime_command_for_request,
    fallback_voice_runtime_speak,
    is_voice_tool_request,
    likely_bad_transcript,
    load_runtime_profile,
    max_tokens_for_profile,
    model_for_profile,
    parse_voice_runtime_command,
    runtime_command_context,
    save_runtime_profile,
)
from .voice_runtime_executor import execute_voice_runtime_actions


_CODEX_PROJECT_SELECTION_PROMPTS = (
    "which project do you mean",
    "which project should i attach",
    "please name an existing project",
)


def rtvi_user_speaking_message(started: bool) -> dict[str, str]:
    return {
        "label": "rtvi-ai",
        "type": "user-started-speaking" if started else "user-stopped-speaking",
    }


def _normalize_voice_phrase(text: str) -> str:
    return " ".join(text.casefold().replace(".", " ").replace("?", " ").replace("!", " ").split())


def _repair_codex_project_selection_transcript(text: str, last_codex_response: str | None) -> str:
    normalized_response = _normalize_voice_phrase(last_codex_response or "")
    if not any(prompt in normalized_response for prompt in _CODEX_PROJECT_SELECTION_PROMPTS):
        return text
    normalized = _normalize_voice_phrase(text)
    if normalized in {"no one", "no 1", "new won", "new one", "a new one"}:
        return "New one."
    if normalized in {"what is the work", "whats the work", "what's the work", "what was the work"}:
        return "Create a new project."
    return text


def _last_unselected_codex_response(db: Database, conversation_id: str) -> str | None:
    row = db.one(
        """
        SELECT last_response, codex_project_id
        FROM codex_orchestrator_sessions
        WHERE conversation_id = ?
        """,
        (conversation_id,),
    )
    if not row or row["codex_project_id"]:
        return None
    return row["last_response"]


def _empty_live_voice_response(user_text: str) -> str:
    normalized = user_text.strip().lower().strip(" .!?")
    if normalized in {"hi", "hello", "hey"}:
        return "I'm here."
    if normalized:
        return "I heard you."
    return fallback_voice_runtime_speak("")


@dataclass
class LocalVoiceConversationRecorder:
    db: Database
    settings: Settings
    prompt_version: int
    channel: str = "local_pipecat"
    transport_name: str = "pipecat.local_audio"
    conversation_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    _last_recorded_turn: dict[str, tuple[str, float]] = field(default_factory=dict, init=False)

    def start(self) -> None:
        self.db.execute(
            """
            INSERT OR IGNORE INTO conversations(id, channel, metadata_json)
            VALUES (?, ?, ?)
            """,
            (
                self.conversation_id,
                self.channel,
                dumps(
                    {
                        "llm_provider": self.settings.llm_provider,
                        "model": self.settings.active_model,
                        "stt_provider": self.settings.local_stt_provider,
                        "stt_model": self.settings.local_stt_model,
                        "stt_language": self.settings.local_stt_language,
                        "tts_provider": self.settings.local_tts_provider,
                        "tts_voice": self.settings.local_tts_voice,
                        "voice_speech_path": self.settings.voice_speech_path,
                        "nvidia_asr_url": self.settings.nvidia_asr_url,
                        "nemotron_llm_url": self.settings.nemotron_llm_url,
                        "gradium_tts_model": self.settings.gradium_tts_model,
                        "gradium_tts_voice_id": self.settings.gradium_tts_voice_id,
                        "transport": self.transport_name,
                        "voice_behavior_mode": self.settings.voice_behavior_mode,
                        "voice_flow_id": self.settings.voice_flow_id,
                    }
                ),
            ),
        )

    def update_metadata(self, patch: dict[str, Any]) -> None:
        row = self.db.one(
            "SELECT metadata_json FROM conversations WHERE id = ?",
            (self.conversation_id,),
        )
        metadata = loads(row["metadata_json"], {}) if row else {}
        if not isinstance(metadata, dict):
            metadata = {}
        metadata.update(patch)
        self.db.execute(
            "UPDATE conversations SET metadata_json = ? WHERE id = ?",
            (dumps(metadata), self.conversation_id),
        )

    def record_turn(
        self,
        role: str,
        content: str,
        *,
        latency_ms: int | None = None,
        metrics: dict[str, Any] | None = None,
    ) -> str:
        text = content.strip()
        if not text:
            return ""
        normalized = " ".join(text.casefold().split())
        now = time.perf_counter()
        last = self._last_recorded_turn.get(role)
        if last and last[0] == normalized and now - last[1] <= 1.25:
            return ""
        self._last_recorded_turn[role] = (normalized, now)
        turn_id = str(uuid.uuid4())
        self.start()
        self.db.execute(
            """
            INSERT INTO turns(id, conversation_id, role, content, latency_ms, model, prompt_version, metrics_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                turn_id,
                self.conversation_id,
                role,
                text,
                latency_ms,
                self.settings.active_model if role == "assistant" else None,
                self.prompt_version if role == "assistant" else None,
                dumps(metrics or {}),
            ),
        )
        return turn_id

    def transcript(self, limit: int = 30) -> list[dict[str, Any]]:
        rows = self.db.all(
            """
            SELECT role, content, created_at
            FROM turns
            WHERE conversation_id = ?
              AND role IN ('user', 'assistant', 'system')
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (self.conversation_id, limit),
        )
        return [
            {"role": row["role"], "content": row["content"], "created_at": row["created_at"]}
            for row in rows
        ]

    def record_latency_trace(
        self,
        *,
        interaction_id: str,
        user_turn_id: str | None,
        assistant_turn_id: str | None,
        providers: dict[str, Any],
        timings: dict[str, Any],
    ) -> str:
        trace_id = str(uuid.uuid4())
        self.start()
        user_turn_id = user_turn_id if user_turn_id and self.db.one("SELECT 1 FROM turns WHERE id = ?", (user_turn_id,)) else None
        assistant_turn_id = (
            assistant_turn_id
            if assistant_turn_id and self.db.one("SELECT 1 FROM turns WHERE id = ?", (assistant_turn_id,))
            else None
        )
        query = """
        INSERT INTO latency_traces(
            id, conversation_id, interaction_id, channel, transport,
            user_turn_id, assistant_turn_id, providers_json, timings_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
        params = (
            trace_id,
            self.conversation_id,
            interaction_id,
            self.channel,
            self.transport_name,
            user_turn_id,
            assistant_turn_id,
            dumps(providers),
            dumps(timings),
        )
        try:
            self.db.execute(query, params)
        except sqlite3.IntegrityError:
            self.start()
            self.db.execute(query, (*params[:5], None, None, *params[7:]))
        return trace_id

    def record_interaction_event(
        self,
        *,
        interaction_id: str,
        event: str,
        role: str | None = None,
        text: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> str:
        event_id = str(uuid.uuid4())
        self.start()
        self.db.execute(
            """
            INSERT INTO interaction_events(
                id, conversation_id, interaction_id, channel, transport,
                event, role, text, payload_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                self.conversation_id,
                interaction_id,
                self.channel,
                self.transport_name,
                event,
                role,
                text,
                dumps(payload or {}),
            ),
        )
        return event_id


def require_openai_compatible_llm(settings: Settings) -> None:
    if settings.llm_provider == "mock":
        raise RuntimeError(
            "Local Pipecat voice needs a streaming-capable OpenAI-compatible LLM. "
            "Set LLM_PROVIDER=nemotron and NEMOTRON_LLM_URL to the hosted endpoint."
        )
    if not settings.active_base_url:
        raise RuntimeError("Active LLM provider is missing a base URL.")
    if settings.active_requires_api_key and not settings.active_api_key:
        raise RuntimeError("Active LLM provider is missing an API key.")


def openai_compatible_client_api_key(settings: Settings) -> str:
    return settings.active_api_key or "unused"


def build_system_instruction(settings: Settings, prompt_repo: PromptRepository) -> str:
    active_prompt = prompt_repo.active()
    learner = FeedbackLearner(
        prompt_repo.db,
        prompt_repo,
        settings.latency_target_ms,
    )
    learner_config = getattr(learner, "config", None)
    config = learner_config() if callable(learner_config) else {"enabled": True}
    instruction = active_prompt.compiled if config.get("enabled") else active_prompt.system_prompt
    try:
        hints = learner.derive_hints()
        existing_hints = {
            line.strip()
            for line in active_prompt.learned_hints.splitlines()
            if line.strip()
        }
        live_hints = [hint for hint in hints if hint.strip() and hint.strip() not in existing_hints]
    except Exception:
        live_hints = []
    if live_hints:
        instruction = f"{instruction}\n\nLive runtime hints:\n" + "\n".join(live_hints[:2])
    instruction = (
        f"{instruction}\n\n"
        "Live voice rules: answer immediately; default to one short spoken sentence unless the user asks for detail; "
        "use the user's requested language; ask one concise clarification when needed; do not mention "
        "internals unless asked. For normal replies, return plain spoken text. If a runtime-control "
        "system message is present, follow its JSON schema exactly. For Codex or Builder work, mention that "
        "the Builder page has the Megaplan for the longer summary. Never speak raw JSON, emotion "
        "prefixes, or expression tags."
    )
    if settings.local_tts_provider == "gradium":
        instruction = (
            f"{instruction}\n\n"
            "Gradium TTS: return clean spoken text. Do not write SSML, emotion tags, or audio markup."
        )
    if settings.reasoning_mode == "off":
        return f"/no_think\n{instruction}"
    return instruction


def _language_or_auto(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    if normalized in {"", "auto", "detect", "none", "null"}:
        return None
    return normalized


def resolve_stt_language(settings: Settings):
    from pipecat.transcriptions.language import Language

    code = _language_or_auto(settings.local_stt_language or settings.local_voice_language)
    return Language(code) if code else None


def resolve_tts_language(settings: Settings):
    from pipecat.transcriptions.language import Language

    code = _language_or_auto(settings.local_tts_language or settings.local_voice_language) or "en"
    return Language(code)


def _message_role(message: Any) -> str | None:
    if isinstance(message, Mapping):
        role = message.get("role")
        return role if isinstance(role, str) else None
    return None


def _message_content_text(message: Any) -> str | None:
    if isinstance(message, Mapping):
        content = message.get("content")
        return content if isinstance(content, str) else None
    return None


def merge_adjacent_chat_messages(messages: list[Any]) -> list[Any]:
    """Collapse adjacent same-role turns for chat templates that require alternation."""

    merged: list[Any] = []
    for message in messages:
        role = _message_role(message)
        text = _message_content_text(message)
        last = merged[-1] if merged else None
        last_role = _message_role(last)
        last_text = _message_content_text(last)
        if role in {"user", "assistant"} and text and last_role == role and last_text:
            merged[-1] = {**last, "content": f"{last_text.rstrip()}\n{text.strip()}"}
        else:
            merged.append(message)
    return merged


def trim_voice_chat_messages(messages: list[Any], *, max_messages: int, max_chars: int) -> list[Any]:
    """Keep voice prompts short enough for low-latency hosted models."""

    system_messages = [message for message in messages if _message_role(message) == "system"]
    chat_messages = [message for message in messages if _message_role(message) != "system"]
    kept = [*system_messages[:1], *chat_messages[-max_messages:]]
    trimmed: list[Any] = []
    for message in kept:
        text = _message_content_text(message)
        if text and len(text) > max_chars:
            role = _message_role(message)
            content = text[-max_chars:] if role == "user" else text[:max_chars]
            trimmed.append({**message, "content": content.strip()})
        else:
            trimmed.append(message)
    return trimmed


_LIVE_VOICE_REQUEST_MAX_MESSAGES = 16
_LIVE_VOICE_REQUEST_MAX_CHARS = 1400
_LIVE_VOICE_FILLER_TURNS = {
    "and",
    "okay",
    "ok",
    "mm hmm",
    "mhm",
    "uh",
    "um",
}


def _live_voice_recent_user_request(messages: list[Any], latest_user_text: str, settings: Settings) -> str:
    """Join contiguous STT fragments so live VAD pauses do not hide task intent."""

    fragments: list[str] = []
    for message in reversed(messages):
        role = _message_role(message)
        if role == "assistant":
            break
        if role != "user":
            continue
        text = (_message_content_text(message) or "").strip()
        if text:
            fragments.append(text)
        if len(fragments) >= _LIVE_VOICE_REQUEST_MAX_MESSAGES:
            break
    fragments.reverse()
    while len(fragments) > 1:
        normalized = " ".join(fragments[0].casefold().replace(".", " ").split())
        if normalized in _LIVE_VOICE_FILLER_TURNS:
            fragments.pop(0)
        else:
            break
    combined = " ".join(fragments).strip()
    if len(combined) > _LIVE_VOICE_REQUEST_MAX_CHARS:
        combined = combined[-_LIVE_VOICE_REQUEST_MAX_CHARS:].strip()
    if combined and combined != latest_user_text.strip() and is_voice_tool_request(combined, settings):
        return combined
    return latest_user_text


async def create_local_tts_service(settings: Settings):
    from pipecat.services.tts_service import TextAggregationMode

    text_aggregation_mode = (
        TextAggregationMode.TOKEN
        if settings.local_tts_text_aggregation_mode == "token"
        else TextAggregationMode.SENTENCE
    )
    from .gradium_voice import create_gradium_tts_service

    return "gradium", create_gradium_tts_service(
        settings,
        text_aggregation_mode=text_aggregation_mode,
    )


def create_local_stt_service(settings: Settings):
    from .nvidia_ws_stt import NvidiaWebSocketSTTService

    return "nvidia_ws", NvidiaWebSocketSTTService(
        url=settings.nvidia_asr_url,
        sample_rate=settings.local_audio_input_sample_rate,
        stt_ttfb_timeout=settings.local_stt_ttfb_timeout,
        ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
        strip_interim_prefix=settings.nvidia_asr_strip_interim_prefix,
        preroll_seconds=settings.nvidia_asr_preroll_seconds,
        ws_ping_interval=settings.nvidia_asr_ws_ping_interval,
        ws_ping_timeout=settings.nvidia_asr_ws_ping_timeout,
    )


async def _run_voice_pipeline(
    *,
    settings: Settings,
    db: Database,
    prompt_repo: PromptRepository,
    recorder: LocalVoiceConversationRecorder,
    transport,
    handle_sigint: bool,
    voice_behavior_mode: str | None = None,
    voice_flow_id: str | None = None,
    input_mode: VoiceInputMode = "vad",
    pipeline_idle_timeout_secs: float | None = 300,
) -> None:
    from loguru import logger
    from openai import NOT_GIVEN
    from pipecat.frames.frames import (
        ErrorFrame,
        Frame,
        InterruptionFrame,
        LLMFullResponseEndFrame,
        LLMFullResponseStartFrame,
        TextFrame,
        TTSAudioRawFrame,
        TTSStoppedFrame,
        TranscriptionFrame,
        OutputTransportMessageUrgentFrame,
        VADUserStartedSpeakingFrame,
        VADUserStoppedSpeakingFrame,
    )
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.turns.user_start import TranscriptionUserTurnStartStrategy, VADUserTurnStartStrategy
    from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies

    effective_voice_behavior_mode = (
        voice_behavior_mode if voice_behavior_mode in {"assistant", "flow"} else settings.voice_behavior_mode
    )
    logger.info(
        f"Starting local voice pipeline: speech_path={settings.voice_speech_path} "
        f"behavior={effective_voice_behavior_mode} input_mode={input_mode}"
    )
    effective_input_mode = input_mode
    effective_voice_flow_id = (voice_flow_id or settings.voice_flow_id).strip() or "active"
    recorder.update_metadata(
        {
            "voice_behavior_mode": effective_voice_behavior_mode,
            "voice_flow_id": effective_voice_flow_id,
            "input_mode": input_mode,
        }
    )

    pipeline_task: PipelineTask | None = None
    pipeline_error_cancelled = False
    runtime_profile = load_runtime_profile(db, settings)
    runtime_profile["input_mode"] = input_mode
    if input_mode == "push_to_talk":
        runtime_profile["turn_taking"]["push_to_talk_enabled"] = True
        runtime_profile["turn_taking"]["vad_enabled"] = False
    save_runtime_profile(db, runtime_profile)

    @dataclass
    class VoiceLatencyTrace:
        interaction_id: str = field(default_factory=lambda: str(uuid.uuid4()))
        user_turn_id: str | None = None
        assistant_turn_id: str | None = None
        user_text: str = ""
        assistant_text: str = ""
        tts_rendered_text: str = ""
        tts_params: dict[str, Any] = field(default_factory=dict)
        last_tts_payload: dict[str, Any] | None = None
        expression_tags_used: list[str] = field(default_factory=list)
        unsupported_expression_tags: list[str] = field(default_factory=list)
        model_profile: str = "balanced"
        model_used: str = settings.active_model
        input_mode: str = field(default_factory=lambda: effective_input_mode)
        structured_output_expected: bool = False
        llm_structured_output_raw: str = ""
        llm_structured_output: dict[str, Any] | None = None
        structured_output_parse_errors: list[str] = field(default_factory=list)
        runtime_actions: list[dict[str, Any]] = field(default_factory=list)
        runtime_action_status: list[dict[str, Any]] = field(default_factory=list)
        language: str | None = None
        vad_started_at: float = 0.0
        vad_stopped_at: float = 0.0
        transcription_started_at: float = 0.0
        transcript_at: float = 0.0
        llm_request_started_at: float = 0.0
        llm_first_text_at: float = 0.0
        llm_completed_at: float = 0.0
        tts_text_started_at: float = 0.0
        tts_first_audio_at: float = 0.0
        tts_completed_at: float = 0.0
        stt_provider_elapsed_ms: int | None = None
        tts_audio_chunk_count: int = 0
        interrupted: bool = False
        vad_starts: int = 0
        vad_stops: int = 0
        interruptions: int = 0
        duplicate_vad_events: int = 0
        duplicate_interruption_events: int = 0
        empty_llm_completions: int = 0
        duplicate_interruptions_prevented: int = 0
        likely_bad_transcript: bool = False
        was_empty_response: bool = False

        def ms(self, start: float, end: float) -> int | None:
            if not start or not end or end < start:
                return None
            return int((end - start) * 1000)

        def timings(self) -> dict[str, Any]:
            first_response_at = self.tts_first_audio_at or self.llm_first_text_at
            return {
                "user_speech_started_at": self.vad_started_at,
                "user_speech_stopped_at": self.vad_stopped_at,
                "transcription_started_at": self.transcription_started_at,
                "transcription_completed_at": self.transcript_at,
                "llm_request_started_at": self.llm_request_started_at,
                "llm_first_token_at": self.llm_first_text_at,
                "llm_completed_at": self.llm_completed_at,
                "tts_request_started_at": self.tts_text_started_at,
                "tts_first_audio_at": self.tts_first_audio_at,
                "tts_completed_at": self.tts_completed_at,
                "interaction_completed_at": self.tts_completed_at,
                "vad_speech_ms": self.ms(self.vad_started_at, self.vad_stopped_at),
                "stt_after_speech_end_ms": self.ms(self.vad_stopped_at, self.transcript_at),
                "stt_after_speech_start_ms": self.ms(self.vad_started_at, self.transcript_at),
                "stt_provider_elapsed_ms": self.stt_provider_elapsed_ms,
                "stt_latency_ms": self.ms(self.transcription_started_at or self.vad_stopped_at, self.transcript_at),
                "turn_finalization_ms": self.ms(self.transcript_at, self.llm_request_started_at),
                "llm_ttfb_ms": self.ms(self.llm_request_started_at, self.llm_first_text_at),
                "llm_total_ms": self.ms(self.llm_request_started_at, self.llm_completed_at),
                "tts_ttfb_from_first_text_ms": self.ms(self.tts_text_started_at, self.tts_first_audio_at),
                "tts_ttfb_ms": self.ms(self.tts_text_started_at, self.tts_first_audio_at),
                "tts_total_ms": self.ms(self.tts_text_started_at, self.tts_completed_at),
                "speech_end_to_first_text_ms": self.ms(self.vad_stopped_at, self.llm_first_text_at),
                "speech_end_to_first_audio_ms": self.ms(self.vad_stopped_at, self.tts_first_audio_at),
                "speech_start_to_first_audio_ms": self.ms(self.vad_started_at, self.tts_first_audio_at),
                "transcript_to_first_text_ms": self.ms(self.transcript_at, self.llm_first_text_at),
                "transcript_to_first_audio_ms": self.ms(self.transcript_at, self.tts_first_audio_at),
                "transcript_to_response_done_ms": self.ms(self.transcript_at, self.tts_completed_at),
                "total_interaction_ms": self.ms(self.vad_started_at, self.tts_completed_at),
                "total_first_audio_ms": self.ms(self.vad_started_at, self.tts_first_audio_at),
                "first_response_ms": self.ms(self.vad_stopped_at, first_response_at),
                "tts_audio_chunk_count": self.tts_audio_chunk_count,
                "interrupted": self.interrupted,
                "vad_starts": self.vad_starts,
                "vad_stops": self.vad_stops,
                "interruptions": self.interruptions,
                "duplicate_vad_events": self.duplicate_vad_events,
                "duplicate_interruption_events": self.duplicate_interruption_events,
                "empty_llm_completions": self.empty_llm_completions,
                "duplicate_interruptions_prevented": self.duplicate_interruptions_prevented,
                "structured_output_expected": self.structured_output_expected,
                "structured_output_parse_errors": self.structured_output_parse_errors,
            }

        def events(self) -> dict[str, Any]:
            return {
                "vad_starts": self.vad_starts,
                "vad_stops": self.vad_stops,
                "interruptions": self.interruptions,
                "empty_llm_completions": self.empty_llm_completions,
                "duplicate_vad_events": self.duplicate_vad_events,
                "duplicate_interruption_events": self.duplicate_interruption_events,
                "duplicate_interruptions_prevented": self.duplicate_interruptions_prevented,
            }

        def quality_signals(self) -> dict[str, Any]:
            return {
                "stt_confidence": None,
                "was_interrupted": self.interrupted,
                "was_empty_response": self.was_empty_response,
                "likely_bad_transcript": self.likely_bad_transcript,
                "user_correction_detected": False,
                "failure_type": None,
            }

        def apply_tts_render_history(self, history: list[dict[str, Any]]) -> None:
            if not history:
                return
            rendered_parts: list[str] = []
            tags: list[str] = []
            unsupported: list[str] = []
            for item in history:
                rendered = str(item.get("rendered_text") or item.get("clean_text") or "").strip()
                if rendered:
                    rendered_parts.append(rendered)
                tags.extend(str(tag) for tag in item.get("expression_tags_used") or [])
                unsupported.extend(str(tag) for tag in item.get("unsupported_expression_tags") or [])
                payload = item.get("tts_payload")
                if isinstance(payload, dict):
                    self.last_tts_payload = dict(payload)
            self.tts_rendered_text = " ".join(rendered_parts).strip()
            self.expression_tags_used = tags
            self.unsupported_expression_tags = unsupported

        def providers(self) -> dict[str, Any]:
            return {
                "stt_provider": stt_provider,
                "configured_stt_provider": settings.local_stt_provider,
                "stt_model": settings.local_stt_model,
                "stt_language": settings.local_stt_language,
                "nvidia_asr_url": settings.nvidia_asr_url,
                "gradium_vad_model": settings.gradium_vad_model,
                "gradium_vad_input_format": settings.gradium_vad_input_format,
                "tts_provider": tts_provider,
                "configured_tts_provider": settings.local_tts_provider,
                "tts_voice": settings.gradium_tts_voice_id,
                "tts_text_aggregation_mode": settings.local_tts_text_aggregation_mode,
                "gradium_tts_model": settings.gradium_tts_model,
                "gradium_tts_output_format": settings.gradium_tts_output_format,
                "llm_provider": settings.llm_provider,
                "llm_model": self.model_used,
                "llm_model_profile": self.model_profile,
                "tts_params": self.tts_params,
                "last_tts_payload": self.last_tts_payload,
                "expression_tags_used": self.expression_tags_used,
                "unsupported_expression_tags": self.unsupported_expression_tags,
                "llm_structured_output": self.llm_structured_output,
                "runtime_actions": self.runtime_actions,
                "runtime_action_status": self.runtime_action_status,
                "voice_speech_path": settings.voice_speech_path,
                "voice_behavior_mode": effective_voice_behavior_mode,
                "voice_flow_id": effective_voice_flow_id,
                "input_mode": input_mode,
            }

    @dataclass
    class VoiceLatencyState:
        active_trace: VoiceLatencyTrace | None = None
        response_trace: VoiceLatencyTrace | None = None
        assistant_speaking: bool = False
        last_timings: dict[str, Any] = field(default_factory=dict)
        last_bottleneck: str | None = None
        last_vad_start_event_at: float = 0.0
        last_vad_stop_event_at: float = 0.0
        last_interruption_event_at: float = 0.0

        def runtime_system_message(self) -> str | None:
            if not self.last_timings:
                return None
            try:
                self_learn_config = FeedbackLearner(
                    db,
                    prompt_repo,
                    settings.latency_target_ms,
                ).config()
            except Exception:
                self_learn_config = {"enabled": True, "factor": 0.75}
            factor = float(self_learn_config.get("factor", 0) or 0)
            if not self_learn_config.get("enabled") or factor <= 0:
                return None
            first_response = self.last_timings.get("first_response_ms")
            total = self.last_timings.get("total_interaction_ms")
            tts_total = self.last_timings.get("tts_total_ms")
            interrupted = self.last_timings.get("interrupted") is True
            target = settings.latency_target_ms
            effective_target = target * (1.75 - (0.75 * factor))
            tts_limit = 15000 - (7000 * factor)
            turn_limit = 18000 - (8000 * factor)
            breached = isinstance(first_response, int | float) and first_response > effective_target
            long_tts = isinstance(tts_total, int | float) and tts_total > tts_limit
            long_turn = isinstance(total, int | float) and total > turn_limit
            adaptations: list[str] = []
            if interrupted:
                adaptations.append(
                    "the user interrupted the previous turn, so enter repair mode: stop elaborating and keep the next answer short"
                )
            if breached:
                adaptations.append(
                    "first response was slow, so answer with the useful part first and remove preamble"
                )
            if long_tts or long_turn:
                adaptations.append(
                    "the spoken response ran long, so cap quick/status/simple replies to one or two short sentences"
                )
            if not adaptations:
                adaptations.append("keep the next spoken reply concise and natural")
            adaptation_text = "; ".join(adaptations)
            return (
                "Runtime voice telemetry for the previous turn: "
                f"first_response_ms={first_response}, total_interaction_ms={total}, "
                f"tts_total_ms={tts_total}, interrupted={interrupted}, "
                f"dominant_bottleneck={self.last_bottleneck or 'unknown'}, target_ms={target}, "
                f"self_learn_factor={factor:.2f}. "
                f"Use this silently to adapt: {adaptation_text}. "
                "Still honor explicit requests for stories, explanations, detail, or continued talking, "
                "but make them tighter when the user asked for quick/brief. Do not mention telemetry unless the user asks about latency."
            )

    latency_state = VoiceLatencyState()

    @dataclass
    class VoiceControlState:
        speed: float = (
            settings.gradium_tts_speed
            if settings.local_tts_provider == "gradium"
            else 1.0
        )
        emotion_code: str = "N"
        emotion: str = "neutral"
        user_tone_override: str | None = None
        tts_service: Any | None = None

        def bind_tts(self, service: Any) -> None:
            self.tts_service = service
            if hasattr(self.tts_service, "apply_runtime_profile"):
                self.tts_service.apply_runtime_profile(runtime_profile)
            self._apply_speed()
            self._apply_emotion()

        def apply_user_text(self, text: str) -> dict[str, Any] | None:
            speed_intent = voice_speed_intent(text)
            tone_intent = voice_tone_intent(text)
            if not speed_intent and not tone_intent:
                return None
            state: dict[str, Any] = {
                "speed": round(self.speed, 2),
                "speed_label": voice_speed_label(self.speed),
                "tone": self.emotion,
            }
            if speed_intent:
                previous_speed = self.speed
                self.speed = next_voice_speed(self.speed, speed_intent)
                self._apply_speed()
                state.update(
                    {
                        "speed_intent": speed_intent,
                        "previous_speed": round(previous_speed, 2),
                        "speed": round(self.speed, 2),
                        "speed_label": voice_speed_label(self.speed),
                    }
                )
            if tone_intent:
                self.user_tone_override = tone_intent
                self.apply_tone(tone_intent)
                state.update(
                    {
                        "tone_intent": tone_intent,
                        "tone": self.emotion,
                        "emotion_code": self.emotion_code,
                    }
                )
            recorder.update_metadata(
                {
                    "voice_speed": state["speed"],
                    "voice_speed_label": state["speed_label"],
                    "voice_tone": state["tone"],
                    "voice_user_tone_override": self.user_tone_override,
                    "last_voice_speed_intent": state.get("speed_intent"),
                    "last_voice_tone_intent": state.get("tone_intent"),
                }
            )
            return state

        def apply_flow_voice(self, voice: Mapping[str, Any] | None) -> None:
            if not voice:
                return
            speed = voice.get("speed")
            if isinstance(speed, (int, float)) and not isinstance(speed, bool):
                self.speed = max(0.5, min(2.0, float(speed)))
                self._apply_speed()
            tone = voice.get("tone")
            if isinstance(tone, str) and tone.strip() and not self.user_tone_override:
                self.apply_tone(tone)
            recorder.update_metadata(
                {
                    "voice_speed": round(self.speed, 2),
                    "voice_speed_label": voice_speed_label(self.speed),
                    "voice_tone": self.emotion,
                    "voice_user_tone_override": self.user_tone_override,
                    "voice_flow_node_tone": tone if isinstance(tone, str) else None,
                }
            )

        def apply_tone(self, tone: str) -> None:
            normalized = tone.casefold().strip().replace(" ", "_")
            self.emotion = normalized
            self.emotion_code = emotion_code_for_tone(normalized)
            self._apply_emotion()
            recorder.update_metadata(
                {
                    "voice_emotion_code": self.emotion_code,
                    "voice_emotion": self.emotion,
                }
            )

        def apply_emotion_code(self, code: str) -> None:
            normalized = code.upper().strip()
            if normalized not in VOICE_EMOTION_CODES:
                return
            self.emotion_code = normalized
            self.emotion = VOICE_EMOTION_CODES[normalized]  # type: ignore[index]
            self._apply_emotion()
            recorder.update_metadata(
                {
                    "voice_emotion_code": self.emotion_code,
                    "voice_emotion": self.emotion,
                }
            )

        def _apply_speed(self) -> None:
            if self.tts_service and hasattr(self.tts_service, "set_speed"):
                self.tts_service.set_speed(self.speed)

        def _apply_emotion(self) -> None:
            if self.tts_service and hasattr(self.tts_service, "set_emotion"):
                self.tts_service.set_emotion(self.emotion)

    voice_controls = VoiceControlState()

    @dataclass
    class VoiceFlowState:
        enabled: bool = effective_voice_behavior_mode == "flow"
        runtime: FlowRuntime | None = None
        flow_id: str | None = None
        run_id: str | None = None

        def bind(self) -> None:
            if not self.enabled:
                return
            repo = FlowRepository(db)
            self.runtime = FlowRuntime(db, repo, make_llm_client(settings), settings)
            self.flow_id = repo.active().id if effective_voice_flow_id == "active" else effective_voice_flow_id
            recorder.update_metadata({"voice_flow_id": self.flow_id})

        async def respond(self, text: str, trace: VoiceLatencyTrace | None) -> str | None:
            if not self.enabled or not self.runtime or not self.flow_id:
                return None
            try:
                result = await self.runtime.handle_message(
                    flow_id=self.flow_id,
                    run_id=self.run_id,
                    message=text,
                    conversation_id=recorder.conversation_id,
                )
            except Exception as exc:
                if trace:
                    log_latency("flow_runtime_error", trace, error=type(exc).__name__)
                return "I hit a flow issue, so I'll keep helping normally."

            self.run_id = result["run_id"]
            messages = result.get("messages") or []
            response_text = next(
                (
                    str(message.get("text", "")).strip()
                    for message in reversed(messages)
                    if str(message.get("text", "")).strip()
                ),
                "",
            )
            response_voice = next(
                (
                    message.get("voice")
                    for message in reversed(messages)
                    if isinstance(message.get("voice"), Mapping)
                ),
                None,
            )
            if isinstance(response_voice, Mapping):
                voice_controls.apply_flow_voice(response_voice)
            if not response_text:
                response_text = "I understand. What should happen next?"
            if trace:
                log_latency(
                    "flow_runtime_response",
                    trace,
                    text=response_text,
                    voice=response_voice,
                    flow_id=self.flow_id,
                    flow_run_id=self.run_id,
                    active_node_id=result.get("active_node_id"),
                    status=result.get("status"),
                )
            return response_text

    voice_flow = VoiceFlowState()
    voice_flow.bind()

    def dominant_bottleneck(timings: Mapping[str, Any]) -> str | None:
        candidates = {
            "stt": timings.get("stt_after_speech_end_ms"),
            "turn_finalization": timings.get("turn_finalization_ms"),
            "llm_ttfb": timings.get("llm_ttfb_ms"),
            "llm_total": timings.get("llm_total_ms"),
            "tts_ttfb": timings.get("tts_ttfb_from_first_text_ms"),
            "tts_total": timings.get("tts_total_ms"),
        }
        numeric = {
            name: float(value)
            for name, value in candidates.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
        if not numeric:
            return None
        return max(numeric, key=numeric.get)

    def log_latency(event: str, trace: VoiceLatencyTrace, **extra: Any) -> None:
        payload = {
            "event": event,
            "conversation_id": recorder.conversation_id,
            "interaction_id": trace.interaction_id,
            "channel": recorder.channel,
            "providers": trace.providers(),
            "timings": trace.timings(),
            **extra,
        }
        text = extra.get("text") if isinstance(extra.get("text"), str) else None
        role = None
        if event == "user_transcribed":
            role = "user"
        elif event in {"llm_first_text", "llm_completed", "tts_first_audio", "interaction_completed"}:
            role = "assistant"
        try:
            recorder.record_interaction_event(
                interaction_id=trace.interaction_id,
                event=event,
                role=role,
                text=text,
                payload=payload,
            )
        except Exception:
            logger.debug("Failed to persist interaction event", exc_info=True)
        logger.info("VOICE_LATENCY " + dumps(payload))

    def log_runtime_action_event(
        event: str,
        trace: VoiceLatencyTrace,
        *,
        tool: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        event_payload = {
            "event": event,
            "tool": tool,
            "session_id": recorder.conversation_id,
            "turn_id": trace.interaction_id,
            "conversation_id": recorder.conversation_id,
            "interaction_id": trace.interaction_id,
            **(payload or {}),
        }
        try:
            recorder.record_interaction_event(
                interaction_id=trace.interaction_id,
                event=event,
                role="system",
                payload=event_payload,
            )
        except Exception:
            logger.debug("Failed to persist runtime action event", exc_info=True)
        logger.info("VOICE_RUNTIME_ACTION " + dumps(event_payload))

    def sync_runtime_profile_to_voice(profile: Mapping[str, Any]) -> None:
        tts_profile = profile.get("tts") if isinstance(profile.get("tts"), Mapping) else {}
        speed = tts_profile.get("speed")
        if isinstance(speed, (int, float)) and not isinstance(speed, bool):
            voice_controls.speed = float(speed)
        if hasattr(tts, "apply_runtime_profile"):
            tts.apply_runtime_profile(dict(profile))
        else:
            voice_controls._apply_speed()
        recorder.update_metadata(
            {
                "voice_speed": round(voice_controls.speed, 2),
                "voice_speed_label": voice_speed_label(voice_controls.speed),
                "voice_runtime_status": profile.get("debug", {}).get("last_runtime_status")
                if isinstance(profile.get("debug"), Mapping)
                else None,
            }
        )

    async def apply_voice_runtime_command(
        command,
        trace: VoiceLatencyTrace,
        *,
        event: str,
        parse_errors: list[str] | None = None,
        repair_attempted: bool = False,
    ) -> str:
        nonlocal runtime_profile
        errors = list(parse_errors or [])
        trace.llm_structured_output = {
            "speak": command.speak,
            "runtime_actions": command.runtime_actions,
            "reasoning_profile": command.reasoning_profile,
            "debug": command.debug,
        }
        trace.runtime_actions = [dict(action) for action in command.runtime_actions]
        trace.structured_output_parse_errors = errors
        runtime_debug = runtime_profile.setdefault("debug", {})
        runtime_debug["last_llm_structured_output"] = trace.llm_structured_output
        runtime_debug["structured_output_parse_errors"] = errors
        for action in command.runtime_actions:
            log_runtime_action_event(
                "voice_runtime_action_started",
                trace,
                tool=str(action.get("tool") or ""),
                payload={"action": dict(action)},
            )
        execution = await execute_voice_runtime_actions(
            db=db,
            settings=settings,
            profile=runtime_profile,
            actions=command.runtime_actions,
            conversation_id=recorder.conversation_id,
            user_text=trace.user_text,
            transcript=recorder.transcript(),
        )
        runtime_profile = execution.profile
        statuses = execution.statuses
        trace.runtime_action_status = statuses
        for status in statuses:
            log_runtime_action_event(
                "voice_runtime_action_completed",
                trace,
                tool=str(status.get("tool") or ""),
                payload=status,
            )
        sync_runtime_profile_to_voice(runtime_profile)
        try:
            save_runtime_profile(db, runtime_profile)
        except Exception:
            logger.debug("Failed to persist runtime voice profile", exc_info=True)
        text = execution.response_text or command.speak
        log_latency(
            event,
            trace,
            text=text,
            runtime_actions=trace.runtime_actions,
            runtime_action_status=statuses,
            repair_attempted=repair_attempted,
            structured_output_parse_errors=errors,
        )
        return text

    async def repair_voice_runtime_json(raw_text: str, trace: VoiceLatencyTrace) -> str | None:
        import httpx

        base_url = (settings.active_base_url or "").rstrip("/")
        api_key = settings.active_api_key
        if not base_url:
            return None
        payload = {
            "model": trace.model_used or settings.active_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Repair the assistant response into valid JSON only. "
                        "Use schema: {\"speak\": string, \"runtime_actions\": list, "
                        "\"reasoning_profile\": optional string, \"debug\": optional object}. "
                        "Do not add unknown runtime actions. Do not include markdown."
                    ),
                },
                {"role": "user", "content": raw_text[:4000]},
            ],
            "temperature": 0,
            "max_tokens": 350,
        }
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(min(settings.llm_timeout_seconds, 15), connect=5)
            ) as client:
                response = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
            if response.status_code >= 400:
                log_latency(
                    "structured_output_repair_failed",
                    trace,
                    status_code=response.status_code,
                    body=response.text[:240],
                )
                return None
            data = response.json()
            content = (
                data.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
            )
            return content if isinstance(content, str) and content.strip() else None
        except Exception as exc:
            log_latency("structured_output_repair_failed", trace, error=type(exc).__name__)
            return None

    def response_emotion_code(user_text: str, response_text: str) -> str:
        if voice_controls.user_tone_override:
            return voice_controls.emotion_code
        return emotion_code_for_turn(user_text, response_text)

    class VoiceOpenAILLMService(OpenAILLMService):
        async def _process_context(self, context: LLMContext):
            latest_user_text = ""
            for message in reversed(context.get_messages()):
                if _message_role(message) == "user":
                    latest_user_text = _message_content_text(message) or ""
                    break
            latest_user_text = _live_voice_recent_user_request(
                context.get_messages(),
                latest_user_text,
                settings,
            )
            codex_session_active = has_codex_orchestrator_session(db, recorder.conversation_id)
            runtime_control_request = (
                is_voice_tool_request(latest_user_text, settings) or codex_session_active
            )
            if runtime_control_request:
                trace = latency_state.active_trace or VoiceLatencyTrace()
                if latency_state.active_trace is None:
                    latency_state.active_trace = trace
                trace.user_text = latest_user_text
                trace.model_profile = "reasoning" if settings.codex_orchestrator_enabled else "fast"
                trace.model_used = "voice-runtime-direct"
                now = time.perf_counter()
                trace.llm_request_started_at = trace.llm_request_started_at or now
                trace.llm_first_text_at = now
                trace.llm_completed_at = now
                latency_state.response_trace = trace
                fallback_command = fallback_runtime_command_for_request(
                    latest_user_text,
                    runtime_profile,
                    settings,
                    reason="live_voice_direct_runtime_intent",
                    codex_session_active=codex_session_active,
                )
                if fallback_command:
                    text = await apply_voice_runtime_command(
                        fallback_command,
                        trace,
                        event="runtime_control_direct_applied",
                    )
                    trace.structured_output_expected = False
                    emotion_code = (
                        response_emotion_code(latest_user_text, text)
                        if settings.voice_emotion_codes_enabled
                        else "N"
                    )
                    await self._push_llm_text(prefix_emotion_code(text, emotion_code))
                    return
            if (
                latest_user_text
                and likely_bad_transcript(latest_user_text)
                and runtime_profile.get("turn_taking", {}).get(
                    "clarification_on_low_stt_confidence", True
                )
            ):
                clarification = "Sorry, I didn't catch that. Can you say it again?"
                emotion_code = (
                    response_emotion_code(latest_user_text, clarification)
                    if settings.voice_emotion_codes_enabled
                    else "N"
                )
                trace = latency_state.active_trace
                now = time.perf_counter()
                if trace:
                    trace.likely_bad_transcript = True
                    trace.llm_request_started_at = now
                    trace.llm_first_text_at = now
                    trace.llm_completed_at = now
                    trace.model_profile = "fast"
                    trace.model_used = "clarification_policy"
                    latency_state.response_trace = trace
                    log_latency("llm_clarification_response", trace, text=clarification)
                await self._push_llm_text(prefix_emotion_code(clarification, emotion_code))
                return
            flow_text = None if runtime_control_request else await voice_flow.respond(
                latest_user_text,
                latency_state.active_trace,
            )
            if flow_text:
                emotion_code = (
                    response_emotion_code(latest_user_text, flow_text)
                    if settings.voice_emotion_codes_enabled
                    else "N"
                )
                trace = latency_state.active_trace
                now = time.perf_counter()
                if trace:
                    trace.llm_request_started_at = now
                    trace.llm_first_text_at = now
                    trace.llm_completed_at = now
                    latency_state.response_trace = trace
                await self._push_llm_text(prefix_emotion_code(flow_text, emotion_code))
                return
            await super()._process_context(context)

        async def get_chat_completions(self, context: LLMContext):
            trace = latency_state.active_trace
            latest_user_text = ""
            for message in reversed(context.get_messages()):
                if _message_role(message) == "user":
                    latest_user_text = _message_content_text(message) or ""
                    break
            latest_user_text = _live_voice_recent_user_request(
                context.get_messages(),
                latest_user_text,
                settings,
            )
            selected_profile = choose_model_profile(latest_user_text, runtime_profile)
            selected_model = model_for_profile(settings, runtime_profile, selected_profile)
            selected_max_tokens = max_tokens_for_profile(settings, selected_profile, runtime_profile)
            codex_session_active = has_codex_orchestrator_session(db, recorder.conversation_id)
            runtime_control_request = (
                is_voice_tool_request(latest_user_text, settings) or codex_session_active
            )
            if runtime_control_request:
                # Runtime actions need stronger JSON adherence than the nano fast model provides.
                selected_model = model_for_profile(settings, runtime_profile, "balanced")
            self._settings.model = selected_model
            self._settings.max_tokens = selected_max_tokens
            runtime_profile.setdefault("llm", {})["current_model"] = selected_model
            runtime_profile["active_model_profile"] = selected_profile
            if trace:
                trace.model_profile = selected_profile
                trace.model_used = selected_model
                trace.structured_output_expected = runtime_control_request
                trace.llm_request_started_at = time.perf_counter()
                latency_state.response_trace = trace
                log_latency(
                    "llm_request_started",
                    trace,
                    selected_model_profile=selected_profile,
                    selected_model=selected_model,
                    max_tokens=selected_max_tokens,
                )
            messages = trim_voice_chat_messages(
                merge_adjacent_chat_messages(context.get_messages()),
                max_messages=settings.voice_llm_context_messages,
                max_chars=settings.voice_llm_context_max_chars,
            )
            if runtime_control_request:
                runtime_message = {
                    "role": "system",
                    "content": runtime_command_context(
                        runtime_profile,
                        settings,
                        latest_user_text,
                        codex_session_active=codex_session_active,
                    ),
                }
                insert_at = 1 if messages and _message_role(messages[0]) == "system" else 0
                messages = [*messages[:insert_at], runtime_message, *messages[insert_at:]]
            normalized = LLMContext(
                messages=messages,
                tools=context.tools,
                tool_choice=context.tool_choice,
            )
            return await super().get_chat_completions(normalized)

    class TranscriptCaptureProcessor(FrameProcessor):
        def __init__(self, *, capture_user: bool = False, capture_assistant: bool = False):
            super().__init__()
            self._capture_user = capture_user
            self._capture_assistant = capture_assistant
            self._assistant_parts: list[str] = []
            self._assistant_started_at = 0.0
            self._emotion_prefix_pending = False
            self._emotion_prefix_buffer = ""

        async def process_frame(self, frame: Frame, direction: FrameDirection):
            nonlocal pipeline_error_cancelled, runtime_profile
            await super().process_frame(frame, direction)
            if isinstance(frame, VADUserStartedSpeakingFrame):
                now = time.perf_counter()
                debounce_s = float(
                    runtime_profile.get("turn_taking", {}).get("vad_debounce_ms", 250)
                ) / 1000
                active_trace = latency_state.active_trace
                is_duplicate = (
                    latency_state.last_vad_start_event_at > 0
                    and now - latency_state.last_vad_start_event_at < debounce_s
                )
                if input_mode == "push_to_talk" and active_trace and not active_trace.transcript_at:
                    is_duplicate = True
                if is_duplicate:
                    trace = active_trace or latency_state.response_trace
                    if trace:
                        trace.duplicate_vad_events += 1
                        log_latency(
                            "vad_started_deduped",
                            trace,
                            debounce_ms=int(debounce_s * 1000),
                        )
                    return
                trace = VoiceLatencyTrace(vad_started_at=now)
                trace.vad_starts = 1
                latency_state.active_trace = trace
                latency_state.last_vad_start_event_at = now
                log_latency("vad_started", trace)
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                now = time.perf_counter()
                debounce_s = float(
                    runtime_profile.get("turn_taking", {}).get("vad_debounce_ms", 250)
                ) / 1000
                trace = latency_state.active_trace
                is_duplicate = (
                    latency_state.last_vad_stop_event_at > 0
                    and now - latency_state.last_vad_stop_event_at < debounce_s
                )
                if is_duplicate:
                    if trace:
                        trace.duplicate_vad_events += 1
                        log_latency(
                            "vad_stopped_deduped",
                            trace,
                            debounce_ms=int(debounce_s * 1000),
                        )
                    return
                if trace:
                    trace.vad_stopped_at = now
                    trace.transcription_started_at = trace.transcription_started_at or now
                    trace.vad_stops += 1
                    latency_state.last_vad_stop_event_at = now
                    log_latency("vad_stopped", trace)

            if self._capture_user and isinstance(frame, TranscriptionFrame):
                raw_text = frame.text.strip()
                text = _repair_codex_project_selection_transcript(
                    raw_text.strip(),
                    _last_unselected_codex_response(db, recorder.conversation_id),
                )
                if text:
                    speed_state = None
                    now = time.perf_counter()
                    trace = latency_state.active_trace or VoiceLatencyTrace()
                    if latency_state.active_trace is None:
                        latency_state.active_trace = trace
                    trace.transcription_started_at = trace.transcription_started_at or trace.vad_stopped_at or now
                    trace.transcript_at = now
                    trace.user_text = text
                    trace.likely_bad_transcript = likely_bad_transcript(text)
                    language = str(frame.language) if frame.language else None
                    trace.language = language
                    result = getattr(frame, "result", None)
                    if isinstance(result, Mapping):
                        elapsed_ms = result.get("elapsed_ms")
                        if isinstance(elapsed_ms, int):
                            trace.stt_provider_elapsed_ms = elapsed_ms
                    user_turn_id = recorder.record_turn(
                        "user",
                        text,
                        metrics={
                            "interaction_id": trace.interaction_id,
                            "language": language,
                            "source": settings.local_stt_provider,
                            "stt_model": settings.local_stt_model,
                            "raw_transcript": raw_text,
                            "voice_speed": round(voice_controls.speed, 2),
                            "voice_speed_label": voice_speed_label(voice_controls.speed),
                            "voice_speed_change": speed_state,
                            **trace.timings(),
                        },
                    )
                    trace.user_turn_id = user_turn_id or trace.user_turn_id
                    logger.info(f"USER: {text}")
                    log_latency(
                        "user_transcribed",
                        trace,
                        text=text,
                        raw_text=raw_text,
                        language=language,
                        voice_speed=round(voice_controls.speed, 2),
                        voice_speed_label=voice_speed_label(voice_controls.speed),
                        voice_speed_change=speed_state,
                    )
            elif self._capture_assistant and isinstance(frame, LLMFullResponseStartFrame):
                self._assistant_parts = []
                self._assistant_started_at = time.perf_counter()
                self._emotion_prefix_pending = settings.voice_emotion_codes_enabled
                self._emotion_prefix_buffer = ""
                trace = latency_state.response_trace or latency_state.active_trace
                if trace:
                    if not trace.llm_request_started_at:
                        trace.llm_request_started_at = self._assistant_started_at
                    trace.llm_first_text_at = 0.0
                    trace.llm_completed_at = 0.0
                    trace.tts_text_started_at = 0.0
                    trace.tts_first_audio_at = 0.0
                    trace.tts_completed_at = 0.0
                    trace.tts_audio_chunk_count = 0
                    if trace.structured_output_expected:
                        self._emotion_prefix_pending = False
                latency_state.assistant_speaking = False
            elif self._capture_assistant and isinstance(frame, TextFrame):
                trace = latency_state.response_trace or latency_state.active_trace
                if trace and not trace.llm_first_text_at:
                    trace.llm_first_text_at = time.perf_counter()
                    log_latency("llm_first_text", trace, text=frame.text)
                if trace and trace.structured_output_expected:
                    self._assistant_parts.append(frame.text)
                    return
                if trace:
                    trace.tts_text_started_at = trace.tts_text_started_at or trace.llm_first_text_at
                text_for_tts = frame.text
                if self._emotion_prefix_pending:
                    self._emotion_prefix_buffer += frame.text
                    status, code, remainder = consume_emotion_prefix(self._emotion_prefix_buffer)
                    if status == "pending":
                        return
                    self._emotion_prefix_pending = False
                    self._emotion_prefix_buffer = ""
                    if status == "matched" and code:
                        if not voice_controls.user_tone_override:
                            voice_controls.apply_emotion_code(code)
                        if trace:
                            log_latency(
                                "voice_emotion_changed",
                                trace,
                                emotion_code=code,
                                emotion=voice_controls.emotion,
                                user_tone_override=voice_controls.user_tone_override,
                            )
                        text_for_tts = remainder
                    else:
                        inferred_code = response_emotion_code(trace.user_text if trace else "", remainder)
                        if not voice_controls.user_tone_override:
                            voice_controls.apply_emotion_code(inferred_code)
                        text_for_tts = remainder
                    if not text_for_tts:
                        return
                    frame = TextFrame(text_for_tts)
                self._assistant_parts.append(text_for_tts)
            elif self._capture_assistant and isinstance(frame, LLMFullResponseEndFrame):
                text = "".join(self._assistant_parts).strip()
                completed_at = time.perf_counter()
                trace = latency_state.response_trace or latency_state.active_trace
                if trace and trace.structured_output_expected:
                    trace.llm_completed_at = completed_at
                    trace.llm_structured_output_raw = text
                    parsed = parse_voice_runtime_command(text)
                    if not parsed.ok:
                        repaired = await repair_voice_runtime_json(text, trace)
                        if repaired:
                            repaired_result = parse_voice_runtime_command(repaired)
                            repaired_result.repair_attempted = True
                            repaired_result.repaired_raw = repaired
                            if repaired_result.ok:
                                parsed = repaired_result
                            else:
                                parsed.errors = [
                                    *parsed.errors,
                                    *[f"repair:{error}" for error in repaired_result.errors],
                                ]
                    if parsed.ok and parsed.command:
                        command = parsed.command
                        text = await apply_voice_runtime_command(
                            command,
                            trace,
                            event="llm_structured_output_parsed",
                            repair_attempted=parsed.repair_attempted,
                        )
                        if command.runtime_actions and not any(
                            status.get("status") == "completed"
                            for status in trace.runtime_action_status
                        ) and not any(
                            status.get("tool")
                            in {"delegate_to_codex_orchestrator", "get_codex_orchestrator_status"}
                            for status in trace.runtime_action_status
                        ):
                            fallback_command = fallback_runtime_command_for_request(
                                trace.user_text,
                                runtime_profile,
                                settings,
                                reason="runtime_actions_rejected",
                                codex_session_active=has_codex_orchestrator_session(
                                    db, recorder.conversation_id
                                ),
                            )
                            if fallback_command:
                                text = await apply_voice_runtime_command(
                                    fallback_command,
                                    trace,
                                    event="runtime_control_fallback_applied",
                                )
                    else:
                        errors = parsed.errors or ["structured_output_parse_failed"]
                        trace.structured_output_parse_errors = errors
                        runtime_profile.setdefault("debug", {})[
                            "structured_output_parse_errors"
                        ] = errors
                        runtime_profile.setdefault("debug", {})[
                            "last_llm_structured_output"
                        ] = text
                        try:
                            save_runtime_profile(db, runtime_profile)
                        except Exception:
                            logger.debug("Failed to persist runtime voice profile", exc_info=True)
                        fallback_command = fallback_runtime_command_for_request(
                            trace.user_text,
                            runtime_profile,
                            settings,
                            reason=",".join(errors),
                            codex_session_active=has_codex_orchestrator_session(
                                db, recorder.conversation_id
                            ),
                        )
                        if fallback_command:
                            text = await apply_voice_runtime_command(
                                fallback_command,
                                trace,
                                event="runtime_control_fallback_applied",
                                parse_errors=errors,
                                repair_attempted=parsed.repair_attempted,
                            )
                        else:
                            text = fallback_voice_runtime_speak(text)
                            log_latency("structured_output_parse_failed", trace, text=text, errors=errors)
                    if not text:
                        text = _empty_live_voice_response(trace.user_text)
                        trace.empty_llm_completions += 1
                        trace.was_empty_response = True
                        log_latency("llm_completed_empty_recovered", trace, text=text)
                    trace.assistant_text = text
                    trace.tts_text_started_at = time.perf_counter()
                    if text:
                        log_latency("llm_completed", trace, text=text)
                        await self.push_frame(TextFrame(text), direction)
                    await self.push_frame(frame, direction)
                    return
                if trace:
                    trace.llm_completed_at = completed_at
                    if not text:
                        text = _empty_live_voice_response(trace.user_text)
                        trace.empty_llm_completions += 1
                        trace.was_empty_response = True
                        log_latency("llm_completed_empty_recovered", trace, text=text)
                        await self.push_frame(TextFrame(text), direction)
                    trace.assistant_text = text
                    if text:
                        log_latency("llm_completed", trace, text=text)
            elif isinstance(frame, InterruptionFrame):
                now = time.perf_counter()
                debounce_s = float(
                    runtime_profile.get("turn_taking", {}).get(
                        "interruption_debounce_ms", 250
                    )
                ) / 1000
                trace = latency_state.active_trace or latency_state.response_trace
                if (
                    latency_state.last_interruption_event_at > 0
                    and now - latency_state.last_interruption_event_at < debounce_s
                ):
                    if trace:
                        trace.duplicate_interruption_events += 1
                        trace.duplicate_interruptions_prevented += 1
                        log_latency(
                            "interruption_deduped",
                            trace,
                            debounce_ms=int(debounce_s * 1000),
                        )
                    return
                latency_state.last_interruption_event_at = now
                if trace:
                    trace.interrupted = True
                    trace.interruptions += 1
                since_user_start_ms = trace.ms(trace.vad_started_at, now) if trace else None
                logger.info(
                    "INTERRUPTION: user speech interrupted the assistant "
                    f"after {since_user_start_ms} ms"
                )
                if trace:
                    log_latency("interruption", trace, since_user_start_ms=since_user_start_ms)
            elif isinstance(frame, ErrorFrame):
                logger.error(f"PIPELINE ERROR: {frame.error}")
                if pipeline_task is not None and not pipeline_error_cancelled:
                    pipeline_error_cancelled = True
                    await pipeline_task.cancel(reason=f"pipeline error: {frame.error}")
            await self.push_frame(frame, direction)

    class VoiceRTVISpeakingBridgeProcessor(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection):
            await super().process_frame(frame, direction)
            if isinstance(frame, VADUserStartedSpeakingFrame):
                await self.push_frame(
                    OutputTransportMessageUrgentFrame(message=rtvi_user_speaking_message(True)),
                    direction,
                )
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                await self.push_frame(
                    OutputTransportMessageUrgentFrame(message=rtvi_user_speaking_message(False)),
                    direction,
                )
            await self.push_frame(frame, direction)

    class OutputAudioProbeProcessor(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection):
            nonlocal runtime_profile
            await super().process_frame(frame, direction)
            trace = latency_state.response_trace
            if isinstance(frame, TTSAudioRawFrame):
                if trace:
                    trace.tts_audio_chunk_count += 1
                    if not trace.tts_first_audio_at:
                        trace.tts_first_audio_at = time.perf_counter()
                        log_latency("tts_first_audio", trace)
                latency_state.assistant_speaking = True
            elif isinstance(frame, TTSStoppedFrame):
                if trace:
                    trace.tts_completed_at = time.perf_counter()
                    if hasattr(tts, "drain_render_history"):
                        trace.apply_tts_render_history(tts.drain_render_history())
                    if hasattr(tts, "current_params"):
                        trace.tts_params = tts.current_params()
                    if hasattr(tts, "last_payload"):
                        trace.last_tts_payload = tts.last_payload()
                    if trace.last_tts_payload:
                        trace.tts_params["last_tts_payload"] = trace.last_tts_payload
                        runtime_profile.setdefault("debug", {})[
                            "last_tts_payload"
                        ] = trace.last_tts_payload
                        try:
                            recorder.record_interaction_event(
                                interaction_id=trace.interaction_id,
                                event="tts_request",
                                role="system",
                                payload={
                                    "event": "tts_request",
                                    "provider": tts_provider,
                                    **trace.last_tts_payload,
                                },
                            )
                        except Exception:
                            logger.debug("Failed to persist TTS request event", exc_info=True)
                    trace.tts_params.update(
                        {
                            "expression_tags_used": list(trace.expression_tags_used),
                            "unsupported_expression_tags": list(trace.unsupported_expression_tags),
                        }
                    )
                    clean_assistant_text, _kept_tags, stripped_tags = clean_angle_tags(
                        trace.assistant_text, []
                    )
                    prefix_status, prefix_code, prefix_remainder = consume_emotion_prefix(
                        clean_assistant_text
                    )
                    if prefix_status == "matched":
                        clean_assistant_text = prefix_remainder
                        if prefix_code and not voice_controls.user_tone_override:
                            voice_controls.apply_emotion_code(prefix_code)
                    trace.assistant_text = clean_assistant_text.strip()
                    if stripped_tags:
                        trace.unsupported_expression_tags.extend(stripped_tags)
                        trace.tts_params["unsupported_expression_tags"] = list(
                            trace.unsupported_expression_tags
                        )
                    if not trace.tts_rendered_text:
                        trace.tts_rendered_text = trace.assistant_text
                    runtime_profile.setdefault("debug", {})[
                        "last_tts_rendered_text"
                    ] = trace.tts_rendered_text
                    latency_ms = (
                        trace.timings().get("speech_end_to_first_audio_ms")
                        or trace.timings().get("speech_end_to_first_text_ms")
                        or trace.timings().get("llm_total_ms")
                    )
                    if trace.assistant_text:
                        assistant_turn_id = recorder.record_turn(
                            "assistant",
                            trace.assistant_text,
                            latency_ms=latency_ms,
                            metrics={
                                "interaction_id": trace.interaction_id,
                                "source": "local_pipecat",
                                "voice_behavior_mode": effective_voice_behavior_mode,
                                "voice_flow_id": voice_flow.flow_id,
                                "voice_flow_run_id": voice_flow.run_id,
                                "voice_speed": round(voice_controls.speed, 2),
                                "voice_speed_label": voice_speed_label(voice_controls.speed),
                                "voice_emotion_code": voice_controls.emotion_code,
                                "voice_emotion": voice_controls.emotion,
                                **trace.providers(),
                                **trace.timings(),
                            },
                        )
                        trace.assistant_turn_id = assistant_turn_id or trace.assistant_turn_id
                        logger.info(f"ASSISTANT: {trace.assistant_text}")
                    learning_record = build_learning_record(
                        session_id=recorder.conversation_id,
                        turn_id=trace.assistant_turn_id or trace.user_turn_id or trace.interaction_id,
                        input_mode=input_mode,
                        user_transcript=trace.user_text,
                        assistant_response_clean=trace.assistant_text,
                        tts_rendered_text=trace.tts_rendered_text,
                        model_profile=trace.model_profile,
                        model_used=trace.model_used,
                        tts_provider=tts_provider,
                        tts_params=trace.tts_params,
                        latency=trace.timings(),
                        events=trace.events(),
                        quality_signals=trace.quality_signals(),
                        runtime_profile_snapshot=runtime_profile,
                    )
                    failures = classify_voice_turn(learning_record, runtime_profile)
                    learning_record["quality_signals"]["failure_types"] = failures
                    learning_record["quality_signals"]["failure_type"] = next(
                        (failure for failure in failures if failure != "successful_turn"),
                        None,
                    )
                    try:
                        recorder.record_interaction_event(
                            interaction_id=trace.interaction_id,
                            event="interaction_learning_log",
                            role="assistant" if trace.assistant_text else None,
                            text=trace.assistant_text or None,
                            payload=learning_record,
                        )
                    except Exception:
                        logger.debug("Failed to persist interaction learning log", exc_info=True)
                    runtime_profile = apply_runtime_adaptation(
                        runtime_profile,
                        failures,
                        learning_record,
                    )
                    if hasattr(tts, "apply_runtime_profile"):
                        tts.apply_runtime_profile(runtime_profile)
                    try:
                        save_runtime_profile(db, runtime_profile)
                    except Exception:
                        logger.debug("Failed to persist runtime voice profile", exc_info=True)
                    trace_id = recorder.record_latency_trace(
                        interaction_id=trace.interaction_id,
                        user_turn_id=trace.user_turn_id,
                        assistant_turn_id=trace.assistant_turn_id,
                        providers=trace.providers(),
                        timings=trace.timings(),
                    )
                    latency_state.last_timings = trace.timings()
                    latency_state.last_bottleneck = dominant_bottleneck(latency_state.last_timings)
                    log_latency(
                        "interaction_completed",
                        trace,
                        latency_trace_id=trace_id,
                        failure_types=failures,
                        runtime_profile_change=runtime_profile.get("last_profile_change"),
                    )
                    if latency_state.active_trace is trace:
                        latency_state.active_trace = None
                    latency_state.response_trace = None
                latency_state.assistant_speaking = False
            await self.push_frame(frame, direction)

    logger.info(
        f"Creating local STT service: provider={settings.local_stt_provider} "
        f"model={settings.local_stt_model}"
    )
    stt_provider, stt = create_local_stt_service(settings)
    logger.info(f"Created local STT service: provider={stt_provider}")
    logger.info(
        f"Creating local LLM service: provider={settings.llm_provider} "
        f"model={settings.active_model}"
    )
    llm = VoiceOpenAILLMService(
        api_key=openai_compatible_client_api_key(settings),
        base_url=settings.active_base_url,
        retry_timeout_secs=settings.llm_timeout_seconds,
        retry_on_timeout=True,
        settings=OpenAILLMService.Settings(
            model=settings.active_model,
            system_instruction=build_system_instruction(settings, prompt_repo),
            temperature=settings.llm_temperature,
            top_p=settings.llm_top_p,
            max_tokens=settings.max_completion_tokens,
            max_completion_tokens=NOT_GIVEN,
        ),
    )
    logger.info(
        f"Creating local TTS service: provider={settings.local_tts_provider} "
        f"voice={settings.local_tts_voice}"
    )
    tts_provider, tts = await create_local_tts_service(settings)
    logger.info(f"Created local TTS service: provider={tts_provider}")
    voice_controls.bind_tts(tts)
    from .gradium_voice import create_gradium_vad_processor

    vad = create_gradium_vad_processor(settings)
    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
            user_params=LLMUserAggregatorParams(
            audio_idle_timeout=settings.local_vad_audio_idle_timeout,
            user_turn_strategies=UserTurnStrategies(
                start=[VADUserTurnStartStrategy(), TranscriptionUserTurnStartStrategy(use_interim=False)],
                stop=[
                    SpeechTimeoutUserTurnStopStrategy(
                        user_speech_timeout=settings.local_user_speech_timeout
                    )
                ]
            ),
            user_turn_stop_timeout=settings.local_user_turn_stop_timeout,
        ),
    )
    pipeline = Pipeline(
        [
            transport.input(),
            vad,
            VoiceRTVISpeakingBridgeProcessor(),
            stt,
            TranscriptCaptureProcessor(capture_user=True),
            user_aggregator,
            llm,
            TranscriptCaptureProcessor(capture_assistant=True),
            tts,
            OutputAudioProbeProcessor(),
            transport.output(),
            assistant_aggregator,
        ]
    )
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=settings.local_audio_input_sample_rate,
            audio_out_sample_rate=settings.local_audio_output_sample_rate,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        conversation_id=recorder.conversation_id,
        idle_timeout_secs=pipeline_idle_timeout_secs,
    )
    pipeline_task = task

    if hasattr(transport, "event_handler"):
        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(_transport, _client):
            logger.info("Pipecat client disconnected; cancelling voice pipeline")
            await task.cancel(reason="client disconnected")

    logger.info("Local Pipecat voice agent is live.")
    logger.info(f"Conversation ID: {recorder.conversation_id}")
    logger.info(
        f"STT={stt_provider}:{settings.local_stt_model} language={settings.local_stt_language} "
        f"TTS={tts_provider} LLM={settings.active_model}"
    )
    logger.info("Speak into the Mac microphone. Start talking over the assistant to test interruption.")
    await PipelineRunner(handle_sigint=handle_sigint).run(task)


async def run_local_pipecat_voice_agent(
    settings: Settings | None = None,
    db: Database | None = None,
    prompt_repo: PromptRepository | None = None,
) -> None:
    """Run local microphone/speaker Pipecat voice with open-source STT/TTS."""

    settings = settings or get_settings()
    require_openai_compatible_llm(settings)
    db = db or Database(settings.database_path)
    prompt_repo = prompt_repo or PromptRepository(db)
    prompt = prompt_repo.active()
    recorder = LocalVoiceConversationRecorder(db, settings, prompt.version)
    recorder.start()

    from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams

    transport = LocalAudioTransport(
        LocalAudioTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=settings.local_audio_input_sample_rate,
            audio_out_sample_rate=settings.local_audio_output_sample_rate,
            audio_out_10ms_chunks=settings.local_audio_output_10ms_chunks,
            audio_out_end_silence_secs=settings.local_audio_output_end_silence_secs,
            audio_in_passthrough=True,
            input_device_index=settings.local_audio_input_device_index,
            output_device_index=settings.local_audio_output_device_index,
        )
    )
    await _run_voice_pipeline(
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        recorder=recorder,
        transport=transport,
        handle_sigint=True,
        voice_behavior_mode=settings.voice_behavior_mode,
        voice_flow_id=settings.voice_flow_id,
    )


async def run_browser_pipecat_voice_agent(
    webrtc_connection,
    settings: Settings | None = None,
    db: Database | None = None,
    prompt_repo: PromptRepository | None = None,
    session_id: str | None = None,
    voice_behavior_mode: str | None = None,
    voice_flow_id: str | None = None,
    input_mode: VoiceInputMode = "vad",
) -> None:
    """Run a browser SmallWebRTC Pipecat voice session."""

    settings = settings or get_settings()
    require_openai_compatible_llm(settings)
    db = db or Database(settings.database_path)
    prompt_repo = prompt_repo or PromptRepository(db)
    prompt = prompt_repo.active()
    recorder = LocalVoiceConversationRecorder(
        db,
        settings,
        prompt.version,
        channel="browser_pipecat",
        transport_name="pipecat.smallwebrtc",
        conversation_id=session_id or str(uuid.uuid4()),
    )
    recorder.start()

    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=settings.local_audio_input_sample_rate,
            audio_out_sample_rate=settings.local_audio_output_sample_rate,
            audio_out_10ms_chunks=settings.local_audio_output_10ms_chunks,
            audio_out_end_silence_secs=settings.local_audio_output_end_silence_secs,
            audio_in_passthrough=True,
        ),
    )
    await _run_voice_pipeline(
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        recorder=recorder,
        transport=transport,
        handle_sigint=False,
        voice_behavior_mode=voice_behavior_mode,
        voice_flow_id=voice_flow_id,
        input_mode=input_mode,
        pipeline_idle_timeout_secs=None,
    )


async def main() -> None:
    await run_local_pipecat_voice_agent()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
