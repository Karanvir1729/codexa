from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncGenerator

import httpx
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.stt_service import STTSettings, SegmentedSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601


@dataclass(frozen=True)
class RemoteWhisperOptions:
    base_url: str
    model: str
    language: str | None
    no_speech_prob: float | None
    sample_rate: int
    timeout_seconds: float


class RemoteWhisperSTTService(SegmentedSTTService):
    """Pipecat segmented STT backed by a same-VPC Faster Whisper HTTP worker."""

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        language: str | Language | None,
        no_speech_prob: float | None,
        sample_rate: int,
        timeout_seconds: float,
        stt_ttfb_timeout: float,
        ttfs_p99_latency: float,
    ) -> None:
        self.options = RemoteWhisperOptions(
            base_url=base_url.rstrip("/"),
            model=model,
            language=_language_code(language),
            no_speech_prob=no_speech_prob,
            sample_rate=sample_rate,
            timeout_seconds=timeout_seconds,
        )
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
            logger.exception("Remote Whisper STT failed")
            await self.stop_processing_metrics()
            yield ErrorFrame(
                error=f"Remote Whisper STT failed: {_failure_detail(exc, self.options.base_url)}"
            )
            return

        text = str(transcript.get("text", "")).strip()
        if not text:
            if reason := transcript.get("filtered_reason"):
                logger.debug(
                    "Remote Whisper suppressed transcript "
                    f"reason={reason} duration_ms={transcript.get('audio_duration_ms')} "
                    f"rms={transcript.get('audio_rms')}"
                )
            return

        logger.debug(f"Remote Whisper transcription: [{text}]")
        language = _pipecat_language(transcript.get("language"))
        yield TranscriptionFrame(
            text,
            self._user_id,
            time_now_iso8601(),
            language=language,
            result=transcript,
        )

    async def _transcribe(self, audio: bytes) -> dict[str, Any]:
        params: dict[str, Any] = {
            "sample_rate": self.options.sample_rate,
            "model": self.options.model,
        }
        if self.options.language:
            params["language"] = self.options.language
        if self.options.no_speech_prob is not None:
            params["no_speech_prob"] = self.options.no_speech_prob

        timeout = httpx.Timeout(self.options.timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.options.base_url}/transcribe",
                params=params,
                content=audio,
                headers={"content-type": "application/octet-stream"},
            )
            response.raise_for_status()
            return response.json()


def _language_code(language: str | Language | None) -> str | None:
    if language is None:
        return None
    value = str(language).strip()
    if value.lower() in {"", "auto", "none", "null"}:
        return None
    if "." in value:
        value = value.rsplit(".", 1)[-1]
    return value.lower()


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
