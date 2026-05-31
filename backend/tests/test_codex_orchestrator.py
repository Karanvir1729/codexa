from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.codex_orchestrator import CodexOrchestratorBridge, is_codex_detail_request, is_codex_task_request
from app.config import Settings
from app.db import Database, loads
from app.flow_runtime import FlowRepository, FlowRuntime
from app.local_voice_runtime import (
    _live_voice_recent_user_request,
    _repair_codex_project_selection_transcript,
)
from app.llm import LLMResult, MockLLMClient
from app.voice_text_test import run_voice_text_turn
from app.agent import AgentService
from app.feedback import PromptRepository
from app.voice_runtime_executor import execute_voice_runtime_actions


class FailingLLM:
    async def generate(self, messages, system_prompt):
        raise AssertionError("Twilio Codex routing should not call the voice LLM")

    async def warmup(self) -> None:
        return None


class SemanticBuilderRouterLLM:
    async def generate(self, messages, system_prompt):
        assert "Builder context" in system_prompt
        user_text = next((item["content"] for item in reversed(messages) if item["role"] == "user"), "")
        return LLMResult(
            text=json.dumps(
                {
                    "speak": "I'll route that to Builder.",
                    "runtime_actions": [
                        {
                            "tool": "delegate_to_codex_orchestrator",
                            "args": {
                                "goal": user_text,
                                "mode": "plan_first",
                                "reason": "semantic_builder_request",
                            },
                        }
                    ],
                    "reasoning_profile": "reasoning",
                    "debug": {"intent": "codex_orchestrator_delegate"},
                }
            ),
            latency_ms=1,
            model="semantic-builder-router",
            provider="mock",
            raw={"deterministic": True},
        )

    async def warmup(self) -> None:
        return None


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="mock",
        codex_orchestrator_enabled=True,
        local_tts_provider="supertonic",
        voice_speech_path="supertone_parakeet",
    )


def _ensure_conversation(db: Database, conversation_id: str = "voice-codex") -> None:
    db.execute(
        """
        INSERT OR IGNORE INTO conversations(id, channel, metadata_json)
        VALUES (?, 'browser_voice_text', '{}')
        """,
        (conversation_id,),
    )


def test_codex_task_intent_accepts_planning_language_and_codexa_name():
    assert is_codex_task_request(
        "Use the codexa-live-smoke project. Plan adding a tiny static checklist feature."
    )
    assert is_codex_task_request("Tell Codex to continue.")
    assert not is_codex_task_request("Build a chess game.")


def test_codex_detail_intent_accepts_natural_elaboration_language():
    assert is_codex_detail_request("Can you elaborate on the Megaplan?")
    assert is_codex_detail_request("Give me the full summary.")


def test_live_voice_request_combines_vad_fragments_for_codex_task():
    settings = Settings(codex_orchestrator_enabled=True)
    messages = [
        {"role": "assistant", "content": "How can I help?"},
        {"role": "user", "content": "Okay."},
        {"role": "user", "content": "Can you build a"},
        {"role": "user", "content": "chess.com like website for me."},
        {"role": "user", "content": "I want it to be a real chess game."},
        {"role": "user", "content": "multiplayer on the same computer."},
        {"role": "user", "content": "flip the board and not flip the board."},
    ]

    combined = _live_voice_recent_user_request(
        messages,
        "flip the board and not flip the board.",
        settings,
    )

    assert combined.startswith("Can you build a")
    assert "chess.com like website" in combined
    assert "multiplayer on the same computer" in combined


def test_live_voice_request_keeps_simple_latest_turn_when_not_task():
    settings = Settings(codex_orchestrator_enabled=True)
    messages = [
        {"role": "assistant", "content": "How can I help?"},
        {"role": "user", "content": "Okay."},
        {"role": "user", "content": "What's your name?"},
    ]

    assert _live_voice_recent_user_request(messages, "What's your name?", settings) == "What's your name?"


