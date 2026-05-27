from __future__ import annotations

import os
import re
import time
from collections import Counter
from typing import Any

import numpy as np
from fastapi import FastAPI, Query, Request
from faster_whisper import WhisperModel


MODEL_NAME = os.environ.get("REMOTE_WHISPER_MODEL", "base")
DEVICE = os.environ.get("REMOTE_WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("REMOTE_WHISPER_COMPUTE_TYPE", "int8_float16")
CPU_THREADS = int(os.environ.get("REMOTE_WHISPER_CPU_THREADS", "4"))
NUM_WORKERS = int(os.environ.get("REMOTE_WHISPER_NUM_WORKERS", "1"))
BEAM_SIZE = int(os.environ.get("REMOTE_WHISPER_BEAM_SIZE", "3"))
BEST_OF = int(os.environ.get("REMOTE_WHISPER_BEST_OF", "3"))
PATIENCE = float(os.environ.get("REMOTE_WHISPER_PATIENCE", "1.0"))
REPETITION_PENALTY = float(os.environ.get("REMOTE_WHISPER_REPETITION_PENALTY", "1.05"))
NO_REPEAT_NGRAM_SIZE = int(os.environ.get("REMOTE_WHISPER_NO_REPEAT_NGRAM_SIZE", "3"))
CONDITION_ON_PREVIOUS_TEXT = os.environ.get(
    "REMOTE_WHISPER_CONDITION_ON_PREVIOUS_TEXT", "false"
).lower() in {"1", "true", "yes", "on"}
MULTILINGUAL = os.environ.get("REMOTE_WHISPER_MULTILINGUAL", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}
VAD_FILTER = os.environ.get("REMOTE_WHISPER_VAD_FILTER", "false").lower() in {
    "1",
    "true",
    "yes",
    "on",
}
LANGUAGE_DETECTION_THRESHOLD = float(
    os.environ.get("REMOTE_WHISPER_LANGUAGE_DETECTION_THRESHOLD", "0.35")
)
LANGUAGE_DETECTION_SEGMENTS = int(os.environ.get("REMOTE_WHISPER_LANGUAGE_DETECTION_SEGMENTS", "2"))
MIN_RMS = float(os.environ.get("REMOTE_WHISPER_MIN_RMS", "0.003"))
MIN_DURATION_S = float(os.environ.get("REMOTE_WHISPER_MIN_DURATION_S", "0.10"))
MIN_LANGUAGE_PROB = float(os.environ.get("REMOTE_WHISPER_MIN_LANGUAGE_PROB", "0.18"))
MIN_AVG_LOGPROB = float(os.environ.get("REMOTE_WHISPER_MIN_AVG_LOGPROB", "-1.1"))
MAX_COMPRESSION_RATIO = float(os.environ.get("REMOTE_WHISPER_MAX_COMPRESSION_RATIO", "2.6"))
HALLUCINATION_MAX_DURATION_S = float(
    os.environ.get("REMOTE_WHISPER_HALLUCINATION_MAX_DURATION_S", "1.6")
)
HALLUCINATION_MAX_RMS = float(os.environ.get("REMOTE_WHISPER_HALLUCINATION_MAX_RMS", "0.018"))
ADAPTIVE_NOISE_FLOOR = os.environ.get("REMOTE_WHISPER_ADAPTIVE_NOISE_FLOOR", "true").lower() in {
    "1",
    "true",
    "yes",
    "on",
}
NOISE_FLOOR_ALPHA = float(os.environ.get("REMOTE_WHISPER_NOISE_FLOOR_ALPHA", "0.08"))
NOISE_FLOOR_MULTIPLIER = float(os.environ.get("REMOTE_WHISPER_NOISE_FLOOR_MULTIPLIER", "1.8"))
MAX_ADAPTIVE_MIN_RMS = float(os.environ.get("REMOTE_WHISPER_MAX_ADAPTIVE_MIN_RMS", "0.03"))
DEFAULT_INITIAL_PROMPT = ""
DEFAULT_HOTWORDS = ""
INITIAL_PROMPT = os.environ.get("REMOTE_WHISPER_INITIAL_PROMPT", DEFAULT_INITIAL_PROMPT).strip() or None
HOTWORDS = os.environ.get("REMOTE_WHISPER_HOTWORDS", DEFAULT_HOTWORDS).strip() or None

TOKEN_RE = re.compile(r"[\w\u0900-\u097f]+", re.UNICODE)
PROMPT_LEAK_PHRASES = {
    "transcribe english hindi urdu",
    "transcribe english hindi urdu hinglish",
    "preserve technical terms",
    "pipecat pipecad piecad",
    "pipecat pipecad pipe cad",
}
COMMON_HALLUCINATIONS = {
    "thank you",
    "thanks",
    "thanks for watching",
    "you",
    "bye",
}

app = FastAPI()
model: WhisperModel | None = None
noise_rms_floor: float | None = None


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
        "filters": {
            "min_rms": MIN_RMS,
            "min_duration_s": MIN_DURATION_S,
            "min_language_prob": MIN_LANGUAGE_PROB,
            "min_avg_logprob": MIN_AVG_LOGPROB,
            "max_compression_ratio": MAX_COMPRESSION_RATIO,
        },
        "decode": {
            "beam_size": BEAM_SIZE,
            "best_of": BEST_OF,
            "patience": PATIENCE,
            "repetition_penalty": REPETITION_PENALTY,
            "no_repeat_ngram_size": NO_REPEAT_NGRAM_SIZE,
            "condition_on_previous_text": CONDITION_ON_PREVIOUS_TEXT,
            "multilingual": MULTILINGUAL,
            "vad_filter": VAD_FILTER,
            "language_detection_threshold": LANGUAGE_DETECTION_THRESHOLD,
            "language_detection_segments": LANGUAGE_DETECTION_SEGMENTS,
            "initial_prompt_enabled": bool(INITIAL_PROMPT),
            "hotwords_count": len(_tokens(HOTWORDS or "")),
        },
        "adaptive_noise": {
            "enabled": ADAPTIVE_NOISE_FLOOR,
            "noise_rms_floor": noise_rms_floor,
            "effective_min_rms": _effective_min_rms(),
        },
    }


