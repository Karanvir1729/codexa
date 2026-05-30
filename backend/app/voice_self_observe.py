from __future__ import annotations

import json
import re
import time
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Mapping

from .codex_orchestrator import (
    CODEX_ORCHESTRATOR_RUNTIME_TOOLS,
    is_codex_orchestrator_request,
    is_codex_status_request,
)
from .config import Settings
from .db import Database, dumps, loads
from .voice_runtime_controls import normalize_for_intent, voice_speed_intent

VoiceInputMode = Literal["vad", "push_to_talk"]
VoiceModelProfile = Literal["fast", "balanced", "reasoning"]
ExpressionMode = Literal["off", "subtle", "demo", "debug"]
ResponseLength = Literal["short", "medium", "long"]

RUNTIME_PROFILE_KEY = "agent_runtime_profile"
SUPERTONIC_DISCOVERY_SOURCES = [
    "/private/tmp/voice-agent-voice-venv/lib/python3.12/site-packages/supertonic-1.3.1.dist-info/METADATA:329",
    "/Users/meharkhanna/.cache/supertonic3/README.md:86",
]

# Local discovery found examples for these tags. The installed package metadata
# says 10 tags exist, but it does not list the other seven, so keep the
# allowlist to locally evidenced tags only.
DISCOVERED_SUPERTONIC_EXPRESSION_TAGS = ["breath", "laugh", "sigh"]

SIMPLE_GREETING_WORDS = {"hi", "hello", "hey", "okay", "ok", "thanks", "thank", "yo"}
REASONING_HINTS = {
    "debug",
    "fix",
    "implement",
    "code",
    "architecture",
    "design",
    "analyze",
    "investigate",
    "test",
    "deploy",
    "database",
    "api",
    "tool",
    "trace",
    "latency",
}
SERIOUS_HINTS = {
    "emergency",
    "urgent",
    "medical",
    "doctor",
    "legal",
    "lawyer",
    "financial",
    "bank",
    "unsafe",
    "scared",
    "afraid",
    "angry",
    "frustrated",
    "problem",
    "failed",
    "broken",
}

TAG_RE = re.compile(r"</?([A-Za-z_][A-Za-z0-9_-]*)(?:\s[^>]*)?>")
ALLOWED_RUNTIME_TOOLS = {
    "set_tts_speed",
    "increment_tts_speed",
    "set_expression_mode",
    "set_response_length",
    "set_model_profile",
    "get_voice_runtime_status",
    *CODEX_ORCHESTRATOR_RUNTIME_TOOLS,
}
ALLOWED_EXPRESSION_MODES = {"off", "subtle", "demo"}
ALLOWED_RESPONSE_LENGTHS = {"short", "medium", "long"}
ALLOWED_MODEL_PROFILES = {"fast", "balanced", "reasoning"}
LEGACY_HEAVY_VOICE_MODELS = {
    "mistralai/mistral-nemotron",
    "mistralai/mistral-medium-3.5-128b",
    "mistralai/mistral-small-4-119b-2603",
    "mistralai/mistral-large-3-675b-instruct-2512",
}
SPOKEN_CONTROL_PREFIX_RE = re.compile(r"^\s*[NFCPSE]\|\s*")


@dataclass
class VoiceRuntimeCommand:
    speak: str
    runtime_actions: list[dict[str, Any]] = field(default_factory=list)
    reasoning_profile: VoiceModelProfile | None = None
    debug: dict[str, Any] = field(default_factory=dict)
    raw: str = ""