@pytest.mark.asyncio
async def test_voice_text_uses_model_router_for_builder_task_without_task_keyword_list(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    prompt_repo = PromptRepository(db)
    agent = AgentService(db, settings, SemanticBuilderRouterLLM())
    flow_repo = FlowRepository(db)
    flow_runtime = FlowRuntime(db, flow_repo, MockLLMClient(settings))
    calls: list[dict[str, Any]] = []

    async def fake_request(self, method, path, *, json=None, params=None):
        if path == "/agent/chat":
            calls.append(dict(json or {}))
            return {
                "text": "I made a Builder plan for the chess game.",
                "sessionId": "codexa-chess",
                "projectId": "project-chess",
            }
        return {"ok": True}

    monkeypatch.setattr(CodexOrchestratorBridge, "_request_json", fake_request)

    assert not is_codex_task_request("Build a chess game.")

    result = await run_voice_text_turn(
        message="Build a chess game.",
        conversation_id="voice-chess",
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        agent=agent,
        flow_runtime=flow_runtime,
        voice_behavior_mode="assistant",
    )

    assert calls
    assert "Build a chess game." in calls[0]["text"]
    assert result["codex"]["codex_session_id"] == "codexa-chess"
    assert result["providers"]["codex_project_id"] == "project-chess"


def test_contextual_codex_project_selection_stt_repair():
    prompt = "Which project do you mean? I see codexa-live-smoke-workspace-gpt55, codexa-live-smoke-gpt55."

    assert _repair_codex_project_selection_transcript("No one.", prompt) == "New one."
    assert (
        _repair_codex_project_selection_transcript("What is the work?", prompt)
        == "Create a new project."
    )
    assert _repair_codex_project_selection_transcript("No one.", "Hello there.") == "No one."


@pytest.mark.asyncio
async def test_codex_bridge_delegates_and_reuses_persisted_session(tmp_path: Path):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)
    requests: list[dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/agent/chat":
            body = json.loads(request.content.decode())
            requests.append(body)
            return httpx.Response(
                200,
                json={
                    "text": "Which local repo should I use?",
                    "sessionId": "codexa-session-1",
                    "projectId": "project-1",
                },
            )
        return httpx.Response(200, json={"ok": True})

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))

    first = await bridge.delegate(
        conversation_id="voice-codex",
        user_text="Build an app dashboard.",
        transcript=[{"role": "user", "content": "Build an app dashboard."}],
    )
    second = await bridge.delegate(
        conversation_id="voice-codex",
        user_text="Use this repo.",
        transcript=[{"role": "user", "content": "Use this repo."}],
    )

    assert first.codex_session_id == "codexa-session-1"
    assert first.metadata()["voice_conversation_id"] == "voice-codex"
    assert second.codex_session_id == "codexa-session-1"
    assert requests[0]["channel"] == "web_voice"
    assert requests[0]["text"] == "Build an app dashboard."
    assert requests[1]["session_id"] == "codexa-session-1"
    assert requests[1]["text"] == "Use this repo."

    row = db.one(
        "SELECT codex_session_id, codex_project_id FROM codex_orchestrator_sessions WHERE conversation_id = ?",
        ("voice-codex",),
    )
    assert row is not None
    assert row["codex_session_id"] == "codexa-session-1"
    assert row["codex_project_id"] == "project-1"


@pytest.mark.asyncio
async def test_codex_bridge_reports_unreachable_without_session(tmp_path: Path):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)

    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))
    result = await bridge.delegate(conversation_id="voice-codex", user_text="Build a test app.")

    assert result.status == "unreachable"
    assert "cannot reach Codex" in result.text


@pytest.mark.asyncio
async def test_codex_bridge_reports_timeout(tmp_path: Path, monkeypatch):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)
    monkeypatch.setattr("app.codex_orchestrator.asyncio.sleep", _no_sleep)

    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))
    result = await bridge.delegate(conversation_id="voice-codex", user_text="Build a test app.")

    assert result.status == "timeout"
    assert "timed out" in result.text


async def _no_sleep(_delay: float) -> None:
    return None