def _normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold()).strip(" .,!?;:-_\"'")


def _tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text.casefold())


def _repetition_reason(text: str) -> str | None:
    tokens = _tokens(text)
    if len(tokens) >= 6:
        counts = Counter(tokens)
        _token, count = counts.most_common(1)[0]
        if count >= 6 or (len(tokens) >= 8 and count / len(tokens) >= 0.65 and len(counts) <= 3):
            return "repetition_loop"
        run = 1
        previous = tokens[0]
        for token in tokens[1:]:
            run = run + 1 if token == previous else 1
            previous = token
            if run >= 5:
                return "repetition_loop"

    compact = re.sub(r"\s+", "", text.casefold())
    if len(compact) >= 8 and re.search(r"(.{1,4})\1{4,}", compact):
        return "repetition_loop"
    return None


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _effective_min_rms() -> float:
    if not ADAPTIVE_NOISE_FLOOR or noise_rms_floor is None:
        return MIN_RMS
    return max(MIN_RMS, min(MAX_ADAPTIVE_MIN_RMS, noise_rms_floor * NOISE_FLOOR_MULTIPLIER))


def _update_noise_floor(audio_rms: float) -> None:
    global noise_rms_floor
    if not ADAPTIVE_NOISE_FLOOR or audio_rms <= 0:
        return
    if noise_rms_floor is None:
        noise_rms_floor = audio_rms
        return
    noise_rms_floor = (NOISE_FLOOR_ALPHA * audio_rms) + ((1 - NOISE_FLOOR_ALPHA) * noise_rms_floor)


def _join_hints(*values: str | None) -> str | None:
    seen: set[str] = set()
    hints: list[str] = []
    for value in values:
        if not value:
            continue
        for part in re.split(r"[,;\n]", value):
            hint = part.strip()
            key = hint.casefold()
            if hint and key not in seen:
                hints.append(hint)
                seen.add(key)
    return ", ".join(hints) if hints else None


def _filter_reason(
    *,
    text: str,
    audio_duration_s: float,
    audio_rms: float,
    effective_min_rms: float,
    language_probability: float | None,
    segments: list[dict[str, Any]],
) -> str | None:
    normalized = _normalize_text(text)
    if not normalized:
        return "empty"
    if audio_duration_s < MIN_DURATION_S or audio_rms < effective_min_rms:
        return "silence"

    if (
        normalized in COMMON_HALLUCINATIONS
        and audio_duration_s <= HALLUCINATION_MAX_DURATION_S
        and (audio_duration_s <= 0.75 or audio_rms <= HALLUCINATION_MAX_RMS)
    ):
        return "common_hallucination"
    if normalized.count("thank you") >= 2:
        return "common_hallucination"
    token_normalized = " ".join(_tokens(text))
    if any(
        phrase in normalized or phrase in token_normalized for phrase in PROMPT_LEAK_PHRASES
    ):
        return "prompt_leak"

    if reason := _repetition_reason(text):
        return reason

    if (
        language_probability is not None
        and language_probability < MIN_LANGUAGE_PROB
        and audio_duration_s <= 1.0
    ):
        return "low_language_probability"

    avg_logprobs = [
        float(segment["avg_logprob"])
        for segment in segments
        if isinstance(segment.get("avg_logprob"), int | float)
    ]
    avg_logprob = _mean(avg_logprobs)
    if avg_logprob is not None and avg_logprob < MIN_AVG_LOGPROB and audio_duration_s <= 1.4:
        return "low_logprob"

    compression_ratios = [
        float(segment["compression_ratio"])
        for segment in segments
        if isinstance(segment.get("compression_ratio"), int | float)
    ]
    if compression_ratios and max(compression_ratios) > MAX_COMPRESSION_RATIO:
        return "high_compression_ratio"

    return None


