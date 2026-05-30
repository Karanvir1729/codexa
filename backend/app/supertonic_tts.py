from __future__ import annotations

import io
import json
import time
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
from .voice_self_observe import (
    DISCOVERED_SUPERTONIC_EXPRESSION_TAGS,
    clamp_supertonic_params,
    render_expression_tags,
)


class SupertonicTTSService(TTSService):
    """Pipecat TTS service for a local Supertonic HTTP server."""

    NATIVE_SAMPLE_RATE = 44100

    def __init__(
        self,
        *,
        base_url: str,
        endpoint: str = "/v1/tts",
        model: str = "supertonic-3",
        voice: str = "M1",
        language: str = "na",
        steps: int = 8,
        speed: float = 1.05,
        max_chunk_length: int = 300,
        silence_duration: float = 0.3,
        response_format: str = "wav",
        timeout_seconds: float = 60,
        sample_rate: int | None = None,
        text_aggregation_mode: TextAggregationMode = TextAggregationMode.SENTENCE,
        expression_mode: str = "subtle",
        max_expression_tags_per_utterance: int = 1,
        **kwargs,
    ):
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=sample_rate,
            settings=TTSSettings(model=model, voice=voice, language=None),
            text_aggregation_mode=text_aggregation_mode,
            **kwargs,
        )
        normalized_endpoint = endpoint if endpoint.startswith("/") else f"/{endpoint}"
        self._endpoint = f"{base_url.rstrip('/')}{normalized_endpoint}"
        self._model = model
        self._voice = voice
        self._language = language
        clamped = clamp_supertonic_params(
            {
                "voice": voice,
                "lang": language,
                "steps": steps,
                "speed": speed,
                "max_chunk_length": max_chunk_length,
                "silence_duration": silence_duration,
                "response_format": response_format,
            }
        )
        self._steps = clamped["steps"]
        self._speed = clamped["speed"]
        self._max_chunk_length = clamped["max_chunk_length"]
        self._silence_duration = clamped["silence_duration"]
        self._response_format = clamped["response_format"]
        self._expression_mode = expression_mode
        self._max_expression_tags_per_utterance = max_expression_tags_per_utterance
        self._allowed_expression_tags = list(DISCOVERED_SUPERTONIC_EXPRESSION_TAGS)
        self._timeout = httpx.Timeout(timeout_seconds, connect=5)
        self._target_sample_rate = sample_rate or self.NATIVE_SAMPLE_RATE
        self._resampler = create_stream_resampler()
        self._render_history: list[dict[str, Any]] = []
        self._last_payload: dict[str, Any] | None = None
        self._warmed = False

    def set_speed(self, speed: float) -> None:
        self._speed = max(0.7, min(2.0, speed))

    def set_emotion(self, _emotion: str) -> None:
        # Supertonic expression tags are inline text controls. They are applied
        # by the renderer immediately before synthesis, not by the LLM prompt.
        return

    def apply_runtime_profile(self, profile: dict[str, Any]) -> None:
        tts = profile.get("tts") if isinstance(profile.get("tts"), dict) else {}
        clamped = clamp_supertonic_params(tts)
        self._voice = clamped["voice"]
        self._language = clamped["lang"]
        self._speed = clamped["speed"]
        self._steps = clamped["steps"]
        self._max_chunk_length = clamped["max_chunk_length"]
        self._silence_duration = clamped["silence_duration"]
        self._response_format = clamped["response_format"]
        self._expression_mode = str(tts.get("expression_mode") or self._expression_mode)
        self._max_expression_tags_per_utterance = int(
            tts.get("max_expression_tags_per_utterance")
            or self._max_expression_tags_per_utterance
        )

    def drain_render_history(self) -> list[dict[str, Any]]:
        history = list(self._render_history)
        self._render_history.clear()
        return history

    def current_params(self) -> dict[str, Any]:
        return {
            "voice": self._voice,
            "lang": self._language,
            "speed": round(self._speed, 2),
            "steps": self._steps,
            "max_chunk_length": self._max_chunk_length,
            "silence_duration": self._silence_duration,
            "response_format": self._response_format,
            "expression_mode": self._expression_mode,
            "allowed_expression_tags": list(self._allowed_expression_tags),
            "max_expression_tags_per_utterance": self._max_expression_tags_per_utterance,
        }

    async def warmup(self) -> None:
        if self._warmed:
            return
        payload: dict[str, Any] = {
            "text": "Ready.",
            "voice": self._voice,
            "lang": self._language,
            "steps": self._steps,
            "speed": round(self._speed, 2),
            "max_chunk_length": self._max_chunk_length,
            "silence_duration": self._silence_duration,
            "response_format": self._response_format,
        }
        started_at = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(
                    self._endpoint,
                    json=payload,
                    headers={"content-type": "application/json"},
                )
            response.raise_for_status()
            self._warmed = True
            logger.info(
                "SUPERTONIC_TTS_WARMUP "
                + json.dumps(
                    {
                        "event": "supertonic_tts_warmup",
                        "provider": "supertonic",
                        "elapsed_ms": int((time.perf_counter() - started_at) * 1000),
                        "voice": payload["voice"],
                        "speed": payload["speed"],
                        "steps": payload["steps"],
                        "max_chunk_length": payload["max_chunk_length"],
                        "silence_duration": payload["silence_duration"],
                        "response_format": payload["response_format"],
                    }
                )
            )
        except Exception as exc:
            logger.warning(f"Supertonic TTS warmup failed: {type(exc).__name__}: {exc}")

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        render = render_expression_tags(
            text,
            {
                "tts": {
                    **self.current_params(),
                    "allowed_expression_tags": self._allowed_expression_tags,
                }
            },
        )
        clean_text = render["clean_text"]
        rendered_text = render["rendered_text"]
        logger.debug(f"{self}: Generating Supertonic TTS [{rendered_text}]")
        try:
            if self._response_format != "wav":
                yield ErrorFrame(
                    error=(
                        "Supertonic Pipecat audio pipeline requires response_format='wav'; "
                        f"got {self._response_format!r}."
                    )
                )
                return
            await self.start_tts_usage_metrics(text)
            payload: dict[str, Any] = {
                "text": rendered_text or clean_text,
                "voice": self._voice,
                "lang": self._language,
                "steps": self._steps,
                "speed": round(self._speed, 2),
                "max_chunk_length": self._max_chunk_length,
                "silence_duration": self._silence_duration,
                "response_format": self._response_format,
            }
            self._last_payload = dict(payload)
            render["supertonic_payload"] = dict(payload)
            self._render_history.append(render)
            logger.info(
                "SUPERTONIC_TTS_REQUEST "
                + json.dumps(
                    {
                        "event": "supertonic_tts_request",
                        "provider": "supertonic",
                        "voice": payload["voice"],
                        "speed": payload["speed"],
                        "steps": payload["steps"],
                        "max_chunk_length": payload["max_chunk_length"],
                        "silence_duration": payload["silence_duration"],
                        "response_format": payload["response_format"],
                    }
                )
            )
            headers = {"content-type": "application/json"}
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(self._endpoint, json=payload, headers=headers)
            if response.status_code >= 400:
                yield ErrorFrame(
                    error=(
                        "Supertonic TTS failed "
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
            yield ErrorFrame(error=f"Supertonic TTS failed: {exc}")
        finally:
            await self.stop_ttfb_metrics()

    async def _decode_wav(self, content: bytes) -> bytes:
        with wave.open(io.BytesIO(content), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            source_rate = wav_file.getframerate()
            frames = wav_file.readframes(wav_file.getnframes())

        if channels != 1:
            raise ValueError(f"expected mono Supertonic WAV, got {channels} channels")
        if sample_width != 2:
            raise ValueError(f"expected 16-bit Supertonic WAV, got {sample_width * 8}-bit")
        return await self._resampler.resample(frames, source_rate, self._output_sample_rate())

    def _output_sample_rate(self) -> int:
        return self.sample_rate or self._target_sample_rate

    def last_payload(self) -> dict[str, Any] | None:
        return dict(self._last_payload) if self._last_payload else None


async def supertonic_healthcheck(settings: Settings) -> tuple[bool, str]:
    base = settings.supertonic_base_url.rstrip("/")
    urls = [f"{base}/v1/health", f"{base}/v1/styles", f"{base}/docs"]
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(2.0, connect=1.0)) as client:
            last_status = 0
            for url in urls:
                response = await client.get(url)
                last_status = response.status_code
                if response.status_code == 200:
                    return True, "Supertonic server is healthy."
        return False, f"Supertonic health returned HTTP {last_status} at {urls[-1]}."
    except Exception as exc:
        return False, f"Supertonic is not reachable at {base}: {exc}"


def create_supertonic_tts_service(
    settings: Settings,
    *,
    text_aggregation_mode: TextAggregationMode | None = None,
) -> SupertonicTTSService:
    kwargs = {}
    if text_aggregation_mode is not None:
        kwargs["text_aggregation_mode"] = text_aggregation_mode
    return SupertonicTTSService(
        base_url=settings.supertonic_base_url,
        endpoint=settings.supertonic_endpoint,
        model=settings.supertonic_model,
        voice=settings.supertonic_voice,
        language=settings.supertonic_language,
        steps=settings.supertonic_steps,
        speed=settings.supertonic_speed,
        max_chunk_length=settings.supertonic_max_chunk_length,
        silence_duration=settings.supertonic_silence_duration,
        response_format=settings.supertonic_response_format,
        timeout_seconds=settings.supertonic_timeout_seconds,
        sample_rate=settings.local_audio_output_sample_rate,
        expression_mode=settings.supertonic_expression_mode,
        max_expression_tags_per_utterance=settings.supertonic_max_expression_tags_per_utterance,
        **kwargs,
    )
