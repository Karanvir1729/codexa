#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from dataclasses import asdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import websockets

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_PATH = REPO_ROOT / "backend"
if str(BACKEND_PATH) not in sys.path:
    sys.path.insert(0, str(BACKEND_PATH))

from app.config import get_settings  # noqa: E402
from app.gradium_voice import _connect_websocket  # noqa: E402
from app.gradium_voice import synthesize_gradium_tts  # noqa: E402
from app.llm import make_llm_client  # noqa: E402


@dataclass
class Check:
    name: str
    status: str
    detail: str
    latency_ms: int | None = None


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        os.environ.setdefault(key, value)


def elapsed_ms(start: float) -> int:
    return int((time.perf_counter() - start) * 1000)


def ready(name: str, detail: str, start: float | None = None) -> Check:
    return Check(name, "ready", detail, elapsed_ms(start) if start else None)


def blocked(name: str, detail: str, start: float | None = None) -> Check:
    return Check(name, "blocked", detail, elapsed_ms(start) if start else None)


def check_static_config() -> Check:
    settings = get_settings()
    missing = []
    expected = {
        "LLM_PROVIDER": ("llm_provider", "nemotron"),
        "VOICE_RUNTIME": ("voice_runtime", "local_pipecat"),
        "VOICE_SPEECH_PATH": ("voice_speech_path", "nvidia_gradium"),
        "LOCAL_STT_PROVIDER": ("local_stt_provider", "nvidia_ws"),
        "LOCAL_TTS_PROVIDER": ("local_tts_provider", "gradium"),
    }
    for env_name, (field, expected_value) in expected.items():
        if getattr(settings, field) != expected_value:
            missing.append(f"{env_name}={expected_value}")
    if not settings.nvidia_asr_url:
        missing.append("NVIDIA_ASR_URL")
    if not settings.nemotron_llm_url:
        missing.append("NEMOTRON_LLM_URL")
    if not settings.nemotron_llm_model:
        missing.append("NEMOTRON_LLM_MODEL")
    if not settings.gradium_api_key:
        missing.append("GRADIUM_API_KEY")
    if missing:
        return blocked("config", "Missing or incorrect: " + ", ".join(missing))
    return ready("config", "NVIDIA STT, Nemotron LLM, and Gradium VAD/TTS are selected.")


async def check_nemotron() -> Check:
    settings = get_settings()
    start = time.perf_counter()
    try:
        client = make_llm_client(settings)
        result = await client.generate(
            [{"role": "user", "content": "Reply with exactly: ready"}],
            "Return the requested word only.",
        )
        if not result.text.strip():
            return blocked("nemotron_llm", "Nemotron returned empty content.", start)
        return ready(
            "nemotron_llm",
            f"{result.provider}/{result.model} returned {result.text.strip()[:40]!r}.",
            start,
        )
    except Exception as exc:
        return blocked("nemotron_llm", f"{type(exc).__name__}: {exc}", start)


async def check_nvidia_asr() -> Check:
    settings = get_settings()
    start = time.perf_counter()
    try:
        async with websockets.connect(
            settings.nvidia_asr_url,
            ping_interval=settings.nvidia_asr_ws_ping_interval,
            ping_timeout=settings.nvidia_asr_ws_ping_timeout,
            open_timeout=5,
        ) as websocket:
            raw = await asyncio.wait_for(websocket.recv(), timeout=5)
        try:
            message: Any = json.loads(raw)
        except json.JSONDecodeError:
            message = raw
        if isinstance(message, dict) and message.get("type") == "ready":
            return ready("nvidia_asr", "WebSocket accepted connection and sent ready.", start)
        return blocked("nvidia_asr", f"Unexpected first message: {message!r}", start)
    except Exception as exc:
        return blocked("nvidia_asr", f"{type(exc).__name__}: {exc}", start)


async def check_gradium_vad() -> Check:
    settings = get_settings()
    start = time.perf_counter()
    if not settings.gradium_api_key:
        return blocked("gradium_vad", "GRADIUM_API_KEY is not set.", start)
    setup = {
        "type": "setup",
        "model_name": settings.gradium_vad_model,
        "input_format": settings.gradium_vad_input_format,
        "json_config": {
            "language": settings.gradium_vad_language,
            "delay_in_frames": settings.gradium_vad_delay_in_frames,
        },
    }
    try:
        websocket = await _connect_websocket(
            settings.gradium_vad_ws_url,
            {"x-api-key": settings.gradium_api_key},
            ping_interval=20,
            ping_timeout=20,
            open_timeout=5,
        )
        try:
            await websocket.send(json.dumps(setup))
            ready_message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=5))
        finally:
            await websocket.close()
        if ready_message.get("type") == "ready":
            return ready("gradium_vad", "Gradium ASR/VAD WebSocket setup returned ready.", start)
        return blocked("gradium_vad", f"Unexpected setup response: {ready_message!r}", start)
    except Exception as exc:
        return blocked("gradium_vad", f"{type(exc).__name__}: {exc}", start)


async def check_gradium_tts() -> Check:
    settings = get_settings()
    start = time.perf_counter()
    try:
        audio, metadata = await synthesize_gradium_tts(settings, "Readiness check.", output_format="wav")
        if len(audio) <= 44:
            return blocked("gradium_tts", f"Generated too little audio ({len(audio)} bytes).", start)
        return ready(
            "gradium_tts",
            f"Generated {len(audio)} bytes with voice {metadata.get('voice_id')}.",
            start,
        )
    except Exception as exc:
        return blocked("gradium_tts", f"{type(exc).__name__}: {exc}", start)


async def main() -> int:
    load_env_file(REPO_ROOT / ".env")
    load_env_file(REPO_ROOT / ".env.local")
    get_settings.cache_clear()

    checks = [check_static_config()]
    checks.extend(await asyncio.gather(check_nemotron(), check_nvidia_asr(), check_gradium_vad(), check_gradium_tts()))
    payload = {"checks": [asdict(check) for check in checks]}
    payload["ready"] = all(check.status == "ready" for check in checks)
    print(json.dumps(payload, indent=2))
    return 0 if payload["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
