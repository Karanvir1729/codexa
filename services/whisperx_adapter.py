#!/usr/bin/env python3
"""Small WhisperX HTTP adapter for the browser voice prototype.

Contract:
  POST /transcribe
  raw audio body -> {"text": "...", "segments": [...], ...}

The Node app treats this as a replaceable STT service boundary. This adapter is
intentionally minimal so it can be swapped for streaming ASR later.
"""

from __future__ import annotations

import argparse
import json
import os
import math
import subprocess
import tempfile
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MODEL: Any | None = None
MODEL_INFO: dict[str, Any] = {}
SPEAKER_MODEL: Any | None = None
SPEAKER_MODEL_INFO: dict[str, Any] = {}
USER_EMBEDDING: Any | None = None
USER_SAMPLES = 0
ASSISTANT_EMBEDDING: Any | None = None
ASSISTANT_SAMPLES = 0
SPEAKER_PROFILES: dict[str, dict[str, Any]] = {}
SPEAKER_PROFILES_LOADED = False


def _profile_store_path() -> Path:
    return Path(os.environ.get("SPEAKER_PROFILE_STORE", "data/speaker_profiles.json"))


def _profile_threshold() -> float:
    return float(os.environ.get("SPEAKER_PROFILE_THRESHOLD", os.environ.get("SPEAKER_USER_THRESHOLD", "0.58")))


def _load_profiles() -> None:
    global SPEAKER_PROFILES, SPEAKER_PROFILES_LOADED
    if SPEAKER_PROFILES_LOADED:
        return

    path = _profile_store_path()
    if path.exists():
        try:
            data = json.loads(path.read_text("utf-8"))
            profiles = data.get("profiles", {})
            if isinstance(profiles, dict):
                SPEAKER_PROFILES = profiles
        except Exception:
            SPEAKER_PROFILES = {}
    SPEAKER_PROFILES_LOADED = True


def _save_profiles() -> None:
    path = _profile_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "profiles": SPEAKER_PROFILES,
            },
            indent=2,
        ),
        "utf-8",
    )


def _profile_embedding(profile: dict[str, Any]) -> Any | None:
    embedding = profile.get("embedding")
    if not isinstance(embedding, list) or not embedding:
        return None
    import numpy as np  # type: ignore

    vector = np.array(embedding, dtype="float32")
    norm = np.linalg.norm(vector)
    if not math.isfinite(float(norm)) or norm <= 0:
        return None
    return vector / norm


def _request_profile_id(handler: BaseHTTPRequestHandler) -> str:
    raw = handler.headers.get("x-user-id") or "user_a"
    safe = "".join(ch if ch.isalnum() or ch in {"_", "-"} else "_" for ch in raw.strip().lower())
    return safe or "user_a"


def _request_profile_name(handler: BaseHTTPRequestHandler, profile_id: str) -> str:
    return (handler.headers.get("x-user-name") or profile_id.replace("_", " ").title()).strip()


def _enroll_persistent_profile(handler: BaseHTTPRequestHandler, embedding: Any) -> dict[str, Any]:
    _load_profiles()
    profile_id = _request_profile_id(handler)
    profile_name = _request_profile_name(handler, profile_id)
    current = SPEAKER_PROFILES.get(profile_id, {})
    samples = int(current.get("samples", 0) or 0)
    existing = _profile_embedding(current)
    merged, next_samples = _merge_embedding(existing, samples, embedding)

    profile = {
        "id": profile_id,
        "name": profile_name,
        "samples": next_samples,
        "embedding": merged.tolist(),
        "updated_at": time.time(),
        "model": SPEAKER_MODEL_INFO.get("model") or os.environ.get("SPEAKER_MODEL", "speechbrain/spkrec-ecapa-voxceleb"),
    }
    SPEAKER_PROFILES[profile_id] = profile
    _save_profiles()
    return {key: profile[key] for key in ["id", "name", "samples", "updated_at", "model"]}


def _match_persistent_profile(candidate: Any) -> dict[str, Any] | None:
    _load_profiles()
    best: dict[str, Any] | None = None
    for profile in SPEAKER_PROFILES.values():
        profile_vector = _profile_embedding(profile)
        score = _cosine(profile_vector, candidate)
        if score is None:
            continue
        if best is None or score > best["similarity"]:
            best = {
                "id": profile.get("id"),
                "name": profile.get("name"),
                "similarity": score,
                "samples": profile.get("samples", 0),
                "model": profile.get("model"),
            }
    return best


