from __future__ import annotations

import base64
import io
import json
import struct
import wave
from collections.abc import AsyncGenerator, AsyncIterator
from pathlib import Path
from typing import Any

import httpx
from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import ErrorFrame, Frame, TTSAudioRawFrame
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService, TextAggregationMode
from pipecat.utils.tracing.service_decorators import traced_tts

from .config import Settings


class VoxtralTTSService(TTSService):
    """Pipecat TTS service for Voxtral-compatible /v1/audio/speech endpoints."""

    NATIVE_SAMPLE_RATE = 24000

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None = None,
        model: str = "mistralai/Voxtral-4B-TTS-2603",
        voice: str | None = "neutral_female",
        voice_id: str | None = None,
        language: str | None = "Auto",
        instructions: str | None = None,
        ref_audio_base64: str | None = None,
        response_format: str = "wav",
        stream: bool = False,
        initial_codec_chunk_frames: int | None = None,
        timeout_seconds: float = 120,
        sample_rate: int | None = None,
        **kwargs,
    ):
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=sample_rate,
            settings=TTSSettings(model=model, voice=voice_id or voice, language=None),
            **kwargs,
        )
        self._endpoint = _audio_speech_endpoint(base_url)
        self._api_key = api_key
        self._model = model
        self._voice = voice
        self._voice_id = voice_id
        self._language = language
        self._instructions = instructions
        self._ref_audio_base64 = ref_audio_base64
        self._response_format = response_format
        self._stream = stream
        self._initial_codec_chunk_frames = initial_codec_chunk_frames
        self._timeout = httpx.Timeout(timeout_seconds, connect=10)
        self._target_sample_rate = sample_rate or self.NATIVE_SAMPLE_RATE
        self._resampler = create_stream_resampler()

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        logger.debug(f"{self}: Generating Voxtral TTS [{text}]")
        ttfb_stopped = False
        try:
            await self.start_tts_usage_metrics(text)
            payload: dict[str, Any] = {
                "input": text,
                "model": self._model,
                "response_format": self._response_format,
            }
            if self._stream:
                payload["stream"] = True
            if self._voice_id:
                payload["voice_id"] = self._voice_id
            elif self._voice:
                # vLLM-Omni's OpenAI-compatible endpoint uses `voice`.
                payload["voice"] = self._voice
            if self._language:
                payload["language"] = self._language
            if self._instructions:
                payload["instructions"] = self._instructions
            if self._initial_codec_chunk_frames is not None:
                payload["initial_codec_chunk_frames"] = self._initial_codec_chunk_frames
            if self._ref_audio_base64:
                payload["ref_audio"] = self._ref_audio_base64

            headers = {"content-type": "application/json"}
            if self._stream:
                headers["accept"] = "text/event-stream"
            if self._api_key:
                headers["authorization"] = f"Bearer {self._api_key}"

            async with httpx.AsyncClient(timeout=self._timeout) as client:
                async with client.stream(
                    "POST",
                    self._endpoint,
                    json=payload,
                    headers=headers,
                ) as response:
                    if response.status_code >= 400:
                        body = (await response.aread()).decode("utf-8", errors="replace")
                        yield ErrorFrame(
                            error=(
                                "Voxtral TTS failed "
                                f"(HTTP {response.status_code}): {body[:240]}"
                            )
                        )
                        return

                    content_type = response.headers.get("content-type", "")
                    if "text/event-stream" in content_type:
                        async for audio in self._stream_sse_audio(response.aiter_lines()):
                            if not ttfb_stopped:
                                await self.stop_ttfb_metrics()
                                ttfb_stopped = True
                            yield TTSAudioRawFrame(
                                audio=audio,
                                sample_rate=self._output_sample_rate(),
                                num_channels=1,
                                context_id=context_id,
                            )
                        return

                    body = await response.aread()
                    audio = await self._decode_response_audio(body, content_type)
                    if not ttfb_stopped:
                        await self.stop_ttfb_metrics()
                        ttfb_stopped = True
                    yield TTSAudioRawFrame(
                        audio=audio,
                        sample_rate=self._output_sample_rate(),
                        num_channels=1,
                        context_id=context_id,
                    )
        except Exception as exc:
            yield ErrorFrame(error=f"Voxtral TTS failed: {exc}")
        finally:
            if not ttfb_stopped:
                await self.stop_ttfb_metrics()

    async def _stream_sse_audio(self, lines: AsyncIterator[str]) -> AsyncGenerator[bytes, None]:
        async for event, data in _iter_sse_events(lines):
            if data == "[DONE]":
                continue
            try:
                payload = json.loads(data)
            except json.JSONDecodeError:
                logger.warning(f"Skipping malformed Voxtral SSE payload for event {event}: {data[:120]}")
                continue
            event_type = event or payload.get("type")
            if event_type != "speech.audio.delta":
                continue
            audio_data = payload.get("audio_data")
            if not isinstance(audio_data, str):
                continue
            audio_bytes = base64.b64decode(audio_data)
            yield await self._decode_audio_bytes(audio_bytes, "pcm")

    async def _decode_response_audio(self, body: bytes, content_type: str) -> bytes:
        if "application/json" in content_type or body.lstrip().startswith(b"{"):
            payload = json.loads(body.decode("utf-8"))
            audio_data = payload.get("audio_data")
            if not isinstance(audio_data, str):
                raise ValueError("Voxtral JSON response did not include audio_data")
            return await self._decode_audio_bytes(
                base64.b64decode(audio_data),
                self._response_format,
            )

        response_format = "wav" if body.startswith(b"RIFF") else self._response_format
        return await self._decode_audio_bytes(body, response_format)

    async def _decode_audio_bytes(self, content: bytes, response_format: str) -> bytes:
        if response_format == "pcm":
            return await self._resampler.resample(
                _float32_to_int16(content),
                self.NATIVE_SAMPLE_RATE,
                self._output_sample_rate(),
            )
        if response_format == "wav" or content.startswith(b"RIFF"):
            return await self._decode_wav(content)
        raise ValueError(
            "Voxtral TTS response_format must be pcm or wav for direct Pipecat playback; "
            f"got {response_format}"
        )

    async def _decode_wav(self, content: bytes) -> bytes:
        with wave.open(io.BytesIO(content), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            source_rate = wav_file.getframerate()
            frames = wav_file.readframes(wav_file.getnframes())

        if channels != 1:
            raise ValueError(f"expected mono Voxtral WAV, got {channels} channels")
        if sample_width == 4:
            frames = _float32_to_int16(frames)
        elif sample_width != 2:
            raise ValueError(f"expected 16-bit or float32 Voxtral WAV, got {sample_width * 8}-bit")
        return await self._resampler.resample(frames, source_rate, self._output_sample_rate())

    def _output_sample_rate(self) -> int:
        return self.sample_rate or self._target_sample_rate


async def _iter_sse_events(lines: AsyncIterator[str]) -> AsyncGenerator[tuple[str | None, str], None]:
    event: str | None = None
    data_lines: list[str] = []
    async for raw_line in lines:
        line = raw_line.rstrip("\r")
        if not line:
            if data_lines:
                yield event, "\n".join(data_lines)
            event = None
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        field, separator, value = line.partition(":")
        if not separator:
            continue
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            event = value
        elif field == "data":
            data_lines.append(value)
    if data_lines:
        yield event, "\n".join(data_lines)


def _audio_speech_endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/audio/speech"):
        return base
    return f"{base}/audio/speech"


def _models_endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        return f"{base}/models"
    return f"{base}/v1/models"


def _float32_to_int16(data: bytes) -> bytes:
    if len(data) % 4 != 0:
        raise ValueError("float32 PCM payload length is not divisible by 4")
    count = len(data) // 4
    floats = struct.unpack(f"<{count}f", data)
    return struct.pack(
        f"<{count}h",
        *(min(32767, max(-32768, int(sample * 32767))) for sample in floats),
    )


async def voxtral_tts_healthcheck(settings: Settings) -> tuple[bool, str]:
    url = _models_endpoint(settings.voxtral_tts_base_url)
    headers = {}
    if settings.voxtral_tts_api_key:
        headers["authorization"] = f"Bearer {settings.voxtral_tts_api_key}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(2.0, connect=1.0)) as client:
            response = await client.get(url, headers=headers)
        if response.status_code == 200:
            return True, "Voxtral TTS server is healthy."
        return False, f"Voxtral TTS health returned HTTP {response.status_code} at {url}."
    except Exception as exc:
        return False, f"Voxtral TTS is not reachable at {url}: {exc}"


def create_voxtral_tts_service(settings: Settings) -> VoxtralTTSService:
    ref_audio_base64 = None
    if settings.voxtral_tts_ref_audio_path:
        ref_audio_base64 = base64.b64encode(
            Path(settings.voxtral_tts_ref_audio_path).read_bytes()
        ).decode("ascii")
    return VoxtralTTSService(
        base_url=settings.voxtral_tts_base_url,
        api_key=settings.voxtral_tts_api_key,
        model=settings.voxtral_tts_model,
        voice=settings.voxtral_tts_voice,
        voice_id=settings.voxtral_tts_voice_id,
        language=settings.voxtral_tts_language,
        instructions=settings.voxtral_tts_instructions,
        ref_audio_base64=ref_audio_base64,
        response_format=settings.voxtral_tts_response_format,
        stream=settings.voxtral_tts_stream,
        initial_codec_chunk_frames=settings.voxtral_tts_initial_codec_chunk_frames,
        timeout_seconds=settings.voxtral_tts_timeout_seconds,
        sample_rate=settings.local_audio_output_sample_rate,
        text_aggregation_mode=(
            TextAggregationMode.TOKEN
            if settings.local_tts_text_aggregation_mode == "token"
            else TextAggregationMode.SENTENCE
        ),
    )
