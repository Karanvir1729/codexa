from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path

import httpx
import pytest

from app.agent import (
    AgentService,
    build_runtime_system_prompt,
    fast_policy_response,
)
from app.cloud_vm import CloudVLLMManager
from app.config import (
    MAINSTREAM_OPENROUTER_STT_MODEL,
    Settings,
    mainstream_voice_path_errors,
    require_mainstream_voice_path,
    settings_for_speech_path,
)
from app.cost_guard import CostGuard, CostLimitExceeded
from app.db import Database, loads
from app.eval_scheduler import EvalScheduler
from app.evaluator import EvalRunner
from app.feedback import FeedbackLearner, PromptRepository
from app.flow_runtime import FlowRepository, FlowRuntime, validate_flow_graph
from app.llm import LLMResult, MockLLMClient, make_llm_client
from app.local_voice_runtime import (
    LocalVoiceConversationRecorder,
    _empty_live_voice_response,
    build_system_instruction,
    create_local_stt_service,
    merge_adjacent_chat_messages,
    require_openai_compatible_llm,
    resolve_stt_language,
    resolve_tts_language,
)
from app.openrouter_stt import OpenRouterSTTService
from app.voxtral_tts import CoherentSentenceAggregator, VoxtralTTSService
from app.voice_self_observe import (
    apply_runtime_adaptation,
    build_learning_record,
    choose_model_profile,
    classify_voice_turn,
    clamp_supertonic_params,
    default_runtime_profile,
    execute_runtime_actions,
    is_runtime_control_request,
    likely_bad_transcript,
    max_tokens_for_profile,
    model_for_profile,
    parse_voice_runtime_command,
    render_expression_tags,
    runtime_command_context,
    load_runtime_profile,
)
from app.voice_runtime_controls import voice_speed_intent

