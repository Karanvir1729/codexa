from __future__ import annotations

from pathlib import Path

import pytest

from app.agent import AgentService
from app.config import Settings
from app.db import Database, loads
from app.feedback import PromptRepository
from app.flow_runtime import FlowRepository, FlowRuntime
from app.llm import MockLLMClient
from app.main import VoiceTextTurnRequest
from app.voice_text_test import build_voice_text_tts_payload, run_voice_text_suite, run_voice_text_turn


class FailingRuntimeLLM:
    async def generate(self, messages, system_prompt):
        raise TimeoutError("runtime command timed out")

    async def warmup(self) -> None:
        return None


@pytest.fixture()
def voice_text_runtime(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="mock",
        local_tts_provider="supertonic",
        voice_speech_path="supertone_parakeet",
    )
    db = Database(settings.database_path)
    prompt_repo = PromptRepository(db)
    llm = MockLLMClient(settings)
    agent = AgentService(db, settings, llm)
    flow_repo = FlowRepository(db)
    flow_runtime = FlowRuntime(db, flow_repo, llm)
    return settings, db, prompt_repo, agent, flow_runtime


def test_voice_text_tts_payload_renders_supertonic_wav():
    settings = Settings(
        local_tts_provider="supertonic",
        supertonic_voice="M1",
        supertonic_language="na",
        supertonic_speed=1.05,
        supertonic_steps=8,
        supertonic_response_format="ogg",
    )
    profile = {
        "tts": {
            "speed": 3,
            "steps": 0,
            "expression_mode": "subtle",
            "allowed_expression_tags": ["breath"],
            "max_expression_tags_per_utterance": 1,
        }
    }

    payload, rendered = build_voice_text_tts_payload(
        settings,
        profile,
        "Sure, I can test the spoken response now.",
        user_text="Please test TTS.",
    )

    assert payload["response_format"] == "wav"
    assert payload["speed"] == 2.0
    assert payload["steps"] == 1
    assert payload["voice"] == "M1"
    assert payload["lang"] == "na"
    assert "<breath>" in payload["text"]
    assert rendered["expression_tags_used"] == ["breath"]


def test_voice_text_turn_request_accepts_readme_text_field():
    payload = VoiceTextTurnRequest.model_validate(
        {
            "text": "Hello, can you confirm the voice coding agent is ready?",
            "voice_speech_path": "supertone_parakeet",
        }
    )

    assert payload.message == "Hello, can you confirm the voice coding agent is ready?"


@pytest.mark.asyncio
async def test_voice_text_turn_assumes_stt_and_records_voice_artifacts(voice_text_runtime):
    settings, db, prompt_repo, agent, flow_runtime = voice_text_runtime

    result = await run_voice_text_turn(
        message="Can you talk faster?",
        conversation_id=None,
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        agent=agent,
        flow_runtime=flow_runtime,
        voice_behavior_mode="assistant",
        voice_flow_id="active",
        input_mode="push_to_talk",
    )

    assert result["input"]["assumed_stt"] is True
    assert result["tts"]["simulated"] is True
    assert "faster" in result["message"].casefold()
    assert result["runtime_action_status"][0]["status"] == "completed"
    assert result["runtime_action_status"][0]["field"] == "tts.speed"
    assert result["latency_trace_id"]
    assert "user_transcribed" in result["events_recorded"]
    assert "tts_simulated" in result["events_recorded"]
    assert "interaction_completed" in result["events_recorded"]

    turns = db.all(
        "SELECT role, content, metrics_json FROM turns WHERE conversation_id = ? ORDER BY rowid",
        (result["conversation_id"],),
    )
    assert [(row["role"], row["content"]) for row in turns] == [
        ("user", "Can you talk faster?"),
        ("assistant", result["message"]),
    ]
    user_metrics = loads(turns[0]["metrics_json"], {})
    assistant_metrics = loads(turns[1]["metrics_json"], {})
    assert user_metrics["source"] == "text_assumed_stt"
    assert user_metrics["assumed_stt"] is True
    assert assistant_metrics["source"] == "voice_text_test"
    assert assistant_metrics["tts_simulated"] is True

    trace = db.one(
        "SELECT providers_json, timings_json FROM latency_traces WHERE id = ?",
        (result["latency_trace_id"],),
    )
    assert trace is not None
    assert loads(trace["providers_json"], {})["stt_provider"] == "assumed_text"
    assert loads(trace["timings_json"], {})["assumed_stt"] is True