@pytest.mark.asyncio
async def test_codex_bridge_recovers_session_after_post_timeout(tmp_path: Path, monkeypatch):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)
    monkeypatch.setattr("app.codex_orchestrator.asyncio.sleep", _no_sleep)
    requests: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(f"{request.method} {request.url.path}")
        if request.method == "POST":
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(
            200,
            json={
                "sessions": [
                    {
                        "session_id": "codexa-recovered",
                        "user_id": "voice-agent:voice-codex",
                        "project_id": "project-recovered",
                        "latest_codex_message": "Recovered Codexa response.",
                        "pending_approvals": [
                            {"id": "approval-recovered", "status": "pending"},
                        ],
                    }
                ]
            },
        )

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))
    result = await bridge.delegate(conversation_id="voice-codex", user_text="Plan a task.")

    assert result.status == "completed"
    assert result.text == "Recovered Codexa response."
    assert result.codex_session_id == "codexa-recovered"
    assert result.codex_project_id == "project-recovered"
    assert result.requires_approval is True
    assert result.approval_id == "approval-recovered"
    assert requests == ["POST /agent/chat", "GET /codex/status"]
    assert bridge.load_mapping("voice-codex")["codex_session_id"] == "codexa-recovered"


@pytest.mark.asyncio
async def test_codex_bridge_health_and_status_summary(tmp_path: Path):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)

    db.execute(
        """
        INSERT INTO codex_orchestrator_sessions(
            conversation_id, codex_session_id, codex_project_id, requires_approval, approval_id, last_status
        )
        VALUES (?, ?, ?, 1, ?, 'completed')
        """,
        ("voice-codex", "codexa-1", "project-1", "approval-1"),
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/codex/status":
            assert request.url.params["session_id"] == "codexa-1"
            return httpx.Response(
                200,
                json={
                    "session": {
                        "session_id": "codexa-1",
                        "latest_codex_message": "Final plan is waiting for approval.",
                        "files_modified": ["app.py", "tests/test_app.py"],
                        "pending_action": {
                            "type": "approve_megaplan",
                            "reason": "The Megaplan must be approved before Codex starts implementation.",
                        },
                    },
                },
            )
        return httpx.Response(404, json={"error": "unexpected"})

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))

    assert await bridge.health() is True
    result = await bridge.status("voice-codex")

    assert result.status == "completed"
    assert result.codex_session_id == "codexa-1"
    assert result.requires_approval is True
    assert "Final plan is waiting for approval" in result.text
    assert "Builder has the Megaplan" in result.text

    detailed = await bridge.status("voice-codex", user_text="Can you elaborate?")
    assert "Files modified: app.py, tests/test_app.py." in detailed.text
    assert "approve_megaplan" in detailed.text


@pytest.mark.asyncio
async def test_codex_bridge_filters_synced_flowchart_to_voice_session(tmp_path: Path):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)
    db.execute(
        """
        INSERT INTO codex_orchestrator_sessions(
            conversation_id, codex_session_id, codex_project_id, codex_task_id, last_status
        )
        VALUES (?, ?, ?, ?, 'completed')
        """,
        ("voice-codex", "codexa-1", "project-1", "task-1"),
    )

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/orchestrator/flowchart"
        return httpx.Response(
            200,
            json={
                "generated_at": "2026-05-29T00:00:00Z",
                "nodes": [
                    {
                        "id": "channel:web_voice",
                        "type": "channel",
                        "label": "Web Voice",
                        "status": "active",
                        "summary": "Session codexa-1 is active.",
                        "detail": {"sessions": ["codexa-1"]},
                    },
                    {
                        "id": "session:codexa-1",
                        "type": "session",
                        "label": "Session",
                        "status": "running",
                        "summary": "Planning.",
                        "detail": {
                            "session": {
                                "session_id": "codexa-1",
                                "active_task_id": "task-1",
                                "raw_events": [{"large": "not returned"}],
                            }
                        },
                    },
                    {
                        "id": "task:task-1",
                        "type": "task",
                        "label": "Task",
                        "visual_state": "completed",
                        "summary": "Ready for approval.",
                        "detail": {"task": {"task_id": "task-1", "project_id": "project-1"}},
                    },
                    {
                        "id": "session:other",
                        "type": "session",
                        "label": "Other",
                        "summary": "Unrelated.",
                    },
                ],
                "edges": [
                    {"id": "a", "from": "channel:web_voice", "to": "session:codexa-1"},
                    {"id": "b", "from": "session:codexa-1", "to": "task:task-1"},
                    {"id": "c", "from": "session:other", "to": "task:task-1"},
                ],
            },
        )

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))
    flowchart = await bridge.flowchart("voice-codex")

    assert flowchart["status"] == "completed"
    assert [node["id"] for node in flowchart["nodes"]] == [
        "channel:web_voice",
        "session:codexa-1",
        "task:task-1",
    ]
    assert [edge["id"] for edge in flowchart["edges"]] == ["a", "b"]
    assert "raw_events" not in json.dumps(flowchart)