BACKEND_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def runtime(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    repo = PromptRepository(db)
    learner = FeedbackLearner(db, repo, settings.latency_target_ms)
    agent = AgentService(db, settings, MockLLMClient(settings))
    return settings, db, repo, learner, agent


class FailingRuntimeLLM:
    async def generate(self, messages, system_prompt):
        raise TimeoutError("runtime command timed out")

    async def warmup(self) -> None:
        return None


def test_feedback_report_includes_self_learn_config(runtime):
    _settings, _db, _repo, learner, _agent = runtime

    assert learner.report()["config"] == {"enabled": True, "factor": 0.35}
    assert learner.update_config(enabled=False, factor=0.8) == {"enabled": False, "factor": 0.8}
    assert learner.report()["config"] == {"enabled": False, "factor": 0.8}


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

    with pytest.raises(RuntimeError, match="LLM_PROVIDER=nvidia"):
        require_openai_compatible_llm(settings)


@pytest.mark.asyncio
async def test_default_nvidia_provider_fails_without_api_key() -> None:
    settings = Settings(_env_file=None)
    llm = make_llm_client(settings)

    with pytest.raises(RuntimeError, match="nvidia provider is missing NVIDIA_API_KEY"):
        await llm.generate([{"role": "user", "content": "hello"}], "Reply briefly.")


def test_local_voice_uses_auto_detect_stt_and_explicit_tts_language():
    settings = Settings(local_stt_language="auto", local_tts_language="en")

    assert resolve_stt_language(settings) is None
    assert str(resolve_tts_language(settings)) == "en"


def test_mainstream_validator_rejects_non_demo_defaults():
    settings = Settings(_env_file=None)
    selected = settings_for_speech_path(settings, "supertone_parakeet")

    errors = mainstream_voice_path_errors(selected)

    assert any("VOICE_RUNTIME must be local_pipecat" in error for error in errors)
    assert any("LOCAL_STT_PROVIDER must be openrouter" in error for error in errors)
    assert any("CODEX_ORCHESTRATOR_ENABLED must be true" in error for error in errors)


def test_mainstream_validator_accepts_demo_configuration():
    settings = Settings(
        voice_runtime="local_pipecat",
        local_stt_provider="openrouter",
        openrouter_api_key="test-key",
        codex_orchestrator_enabled=True,
        supertonic_language="na",
    )
    selected = settings_for_speech_path(settings, "current")

    assert mainstream_voice_path_errors(selected) == []
    require_mainstream_voice_path(selected)
    assert selected.openrouter_stt_model == MAINSTREAM_OPENROUTER_STT_MODEL


def test_supertone_parakeet_speech_path_keeps_llm_and_stt_and_swaps_tts():
    base = Settings(llm_provider="ollama", ollama_model="qwen2.5:0.5b")

    selected = settings_for_speech_path(base, "supertone_parakeet")

    assert selected.llm_provider == base.llm_provider
    assert selected.active_model == base.active_model
    assert selected.local_stt_provider == base.local_stt_provider
    assert selected.local_stt_model == base.local_stt_model
    assert selected.local_tts_provider == "supertonic"
    assert selected.local_tts_voice == selected.supertonic_voice
    assert selected.local_audio_output_sample_rate == 44100


def test_legacy_current_speech_path_maps_to_supertone_parakeet():
    base = Settings(llm_provider="ollama", ollama_model="qwen2.5:0.5b", voice_speech_path="current")

    selected = settings_for_speech_path(base, "current")

    assert base.voice_speech_path == "supertone_parakeet"
    assert selected.voice_speech_path == "supertone_parakeet"
    assert selected.local_tts_provider == "supertonic"


def test_cloud_vllm_lifecycle_defaults_to_disabled():
    settings = Settings()
    manager = CloudVLLMManager(settings)

    snapshot = manager.snapshot()

    assert snapshot["enabled"] is False
    assert snapshot["stop_on_idle_enabled"] is True
    assert snapshot["idle_shutdown_seconds"] == 300


@pytest.mark.asyncio
async def test_cloud_vllm_health_check_skips_non_local_provider():
    settings = Settings(llm_provider="mock")

    assert await CloudVLLMManager(settings).health_check() is False


def test_cloud_vllm_external_ip_mode_refreshes_local_llm_base_url():
    settings = Settings(
        llm_provider="local",
        local_llm_base_url="http://192.0.2.1:5000/v1",
        cloud_vllm_ip_mode="external",
    )
    manager = CloudVLLMManager(settings)

    manager._update_base_url_from_instance(
        {
            "networkInterfaces": [
                {
                    "networkIP": "10.128.0.10",
                    "accessConfigs": [{"natIP": "203.0.113.20"}],
                }
            ]
        }
    )

    assert settings.local_llm_base_url == "http://203.0.113.20:5000/v1"


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


def test_openrouter_stt_service_uses_parakeet_v3_model():
    settings = Settings(
        local_stt_provider="openrouter",
        openrouter_api_key="test-key",
        local_stt_language="auto",
    )

    provider, stt = create_local_stt_service(settings)

    assert provider == "openrouter"
    assert stt.options.model == "nvidia/parakeet-tdt-0.6b-v3"
    assert stt.options.language is None


@pytest.mark.asyncio
async def test_openrouter_stt_posts_base64_wav_json():
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen["path"] = request.url.path
        seen["body"] = body
        seen["authorization"] = request.headers.get("authorization")
        decoded_audio = base64.b64decode(body["input_audio"]["data"])
        seen["decoded_audio_prefix"] = decoded_audio[:4]
        return httpx.Response(
            200,
            json={"text": "New one.", "language": "en"},
            headers={"X-Generation-Id": "gen-test"},
        )

    service = OpenRouterSTTService(
        base_url="https://openrouter.test/api/v1",
        api_key="test-key",
        model="nvidia/parakeet-tdt-0.6b-v3",
        language="en",
        temperature=0,
        sample_rate=16000,
        timeout_seconds=5,
        stt_ttfb_timeout=0.6,
        ttfs_p99_latency=0.8,
        transport=httpx.MockTransport(handler),
    )

    result = await service._transcribe(b"\x00\x00" * 160)
    body = seen["body"]
    assert isinstance(body, dict)

    assert seen["path"] == "/api/v1/audio/transcriptions"
    assert seen["authorization"] == "Bearer test-key"
    assert seen["decoded_audio_prefix"] == b"RIFF"
    assert body["model"] == "nvidia/parakeet-tdt-0.6b-v3"
    assert body["input_audio"]["format"] == "wav"
    assert body["language"] == "en"
    assert body["temperature"] == 0
    assert result["text"] == "New one."
    assert result["generation_id"] == "gen-test"


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

    assert "I am an AI assistant." in prompt
    assert "latency" in prompt
    assert "story" in prompt
    assert "one short sentence" not in prompt
    assert "human agent" not in prompt
    assert "order ID" not in prompt
    assert "account email" not in prompt
    assert "Voice cloning is not available" in prompt


def test_fast_policy_response_handles_name_without_customer_service_hijacks():
    assert fast_policy_response("What's your name?") == "I am an AI assistant."
    assert fast_policy_response("Hello? Are you there?") is None
    assert fast_policy_response("Hi") is None
    assert fast_policy_response("Hey, how's it going?") is None
    assert fast_policy_response("I need help with my account.") is None
    assert fast_policy_response("Can I talk to a human agent?") is None


def test_fast_policy_response_handles_voice_speed_and_oneplus_ambiguity():
    assert fast_policy_response("Can you talk a bit faster?") is None
    assert fast_policy_response("Talk very fast.") is None
    assert fast_policy_response("Please slow down your voice.") is None
    assert fast_policy_response("Can you use a spooky tone?") == "Got it, I'll use a spooky tone."
    assert fast_policy_response("You can clone my voice.") is None
    assert fast_policy_response("Can you clone my voice?") is None
    assert fast_policy_response("What's OnePlus One?") == (
        "Do you mean the OnePlus phone or one plus one?"
    )
    assert fast_policy_response("What's one plus one?") == "It's 2."


def test_voice_speed_intent_covers_natural_slow_phrases():
    assert voice_speed_intent("talk slow") == "slower"
    assert voice_speed_intent("talk slow please") == "slower"
    assert voice_speed_intent("please talk slower") == "slower"
    assert voice_speed_intent("you're talking too slow") == "faster"
    assert voice_speed_intent("you're talking too fast") == "slower"


@pytest.mark.asyncio
async def test_chat_runtime_speed_uses_structured_tool_action(runtime):
    settings, db, _repo, _learner, agent = runtime

    response = await agent.respond("talk slow please", channel="test")

    assert "slow" in response["message"].casefold()
    profile = load_runtime_profile(db, settings)
    assert profile["tts"]["speed"] < settings.supertonic_speed

    row = db.one(
        """
        SELECT metrics_json
        FROM turns
        WHERE conversation_id = ? AND role = 'assistant'
        ORDER BY rowid DESC
        LIMIT 1
        """,
        (response["conversation_id"],),
    )
    metrics = loads(row["metrics_json"], {})
    assert metrics["source"] == "voice_runtime_tools"
    assert metrics["runtime_actions"][0]["tool"] == "increment_tts_speed"
    assert metrics["runtime_action_status"][0]["field"] == "tts.speed"
    assert metrics["runtime_action_status"][0]["status"] == "completed"


@pytest.mark.asyncio
async def test_chat_runtime_speed_raises_on_llm_timeout(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    agent = AgentService(db, settings, FailingRuntimeLLM())

    with pytest.raises(RuntimeError, match="Voice runtime LLM request failed"):
        await agent.respond("talk slow please", channel="test")

    profile = load_runtime_profile(db, settings)
    assert profile["tts"]["speed"] == settings.supertonic_speed

    turns = db.all("SELECT role FROM turns ORDER BY rowid")
    assert [row["role"] for row in turns] == ["user"]


def test_fast_policy_does_not_block_long_form_requests():
    assert fast_policy_response("Tell me a story in a spooky tone.") is None
    assert fast_policy_response("Explain that in more detail.") is None


def test_voxtral_ref_audio_takes_precedence_and_whisper_is_stronger():
    tts = VoxtralTTSService(
        base_url="http://tts.example/v1",
        voice="neutral_female",
        voice_id="saved-voice",
        ref_audio_base64="abc123",
    )

    payload = tts._build_payload("Hello.")

    assert payload["ref_audio"] == "data:audio/wav;base64,abc123"
    assert "voice" not in payload
    assert "voice_id" not in payload

    payload = tts._build_payload("Hello.", include_ref_audio=False)
    assert payload["voice_id"] == "saved-voice"
    assert "ref_audio" not in payload

    tts.set_ref_audio_enabled(False)
    payload = tts._build_payload("Hello.")
    assert payload["voice_id"] == "saved-voice"
    assert "ref_audio" not in payload
    tts.set_ref_audio_enabled(True)

    tts.set_ref_audio_base64(None)
    tts.set_emotion("whisper")
    payload = tts._build_payload("Hello.")

    assert payload["voice_id"] == "saved-voice"
    assert "whisper-like" in payload["instructions"]
    assert "same voice, pace, pitch" in payload["instructions"]


@pytest.mark.asyncio
async def test_voxtral_sentence_aggregator_coalesces_short_replies():
    aggregator = CoherentSentenceAggregator(min_chars=80)
    chunks = []

    async for chunk in aggregator.aggregate("Hey! "):
        chunks.append(chunk.text)
    async for chunk in aggregator.aggregate("I'm doing well, thanks for asking. "):
        chunks.append(chunk.text)
    async for chunk in aggregator.aggregate("How about you? How can I help you today?"):
        chunks.append(chunk.text)

    pending = await aggregator.flush()

    assert chunks == []
    assert pending is not None
    assert pending.text == (
        "Hey! I'm doing well, thanks for asking. How about you? "
        "How can I help you today?"
    )


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

    assert response["message"] == "I am an AI assistant."
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


@pytest.mark.asyncio
async def test_agent_raises_when_llm_fails(tmp_path: Path):
    class FailingLLM:
        async def generate(self, _messages, _system_prompt: str) -> LLMResult:
            raise TimeoutError("upstream timed out")

        async def warmup(self) -> None:
            return None

    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    agent = AgentService(db, settings, FailingLLM())

    with pytest.raises(RuntimeError, match="LLM provider request failed"):
        await agent.respond("Can you help?", channel="test")

    transcript = agent.transcript(db.all("SELECT id FROM conversations ORDER BY rowid")[0]["id"])
    assert [turn["role"] for turn in transcript] == ["user"]


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


def test_voice_model_profile_routes_greetings_to_fast():
    settings = Settings(
        llm_provider="nvidia",
        nvidia_api_key="test",
        nvidia_model="mistralai/mistral-nemotron",
        voice_fast_model=None,
        supertonic_steps=8,
    )
    profile = default_runtime_profile(settings)

    selected = choose_model_profile("Hey, how's it going?", profile)

    assert selected == "fast"
    assert model_for_profile(settings, profile, selected) == settings.active_model
    assert max_tokens_for_profile(settings, selected, profile) <= 96
    assert profile["tts"]["steps"] == 8


def test_high_latency_trace_classifies_and_adapts_toward_fast_profile():
    settings = Settings(
        llm_provider="nvidia",
        nvidia_api_key="test",
        nvidia_model="mistralai/mistral-nemotron",
    )
    profile = default_runtime_profile(settings)
    record = build_learning_record(
        session_id="0756609a",
        turn_id="turn-1",
        input_mode="vad",
        user_transcript="Hey, how's it going?",
        assistant_response_clean="I'm here. How can I help?",
        tts_rendered_text="I'm here. How can I help?",
        model_profile="balanced",
        model_used=settings.active_model,
        tts_provider="supertonic",
        tts_params={"steps": 8, "expression_tags_used": []},
        latency={"llm_ttfb_ms": 31424, "total_first_audio_ms": 32457, "tts_ttfb_ms": 300},
        events={"vad_starts": 1, "duplicate_interruption_events": 0},
        quality_signals={"likely_bad_transcript": False},
        runtime_profile_snapshot=profile,
    )

    failures = classify_voice_turn(record, profile)
    updated = apply_runtime_adaptation(profile, failures, record)

    assert "high_llm_ttfb" in failures
    assert "high_total_first_audio_latency" in failures
    assert updated["active_model_profile"] == "fast"
    assert updated["llm"]["max_output_tokens"] <= 96


def test_duplicate_interruption_events_increase_debounce():
    settings = Settings(supertonic_steps=8)
    profile = default_runtime_profile(settings)
    record = build_learning_record(
        session_id="0756609a",
        turn_id="turn-2",
        input_mode="vad",
        user_transcript="Okay.",
        assistant_response_clean="Got it.",
        tts_rendered_text="Got it.",
        model_profile="fast",
        model_used=settings.active_model,
        tts_provider="supertonic",
        tts_params={"steps": 8, "expression_tags_used": []},
        latency={"llm_ttfb_ms": 120, "total_first_audio_ms": 700, "tts_ttfb_ms": 200},
        events={"vad_starts": 1, "interruptions": 1, "duplicate_interruption_events": 1},
        quality_signals={"likely_bad_transcript": False},
        runtime_profile_snapshot=profile,
    )

    failures = classify_voice_turn(record, profile)
    updated = apply_runtime_adaptation(profile, failures, record)

    assert "duplicate_interruption_events" in failures
    assert updated["turn_taking"]["interruption_debounce_ms"] > profile["turn_taking"]["interruption_debounce_ms"]
    assert updated["turn_taking"]["duplicate_interruptions_prevented"] == 1


def test_empty_llm_completion_is_not_a_visible_assistant_turn(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="ollama")
    profile = default_runtime_profile(settings)
    record = build_learning_record(
        session_id="session",
        turn_id="turn-empty",
        input_mode="vad",
        user_transcript="Hello",
        assistant_response_clean="",
        tts_rendered_text="",
        model_profile="fast",
        model_used=settings.active_model,
        tts_provider="supertonic",
        tts_params={"steps": 8, "expression_tags_used": []},
        latency={"llm_ttfb_ms": 100, "total_first_audio_ms": None, "tts_ttfb_ms": None},
        events={"vad_starts": 1, "empty_llm_completions": 1},
        quality_signals={"was_empty_response": True},
        runtime_profile_snapshot=profile,
    )
    recorder = LocalVoiceConversationRecorder(
        Database(settings.database_path),
        settings,
        PromptRepository(Database(settings.database_path)).active().version,
    )

    assert "empty_llm_completion" in classify_voice_turn(record, profile)
    assert recorder.record_turn("assistant", "") == ""


def test_bad_transcript_is_classified_for_clarification():
    settings = Settings()
    profile = default_runtime_profile(settings)
    record = build_learning_record(
        session_id="0756609a",
        turn_id="turn-bad-stt",
        input_mode="vad",
        user_transcript="Month BJU.",
        assistant_response_clean="Sorry, I didn't catch that. Can you say it again?",
        tts_rendered_text="Sorry, I didn't catch that. Can you say it again?",
        model_profile="fast",
        model_used="clarification_policy",
        tts_provider="supertonic",
        tts_params={"steps": 8, "expression_tags_used": []},
        latency={"llm_ttfb_ms": 0, "total_first_audio_ms": 500, "tts_ttfb_ms": 180},
        events={"vad_starts": 1},
        quality_signals={"likely_bad_transcript": True},
        runtime_profile_snapshot=profile,
    )

    assert likely_bad_transcript("Month BJU.")
    assert "likely_bad_transcript" in classify_voice_turn(record, profile)


def test_supertonic_tts_parameter_clamp_rejects_unsupported_format():
    clamped_high = clamp_supertonic_params({"speed": 3.0, "steps": 500, "response_format": "mp3"})
    clamped_low = clamp_supertonic_params({"speed": 0.2, "steps": 0})

    assert clamped_high["speed"] == 2.0
    assert clamped_high["steps"] == 100
    assert clamped_high["response_format"] == "wav"
    assert clamped_low["speed"] == 0.7
    assert clamped_low["steps"] == 1


def test_expression_tag_renderer_uses_discovered_allowlist_and_keeps_canonical_clean():
    settings = Settings()
    profile = default_runtime_profile(settings)
    profile["tts"]["allowed_expression_tags"] = ["breath", "laugh", "sigh"]

    off_profile = {**profile, "tts": {**profile["tts"], "expression_mode": "off"}}
    off = render_expression_tags("<breath> Got it.", off_profile)
    subtle = render_expression_tags("Got it. I'll keep it short.", profile)
    unsupported = render_expression_tags("Hello <dance> there.", profile)
    serious = render_expression_tags("This is a medical emergency.", profile)

    assert "<" not in off["clean_text"]
    assert "<" not in off["rendered_text"]
    assert "breath" in off["unsupported_expression_tags"]
    assert subtle["expression_tags_used"] == ["breath"]
    assert subtle["rendered_text"].count("<") <= 1
    assert "dance" in unsupported["unsupported_expression_tags"]
    assert "<dance>" not in unsupported["rendered_text"]
    assert serious["expression_tags_used"] == []
    assert "<" not in serious["clean_text"]


def test_voice_runtime_command_parses_and_executes_speed_increment():
    settings = Settings()
    profile = default_runtime_profile(settings)
    raw = """
    {
      "speak": "Faster now.",
      "runtime_actions": [
        {"tool": "increment_tts_speed", "args": {"delta": 0.1, "reason": "test"}}
      ]
    }
    """

    parsed = parse_voice_runtime_command(raw)
    assert parsed.ok
    assert parsed.command is not None

    updated, statuses = execute_runtime_actions(profile, parsed.command.runtime_actions, settings)

    assert parsed.command.speak == "Faster now."
    assert updated["tts"]["speed"] == 1.15
    assert statuses[0]["tool"] == "increment_tts_speed"
    assert statuses[0]["status"] == "completed"
    assert updated["debug"]["last_runtime_actions"] == parsed.command.runtime_actions


def test_voice_runtime_command_normalizes_known_tool_call_aliases():
    settings = Settings()
    profile = default_runtime_profile(settings)
    raw = """
    {
      "speak": "Faster now.",
      "runtime_actions": [
        {"name": "increment_tts_speed", "arguments": {"delta": 0.1, "reason": "test"}}
      ]
    }
    """

    parsed = parse_voice_runtime_command(raw)
    assert parsed.ok
    assert parsed.command is not None

    updated, statuses = execute_runtime_actions(profile, parsed.command.runtime_actions, settings)

    assert parsed.command.runtime_actions == [
        {"tool": "increment_tts_speed", "args": {"delta": 0.1, "reason": "test"}}
    ]
    assert updated["tts"]["speed"] == 1.15
    assert statuses[0]["status"] == "completed"


def test_voice_runtime_command_strips_emotion_prefix_from_spoken_text():
    parsed = parse_voice_runtime_command(
        '{"speak":"F| Hi there!","runtime_actions":[],"reasoning_profile":"fast"}'
    )

    assert parsed.ok
    assert parsed.command is not None
    assert parsed.command.speak == "Hi there!"


def test_voice_runtime_parser_ignores_unknown_optional_reasoning_profile():
    parsed = parse_voice_runtime_command(
        '{"speak":"Okay.","runtime_actions":[],"reasoning_profile":"quick"}'
    )

    assert parsed.ok
    assert parsed.command is not None
    assert parsed.command.reasoning_profile is None


def test_runtime_command_prompt_exposes_allowed_actions_and_current_state():
    settings = Settings()
    profile = default_runtime_profile(settings)

    prompt = runtime_command_context(profile, settings)

    assert "Return valid JSON only" in prompt
    assert "set_tts_speed" in prompt
    assert "increment_tts_speed" in prompt
    assert "get_voice_runtime_status" in prompt
    assert "delta:number" in prompt
    assert "speed:number" in prompt
    assert "Canonical slower example" in prompt
    assert "Canonical Codex example" in prompt
    assert "Never return a bare tool object" in prompt
    assert "do not copy runtime_actions from prior turns" in prompt
    assert "<breath>, <laugh>, <sigh>" in prompt
    assert str(profile["tts"]["speed"]) in prompt


def test_runtime_control_request_bypasses_fast_policy_shortcut():
    assert is_runtime_control_request("Talk faster.")
    assert is_runtime_control_request("Fastest.")
    assert is_runtime_control_request("Can you use expression tags?")
    assert is_runtime_control_request("Are you using Supertonic?")


def test_voice_runtime_fastest_clamps_to_natural_live_max():
    settings = Settings()
    profile = default_runtime_profile(settings)
    actions = [
        {
            "tool": "set_tts_speed",
            "args": {"speed": 2.0, "reason": "user_requested_fastest_speech"},
        }
    ]

    updated, statuses = execute_runtime_actions(profile, actions, settings)

    assert updated["tts"]["speed"] == settings.voice_natural_tts_speed_max
    assert statuses[0]["new_value"] == settings.voice_natural_tts_speed_max


def test_voice_runtime_expression_mode_action_keeps_speak_clean():
    settings = Settings()
    profile = default_runtime_profile(settings)
    raw = """
    {
      "speak": "Yes. I enabled subtle expression tags.",
      "runtime_actions": [
        {"tool": "set_expression_mode", "args": {"mode": "subtle", "reason": "test"}}
      ],
      "reasoning_profile": "fast"
    }
    """

    parsed = parse_voice_runtime_command(raw)
    assert parsed.ok
    assert parsed.command is not None
    updated, _statuses = execute_runtime_actions(profile, parsed.command.runtime_actions, settings)

    assert "<" not in parsed.command.speak
    assert updated["tts"]["expression_mode"] == "subtle"


def test_voice_runtime_parser_strips_tags_from_speak_without_repair():
    raw = """
    {
      "speak": "Yes, I can use tags like <laugh> when appropriate.",
      "runtime_actions": []
    }
    """

    parsed = parse_voice_runtime_command(raw)

    assert parsed.ok
    assert parsed.command is not None
    assert parsed.command.speak == "Yes, I can use tags like  when appropriate."


def test_voice_runtime_parser_accepts_bare_tool_action():
    raw = """
    {
      "tool": "increment_tts_speed",
      "args": {"delta": -0.2, "reason": "user_requested_slower_speech"}
    }
    """

    parsed = parse_voice_runtime_command(raw)

    assert parsed.ok
    assert parsed.command is not None
    assert parsed.command.speak == "I updated the voice runtime."
    assert parsed.command.runtime_actions == [
        {
            "tool": "increment_tts_speed",
            "args": {"delta": -0.2, "reason": "user_requested_slower_speech"},
        }
    ]


def test_voice_runtime_parser_decodes_openai_style_argument_string():
    raw = r"""
    {
      "speak": "Sure, I'll talk faster.",
      "runtime_actions": [
        {
          "name": "increment_tts_speed",
          "arguments": "{\"delta\": 0.2, \"reason\": \"user_requested_faster_speech\"}"
        }
      ]
    }
    """

    parsed = parse_voice_runtime_command(raw)

    assert parsed.ok
    assert parsed.command is not None
    assert parsed.command.runtime_actions == [
        {
            "tool": "increment_tts_speed",
            "args": {"delta": 0.2, "reason": "user_requested_faster_speech"},
        }
    ]


def test_voice_runtime_parser_repairs_missing_action_object_brace():
    raw = r"""
    {
      "speak": "I'll route that to Codex planning.",
      "runtime_actions": [
        {
          "tool": "delegate_to_codex_orchestrator",
          "args": {
            "goal": "Add a README note.",
            "mode": "plan_first",
            "reason": "user_requested_codex_planning"
          }
        ],
      "reasoning_profile": "reasoning"
    }
    """

    parsed = parse_voice_runtime_command(raw)

    assert parsed.ok
    assert parsed.command is not None
    assert parsed.command.runtime_actions == [
        {
            "tool": "delegate_to_codex_orchestrator",
            "args": {
                "goal": "Add a README note.",
                "mode": "plan_first",
                "reason": "user_requested_codex_planning",
            },
        }
    ]


def test_voice_runtime_missing_required_action_args_are_rejected():
    settings = Settings()
    profile = default_runtime_profile(settings)
    actions = [{"tool": "increment_tts_speed", "args": {"reason": "test"}}]

    updated, statuses = execute_runtime_actions(profile, actions, settings)

    assert updated["tts"]["speed"] == profile["tts"]["speed"]
    assert statuses[0]["status"] == "rejected"
    assert statuses[0]["error"] == "missing_delta"


def test_voice_runtime_invalid_json_is_rejected_without_actions():
    parsed = parse_voice_runtime_command("Sure, I'll talk faster.")

    assert not parsed.ok
    assert "structured_output_parse_failed:no_json_object" in parsed.errors


def test_live_voice_empty_completion_recovers_to_spoken_turn():
    assert _empty_live_voice_response("Hello.") == "I'm here."
    assert _empty_live_voice_response("Can you hear me?") == "I heard you."
    assert _empty_live_voice_response("") == "I understand."


def test_voice_runtime_unknown_tool_is_rejected_without_mutation():
    settings = Settings()
    profile = default_runtime_profile(settings)
    raw = """
    {
      "speak": "Trying that.",
      "runtime_actions": [
        {"tool": "set_pitch", "args": {"pitch": 2, "reason": "test"}}
      ]
    }
    """

    parsed = parse_voice_runtime_command(raw)
    assert parsed.ok
    assert parsed.command is not None
    updated, statuses = execute_runtime_actions(profile, parsed.command.runtime_actions, settings)

    assert updated["tts"]["speed"] == profile["tts"]["speed"]
    assert statuses[0]["status"] == "rejected"
    assert statuses[0]["error"] == "unknown_tool"


def test_local_voice_system_instruction_respects_no_think(tmp_path: Path):
    settings = Settings(
        database_path=str(tmp_path / "agent.sqlite3"),
        llm_provider="ollama",
        reasoning_mode="off",
    )
    repo = PromptRepository(Database(settings.database_path))

    instruction = build_system_instruction(settings, repo)

    assert instruction.startswith("/no_think\n")
    assert "answer immediately" in instruction
    assert "under 18 words" not in instruction
    assert "under 12 words" not in instruction
    assert "runtime-control system message" in instruction


def test_tts_total_latency_classifies_when_first_audio_probe_is_missing():
    settings = Settings(supertonic_steps=8)
    profile = default_runtime_profile(settings)
    record = build_learning_record(
        session_id="session",
        turn_id="turn-tts-slow",
        input_mode="vad",
        user_transcript="Hello.",
        assistant_response_clean="Hi there!",
        tts_rendered_text="Hi there!",
        model_profile="fast",
        model_used=settings.active_model,
        tts_provider="supertonic",
        tts_params={"steps": 8, "expression_tags_used": []},
        latency={
            "llm_ttfb_ms": 300,
            "tts_ttfb_ms": None,
            "tts_total_ms": 3024,
            "total_first_audio_ms": None,
            "transcript_to_response_done_ms": 5286,
        },
        events={"vad_starts": 1},
        quality_signals={"likely_bad_transcript": False},
        runtime_profile_snapshot=profile,
    )

    failures = classify_voice_turn(record, profile)
    updated = apply_runtime_adaptation(profile, failures, record)

    assert "high_tts_ttfb" in failures
    assert "tts_too_slow" in failures
    assert "high_total_first_audio_latency" in failures
    assert updated["tts"]["steps"] < profile["tts"]["steps"]
    assert updated["tts"]["max_chunk_length"] <= 220
    assert updated["tts"]["silence_duration"] <= 0.2


def test_default_flow_bootstraps_with_flow_voice_agent_path(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    repo = FlowRepository(Database(settings.database_path))

    flow = repo.active()
    validation = validate_flow_graph(flow.graph)
    node_types = {node["data"]["nodeType"] for node in flow.graph["nodes"]}

    assert flow.status == "published"
    assert flow.name == "Flow Voice Agent"
    assert flow.graph["metadata"]["schemaVersion"] == 4
    assert validation["ok"] is True
    assert {"start", "dialogue", "collect", "fallback", "end"} <= node_types


@pytest.mark.asyncio
async def test_flow_runtime_routes_voice_requests_through_flow_nodes(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    repo = FlowRepository(db)
    runtime = FlowRuntime(db, repo, MockLLMClient(settings))
    flow = repo.active()

    started = await runtime.handle_message(flow_id=flow.id, message=None)
    toned = await runtime.handle_message(
        flow_id=flow.id,
        run_id=started["run_id"],
        message="Can you use a spooky tone?",
    )
    story = await runtime.handle_message(
        flow_id=flow.id,
        run_id=started["run_id"],
        message="Tell me a spooky story in four sentences.",
    )

    assert started["active_node_id"] == "listen_for_intent"
    assert any("I am an AI assistant" in message["text"] for message in started["messages"])
    assert toned["active_node_id"] == "tone_control"
    assert toned["slots"]["user_request"] == "Can you use a spooky tone?"
    assert any(message.get("voice") for message in toned["messages"])
    assert story["active_node_id"] == "long_form_response"
    assert any("clock" in message["text"].casefold() for message in story["messages"])
    assert runtime.latest_run_for_conversation(story["run_id"]) is None


@pytest.mark.asyncio
async def test_flow_runtime_can_lookup_voice_run_by_conversation(tmp_path: Path):
    settings = Settings(database_path=str(tmp_path / "agent.sqlite3"), llm_provider="mock")
    db = Database(settings.database_path)
    repo = FlowRepository(db)
    runtime = FlowRuntime(db, repo, MockLLMClient(settings))
    flow = repo.active()
    conversation_id = "voice-conversation"

    started = await runtime.handle_message(flow_id=flow.id, message=None, conversation_id=conversation_id)
    latest = runtime.latest_run_for_conversation(conversation_id)

    assert latest is not None
    assert latest["run_id"] == started["run_id"]
    assert latest["active_node_id"] == "listen_for_intent"


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

    assert interrupted["active_node_id"] == "clarify_request"
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
    assert result["improvement_hints"]
    assert learner.report()["active_prompt_version"] == result["prompt_version"]


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
