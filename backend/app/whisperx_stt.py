from __future__ import annotations

import asyncio
import io
import wave
from dataclasses import dataclass
from typing import Any, AsyncGenerator

import numpy as np
from loguru import logger
from pipecat.frames.frames import ErrorFrame, Frame, TranscriptionFrame
from pipecat.services.stt_service import STTSettings, SegmentedSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601


@dataclass(frozen=True)
class WhisperXOptions:
    model: str
    device: str
    compute_type: str
    batch_size: int
    language: str | None
    no_speech_prob: float | None


class WhisperXSTTService(SegmentedSTTService):
    """Pipecat segmented STT service backed by WhisperX.

    WhisperX is not a streaming ASR server. For live voice we use it on VAD-cut
    utterances, keep the model warm in-process, and skip alignment/diarization
    in the hot path. Alignment remains a post-call enhancement because it adds
    latency that is audible in an interactive agent.
    """

    def __init__(
        self,
        *,
        model: str,
        device: str,
        compute_type: str,
        batch_size: int,
        language: str | Language | None,
        no_speech_prob: float | None,
        sample_rate: int,
        stt_ttfb_timeout: float,
        ttfs_p99_latency: float,
    ) -> None:
        self.options = WhisperXOptions(
            model=model,
            device=_resolve_device(device),
            compute_type=_resolve_compute_type(compute_type, device),
            batch_size=batch_size,
            language=_language_code(language),
            no_speech_prob=no_speech_prob,
        )
        self._model: Any | None = None
        super().__init__(
            sample_rate=sample_rate,
            stt_ttfb_timeout=stt_ttfb_timeout,
            ttfs_p99_latency=ttfs_p99_latency,
            settings=STTSettings(model=model, language=language),
        )

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        try:
            await self.start_processing_metrics()
            transcript = await asyncio.to_thread(self._transcribe_sync, audio)
            await self.stop_processing_metrics()
        except Exception as exc:
            yield ErrorFrame(error=f"WhisperX STT failed: {exc}")
            return

        text = transcript["text"].strip()
        if not text:
            return

        logger.debug(f"WhisperX transcription: [{text}]")
        yield TranscriptionFrame(
            text,
            self._user_id,
            time_now_iso8601(),
            language=_pipecat_language(transcript.get("language")),
            result=transcript,
        )

    def _transcribe_sync(self, audio: bytes) -> dict[str, Any]:
        model = self._get_model()
        audio_float = _pcm16_mono_float(audio, fallback_sample_rate=self.sample_rate)

        kwargs: dict[str, Any] = {"batch_size": self.options.batch_size}
        if self.options.language:
            kwargs["language"] = self.options.language

        try:
            result = model.transcribe(audio_float, **kwargs)
        except TypeError:
            kwargs.pop("language", None)
            result = model.transcribe(audio_float, **kwargs)

        segments = [
            segment
            for segment in result.get("segments", [])
            if not _likely_no_speech(segment, self.options.no_speech_prob)
        ]
        text = " ".join(str(segment.get("text", "")).strip() for segment in segments).strip()
        return {
            "text": text,
            "language": result.get("language"),
            "segments": segments,
            "provider": "whisperx",
            "model": self.options.model,
            "device": self.options.device,
            "compute_type": self.options.compute_type,
        }

    def _get_model(self):
        if self._model is not None:
            return self._model

        try:
            import whisperx
        except ImportError as exc:
            raise RuntimeError(
                "WhisperX is not installed. Install voice dependencies with "
                '`pip install -e "backend[voice]"`.'
            ) from exc

        logger.info(
            "Loading WhisperX STT model "
            f"{self.options.model} on {self.options.device}/{self.options.compute_type}"
        )
        kwargs: dict[str, Any] = {
            "compute_type": self.options.compute_type,
        }
        if self.options.language:
            kwargs["language"] = self.options.language

        try:
            self._model = whisperx.load_model(self.options.model, self.options.device, **kwargs)
        except TypeError:
            kwargs.pop("language", None)
            self._model = whisperx.load_model(self.options.model, self.options.device, **kwargs)
        return self._model


def _resolve_device(device: str) -> str:
    if device != "auto":
        return device
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def _resolve_compute_type(compute_type: str, device: str) -> str:
    if compute_type != "auto":
        return compute_type
    return "float16" if _resolve_device(device) == "cuda" else "int8"


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


def _pcm16_mono_float(audio: bytes, *, fallback_sample_rate: int) -> np.ndarray:
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            raw = wav.readframes(wav.getnframes())
    except wave.Error:
        channels = 1
        sample_width = 2
        sample_rate = fallback_sample_rate
        raw = audio

    if sample_width != 2:
        raise ValueError(f"WhisperX expects 16-bit PCM audio, got {sample_width * 8}-bit")
    if sample_rate != 16000:
        logger.debug(f"WhisperX received {sample_rate} Hz audio; expected 16000 Hz.")

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples


def _likely_no_speech(segment: dict[str, Any], threshold: float | None) -> bool:
    if threshold is None:
        return False
    no_speech_prob = segment.get("no_speech_prob")
    return isinstance(no_speech_prob, (int, float)) and no_speech_prob > threshold