@pytest.mark.asyncio
async def test_voice_text_turn_runtime_speed_raises_on_llm_timeout(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="mock",
        local_tts_provider="supertonic",
        voice_speech_path="supertone_parakeet",
    )
    db = Database(settings.database_path)
    prompt_repo = PromptRepository(db)
    agent = AgentService(db, settings, FailingRuntimeLLM())
    flow_repo = FlowRepository(db)
    flow_runtime = FlowRuntime(db, flow_repo, MockLLMClient(settings))

    with pytest.raises(RuntimeError, match="Voice runtime LLM request failed"):
        await run_voice_text_turn(
            message="talk slow please",
            conversation_id=None,
            settings=settings,
            db=db,
            prompt_repo=prompt_repo,
            agent=agent,
            flow_runtime=flow_runtime,
            voice_behavior_mode="assistant",
            voice_flow_id="active",
            input_mode="push_to_talk",
        )


@pytest.mark.asyncio
async def test_voice_text_turn_uses_flow_runtime_and_persists_transcript(voice_text_runtime):
    settings, db, prompt_repo, agent, flow_runtime = voice_text_runtime

    result = await run_voice_text_turn(
        message="Tell me a spooky story in four sentences.",
        conversation_id="text-flow-conversation",
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        agent=agent,
        flow_runtime=flow_runtime,
        voice_behavior_mode="flow",
        voice_flow_id="active",
        input_mode="push_to_talk",
    )

    assert result["mode"] == "flow"
    assert result["flow"]["active_node_id"] == "long_form_response"
    assert result["flow"]["run_id"]
    assert "clock" in result["message"].casefold()

    latest = flow_runtime.latest_run_for_conversation(result["conversation_id"])
    assert latest is not None
    assert latest["run_id"] == result["flow"]["run_id"]
    assert latest["active_node_id"] == "long_form_response"

    assistant = db.one(
        """
        SELECT metrics_json
        FROM turns
        WHERE conversation_id = ? AND role = 'assistant'
        ORDER BY rowid DESC
        LIMIT 1
        """,
        (result["conversation_id"],),
    )
    assert assistant is not None
    metrics = loads(assistant["metrics_json"], {})
    assert metrics["voice_behavior_mode"] == "flow"
    assert metrics["voice_flow_run_id"] == result["flow"]["run_id"]


@pytest.mark.asyncio
async def test_voice_text_suite_covers_assistant_runtime_and_flow(voice_text_runtime):
    settings, db, prompt_repo, agent, flow_runtime = voice_text_runtime

    result = await run_voice_text_suite(
        conversation_id=None,
        settings=settings,
        db=db,
        prompt_repo=prompt_repo,
        agent=agent,
        flow_runtime=flow_runtime,
        input_mode="push_to_talk",
    )

    assert result["status"] == "passed"
    assert result["summary"] == {"passed": 4, "failed": 0, "total": 4}
    cases = {case["id"]: case for case in result["cases"]}
    assert cases["assistant_runtime_speed"]["turn"]["runtime_action_status"]
    assert cases["flow_long_form"]["turn"]["flow"]["active_node_id"] == "long_form_response"
    assert cases["flow_interrupt"]["turn"]["flow"]["active_node_id"] == "clarify_request"
    assert all(check["passed"] for case in result["cases"] for check in case["checks"])
