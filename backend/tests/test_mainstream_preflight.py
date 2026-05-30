from __future__ import annotations

from pathlib import Path

import pytest

from app import main as main_module
from app.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_voice_preflight_includes_codex_dependency(monkeypatch, tmp_path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="nemotron",
        voice_runtime="local_pipecat",
        voice_speech_path="nvidia_gradium",
        local_stt_provider="nvidia_ws",
        nvidia_asr_url="ws://asr.test:8080",
        local_tts_provider="gradium",
        gradium_api_key="test-gradium-key",
        codex_orchestrator_enabled=True,
    )

    async def fake_check_voice_dependencies(*_args, **_kwargs):
        return True, [], [], {
            "stt": {"provider": "nvidia_ws", "healthy": True},
            "vad": {"provider": "gradium", "healthy": True},
            "tts": {"provider": "gradium", "healthy": True},
        }

    async def fake_check_codex_dependency(_settings):
        return False, "Codex is offline.", {
            "provider": "codex",
            "healthy": False,
            "health_url": "http://127.0.0.1:4317/health",
            "error": "offline",
        }

    monkeypatch.setattr(main_module, "settings", settings)
    monkeypatch.setattr(main_module, "check_voice_dependencies", fake_check_voice_dependencies)
    monkeypatch.setattr(main_module, "check_codexa_dependency", fake_check_codex_dependency)

    result = await main_module.voice_preflight("nvidia_gradium")

    assert result["ready"] is False
    assert "Codex is offline." in result["reasons"]
    assert result["dependencies"]["codex"]["provider"] == "codex"
    assert result["dependencies"]["codex"]["healthy"] is False


def test_frontend_exposes_only_nvidia_gradium_speech_path():
    api_source = (REPO_ROOT / "frontend/src/api.ts").read_text()
    app_source = (REPO_ROOT / "frontend/src/App.tsx").read_text()
    flow_source = (REPO_ROOT / "frontend/src/FlowStudio.tsx").read_text()

    assert 'export type VoiceSpeechPath = "nvidia_gradium";' in api_source
    assert 'setSpeechPath("current")' not in app_source
    assert 'onSpeechPathChange?.("current")' not in flow_source
