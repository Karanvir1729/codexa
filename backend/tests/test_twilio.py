import asyncio

import httpx
import pytest

from app import main as main_module
from app.config import Settings
from app.db import Database, dumps
from app.twilio_routes import (
    _to_ws_url,
    _twilio_spoken_summary,
    gather_twiml,
    inbound_twiml,
    no_input_twiml,
    pending_twiml,
    should_use_media_stream,
    voice_turn_twiml,
)


def test_to_ws_url_maps_http_and_https_public_urls():
    assert _to_ws_url("http://localhost:8000", "/twilio/media-stream") == (
        "ws://localhost:8000/twilio/media-stream"
    )
    assert _to_ws_url("https://voice.example.com", "/twilio/media-stream") == (
        "wss://voice.example.com/twilio/media-stream"
    )


def test_inbound_twiml_uses_public_base_url_when_cloud_settings_absent():
    xml = inbound_twiml(
        Settings(public_base_url="https://voice.example.com", twilio_voice_mode="media_stream")
    )

    assert '<Stream url="wss://voice.example.com/twilio/media-stream">' in xml
    assert 'name="agent_profile" value="default"' in xml
    assert "_pipecatCloudServiceHost" not in xml


def test_inbound_twiml_uses_pipecat_cloud_settings_and_escapes_values():
    xml = inbound_twiml(
        Settings(
            pipecat_cloud_ws_url="wss://api.pipecat.example/ws/twilio?x=<bad>",
            pipecat_cloud_service_host="svc.example.com/<host>",
        )
    )

    assert 'url="wss://api.pipecat.example/ws/twilio?x=&lt;bad&gt;"' in xml
    assert 'name="_pipecatCloudServiceHost" value="svc.example.com/&lt;host&gt;"' in xml


def test_auto_twilio_mode_uses_gather_without_pipecat_runtime():
    settings = Settings(public_base_url="https://voice.example.com", voice_runtime="text")

    assert should_use_media_stream(settings) is False

    xml = inbound_twiml(settings, call_sid="CA123")

    assert "<Gather" in xml
    assert 'input="speech"' in xml
    assert "You are connected to the voice coding agent" in xml
    assert "conversation_id=twilio-call-CA123" in xml
    assert "/twilio/media-stream" not in xml


def test_auto_twilio_mode_keeps_media_stream_for_pipecat_runtime():
    settings = Settings(public_base_url="https://voice.example.com", voice_runtime="pipecat")

    assert should_use_media_stream(settings) is True
    assert "/twilio/media-stream" in inbound_twiml(settings)


def test_gather_twiml_uses_webhook_base_and_escapes_response():
    settings = Settings(
        public_base_url="http://localhost:8000",
        twilio_webhook_base_url="https://voice.example.com",
    )

    xml = voice_turn_twiml(settings, "A <great> answer", "twilio-call-1")

    assert 'action="https://voice.example.com/twilio/voice-turn?conversation_id=twilio-call-1"' in xml
    assert "A &lt;great&gt; answer" in xml


def test_gather_twiml_trims_long_agent_responses():
    settings = Settings(public_base_url="https://voice.example.com")

    xml = gather_twiml(settings, "hello")
    long_xml = voice_turn_twiml(settings, "word " * 400)

    assert "hello" in xml
    assert len(long_xml) < 1800


def test_twilio_spoken_summary_removes_file_paths_and_stays_concise():
    text = (
        "Done. Changed files: /Users/karanvirkhanna/shirts/backend/app/main.py, "
        "`frontend/src/App.tsx`, and /tmp/build/logs/output.txt. "
        "Validation passed with npm test. The browser UI has the full details."
    )

    summary = _twilio_spoken_summary(text)
    xml = voice_turn_twiml(Settings(public_base_url="https://voice.example.com"), text, "twilio-call-1")

    assert "/Users/" not in summary
    assert "/tmp/" not in summary
    assert "frontend/src/App.tsx" not in summary
    assert "/Users/" not in xml
    assert "/tmp/" not in xml
    assert "frontend/src/App.tsx" not in xml
    assert "Validation passed" in summary
    assert len(summary) <= 700


def test_no_input_twiml_hangs_up_after_empty_turn_limit():
    settings = Settings(
        _env_file=None,
        public_base_url="https://voice.example.com",
        twilio_gather_max_empty_turns=2,
    )

    retry_xml = no_input_twiml(settings, "twilio-call-1", no_input_count=1)
    final_xml = no_input_twiml(settings, "twilio-call-1", no_input_count=2)

    assert "no_input_count=2" in retry_xml
    assert "<Redirect" in retry_xml
    assert "<Hangup />" in final_xml
    assert "<Redirect" not in final_xml


def test_pending_twiml_polls_without_requiring_speech_input():
    settings = Settings(public_base_url="https://voice.example.com")

    xml = pending_twiml(settings, "twilio-call-1")

    assert "Codex is still working" in xml
    assert "<Pause" in xml
    assert "pending=1" in xml
    assert "<Gather" not in xml


