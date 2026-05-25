from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from app.agent import AgentService
from app.config import Settings
from app.cost_guard import CostGuard, CostLimitExceeded
from app.db import Database
from app.eval_scheduler import EvalScheduler
from app.evaluator import EvalRunner
from app.feedback import FeedbackLearner, PromptRepository
from app.llm import MockLLMClient
from app.local_voice_runtime import (
    LocalVoiceConversationRecorder,
    build_system_instruction,
    require_openai_compatible_llm,
)

BACKEND_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def runtime(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    repo = PromptRepository(db)
    learner = FeedbackLearner(db, repo, settings.latency_target_ms)
    agent = AgentService(db, settings, MockLLMClient(settings))
    return settings, db, repo, learner, agent


@pytest.mark.asyncio
async def test_chat_turn_is_logged(runtime):
    _settings, _db, _repo, _learner, agent = runtime
    response = await agent.respond("Hello", channel="test")

    assert response["message"]
    assert response["conversation_id"]
    transcript = agent.transcript(response["conversation_id"])
    assert [turn["role"] for turn in transcript] == ["user", "assistant"]


def test_feedback_rebuilds_active_prompt(runtime):
    _settings, db, repo, learner, agent = runtime
    conversation_id = agent.ensure_conversation(None, "test")
    db.execute(
        """
        INSERT INTO feedback(id, conversation_id, rating, label, notes)
        VALUES ('feedback-1', ?, 2, 'incorrect', 'Guessed instead of asking.')
        """,
        (conversation_id,),
    )

    before = repo.active().version
    after = learner.rebuild()

    assert after.version > before
    assert "clarifying question" in after.learned_hints


def test_cost_guard_blocks_when_local_cap_would_be_exceeded(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        cost_guard_cap_usd=0.01,
        cost_guard_reserve_usd_per_call=0.02,
    )
    guard = CostGuard(Database(settings.database_path), settings)

    with pytest.raises(CostLimitExceeded):
        guard.reserve(0.02, source="llm_call", provider="nvidia", model="test-model")


def test_cost_guard_records_actual_estimated_spend(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), cost_guard_cap_usd=1)
    guard = CostGuard(Database(settings.database_path), settings)

    event_id = guard.reserve(0.01, source="llm_call", provider="nvidia", model="test-model")
    guard.finalize(event_id, 0.005, units={"total_tokens": 100})

    snapshot = guard.snapshot()
    assert snapshot.actual_usd == 0.005
    assert snapshot.reserved_usd == 0
    assert snapshot.remaining_usd == 0.995


def test_local_voice_requires_real_llm_provider(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")

    with pytest.raises(RuntimeError, match="LLM_PROVIDER=ollama"):
        require_openai_compatible_llm(settings)


def test_local_voice_records_turns_in_feedback_database(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="ollama",
        ollama_model="qwen2.5:0.5b",
    )
    db = Database(settings.database_path)
    repo = PromptRepository(db)
    recorder = LocalVoiceConversationRecorder(db, settings, repo.active().version)

    recorder.start()
    recorder.record_turn("user", "hello from microphone", metrics={"source": "test"})
    assistant_turn_id = recorder.record_turn("assistant", "hello back", latency_ms=123)

    rows = db.all(
        "SELECT role, content, latency_ms, model FROM turns WHERE conversation_id = ? ORDER BY rowid",
        (recorder.conversation_id,),
    )

    assert [row["role"] for row in rows] == ["user", "assistant"]
    assert rows[0]["content"] == "hello from microphone"
    assert rows[1]["latency_ms"] == 123
    assert rows[1]["model"] == "qwen2.5:0.5b"
    assert assistant_turn_id


def test_local_voice_system_instruction_respects_no_think(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="ollama",
        reasoning_mode="off",
    )
    repo = PromptRepository(Database(settings.database_path))

    assert build_system_instruction(settings, repo).startswith("/no_think\n")


@pytest.mark.asyncio
async def test_eval_suite_records_results(runtime):
    _settings, db, repo, learner, agent = runtime
    runner = EvalRunner(db, agent, learner)
    suite = Path(os.environ.get("EVAL_SUITE", str(BACKEND_ROOT / "evals/customer_intake.yml")))

    result = await runner.run_suite(suite, apply_feedback=True)

    assert result["status"] == "passed"
    assert result["aggregate_score"] == 1.0
    assert repo.active().version == result["prompt_version"]


@pytest.mark.asyncio
async def test_eval_scheduler_run_once_records_status(runtime):
    _settings, db, _repo, learner, agent = runtime
    runner = EvalRunner(db, agent, learner)
    scheduler = EvalScheduler(
        runner,
        lambda path: Path(path) if Path(path).is_absolute() else BACKEND_ROOT / path,
        "evals/customer_intake.yml",
        interval_seconds=60,
        apply_feedback=True,
    )

    result = await scheduler.run_once()

    assert result["status"] == "passed"
    status = scheduler.status()
    assert status["run_count"] == 1
    assert status["last_run"]["status"] == "passed"


@pytest.mark.asyncio
async def test_eval_scheduler_keeps_running_after_eval_error():
    class BrokenRunner:
        async def run_suite(self, *_args, **_kwargs):
            raise RuntimeError("temporary eval failure")

    scheduler = EvalScheduler(
        BrokenRunner(),  # type: ignore[arg-type]
        lambda path: Path(path),
        "missing.yml",
        interval_seconds=60,
        apply_feedback=True,
    )

    await scheduler.start()
    await asyncio.sleep(0)
    status = scheduler.status()
    await scheduler.stop()

    assert status["running"] is True
    assert status["last_error"] == "RuntimeError: temporary eval failure"
