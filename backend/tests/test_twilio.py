from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as main_module
from app.agent import AgentService
from app.config import Settings
from app.db import Database, loads
from app.feedback import PromptRepository
from app.flow_runtime import FlowRepository, FlowRuntime
from app.llm import MockLLMClient
from app.twilio_routes import _to_ws_url, inbound_twiml


@pytest.fixture()
def twilio_runtime(monkeypatch, tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="mock",
        local_tts_provider="gradium",
        voice_speech_path="nvidia_gradium",
    )
    db = Database(settings.database_path)
    prompt_repo = PromptRepository(db)
    llm = MockLLMClient(settings)
    agent = AgentService(db, settings, llm)
    flow_repo = FlowRepository(db)
    flow_runtime = FlowRuntime(db, flow_repo, llm)
    monkeypatch.setattr(main_module, "settings", settings)
    monkeypatch.setattr(main_module, "db", db)
    monkeypatch.setattr(main_module, "prompt_repo", prompt_repo)
    monkeypatch.setattr(main_module, "agent", agent)
    monkeypatch.setattr(main_module, "flow_runtime", flow_runtime)
    return settings, db


def test_to_ws_url_maps_http_and_https_public_urls():
    assert _to_ws_url("http://localhost:8000", "/twilio/media-stream") == (
        "ws://localhost:8000/twilio/media-stream"
    )
    assert _to_ws_url("https://voice.example.com", "/twilio/media-stream") == (
        "wss://voice.example.com/twilio/media-stream"
    )


def test_inbound_twiml_uses_public_base_url():
    xml = inbound_twiml(Settings(public_base_url="https://voice.example.com"))

    assert '<Stream url="wss://voice.example.com/twilio/media-stream">' in xml
    assert 'name="agent_profile" value="default"' in xml
    assert "_pipecatCloudServiceHost" not in xml


def test_twilio_media_stream_text_bridge_uses_voice_turn_runner(twilio_runtime):
    _settings, db = twilio_runtime
    client = TestClient(main_module.app)

    with client.websocket_connect("/twilio/media-stream") as websocket:
        websocket.send_json(
            {
                "event": "start",
                "start": {
                    "streamSid": "MZ123",
                    "callSid": "CA123",
                    "customParameters": {"agent_profile": "default"},
                },
            }
        )
        assert websocket.receive_json() == {
            "event": "mark",
            "streamSid": "MZ123",
            "mark": {"name": "ready"},
        }

        websocket.send_json({"event": "text", "text": "Can you talk faster?"})
        message = websocket.receive_json()
        websocket.send_json({"event": "stop"})

    assert message["event"] == "agent_text"
    assert message["streamSid"] == "MZ123"
    assert message["conversation_id"] == "twilio-CA123"
    assert "faster" in message["text"].casefold()
    assert message["metadata"]["source"] == "twilio"
    assert message["metadata"]["voice_turn_source"] == "voice_text_turn"
    assert message["metadata"]["latency_trace_id"]

    turns = db.all(
        "SELECT role, content, metrics_json FROM turns WHERE conversation_id = ? ORDER BY rowid",
        ("twilio-CA123",),
    )
    assert [(row["role"], row["content"]) for row in turns] == [
        ("system", "Twilio media stream started. Text bridge is routed through the voice turn runner."),
        ("user", "Can you talk faster?"),
        ("assistant", message["text"]),
    ]
    assert loads(turns[1]["metrics_json"], {})["source"] == "text_assumed_stt"
