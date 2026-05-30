from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("DATABASE_PATH", "/tmp/voice-agent-cekura-test-import.sqlite3")

from app import main as main_module
from app.agent import AgentService
from app.cekura import cleanup_cekura_state, record_cekura_result, seed_cekura_state
from app.config import Settings
from app.db import Database, loads
from app.feedback import PromptRepository
from app.flow_runtime import FlowRepository, FlowRuntime
from app.llm import MockLLMClient


@pytest.fixture()
def cekura_runtime(monkeypatch, tmp_path: Path):
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


def test_seed_and_cleanup_cekura_state(cekura_runtime):
    _settings, db = cekura_runtime

    seeded = seed_cekura_state(db, run_id="run-1", scenario_id="scenario-1", result_id="result-1")
    assert seeded["conversation_id"] == "cekura-run-1"
    assert db.one("SELECT id FROM conversations WHERE id = ?", ("cekura-run-1",)) is not None

    cleanup = cleanup_cekura_state(db, run_id="run-1", reset_runtime_profile=True)

    assert cleanup["deleted_conversation_count"] == 1
    assert db.one("SELECT id FROM conversations WHERE id = ?", ("cekura-run-1",)) is None


def test_record_cekura_result_feeds_local_eval_tables(cekura_runtime):
    _settings, db = cekura_runtime

    recorded = record_cekura_result(
        db,
        {
            "event_type": "result.completed",
            "data": {
                "id": 101,
                "status": "completed",
                "success_rate": 50,
                "runs": {
                    "201": {
                        "success": True,
                        "scenario": {"id": 1, "name": "Identity and no handoff"},
                        "transcript_object": [{"role": "Testing Agent", "content": "Hello"}],
                        "evaluation": {"metrics": []},
                    },
                    "202": {
                        "success": False,
                        "scenario": {"id": 2, "name": "Voice speed control"},
                        "error_message": "WebSocket connection timed out",
                    },
                },
            },
        },
    )

    assert recorded["local_eval_run_id"] == "cekura-101"
    rows = db.all("SELECT case_id, passed, feedback_json FROM eval_results ORDER BY case_id")
    assert [(row["case_id"], bool(row["passed"])) for row in rows] == [
        ("Identity and no handoff", True),
        ("Voice speed control", False),
    ]
    assert loads(rows[1]["feedback_json"], {})["error_message"] == "WebSocket connection timed out"


def test_cekura_websocket_runs_voice_text_turn(cekura_runtime):
    _settings, db = cekura_runtime
    client = TestClient(main_module.app)

    with client.websocket_connect(
        "/api/cekura/ws",
        headers={
            "X-VOCERA-RUN-ID": "run-123",
            "X-VOCERA-SCENARIO-ID": "scenario-456",
            "X-VOCERA-RESULT-ID": "result-789",
        },
    ) as websocket:
        websocket.send_json({"content": "Can you talk faster?"})
        message = websocket.receive_json()

    assert "faster" in message["content"].casefold()
    assert message["metadata"]["source"] == "cekura"
    assert message["metadata"]["cekura"]["run_id"] == "run-123"
    assert message["metadata"]["latency_trace_id"]
    assert db.one("SELECT id FROM conversations WHERE id = ?", ("cekura-run-123",)) is not None


def test_cekura_hooks_require_configured_secret(cekura_runtime):
    settings, _db = cekura_runtime
    settings.cekura_webhook_secret = "secret"
    client = TestClient(main_module.app)

    unauthorized = client.post("/api/cekura/hooks/reset", json={"run_id": "run-1"})
    authorized = client.post(
        "/api/cekura/hooks/reset",
        json={"run_id": "run-1"},
        headers={"X-CEKURA-SECRET": "secret"},
    )

    assert unauthorized.status_code == 401
    assert authorized.status_code == 200