def _json(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _load_model() -> Any:
    global MODEL, MODEL_INFO
    if MODEL is not None:
        return MODEL

    import whisperx  # type: ignore

    model_name = os.environ.get("WHISPERX_MODEL", "base")
    device = os.environ.get("WHISPERX_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPERX_COMPUTE_TYPE", "int8" if device == "cpu" else "float16")
    language = os.environ.get("WHISPERX_LANGUAGE", "en")

    started_at = time.perf_counter()
    MODEL = whisperx.load_model(model_name, device=device, compute_type=compute_type, language=language)
    MODEL_INFO = {
        "model": model_name,
        "device": device,
        "compute_type": compute_type,
        "language": language,
        "load_ms": round((time.perf_counter() - started_at) * 1000),
    }
    return MODEL


def _load_speaker_model() -> Any:
    global SPEAKER_MODEL, SPEAKER_MODEL_INFO
    if SPEAKER_MODEL is not None:
        return SPEAKER_MODEL

    from speechbrain.inference.speaker import EncoderClassifier  # type: ignore

    source = os.environ.get("SPEAKER_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
    savedir = os.environ.get("SPEAKER_MODEL_DIR", "pretrained_models/spkrec-ecapa-voxceleb")
    device = os.environ.get("SPEAKER_DEVICE", os.environ.get("WHISPERX_DEVICE", "cpu"))

    started_at = time.perf_counter()
    SPEAKER_MODEL = EncoderClassifier.from_hparams(source=source, savedir=savedir, run_opts={"device": device})
    SPEAKER_MODEL_INFO = {
        "model": source,
        "device": device,
        "load_ms": round((time.perf_counter() - started_at) * 1000),
    }
    return SPEAKER_MODEL


def _extension_for(content_type: str, audio_format: str) -> str:
    lowered = f"{content_type} {audio_format}".lower()
    if "wav" in lowered:
        return ".wav"
    if "mpeg" in lowered or "mp3" in lowered:
        return ".mp3"
    if "ogg" in lowered:
        return ".ogg"
    return ".webm"


def _write_temp_audio(handler: BaseHTTPRequestHandler) -> tuple[Path, str]:
    length = int(handler.headers.get("content-length", "0") or "0")
    if length <= 0:
        raise ValueError("Missing audio body")

    content_type = handler.headers.get("content-type", "application/octet-stream")
    audio_format = handler.headers.get("x-audio-format", "webm")
    suffix = _extension_for(content_type, audio_format)
    audio = handler.rfile.read(length)
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
        temp.write(audio)
        return Path(temp.name), content_type


def _to_wav_16k_mono(input_path: Path) -> Path:
    output = Path(tempfile.NamedTemporaryFile(delete=False, suffix=".wav").name)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-ar",
            "16000",
            "-ac",
            "1",
            str(output),
        ],
        check=True,
    )
    return output


def _speaker_embedding(input_path: Path) -> Any:
    import numpy as np  # type: ignore
    import torch  # type: ignore
    import torchaudio  # type: ignore

    classifier = _load_speaker_model()
    wav_path = _to_wav_16k_mono(input_path)
    try:
      signal, sample_rate = torchaudio.load(str(wav_path))
      if sample_rate != 16000:
          signal = torchaudio.functional.resample(signal, sample_rate, 16000)
      with torch.inference_mode():
          embedding = classifier.encode_batch(signal).squeeze().detach().cpu().numpy()
      norm = np.linalg.norm(embedding)
      if not math.isfinite(float(norm)) or norm <= 0:
          raise ValueError("Speaker embedding had zero norm")
      return embedding / norm
    finally:
      wav_path.unlink(missing_ok=True)


def _cosine(a: Any | None, b: Any | None) -> float | None:
    if a is None or b is None:
        return None
    import numpy as np  # type: ignore

    return float(np.dot(a, b))


def _merge_embedding(existing: Any | None, samples: int, candidate: Any) -> tuple[Any, int]:
    import numpy as np  # type: ignore

    if existing is None or samples <= 0:
        return candidate, 1
    merged = (existing * samples + candidate) / (samples + 1)
    merged = merged / np.linalg.norm(merged)
    return merged, samples + 1