@pytest.mark.asyncio
async def test_codex_bridge_enriches_megaplan_pending_action(tmp_path: Path):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/agent/chat":
            return httpx.Response(
                200,
                json={"text": "Reply approve to start.", "sessionId": "codexa-1"},
            )
        if request.url.path == "/codex/status":
            return httpx.Response(
                200,
                json={
                    "session": {
                        "session_id": "codexa-1",
                        "project_id": "project-1",
                        "pending_action": {"type": "approve_megaplan"},
                        "approval_status": "pending",
                    }
                },
            )
        return httpx.Response(404, json={"error": "unexpected"})

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))
    result = await bridge.delegate(conversation_id="voice-codex", user_text="Plan the work.")

    assert result.requires_approval is True
    assert result.approval_id == "approve_megaplan"
    assert result.metadata()["codex_session_status"] is None
    row = db.one(
        """
        SELECT requires_approval, approval_id
        FROM codex_orchestrator_sessions
        WHERE conversation_id = ?
        """,
        ("voice-codex",),
    )
    assert row is not None
    assert row["requires_approval"] == 1
    assert row["approval_id"] == "approve_megaplan"


@pytest.mark.asyncio
async def test_runtime_executor_runs_codex_tool_once_and_uses_spoken_result(tmp_path: Path):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        if request.url.path == "/codex/status":
            return httpx.Response(200, json={"session": {"session_id": "codexa-1"}})
        calls += 1
        body = json.loads(request.content.decode())
        assert body["channel"] == "web_voice"
        assert body["external_conversation_id"] == "voice-codex"
        return httpx.Response(
            200,
            json={
                "text": "Codexa question for the user.",
                "sessionId": "codexa-1",
                "requiresApproval": False,
            },
        )

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))
    execution = await execute_voice_runtime_actions(
        db=db,
        settings=settings,
        profile={},
        actions=[
            {
                "tool": "delegate_to_codex_orchestrator",
                "args": {"goal": "Build a settings page.", "mode": "plan_first", "reason": "task_intent"},
            }
        ],
        conversation_id="voice-codex",
        user_text="Build a settings page.",
        transcript=[{"role": "user", "content": "Build a settings page."}],
        bridge=bridge,
    )

    assert calls == 1
    assert execution.response_text == "Codexa question for the user; Builder has the Megaplan."
    assert execution.codex["codex_session_id"] == "codexa-1"
    assert execution.statuses[0]["status"] == "completed"


