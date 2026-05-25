#!/usr/bin/env python3
from __future__ import annotations

import asyncio

from app.config import get_settings
from app.local_voice_runtime import create_local_tts_service, resolve_stt_language


async def main() -> None:
    from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame, TranscriptionFrame
    from pipecat.services.whisper.stt import WhisperSTTServiceMLX

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

    print(f"Prewarming MLX Whisper model {settings.local_stt_model}...")
    stt = WhisperSTTServiceMLX(
        settings=WhisperSTTServiceMLX.Settings(
            model=settings.local_stt_model,
            language=resolve_stt_language(settings),
            no_speech_prob=settings.local_stt_no_speech_prob,
            temperature=settings.local_stt_temperature,
        ),
        sample_rate=settings.local_audio_input_sample_rate,
        ttfs_p99_latency=settings.local_stt_ttfs_p99_latency,
    )
    silence = b"\0" * settings.local_audio_input_sample_rate * 2
    transcriptions = 0
    async for frame in stt.run_stt(silence):
        if isinstance(frame, TranscriptionFrame):
            transcriptions += 1
        elif isinstance(frame, ErrorFrame):
            raise RuntimeError(frame.error)
    print(f"MLX Whisper ready ({transcriptions} silence transcriptions ignored).")


if __name__ == "__main__":
    asyncio.run(main())
