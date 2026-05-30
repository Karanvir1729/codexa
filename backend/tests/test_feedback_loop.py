from __future__ import annotations

from pathlib import Path

import pytest

from app.agent import AgentService, fast_policy_response
from app.config import Settings, mainstream_voice_path_errors, settings_for_speech_path
from app.cost_guard import CostGuard, CostLimitExceeded
from app.db import Database, loads
from app.feedback import FeedbackLearner, PromptRepository
from app.llm import MockLLMClient
from app.local_voice_runtime import (
    LocalVoiceConversationRecorder,
    _empty_live_voice_response,
    build_system_instruction,
    merge_adjacent_chat_messages,
    openai_compatible_client_api_key,
    require_openai_compatible_llm,
    rtvi_user_speaking_message,
)
from app.voice_runtime_controls import voice_speed_intent
from app.voice_self_observe import (
    apply_runtime_adaptation,
    build_learning_record,
    choose_model_profile,
    classify_voice_turn,
    clamp_gradium_tts_params,
    default_runtime_profile,
    execute_runtime_actions,
    fallback_runtime_command_for_request,
    is_runtime_control_request,
    model_for_profile,
    parse_voice_runtime_command,
    render_expression_tags,
    runtime_command_context,
)


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


def test_cost_guard_blocks_when_cap_would_be_exceeded(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), cost_guard_cap_usd=0.01)
    db = Database(settings.database_path)
    guard = CostGuard(db, settings)

    guard.reserve(0.01, source="llm_call", provider="nemotron", model="test-model")

    with pytest.raises(CostLimitExceeded):
        guard.reserve(0.02, source="llm_call", provider="nemotron", model="test-model")


def test_cost_guard_estimates_nemotron_usage(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        cost_guard_nemotron_call_usd=0.01,
        cost_guard_nemotron_input_per_1m_tokens_usd=1.0,
        cost_guard_nemotron_output_per_1m_tokens_usd=2.0,
    )
    db = Database(settings.database_path)
    guard = CostGuard(db, settings)

    estimate = guard.estimate_llm_call(
        "nemotron",
        {"usage": {"prompt_tokens": 1000, "completion_tokens": 2000}},
    )

    assert estimate == 0.01
    assert guard.reserve_amount_for_provider("nemotron") == 0.01


def test_voice_path_requires_nvidia_gradium_stack():
    settings = Settings(
        voice_runtime="local_pipecat",
        llm_provider="nemotron",
        local_stt_provider="nvidia_ws",
        local_tts_provider="gradium",
        gradium_api_key="test",
        codex_orchestrator_enabled=True,
    )

    assert mainstream_voice_path_errors(settings) == []


def test_voice_path_rejects_non_demo_defaults():
    settings = Settings(voice_runtime="text", gradium_api_key=None)

    errors = mainstream_voice_path_errors(settings)

    assert any("VOICE_RUNTIME must be local_pipecat" in error for error in errors)
    assert any("GRADIUM_API_KEY" in error for error in errors)


def test_legacy_speech_path_env_maps_to_nvidia_gradium():
    settings = Settings(
        voice_speech_path="stale_path",
        llm_provider="mock",
        local_stt_provider="stale_stt",
        local_tts_provider="stale_tts",
    )
    selected = settings_for_speech_path(settings, "stale_path")

    assert settings.voice_speech_path == "nvidia_gradium"
    assert selected.voice_speech_path == "nvidia_gradium"
    assert selected.llm_provider == "nemotron"
    assert selected.local_stt_provider == "nvidia_ws"
    assert selected.local_tts_provider == "gradium"


def test_local_voice_requires_openai_compatible_base_url(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), nemotron_llm_url="")

    with pytest.raises(RuntimeError, match="base URL"):
        require_openai_compatible_llm(settings)


def test_local_voice_accepts_unauthenticated_nemotron():
    settings = Settings(llm_provider="nemotron", nemotron_llm_api_key=None)

    require_openai_compatible_llm(settings)
    assert openai_compatible_client_api_key(settings) == "unused"


def test_local_voice_recorder_metadata_uses_nvidia_gradium(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="nemotron",
        voice_speech_path="nvidia_gradium",
        local_stt_provider="nvidia_ws",
        local_tts_provider="gradium",
    )
    db = Database(settings.database_path)
    recorder = LocalVoiceConversationRecorder(db, settings, prompt_version=1)
    recorder.start()

    row = db.one("SELECT metadata_json FROM conversations WHERE id = ?", (recorder.conversation_id,))
    metadata = loads(row["metadata_json"], {})

    assert metadata["llm_provider"] == "nemotron"
    assert metadata["stt_provider"] == "nvidia_ws"
    assert metadata["tts_provider"] == "gradium"
    assert metadata["voice_speech_path"] == "nvidia_gradium"
    assert metadata["nvidia_asr_url"] == settings.nvidia_asr_url
    assert metadata["gradium_tts_voice_id"] == settings.gradium_tts_voice_id