@pytest.mark.asyncio
async def test_twilio_agent_turn_delegates_directly_to_codex_without_voice_llm(tmp_path: Path, monkeypatch):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    agent = AgentService(db, settings, FailingLLM())
    requests: list[dict[str, Any]] = []

    async def fake_request(self, method, path, *, json=None, params=None):
        if path == "/agent/chat":
            requests.append(dict(json or {}))
            return {
                "text": "Codexa will plan the app. Reply approve to start.",
                "sessionId": "codexa-twilio",
                "projectId": "project-twilio",
                "requiresApproval": True,
                "approvalId": "approve_megaplan",
            }
        if path == "/codex/status":
            return {
                "session": {
                    "session_id": "codexa-twilio",
                    "project_id": "project-twilio",
                    "pending_action": {"type": "approve_megaplan"},
                }
            }
        return {"ok": True}

    monkeypatch.setattr(CodexOrchestratorBridge, "_request_json", fake_request)

    response = await agent.respond(
        "Build a full stack app for booking classes.",
        conversation_id="twilio-call-CA123",
        channel="twilio",
        caller="+14246993915",
    )

    assert response["message"] == "Codexa will plan the app; say approve to continue; Builder has the Megaplan."
    assert response["provider"] == "codex-orchestrator"
    assert response["codex"]["codex_session_id"] == "codexa-twilio"
    assert response["codex"]["codex_project_id"] == "project-twilio"
    assert response["codex"]["requires_approval"] is True
    assert response["runtime_action_status"][0]["status"] == "completed"
    assert requests[0]["channel"] == "web_voice"
    assert requests[0]["external_conversation_id"] == "twilio-call-CA123"
    assert requests[0]["text"] == "Build a full stack app for booking classes."

    row = db.one(
        """
        SELECT codex_session_id, codex_project_id, requires_approval, approval_id
        FROM codex_orchestrator_sessions
        WHERE conversation_id = ?
        """,
        ("twilio-call-CA123",),
    )
    assert row is not None
    assert row["codex_session_id"] == "codexa-twilio"
    assert row["codex_project_id"] == "project-twilio"
    assert row["requires_approval"] == 1
    assert row["approval_id"] == "approve_megaplan"

    turns = db.all(
        "SELECT role, content, model, metrics_json FROM turns WHERE conversation_id = ? ORDER BY rowid",
        ("twilio-call-CA123",),
    )
    assert [(turn["role"], turn["content"]) for turn in turns] == [
        ("user", "Build a full stack app for booking classes."),
        ("assistant", "Codexa will plan the app; say approve to continue; Builder has the Megaplan."),
    ]
    assistant_metrics = loads(turns[1]["metrics_json"], {})
    assert turns[1]["model"] == "codexa-http"
    assert assistant_metrics["source"] == "codex-orchestrator"
    assert assistant_metrics["codex"]["codex_session_id"] == "codexa-twilio"


@pytest.mark.asyncio
async def test_twilio_codex_detail_request_stays_short(tmp_path: Path, monkeypatch):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    agent = AgentService(db, settings, FailingLLM())

    async def fake_request(self, method, path, *, json=None, params=None):
        if path == "/agent/chat":
            return {
                "text": (
                    "Full plan: build the project, add backend endpoints, wire the UI, "
                    "run tests, and deploy the app. This should not be spoken in full."
                ),
                "sessionId": "codexa-twilio-detail",
                "projectId": "project-twilio-detail",
            }
        if path == "/codex/status":
            return {
                "session": {
                    "session_id": "codexa-twilio-detail",
                    "project_id": "project-twilio-detail",
                }
            }
        return {"ok": True}

    monkeypatch.setattr(CodexOrchestratorBridge, "_request_json", fake_request)

    response = await agent.respond(
        "Can you elaborate on the plan?",
        conversation_id="twilio-call-CADETAIL",
        channel="twilio",
        caller="+14246993915",
    )

    assert response["message"] == "Full plan: build the project, add backend endpoints, wire the UI, run tests, and deploy the app; Builder has the Megaplan."
    assert "This should not be spoken in full" not in response["message"]


@pytest.mark.asyncio
async def test_runtime_executor_rejects_stale_speed_action_on_codex_request(tmp_path: Path):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        if request.url.path == "/codex/status":
            return httpx.Response(200, json={"session": {"session_id": "codexa-1"}})
        calls += 1
        return httpx.Response(
            200,
            json={
                "text": "Codexa plan response.",
                "sessionId": "codexa-1",
                "requiresApproval": False,
            },
        )

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))
    execution = await execute_voice_runtime_actions(
        db=db,
        settings=settings,
        profile={"tts": {"speed": 1.1}},
        actions=[
            {
                "tool": "increment_tts_speed",
                "args": {"delta": -0.2, "reason": "stale_context"},
            },
            {
                "tool": "delegate_to_codex_orchestrator",
                "args": {"goal": "Plan a README update.", "mode": "plan_first", "reason": "task_intent"},
            },
        ],
        conversation_id="voice-codex",
        user_text="Plan a README update.",
        transcript=[{"role": "user", "content": "Plan a README update."}],
        bridge=bridge,
    )

    assert calls == 1
    assert execution.profile["tts"]["speed"] == 1.1
    assert execution.statuses[0]["tool"] == "increment_tts_speed"
    assert execution.statuses[0]["status"] == "rejected"
    assert execution.statuses[0]["error"] == "speed_action_without_speed_intent"
    assert execution.statuses[1]["tool"] == "delegate_to_codex_orchestrator"
    assert execution.statuses[1]["status"] == "completed"


