from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator

import websockets
from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import (
    AudioRawFrame,
    CancelFrame,
    EndFrame,
    ErrorFrame,
    Frame,
    InterimTranscriptionFrame,
    StartFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import WebsocketSTTService
from pipecat.utils.time import time_now_iso8601


def _strip_committed_prefix(interim_text: str, committed_count: int) -> str | None:
    interim_tokens = interim_text.split()
    if len(interim_tokens) < committed_count:
        return None
    return " ".join(interim_tokens[committed_count:])


class NvidiaWebSocketSTTService(WebsocketSTTService):
    """Pipecat STT service for the unauthenticated NVIDIA Parakeet WebSocket."""

    def __init__(
        self,
        *,
        url: str,
        sample_rate: int = 16000,
        strip_interim_prefix: bool = False,
        preroll_seconds: float = 1.0,
        ws_ping_interval: float = 20.0,
        ws_ping_timeout: float = 20.0,
        **kwargs,
    ) -> None:
        super().__init__(
            sample_rate=sample_rate,
            settings=STTSettings(model=None, language=None),
            **kwargs,
        )
        self._url = url
        self._strip_interim_prefix = strip_interim_prefix
        self._preroll_seconds = preroll_seconds
        self._resampler = create_stream_resampler()
        self._ws_ping_interval = ws_ping_interval
        self._ws_ping_timeout = ws_ping_timeout
        self._websocket = None
        self._receive_task: asyncio.Task | None = None
        self._ready = False
        self._committed_token_count = 0
        self._user_speaking = False
        self._audio_ring = bytearray()
        self._preroll_bytes = 0
        self._audio_send_lock = asyncio.Lock()
        self._audio_bytes_sent = 0
        self._waiting_for_final = False

    def can_generate_metrics(self) -> bool:
        return True

    @property
    def supports_ttfs(self) -> bool:
        return False

    async def start(self, frame: StartFrame):
        await super().start(frame)
        self._preroll_bytes = int(self.sample_rate * self._preroll_seconds) * 2
        await self._connect()

    async def stop(self, frame: EndFrame):
        self._audio_ring.clear()
        await self._send_reset(finalize=True)
        await super().stop(frame)
        await self._disconnect()

    async def cancel(self, frame: CancelFrame):
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None

        self._audio_ring.clear()
        await self._send_reset(finalize=True)
        if self._websocket and self._ready:
            try:
                msg = await asyncio.wait_for(self._websocket.recv(), timeout=0.5)
                data = json.loads(msg)
                if data.get("type") == "transcript" and data.get("is_final"):
                    await self._handle_transcript(data)
            except Exception:
                pass
        await super().cancel(frame)
        await self._disconnect()

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        if self._websocket and self._ready:
            try:
                async with self._audio_send_lock:
                    await self._websocket.send(audio)
                    self._audio_bytes_sent += len(audio)
            except Exception as exc:
                logger.error(f"{self} failed to send audio: {exc}")
                await self._report_error(ErrorFrame(f"Failed to send audio: {exc}"))
        yield None

    async def process_audio_frame(self, frame: AudioRawFrame, direction: FrameDirection):
        if self._reconnecting:
            self._reconnect_audio_buffer.append((frame, direction))
            return
        if self._muted:
            return

        self._user_id = getattr(frame, "user_id", "")
        self._last_audio_time = time.monotonic()
        if not frame.audio:
            logger.warning(f"Empty audio frame received for STT service: {self.name}")
            return

        audio = await self._resampler.resample(frame.audio, frame.sample_rate, self.sample_rate)
        if self._user_speaking:
            await self.process_generator(self.run_stt(audio))
            return

        self._audio_ring += audio
        if self._preroll_bytes > 0 and len(self._audio_ring) > self._preroll_bytes:
            del self._audio_ring[: -self._preroll_bytes]

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, UserStartedSpeakingFrame):
            self._waiting_for_final = False
            await super().process_frame(frame, direction)
            return

        if isinstance(frame, VADUserStartedSpeakingFrame):
            if self._audio_ring:
                await self.process_generator(self.run_stt(bytes(self._audio_ring)))
            self._audio_ring.clear()
            self._user_speaking = True
            await super().process_frame(frame, direction)
            return

        if isinstance(frame, VADUserStoppedSpeakingFrame):
            audio_was_streamed = self._audio_bytes_sent > 0
            self._user_speaking = False
            if not audio_was_streamed:
                self._audio_ring.clear()
                logger.debug(f"{self} ignoring unmatched VAD stop; no audio streamed")
                await self.push_frame(frame, direction)
                return

            await super().process_frame(frame, direction)
            self._waiting_for_final = True
            await self.start_ttfb_metrics()
            await self._send_reset(finalize=True)
            return

        await super().process_frame(frame, direction)

    async def _send_reset(self, finalize: bool = True):
        if self._websocket and self._ready:
            try:
                async with self._audio_send_lock:
                    await self._websocket.send(json.dumps({"type": "reset", "finalize": finalize}))
                    samples = self._audio_bytes_sent // 2
                    duration_ms = (samples * 1000) // self.sample_rate
                    reset_type = "hard" if finalize else "soft"
                    logger.debug(f"{self} sent {reset_type} reset (audio: {duration_ms}ms)")
                    if finalize:
                        self._audio_bytes_sent = 0
            except Exception as exc:
                logger.error(f"{self} failed to send reset: {exc}")

    async def _connect(self):
        logger.debug(f"{self} connecting to {self._url}")
        await self._connect_websocket()
        self._receive_task = asyncio.create_task(self._receive_task_handler(self._report_error))
        await self._call_event_handler("on_connected", self)

    async def _disconnect(self):
        logger.debug(f"{self} disconnecting")
        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
            self._receive_task = None
        await self._disconnect_websocket()
        await self._call_event_handler("on_disconnected", self)

    async def _connect_websocket(self):
        try:
            self._websocket = await websockets.connect(
                self._url,
                ping_interval=self._ws_ping_interval,
                ping_timeout=self._ws_ping_timeout,
            )
            self._ready = False
            try:
                ready_msg = await asyncio.wait_for(self._websocket.recv(), timeout=5.0)
                data = json.loads(ready_msg)
                if data.get("type") == "ready":
                    self._ready = True
                    logger.info(f"{self} connected and ready")
                else:
                    logger.warning(f"{self} unexpected initial message: {data}")
                    self._ready = True
            except TimeoutError:
                logger.warning(f"{self} timeout waiting for ready message, proceeding anyway")
                self._ready = True

            self._committed_token_count = 0
            self._user_speaking = False
            self._audio_ring.clear()
            self._audio_bytes_sent = 0
        except Exception as exc:
            logger.error(f"{self} connection failed: {exc}")
            await self._report_error(ErrorFrame(f"Connection failed: {exc}"))
            raise

    async def _disconnect_websocket(self):
        self._ready = False
        self._committed_token_count = 0
        self._user_speaking = False
        self._audio_ring.clear()
        self._audio_bytes_sent = 0
        if self._websocket:
            try:
                await self._websocket.close()
            except Exception as exc:
                logger.debug(f"{self} error closing websocket: {exc}")
            finally:
                self._websocket = None

    async def _receive_messages(self):
        if not self._websocket:
            return
        async for message in self._websocket:
            try:
                data = json.loads(message)
                msg_type = data.get("type")
                if msg_type == "transcript":
                    await self._handle_transcript(data)
                elif msg_type == "error":
                    error_msg = data.get("message", "Unknown error")
                    logger.error(f"{self} server error: {error_msg}")
                    await self._report_error(ErrorFrame(f"Server error: {error_msg}"))
                elif msg_type == "ready":
                    self._ready = True
                    logger.debug(f"{self} server ready")
                else:
                    logger.debug(f"{self} unknown message type: {msg_type}")
            except json.JSONDecodeError as exc:
                logger.error(f"{self} invalid JSON: {exc}")
            except Exception as exc:
                logger.error(f"{self} error processing message: {exc}")

    async def _handle_transcript(self, data: dict):
        text = data.get("text", "")
        is_final = data.get("is_final", False)
        is_hard_reset = data.get("finalize", True)
        if not text:
            if is_final and is_hard_reset:
                self._waiting_for_final = False
            return

        timestamp = time_now_iso8601()
        if is_final:
            reset_type = "hard" if is_hard_reset else "soft"
            logger.debug(f"{self} {reset_type} final at {time.time():.3f}: {text[-50:]}")
            if is_hard_reset:
                await self.push_frame(
                    TranscriptionFrame(
                        text,
                        self._user_id,
                        timestamp,
                        language=None,
                        finalized=True,
                    )
                )
                self._waiting_for_final = False
                self._committed_token_count += len(text.split())
            return

        if not self._strip_interim_prefix:
            await self.push_frame(
                InterimTranscriptionFrame(text, self._user_id, timestamp, language=None)
            )
            return

        stripped = _strip_committed_prefix(text, self._committed_token_count)
        if stripped is None:
            logger.debug(
                f"{self} interim shorter than committed prefix; emitting unchanged"
            )
            stripped = text
        elif stripped == "":
            return
        await self.push_frame(
            InterimTranscriptionFrame(stripped, self._user_id, timestamp, language=None)
        )
