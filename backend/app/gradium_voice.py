from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import AsyncGenerator
from typing import Any

import websockets
from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import (
    AudioRawFrame,
    CancelFrame,
    EndFrame,
    ErrorFrame,
    Frame,
    StartFrame,
    TTSAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSService, TextAggregationMode
from pipecat.utils.tracing.service_decorators import traced_tts

from .config import Settings


async def _connect_websocket(url: str, headers: dict[str, str], **kwargs):
    try:
        return await websockets.connect(url, additional_headers=headers, **kwargs)
    except TypeError:
        return await websockets.connect(url, extra_headers=headers, **kwargs)


def _pcm_output_sample_rate(output_format: str) -> int:
    if output_format == "pcm":
        return 48000
    if output_format.startswith("pcm_"):
        try:
            return int(output_format.split("_", 1)[1])
        except ValueError:
            return 24000
    return 24000


class GradiumSemanticVADProcessor(FrameProcessor):
    """Semantic VAD driven by Gradium STT `step` messages.

    This processor uses Gradium only for turn-taking signals. Audio still flows
    downstream to NVIDIA ASR for transcription.
    """

    def __init__(
        self,
        *,
        api_key: str,
        ws_url: str,
        model_name: str,
        input_format: str,
        language: str,
        delay_in_frames: int,
        sample_rate: int,
        start_inactivity_threshold: float,
        stop_inactivity_threshold: float,
        start_consecutive_steps: int,
        stop_consecutive_steps: int,
    ) -> None:
        super().__init__()
        self._api_key = api_key
        self._ws_url = ws_url
        self._model_name = model_name
        self._input_format = input_format
        self._language = language
        self._delay_in_frames = delay_in_frames
        self._sample_rate = sample_rate
        self._start_threshold = start_inactivity_threshold
        self._stop_threshold = stop_inactivity_threshold
        self._start_steps_required = start_consecutive_steps
        self._stop_steps_required = stop_consecutive_steps
        self._resampler = create_stream_resampler()
        self._websocket = None
        self._receive_task: asyncio.Task | None = None
        self._send_lock = asyncio.Lock()
        self._ready = False
        self._speaking = False
        self._start_steps = 0
        self._stop_steps = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            await self._connect()
            await self.push_frame(frame, direction)
        elif isinstance(frame, AudioRawFrame):
            await self._send_audio(frame)
            await self.push_frame(frame, direction)
        elif isinstance(frame, EndFrame):
            await self._send_end_of_stream()
            await self._disconnect()
            await self.push_frame(frame, direction)
        elif isinstance(frame, CancelFrame):
            await self._disconnect()
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    async def _connect(self) -> None:
        if self._websocket:
            return
        setup = {
            "type": "setup",
            "model_name": self._model_name,
            "input_format": self._input_format,
            "json_config": {
                "language": self._language,
                "delay_in_frames": self._delay_in_frames,
            },
        }
        self._websocket = await _connect_websocket(
            self._ws_url,
            {"x-api-key": self._api_key},
            ping_interval=20,
            ping_timeout=20,
        )
        await self._websocket.send(json.dumps(setup))
        ready = json.loads(await asyncio.wait_for(self._websocket.recv(), timeout=5.0))
        if ready.get("type") != "ready":
            raise RuntimeError(f"Gradium VAD expected ready message, got {ready}")
        self._ready = True
        self._receive_task = asyncio.create_task(self._receive_messages())

    async def _disconnect(self) -> None:
        self._ready = False
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None
        if self._websocket:
            try:
                await self._websocket.close()
            finally:
                self._websocket = None

    async def _send_audio(self, frame: AudioRawFrame) -> None:
        if not self._websocket or not self._ready or not frame.audio:
            return
        audio = await self._resampler.resample(frame.audio, frame.sample_rate, self._sample_rate)
        payload = {"type": "audio", "audio": base64.b64encode(audio).decode("ascii")}
        try:
            async with self._send_lock:
                await self._websocket.send(json.dumps(payload))
        except Exception as exc:
            logger.warning(f"Gradium VAD audio send failed: {exc}")

    async def _send_end_of_stream(self) -> None:
        if not self._websocket or not self._ready:
            return
        try:
            async with self._send_lock:
                await self._websocket.send(json.dumps({"type": "end_of_stream"}))
        except Exception:
            logger.debug("Gradium VAD end_of_stream failed", exc_info=True)

    async def _receive_messages(self) -> None:
        if not self._websocket:
            return
        async for raw_message in self._websocket:
            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                continue
            msg_type = message.get("type")
            if msg_type in {"step", "vad"}:
                await self._handle_vad_step(message)
            elif msg_type == "error":
                await self.push_frame(ErrorFrame(f"Gradium VAD error: {message.get('message')}"))
            elif msg_type == "end_of_stream":
                return

    async def _handle_vad_step(self, message: dict[str, Any]) -> None:
        vad = message.get("vad")
        if not isinstance(vad, list) or not vad:
            return
        horizon = vad[-1]
        if not isinstance(horizon, dict):
            return
        inactivity = horizon.get("inactivity_prob")
        if not isinstance(inactivity, (int, float)):
            return
        total_duration = float(message.get("total_duration_s") or 0.0)

        if self._speaking:
            if inactivity >= self._stop_threshold:
                self._stop_steps += 1
            else:
                self._stop_steps = 0
            if self._stop_steps >= self._stop_steps_required:
                self._speaking = False
                self._start_steps = 0
                self._stop_steps = 0
                await self.push_frame(VADUserStoppedSpeakingFrame(stop_secs=total_duration))
            return

        if inactivity <= self._start_threshold:
            self._start_steps += 1
        else:
            self._start_steps = 0
        if self._start_steps >= self._start_steps_required:
            self._speaking = True
            self._start_steps = 0
            self._stop_steps = 0
            await self.push_frame(VADUserStartedSpeakingFrame(start_secs=total_duration))


class GradiumTTSService(TTSService):
    """Pipecat TTS service for Gradium's WebSocket TTS endpoint."""

    def __init__(
        self,
        *,
        api_key: str,
        ws_url: str,
        model_name: str,
        voice_id: str,
        output_format: str,
        speed: float,
        rewrite_rules: str,
        timeout_seconds: float,
        sample_rate: int | None = None,
        text_aggregation_mode: TextAggregationMode = TextAggregationMode.SENTENCE,
        **kwargs,
    ) -> None:
        self._api_key = api_key
        self._ws_url = ws_url
        self._model_name = model_name
        self._voice_id = voice_id
        self._output_format = output_format
        self._speed = speed
        self._rewrite_rules = rewrite_rules
        self._timeout_seconds = timeout_seconds
        self._native_sample_rate = _pcm_output_sample_rate(output_format)
        self._last_payload: dict[str, Any] | None = None
        super().__init__(
            push_start_frame=True,
            push_stop_frames=True,
            sample_rate=sample_rate or self._native_sample_rate,
            settings=TTSSettings(model=model_name, voice=voice_id, language=None),
            text_aggregation_mode=text_aggregation_mode,
            **kwargs,
        )

    def set_speed(self, speed: float) -> None:
        self._speed = max(0.5, min(2.0, float(speed)))

    def set_emotion(self, _emotion: str) -> None:
        return

    def apply_runtime_profile(self, profile: dict[str, Any]) -> None:
        tts = profile.get("tts") if isinstance(profile.get("tts"), dict) else {}
        speed = tts.get("speed")
        if isinstance(speed, (int, float)) and not isinstance(speed, bool):
            self.set_speed(float(speed))

    def current_params(self) -> dict[str, Any]:
        return {
            "provider": "gradium",
            "model_name": self._model_name,
            "voice_id": self._voice_id,
            "output_format": self._output_format,
            "sample_rate": self.sample_rate or self._native_sample_rate,
            "speed": round(self._speed, 2),
            "rewrite_rules": self._rewrite_rules,
        }

    def last_payload(self) -> dict[str, Any] | None:
        return dict(self._last_payload) if self._last_payload else None

    @traced_tts
    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame, None]:
        setup: dict[str, Any] = {
            "type": "setup",
            "model_name": self._model_name,
            "voice_id": self._voice_id,
            "output_format": self._output_format,
            "json_config": {"speed": round(self._speed, 2)},
        }
        if self._rewrite_rules:
            setup["json_config"]["rewrite_rules"] = self._rewrite_rules
        self._last_payload = {
            "text": text,
            "model_name": self._model_name,
            "voice_id": self._voice_id,
            "output_format": self._output_format,
            "speed": round(self._speed, 2),
            "rewrite_rules": self._rewrite_rules,
        }
        try:
            await self.start_tts_usage_metrics(text)
            ws = await _connect_websocket(
                self._ws_url,
                {"x-api-key": self._api_key},
                ping_interval=20,
                ping_timeout=20,
                open_timeout=min(self._timeout_seconds, 10),
            )
            try:
                await ws.send(json.dumps(setup))
                ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=5.0))
                if ready.get("type") != "ready":
                    yield ErrorFrame(f"Gradium TTS expected ready message, got {ready}")
                    return
                await ws.send(json.dumps({"type": "text", "text": text}))
                await ws.send(json.dumps({"type": "end_of_stream"}))
                async for raw_message in ws:
                    message = json.loads(raw_message)
                    msg_type = message.get("type")
                    if msg_type == "audio":
                        audio_b64 = message.get("audio")
                        if not isinstance(audio_b64, str):
                            continue
                        await self.stop_ttfb_metrics()
                        yield TTSAudioRawFrame(
                            audio=base64.b64decode(audio_b64),
                            sample_rate=self.sample_rate or self._native_sample_rate,
                            num_channels=1,
                            context_id=context_id,
                        )
                    elif msg_type == "end_of_stream":
                        return
                    elif msg_type == "error":
                        yield ErrorFrame(f"Gradium TTS error: {message.get('message')}")
                        return
            finally:
                await ws.close()
        except Exception as exc:
            yield ErrorFrame(f"Gradium TTS failed: {exc}")
        finally:
            await self.stop_ttfb_metrics()


