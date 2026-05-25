from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from .agent import build_runtime_system_prompt
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
    instruction = build_runtime_system_prompt(prompt_repo.active().system_prompt)
    instruction = (
        f"{instruction}\n\n"
        "Live voice constraints:\n"
        "- Answer immediately in one short sentence by default.\n"
        "- Keep normal spoken replies under 35 words; use two sentences only when necessary.\n"
        "- If the user asks for a long story or explanation, ask how long they want it before continuing.\n"
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


async def create_local_tts_service(settings: Settings):
    from loguru import logger
    from pipecat.services.kokoro.tts import KokoroTTSService

    provider = settings.local_tts_provider
    if provider in {"auto", "fish_speech"}:
        from .fish_speech_tts import create_fish_speech_tts_service, fish_speech_healthcheck

        if provider == "fish_speech":
            return "fish_speech", create_fish_speech_tts_service(settings)

        healthy, detail = await fish_speech_healthcheck(settings)
        if healthy:
            logger.info("Fish Speech server detected; using Fish Speech TTS.")
            return "fish_speech", create_fish_speech_tts_service(settings)
        logger.info(f"{detail} Falling back to Kokoro TTS.")

    language = resolve_tts_language(settings)
    return "kokoro", KokoroTTSService(
        settings=KokoroTTSService.Settings(voice=settings.local_tts_voice, language=language),
        sample_rate=settings.local_audio_output_sample_rate,
    )


def create_local_stt_service(settings: Settings):
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
    class VoiceLatencyState:
        user_vad_started_at: float = 0.0
        user_vad_stopped_at: float = 0.0
        user_transcript_at: float = 0.0
        assistant_llm_started_at: float = 0.0
        assistant_first_text_at: float = 0.0
        assistant_first_audio_at: float = 0.0
        assistant_speaking: bool = False

    latency_state = VoiceLatencyState()

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
                latency_state.user_vad_started_at = time.perf_counter()
            elif isinstance(frame, VADUserStoppedSpeakingFrame):
                latency_state.user_vad_stopped_at = time.perf_counter()

            if self._capture_user and isinstance(frame, TranscriptionFrame):
                text = frame.text.strip()
                if text:
                    now = time.perf_counter()
                    latency_state.user_transcript_at = now
                    language = str(frame.language) if frame.language else None
                    vad_to_transcript_ms = (
                        int((now - latency_state.user_vad_started_at) * 1000)
                        if latency_state.user_vad_started_at
                        else None
                    )
                    speech_end_to_transcript_ms = (
                        int((now - latency_state.user_vad_stopped_at) * 1000)
                        if latency_state.user_vad_stopped_at
                        else None
                    )
                    recorder.record_turn(
                        "user",
                        text,
                        metrics={
                            "language": language,
                            "source": settings.local_stt_provider,
                            "stt_model": settings.local_stt_model,
                            "vad_to_transcript_ms": vad_to_transcript_ms,
                            "speech_end_to_transcript_ms": speech_end_to_transcript_ms,
                        },
                    )
                    logger.info(f"USER: {text}")
            elif self._capture_assistant and isinstance(frame, LLMFullResponseStartFrame):
                self._assistant_parts = []
                self._assistant_started_at = time.perf_counter()
                latency_state.assistant_llm_started_at = self._assistant_started_at
                latency_state.assistant_first_text_at = 0.0
                latency_state.assistant_first_audio_at = 0.0
                latency_state.assistant_speaking = False
            elif self._capture_assistant and isinstance(frame, TextFrame):
                if not latency_state.assistant_first_text_at:
                    latency_state.assistant_first_text_at = time.perf_counter()
                self._assistant_parts.append(frame.text)
            elif self._capture_assistant and isinstance(frame, LLMFullResponseEndFrame):
                text = "".join(self._assistant_parts).strip()
                completed_at = time.perf_counter()
                generation_ms = (
                    int((time.perf_counter() - self._assistant_started_at) * 1000)
                    if self._assistant_started_at
                    else None
                )
                speech_to_first_text_ms = (
                    int((latency_state.assistant_first_text_at - latency_state.user_transcript_at) * 1000)
                    if latency_state.user_transcript_at and latency_state.assistant_first_text_at
                    else None
                )
                speech_to_first_audio_ms = (
                    int((latency_state.assistant_first_audio_at - latency_state.user_transcript_at) * 1000)
                    if latency_state.user_transcript_at and latency_state.assistant_first_audio_at
                    else None
                )
                latency_ms = speech_to_first_audio_ms or speech_to_first_text_ms or generation_ms
                if text:
                    recorder.record_turn(
                        "assistant",
                        text,
                        latency_ms=latency_ms,
                        metrics={
                            "source": "local_pipecat",
                            "generation_ms": generation_ms,
                            "speech_to_first_text_ms": speech_to_first_text_ms,
                            "speech_to_first_audio_ms": speech_to_first_audio_ms,
                            "completed_after_user_transcript_ms": (
                                int((completed_at - latency_state.user_transcript_at) * 1000)
                                if latency_state.user_transcript_at
                                else None
                            ),
                        },
                    )
                    logger.info(f"ASSISTANT: {text}")
            elif isinstance(frame, InterruptionFrame):
                since_user_start_ms = (
                    int((time.perf_counter() - latency_state.user_vad_started_at) * 1000)
                    if latency_state.user_vad_started_at
                    else None
                )
                logger.info(
                    "INTERRUPTION: user speech interrupted the assistant "
                    f"after {since_user_start_ms} ms"
                )
            elif isinstance(frame, ErrorFrame):
                logger.error(f"PIPELINE ERROR: {frame.error}")
            await self.push_frame(frame, direction)

    class OutputAudioProbeProcessor(FrameProcessor):
        async def process_frame(self, frame: Frame, direction: FrameDirection):
            await super().process_frame(frame, direction)
            if isinstance(frame, TTSAudioRawFrame) and not latency_state.assistant_first_audio_at:
                latency_state.assistant_first_audio_at = time.perf_counter()
                latency_state.assistant_speaking = True
            elif isinstance(frame, TTSStoppedFrame):
                latency_state.assistant_speaking = False
            await self.push_frame(frame, direction)

    stt_provider, stt = create_local_stt_service(settings)
    llm = OpenAILLMService(
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