@app.post("/transcribe")
async def transcribe(
    request: Request,
    sample_rate: int = Query(16000, ge=8000),
    model: str = Query(MODEL_NAME),
    language: str | None = None,
    no_speech_prob: float | None = Query(0.35, ge=0, le=1),
    beam_size: int | None = Query(None, ge=1, le=8),
    best_of: int | None = Query(None, ge=1, le=8),
    initial_prompt: str | None = None,
    hotwords: str | None = None,
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
    audio_rms = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
    effective_min_rms = _effective_min_rms()
    if audio_duration_s < MIN_DURATION_S or audio_rms < effective_min_rms:
        _update_noise_floor(audio_rms)
        return {
            "text": "",
            "language": language,
            "language_probability": None,
            "duration": audio_duration_s,
            "audio_duration_ms": int(audio_duration_s * 1000),
            "elapsed_ms": 0,
            "realtime_factor": 0,
            "segments": [],
            "provider": "remote_whisper",
            "model": MODEL_NAME,
            "device": DEVICE,
            "compute_type": COMPUTE_TYPE,
            "audio_rms": audio_rms,
            "effective_min_rms": effective_min_rms,
            "noise_rms_floor": noise_rms_floor,
            "filtered_reason": "silence",
        }

    started = time.perf_counter()
    segments_iter, info = globals()["model"].transcribe(
        audio,
        language=language or None,
        beam_size=beam_size or BEAM_SIZE,
        best_of=best_of or BEST_OF,
        patience=PATIENCE,
        repetition_penalty=REPETITION_PENALTY,
        no_repeat_ngram_size=NO_REPEAT_NGRAM_SIZE,
        temperature=0.0,
        condition_on_previous_text=CONDITION_ON_PREVIOUS_TEXT,
        vad_filter=VAD_FILTER,
        multilingual=MULTILINGUAL,
        language_detection_threshold=LANGUAGE_DETECTION_THRESHOLD,
        language_detection_segments=LANGUAGE_DETECTION_SEGMENTS,
        initial_prompt=(initial_prompt or INITIAL_PROMPT),
        hotwords=_join_hints(HOTWORDS, hotwords),
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
            "compression_ratio": getattr(segment, "compression_ratio", None),
        }
        segments.append(item)
        if no_speech_prob is None or segment.no_speech_prob < no_speech_prob:
            accepted_text.append(segment.text.strip())

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    text = " ".join(part for part in accepted_text if part).strip()
    language_probability = getattr(info, "language_probability", None)
    filtered_reason = _filter_reason(
        text=text,
        audio_duration_s=audio_duration_s,
        audio_rms=audio_rms,
        effective_min_rms=effective_min_rms,
        language_probability=language_probability,
        segments=segments,
    )
    if filtered_reason in {"common_hallucination", "low_language_probability", "low_logprob"} and (
        audio_rms <= max(HALLUCINATION_MAX_RMS, effective_min_rms * 1.5)
    ):
        _update_noise_floor(audio_rms)
    return {
        "text": "" if filtered_reason else text,
        "language": getattr(info, "language", language),
        "language_probability": language_probability,
        "duration": getattr(info, "duration", audio_duration_s),
        "audio_duration_ms": int(audio_duration_s * 1000),
        "elapsed_ms": elapsed_ms,
        "realtime_factor": round(elapsed_ms / max(1, int(audio_duration_s * 1000)), 4),
        "segments": segments,
        "provider": "remote_whisper",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "audio_rms": audio_rms,
        "effective_min_rms": effective_min_rms,
        "noise_rms_floor": noise_rms_floor,
        "filtered_reason": filtered_reason,
    }
