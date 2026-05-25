#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import io
import wave

from app.config import get_settings
from app.local_voice_runtime import create_local_stt_service, create_local_tts_service


async def main() -> None:
    from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame, TranscriptionFrame

    settings = get_settings()

    print(f"Prewarming local TTS provider {settings.local_tts_provider}...")
    tts_provider, tts = await create_local_tts_service(settings)
    # run_tts normally gets the sample rate from Pipecat's StartFrame. This
    # standalone prewarm path calls the service directly to avoid opening audio.
    tts._sample_rate = settings.local_audio_output_sample_rate
    audio_frames = 0
    async for frame in tts.run_tts("Ready.", "prewarm"):
        if isinstance(frame, TTSAudioRawFrame):
            audio_frames += 1
        elif isinstance(frame, ErrorFrame):
            raise RuntimeError(frame.error)
    print(f"{tts_provider} ready ({audio_frames} audio frames generated).")

    stt_provider, stt = create_local_stt_service(settings)
    print(f"Prewarming {stt_provider} STT model {settings.local_stt_model}...")
    silence = _silence_wav(settings.local_audio_input_sample_rate)
    transcriptions = 0
    async for frame in stt.run_stt(silence):
        if isinstance(frame, TranscriptionFrame):
            transcriptions += 1
        elif isinstance(frame, ErrorFrame):
            raise RuntimeError(frame.error)
    print(f"{stt_provider} ready ({transcriptions} silence transcriptions ignored).")


def _silence_wav(sample_rate: int) -> bytes:
    content = io.BytesIO()
    with wave.open(content, "wb") as wav:
        wav.setsampwidth(2)
        wav.setnchannels(1)
        wav.setframerate(sample_rate)
        wav.writeframes(b"\0" * sample_rate * 2)
    return content.getvalue()


if __name__ == "__main__":
    asyncio.run(main())