@dataclass
class VoiceRuntimeParseResult:
    command: VoiceRuntimeCommand | None
    errors: list[str] = field(default_factory=list)
    repair_attempted: bool = False
    repaired_raw: str | None = None

    @property
    def ok(self) -> bool:
        return self.command is not None and not self.errors


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def clamp_number(value: Any, default: float, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return max(minimum, min(maximum, float(value)))


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return max(minimum, min(maximum, value))


def clamp_supertonic_params(params: Mapping[str, Any]) -> dict[str, Any]:
    response_format = str(params.get("response_format") or "wav").strip().lower()
    if response_format not in {"wav", "flac", "ogg"}:
        response_format = "wav"
    return {
        "voice": str(params.get("voice") or "M1"),
        "lang": str(params.get("lang") or "en"),
        "speed": round(clamp_number(params.get("speed"), 1.05, 0.7, 2.0), 2),
        "steps": clamp_int(params.get("steps"), 8, 1, 100),
        "max_chunk_length": clamp_int(params.get("max_chunk_length"), 300, 1, 10000),
        "silence_duration": round(clamp_number(params.get("silence_duration"), 0.3, 0.0, 10.0), 2),
        "response_format": response_format,
    }


def natural_tts_speed_bounds(settings: Settings) -> tuple[float, float]:
    return (
        max(0.7, min(2.0, settings.voice_natural_tts_speed_min)),
        max(0.7, min(2.0, settings.voice_natural_tts_speed_max)),
    )


def clamp_live_tts_speed(settings: Settings, speed: Any) -> float:
    hard = clamp_number(speed, settings.supertonic_speed, 0.7, 2.0)
    if settings.voice_allow_hard_tts_speed_range:
        return round(hard, 2)
    natural_min, natural_max = natural_tts_speed_bounds(settings)
    return round(max(natural_min, min(natural_max, hard)), 2)


def default_runtime_profile(settings: Settings) -> dict[str, Any]:
    return {
        "profile_version": 1,
        "last_updated_at": now_iso(),
        "active_model_profile": settings.voice_default_profile,
        "input_mode": "vad",
        "llm": {
            "fast_model": settings.voice_fast_model,
            "balanced_model": settings.voice_balanced_model or settings.active_model,
            "reasoning_model": settings.voice_reasoning_model,
            "current_model": None,
            "reasoning_budget": "low",
            "max_output_tokens": min(settings.max_completion_tokens, 128),
            "temperature": settings.llm_temperature,
        },
        "tts": {
            "provider": "supertonic",
            "base_url": settings.supertonic_base_url,
            "endpoint": settings.supertonic_endpoint,
            "model": settings.supertonic_model,
            "voice": settings.supertonic_voice,
            "lang": settings.supertonic_language,
            "speed": settings.supertonic_speed,
            "steps": settings.supertonic_steps,
            "max_chunk_length": settings.supertonic_max_chunk_length,
            "silence_duration": settings.supertonic_silence_duration,
            "response_format": settings.supertonic_response_format,
            "expression_mode": settings.supertonic_expression_mode,
            "allowed_expression_tags": list(DISCOVERED_SUPERTONIC_EXPRESSION_TAGS),
            "expression_tag_sources": list(SUPERTONIC_DISCOVERY_SOURCES),
            "max_expression_tags_per_utterance": settings.supertonic_max_expression_tags_per_utterance,
        },
        "latency": {
            "target_first_audio_ms": settings.voice_target_first_audio_ms,
            "target_llm_ttfb_ms": settings.voice_max_llm_ttfb_ms,
            "last_llm_ttfb_ms": None,
            "last_tts_ttfb_ms": None,
            "last_first_audio_ms": None,
            "rolling_avg_first_audio_ms": None,
            "rolling_avg_llm_ttfb_ms": None,
            "rolling_avg_tts_ttfb_ms": None,
        },
        "turn_taking": {
            "vad_enabled": True,
            "push_to_talk_enabled": False,
            "vad_debounce_ms": settings.voice_vad_debounce_ms,
            "interruption_debounce_ms": settings.voice_interruption_debounce_ms,
            "clarification_on_low_stt_confidence": True,
            "duplicate_interruptions_prevented": 0,
        },
        "quality": {
            "recent_failure_types": [],
            "tool_failure_rate": 0,
            "stt_confidence_avg": None,
            "user_correction_rate": 0,
        },
        "response": {
            "length": "short",
        },
        "debug": {
            "last_llm_structured_output": None,
            "last_runtime_actions": [],
            "last_runtime_action_status": [],
            "last_supertonic_payload": None,
            "last_tts_rendered_text": None,
            "structured_output_parse_errors": [],
            "last_runtime_status": None,
        },
        "last_profile_change": None,
        "last_turn": None,
    }


def merge_runtime_profile(settings: Settings, stored: Mapping[str, Any] | None) -> dict[str, Any]:
    profile = default_runtime_profile(settings)
    if isinstance(stored, Mapping):
        _deep_update(profile, stored)
    llm = profile.setdefault("llm", {})
    if isinstance(llm, dict):
        llm["fast_model"] = settings.voice_fast_model
        llm["balanced_model"] = settings.voice_balanced_model or settings.active_model
        llm["reasoning_model"] = settings.voice_reasoning_model
        if llm.get("fast_model") in LEGACY_HEAVY_VOICE_MODELS:
            llm["fast_model"] = settings.voice_fast_model or settings.active_model
        if llm.get("balanced_model") in LEGACY_HEAVY_VOICE_MODELS:
            llm["balanced_model"] = settings.voice_balanced_model or settings.active_model
        if llm.get("reasoning_model") in LEGACY_HEAVY_VOICE_MODELS:
            llm["reasoning_model"] = settings.voice_reasoning_model or settings.active_model
        active_profile = str(profile.get("active_model_profile") or settings.voice_default_profile)
        if active_profile == "fast":
            llm["current_model"] = llm.get("fast_model") or settings.voice_fast_model or settings.active_model
        elif active_profile == "reasoning":
            llm["current_model"] = (
                llm.get("reasoning_model") or settings.voice_reasoning_model or settings.active_model
            )
        else:
            llm["current_model"] = (
                llm.get("balanced_model") or settings.voice_balanced_model or settings.active_model
            )
    profile["tts"]["allowed_expression_tags"] = list(DISCOVERED_SUPERTONIC_EXPRESSION_TAGS)
    profile["tts"]["expression_tag_sources"] = list(SUPERTONIC_DISCOVERY_SOURCES)
    profile["tts"].update(clamp_supertonic_params(profile.get("tts", {})))
    profile["latency"]["target_first_audio_ms"] = settings.voice_target_first_audio_ms
    profile["latency"]["target_llm_ttfb_ms"] = settings.voice_max_llm_ttfb_ms
    return profile


def voice_runtime_status(profile: Mapping[str, Any]) -> dict[str, Any]:
    tts = profile.get("tts") if isinstance(profile.get("tts"), Mapping) else {}
    llm = profile.get("llm") if isinstance(profile.get("llm"), Mapping) else {}
    return {
        "tts_provider": tts.get("provider", "supertonic"),
        "tts_voice": tts.get("voice", "M1"),
        "tts_speed": tts.get("speed", 1.05),
        "tts_steps": tts.get("steps", 8),
        "expression_mode": tts.get("expression_mode", "off"),
        "model_profile": profile.get("active_model_profile", "balanced"),
        "current_model": llm.get("current_model"),
        "response_length": (
            profile.get("response", {}).get("length", "short")
            if isinstance(profile.get("response"), Mapping)
            else "short"
        ),
    }


def runtime_command_context(
    profile: Mapping[str, Any],
    settings: Settings,
    user_text: str = "",
    *,
    codex_session_active: bool = False,
) -> str:
    tts = profile.get("tts") if isinstance(profile.get("tts"), Mapping) else {}
    response = profile.get("response") if isinstance(profile.get("response"), Mapping) else {}
    natural_min, natural_max = natural_tts_speed_bounds(settings)
    allowed_tags = ", ".join(f"<{tag}>" for tag in tts.get("allowed_expression_tags") or [])
    speed_intent = voice_speed_intent(user_text)
    codex_enabled = settings.codex_orchestrator_enabled
    if speed_intent in {"slower", "very_slow"}:
        speed_guidance = (
            "The current request asks for slower speech. Choose exactly one TTS speed action "
            "that lowers the speed, either increment_tts_speed with a negative delta or "
            "set_tts_speed with a speed below the current speed."
        )
    elif speed_intent in {"faster", "very_fast"}:
        speed_guidance = (
            "The current request asks for faster speech. Choose exactly one TTS speed action "
            "that raises the speed, either increment_tts_speed with a positive delta or "
            "set_tts_speed with a speed above the current speed."
        )
    elif speed_intent == "normal":
        speed_guidance = "The current request asks for normal speech speed. Use set_tts_speed with speed 1.0."
    elif codex_enabled and is_codex_status_request(user_text):
        speed_guidance = "The current request asks about Codex state. Choose get_codex_orchestrator_status."
    elif codex_enabled and codex_session_active:
        speed_guidance = (
            "There is an active Codex planning session for this voice conversation. "
            "Choose delegate_to_codex_orchestrator for this user turn, preserving the user's exact answer or instruction. "
            "Do not choose any TTS speed action unless the current user request explicitly asks to speak faster or slower."
        )
    elif codex_enabled and is_codex_orchestrator_request(user_text):
        speed_guidance = (
            "The current request is a coding/project task or Codex approval follow-up. "
            "Choose delegate_to_codex_orchestrator with mode plan_first and a concise goal copied from the user request. "
            "For this request, delegate_to_codex_orchestrator is required and TTS speed tools are invalid unless the user also asks to speak faster or slower."
        )
    else:
        speed_guidance = "If the current request does not require a runtime change, use an empty runtime_actions array."
    codex_tools = ""
    if codex_enabled:
        codex_tools = (
            "\nCodex tool shapes: "
            '{"tool":"delegate_to_codex_orchestrator","args":{"goal":"user_goal","mode":"plan_first","reason":"brief_reason"}} '
            'or {"tool":"get_codex_orchestrator_status","args":{"reason":"brief_reason"}}. '
            "Use delegate_to_codex_orchestrator when the user asks to build, fix, implement, create, update, test, or continue a coding/project task. "
            "Use get_codex_orchestrator_status when the user asks what Codex is doing, what changed, or what approval is pending. "
            "For approve/deny follow-ups, delegate the exact user response as the goal."
        )
    allowed_tool_names = [
        "set_tts_speed",
        "increment_tts_speed",
        "set_expression_mode",
        "set_response_length",
        "set_model_profile",
        "get_voice_runtime_status",
    ]
    if codex_enabled:
        allowed_tool_names.extend(sorted(CODEX_ORCHESTRATOR_RUNTIME_TOOLS))
    return f"""Voice runtime protocol for this turn. Return valid JSON only. Do not answer the user directly in this protocol; choose runtime tools.
Current user request: {user_text[:500]!r}
Runtime: provider={tts.get("provider", "supertonic")}, voice={tts.get("voice", "M1")}, speed={tts.get("speed", 1.05)} range=0.7-2.0 natural={natural_min}-{natural_max}, steps={tts.get("steps", 8)}, expression_mode={tts.get("expression_mode", "off")}, tags={allowed_tags or "none"}, response_length={response.get("length", "short")}, model_profile={profile.get("active_model_profile", "balanced")}.
Return object keys: speak, runtime_actions, reasoning_profile, debug.
Allowed tool names: {", ".join(allowed_tool_names)}.
Action object shape: {{"tool":"set_tts_speed","args":{{"speed":1.0,"reason":"brief_reason"}}}} or {{"tool":"increment_tts_speed","args":{{"delta":0.2,"reason":"brief_reason"}}}}.
Required args by tool: set_tts_speed needs speed:number and reason:string; increment_tts_speed needs delta:number and reason:string; set_expression_mode needs mode:"off|subtle|demo" and reason:string; set_response_length needs length:"short|medium|long" and reason:string; set_model_profile needs profile:"fast|balanced|reasoning" and reason:string; get_voice_runtime_status needs reason:string.
{codex_tools}
{speed_guidance}
Canonical slower example: {{"speak":"Sure, I'll talk slower.","runtime_actions":[{{"tool":"increment_tts_speed","args":{{"delta":-0.2,"reason":"user_requested_slower_speech"}}}}],"reasoning_profile":"fast","debug":{{"intent":"runtime_control"}}}}.
Canonical faster example: {{"speak":"Sure, I'll talk faster.","runtime_actions":[{{"tool":"increment_tts_speed","args":{{"delta":0.2,"reason":"user_requested_faster_speech"}}}}],"reasoning_profile":"fast","debug":{{"intent":"runtime_control"}}}}.
Canonical Codex example: {{"speak":"I'll route that to Codex planning.","runtime_actions":[{{"tool":"delegate_to_codex_orchestrator","args":{{"goal":"user_goal","mode":"plan_first","reason":"user_requested_codex_planning"}}}}],"reasoning_profile":"reasoning","debug":{{"intent":"codex_orchestrator_delegate"}}}}.
Rules: The current user request is authoritative; do not copy runtime_actions from prior turns. voice/audio/talking speed changes use TTS speed tools, not model_profile. model_profile only changes LLM strength. Short follow-ups like faster/fastest/slower should follow recent context; if that context is speech speed, choose a numeric TTS speed or delta within range. `speed` is an absolute multiplier and must never be negative; use a negative `delta` for slower speech. Runtime-change requests must include an action. Never return a bare tool object; always return the full object with speak and runtime_actions. Never put <tags> in speak; expression tags are added later by the renderer. Keep speak short.
Choose runtime_actions yourself from the current user request and runtime state. If the current request mentions Codex or asks for a coding/project task, include delegate_to_codex_orchestrator."""


def _strip_json_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, flags=re.IGNORECASE)
        stripped = re.sub(r"\s*```$", "", stripped)
    return stripped.strip()


