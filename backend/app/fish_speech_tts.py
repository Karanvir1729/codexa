from __future__ import annotations

import io
import wave
from collections.abc import AsyncGenerator
from typing import Any

import httpx
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
        sample_rate: int = 24000,
        text_aggregation_mode: TextAggregationMode = TextAggregationMode.SENTENCE,
        **kwargs: Any,
    ) -> None:
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=sample_rate,
            settings=TTSSettings(model="fish-speech", voice=reference_id, language=None),
            text_aggregation_mode=text_aggregation_mode,
            **kwargs,
        )
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._reference_id = reference_id
        self._latency = latency
        self._chunk_length = chunk_length
        self._max_new_tokens = max_new_tokens
        self._top_p = top_p
        self._repetition_penalty = repetition_penalty
        self._temperature = temperature
        self._timeout = httpx.Timeout(timeout_seconds, connect=5)
        self._target_sample_rate = sample_rate
        self._resampler = create_stream_resampler()

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        logger.debug(f"{self}: Generating Fish Speech TTS [{text}]")
        payload: dict[str, Any] = {
            "text": text,
            "format": "wav",
            "latency": self._latency,
            "chunk_length": self._chunk_length,
            "max_new_tokens": self._max_new_tokens,
            "top_p": self._top_p,
            "repetition_penalty": self._repetition_penalty,
            "temperature": self._temperature,
        }
        if self._reference_id:
            payload["reference_id"] = self._reference_id
        headers = {"content-type": "application/json"}
        if self._api_key:
            headers["authorization"] = f"Bearer {self._api_key}"

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(
                    f"{self._base_url}/v1/tts",
                    json=payload,
                    headers=headers,
                )
            if response.status_code >= 400:
                yield ErrorFrame(
                    error=(
                        "Fish Speech TTS failed "
                        f"(HTTP {response.status_code}): {response.text[:500]}"
                    )
                )
                return
            pcm, sample_rate = self._decode_wav(response.content)
            if sample_rate != self._target_sample_rate:
                pcm = await self._resampler.resample(
                    pcm,
                    sample_rate,
                    self._target_sample_rate,
                )
            yield TTSAudioRawFrame(
                audio=pcm,
                sample_rate=self._target_sample_rate,
                num_channels=1,
            )
        except Exception as exc:
            yield ErrorFrame(error=f"Fish Speech TTS failed: {exc}")

    @staticmethod
    def _decode_wav(data: bytes) -> tuple[bytes, int]:
        with wave.open(io.BytesIO(data), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            if channels != 1:
                raise ValueError(f"expected mono Fish Speech WAV, got {channels} channels")
            if sample_width != 2:
                raise ValueError(f"expected 16-bit Fish Speech WAV, got {sample_width * 8}-bit")
            return wav.readframes(wav.getnframes()), sample_rate


async def fish_speech_healthcheck(settings: Settings) -> tuple[bool, str]:
    url = settings.fish_speech_base_url.rstrip("/") + "/v1/health"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, connect=2)) as client:
            response = await client.get(url)
        if response.status_code < 400:
            return True, "Fish Speech server is healthy."
        return False, f"Fish Speech health returned HTTP {response.status_code}."
    except Exception as exc:
        return False, f"Fish Speech is not reachable at {url}: {exc}"


def create_fish_speech_tts_service(
    settings: Settings,
    *,
    text_aggregation_mode: TextAggregationMode | None = None,
) -> FishSpeechTTSService:
    return FishSpeechTTSService(
        base_url=settings.fish_speech_base_url,
        api_key=settings.fish_speech_api_key or None,
        reference_id=settings.fish_speech_reference_id or None,
        latency=settings.fish_speech_latency,
        chunk_length=settings.fish_speech_chunk_length,
        max_new_tokens=settings.fish_speech_max_new_tokens,
        top_p=settings.fish_speech_top_p,
        repetition_penalty=settings.fish_speech_repetition_penalty,
        temperature=settings.fish_speech_temperature,
        timeout_seconds=settings.fish_speech_timeout_seconds,
        sample_rate=settings.local_audio_output_sample_rate,
        text_aggregation_mode=text_aggregation_mode or TextAggregationMode.SENTENCE,
    )
