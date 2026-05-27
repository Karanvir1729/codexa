from __future__ import annotations

import json
import re
import shutil
import time
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .config import Settings


VoiceCloneIntent = Literal["enable", "disable", "delete"]


def voice_clone_intent(text: str) -> VoiceCloneIntent | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    if not normalized:
        return None
    if any(
        phrase in normalized
        for phrase in [
            "delete my voice clone",
            "forget my voice clone",
            "forget my voice",
            "erase my voice clone",
            "remove my voice clone",
        ]
    ):
        return "delete"
    if any(
        phrase in normalized
        for phrase in [
            "stop cloning my voice",
            "stop saving my voice",
            "pause voice cloning",
            "turn off voice cloning",
        ]
    ):
        return "disable"
    if any(
        phrase in normalized
        for phrase in [
            "can you clone my voice",
            "could you clone my voice",
            "will you clone my voice",
            "clone my voice",
            "you can clone my voice",
            "yes clone my voice",
            "please clone my voice",
            "you may clone my voice",
            "i consent to voice cloning",
            "i give consent to voice cloning",
            "i give you consent to clone my voice",
            "start cloning my voice",
            "start saving my voice",
            "use my voice as the voice prompt",
        ]
    ):
        return "enable"
    return None


def voice_clone_response(intent: VoiceCloneIntent) -> str:
    if intent == "enable":
        return "Voice cloning is on. I'll save your voice samples and use them as my voice prompt."
    if intent == "disable":
        return "Voice cloning is paused."
    return "I deleted the stored voice clone."


def voice_clone_followup_response(text: str, status: dict[str, Any]) -> str | None:
    if not status.get("enabled"):
        return None
    normalized = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    if not normalized:
        return None
    sample_count = int(status.get("sample_count") or 0)
    if (
        normalized in {"hi", "hello", "hey", "hallo"}
        or "are you there" in normalized
        or "you there" in normalized
        or "hello" in normalized
        or "hallo" in normalized
    ):
        return "I'm here. Voice cloning is still on; keep talking naturally."
    if any(
        phrase in normalized
        for phrase in [
            "do you need any more data",
            "do you need more data",
            "need any more data",
            "need more data",
            "how much data",
            "is that enough data",
            "is this enough data",
            "i can keep talking",
            "keep talking",
            "voice turns out",
            "voice is perfect",
            "voice perfect",
        ]
    ):
        if sample_count < 3:
            return "Yes. Keep talking naturally for a few more clear sentences."
        return "That's enough to start. Keep talking naturally and I'll keep updating the voice sample."
    return None


@dataclass
class CompletedUtterance:
    id: str
    audio: bytes
    sample_rate: int
    num_channels: int
    started_at: float
    stopped_at: float

    @property
    def duration_seconds(self) -> float:
        bytes_per_frame = max(1, self.num_channels * 2)
        return len(self.audio) / bytes_per_frame / max(1, self.sample_rate)