def _speaker_payload(candidate: Any) -> dict[str, Any]:
    user_similarity = _cosine(USER_EMBEDDING, candidate)
    assistant_similarity = _cosine(ASSISTANT_EMBEDDING, candidate)
    profile_match = _match_persistent_profile(candidate)
    profile_threshold = _profile_threshold()
    user_threshold = float(os.environ.get("SPEAKER_USER_THRESHOLD", "0.58"))
    assistant_margin = float(os.environ.get("SPEAKER_ASSISTANT_MARGIN", "0.06"))
    user_known = USER_EMBEDDING is not None
    assistant_known = ASSISTANT_EMBEDDING is not None

    is_user = False
    reason = "no_user_profile"
    if SPEAKER_PROFILES:
        if profile_match and profile_match["similarity"] >= profile_threshold:
            is_user = True
            reason = "persistent_profile_match"
        else:
            reason = "persistent_profile_low"
    elif user_known and user_similarity is not None:
        is_user = user_similarity >= user_threshold
        reason = "user_similarity_pass" if is_user else "user_similarity_low"
    if is_user and assistant_known and assistant_similarity is not None and user_similarity is not None:
        if assistant_similarity > user_similarity + assistant_margin:
            is_user = False
            reason = "assistant_similarity_higher"

    return {
        "is_user": is_user,
        "reason": reason,
        "user_similarity": user_similarity,
        "assistant_similarity": assistant_similarity,
        "profile_match": profile_match,
        "profile_threshold": profile_threshold,
        "user_threshold": user_threshold,
        "assistant_margin": assistant_margin,
        "user_samples": USER_SAMPLES,
        "assistant_samples": ASSISTANT_SAMPLES,
        "persistent_profile_count": len(SPEAKER_PROFILES),
        "speaker_model": SPEAKER_MODEL_INFO,
        "nvidia_target_model": os.environ.get("SPEAKER_TARGET_MODEL", "nvidia/diar_streaming_sortformer_4spk-v2.1"),
    }