def create_gradium_vad_processor(settings: Settings) -> GradiumSemanticVADProcessor:
    if not settings.gradium_api_key:
        raise RuntimeError("GRADIUM_API_KEY is required for Gradium VAD.")
    return GradiumSemanticVADProcessor(
        api_key=settings.gradium_api_key,
        ws_url=settings.gradium_vad_ws_url,
        model_name=settings.gradium_vad_model,
        input_format=settings.gradium_vad_input_format,
        language=settings.gradium_vad_language,
        delay_in_frames=settings.gradium_vad_delay_in_frames,
        sample_rate=settings.gradium_vad_sample_rate,
        start_inactivity_threshold=settings.gradium_vad_start_inactivity_threshold,
        stop_inactivity_threshold=settings.gradium_vad_stop_inactivity_threshold,
        start_consecutive_steps=settings.gradium_vad_start_consecutive_steps,
        stop_consecutive_steps=settings.gradium_vad_stop_consecutive_steps,
    )


def create_gradium_tts_service(
    settings: Settings,
    *,
    text_aggregation_mode: TextAggregationMode | None = None,
) -> GradiumTTSService:
    if not settings.gradium_api_key:
        raise RuntimeError("GRADIUM_API_KEY is required for Gradium TTS.")
    kwargs = {}
    if text_aggregation_mode is not None:
        kwargs["text_aggregation_mode"] = text_aggregation_mode
    return GradiumTTSService(
        api_key=settings.gradium_api_key,
        ws_url=settings.gradium_tts_ws_url,
        model_name=settings.gradium_tts_model,
        voice_id=settings.gradium_tts_voice_id,
        output_format=settings.gradium_tts_output_format,
        speed=settings.gradium_tts_speed,
        rewrite_rules=settings.gradium_tts_rewrite_rules,
        timeout_seconds=settings.gradium_tts_timeout_seconds,
        sample_rate=settings.local_audio_output_sample_rate,
        **kwargs,
    )


