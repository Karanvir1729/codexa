from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from .agent import build_runtime_system_prompt, fast_policy_response
from .config import Settings, get_settings
from .db import Database, dumps
from .feedback import PromptRepository


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
                    }
                ),
            ),
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
        "- Answer immediately in one short sentence by default.\n"
        "- Speak English only unless the latest user utterance explicitly asks for another language.\n"
        "- If the user speaks Hindi, Urdu, or Hinglish, answer in that language only for that turn.\n"
        "- Use plain ASCII English when the TTS voice is English.\n"
        "- Keep normal spoken replies under 18 words; use two sentences only when necessary.\n"
        "- You are latency-aware: if runtime telemetry says the previous turn was slow, shorten the next reply.\n"
        "- Control voice behavior through the spoken content: concise wording for speed, calm wording for tone, and the user's language for language.\n"
        "- If the user asks for a long story or explanation, ask how long they want it before continuing.\n"
        "- If asked about latency, identify the slow stage from runtime telemetry when it is available.\n"
        "- Do not mention model identity, internal policy, or provider names unless the user asks."
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
                "Use this silently to adapt. If latency is above target, answer in under 12 words, "
                "avoid lists, avoid long explanations, and prefer one spoken sentence. "
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
                trace = latency_state.active_trace
                now = time.perf_counter()
                if trace:
                    trace.llm_request_started_at = now
                    trace.llm_first_text_at = now
                    trace.llm_completed_at = now
                    latency_state.response_trace = trace
                    log_latency("llm_policy_response", trace, text=policy_text)
                await self._push_llm_text(policy_text)
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
                text = frame.text.strip()
                if text:
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
                            **trace.timings(),
                        },
                    )
                    trace.user_turn_id = user_turn_id or trace.user_turn_id
                    logger.info(f"USER: {text}")
                    log_latency("user_transcribed", trace, text=text, language=language)
            elif self._capture_assistant and isinstance(frame, LLMFullResponseStartFrame):
                self._assistant_parts = []
                self._assistant_started_at = time.perf_counter()
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
                self._assistant_parts.append(frame.text)
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
    )


async def run_browser_pipecat_voice_agent(
    webrtc_connection,
    settings: Settings | None = None,
    db: Database | None = None,
    prompt_repo: PromptRepository | None = None,
    session_id: str | None = None,
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
    )


async def main() -> None:
    await run_local_pipecat_voice_agent()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
