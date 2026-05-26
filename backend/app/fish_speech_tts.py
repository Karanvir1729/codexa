from __future__ import annotations

import io
import wave
from collections.abc import AsyncGenerator

import httpx
import ormsgpack
from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService, TextAggregationMode
from pipecat.utils.tracing.service_decorators import traced_tts

from .config import Settings


class FishSpeechTTSService(TTSService):
    """Pipecat TTS service for a self-hosted Fish Speech HTTP server."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None = None,
        reference_id: str | None = None,
        latency: str = "normal",
        chunk_length: int = 300,
        max_new_tokens: int = 1024,
        top_p: float = 0.8,
        repetition_penalty: float = 1.1,
        temperature: float = 0.8,
        timeout_seconds: float = 120,
        sample_rate: int | None = None,
        **kwargs,
    ):
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=sample_rate,
            settings=TTSSettings(model="fish-speech", voice=reference_id, language=None),
            **kwargs,
        )
        self._endpoint = f"{base_url.rstrip('/')}/v1/tts"
        self._api_key = api_key
        self._reference_id = reference_id
        self._latency = latency
        self._chunk_length = chunk_length
        self._max_new_tokens = max_new_tokens
        self._top_p = top_p
        self._repetition_penalty = repetition_penalty
        self._temperature = temperature
        self._timeout = httpx.Timeout(timeout_seconds, connect=10)
        self._target_sample_rate = sample_rate or 24000
        self._resampler = create_stream_resampler()

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        logger.debug(f"{self}: Generating Fish Speech TTS [{text}]")
        try:
            await self.start_tts_usage_metrics(text)
            payload = {
                "text": text,
                "references": [],
                "reference_id": self._reference_id,
                "format": "wav",
                "latency": self._latency,
                "max_new_tokens": self._max_new_tokens,
                "chunk_length": self._chunk_length,
                "top_p": self._top_p,
                "repetition_penalty": self._repetition_penalty,
                "temperature": self._temperature,
                "streaming": False,
                "use_memory_cache": "on",
                "seed": None,
            }
            headers = {"content-type": "application/msgpack"}
            if self._api_key:
                headers["authorization"] = f"Bearer {self._api_key}"

            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(
                    self._endpoint,
                    params={"format": "msgpack"},
                    content=ormsgpack.packb(payload),
                    headers=headers,
                )
            if response.status_code >= 400:
                yield ErrorFrame(
                    error=(
                        "Fish Speech TTS failed "
                        f"(HTTP {response.status_code}): {response.text[:240]}"
                    )
                )
                return

            audio_data = await self._decode_wav(response.content)
            await self.stop_ttfb_metrics()
            yield TTSAudioRawFrame(
                audio=audio_data,
                sample_rate=self._output_sample_rate(),
                num_channels=1,
                context_id=context_id,
            )
        except Exception as exc:
            yield ErrorFrame(error=f"Fish Speech TTS failed: {exc}")
        finally:
            await self.stop_ttfb_metrics()

    async def _decode_wav(self, content: bytes) -> bytes:
        with wave.open(io.BytesIO(content), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            source_rate = wav_file.getframerate()
            frames = wav_file.readframes(wav_file.getnframes())

        if channels != 1:
            raise ValueError(f"expected mono Fish Speech WAV, got {channels} channels")
        if sample_width != 2:
            raise ValueError(f"expected 16-bit Fish Speech WAV, got {sample_width * 8}-bit")
        return await self._resampler.resample(frames, source_rate, self._output_sample_rate())

    def _output_sample_rate(self) -> int:
        return self.sample_rate or self._target_sample_rate


async def fish_speech_healthcheck(settings: Settings) -> tuple[bool, str]:
    url = f"{settings.fish_speech_base_url.rstrip('/')}/v1/health"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(2.0, connect=1.0)) as client:
            response = await client.get(url)
        if response.status_code == 200:
            return True, "Fish Speech server is healthy."
        return False, f"Fish Speech health returned HTTP {response.status_code}."
    except Exception as exc:
        return False, f"Fish Speech is not reachable at {url}: {exc}"


def create_fish_speech_tts_service(
    settings: Settings,
    *,
    text_aggregation_mode: TextAggregationMode | None = None,
) -> FishSpeechTTSService:
    kwargs = {}
    if text_aggregation_mode is not None:
        kwargs["text_aggregation_mode"] = text_aggregation_mode
    return FishSpeechTTSService(
        base_url=settings.fish_speech_base_url,
        api_key=settings.fish_speech_api_key,
        reference_id=settings.fish_speech_reference_id,
        latency=settings.fish_speech_latency,
        chunk_length=settings.fish_speech_chunk_length,
        max_new_tokens=settings.fish_speech_max_new_tokens,
        top_p=settings.fish_speech_top_p,
        repetition_penalty=settings.fish_speech_repetition_penalty,
        temperature=settings.fish_speech_temperature,
        timeout_seconds=settings.fish_speech_timeout_seconds,
        sample_rate=settings.local_audio_output_sample_rate,
        **kwargs,
    )
