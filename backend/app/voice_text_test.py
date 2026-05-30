from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Mapping

from .agent import (
    AgentService,
    build_runtime_system_prompt,
    repair_long_form_response,
)
from .codex_orchestrator import has_codex_orchestrator_session
from .config import Settings
from .db import Database
from .feedback import PromptRepository
from .flow_runtime import FlowRuntime
from .local_voice_runtime import LocalVoiceConversationRecorder
from .voice_runtime_controls import (
    emotion_code_for_tone,
    emotion_code_for_turn,
    voice_speed_intent,
    voice_speed_label,
    voice_tone_intent,
)
from .voice_self_observe import (
    VoiceInputMode,
    apply_runtime_adaptation,
    build_learning_record,
    choose_model_profile,
    classify_voice_turn,
    clamp_supertonic_params,
    fallback_runtime_command_for_request,
    is_voice_tool_request,
    load_runtime_profile,
    model_for_profile,
    parse_voice_runtime_command,
    render_expression_tags,
    runtime_command_context,
    save_runtime_profile,
    voice_runtime_status,
)
from .voice_runtime_executor import execute_voice_runtime_actions


DEFAULT_VOICE_TEXT_TEST_CASES: list[dict[str, Any]] = [
    {
        "id": "assistant_greeting",
        "message": "Hello, are you there?",
        "voice_behavior_mode": "assistant",
        "expect_min_words": 4,
    },
    {
        "id": "assistant_runtime_speed",
        "message": "Can you talk faster?",
        "voice_behavior_mode": "assistant",
        "expect_contains": ["faster"],
        "expect_runtime_action": True,
    },
    {
        "id": "flow_long_form",
        "message": "Tell me a spooky story in four sentences.",
        "voice_behavior_mode": "flow",
        "expect_active_node_id": "long_form_response",
        "expect_min_words": 10,
        "expect_not_contains": ["what detail should i use"],
    },
    {
        "id": "flow_interrupt",
        "message": "stop, actually cancel that",
        "voice_behavior_mode": "flow",
        "force_interrupt": True,
        "expect_contains": ["make sure"],
        "expect_active_node_id": "clarify_request",
    },
]


def _ms(start: float, end: float) -> int:
    return max(0, int((end - start) * 1000))


def _safe_mode(value: str | None, settings: Settings) -> str:
    if value in {"assistant", "flow"}:
        return value
    return settings.voice_behavior_mode if settings.voice_behavior_mode in {"assistant", "flow"} else "assistant"


def _safe_input_mode(value: str | None) -> VoiceInputMode:
    return "push_to_talk" if value == "push_to_talk" else "vad"


def _resolve_flow_id(flow_runtime: FlowRuntime, requested: str | None) -> str:
    value = (requested or "").strip()
    if not value or value == "active":
        return flow_runtime.repo.active().id
    return value


def _tts_params(settings: Settings, profile: Mapping[str, Any], rendered: Mapping[str, Any]) -> dict[str, Any]:
    tts_profile = profile.get("tts") if isinstance(profile.get("tts"), Mapping) else {}
    if settings.local_tts_provider == "supertonic":
        params = clamp_supertonic_params(
            {
                **dict(tts_profile),
                "voice": settings.supertonic_voice,
                "lang": settings.supertonic_language,
                "speed": tts_profile.get("speed", settings.supertonic_speed),
                "steps": tts_profile.get("steps", settings.supertonic_steps),
                "max_chunk_length": tts_profile.get(
                    "max_chunk_length",
                    settings.supertonic_max_chunk_length,
                ),
                "silence_duration": tts_profile.get(
                    "silence_duration",
                    settings.supertonic_silence_duration,
                ),
                "response_format": settings.supertonic_response_format,
            }
        )
    else:
        params = {
            "voice": settings.local_tts_voice,
            "speed": tts_profile.get("speed", settings.supertonic_speed),
            "provider": settings.local_tts_provider,
        }
    params.update(
        {
            "provider": settings.local_tts_provider,
            "simulated": True,
            "expression_tags_used": list(rendered.get("expression_tags_used") or []),
            "unsupported_expression_tags": list(rendered.get("unsupported_expression_tags") or []),
        }
    )
    return params