def _extract_json_object(text: str) -> str | None:
    candidate = _strip_json_fence(text)
    if candidate.startswith("{") and candidate.endswith("}"):
        return candidate
    start = candidate.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for index, char in enumerate(candidate[start:], start=start):
        if escape:
            escape = False
            continue
        if char == "\\":
            escape = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return candidate[start : index + 1]
    return None


def _repair_runtime_json_candidate(candidate: str) -> str | None:
    if '"runtime_actions"' not in candidate or '"args"' not in candidate:
        return None
    repaired = re.sub(
        r'("args"\s*:\s*\{(?:[^{}]|\{[^{}]*\})*\})\s*\]',
        r"\1}]",
        candidate,
        flags=re.DOTALL,
    )
    return repaired if repaired != candidate else None


def parse_voice_runtime_command(raw_text: str) -> VoiceRuntimeParseResult:
    errors: list[str] = []
    candidate = _extract_json_object(raw_text)
    if not candidate:
        return VoiceRuntimeParseResult(
            command=None,
            errors=["structured_output_parse_failed:no_json_object"],
        )
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError as exc:
        repaired = _repair_runtime_json_candidate(candidate)
        if not repaired:
            return VoiceRuntimeParseResult(
                command=None,
                errors=[f"structured_output_parse_failed:{exc.msg}"],
            )
        try:
            payload = json.loads(repaired)
        except json.JSONDecodeError:
            return VoiceRuntimeParseResult(
                command=None,
                errors=[f"structured_output_parse_failed:{exc.msg}"],
            )
        candidate = repaired
    if not isinstance(payload, dict):
        return VoiceRuntimeParseResult(command=None, errors=["schema_invalid:not_object"])
    if "runtime_actions" not in payload and isinstance(
        payload.get("tool") or payload.get("name") or payload.get("function") or payload.get("tool_name"),
        str,
    ):
        bare_action = dict(payload)
        payload = {
            "speak": payload.get("speak") or "I updated the voice runtime.",
            "runtime_actions": [bare_action],
            "reasoning_profile": payload.get("reasoning_profile"),
            "debug": {"normalized_bare_tool_action": True},
        }
    speak = payload.get("speak")
    if not isinstance(speak, str) or not speak.strip():
        errors.append("schema_invalid:speak_required")
        speak = ""
    speak_clean, _kept, stripped_tags = clean_angle_tags(speak, [])
    speak_clean = SPOKEN_CONTROL_PREFIX_RE.sub("", speak_clean).strip()
    raw_actions = payload.get("runtime_actions", [])
    if raw_actions is None:
        raw_actions = []
    if not isinstance(raw_actions, list):
        errors.append("schema_invalid:runtime_actions_not_list")
        raw_actions = []
    actions: list[dict[str, Any]] = []
    for index, action in enumerate(raw_actions):
        if not isinstance(action, dict):
            errors.append(f"schema_invalid:action_{index}_not_object")
            continue
        tool = action.get("tool")
        if not isinstance(tool, str) or not tool.strip():
            # Some hosted models emit OpenAI-style tool-call field names even when
            # instructed to use our compact JSON schema. Normalize known shapes,
            # but still reject unknown tool names during execution.
            tool = action.get("name") or action.get("function") or action.get("tool_name")
        args = action.get("args", None)
        if args is None:
            args = action.get("arguments", None)
        if args is None:
            args = action.get("params", {})
        if isinstance(args, str):
            try:
                decoded_args = json.loads(args)
            except json.JSONDecodeError:
                decoded_args = None
            if isinstance(decoded_args, dict):
                args = decoded_args
        if not isinstance(tool, str) or not tool.strip():
            errors.append(f"schema_invalid:action_{index}_tool_required")
            continue
        if args is None:
            args = {}
        if not isinstance(args, dict):
            errors.append(f"schema_invalid:action_{index}_args_not_object")
            args = {}
        actions.append({"tool": tool.strip(), "args": dict(args)})
    reasoning = payload.get("reasoning_profile")
    if reasoning is not None and reasoning not in ALLOWED_MODEL_PROFILES:
        reasoning = None
    debug = payload.get("debug", {})
    if not isinstance(debug, dict):
        debug = {}
    if errors:
        return VoiceRuntimeParseResult(command=None, errors=errors)
    return VoiceRuntimeParseResult(
        command=VoiceRuntimeCommand(
            speak=speak_clean.strip(),
            runtime_actions=actions,
            reasoning_profile=reasoning,
            debug=debug,
            raw=candidate,
        )
    )