class WhisperXHandler(BaseHTTPRequestHandler):
    server_version = "TutorTronWhisperX/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[whisperx] {self.address_string()} - {fmt % args}")

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            _load_profiles()
            available = True
            error = None
            try:
                import whisperx  # noqa: F401
            except Exception as exc:  # pragma: no cover - environment dependent
                available = False
                error = str(exc)

            _json(
                self,
                HTTPStatus.OK,
                {
                    "ok": available,
                    "model_loaded": MODEL is not None,
                    "model_info": MODEL_INFO,
                    "speaker_model_loaded": SPEAKER_MODEL is not None,
                    "speaker_model_info": SPEAKER_MODEL_INFO,
                    "speaker_runtime": {
                        "active_backend": "local_speechbrain_ecapa",
                        "nvidia_target_model": os.environ.get(
                            "SPEAKER_TARGET_MODEL",
                            "nvidia/diar_streaming_sortformer_4spk-v2.1",
                        ),
                        "nvidia_target_role": "online diarization + persistent speaker labels",
                        "local_fallback_role": "speaker embeddings for persistent student voice profiles",
                    },
                    "speaker_profiles": {
                        "user_samples": USER_SAMPLES,
                        "assistant_samples": ASSISTANT_SAMPLES,
                        "persistent_profiles": len(SPEAKER_PROFILES),
                        "store": str(_profile_store_path()),
                    },
                    "error": error,
                },
            )
            return

        if self.path.rstrip("/") == "/speaker/profiles":
            _load_profiles()
            _json(
                self,
                HTTPStatus.OK,
                {
                    "profiles": [
                        {
                            "id": profile.get("id"),
                            "name": profile.get("name"),
                            "samples": profile.get("samples", 0),
                            "updated_at": profile.get("updated_at"),
                            "model": profile.get("model"),
                        }
                        for profile in SPEAKER_PROFILES.values()
                    ],
                    "store": str(_profile_store_path()),
                },
            )
            return

        _json(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/speaker/reset":
            global USER_EMBEDDING, USER_SAMPLES, ASSISTANT_EMBEDDING, ASSISTANT_SAMPLES
            USER_EMBEDDING = None
            USER_SAMPLES = 0
            ASSISTANT_EMBEDDING = None
            ASSISTANT_SAMPLES = 0
            _json(self, HTTPStatus.OK, {"ok": True, "reset": True, "persistent_profiles_preserved": True})
            return

        if self.path.rstrip("/") == "/speaker/profiles":
            _load_profiles()
            _json(
                self,
                HTTPStatus.OK,
                {
                    "profiles": [
                        {
                            "id": profile.get("id"),
                            "name": profile.get("name"),
                            "samples": profile.get("samples", 0),
                            "updated_at": profile.get("updated_at"),
                            "model": profile.get("model"),
                        }
                        for profile in SPEAKER_PROFILES.values()
                    ],
                    "store": str(_profile_store_path()),
                },
            )
            return

        if self.path.rstrip("/") in {"/speaker/enroll", "/speaker/enroll-assistant", "/speaker/classify"}:
            self._handle_speaker_request()
            return

        if self.path.rstrip("/") != "/transcribe":
            _json(self, HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return

        length = int(self.headers.get("content-length", "0") or "0")
        if length <= 0:
            _json(self, HTTPStatus.BAD_REQUEST, {"error": "Missing audio body"})
            return

        content_type = self.headers.get("content-type", "application/octet-stream")
        audio_format = self.headers.get("x-audio-format", "webm")
        suffix = _extension_for(content_type, audio_format)
        audio = self.rfile.read(length)

        temp_path: Path | None = None
        started_at = time.perf_counter()
        try:
            model = _load_model()
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
                temp.write(audio)
                temp_path = Path(temp.name)

            batch_size = int(os.environ.get("WHISPERX_BATCH_SIZE", "8"))
            result = model.transcribe(str(temp_path), batch_size=batch_size)
            text = " ".join((segment.get("text") or "").strip() for segment in result.get("segments", [])).strip()
            _json(
                self,
                HTTPStatus.OK,
                {
                    "text": text,
                    "segments": result.get("segments", []),
                    "language": result.get("language"),
                    "model_info": MODEL_INFO,
                    "duration_ms": round((time.perf_counter() - started_at) * 1000),
                },
            )
        except ModuleNotFoundError as exc:
            _json(
                self,
                HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "error": "WhisperX is not installed in this environment.",
                    "detail": str(exc),
                    "fix": "Run: npm run stt:install",
                },
            )
        except Exception as exc:  # pragma: no cover - model/runtime dependent
            _json(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "error": "WhisperX transcription failed.",
                    "detail": str(exc),
                    "trace": traceback.format_exc(limit=4),
                },
            )
        finally:
            if temp_path:
                temp_path.unlink(missing_ok=True)

    def _handle_speaker_request(self) -> None:
        global USER_EMBEDDING, USER_SAMPLES, ASSISTANT_EMBEDDING, ASSISTANT_SAMPLES

        temp_path: Path | None = None
        started_at = time.perf_counter()
        try:
            temp_path, _content_type = _write_temp_audio(self)
            embedding = _speaker_embedding(temp_path)
            path = self.path.rstrip("/")

            if path == "/speaker/enroll":
                USER_EMBEDDING, USER_SAMPLES = _merge_embedding(USER_EMBEDDING, USER_SAMPLES, embedding)
                persistent_profile = _enroll_persistent_profile(self, embedding)
                _json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "profile": "user",
                        "persistent_profile": persistent_profile,
                        "samples": USER_SAMPLES,
                        "duration_ms": round((time.perf_counter() - started_at) * 1000),
                        "speaker_model": SPEAKER_MODEL_INFO,
                    },
                )
                return

            if path == "/speaker/enroll-assistant":
                ASSISTANT_EMBEDDING, ASSISTANT_SAMPLES = _merge_embedding(
                    ASSISTANT_EMBEDDING,
                    ASSISTANT_SAMPLES,
                    embedding,
                )
                _json(
                    self,
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "profile": "assistant",
                        "samples": ASSISTANT_SAMPLES,
                        "duration_ms": round((time.perf_counter() - started_at) * 1000),
                        "speaker_model": SPEAKER_MODEL_INFO,
                    },
                )
                return

            payload = _speaker_payload(embedding)
            payload["duration_ms"] = round((time.perf_counter() - started_at) * 1000)
            _json(self, HTTPStatus.OK, payload)
        except ModuleNotFoundError as exc:
            _json(
                self,
                HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    "error": "Speaker identity dependencies are not installed.",
                    "detail": str(exc),
                    "fix": "Run: npm run stt:install",
                },
            )
        except Exception as exc:  # pragma: no cover - model/runtime dependent
            _json(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {
                    "error": "Speaker identity failed.",
                    "detail": str(exc),
                    "trace": traceback.format_exc(limit=4),
                },
            )
        finally:
            if temp_path:
                temp_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("WHISPERX_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WHISPERX_PORT", "9001")))
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), WhisperXHandler)
    print(f"WhisperX adapter listening on http://{args.host}:{args.port}")
    print("Install deps with: npm run stt:install")
    server.serve_forever()


if __name__ == "__main__":
    main()
