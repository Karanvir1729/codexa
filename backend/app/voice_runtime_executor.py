from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .codex_orchestrator import CODEX_ORCHESTRATOR_RUNTIME_TOOLS, CodexOrchestratorBridge
from .config import Settings
from .db import Database
from .voice_runtime_controls import voice_speed_intent
from .voice_self_observe import execute_runtime_actions


@dataclass
class VoiceRuntimeExecution:
    profile: dict[str, Any]
    statuses: list[dict[str, Any]]
    response_text: str | None = None
    codex: dict[str, Any] = field(default_factory=dict)


def _action_tool(action: Mapping[str, Any]) -> str:
    return str(action.get("tool") or "").strip()


def _action_args(action: Mapping[str, Any]) -> Mapping[str, Any]:
    args = action.get("args")
    return args if isinstance(args, Mapping) else {}


TTS_SPEED_RUNTIME_TOOLS = {"set_tts_speed", "increment_tts_speed"}


def _filter_sync_actions_for_request(
    actions: list[Mapping[str, Any]],
    user_text: str,
) -> tuple[list[Mapping[str, Any]], list[dict[str, Any]]]:
    if voice_speed_intent(user_text):
        return actions, []
    filtered: list[Mapping[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for action in actions:
        tool = _action_tool(action)
        args = _action_args(action)
        if tool in TTS_SPEED_RUNTIME_TOOLS:
            rejected.append(
                {
                    "tool": tool,
                    "reason": str(args.get("reason") or "unspecified"),
                    "status": "rejected",
                    "error": "speed_action_without_speed_intent",
                }
            )
        else:
            filtered.append(action)
    return filtered, rejected


async def execute_voice_runtime_actions(
    *,
    db: Database,
    settings: Settings,
    profile: Mapping[str, Any],
    actions: list[Mapping[str, Any]],
    conversation_id: str,
    user_text: str,
    transcript: list[Mapping[str, Any]] | None = None,
    bridge: CodexOrchestratorBridge | None = None,
) -> VoiceRuntimeExecution:
    sync_actions = [
        action for action in actions if _action_tool(action) not in CODEX_ORCHESTRATOR_RUNTIME_TOOLS
    ]
    codex_actions = [
        action for action in actions if _action_tool(action) in CODEX_ORCHESTRATOR_RUNTIME_TOOLS
    ]
    sync_actions, rejected_statuses = _filter_sync_actions_for_request(sync_actions, user_text)

    updated, statuses = execute_runtime_actions(profile, sync_actions, settings)
    statuses = [*rejected_statuses, *statuses]
    response_text: str | None = None
    codex_metadata: dict[str, Any] = {}
    codex_bridge = bridge or CodexOrchestratorBridge(db, settings)

    for action in codex_actions:
        tool = _action_tool(action)
        args = _action_args(action)
        reason = str(args.get("reason") or "user_requested_codex_orchestration")
        status: dict[str, Any] = {"tool": tool, "reason": reason, "status": "completed"}
        if tool == "delegate_to_codex_orchestrator":
            goal = str(args.get("goal") or user_text).strip() or user_text
            mode = str(args.get("mode") or "plan_first").strip() or "plan_first"
            mapped = codex_bridge.load_mapping(conversation_id)
            result = await codex_bridge.delegate(
                conversation_id=conversation_id,
                user_text=user_text if mapped.get("codex_session_id") else goal,
                transcript=transcript,
                mode=mode,
            )
        else:
            result = await codex_bridge.status(conversation_id)

        codex_metadata = result.metadata()
        codex_metadata["raw"] = result.raw or {}
        response_text = result.text
        status.update({"codex": codex_metadata})
        if result.status in {"disabled", "timeout", "http_error", "unreachable"}:
            status["status"] = "failed"
            status["error"] = result.status
        statuses.append(status)

    updated.setdefault("debug", {})["last_runtime_action_status"] = statuses
    if codex_metadata:
        updated.setdefault("debug", {})["last_codex_orchestrator"] = codex_metadata
    return VoiceRuntimeExecution(
        profile=updated,
        statuses=statuses,
        response_text=response_text,
        codex=codex_metadata,
    )