@pytest.mark.asyncio
async def test_runtime_executor_preserves_exact_user_text_for_mapped_session(tmp_path: Path):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    _ensure_conversation(db)
    db.execute(
        """
        INSERT INTO codex_orchestrator_sessions(conversation_id, codex_session_id, last_status)
        VALUES (?, ?, 'completed')
        """,
        ("voice-codex", "codexa-1"),
    )
    sent_texts: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/codex/status":
            return httpx.Response(200, json={"session": {"session_id": "codexa-1"}})
        body = json.loads(request.content.decode())
        sent_texts.append(body["text"])
        assert body["session_id"] == "codexa-1"
        return httpx.Response(200, json={"text": "Follow-up accepted.", "sessionId": "codexa-1"})

    bridge = CodexOrchestratorBridge(db, settings, transport=httpx.MockTransport(handler))
    await execute_voice_runtime_actions(
        db=db,
        settings=settings,
        profile={},
        actions=[
            {
                "tool": "delegate_to_codex_orchestrator",
                "args": {"goal": "paraphrased model argument", "mode": "plan_first"},
            }
        ],
        conversation_id="voice-codex",
        user_text="Use this exact answer, please.",
        transcript=[{"role": "user", "content": "Use this exact answer, please."}],
        bridge=bridge,
    )

    assert sent_texts == ["Use this exact answer, please."]


@pytest.mark.asyncio
async def test_voice_text_codex_plan_first_conversation_and_approval(tmp_path: Path, monkeypatch):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    prompt_repo = PromptRepository(db)
    llm = MockLLMClient(settings)
    agent = AgentService(db, settings, llm)
    flow_repo = FlowRepository(db)
    flow_runtime = FlowRuntime(db, flow_repo, llm, settings)
    calls: list[dict[str, Any]] = []

    async def fake_request(self, method, path, *, json=None, params=None):
        if path == "/agent/chat":
            calls.append(dict(json or {}))
            if len(calls) == 1:
                return {"text": "Which repo should I plan against?", "sessionId": "codexa-1"}
            if len(calls) == 2:
                return {
                    "text": "Final plan: add tests, wire the feature, and verify. Reply approve to start.",
                    "sessionId": "codexa-1",
                    "projectId": "project-1",
                    "requiresApproval": True,
                    "approvalId": "approval-1",
                }
            return {
                "text": "Approved. I sent Codex back to continue.",
                "sessionId": "codexa-1",
                "projectId": "project-1",
            }
        return {"ok": True}

    monkeypatch.setattr(CodexOrchestratorBridge, "_request_json", fake_request)

    first = await run_voice_text_turn(
        message="Build a test feature for the app.",
        conversation_id="voice-codex",
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        agent=agent,
        flow_runtime=flow_runtime,
        voice_behavior_mode="assistant",
    )
    second = await run_voice_text_turn(
        message="Use this repo.",
        conversation_id="voice-codex",
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        agent=agent,
        flow_runtime=flow_runtime,
        voice_behavior_mode="assistant",
    )
    third = await run_voice_text_turn(
        message="approve",
        conversation_id="voice-codex",
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        agent=agent,
        flow_runtime=flow_runtime,
        voice_behavior_mode="assistant",
    )

    assert first["message"] == "Which repo should I plan against?"
    assert second["codex"]["requires_approval"] is True
    assert second["codex"]["approval_id"] == "approval-1"
    assert second["providers"]["codex_session_id"] == "codexa-1"
    assert second["providers"]["codex_project_id"] == "project-1"
    assert second["providers"]["requires_approval"] is True
    assert second["providers"]["approval_id"] == "approval-1"
    assert second["providers"]["runtime_action_source"] == "codex-orchestrator"
    assert third["message"].startswith("Approved.")
    assert third["providers"]["codex_session_id"] == "codexa-1"
    assert calls[0]["channel"] == "web_voice"
    assert calls[0]["text"] == "Build a test feature for the app."
    assert calls[1]["session_id"] == "codexa-1"
    assert calls[1]["text"] == "Use this repo."
    assert calls[2]["text"] == "approve"