async def synthesize_gradium_tts(
    settings: Settings,
    text: str,
    *,
    output_format: str = "wav",
) -> tuple[bytes, dict[str, Any]]:
    if not settings.gradium_api_key:
        raise RuntimeError("GRADIUM_API_KEY is required for Gradium TTS.")
    setup: dict[str, Any] = {
        "type": "setup",
        "model_name": settings.gradium_tts_model,
        "voice_id": settings.gradium_tts_voice_id,
        "output_format": output_format,
        "json_config": {"speed": round(settings.gradium_tts_speed, 2)},
    }
    if settings.gradium_tts_rewrite_rules:
        setup["json_config"]["rewrite_rules"] = settings.gradium_tts_rewrite_rules
    chunks: list[bytes] = []
    websocket = await _connect_websocket(
        settings.gradium_tts_ws_url,
        {"x-api-key": settings.gradium_api_key},
        ping_interval=20,
        ping_timeout=20,
        open_timeout=min(settings.gradium_tts_timeout_seconds, 10),
    )
    try:
        await websocket.send(json.dumps(setup))
        ready = json.loads(await asyncio.wait_for(websocket.recv(), timeout=5.0))
        if ready.get("type") != "ready":
            raise RuntimeError(f"Gradium TTS expected ready message, got {ready}")
        await websocket.send(json.dumps({"type": "text", "text": text}))
        await websocket.send(json.dumps({"type": "end_of_stream"}))
        async for raw_message in websocket:
            message = json.loads(raw_message)
            msg_type = message.get("type")
            if msg_type == "audio":
                audio_b64 = message.get("audio")
                if isinstance(audio_b64, str):
                    chunks.append(base64.b64decode(audio_b64))
            elif msg_type == "end_of_stream":
                break
            elif msg_type == "error":
                raise RuntimeError(f"Gradium TTS error: {message.get('message')}")
    finally:
        await websocket.close()
    metadata = {
        "provider": "gradium",
        "model_name": settings.gradium_tts_model,
        "voice_id": settings.gradium_tts_voice_id,
        "output_format": output_format,
        "speed": round(settings.gradium_tts_speed, 2),
        "rewrite_rules": settings.gradium_tts_rewrite_rules,
    }
    return b"".join(chunks), metadata
