from __future__ import annotations

from pathlib import Path

import pytest

from app import main as main_module
from app.config import Settings

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.asyncio
async def test_voice_preflight_includes_codexa_dependency(monkeypatch, tmp_path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="nvidia",
        nvidia_api_key="test-key",
        voice_runtime="local_pipecat",
        local_stt_provider="openrouter",
        openrouter_api_key="test-openrouter-key",
        codex_orchestrator_enabled=True,
        supertonic_language="na",
    )

    async def fake_check_voice_dependencies(*_args, **_kwargs):
        return True, [], [], {
            "stt": {"provider": "openrouter", "healthy": True},
            "tts": {"provider": "supertonic", "healthy": True},
        }

    async def fake_check_codexa_dependency(_settings):
        return False, "Codexa is offline.", {
            "provider": "codexa",
            "healthy": False,
            "health_url": "http://127.0.0.1:4317/health",
            "error": "offline",
        }

    monkeypatch.setattr(main_module, "settings", settings)
    monkeypatch.setattr(main_module, "check_voice_dependencies", fake_check_voice_dependencies)
    monkeypatch.setattr(main_module, "check_codexa_dependency", fake_check_codexa_dependency)

    result = await main_module.voice_preflight("supertone_parakeet")

    assert result["ready"] is False
    assert "Codexa is offline." in result["reasons"]
    assert result["dependencies"]["codex"]["provider"] == "codexa"
    assert result["dependencies"]["codex"]["healthy"] is False


def test_frontend_exposes_only_supertone_speech_path():
    api_source = (REPO_ROOT / "frontend/src/api.ts").read_text()
    app_source = (REPO_ROOT / "frontend/src/App.tsx").read_text()
    flow_source = (REPO_ROOT / "frontend/src/FlowStudio.tsx").read_text()

    assert 'export type VoiceSpeechPath = "supertone_parakeet";' in api_source
    assert 'setSpeechPath("current")' not in app_source
    assert 'onSpeechPathChange?.("current")' not in flow_source
