from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from .config import Settings, get_settings
from .db import Database, dumps
from .feedback import PromptRepository


@dataclass
class LocalVoiceConversationRecorder:
    db: Database
    settings: Settings
    prompt_version: int
    conversation_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def start(self) -> None:
        self.db.execute(
            """
            INSERT OR IGNORE INTO conversations(id, channel, metadata_json)
            VALUES (?, 'local_pipecat', ?)
            """,
            (
                self.conversation_id,
                dumps(
                    {
                        "llm_provider": self.settings.llm_provider,
                        "model": self.settings.active_model,
                        "stt_model": self.settings.local_stt_model,
                        "tts_voice": self.settings.local_tts_voice,
                        "transport": "pipecat.local_audio",
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
    instruction = prompt_repo.active().compiled
    if settings.reasoning_mode == "off":
        return f"/no_think\n{instruction}"
    return instruction


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
        TranscriptionFrame,
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
    from pipecat.services.kokoro.tts import KokoroTTSService
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.services.whisper.stt import WhisperSTTServiceMLX
    from pipecat.transcriptions.language import Language
    from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
    from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies

    class TranscriptCaptureProcessor(FrameProcessor):
        def __init__(self, *, capture_user: bool = False, capture_assistant: bool = False):
            super().__init__()
            self._capture_user = capture_user
            self._capture_assistant = capture_assistant
            self._assistant_parts: list[str] = []
            self._assistant_started_at = 0.0

        async def process_frame(self, frame: Frame, direction: FrameDirection):
            await super().process_frame(frame, direction)
            if self._capture_user and isinstance(frame, TranscriptionFrame):
                text = frame.text.strip()
                if text:
                    recorder.record_turn(
                        "user",
                        text,
                        metrics={"language": str(frame.language), "source": "local_whisper"},
                    )
                    logger.info(f"USER: {text}")
            elif self._capture_assistant and isinstance(frame, LLMFullResponseStartFrame):
                self._assistant_parts = []
                self._assistant_started_at = time.perf_counter()
            elif self._capture_assistant and isinstance(frame, TextFrame):
                self._assistant_parts.append(frame.text)
            elif self._capture_assistant and isinstance(frame, LLMFullResponseEndFrame):
                text = "".join(self._assistant_parts).strip()
                latency_ms = (
                    int((time.perf_counter() - self._assistant_started_at) * 1000)
                    if self._assistant_started_at
                    else None
                )
                if text:
                    recorder.record_turn(
                        "assistant",
                        text,
                        latency_ms=latency_ms,
                        metrics={"source": "local_pipecat"},
                    )
                    logger.info(f"ASSISTANT: {text}")
            elif isinstance(frame, InterruptionFrame):
                logger.info("INTERRUPTION: user speech interrupted the assistant")
            elif isinstance(frame, ErrorFrame):
                logger.error(f"PIPELINE ERROR: {frame.error}")
            await self.push_frame(frame, direction)

    language = Language(settings.local_voice_language)
    transport = LocalAudioTransport(
        LocalAudioTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=settings.local_audio_input_sample_rate,
            audio_out_sample_rate=settings.local_audio_output_sample_rate,
            audio_in_passthrough=True,
            input_device_index=settings.local_audio_input_device_index,
            output_device_index=settings.local_audio_output_device_index,
        )
    )
    stt = WhisperSTTServiceMLX(
        settings=WhisperSTTServiceMLX.Settings(
            model=settings.local_stt_model,
            language=language,
            no_speech_prob=settings.local_stt_no_speech_prob,
            temperature=settings.local_stt_temperature,
        ),
        sample_rate=settings.local_audio_input_sample_rate,
        ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
    )
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
    tts = KokoroTTSService(
        settings=KokoroTTSService.Settings(voice=settings.local_tts_voice, language=language),
        sample_rate=settings.local_audio_output_sample_rate,
    )
    vad = VADProcessor(
        vad_analyzer=SileroVADAnalyzer(
            sample_rate=settings.local_audio_input_sample_rate,
            params=VADParams(
                confidence=settings.local_vad_confidence,
                start_secs=settings.local_vad_start_secs,
                stop_secs=settings.local_vad_stop_secs,
                min_volume=settings.local_vad_min_volume,
            ),
        )
    )
    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                stop=[
                    SpeechTimeoutUserTurnStopStrategy(
                        user_speech_timeout=settings.local_user_speech_timeout
                    )
                ]
            ),
            user_turn_stop_timeout=4.0,
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

    logger.info("Local Pipecat voice agent is live.")
    logger.info(f"Conversation ID: {recorder.conversation_id}")
    logger.info(
        f"STT={settings.local_stt_model} TTS={settings.local_tts_voice} LLM={settings.active_model}"
    )
    logger.info("Speak into the Mac microphone. Start talking over the assistant to test interruption.")
    await PipelineRunner(handle_sigint=True).run(task)


async def main() -> None:
    await run_local_pipecat_voice_agent()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