@pytest.mark.asyncio
async def test_twilio_voice_turn_returns_polling_twiml_when_codex_is_slow(monkeypatch, tmp_path):
    settings = Settings(
        _env_file=None,
        database_path=str(tmp_path / "agent.sqlite3"),
        public_base_url="https://voice.example.com",
        twilio_webhook_base_url="https://voice.example.com",
        twilio_voice_turn_timeout_seconds=0.1,
    )
    calls: list[str] = []

    class SlowAgent:
        async def respond(self, user_text, **_kwargs):
            calls.append(user_text)
            await asyncio.sleep(0.2)
            return {"message": "What should I name the shirt shop project?"}

    monkeypatch.setattr(main_module, "settings", settings)
    monkeypatch.setattr(main_module, "agent", SlowAgent())
    main_module.twilio_pending_turns.clear()

    transport = httpx.ASGITransport(app=main_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        first = await client.post(
            "/twilio/voice-turn?conversation_id=twilio-call-test",
            data={"SpeechResult": "Build an app to sell shirts."},
        )
        assert first.status_code == 200
        assert "Codex is still working" in first.text
        assert "pending=1" in first.text

        await asyncio.sleep(0.15)
        second = await client.post("/twilio/voice-turn?conversation_id=twilio-call-test&pending=1")

    assert second.status_code == 200
    assert "What should I name the shirt shop project?" in second.text
    assert calls == ["Build an app to sell shirts."]
    assert "twilio-call-test" not in main_module.twilio_pending_turns


def test_twilio_number_alias_supports_existing_env_name():
    settings = Settings(_env_file=None, twilio_phone_number="+15551234567")

    assert settings.twilio_effective_from_number == "+15551234567"


@pytest.mark.asyncio
async def test_twilio_status_endpoint_returns_configured_phone_number(monkeypatch):
    monkeypatch.setattr(
        main_module,
        "settings",
        Settings(
            _env_file=None,
            twilio_account_sid="AC123",
            twilio_auth_token="secret",
            twilio_phone_number="+15551234567",
            twilio_phone_number_sid="PN123",
            twilio_voice_webhook_url="https://voice.example.com/api/twilio/voice",
            twilio_status_callback_url="https://voice.example.com/twilio/status",
        ),
    )

    transport = httpx.ASGITransport(app=main_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/twilio/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ready"] is True
    assert payload["phone_number"] == "+15551234567"
    assert payload["from_number_configured"] is True
    assert payload["voice_webhook_url"] == "https://voice.example.com/api/twilio/voice"


@pytest.mark.asyncio
async def test_twilio_call_logs_endpoint_returns_transcript_and_status(monkeypatch, tmp_path):
    test_db = Database(str(tmp_path / "agent.sqlite3"))
    monkeypatch.setattr(main_module, "db", test_db)
    test_db.execute(
        """
        INSERT INTO conversations(id, channel, caller, metadata_json)
        VALUES (?, 'twilio', ?, ?)
        """,
        (
            "twilio-call-CA123",
            "+15551234567",
            dumps({"call_sid": "CA123", "to": "+14246993915", "from": "+15551234567"}),
        ),
    )
    test_db.execute(
        """
        INSERT INTO turns(id, conversation_id, role, content, metrics_json)
        VALUES (?, ?, 'user', ?, ?)
        """,
        ("turn-user", "twilio-call-CA123", "Build a shirt shop.", dumps({"channel": "twilio"})),
    )
    test_db.execute(
        """
        INSERT INTO turns(id, conversation_id, role, content, latency_ms, model, metrics_json)
        VALUES (?, ?, 'assistant', ?, 321, 'codexa-http', ?)
        """,
        (
            "turn-assistant",
            "twilio-call-CA123",
            "What should I name the project?",
            dumps(
                {
                    "provider": "codex-orchestrator",
                    "codex": {
                        "codex_session_id": "codexa-call",
                        "codex_project_id": "project-call",
                        "requires_approval": True,
                    },
                }
            ),
        ),
    )
    test_db.execute(
        """
        INSERT INTO turns(id, conversation_id, role, content, metrics_json)
        VALUES (?, ?, 'system', ?, ?)
        """,
        (
            "turn-status",
            "twilio-call-CA123",
            "Twilio call status: completed",
            dumps({"source": "twilio_status_callback", "call_status": "completed", "duration": "601"}),
        ),
    )

    transport = httpx.ASGITransport(app=main_module.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/twilio/call-logs")

    assert response.status_code == 200
    payload = response.json()
    assert payload["calls"][0]["conversation_id"] == "twilio-call-CA123"
    assert payload["calls"][0]["call_sid"] == "CA123"
    assert payload["calls"][0]["status"] == "completed"
    assert payload["calls"][0]["duration_seconds"] == "601"
    assert payload["calls"][0]["last_message"] == "What should I name the project?"
    assert payload["calls"][0]["codex"]["codex_session_id"] == "codexa-call"
    assert [turn["role"] for turn in payload["calls"][0]["turns"]] == [
        "user",
        "assistant",
        "system",
    ]