@pytest.mark.asyncio
async def test_flow_codex_task_uses_bridge_when_enabled(tmp_path: Path, monkeypatch):
    settings = _settings(tmp_path)
    db = Database(settings.database_path)
    repo = FlowRepository(db)
    llm = MockLLMClient(settings)
    runtime = FlowRuntime(db, repo, llm, settings)
    flow = repo.create("Codex task flow")
    graph = {
        "nodes": [
            {"id": "start", "type": "custom", "data": {"nodeType": "start", "label": "Start"}},
            {
                "id": "codex",
                "type": "custom",
                "data": {
                    "nodeType": "codex_task",
                    "label": "Codex",
                    "script": "Plan the requested implementation.",
                    "integration": {"orchestrator": "agent"},
                },
            },
        ],
        "edges": [{"id": "start-codex", "source": "start", "target": "codex"}],
        "metadata": {"schemaVersion": 4},
    }
    repo.update(flow.id, flow.name, flow.description, graph)

    async def fake_request(self, method, path, *, json=None, params=None):
        return {"text": "Codexa plan question.", "sessionId": "codexa-flow"}

    monkeypatch.setattr(CodexOrchestratorBridge, "_request_json", fake_request)

    result = await runtime.handle_message(
        flow_id=flow.id,
        message="start",
        conversation_id="flow-conversation",
    )

    assert result["messages"][-1]["text"] == "Codexa plan question; Builder has the Megaplan."
    event = db.one(
        """
        SELECT payload_json
        FROM flow_events
        WHERE run_id = ? AND event = 'agent_job_created'
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (result["run_id"],),
    )
    assert event is not None
    payload = loads(event["payload_json"], {})
    assert payload["simulated"] is False
    assert payload["codex_session_id"] == "codexa-flow"


@pytest.mark.asyncio
async def test_flow_codex_task_keeps_simulated_fallback_when_disabled(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="mock",
        codex_orchestrator_enabled=False,
    )
    db = Database(settings.database_path)
    repo = FlowRepository(db)
    llm = MockLLMClient(settings)
    runtime = FlowRuntime(db, repo, llm, settings)
    flow = repo.create("Fallback Codex task flow")
    graph = {
        "nodes": [
            {"id": "start", "type": "custom", "data": {"nodeType": "start", "label": "Start"}},
            {
                "id": "codex",
                "type": "custom",
                "data": {
                    "nodeType": "codex_task",
                    "label": "Codex",
                    "script": "Plan the requested implementation.",
                    "integration": {"orchestrator": "agent"},
                },
            },
        ],
        "edges": [{"id": "start-codex", "source": "start", "target": "codex"}],
        "metadata": {"schemaVersion": 4},
    }
    repo.update(flow.id, flow.name, flow.description, graph)

    result = await runtime.handle_message(
        flow_id=flow.id,
        message="start",
        conversation_id="flow-conversation",
    )

    assert result["messages"][-1]["text"] == "Plan the requested implementation."
    event = db.one(
        """
        SELECT payload_json
        FROM flow_events
        WHERE run_id = ? AND event = 'agent_job_created'
        ORDER BY created_at DESC
        LIMIT 1
        """,
        (result["run_id"],),
    )
    assert event is not None
    payload = loads(event["payload_json"], {})
    assert payload["simulated"] is True