class VoiceCloneProfileStore:
    """Consent-gated local voice sample storage for Voxtral reference audio."""

    def __init__(self, settings: Settings, profile_id: str | None = None) -> None:
        self.settings = settings
        self.profile_id = _safe_id(profile_id or settings.voice_clone_profile_id)
        self.profile_dir = _repo_path(settings.voice_clone_storage_dir) / self.profile_id
        self.samples_dir = self.profile_dir / "samples"
        self.manifest_path = self.profile_dir / "manifest.json"
        self.reference_path = self.profile_dir / "reference.wav"
        self.enabled = False
        self._active_id: str | None = None
        self._active_started_at = 0.0
        self._active_sample_rate = settings.local_audio_input_sample_rate
        self._active_num_channels = 1
        self._active_chunks: list[bytes] = []
        self._last_completed: CompletedUtterance | None = None
        self._last_saved_utterance_id: str | None = None
        self._manifest = self._load_manifest()
        self.enabled = bool(self._manifest.get("consent_active")) and settings.voice_clone_enabled

    def status(self) -> dict[str, Any]:
        samples = self._manifest.get("samples")
        reference = self._manifest.get("reference")
        return {
            "enabled": self.enabled,
            "profile_id": self.profile_id,
            "sample_count": len(samples) if isinstance(samples, list) else 0,
            "reference_path": str(self.reference_path) if self.reference_path.exists() else None,
            "reference": reference if isinstance(reference, dict) else None,
        }

    def active_reference_path(self) -> Path | None:
        if not self.settings.voice_clone_enabled or not self.enabled:
            return None
        return self.reference_path if self.reference_path.exists() else None

    def start_utterance(self) -> None:
        self._active_id = str(uuid.uuid4())
        self._active_started_at = time.time()
        self._active_chunks = []

    def append_audio(self, audio: bytes, sample_rate: int, num_channels: int) -> None:
        if not self._active_id or not audio:
            return
        self._active_sample_rate = sample_rate
        self._active_num_channels = num_channels
        max_bytes = int(
            self.settings.voice_clone_max_sample_seconds
            * max(1, sample_rate)
            * max(1, num_channels)
            * 2
        )
        current_bytes = sum(len(chunk) for chunk in self._active_chunks)
        if current_bytes >= max_bytes:
            return
        self._active_chunks.append(audio[: max(0, max_bytes - current_bytes)])

    def stop_utterance(self) -> None:
        if not self._active_id:
            return
        audio = b"".join(self._active_chunks)
        self._last_completed = CompletedUtterance(
            id=self._active_id,
            audio=audio,
            sample_rate=self._active_sample_rate,
            num_channels=self._active_num_channels,
            started_at=self._active_started_at,
            stopped_at=time.time(),
        )
        self._active_id = None
        self._active_chunks = []

    def handle_transcript(self, text: str) -> dict[str, Any] | None:
        if not self.settings.voice_clone_enabled:
            return None
        intent = voice_clone_intent(text)
        if intent == "delete":
            self.delete()
            return {"intent": intent, **self.status()}
        if intent == "disable":
            self.enabled = False
            self._manifest["consent_active"] = False
            self._manifest["updated_at"] = _now()
            self._save_manifest()
            return {"intent": intent, **self.status()}
        if intent == "enable":
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            self.samples_dir.mkdir(parents=True, exist_ok=True)
            self.enabled = True
            self._manifest["profile_id"] = self.profile_id
            self._manifest["consent_active"] = True
            self._manifest["consented_at"] = self._manifest.get("consented_at") or _now()
            self._manifest["updated_at"] = _now()
            self._save_manifest()

        if self.enabled:
            saved = self._save_last_completed(text)
            status = self.status()
            return {"intent": intent, "saved": saved, **status}
        return None

    def delete(self) -> None:
        if self.profile_dir.exists():
            shutil.rmtree(self.profile_dir)
        self.enabled = False
        self._manifest = self._default_manifest()
        self._last_saved_utterance_id = None

    def _save_last_completed(self, transcript: str) -> bool:
        utterance = self._last_completed
        if not utterance or utterance.id == self._last_saved_utterance_id:
            return False
        if utterance.duration_seconds < self.settings.voice_clone_min_sample_seconds:
            return False

        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self.samples_dir.mkdir(parents=True, exist_ok=True)
        index = len(self._samples()) + 1
        sample_name = f"sample-{index:04d}.wav"
        sample_path = self.samples_dir / sample_name
        _write_wav(sample_path, utterance.audio, utterance.sample_rate, utterance.num_channels)

        sample = {
            "id": utterance.id,
            "path": str(sample_path.relative_to(self.profile_dir)),
            "transcript": transcript.strip(),
            "duration_seconds": round(utterance.duration_seconds, 3),
            "sample_rate": utterance.sample_rate,
            "num_channels": utterance.num_channels,
            "created_at": _now(),
        }
        samples = self._samples()
        samples.append(sample)
        self._manifest["samples"] = samples[-self.settings.voice_clone_max_samples :]
        self._manifest["updated_at"] = _now()
        self._last_saved_utterance_id = utterance.id
        self._rebuild_reference()
        self._save_manifest()
        return True

    def _rebuild_reference(self) -> None:
        chunks: list[bytes] = []
        sample_rate: int | None = None
        num_channels: int | None = None
        duration = 0.0
        selected = 0
        for sample in reversed(self._samples()):
            path_value = sample.get("path") if isinstance(sample, dict) else None
            if not isinstance(path_value, str):
                continue
            sample_path = self.profile_dir / path_value
            if not sample_path.exists():
                continue
            with wave.open(str(sample_path), "rb") as wav_file:
                channels = wav_file.getnchannels()
                width = wav_file.getsampwidth()
                rate = wav_file.getframerate()
                frames = wav_file.readframes(wav_file.getnframes())
            if width != 2:
                continue
            if sample_rate is None:
                sample_rate = rate
                num_channels = channels
            if rate != sample_rate or channels != num_channels:
                continue
            sample_duration = len(frames) / max(1, rate * channels * 2)
            if duration >= self.settings.voice_clone_max_reference_seconds:
                break
            chunks.insert(0, frames)
            duration += sample_duration
            selected += 1

        if sample_rate is None or num_channels is None or not chunks:
            return
        reference_audio = b"".join(chunks)
        max_bytes = int(
            self.settings.voice_clone_max_reference_seconds * sample_rate * num_channels * 2
        )
        if len(reference_audio) > max_bytes:
            reference_audio = reference_audio[-max_bytes:]
            duration = self.settings.voice_clone_max_reference_seconds
        _write_wav(self.reference_path, reference_audio, sample_rate, num_channels)
        self._manifest["reference"] = {
            "path": str(self.reference_path.relative_to(self.profile_dir)),
            "duration_seconds": round(duration, 3),
            "sample_count": selected,
            "sample_rate": sample_rate,
            "num_channels": num_channels,
            "updated_at": _now(),
        }

    def _samples(self) -> list[dict[str, Any]]:
        samples = self._manifest.get("samples")
        return samples if isinstance(samples, list) else []

    def _load_manifest(self) -> dict[str, Any]:
        if not self.manifest_path.exists():
            return self._default_manifest()
        try:
            data = json.loads(self.manifest_path.read_text())
        except (OSError, json.JSONDecodeError):
            return self._default_manifest()
        return data if isinstance(data, dict) else self._default_manifest()

    def _save_manifest(self) -> None:
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(json.dumps(self._manifest, indent=2, sort_keys=True))

    def _default_manifest(self) -> dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "consent_active": False,
            "samples": [],
            "created_at": _now(),
            "updated_at": _now(),
        }


def _repo_path(path: str) -> Path:
    raw = Path(path)
    if raw.is_absolute():
        return raw
    return Path(__file__).resolve().parents[2] / raw


def _safe_id(value: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip())[:80].strip("-")
    return safe or "default"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _write_wav(path: Path, audio: bytes, sample_rate: int, num_channels: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(max(1, num_channels))
        wav_file.setsampwidth(2)
        wav_file.setframerate(max(1, sample_rate))
        wav_file.writeframes(audio)
