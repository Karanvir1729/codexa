from __future__ import annotations

import base64
import io
import wave
from dataclasses import dataclass
from typing import Any, AsyncGenerator

import httpx
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.stt_service import STTSettings, SegmentedSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601


@dataclass(frozen=True)
class OpenRouterSTTOptions:
    base_url: str
    api_key: str
    model: str
    language: str | None
    temperature: float | None
    sample_rate: int
    timeout_seconds: float
    site_url: str | None
    app_title: str | None


class OpenRouterSTTService(SegmentedSTTService):
    """Pipecat segmented STT backed by OpenRouter's audio transcriptions API."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        language: str | Language | None,
        temperature: float | None,
        sample_rate: int,
        timeout_seconds: float,
        site_url: str | None = None,
        app_title: str | None = None,
        stt_ttfb_timeout: float,
        ttfs_p99_latency: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.options = OpenRouterSTTOptions(
            base_url=base_url.rstrip("/"),
            api_key=api_key,
            model=model,
            language=_language_code(language),
            temperature=temperature,
            sample_rate=sample_rate,
            timeout_seconds=timeout_seconds,
            site_url=site_url,
            app_title=app_title,
        )
        self._transport = transport
        super().__init__(
            sample_rate=sample_rate,
            stt_ttfb_timeout=stt_ttfb_timeout,
            ttfs_p99_latency=ttfs_p99_latency,
            settings=STTSettings(model=model, language=language),
        )

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        await self.start_processing_metrics()
        try:
            transcript = await self._transcribe(audio)
            await self.stop_processing_metrics()
        except Exception as exc:
            logger.exception("OpenRouter STT failed")
            await self.stop_processing_metrics()
            yield ErrorFrame(
                error=f"OpenRouter STT failed: {_failure_detail(exc, self.options.base_url)}"
            )
            return

        text = str(transcript.get("text", "")).strip()
        if not text:
            return

        logger.debug(f"OpenRouter transcription: [{text}]")
        language = _pipecat_language(transcript.get("language"))
        yield TranscriptionFrame(
            text,
            self._user_id,
            time_now_iso8601(),
            language=language,
            result=transcript,
        )

    async def _transcribe(self, audio: bytes) -> dict[str, Any]:
        wav_audio = audio if audio.startswith(b"RIFF") else _pcm16_to_wav(audio, self.options.sample_rate)
        payload: dict[str, Any] = {
            "model": self.options.model,
            "input_audio": {
                "data": base64.b64encode(wav_audio).decode("ascii"),
                "format": "wav",
            },
        }
        if self.options.language:
            payload["language"] = self.options.language
        if self.options.temperature is not None:
            payload["temperature"] = self.options.temperature

        timeout = httpx.Timeout(self.options.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout, transport=self._transport) as client:
            response = await client.post(
                f"{self.options.base_url}/audio/transcriptions",
                json=payload,
                headers=_headers(self.options),
            )
            response.raise_for_status()
            result = response.json()
            generation_id = response.headers.get("x-generation-id")
            if generation_id and isinstance(result, dict):
                result["generation_id"] = generation_id
            return result


def _pcm16_to_wav(audio: bytes, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio)
    return buffer.getvalue()


def _headers(options: OpenRouterSTTOptions) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {options.api_key}",
        "Content-Type": "application/json",
    }
    if options.site_url:
        headers["HTTP-Referer"] = options.site_url
    if options.app_title:
        headers["X-Title"] = options.app_title
    return headers


def _language_code(language: str | Language | None) -> str | None:
    if language is None:
        return None
    value = str(language).strip()
    if value.lower() in {"", "auto", "none", "null"}:
        return None
    if "." in value:
        value = value.rsplit(".", 1)[-1]
    value = value.replace("_", "-").lower()
    return value.split("-", 1)[0]


def _pipecat_language(language: str | None) -> Language | None:
    if not language:
        return None
    try:
        return Language(language)
    except ValueError:
        return None


def _failure_detail(exc: Exception, base_url: str) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        body = exc.response.text.strip()
        if len(body) > 300:
            body = f"{body[:300]}..."
        return f"{type(exc).__name__} from {base_url}: HTTP {exc.response.status_code} {body}"

    message = str(exc).strip()
    if message:
        return f"{type(exc).__name__} contacting {base_url}: {message}"
    return f"{type(exc).__name__} contacting {base_url}"