def test_vad_events_are_encoded_as_rtvi_speaking_messages():
    assert rtvi_user_speaking_message(True) == {
        "label": "rtvi-ai",
        "type": "user-started-speaking",
    }
    assert rtvi_user_speaking_message(False) == {
        "label": "rtvi-ai",
        "type": "user-stopped-speaking",
    }


def test_runtime_profile_defaults_to_gradium():
    settings = Settings()
    profile = default_runtime_profile(settings)

    assert profile["tts"]["provider"] == "gradium"
    assert profile["tts"]["voice_id"] == settings.gradium_tts_voice_id
    assert profile["tts"]["max_expression_tags_per_utterance"] == 0
    assert profile["debug"]["last_tts_payload"] is None


def test_gradium_tts_parameter_clamp():
    clamped_high = clamp_gradium_tts_params({"speed": 3.0, "output_format": "bad"})
    clamped_low = clamp_gradium_tts_params({"speed": 0.2})

    assert clamped_high["provider"] == "gradium"
    assert clamped_high["speed"] == 2.0
    assert clamped_high["output_format"] == "pcm_24000"
    assert clamped_low["speed"] == 0.5
    assert clamped_low["max_expression_tags_per_utterance"] == 0


def test_runtime_speed_action_updates_gradium_profile():
    settings = Settings(gradium_tts_speed=1.0)
    profile = default_runtime_profile(settings)

    updated, statuses = execute_runtime_actions(
        profile,
        [{"tool": "increment_tts_speed", "args": {"delta": 0.25, "reason": "test"}}],
        settings,
    )

    assert statuses[0]["status"] == "completed"
    assert updated["tts"]["provider"] == "gradium"
    assert updated["tts"]["speed"] == 1.25


def test_runtime_expression_tags_are_stripped_for_gradium():
    profile = default_runtime_profile(Settings())

    rendered = render_expression_tags("<laugh> Sure, testing.", profile, user_text="test")

    assert rendered["rendered_text"] == "Sure, testing."
    assert rendered["expression_tags_used"] == []
    assert rendered["unsupported_expression_tags"] == ["laugh"]


def test_runtime_command_prompt_exposes_current_stack():
    settings = Settings()
    profile = default_runtime_profile(settings)

    prompt = runtime_command_context(profile, settings, "talk faster")

    assert "provider=gradium" in prompt
    assert "voice_id=" in prompt
    assert "set_tts_speed" in prompt


def test_voice_runtime_fallback_uses_speed_tool():
    settings = Settings(gradium_tts_speed=1.0)
    profile = default_runtime_profile(settings)

    command = fallback_runtime_command_for_request("talk slower", profile, settings, reason="test")

    assert command is not None
    assert command.runtime_actions[0]["tool"] == "increment_tts_speed"
    assert command.runtime_actions[0]["args"]["delta"] < 0


def test_voice_runtime_parser_accepts_tool_actions():
    result = parse_voice_runtime_command(
        '{"speak":"Sure.","runtime_actions":[{"tool":"set_tts_speed","args":{"speed":1.2,"reason":"test"}}]}'
    )

    assert result.ok
    assert result.command is not None
    assert result.command.runtime_actions[0]["tool"] == "set_tts_speed"


def test_high_latency_trace_classifies_without_provider_knobs():
    settings = Settings()
    profile = default_runtime_profile(settings)
    record = build_learning_record(
        session_id="s",
        turn_id="t",
        input_mode="vad",
        user_transcript="hello",
        assistant_response_clean="Hi.",
        tts_rendered_text="Hi.",
        model_profile="balanced",
        model_used=settings.active_model,
        tts_provider="gradium",
        tts_params={"expression_tags_used": [], "unsupported_expression_tags": []},
        latency={"llm_ttfb_ms": 900, "tts_ttfb_ms": 1300, "total_first_audio_ms": 1800},
        events={},
        quality_signals={},
        runtime_profile_snapshot=profile,
    )

    failures = classify_voice_turn(record, profile)
    updated = apply_runtime_adaptation(profile, failures, record)

    assert "high_llm_ttfb" in failures
    assert "tts_too_slow" in failures
    assert updated["active_model_profile"] == "fast"
    assert updated["tts"]["provider"] == "gradium"
    assert "steps" not in updated["tts"]


def test_model_profile_and_fast_policy_helpers(runtime):
    settings, _db, repo, _learner, _agent = runtime
    profile = default_runtime_profile(settings)

    assert choose_model_profile("hello", profile) == "fast"
    assert model_for_profile(settings, profile, "balanced") == profile["llm"]["balanced_model"]
    assert voice_speed_intent("can you speak faster") == "faster"
    assert is_runtime_control_request("voice runtime status")
    assert fast_policy_response("What's your name?") == "I am an AI assistant."
    assert _empty_live_voice_response("hello") == "I'm here."
    assert "Gradium TTS" in build_system_instruction(settings, repo)


def test_merge_adjacent_chat_messages():
    merged = merge_adjacent_chat_messages(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "first"},
            {"role": "user", "content": "second"},
            {"role": "assistant", "content": "ok"},
        ]
    )

    assert merged[1]["content"] == "first\nsecond"
    assert len(merged) == 3