def build_voice_text_tts_payload(
    settings: Settings,
    profile: Mapping[str, Any],
    text: str,
    *,
    user_text: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    if settings.local_tts_provider != "supertonic":
        raise ValueError("Audible text voice tests require Supertonic TTS.")

    rendered = render_expression_tags(text, profile, user_text=user_text)
    clean_text = str(rendered.get("clean_text") or text).strip()
    rendered_text = str(rendered.get("rendered_text") or clean_text).strip()
    if not rendered_text:
        raise ValueError("TTS text is required.")

    tts_profile = profile.get("tts") if isinstance(profile.get("tts"), Mapping) else {}
    params = clamp_supertonic_params(
        {
            **dict(tts_profile),
            "voice": settings.supertonic_voice,
            "lang": settings.supertonic_language,
            "speed": tts_profile.get("speed", settings.supertonic_speed),
            "steps": tts_profile.get("steps", settings.supertonic_steps),
            "max_chunk_length": tts_profile.get(
                "max_chunk_length",
                settings.supertonic_max_chunk_length,
            ),
            "silence_duration": tts_profile.get(
                "silence_duration",
                settings.supertonic_silence_duration,
            ),
            "response_format": "wav",
        }
    )
    return {"text": rendered_text, **params}, rendered


def _quality_signals(*, likely_bad: bool, interrupted: bool) -> dict[str, Any]:
    return {
        "stt_confidence": 1.0,
        "was_interrupted": interrupted,
        "was_empty_response": False,
        "likely_bad_transcript": likely_bad,
        "user_correction_detected": interrupted,
        "failure_type": None,
    }


def _validate_suite_case(case: Mapping[str, Any], turn: Mapping[str, Any]) -> tuple[bool, list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []

    def add(name: str, passed: bool, detail: str = "") -> None:
        checks.append({"name": name, "passed": passed, "detail": detail})

    message = str(turn.get("message") or "")
    add("assistant_message", bool(message.strip()))
    add("user_turn_recorded", bool(turn.get("user_turn_id")))
    add("assistant_turn_recorded", bool(turn.get("assistant_turn_id")))
    add("latency_trace_recorded", bool(turn.get("latency_trace_id")))
    events = turn.get("events_recorded") if isinstance(turn.get("events_recorded"), list) else []
    add("interaction_completed_event", "interaction_completed" in events)

    for expected in case.get("expect_contains") or []:
        expected_text = str(expected).casefold()
        add(
            f"contains:{expected_text}",
            expected_text in message.casefold(),
            f"message={message[:160]}",
        )

    for rejected in case.get("expect_not_contains") or []:
        rejected_text = str(rejected).casefold()
        add(
            f"excludes:{rejected_text}",
            rejected_text not in message.casefold(),
            f"message={message[:160]}",
        )

    expected_min_words = case.get("expect_min_words")
    if isinstance(expected_min_words, int) and expected_min_words > 0:
        word_count = len(message.split())
        add(
            f"min_words:{expected_min_words}",
            word_count >= expected_min_words,
            f"actual={word_count}",
        )

    if case.get("expect_runtime_action"):
        statuses = turn.get("runtime_action_status") if isinstance(turn.get("runtime_action_status"), list) else []
        add(
            "runtime_action_completed",
            any(isinstance(status, dict) and status.get("status") == "completed" for status in statuses),
        )

    expected_node = case.get("expect_active_node_id")
    if expected_node:
        flow = turn.get("flow") if isinstance(turn.get("flow"), Mapping) else {}
        actual_node = flow.get("active_node_id")
        add(
            f"active_node:{expected_node}",
            actual_node == expected_node,
            f"actual={actual_node}",
        )

    passed = all(check["passed"] for check in checks)
    return passed, checks


async def run_voice_text_turn(
    *,
    message: str,
    conversation_id: str | None,
    settings: Settings,
    db: Database,
    prompt_repo: PromptRepository,
    agent: AgentService,
    flow_runtime: FlowRuntime,
    voice_behavior_mode: str | None = None,
    voice_flow_id: str | None = None,
    input_mode: str | None = "push_to_talk",
    force_interrupt: bool = False,
    flow_run_id: str | None = None,
) -> dict[str, Any]:
    text = message.strip()
    if not text:
        raise ValueError("Message is required.")

    mode = _safe_mode(voice_behavior_mode, settings)
    effective_input_mode = _safe_input_mode(input_mode)
    prompt = prompt_repo.active()
    cid = conversation_id or str(uuid.uuid4())
    recorder = LocalVoiceConversationRecorder(
        db,
        settings,
        prompt.version,
        channel="browser_voice_text",
        transport_name="text.assumed_stt",
        conversation_id=cid,
    )
    recorder.start()
    resolved_flow_id = _resolve_flow_id(flow_runtime, voice_flow_id or settings.voice_flow_id)
    recorder.update_metadata(
        {
            "llm_provider": settings.llm_provider,
            "model": settings.active_model,
            "stt_provider": settings.local_stt_provider,
            "stt_model": settings.local_stt_model,
            "tts_provider": settings.local_tts_provider,
            "tts_voice": settings.local_tts_voice,
            "transport": "text.assumed_stt",
            "text_voice_test": True,
            "assumed_stt": True,
            "voice_behavior_mode": mode,
            "voice_flow_id": resolved_flow_id,
            "voice_speech_path": settings.voice_speech_path,
            "input_mode": effective_input_mode,
        }
    )

    runtime_profile = load_runtime_profile(db, settings)
    runtime_profile["input_mode"] = effective_input_mode
    turn_taking = runtime_profile.setdefault("turn_taking", {})
    if effective_input_mode == "push_to_talk":
        turn_taking["push_to_talk_enabled"] = True
        turn_taking["vad_enabled"] = False
    else:
        turn_taking["push_to_talk_enabled"] = False
        turn_taking["vad_enabled"] = True
    save_runtime_profile(db, runtime_profile)

    interaction_id = str(uuid.uuid4())
    events_recorded: list[str] = []

    def record_event(event: str, *, role: str | None = None, text_value: str | None = None, payload: dict[str, Any] | None = None) -> str:
        events_recorded.append(event)
        return recorder.record_interaction_event(
            interaction_id=interaction_id,
            event=event,
            role=role,
            text=text_value,
            payload=payload or {},
        )

    started_at = time.perf_counter()
    transcript_at = started_at
    selected_profile = choose_model_profile(text, runtime_profile)
    selected_model = model_for_profile(settings, runtime_profile, selected_profile)
    likely_bad = False
    speed_intent = voice_speed_intent(text)
    tone_intent = voice_tone_intent(text)
    user_turn_id = recorder.record_turn(
        "user",
        text,
        metrics={
            "interaction_id": interaction_id,
            "source": "text_assumed_stt",
            "assumed_stt": True,
            "raw_transcript": text,
            "input_mode": effective_input_mode,
            "voice_behavior_mode": mode,
            "voice_flow_id": resolved_flow_id,
            "voice_speed_intent": speed_intent,
            "voice_tone_intent": tone_intent,
        },
    )
    record_event(
        "user_transcribed",
        role="user",
        text_value=text,
        payload={
            "event": "user_transcribed",
            "assumed_stt": True,
            "raw_text": text,
            "input_mode": effective_input_mode,
            "configured_stt_provider": settings.local_stt_provider,
            "stt_model": settings.local_stt_model,
        },
    )

    runtime_actions: list[dict[str, Any]] = []
    runtime_action_status: list[dict[str, Any]] = []
    flow_result: dict[str, Any] | None = None
    provider = settings.llm_provider
    model = selected_model
    response_source = "llm"
    response_text = ""
    llm_started_at = time.perf_counter()
    llm_completed_at = llm_started_at
    latency_ms = 0
    raw_result: dict[str, Any] = {}
    structured_output: dict[str, Any] | None = None
    parse_errors: list[str] = []
    fallback_reason: str | None = None
    codex_metadata: dict[str, Any] = {}

    async def apply_runtime_command(
        speak: str,
        actions: list[dict[str, Any]],
        reasoning_profile: str | None,
        debug: dict[str, Any],
    ) -> str:
        nonlocal runtime_profile, runtime_actions, runtime_action_status, selected_profile, structured_output, codex_metadata, provider, model, response_source
        runtime_actions = [dict(action) for action in actions]
        selected_profile = reasoning_profile or selected_profile
        structured_output = {
            "speak": speak,
            "runtime_actions": runtime_actions,
            "reasoning_profile": reasoning_profile,
            "debug": debug,
        }
        runtime_profile.setdefault("debug", {})["last_llm_structured_output"] = structured_output
        runtime_profile.setdefault("debug", {})["structured_output_parse_errors"] = []
        for action in runtime_actions:
            record_event(
                "voice_runtime_action_started",
                role="system",
                payload={
                    "event": "voice_runtime_action_started",
                    "tool": action.get("tool"),
                    "action": action,
                },
            )
        execution = await execute_voice_runtime_actions(
            db=db,
            settings=settings,
            profile=runtime_profile,
            actions=runtime_actions,
            conversation_id=cid,
            user_text=text,
            transcript=recorder.transcript(),
        )
        runtime_profile = execution.profile
        runtime_action_status = execution.statuses
        codex_metadata = execution.codex
        if codex_metadata:
            provider = "codex-orchestrator"
            model = "codexa-http"
            response_source = "codex-orchestrator"
        for status in runtime_action_status:
            record_event(
                "voice_runtime_action_completed",
                role="system",
                payload={"event": "voice_runtime_action_completed", **status},
            )
        return execution.response_text or speak or "I updated the voice runtime."

    codex_session_active = has_codex_orchestrator_session(db, cid)
    if is_voice_tool_request(text, settings) or codex_session_active:
        reservation_id = agent.cost_guard.reserve(
            agent.cost_guard.reserve_amount_for_provider(settings.llm_provider),
            source="voice_runtime_command",
            provider=settings.llm_provider,
            model=settings.active_model,
            metadata={"conversation_id": cid, "channel": "browser_voice_text", "assumed_stt": True},
        )
        try:
            result = await asyncio.wait_for(
                agent.llm.generate(
                    agent.history(cid),
                    runtime_command_context(
                        runtime_profile,
                        settings,
                        text,
                        codex_session_active=codex_session_active,
                    ),
                ),
                timeout=settings.voice_runtime_command_timeout_seconds,
            )
        except Exception as exc:
            agent.cost_guard.release(reservation_id, {"error": type(exc).__name__})
            response_source = "voice-runtime-error"
            provider = "llm-error"
            model = settings.active_model
            raw_result = {"error_type": type(exc).__name__}
            fallback_reason = type(exc).__name__
            llm_completed_at = time.perf_counter()
        else:
            actual_cost = agent.cost_guard.estimate_llm_call(result.provider, result.raw)
            agent.cost_guard.finalize(
                reservation_id,
                actual_cost,
                units=result.raw.get("usage", {}),
                metadata={"conversation_id": cid, "channel": "browser_voice_text", "assumed_stt": True},
            )
            provider = result.provider
            model = result.model
            latency_ms = result.latency_ms
            response_source = "voice-runtime-tools"
            parsed = parse_voice_runtime_command(result.text)
            raw_result = {**dict(result.raw), "model_text": result.text}
            if parsed.ok and parsed.command:
                command = parsed.command
                response_text = await apply_runtime_command(
                    command.speak,
                    [dict(action) for action in command.runtime_actions],
                    command.reasoning_profile,
                    command.debug,
                )
                if runtime_actions and not any(
                    status.get("status") == "completed" for status in runtime_action_status
                ) and not codex_metadata:
                    fallback_reason = "runtime_actions_rejected"
                raw_result["structured_output"] = structured_output
            else:
                parse_errors = parsed.errors or ["structured_output_parse_failed"]
                runtime_profile.setdefault("debug", {})["structured_output_parse_errors"] = parse_errors
                raw_result["structured_output_parse_errors"] = parse_errors
                fallback_reason = ",".join(parse_errors)
        if fallback_reason:
            fallback_command = fallback_runtime_command_for_request(
                text,
                runtime_profile,
                settings,
                reason=fallback_reason,
                codex_session_active=codex_session_active,
            )
            if fallback_command:
                response_text = await apply_runtime_command(
                    fallback_command.speak,
                    [dict(action) for action in fallback_command.runtime_actions],
                    fallback_command.reasoning_profile,
                    fallback_command.debug,
                )
                raw_result["fallback_structured_output"] = structured_output
                response_source = "voice-runtime-tools"
                if provider == "llm-error":
                    provider = "runtime-fallback"
                    model = "runtime-fallback"
            else:
                response_text = "I'm having trouble updating the voice runtime right now."
        save_runtime_profile(db, runtime_profile)
        llm_completed_at = time.perf_counter()
    elif mode == "flow":
        latest_run = None if flow_run_id else flow_runtime.latest_run_for_conversation(cid)
        active_run_id = flow_run_id or (
            latest_run["run_id"] if latest_run and latest_run.get("status") == "active" else None
        )
        flow_result = await flow_runtime.handle_message(
            flow_id=resolved_flow_id,
            message=text,
            run_id=active_run_id,
            force_interrupt=force_interrupt,
            conversation_id=cid,
        )
        messages = flow_result.get("messages") or []
        response_text = next(
            (
                str(item.get("text") or "").strip()
                for item in reversed(messages)
                if str(item.get("text") or "").strip()
            ),
            "I understand. What should happen next?",
        )
        response_source = "flow-runtime"
        provider = "flow-runtime"
        model = selected_model
        latency_ms = next(
            (
                int(item.get("latency_ms"))
                for item in reversed(messages)
                if isinstance(item.get("latency_ms"), int)
            ),
            0,
        )
        response_voice = next(
            (
                item.get("voice")
                for item in reversed(messages)
                if isinstance(item.get("voice"), Mapping)
            ),
            None,
        )
        if isinstance(response_voice, Mapping):
            recorder.update_metadata(
                {
                    "voice_flow_node_tone": response_voice.get("tone"),
                    "voice_speed": response_voice.get("speed"),
                    "voice_speed_label": voice_speed_label(float(response_voice.get("speed") or 1.0)),
                }
            )
        llm_completed_at = time.perf_counter()
    else:
        reservation_id = agent.cost_guard.reserve(
            agent.cost_guard.reserve_amount_for_provider(settings.llm_provider),
            source="llm_call",
            provider=settings.llm_provider,
            model=settings.active_model,
            metadata={"conversation_id": cid, "channel": "browser_voice_text", "assumed_stt": True},
        )
        try:
            result = await agent.llm.generate(
                agent.history(cid),
                build_runtime_system_prompt(prompt.compiled),
            )
        except Exception as exc:
            agent.cost_guard.release(reservation_id, {"error": type(exc).__name__})
            response_text = (
                "I'm having trouble reaching the language model right now. "
                "Please try again in a moment."
            )
            response_source = "llm-error"
            provider = "llm-error"
            model = settings.active_model
            raw_result = {"error_type": type(exc).__name__}
            llm_completed_at = time.perf_counter()
        else:
            actual_cost = agent.cost_guard.estimate_llm_call(result.provider, result.raw)
            agent.cost_guard.finalize(
                reservation_id,
                actual_cost,
                units=result.raw.get("usage", {}),
                metadata={"conversation_id": cid, "channel": "browser_voice_text", "assumed_stt": True},
            )
            response_text = result.text
            response_text = repair_long_form_response(text, response_text) or response_text
            response_source = "llm"
            provider = result.provider
            model = result.model
            raw_result = result.raw
            latency_ms = result.latency_ms
            llm_completed_at = time.perf_counter()

    record_event(
        "llm_request_started",
        role="system",
        payload={
            "event": "llm_request_started",
            "model_profile": selected_profile,
            "model": model,
            "source": response_source,
        },
    )
    record_event(
        "llm_completed",
        role="assistant",
        text_value=response_text,
        payload={
            "event": "llm_completed",
            "provider": provider,
            "model": model,
            "source": response_source,
            "latency_ms": latency_ms or _ms(llm_started_at, llm_completed_at),
        },
    )

    if tone_intent:
        emotion_code = emotion_code_for_tone(tone_intent)
        emotion = tone_intent
    else:
        emotion_code = emotion_code_for_turn(text, response_text)
        emotion = {
            "N": "neutral",
            "F": "friendly",
            "C": "careful",
            "P": "confident",
            "S": "sympathetic",
            "E": "energetic",
        }.get(emotion_code, "neutral")
    rendered = render_expression_tags(response_text, runtime_profile, user_text=text)
    clean_text = str(rendered.get("clean_text") or response_text).strip()
    rendered_text = str(rendered.get("rendered_text") or clean_text).strip()
    tts_started_at = time.perf_counter()
    tts_completed_at = tts_started_at
    tts_params = _tts_params(settings, runtime_profile, rendered)
    runtime_profile.setdefault("debug", {})["last_tts_rendered_text"] = rendered_text
    runtime_profile.setdefault("debug", {})["last_supertonic_payload"] = (
        {
            "text": rendered_text,
            **tts_params,
        }
        if settings.local_tts_provider == "supertonic"
        else None
    )
    save_runtime_profile(db, runtime_profile)
    record_event(
        "tts_simulated",
        role="assistant",
        text_value=rendered_text,
        payload={
            "event": "tts_simulated",
            "provider": settings.local_tts_provider,
            "rendered_text": rendered_text,
            "clean_text": clean_text,
            "tts_params": tts_params,
        },
    )

    timings = {
        "user_speech_started_at": started_at,
        "user_speech_stopped_at": started_at,
        "transcription_started_at": started_at,
        "transcription_completed_at": transcript_at,
        "llm_request_started_at": llm_started_at,
        "llm_first_token_at": llm_completed_at,
        "llm_completed_at": llm_completed_at,
        "tts_request_started_at": tts_started_at,
        "tts_first_audio_at": tts_completed_at,
        "tts_completed_at": tts_completed_at,
        "interaction_completed_at": tts_completed_at,
        "vad_speech_ms": 0,
        "stt_after_speech_end_ms": 0,
        "stt_after_speech_start_ms": 0,
        "stt_provider_elapsed_ms": 0,
        "stt_latency_ms": 0,
        "turn_finalization_ms": _ms(transcript_at, llm_started_at),
        "llm_ttfb_ms": _ms(llm_started_at, llm_completed_at),
        "llm_total_ms": latency_ms or _ms(llm_started_at, llm_completed_at),
        "tts_ttfb_from_first_text_ms": 0,
        "tts_ttfb_ms": 0,
        "tts_total_ms": 0,
        "speech_end_to_first_text_ms": _ms(started_at, llm_completed_at),
        "speech_end_to_first_audio_ms": _ms(started_at, tts_completed_at),
        "speech_start_to_first_audio_ms": _ms(started_at, tts_completed_at),
        "transcript_to_first_text_ms": _ms(transcript_at, llm_completed_at),
        "transcript_to_first_audio_ms": _ms(transcript_at, tts_completed_at),
        "transcript_to_response_done_ms": _ms(transcript_at, tts_completed_at),
        "total_interaction_ms": _ms(started_at, tts_completed_at),
        "total_first_audio_ms": _ms(started_at, tts_completed_at),
        "first_response_ms": _ms(started_at, llm_completed_at),
        "tts_audio_chunk_count": 0,
        "interrupted": force_interrupt,
        "vad_starts": 0,
        "vad_stops": 0,
        "interruptions": 1 if force_interrupt else 0,
        "duplicate_vad_events": 0,
        "duplicate_interruption_events": 0,
        "empty_llm_completions": 0 if clean_text else 1,
        "duplicate_interruptions_prevented": 0,
        "structured_output_expected": bool(runtime_actions),
        "structured_output_parse_errors": parse_errors,
        "assumed_stt": True,
        "tts_simulated": True,
    }
    providers = {
        "stt_provider": "assumed_text",
        "configured_stt_provider": settings.local_stt_provider,
        "stt_model": settings.local_stt_model,
        "stt_language": settings.local_stt_language,
        "tts_provider": settings.local_tts_provider,
        "configured_tts_provider": settings.local_tts_provider,
        "tts_voice": settings.local_tts_voice,
        "tts_text_aggregation_mode": settings.local_tts_text_aggregation_mode,
        "llm_provider": provider,
        "configured_llm_provider": settings.llm_provider,
        "llm_model": model,
        "llm_model_profile": selected_profile,
        "tts_params": tts_params,
        "expression_tags_used": list(rendered.get("expression_tags_used") or []),
        "unsupported_expression_tags": list(rendered.get("unsupported_expression_tags") or []),
        "runtime_actions": runtime_actions,
        "runtime_action_status": runtime_action_status,
        "codex_orchestrator": codex_metadata,
        "voice_speech_path": settings.voice_speech_path,
        "voice_behavior_mode": mode,
        "voice_flow_id": resolved_flow_id,
        "input_mode": effective_input_mode,
        "assumed_stt": True,
        "tts_simulated": True,
    }
    if codex_metadata:
        providers.update(
            {
                "codex_session_id": codex_metadata.get("codex_session_id"),
                "codex_project_id": codex_metadata.get("codex_project_id"),
                "codex_task_id": codex_metadata.get("codex_task_id"),
                "codex_worker_id": codex_metadata.get("codex_worker_id"),
                "requires_approval": codex_metadata.get("requires_approval"),
                "approval_id": codex_metadata.get("approval_id"),
                "runtime_action_source": response_source,
            }
        )
    assistant_turn_id = recorder.record_turn(
        "assistant",
        clean_text,
        latency_ms=timings["speech_end_to_first_audio_ms"],
        metrics={
            "interaction_id": interaction_id,
            "source": "voice_text_test",
            "provider": provider,
            "raw": raw_result,
            "voice_behavior_mode": mode,
            "voice_flow_id": resolved_flow_id,
            "voice_flow_run_id": flow_result.get("run_id") if flow_result else None,
            "voice_speed": tts_params.get("speed"),
            "voice_speed_label": voice_speed_label(float(tts_params.get("speed") or 1.0)),
            "voice_emotion_code": emotion_code,
            "voice_emotion": emotion,
            "codex_orchestrator": codex_metadata,
            **providers,
            **timings,
        },
    )

    learning_record = build_learning_record(
        session_id=cid,
        turn_id=assistant_turn_id or user_turn_id or interaction_id,
        input_mode=effective_input_mode,
        user_transcript=text,
        assistant_response_clean=clean_text,
        tts_rendered_text=rendered_text,
        model_profile=selected_profile,
        model_used=model,
        tts_provider=settings.local_tts_provider,
        tts_params=tts_params,
        latency=timings,
        events={
            "vad_starts": 0,
            "vad_stops": 0,
            "interruptions": 1 if force_interrupt else 0,
            "duplicate_vad_events": 0,
            "duplicate_interruption_events": 0,
            "empty_llm_completions": 0 if clean_text else 1,
        },
        quality_signals=_quality_signals(likely_bad=likely_bad, interrupted=force_interrupt),
        runtime_profile_snapshot=runtime_profile,
    )
    failures = classify_voice_turn(learning_record, runtime_profile)
    learning_record["quality_signals"]["failure_types"] = failures
    learning_record["quality_signals"]["failure_type"] = next(
        (failure for failure in failures if failure != "successful_turn"),
        None,
    )
    record_event(
        "interaction_learning_log",
        role="assistant",
        text_value=clean_text,
        payload=learning_record,
    )
    runtime_profile = apply_runtime_adaptation(runtime_profile, failures, learning_record)
    save_runtime_profile(db, runtime_profile)
    latency_trace_id = recorder.record_latency_trace(
        interaction_id=interaction_id,
        user_turn_id=user_turn_id,
        assistant_turn_id=assistant_turn_id,
        providers=providers,
        timings=timings,
    )
    record_event(
        "interaction_completed",
        role="assistant",
        text_value=clean_text,
        payload={
            "event": "interaction_completed",
            "latency_trace_id": latency_trace_id,
            "failure_types": failures,
            "providers": providers,
            "timings": timings,
        },
    )

    return {
        "conversation_id": cid,
        "interaction_id": interaction_id,
        "user_turn_id": user_turn_id,
        "assistant_turn_id": assistant_turn_id,
        "message": clean_text,
        "latency_ms": timings["speech_end_to_first_audio_ms"],
        "model": model,
        "provider": provider,
        "prompt_version": prompt.version,
        "mode": mode,
        "input": {
            "text": text,
            "assumed_stt": True,
            "input_mode": effective_input_mode,
            "force_interrupt": force_interrupt,
        },
        "tts": {
            "simulated": True,
            "provider": settings.local_tts_provider,
            "clean_text": clean_text,
            "rendered_text": rendered_text,
            "params": tts_params,
            "expression_tags_used": list(rendered.get("expression_tags_used") or []),
            "unsupported_expression_tags": list(rendered.get("unsupported_expression_tags") or []),
        },
        "runtime_actions": runtime_actions,
        "runtime_action_status": runtime_action_status,
        "codex": codex_metadata,
        "flow": flow_result,
        "providers": providers,
        "timings": timings,
        "latency_trace_id": latency_trace_id,
        "events_recorded": events_recorded,
        "learning_failures": failures,
        "runtime_profile": voice_runtime_status(runtime_profile),
        "cost_guard": agent.cost_guard.snapshot().to_dict(),
    }


async def run_voice_text_suite(
    *,
    conversation_id: str | None,
    settings: Settings,
    db: Database,
    prompt_repo: PromptRepository,
    agent: AgentService,
    flow_runtime: FlowRuntime,
    cases: list[dict[str, Any]] | None = None,
    voice_behavior_mode: str | None = None,
    voice_flow_id: str | None = None,
    input_mode: str | None = "push_to_talk",
) -> dict[str, Any]:
    suite_cases = cases or DEFAULT_VOICE_TEXT_TEST_CASES
    cid = conversation_id or str(uuid.uuid4())
    results: list[dict[str, Any]] = []
    for index, case in enumerate(suite_cases):
        turn = await run_voice_text_turn(
            message=str(case.get("message") or ""),
            conversation_id=cid,
            settings=settings,
            db=db,
            prompt_repo=prompt_repo,
            agent=agent,
            flow_runtime=flow_runtime,
            voice_behavior_mode=str(case.get("voice_behavior_mode") or voice_behavior_mode or ""),
            voice_flow_id=str(case.get("voice_flow_id") or voice_flow_id or settings.voice_flow_id),
            input_mode=str(case.get("input_mode") or input_mode or "push_to_talk"),
            force_interrupt=bool(case.get("force_interrupt")),
            flow_run_id=case.get("flow_run_id") if isinstance(case.get("flow_run_id"), str) else None,
        )
        passed, checks = _validate_suite_case(case, turn)
        results.append(
            {
                "id": str(case.get("id") or f"case-{index + 1}"),
                "message": case.get("message"),
                "voice_behavior_mode": turn["mode"],
                "passed": passed,
                "checks": checks,
                "turn": turn,
            }
        )

    passed_count = sum(1 for result in results if result["passed"])
    total_count = len(results)
    return {
        "conversation_id": cid,
        "status": "passed" if passed_count == total_count else "failed",
        "passed": passed_count == total_count,
        "summary": {
            "passed": passed_count,
            "failed": total_count - passed_count,
            "total": total_count,
        },
        "cases": results,
    }