def execute_runtime_actions(
    profile: Mapping[str, Any],
    actions: list[Mapping[str, Any]],
    settings: Settings,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    updated = deepcopy(dict(profile))
    tts = updated.setdefault("tts", {})
    llm = updated.setdefault("llm", {})
    response = updated.setdefault("response", {})
    debug = updated.setdefault("debug", {})
    statuses: list[dict[str, Any]] = []

    for action in actions:
        tool = str(action.get("tool") or "").strip()
        args = action.get("args") if isinstance(action.get("args"), Mapping) else {}
        reason = str(args.get("reason") or "unspecified")
        status: dict[str, Any] = {"tool": tool, "reason": reason, "status": "completed"}
        if tool not in ALLOWED_RUNTIME_TOOLS:
            status.update({"status": "rejected", "error": "unknown_tool"})
            statuses.append(status)
            continue
        if tool in CODEX_ORCHESTRATOR_RUNTIME_TOOLS:
            status.update({"status": "rejected", "error": "requires_async_executor"})
            statuses.append(status)
            continue
        if tool == "set_tts_speed":
            if "speed" not in args:
                status.update({"status": "rejected", "error": "missing_speed"})
                statuses.append(status)
                continue
            old = tts.get("speed", settings.supertonic_speed)
            new = clamp_live_tts_speed(settings, args.get("speed"))
            tts["speed"] = new
            status.update({"old_value": old, "new_value": new, "field": "tts.speed"})
        elif tool == "increment_tts_speed":
            if "delta" not in args:
                status.update({"status": "rejected", "error": "missing_delta"})
                statuses.append(status)
                continue
            old = clamp_number(tts.get("speed"), settings.supertonic_speed, 0.7, 2.0)
            delta = clamp_number(args.get("delta"), 0.0, -1.0, 1.0)
            new = clamp_live_tts_speed(settings, old + delta)
            tts["speed"] = new
            status.update({"old_value": round(old, 2), "new_value": new, "field": "tts.speed"})
        elif tool == "set_expression_mode":
            mode = str(args.get("mode") or "").strip()
            if mode not in ALLOWED_EXPRESSION_MODES:
                status.update({"status": "rejected", "error": "invalid_expression_mode"})
            else:
                old = tts.get("expression_mode", "off")
                tts["expression_mode"] = mode
                status.update({"old_value": old, "new_value": mode, "field": "tts.expression_mode"})
        elif tool == "set_response_length":
            length = str(args.get("length") or "").strip()
            if length not in ALLOWED_RESPONSE_LENGTHS:
                status.update({"status": "rejected", "error": "invalid_response_length"})
            else:
                old = response.get("length", "short")
                response["length"] = length
                status.update({"old_value": old, "new_value": length, "field": "response.length"})
        elif tool == "set_model_profile":
            model_profile = str(args.get("profile") or "").strip()
            if model_profile not in ALLOWED_MODEL_PROFILES:
                status.update({"status": "rejected", "error": "invalid_model_profile"})
            else:
                old = updated.get("active_model_profile", "balanced")
                updated["active_model_profile"] = model_profile
                llm["reasoning_budget"] = "low" if model_profile == "fast" else llm.get("reasoning_budget", "low")
                status.update(
                    {
                        "old_value": old,
                        "new_value": model_profile,
                        "field": "active_model_profile",
                    }
                )
        elif tool == "get_voice_runtime_status":
            status.update({"value": voice_runtime_status(updated), "field": "runtime_status"})
        statuses.append(status)

    debug["last_runtime_actions"] = [dict(action) for action in actions]
    debug["last_runtime_action_status"] = statuses
    debug["last_runtime_status"] = voice_runtime_status(updated)
    updated["tts"].update(clamp_supertonic_params(updated.get("tts", {})))
    return updated, statuses


def load_runtime_profile(db: Database, settings: Settings) -> dict[str, Any]:
    row = db.one("SELECT value_json FROM runtime_settings WHERE key = ?", (RUNTIME_PROFILE_KEY,))
    stored = loads(row["value_json"], {}) if row else {}
    return merge_runtime_profile(settings, stored if isinstance(stored, Mapping) else {})


def save_runtime_profile(db: Database, profile: Mapping[str, Any]) -> None:
    next_profile = deepcopy(dict(profile))
    next_profile["last_updated_at"] = now_iso()
    db.execute(
        """
        INSERT INTO runtime_settings(key, value_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
        """,
        (RUNTIME_PROFILE_KEY, dumps(next_profile)),
    )


def _deep_update(target: dict[str, Any], source: Mapping[str, Any]) -> None:
    for key, value in source.items():
        if isinstance(value, Mapping) and isinstance(target.get(key), dict):
            _deep_update(target[key], value)
        else:
            target[key] = deepcopy(value)


def rolling_average(current: Any, sample: Any, *, weight: float = 0.25) -> float | None:
    if isinstance(sample, bool) or not isinstance(sample, (int, float)):
        return current if isinstance(current, (int, float)) else None
    if isinstance(current, bool) or not isinstance(current, (int, float)):
        return float(sample)
    return round((float(current) * (1 - weight)) + (float(sample) * weight), 2)


def is_simple_turn(text: str) -> bool:
    normalized = normalize_for_intent(text)
    if not normalized:
        return True
    words = normalized.split()
    if len(words) <= 3 and (set(words) & SIMPLE_GREETING_WORDS):
        return True
    return len(words) <= 8 and not (set(words) & REASONING_HINTS)


def is_reasoning_turn(text: str) -> bool:
    normalized = normalize_for_intent(text)
    words = set(normalized.split())
    return len(normalized) > 120 or bool(words & REASONING_HINTS)


def is_runtime_control_request(text: str) -> bool:
    normalized = normalize_for_intent(text)
    if not normalized:
        return False
    if voice_speed_intent(text):
        return True
    control_phrases = {
        "talk faster",
        "talk slower",
        "speak faster",
        "speak slower",
        "faster",
        "fastest",
        "slower",
        "slowest",
        "speed up",
        "slow down",
        "expression tag",
        "expression tags",
        "use expression",
        "laugh a bit",
        "laugh",
        "breath",
        "sigh",
        "supertonic",
        "voice runtime",
        "runtime status",
        "model profile",
        "shorter response",
        "longer response",
        "be concise",
        "talk more",
    }
    return any(phrase in normalized for phrase in control_phrases)


def is_voice_tool_request(text: str, settings: Settings) -> bool:
    if is_runtime_control_request(text):
        return True
    return settings.codex_orchestrator_enabled and is_codex_orchestrator_request(text)


def choose_model_profile(text: str, profile: Mapping[str, Any]) -> VoiceModelProfile:
    active = str(profile.get("active_model_profile") or "balanced")
    if is_runtime_control_request(text):
        return "fast"
    if is_reasoning_turn(text):
        return "reasoning"
    if is_simple_turn(text):
        return "fast"
    return active if active in {"fast", "balanced", "reasoning"} else "balanced"


def model_for_profile(settings: Settings, profile: Mapping[str, Any], model_profile: str) -> str:
    llm = profile.get("llm") if isinstance(profile.get("llm"), Mapping) else {}
    if model_profile == "fast":
        return str(llm.get("fast_model") or settings.voice_fast_model or settings.active_model)
    if model_profile == "reasoning":
        return str(llm.get("reasoning_model") or settings.voice_reasoning_model or settings.active_model)
    return str(llm.get("balanced_model") or settings.voice_balanced_model or settings.active_model)


def max_tokens_for_profile(settings: Settings, model_profile: str, profile: Mapping[str, Any]) -> int:
    configured = profile.get("llm") if isinstance(profile.get("llm"), Mapping) else {}
    if model_profile == "fast":
        return min(int(configured.get("max_output_tokens") or settings.max_completion_tokens), 96)
    if model_profile == "reasoning":
        return min(max(settings.max_completion_tokens, 180), 512)
    return min(settings.max_completion_tokens, 160)


def compact_runtime_context(profile: Mapping[str, Any]) -> str:
    llm = profile.get("llm") if isinstance(profile.get("llm"), Mapping) else {}
    tts = profile.get("tts") if isinstance(profile.get("tts"), Mapping) else {}
    response = profile.get("response") if isinstance(profile.get("response"), Mapping) else {}
    response_length = response.get("length", "short")
    return (
        "Runtime summary: "
        f"length={response_length}, model_profile={profile.get('active_model_profile', 'balanced')}, "
        f"reasoning={llm.get('reasoning_budget', 'low')}, input={profile.get('input_mode', 'vad')}, "
        f"tts={tts.get('provider', 'supertonic')} voice={tts.get('voice', 'M1')} "
        f"speed={tts.get('speed', 1.05)} steps={tts.get('steps', 8)}. "
        "Do not write expression tags."
    )


def clean_angle_tags(text: str, allowed_tags: list[str]) -> tuple[str, list[str], list[str]]:
    kept: list[str] = []
    stripped: list[str] = []
    allowed = set(allowed_tags)

    def replace(match: re.Match[str]) -> str:
        tag = match.group(1).lower()
        raw = match.group(0)
        if tag in allowed and raw == f"<{tag}>":
            kept.append(tag)
            return raw
        stripped.append(tag)
        return ""

    return TAG_RE.sub(replace, text), kept, stripped


def should_avoid_expression_tags(clean_text: str, user_text: str = "") -> bool:
    normalized = normalize_for_intent(f"{user_text} {clean_text}")
    return bool(set(normalized.split()) & SERIOUS_HINTS)


def render_expression_tags(
    clean_text: str,
    profile: Mapping[str, Any],
    *,
    user_text: str = "",
) -> dict[str, Any]:
    tts = profile.get("tts") if isinstance(profile.get("tts"), Mapping) else {}
    mode = str(tts.get("expression_mode") or "off")
    allowed = [str(tag) for tag in tts.get("allowed_expression_tags") or []]
    max_tags = int(tts.get("max_expression_tags_per_utterance") or 1)
    sanitized, _llm_supplied_tags, stripped_tags = clean_angle_tags(clean_text, [])
    rendered = sanitized
    added: list[str] = []
    if mode != "off" and max_tags > 0 and not should_avoid_expression_tags(sanitized, user_text):
        normalized = normalize_for_intent(sanitized)
        if "laugh" in allowed and mode in {"demo", "debug"} and any(word in normalized for word in ["funny", "joke", "haha"]):
            rendered = f"<laugh> {sanitized}".strip()
            added.append("laugh")
        elif "breath" in allowed and len(sanitized.split()) >= 4:
            rendered = _insert_after_first_phrase(sanitized, "<breath>")
            added.append("breath")
        elif "sigh" in allowed and mode in {"demo", "debug"} and any(word in normalized for word in ["sorry", "unfortunately"]):
            rendered = f"<sigh> {sanitized}".strip()
            added.append("sigh")
        if len(added) > max_tags:
            added = added[:max_tags]
            rendered = sanitized
    rendered, final_kept, final_stripped = clean_angle_tags(rendered, allowed)
    tags_used = final_kept[:max_tags]
    if len(tags_used) > max_tags:
        tags_used = tags_used[:max_tags]
        rendered = sanitized
    return {
        "clean_text": sanitized.strip(),
        "rendered_text": rendered.strip(),
        "expression_tags_used": tags_used,
        "unsupported_expression_tags": [*stripped_tags, *final_stripped],
        "expression_mode": mode,
    }


def _insert_after_first_phrase(text: str, tag: str) -> str:
    for separator in [". ", "! ", "? ", ", "]:
        if separator in text:
            head, tail = text.split(separator, 1)
            return f"{head}{separator}{tag} {tail}".strip()
    return f"{tag} {text}".strip()


def likely_bad_transcript(text: str, confidence: float | None = None) -> bool:
    normalized = normalize_for_intent(text)
    if confidence is not None and confidence < 0.45:
        return True
    if normalized in {"month bju", "bju", "um bju"}:
        return True
    words = normalized.split()
    if len(words) <= 3 and any(len(word) >= 3 and sum(ch in "aeiou" for ch in word) == 0 for word in words):
        return True
    return False


def classify_voice_turn(record: Mapping[str, Any], profile: Mapping[str, Any]) -> list[str]:
    latency = record.get("latency") if isinstance(record.get("latency"), Mapping) else {}
    events = record.get("events") if isinstance(record.get("events"), Mapping) else {}
    quality = record.get("quality_signals") if isinstance(record.get("quality_signals"), Mapping) else {}
    tts_params = record.get("tts_params") if isinstance(record.get("tts_params"), Mapping) else {}
    profile_latency = profile.get("latency") if isinstance(profile.get("latency"), Mapping) else {}
    failures: list[str] = []

    llm_ttfb = latency.get("llm_ttfb_ms")
    target_llm = profile_latency.get("target_llm_ttfb_ms", 800)
    if isinstance(llm_ttfb, (int, float)) and llm_ttfb > target_llm:
        failures.append("high_llm_ttfb")

    first_audio = (
        latency.get("total_first_audio_ms")
        or latency.get("speech_end_to_first_audio_ms")
        or latency.get("transcript_to_response_done_ms")
    )
    target_first = profile_latency.get("target_first_audio_ms", 1500)
    if isinstance(first_audio, (int, float)) and first_audio > target_first:
        failures.append("high_total_first_audio_latency")

    tts_ttfb = latency.get("tts_ttfb_ms")
    tts_elapsed = tts_ttfb or latency.get("tts_total_ms")
    if isinstance(tts_elapsed, (int, float)) and tts_elapsed > 1200:
        failures.append("high_tts_ttfb")

    if int(events.get("duplicate_vad_events") or 0) > 0 or int(events.get("vad_starts") or 0) > 1:
        failures.append("duplicate_vad_events")
    if int(events.get("duplicate_interruption_events") or 0) > 0:
        failures.append("duplicate_interruption_events")

    response = str(record.get("assistant_response_clean") or "").strip()
    if not response:
        failures.append("empty_llm_completion")

    transcript = str(record.get("user_transcript") or "")
    if quality.get("likely_bad_transcript") or likely_bad_transcript(transcript, quality.get("stt_confidence")):
        failures.append("likely_bad_transcript")

    model_profile = str(record.get("model_profile") or "")
    if model_profile == "reasoning" and is_simple_turn(transcript) and isinstance(llm_ttfb, (int, float)) and llm_ttfb > target_llm:
        failures.append("model_too_slow")
    if isinstance(tts_elapsed, (int, float)) and tts_elapsed > 1200:
        failures.append("tts_too_slow")
    if len(tts_params.get("expression_tags_used") or []) > int(
        (profile.get("tts") if isinstance(profile.get("tts"), Mapping) else {}).get(
            "max_expression_tags_per_utterance", 1
        )
    ):
        failures.append("expression_overuse")
    if tts_params.get("unsupported_expression_tags"):
        failures.append("unsupported_expression_tag")
    if not failures:
        failures.append("successful_turn")
    return failures


def apply_runtime_adaptation(
    profile: Mapping[str, Any],
    failures: list[str],
    record: Mapping[str, Any],
) -> dict[str, Any]:
    updated = deepcopy(dict(profile))
    reasons: list[str] = []
    llm = updated.setdefault("llm", {})
    tts = updated.setdefault("tts", {})
    latency = updated.setdefault("latency", {})
    turn_taking = updated.setdefault("turn_taking", {})
    quality = updated.setdefault("quality", {})
    record_latency = record.get("latency") if isinstance(record.get("latency"), Mapping) else {}

    latency["last_llm_ttfb_ms"] = record_latency.get("llm_ttfb_ms")
    latency["last_tts_ttfb_ms"] = record_latency.get("tts_ttfb_ms")
    latency["last_first_audio_ms"] = record_latency.get("total_first_audio_ms")
    latency["rolling_avg_llm_ttfb_ms"] = rolling_average(
        latency.get("rolling_avg_llm_ttfb_ms"), record_latency.get("llm_ttfb_ms")
    )
    latency["rolling_avg_tts_ttfb_ms"] = rolling_average(
        latency.get("rolling_avg_tts_ttfb_ms"), record_latency.get("tts_ttfb_ms")
    )
    latency["rolling_avg_first_audio_ms"] = rolling_average(
        latency.get("rolling_avg_first_audio_ms"), record_latency.get("total_first_audio_ms")
    )

    if "high_llm_ttfb" in failures or "model_too_slow" in failures:
        updated["active_model_profile"] = "fast"
        llm["reasoning_budget"] = "low"
        llm["max_output_tokens"] = min(int(llm.get("max_output_tokens") or 128), 96)
        reasons.append("high LLM TTFB routed future simple turns to fast profile")

    if "duplicate_vad_events" in failures or "duplicate_interruption_events" in failures:
        turn_taking["vad_debounce_ms"] = min(800, int(turn_taking.get("vad_debounce_ms") or 250) + 50)
        turn_taking["interruption_debounce_ms"] = min(
            800, int(turn_taking.get("interruption_debounce_ms") or 250) + 50
        )
        if "duplicate_interruption_events" in failures:
            turn_taking["duplicate_interruptions_prevented"] = int(
                turn_taking.get("duplicate_interruptions_prevented") or 0
            ) + 1
        reasons.append("duplicate turn-taking events increased debounce")

    if "likely_bad_transcript" in failures:
        reasons.append("bad transcript marked for clarification and memory exclusion")

    if "high_tts_ttfb" in failures or "tts_too_slow" in failures:
        tts["steps"] = max(5, min(int(tts.get("steps") or 8), 8) - 1)
        tts["max_chunk_length"] = min(int(tts.get("max_chunk_length") or 300), 220)
        tts["silence_duration"] = min(float(tts.get("silence_duration") or 0.3), 0.2)
        reasons.append("TTS latency reduced Supertonic steps/chunk/silence settings")

    if "expression_overuse" in failures:
        tts["expression_mode"] = "subtle" if tts.get("expression_mode") == "demo" else "off"
        reasons.append("expression overuse reduced expression mode")

    if record.get("input_mode") == "push_to_talk":
        updated["input_mode"] = "push_to_talk"
        turn_taking["push_to_talk_enabled"] = True
        turn_taking["vad_enabled"] = False
    elif record.get("input_mode") == "vad":
        updated["input_mode"] = "vad"
        turn_taking["push_to_talk_enabled"] = False
        turn_taking["vad_enabled"] = True

    recent = list(quality.get("recent_failure_types") or [])
    recent.extend([failure for failure in failures if failure != "successful_turn"])
    quality["recent_failure_types"] = recent[-10:]
    updated["last_turn"] = {
        "timestamp": record.get("timestamp"),
        "turn_id": record.get("turn_id"),
        "failures": failures,
        "latency": record_latency,
    }
    if reasons:
        updated["last_profile_change"] = {"timestamp": now_iso(), "reasons": reasons}
    updated["tts"].update(clamp_supertonic_params(updated.get("tts", {})))
    return updated


def build_learning_record(
    *,
    session_id: str,
    turn_id: str,
    input_mode: str,
    user_transcript: str,
    assistant_response_clean: str,
    tts_rendered_text: str,
    model_profile: str,
    model_used: str,
    tts_provider: str,
    tts_params: Mapping[str, Any],
    latency: Mapping[str, Any],
    events: Mapping[str, Any],
    quality_signals: Mapping[str, Any],
    runtime_profile_snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "timestamp": now_iso(),
        "session_id": session_id,
        "turn_id": turn_id,
        "input_mode": input_mode,
        "user_transcript": user_transcript,
        "assistant_response_clean": assistant_response_clean,
        "tts_rendered_text": tts_rendered_text,
        "model_profile": model_profile,
        "model_used": model_used,
        "tts_provider": tts_provider,
        "tts_params": dict(tts_params),
        "latency": dict(latency),
        "events": dict(events),
        "quality_signals": dict(quality_signals),
        "runtime_profile_snapshot": deepcopy(dict(runtime_profile_snapshot)),
    }


def current_timestamp_ms() -> int:
    return int(time.time() * 1000)
