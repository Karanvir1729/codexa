from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .agent import build_runtime_system_prompt, fast_policy_response
from .config import Settings, get_settings
from .db import Database, dumps, loads
from .feedback import PromptRepository
from .flow_runtime import FlowRepository, FlowRuntime
from .llm import make_llm_client
from .voice_runtime_controls import (
    VOICE_EMOTION_CODES,
    VOICE_EMOTION_SYSTEM_PROMPT,
    consume_emotion_prefix,
    emotion_code_for_tone,
    emotion_code_for_turn,
    next_voice_speed,
    prefix_emotion_code,
    voice_speed_intent,
    voice_speed_label,
    voice_tone_intent,
)


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
                        "whisperx_device": self.settings.local_whisperx_device,
                        "whisperx_compute_type": self.settings.local_whisperx_compute_type,
                        "tts_provider": self.settings.local_tts_provider,
                        "tts_voice": self.settings.local_tts_voice,
                        "fish_speech_reference_id": self.settings.fish_speech_reference_id,
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
        self.db.execute(
            """
            INSERT INTO latency_traces(
                id, conversation_id, interaction_id, channel, transport,
                user_turn_id, assistant_turn_id, providers_json, timings_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                trace_id,
                self.conversation_id,
                interaction_id,
                self.channel,
                self.transport_name,
                user_turn_id,
                assistant_turn_id,
                dumps(providers),
                dumps(timings),
            ),
        )
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
            "Run with LLM_PROVIDER=ollama after ./scripts/setup_ollama_local.sh, "
            "or switch to NVIDIA/AWS local vLLM later."
        )
    if not settings.active_base_url:
        raise RuntimeError("Active LLM provider is missing a base URL.")
    if not settings.active_api_key:
        raise RuntimeError("Active LLM provider is missing an API key.")


def build_system_instruction(settings: Settings, prompt_repo: PromptRepository) -> str:
    instruction = build_runtime_system_prompt(prompt_repo.active().compiled)
    instruction = (
        f"{instruction}\n\n"
        "Live voice constraints:\n"
        "- Answer immediately; keep simple controls brief, but allow natural multi-sentence replies when requested.\n"
        "- Speak English only unless the latest user utterance explicitly asks for another language.\n"
        "- If the user speaks Hindi, Urdu, or Hinglish, answer in that language only for that turn.\n"
        "- Use plain ASCII English when the TTS voice is English.\n"
        "- If the user asks for a story, narration, explanation, detail, or to keep talking, give a complete spoken answer with several sentences.\n"
        "- You are latency-aware: if runtime telemetry says the previous turn was slow, remove filler but do not truncate explicit long-form requests.\n"
        "- Control voice behavior through the spoken content: concise wording for speed, calm wording for tone, and the user's language for language.\n"
        "- If asked about latency, identify the slow stage from runtime telemetry when it is available.\n"
        "- If the user says OnePlus One, ask whether they mean the phone or one plus one.\n"
        "- If the user asks to speak faster or slower, acknowledge it; the runtime will adjust speech speed.\n"
        "- Do not mention model identity, internal policy, or provider names unless the user asks."
    )
    if settings.voice_emotion_codes_enabled and settings.voice_runtime == "local_pipecat":
        instruction = f"{instruction}\n\n{VOICE_EMOTION_SYSTEM_PROMPT}"
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


async def create_local_tts_service(settings: Settings):
    from loguru import logger
    from pipecat.services.tts_service import TextAggregationMode

    provider = settings.local_tts_provider
    text_aggregation_mode = (
        TextAggregationMode.TOKEN
        if settings.local_tts_text_aggregation_mode == "token"
        else TextAggregationMode.SENTENCE
    )
    if provider == "nvidia":
        from pipecat.services.nvidia.tts import NvidiaTTSService

        language = resolve_tts_language(settings)
        return "nvidia", NvidiaTTSService(
            api_key=settings.nvidia_api_key,
            server=settings.nvidia_tts_server,
            use_ssl=settings.nvidia_tts_use_ssl,
            settings=NvidiaTTSService.Settings(voice=settings.local_tts_voice, language=language),
            sample_rate=settings.local_audio_output_sample_rate,
            text_aggregation_mode=text_aggregation_mode,
        )

    if provider == "cartesia":
        if not settings.cartesia_api_key:
            raise RuntimeError("LOCAL_TTS_PROVIDER=cartesia requires CARTESIA_API_KEY.")
        from pipecat.services.cartesia.tts import CartesiaTTSService

        return "cartesia", CartesiaTTSService(
            api_key=settings.cartesia_api_key,
            settings=CartesiaTTSService.Settings(voice=settings.cartesia_voice_id),
            sample_rate=settings.local_audio_output_sample_rate,
            text_aggregation_mode=text_aggregation_mode,
        )

    if provider == "deepgram":
        if not settings.deepgram_api_key:
            raise RuntimeError("LOCAL_TTS_PROVIDER=deepgram requires DEEPGRAM_API_KEY.")
        from pipecat.services.deepgram.tts import DeepgramTTSService

        return "deepgram", DeepgramTTSService(
            api_key=settings.deepgram_api_key,
            settings=DeepgramTTSService.Settings(voice=settings.local_tts_voice),
            sample_rate=settings.local_audio_output_sample_rate,
            text_aggregation_mode=text_aggregation_mode,
        )

    if provider == "google":
        from pipecat.services.google.tts import GoogleTTSService

        language = resolve_tts_language(settings)
        return "google", GoogleTTSService(
            credentials=settings.local_google_credentials,
            credentials_path=settings.local_google_credentials_path,
            location=settings.local_google_tts_location or None,
            settings=GoogleTTSService.Settings(voice=settings.local_tts_voice, language=language),
            sample_rate=settings.local_audio_output_sample_rate,
            text_aggregation_mode=text_aggregation_mode,
        )

    if provider == "piper":
        from pipecat.services.piper.tts import PiperTTSService

        download_dir = Path(settings.piper_download_dir)
        download_dir.mkdir(parents=True, exist_ok=True)
        return "piper", PiperTTSService(
            settings=PiperTTSService.Settings(voice=settings.local_tts_voice),
            download_dir=download_dir,
            sample_rate=settings.local_audio_output_sample_rate,
            text_aggregation_mode=text_aggregation_mode,
        )

    if provider == "voxtral":
        from .voxtral_tts import create_voxtral_tts_service

        return "voxtral", create_voxtral_tts_service(settings)

    if provider in {"auto", "fish_speech"}:
        from .fish_speech_tts import create_fish_speech_tts_service, fish_speech_healthcheck
        from .voxtral_tts import create_voxtral_tts_service, voxtral_tts_healthcheck

        if provider == "auto":
            healthy, detail = await voxtral_tts_healthcheck(settings)
            if healthy:
                logger.info("Voxtral TTS server detected; using Voxtral TTS.")
                return "voxtral", create_voxtral_tts_service(settings)
            logger.info(detail)
        if provider == "fish_speech":
            return "fish_speech", create_fish_speech_tts_service(
                settings, text_aggregation_mode=text_aggregation_mode
            )

        healthy, detail = await fish_speech_healthcheck(settings)
        if healthy:
            logger.info("Fish Speech server detected; using Fish Speech TTS.")
            return "fish_speech", create_fish_speech_tts_service(
                settings, text_aggregation_mode=text_aggregation_mode
            )
        logger.info(f"{detail} Falling back to Kokoro TTS.")

    from pipecat.services.kokoro.tts import KokoroTTSService

    language = resolve_tts_language(settings)
    kokoro_dir = Path(settings.kokoro_download_dir)
    kokoro_dir.mkdir(parents=True, exist_ok=True)
    return "kokoro", KokoroTTSService(
        settings=KokoroTTSService.Settings(voice=settings.local_tts_voice, language=language),
        model_path=str(kokoro_dir / "kokoro-v1.0.onnx"),
        voices_path=str(kokoro_dir / "voices-v1.0.bin"),
        sample_rate=settings.local_audio_output_sample_rate,
        text_aggregation_mode=text_aggregation_mode,
    )


def create_local_stt_service(settings: Settings):
    if settings.local_stt_provider == "nvidia":
        from pipecat.services.nvidia.stt import NvidiaSTTService
        from pipecat.transcriptions.language import Language

        language = resolve_stt_language(settings) or Language.EN_US
        return "nvidia", NvidiaSTTService(
            api_key=settings.nvidia_api_key,
            server=settings.nvidia_stt_server,
            use_ssl=settings.nvidia_stt_use_ssl,
            sample_rate=settings.local_audio_input_sample_rate,
            ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
            settings=NvidiaSTTService.Settings(
                language=language,
                automatic_punctuation=True,
                interim_results=True,
            ),
        )

    if settings.local_stt_provider == "deepgram":
        if not settings.deepgram_api_key:
            raise RuntimeError("LOCAL_STT_PROVIDER=deepgram requires DEEPGRAM_API_KEY.")
        from pipecat.services.deepgram.stt import DeepgramSTTService
        from pipecat.transcriptions.language import Language

        language = resolve_stt_language(settings) or Language.EN
        return "deepgram", DeepgramSTTService(
            api_key=settings.deepgram_api_key,
            sample_rate=settings.local_audio_input_sample_rate,
            settings=DeepgramSTTService.Settings(
                model=settings.local_stt_model,
                language=language,
            ),
            stt_ttfb_timeout=settings.local_stt_ttfb_timeout,
            ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
        )

    if settings.local_stt_provider == "google":
        from pipecat.services.google.stt import GoogleSTTService
        from pipecat.transcriptions.language import Language

        language = resolve_stt_language(settings) or Language.EN_US
        return "google", GoogleSTTService(
            credentials=settings.local_google_credentials,
            credentials_path=settings.local_google_credentials_path,
            location=settings.local_google_stt_location or "global",
            sample_rate=settings.local_audio_input_sample_rate,
            ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
            settings=GoogleSTTService.Settings(
                model=settings.local_stt_model,
                languages=[language],
                enable_automatic_punctuation=True,
                enable_interim_results=True,
            ),
        )

    if settings.local_stt_provider == "remote_whisper":
        from .remote_whisper_stt import RemoteWhisperSTTService

        return "remote_whisper", RemoteWhisperSTTService(
            base_url=settings.remote_whisper_base_url,
            model=settings.local_stt_model,
            language=_language_or_auto(settings.local_stt_language or settings.local_voice_language),
            no_speech_prob=settings.local_stt_no_speech_prob,
            sample_rate=settings.local_audio_input_sample_rate,
            timeout_seconds=settings.remote_whisper_timeout_seconds,
            beam_size=settings.remote_whisper_beam_size,
            best_of=settings.remote_whisper_best_of,
            initial_prompt=settings.remote_whisper_initial_prompt,
            hotwords=settings.remote_whisper_hotwords,
            stt_ttfb_timeout=settings.local_stt_ttfb_timeout,
            ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
        )

    if settings.local_stt_provider == "whisperx":
        from .whisperx_stt import WhisperXSTTService

        return "whisperx", WhisperXSTTService(
            model=settings.local_stt_model,
            device=settings.local_whisperx_device,
            compute_type=settings.local_whisperx_compute_type,
            batch_size=settings.local_whisperx_batch_size,
            language=_language_or_auto(settings.local_stt_language or settings.local_voice_language),
            no_speech_prob=settings.local_stt_no_speech_prob,
            sample_rate=settings.local_audio_input_sample_rate,
            stt_ttfb_timeout=settings.local_stt_ttfb_timeout,
            ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
        )

    if settings.local_stt_provider == "whisper":
        from pipecat.services.whisper.stt import WhisperSTTService

        stt_language = resolve_stt_language(settings)
        compute_type = settings.local_whisper_compute_type
        if compute_type == "auto":
            compute_type = "default" if settings.local_whisper_device == "cuda" else "int8"
        return "whisper", WhisperSTTService(
            device=settings.local_whisper_device,
            compute_type=compute_type,
            settings=WhisperSTTService.Settings(
                model=settings.local_stt_model,
                language=stt_language,
                no_speech_prob=settings.local_stt_no_speech_prob,
            ),
            sample_rate=settings.local_audio_input_sample_rate,
            stt_ttfb_timeout=settings.local_stt_ttfb_timeout,
            ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
        )

    from pipecat.services.whisper.stt import WhisperSTTServiceMLX

    stt_language = resolve_stt_language(settings)
    return "mlx_whisper", WhisperSTTServiceMLX(
        settings=WhisperSTTServiceMLX.Settings(
            model=settings.local_stt_model,
            language=stt_language,
            no_speech_prob=settings.local_stt_no_speech_prob,
            temperature=settings.local_stt_temperature,
        ),
        sample_rate=settings.local_audio_input_sample_rate,
        stt_ttfb_timeout=settings.local_stt_ttfb_timeout,
        ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
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
) -> None:
    from loguru import logger
    from openai import NOT_GIVEN
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams
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
    from pipecat.processors.audio.vad_processor import VADProcessor
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.turns.user_start import TranscriptionUserTurnStartStrategy, VADUserTurnStartStrategy
    from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies

    effective_voice_behavior_mode = (
        voice_behavior_mode if voice_behavior_mode in {"assistant", "flow"} else settings.voice_behavior_mode
    )
    effective_voice_flow_id = (voice_flow_id or settings.voice_flow_id).strip() or "active"
    recorder.update_metadata(
        {
            "voice_behavior_mode": effective_voice_behavior_mode,
            "voice_flow_id": effective_voice_flow_id,
        }
    )

    @dataclass
    class VoiceLatencyTrace:
        interaction_id: str = field(default_factory=lambda: str(uuid.uuid4()))
        user_turn_id: str | None = None
        assistant_turn_id: str | None = None
        user_text: str = ""
        assistant_text: str = ""
        language: str | None = None
        vad_started_at: float = 0.0
        vad_stopped_at: float = 0.0
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

        def ms(self, start: float, end: float) -> int | None:
            if not start or not end or end < start:
                return None
            return int((end - start) * 1000)

        def timings(self) -> dict[str, Any]:
            first_response_at = self.tts_first_audio_at or self.llm_first_text_at
            return {
                "vad_speech_ms": self.ms(self.vad_started_at, self.vad_stopped_at),
                "stt_after_speech_end_ms": self.ms(self.vad_stopped_at, self.transcript_at),
                "stt_after_speech_start_ms": self.ms(self.vad_started_at, self.transcript_at),
                "stt_provider_elapsed_ms": self.stt_provider_elapsed_ms,
                "turn_finalization_ms": self.ms(self.transcript_at, self.llm_request_started_at),
                "llm_ttfb_ms": self.ms(self.llm_request_started_at, self.llm_first_text_at),
                "llm_total_ms": self.ms(self.llm_request_started_at, self.llm_completed_at),
                "tts_ttfb_from_first_text_ms": self.ms(self.tts_text_started_at, self.tts_first_audio_at),
                "tts_total_ms": self.ms(self.tts_text_started_at, self.tts_completed_at),
                "speech_end_to_first_text_ms": self.ms(self.vad_stopped_at, self.llm_first_text_at),
                "speech_end_to_first_audio_ms": self.ms(self.vad_stopped_at, self.tts_first_audio_at),
                "speech_start_to_first_audio_ms": self.ms(self.vad_started_at, self.tts_first_audio_at),
                "transcript_to_first_text_ms": self.ms(self.transcript_at, self.llm_first_text_at),
                "transcript_to_first_audio_ms": self.ms(self.transcript_at, self.tts_first_audio_at),
                "transcript_to_response_done_ms": self.ms(self.transcript_at, self.tts_completed_at),
                "total_interaction_ms": self.ms(self.vad_started_at, self.tts_completed_at),
                "first_response_ms": self.ms(self.vad_stopped_at, first_response_at),
                "tts_audio_chunk_count": self.tts_audio_chunk_count,
                "interrupted": self.interrupted,
            }

        def providers(self) -> dict[str, Any]:
            return {
                "stt_provider": stt_provider,
                "configured_stt_provider": settings.local_stt_provider,
                "stt_model": settings.local_stt_model,
                "stt_language": settings.local_stt_language,
                "remote_whisper_base_url": settings.remote_whisper_base_url
                if settings.local_stt_provider == "remote_whisper"
                else None,
                "tts_provider": tts_provider,
                "configured_tts_provider": settings.local_tts_provider,
                "tts_voice": settings.local_tts_voice,
                "tts_text_aggregation_mode": settings.local_tts_text_aggregation_mode,
                "voxtral_tts_model": settings.voxtral_tts_model
                if tts_provider == "voxtral"
                else None,
                "voxtral_tts_base_url": settings.voxtral_tts_base_url
                if tts_provider == "voxtral"
                else None,
                "llm_provider": settings.llm_provider,
                "llm_model": settings.active_model,
                "voice_behavior_mode": effective_voice_behavior_mode,
                "voice_flow_id": effective_voice_flow_id,
            }

    @dataclass
    class VoiceLatencyState:
        active_trace: VoiceLatencyTrace | None = None
        response_trace: VoiceLatencyTrace | None = None
        assistant_speaking: bool = False
        last_timings: dict[str, Any] = field(default_factory=dict)
        last_bottleneck: str | None = None

        def runtime_system_message(self) -> str | None:
            if not self.last_timings:
                return None
            first_response = self.last_timings.get("first_response_ms")
            total = self.last_timings.get("total_interaction_ms")
            target = settings.latency_target_ms
            breached = isinstance(first_response, int | float) and first_response > target
            return (
                "Runtime voice telemetry for the previous turn: "
                f"first_response_ms={first_response}, total_interaction_ms={total}, "
                f"dominant_bottleneck={self.last_bottleneck or 'unknown'}, target_ms={target}. "
                "Use this silently to adapt. If latency is above target, remove filler and avoid unnecessary lists, "
                "but still honor explicit requests for stories, explanations, detail, or continued talking. "
                "Do not mention telemetry unless the user asks about latency."
                if breached
                else (
                    "Runtime voice telemetry for the previous turn: "
                    f"first_response_ms={first_response}, total_interaction_ms={total}, "
                    f"dominant_bottleneck={self.last_bottleneck or 'unknown'}, target_ms={target}. "
                    "Use this silently to keep the next spoken reply concise and natural. "
                    "Do not mention telemetry unless the user asks about latency."
                )
            )

    latency_state = VoiceLatencyState()

    @dataclass
    class VoiceControlState:
        speed: float = settings.voxtral_tts_speed
        emotion_code: str = "N"
        emotion: str = "neutral"
        user_tone_override: str | None = None
        tts_service: Any | None = None

        def bind_tts(self, service: Any) -> None:
            self.tts_service = service
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
            self.runtime = FlowRuntime(db, repo, make_llm_client(settings))
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

    class VoiceOpenAILLMService(OpenAILLMService):
        async def _process_context(self, context: LLMContext):
            latest_user_text = ""
            for message in reversed(context.get_messages()):
                if _message_role(message) == "user":
                    latest_user_text = _message_content_text(message) or ""
                    break
            if policy_text := fast_policy_response(latest_user_text):
                emotion_code = (
                    emotion_code_for_turn(latest_user_text, policy_text)
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
                    log_latency(
                        "llm_policy_response",
                        trace,
                        text=policy_text,
                        emotion_code=emotion_code,
                    )
                await self._push_llm_text(prefix_emotion_code(policy_text, emotion_code))
                return
            flow_text = await voice_flow.respond(latest_user_text, latency_state.active_trace)
            if flow_text:
                emotion_code = (
                    emotion_code_for_turn(latest_user_text, flow_text)
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
            if trace:
                trace.llm_request_started_at = time.perf_counter()
                latency_state.response_trace = trace
                log_latency("llm_request_started", trace)
            messages = trim_voice_chat_messages(
                merge_adjacent_chat_messages(context.get_messages()),
                max_messages=settings.voice_llm_context_messages,
                max_chars=settings.voice_llm_context_max_chars,
            )
            if runtime_status := latency_state.runtime_system_message():
                runtime_message = {"role": "system", "content": runtime_status}
                insert_at = 1 if messages and _message_role(messages[0]) == "system" else 0
                messages = [*messages[:insert_at], runtime_message, *messages[insert_at:]]
            voice_control_status = {
                "role": "system",
                "content": (
                    "Runtime voice control state: "
                    f"speech_speed={voice_controls.speed:.2f} "
                    f"({voice_speed_label(voice_controls.speed)}), "
                    f"emotion={voice_controls.emotion}. "
                    "Use this silently. Do not ask again about speed unless the user changes it."
                ),
            }
            insert_at = 1 if messages and _message_role(messages[0]) == "system" else 0
            messages = [*messages[:insert_at], voice_control_status, *messages[insert_at:]]
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
            await super().process_frame(frame, direction)
            if isinstance(frame, VADUserStartedSpeakingFrame):
                trace = VoiceLatencyTrace(vad_started_at=time.perf_counter())
                latency_state.active_trace = trace
                log_latency("vad_started", trace)
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                trace = latency_state.active_trace
                if trace:
                    trace.vad_stopped_at = time.perf_counter()
                    log_latency("vad_stopped", trace)

            if self._capture_user and isinstance(frame, TranscriptionFrame):
                raw_text = frame.text.strip()
                text = raw_text.strip()
                if text:
                    speed_state = voice_controls.apply_user_text(text)
                    now = time.perf_counter()
                    trace = latency_state.active_trace or VoiceLatencyTrace()
                    if latency_state.active_trace is None:
                        latency_state.active_trace = trace
                    trace.transcript_at = now
                    trace.user_text = text
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
                latency_state.assistant_speaking = False
            elif self._capture_assistant and isinstance(frame, TextFrame):
                trace = latency_state.response_trace or latency_state.active_trace
                if trace and not trace.llm_first_text_at:
                    trace.llm_first_text_at = time.perf_counter()
                    trace.tts_text_started_at = trace.llm_first_text_at
                    log_latency("llm_first_text", trace, text=frame.text)
                text_for_tts = frame.text
                if self._emotion_prefix_pending:
                    self._emotion_prefix_buffer += frame.text
                    status, code, remainder = consume_emotion_prefix(self._emotion_prefix_buffer)
                    if status == "pending":
                        return
                    self._emotion_prefix_pending = False
                    self._emotion_prefix_buffer = ""
                    if status == "matched" and code:
                        voice_controls.apply_emotion_code(code)
                        if trace:
                            log_latency(
                                "voice_emotion_changed",
                                trace,
                                emotion_code=code,
                                emotion=voice_controls.emotion,
                            )
                        text_for_tts = remainder
                    else:
                        inferred_code = emotion_code_for_turn(trace.user_text if trace else "", remainder)
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
                if trace:
                    trace.llm_completed_at = completed_at
                    trace.assistant_text = text
                    log_latency("llm_completed", trace, text=text)
            elif isinstance(frame, InterruptionFrame):
                trace = latency_state.active_trace or latency_state.response_trace
                if trace:
                    trace.interrupted = True
                since_user_start_ms = trace.ms(trace.vad_started_at, time.perf_counter()) if trace else None
                logger.info(
                    "INTERRUPTION: user speech interrupted the assistant "
                    f"after {since_user_start_ms} ms"
                )
                if trace:
                    log_latency("interruption", trace, since_user_start_ms=since_user_start_ms)
            elif isinstance(frame, ErrorFrame):
                logger.error(f"PIPELINE ERROR: {frame.error}")
            await self.push_frame(frame, direction)

    class OutputAudioProbeProcessor(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection):
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
                    trace_id = recorder.record_latency_trace(
                        interaction_id=trace.interaction_id,
                        user_turn_id=trace.user_turn_id,
                        assistant_turn_id=trace.assistant_turn_id,
                        providers=trace.providers(),
                        timings=trace.timings(),
                    )
                    latency_state.last_timings = trace.timings()
                    latency_state.last_bottleneck = dominant_bottleneck(latency_state.last_timings)
                    log_latency("interaction_completed", trace, latency_trace_id=trace_id)
                    latency_state.response_trace = None
                latency_state.assistant_speaking = False
            await self.push_frame(frame, direction)

    stt_provider, stt = create_local_stt_service(settings)
    llm = VoiceOpenAILLMService(
        api_key=settings.active_api_key,
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
    tts_provider, tts = await create_local_tts_service(settings)
    voice_controls.bind_tts(tts)
    vad = VADProcessor(
        vad_analyzer=SileroVADAnalyzer(
            sample_rate=settings.local_audio_input_sample_rate,
            params=VADParams(
                confidence=settings.local_vad_confidence,
                start_secs=settings.local_vad_start_secs,
                stop_secs=settings.local_vad_stop_secs,
                min_volume=settings.local_vad_min_volume,
            ),
        ),
        speech_activity_period=settings.local_vad_speech_activity_period,
        audio_idle_timeout=settings.local_vad_audio_idle_timeout,
    )
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
    )

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
    )


async def main() -> None:
    await run_local_pipecat_voice_agent()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
