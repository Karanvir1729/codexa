from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.agent import AgentService
from app.config import Settings
from app.cost_guard import CostGuard, CostLimitExceeded
from app.db import Database
from app.evaluator import EvalRunner
from app.feedback import FeedbackLearner, PromptRepository
from app.llm import MockLLMClient


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


@pytest.mark.asyncio
async def test_eval_suite_records_results(runtime):
    _settings, db, repo, learner, agent = runtime
    runner = EvalRunner(db, agent, learner)
    suite = Path(os.environ.get("EVAL_SUITE", "evals/customer_intake.yml"))

    result = await runner.run_suite(suite, apply_feedback=True)

    assert result["status"] == "passed"
    assert result["aggregate_score"] == 1.0
    assert repo.active().version == result["prompt_version"]
