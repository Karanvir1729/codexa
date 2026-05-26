from __future__ import annotations

import os
import time
from typing import Any

import numpy as np
from fastapi import FastAPI, Query, Request
from faster_whisper import WhisperModel


MODEL_NAME = os.environ.get("REMOTE_WHISPER_MODEL", "base")
DEVICE = os.environ.get("REMOTE_WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("REMOTE_WHISPER_COMPUTE_TYPE", "int8_float16")
CPU_THREADS = int(os.environ.get("REMOTE_WHISPER_CPU_THREADS", "4"))
NUM_WORKERS = int(os.environ.get("REMOTE_WHISPER_NUM_WORKERS", "1"))

app = FastAPI()
model: WhisperModel | None = None


@app.on_event("startup")
def startup() -> None:
    global model
    model = WhisperModel(
        MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        cpu_threads=CPU_THREADS,
        num_workers=NUM_WORKERS,
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }


@app.post("/transcribe")
async def transcribe(
    request: Request,
    sample_rate: int = Query(16000, ge=8000),
    model: str = Query(MODEL_NAME),
    language: str | None = None,
    no_speech_prob: float | None = Query(0.35, ge=0, le=1),
) -> dict[str, Any]:
    if model != MODEL_NAME:
        return {
            "text": "",
            "language": language,
            "segments": [],
            "error": f"Worker is loaded with {MODEL_NAME}, not {model}.",
        }
    if globals()["model"] is None:
        return {"text": "", "language": language, "segments": [], "error": "model_not_loaded"}

    raw = await request.body()
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    audio_duration_s = len(audio) / sample_rate if sample_rate else 0
    started = time.perf_counter()
    segments_iter, info = globals()["model"].transcribe(
        audio,
        language=language or None,
        beam_size=1,
        best_of=1,
        temperature=0.0,
        condition_on_previous_text=False,
        vad_filter=False,
    )
    segments = []
    accepted_text = []
    for segment in segments_iter:
        item = {
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
            "avg_logprob": segment.avg_logprob,
            "no_speech_prob": segment.no_speech_prob,
        }
        segments.append(item)
        if no_speech_prob is None or segment.no_speech_prob < no_speech_prob:
            accepted_text.append(segment.text.strip())

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return {
        "text": " ".join(part for part in accepted_text if part).strip(),
        "language": getattr(info, "language", language),
        "language_probability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", audio_duration_s),
        "audio_duration_ms": int(audio_duration_s * 1000),
        "elapsed_ms": elapsed_ms,
        "realtime_factor": round(elapsed_ms / max(1, int(audio_duration_s * 1000)), 4),
        "segments": segments,
        "provider": "remote_whisper",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }
