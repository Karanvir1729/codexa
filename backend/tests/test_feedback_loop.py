from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from app.agent import AgentService, build_runtime_system_prompt, fast_policy_response
from app.config import Settings
from app.cost_guard import CostGuard, CostLimitExceeded
from app.db import Database
from app.eval_scheduler import EvalScheduler
from app.evaluator import EvalRunner
from app.feedback import FeedbackLearner, PromptRepository
from app.flow_runtime import FlowRepository, FlowRuntime, validate_flow_graph
from app.llm import LLMResult, MockLLMClient
from app.local_voice_runtime import (
    LocalVoiceConversationRecorder,
    build_system_instruction,
    create_local_stt_service,
    merge_adjacent_chat_messages,
    require_openai_compatible_llm,
    resolve_stt_language,
    resolve_tts_language,
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


def test_local_voice_uses_auto_detect_stt_and_explicit_tts_language():
    settings = Settings(local_stt_language="auto", local_tts_language="en")

    assert resolve_stt_language(settings) is None
    assert str(resolve_tts_language(settings)) == "en"


def test_local_voice_defaults_to_self_hosted_multilingual_whisper_and_fast_turn_timing():
    settings = Settings()

    assert settings.local_stt_provider == "remote_whisper"
    assert settings.local_stt_model == "large-v3-turbo"
    assert settings.local_stt_language == "auto"
    assert settings.local_stt_no_speech_prob <= 0.25
    assert settings.max_completion_tokens >= 180
    assert settings.local_vad_start_secs <= 0.05
    assert settings.local_vad_stop_secs <= 0.12
    assert settings.local_user_speech_timeout <= 0.12


def test_remote_whisper_does_not_send_default_prompt_or_hotwords():
    settings = Settings(
        local_stt_provider="remote_whisper",
        remote_whisper_initial_prompt="",
        remote_whisper_hotwords="",
    )

    provider, stt = create_local_stt_service(settings)

    assert provider == "remote_whisper"
    assert not stt.options.initial_prompt
    assert not stt.options.hotwords


def test_local_voice_merges_adjacent_turns_for_vllm_chat_template():
    messages = [
        {"role": "user", "content": "Hello."},
        {"role": "user", "content": "Are you there?"},
        {"role": "assistant", "content": "Yes."},
        {"role": "assistant", "content": "How can I help?"},
        {"role": "user", "content": "I need help with my account."},
    ]

    assert merge_adjacent_chat_messages(messages) == [
        {"role": "user", "content": "Hello.\nAre you there?"},
        {"role": "assistant", "content": "Yes.\nHow can I help?"},
        {"role": "user", "content": "I need help with my account."},
    ]


def test_runtime_prompt_adds_conversational_voice_contract():
    prompt = build_runtime_system_prompt("Base prompt.")

    assert "PipeCAD's voice assistant" in prompt
    assert "latency" in prompt
    assert "story" in prompt
    assert "one short sentence" not in prompt
    assert "human agent" not in prompt
    assert "order ID" not in prompt
    assert "account email" not in prompt


def test_fast_policy_response_handles_name_without_customer_service_hijacks():
    assert fast_policy_response("What's your name?") == "I'm PipeCAD's voice assistant."
    assert fast_policy_response("Hello? Are you there?") == "I'm here; how can I help?"
    assert fast_policy_response("I need help with my account.") is None
    assert fast_policy_response("Can I talk to a human agent?") is None


def test_fast_policy_response_handles_voice_speed_and_oneplus_ambiguity():
    assert fast_policy_response("Can you talk a bit faster?") == "Sure, I'll talk faster."
    assert fast_policy_response("Talk very fast.") == "Got it, I'll talk very fast."
    assert fast_policy_response("Please slow down your voice.") == "Sure, I'll slow down."
    assert fast_policy_response("What's OnePlus One?") == (
        "Do you mean the OnePlus phone or one plus one?"
    )
    assert fast_policy_response("What's one plus one?") == "It's 2."


def test_fast_policy_does_not_block_long_form_requests():
    assert fast_policy_response("Tell me a story in a spooky tone.") is None
    assert fast_policy_response("Explain that in more detail.") is None


@pytest.mark.asyncio
async def test_agent_fast_policy_still_handles_identity_without_llm(tmp_path: Path):
    class CapturingLLM:
        called = False

        async def generate(self, _messages, _system_prompt: str) -> LLMResult:
            self.called = True
            return LLMResult(
                text="This should not be called.",
                latency_ms=999,
                model="bad",
                provider="mock",
                raw={},
            )

        async def warmup(self) -> None:
            return None

    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    llm = CapturingLLM()
    agent = AgentService(Database(settings.database_path), settings, llm)

    response = await agent.respond("What's your name?", channel="test")

    assert response["message"] == "I'm PipeCAD's voice assistant."
    assert response["provider"] == "policy-rule"
    assert llm.called is False


@pytest.mark.asyncio
async def test_agent_uses_compiled_prompt_with_learned_hints(tmp_path: Path):
    class CapturingLLM:
        system_prompt = ""

        async def generate(self, _messages, system_prompt: str) -> LLMResult:
            self.system_prompt = system_prompt
            return LLMResult(
                text="I can help with that.",
                latency_ms=1,
                model="capture",
                provider="mock",
                raw={},
            )

        async def warmup(self) -> None:
            return None

    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    repo = PromptRepository(db)
    repo.create("Base prompt.", "- Learned hint from eval.", "test")
    llm = CapturingLLM()
    agent = AgentService(db, settings, llm)

    await agent.respond("I have a billing question.", channel="test")

    assert "Learned hint from eval" in llm.system_prompt


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


def test_local_voice_recorder_deduplicates_repeated_final_transcripts(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="ollama",
        ollama_model="qwen2.5:0.5b",
    )
    db = Database(settings.database_path)
    repo = PromptRepository(db)
    recorder = LocalVoiceConversationRecorder(db, settings, repo.active().version)

    recorder.start()
    first_turn_id = recorder.record_turn("user", "Hello.", metrics={"source": "test"})
    second_turn_id = recorder.record_turn("user", " hello. ", metrics={"source": "test"})

    rows = db.all(
        "SELECT role, content FROM turns WHERE conversation_id = ? ORDER BY rowid",
        (recorder.conversation_id,),
    )

    assert first_turn_id
    assert second_turn_id == ""
    assert [(row["role"], row["content"]) for row in rows] == [("user", "Hello.")]


def test_local_voice_recorder_persists_latency_trace(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="ollama",
        ollama_model="qwen2.5:0.5b",
    )
    db = Database(settings.database_path)
    repo = PromptRepository(db)
    recorder = LocalVoiceConversationRecorder(db, settings, repo.active().version)

    recorder.start()
    user_turn_id = recorder.record_turn(
        "user",
        "hello",
        metrics={"interaction_id": "interaction-1"},
    )
    assistant_turn_id = recorder.record_turn(
        "assistant",
        "hi",
        latency_ms=321,
        metrics={"interaction_id": "interaction-1"},
    )
    trace_id = recorder.record_latency_trace(
        interaction_id="interaction-1",
        user_turn_id=user_turn_id,
        assistant_turn_id=assistant_turn_id,
        providers={"stt_provider": "remote_whisper"},
        timings={"speech_end_to_first_audio_ms": 321},
    )

    row = db.one("SELECT * FROM latency_traces WHERE id = ?", (trace_id,))

    assert row is not None
    assert row["conversation_id"] == recorder.conversation_id
    assert row["interaction_id"] == "interaction-1"
    assert '"remote_whisper"' in row["providers_json"]
    assert '"speech_end_to_first_audio_ms":321' in row["timings_json"]


def test_local_voice_recorder_persists_interaction_events(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="ollama",
        ollama_model="qwen2.5:0.5b",
    )
    db = Database(settings.database_path)
    repo = PromptRepository(db)
    recorder = LocalVoiceConversationRecorder(db, settings, repo.active().version)

    recorder.start()
    event_id = recorder.record_interaction_event(
        interaction_id="interaction-2",
        event="user_transcribed",
        role="user",
        text="hello",
        payload={"timings": {"stt_provider_elapsed_ms": 123}},
    )

    row = db.one("SELECT * FROM interaction_events WHERE id = ?", (event_id,))

    assert row is not None
    assert row["conversation_id"] == recorder.conversation_id
    assert row["interaction_id"] == "interaction-2"
    assert row["event"] == "user_transcribed"
    assert row["role"] == "user"
    assert row["text"] == "hello"
    assert '"stt_provider_elapsed_ms":123' in row["payload_json"]


def test_local_voice_system_instruction_respects_no_think(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="ollama",
        reasoning_mode="off",
    )
    repo = PromptRepository(Database(settings.database_path))

    instruction = build_system_instruction(settings, repo)

    assert instruction.startswith("/no_think\n")
    assert "several sentences" in instruction
    assert "under 18 words" not in instruction
    assert "under 12 words" not in instruction
    assert "runtime telemetry" in instruction


def test_default_flow_bootstraps_with_interruptible_codex_path(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    repo = FlowRepository(Database(settings.database_path))

    flow = repo.active()
    validation = validate_flow_graph(flow.graph)
    node_types = {node["data"]["nodeType"] for node in flow.graph["nodes"]}

    assert flow.status == "published"
    assert validation["ok"] is True
    assert {
        "start",
        "dialogue",
        "collect",
        "confirm",
        "condition",
        "codex_task",
        "wait",
        "fallback",
        "transfer_call",
    } <= node_types


@pytest.mark.asyncio
async def test_flow_runtime_routes_code_request_through_codex_guardrail(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    repo = FlowRepository(db)
    runtime = FlowRuntime(db, repo, MockLLMClient(settings))
    flow = repo.active()

    started = await runtime.handle_message(flow_id=flow.id, message=None)
    routed = await runtime.handle_message(
        flow_id=flow.id,
        run_id=started["run_id"],
        message="I need Codex to inspect this repo and fix the failing tests.",
    )
    approved = await runtime.handle_message(
        flow_id=flow.id,
        run_id=started["run_id"],
        message="yes proceed",
    )

    assert started["active_node_id"] == "collect_task_details"
    assert any("Codex Orchestrator" in message["text"] for message in started["messages"])
    assert routed["active_node_id"] == "confirm_task"
    assert routed["slots"]["task_description"] == (
        "I need Codex to inspect this repo and fix the failing tests."
    )
    assert approved["active_node_id"] == "monitor_progress"
    assert any("Codex Orchestrator" in message["text"] for message in approved["messages"])


@pytest.mark.asyncio
async def test_flow_runtime_interrupt_routes_to_cancel(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    repo = FlowRepository(db)
    runtime = FlowRuntime(db, repo, MockLLMClient(settings))
    flow = repo.active()

    started = await runtime.handle_message(flow_id=flow.id, message=None)
    interrupted = await runtime.handle_message(
        flow_id=flow.id,
        run_id=started["run_id"],
        message="stop, actually cancel that",
        force_interrupt=True,
    )

    assert interrupted["active_node_id"] == "clarify_requirements"
    assert any("make sure I get this right" in message["text"] for message in interrupted["messages"])


@pytest.mark.asyncio
async def test_eval_suite_records_results(runtime):
    _settings, db, repo, learner, agent = runtime
    runner = EvalRunner(db, agent, learner)
    suite = Path(os.environ.get("EVAL_SUITE", str(BACKEND_ROOT / "evals/conversational_voice.yml")))

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
        "evals/conversational_voice.yml",
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
