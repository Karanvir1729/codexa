from __future__ import annotations

import asyncio
import re
import uuid
from typing import Any

from .voice_runtime_controls import (
    voice_tone_intent,
    voice_tone_response,
)
from .codex_orchestrator import has_codex_orchestrator_session, is_codex_orchestrator_request
from .config import Settings
from .cost_guard import CostGuard
from .db import Database, dumps, loads
from .feedback import PromptRepository
from .llm import LLMClient, Message
from .voice_self_observe import (
    fallback_runtime_command_for_request,
    is_voice_tool_request,
    load_runtime_profile,
    parse_voice_runtime_command,
    runtime_command_context,
    save_runtime_profile,
)
from .voice_runtime_executor import execute_voice_runtime_actions

NUMBER_WORDS = {
    "zero": 0,
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}


def build_runtime_system_prompt(system_prompt: str) -> str:
    return (
        f"{system_prompt}\n\n"
        "Runtime contract:\n"
        "Use the right spoken length for the user's request: brief for simple controls, "
        "but multi-sentence when the user asks for a story, explanation, detail, or continued talking.\n"
        "- If asked your name or who you are, say: I am an AI assistant.\n"
        "- Default to English. If the latest user message asks for English, reply in English only.\n"
        "- Do not switch to Hindi, Urdu, or another language unless the latest user message explicitly asks for that language.\n"
        "- Stay in the conversation as the AI; do not offer to pass the user to another person.\n"
        "- Voice cloning is not available. Do not claim to save, use, clone, or imitate the user's voice.\n"
        "- If the user greets you, asks if you are there, or asks what is going on, say that you are here and ask how you can help.\n"
        "- If the user says OnePlus One, ask whether they mean the phone or the math problem.\n"
        "- If the user asks you to speak faster or slower, acknowledge the new speed briefly.\n"
        "- If the user asks you to change tone or speaking style, acknowledge that you can do it.\n"
        "- If the user asks about network, speed, or latency, say: We reduce latency with streaming, NVIDIA WebSocket STT, and Gradium VAD/TTS.\n"
        "- If the user asks for a story, narration, explanation, or more detail, answer directly instead of asking how long it should be.\n"
        "- Otherwise, ask one concise clarifying question when required information is missing.\n"
        "Do not claim an external action is complete unless a tool result proves it."
    )


def _number_value(token: str) -> int | None:
    if token.isdigit():
        return int(token)
    return NUMBER_WORDS.get(token)


def simple_math_response(text: str) -> str | None:
    raw = text.casefold()
    normalized = re.sub(r"[^a-z0-9]+", " ", raw).strip()
    if "oneplus" in raw:
        return "Do you mean the OnePlus phone or one plus one?"
    match = re.search(r"\b([a-z0-9]+)\s+plus\s+([a-z0-9]+)\b", normalized)
    if not match:
        return None
    left = _number_value(match.group(1))
    right = _number_value(match.group(2))
    if left is None or right is None:
        return None
    return f"It's {left + right}."


def _has_long_form_intent(normalized: str, words: set[str]) -> bool:
    if words & {
        "story",
        "stories",
        "explain",
        "explanation",
        "detail",
        "details",
        "describe",
        "narrate",
    }:
        return True
    return any(
        phrase in normalized
        for phrase in [
            "tell me about",
            "tell me more",
            "keep talking",
            "talk for longer",
            "go on",
            "what else",
        ]
    )


def _latency_intent(normalized: str, words: set[str]) -> bool:
    if "latency" in words or "lag" in words:
        return True
    return any(
        phrase in normalized
        for phrase in [
            "network latency",
            "response latency",
            "why are you slow",
            "why is this slow",
            "slow response",
        ]
    )


def long_form_fallback_response(text: str) -> str | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    words = set(normalized.split())
    if not _has_long_form_intent(normalized, words):
        return None
    if "story" in words or "stories" in words or "narrate" in words:
        if words & {"spooky", "scary", "creepy", "haunted"}:
            return (
                "The old clock stopped at midnight, and the hallway went quiet. "
                "A soft knock came from the room no one used. "
                "When the door opened, only cold air and a silver key were waiting. "
                "By morning, the clock was ticking again from inside the wall."
            )
        return (
            "A traveler found a lantern glowing beside an empty road. "
            "Each step toward it revealed a path that had not been there before. "
            "At the end, a stranger handed them a map with tomorrow's sunrise marked in gold. "
            "They followed it home and never lost their way again."
        )
    return (
        "Here is the short version: the system should answer the request directly, "
        "cover the main point first, add the most useful detail, and end with one clear next step."
    )


def repair_long_form_response(user_text: str, response_text: str) -> str | None:
    normalized_user = re.sub(r"[^a-z0-9]+", " ", user_text.casefold()).strip()
    words = set(normalized_user.split())
    if not _has_long_form_intent(normalized_user, words):
        return None
    normalized_response = re.sub(r"[^a-z0-9?]+", " ", response_text.casefold()).strip()
    deflection_phrases = [
        "need a bit more information",
        "need more information",
        "could you please tell me",
        "please tell me if",
        "what should i focus on",
        "what would you like the story",
        "what kind of story",
        "how long should",
        "before i",
    ]
    if "?" in response_text and any(phrase in normalized_response for phrase in deflection_phrases):
        return long_form_fallback_response(user_text)
    return None


def fast_policy_response(text: str) -> str | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    words = set(normalized.split())
    if not normalized:
        return None
    has_long_form_intent = _has_long_form_intent(normalized, words)
    if has_long_form_intent:
        return None
    if response := simple_math_response(text):
        return response
    if tone_intent := voice_tone_intent(text):
        return voice_tone_response(tone_intent)
    if "your name" in normalized or "who are you" in normalized:
        return "I am an AI assistant."
    if "human" in words and "agent" in words:
        return "I am an AI assistant, and I can help you here."
    if _latency_intent(normalized, words):
        return "We reduce latency with streaming, NVIDIA WebSocket STT, and Gradium VAD/TTS."
    return None


class AgentService:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        llm: LLMClient,
        cost_guard: CostGuard | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.llm = llm
        self.prompts = PromptRepository(db)
        self.cost_guard = cost_guard or CostGuard(db, settings)

    def ensure_conversation(
        self,
        conversation_id: str | None,
        channel: str,
        caller: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        if conversation_id:
            row = self.db.one("SELECT id FROM conversations WHERE id = ?", (conversation_id,))
            if row:
                return conversation_id
        new_id = conversation_id or str(uuid.uuid4())
        self.db.execute(
            """
            INSERT INTO conversations(id, channel, caller, metadata_json)
            VALUES (?, ?, ?, ?)
            """,
            (new_id, channel, caller, dumps(metadata or {})),
        )
        return new_id

    def history(self, conversation_id: str, limit: int = 12) -> list[Message]:
        rows = self.db.all(
            """
            SELECT role, content
            FROM turns
            WHERE conversation_id = ? AND role IN ('user', 'assistant')
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (conversation_id, limit),
        )
        return [{"role": row["role"], "content": row["content"]} for row in reversed(rows)]

    async def respond(
        self,
        text: str,
        conversation_id: str | None = None,
        channel: str = "web",
        caller: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cid = self.ensure_conversation(conversation_id, channel, caller, metadata)
        user_turn_id = str(uuid.uuid4())
        self.db.execute(
            """
            INSERT INTO turns(id, conversation_id, role, content, metrics_json)
            VALUES (?, ?, 'user', ?, ?)
            """,
            (user_turn_id, cid, text, dumps({"channel": channel})),
        )
        prompt = self.prompts.active()
        messages = self.history(cid)
        codex_session_active = has_codex_orchestrator_session(self.db, cid)
        if is_voice_tool_request(text, self.settings) or codex_session_active:
            return await self._respond_with_runtime_tools(
                text=text,
                conversation_id=cid,
                user_turn_id=user_turn_id,
                messages=messages,
                prompt_version=prompt.version,
                codex_session_active=codex_session_active,
            )
        if not self.settings.codex_orchestrator_enabled and is_codex_orchestrator_request(text):
            response_text = (
                "Codexa orchestration is not enabled in this backend, so I cannot start that "
                "planning flow from this session."
            )
            assistant_turn_id = str(uuid.uuid4())
            self.db.execute(
                """
                INSERT INTO turns(
                    id, conversation_id, role, content, latency_ms, model, prompt_version,
                    metrics_json
                )
                VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
                """,
                (
                    assistant_turn_id,
                    cid,
                    response_text,
                    0,
                    "policy-rule",
                    prompt.version,
                    dumps(
                        {
                            "provider": "policy-rule",
                            "reason": "codex_orchestrator_disabled",
                            "latency_target_ms": self.settings.latency_target_ms,
                            "estimated_cost_usd": 0,
                        }
                    ),
                ),
            )
            return {
                "conversation_id": cid,
                "user_turn_id": user_turn_id,
                "assistant_turn_id": assistant_turn_id,
                "message": response_text,
                "latency_ms": 0,
                "model": "policy-rule",
                "provider": "policy-rule",
                "prompt_version": prompt.version,
                "cost_guard": self.cost_guard.snapshot().to_dict(),
            }
        if response_text := fast_policy_response(text):
            assistant_turn_id = str(uuid.uuid4())
            self.db.execute(
                """
                INSERT INTO turns(
                    id, conversation_id, role, content, latency_ms, model, prompt_version,
                    metrics_json
                )
                VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
                """,
                (
                    assistant_turn_id,
                    cid,
                    response_text,
                    0,
                    "policy-rule",
                    prompt.version,
                    dumps(
                        {
                            "provider": "policy-rule",
                            "latency_target_ms": self.settings.latency_target_ms,
                            "estimated_cost_usd": 0,
                        }
                    ),
                ),
            )
            return {
                "conversation_id": cid,
                "user_turn_id": user_turn_id,
                "assistant_turn_id": assistant_turn_id,
                "message": response_text,
                "latency_ms": 0,
                "model": "policy-rule",
                "provider": "policy-rule",
                "prompt_version": prompt.version,
                "cost_guard": self.cost_guard.snapshot().to_dict(),
            }

        reservation_id = self.cost_guard.reserve(
            self.cost_guard.reserve_amount_for_provider(self.settings.llm_provider),
            source="llm_call",
            provider=self.settings.llm_provider,
            model=self.settings.active_model,
            metadata={"conversation_id": cid, "channel": channel},
        )
        try:
            runtime_prompt = build_runtime_system_prompt(prompt.compiled)
            result = await self.llm.generate(messages, runtime_prompt)
        except Exception as exc:
            self.cost_guard.release(reservation_id, {"error": type(exc).__name__})
            assistant_turn_id = str(uuid.uuid4())
            response_text = (
                "I'm having trouble reaching the language model right now. "
                "Please try again in a moment."
            )
            metrics = {
                "provider": "llm-error",
                "error_type": type(exc).__name__,
                "latency_target_ms": self.settings.latency_target_ms,
                "estimated_cost_usd": 0,
            }
            self.db.execute(
                """
                INSERT INTO turns(
                    id, conversation_id, role, content, latency_ms, model, prompt_version, metrics_json
                )
                VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
                """,
                (
                    assistant_turn_id,
                    cid,
                    response_text,
                    0,
                    self.settings.active_model,
                    prompt.version,
                    dumps(metrics),
                ),
            )
            return {
                "conversation_id": cid,
                "user_turn_id": user_turn_id,
                "assistant_turn_id": assistant_turn_id,
                "message": response_text,
                "latency_ms": 0,
                "model": self.settings.active_model,
                "provider": "llm-error",
                "prompt_version": prompt.version,
                "cost_guard": self.cost_guard.snapshot().to_dict(),
            }
        actual_cost = self.cost_guard.estimate_llm_call(result.provider, result.raw)
        self.cost_guard.finalize(
            reservation_id,
            actual_cost,
            units=result.raw.get("usage", {}),
            metadata={"conversation_id": cid, "channel": channel},
        )
        response_text = repair_long_form_response(text, result.text) or result.text
        assistant_turn_id = str(uuid.uuid4())
        metrics = {
            "provider": result.provider,
            "raw": result.raw,
            "latency_target_ms": self.settings.latency_target_ms,
            "estimated_cost_usd": actual_cost,
        }
        self.db.execute(
            """
            INSERT INTO turns(
                id, conversation_id, role, content, latency_ms, model, prompt_version, metrics_json
            )
            VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
            """,
            (
                assistant_turn_id,
                cid,
                response_text,
                result.latency_ms,
                result.model,
                prompt.version,
                dumps(metrics),
            ),
        )
        return {
            "conversation_id": cid,
            "user_turn_id": user_turn_id,
            "assistant_turn_id": assistant_turn_id,
            "message": response_text,
            "latency_ms": result.latency_ms,
            "model": result.model,
            "provider": result.provider,
            "prompt_version": prompt.version,
            "cost_guard": self.cost_guard.snapshot().to_dict(),
        }

    async def _respond_with_runtime_tools(
        self,
        *,
        text: str,
        conversation_id: str,
        user_turn_id: str,
        messages: list[Message],
        prompt_version: int,
        codex_session_active: bool = False,
    ) -> dict[str, Any]:
        runtime_profile = load_runtime_profile(self.db, self.settings)
        reservation_id = self.cost_guard.reserve(
            self.cost_guard.reserve_amount_for_provider(self.settings.llm_provider),
            source="voice_runtime_command",
            provider=self.settings.llm_provider,
            model=self.settings.active_model,
            metadata={"conversation_id": conversation_id, "channel": "web", "runtime_control": True},
        )
        runtime_actions: list[dict[str, Any]] = []
        runtime_action_status: list[dict[str, Any]] = []
        structured_output: dict[str, Any] | None = None
        parse_errors: list[str] = []
        fallback_reason: str | None = None
        try:
            result = await asyncio.wait_for(
                self.llm.generate(
                    messages,
                    runtime_command_context(
                        runtime_profile,
                        self.settings,
                        text,
                        codex_session_active=codex_session_active,
                    ),
                ),
                timeout=self.settings.voice_runtime_command_timeout_seconds,
            )
        except Exception as exc:
            self.cost_guard.release(reservation_id, {"error": type(exc).__name__})
            latency_ms = 0
            provider = "llm-error"
            model = self.settings.active_model
            raw: dict[str, Any] = {"error_type": type(exc).__name__}
            fallback_reason = type(exc).__name__
        else:
            actual_cost = self.cost_guard.estimate_llm_call(result.provider, result.raw)
            self.cost_guard.finalize(
                reservation_id,
                actual_cost,
                units=result.raw.get("usage", {}),
                metadata={"conversation_id": conversation_id, "channel": "web", "runtime_control": True},
            )
            parsed = parse_voice_runtime_command(result.text)
            provider = result.provider
            model = result.model
            latency_ms = result.latency_ms
            raw = {**dict(result.raw), "model_text": result.text}
            if parsed.ok and parsed.command:
                command = parsed.command
                runtime_actions = [dict(action) for action in command.runtime_actions]
                structured_output = {
                    "speak": command.speak,
                    "runtime_actions": runtime_actions,
                    "reasoning_profile": command.reasoning_profile,
                    "debug": command.debug,
                }
                runtime_profile.setdefault("debug", {})["last_llm_structured_output"] = structured_output
                execution = await execute_voice_runtime_actions(
                    db=self.db,
                    settings=self.settings,
                    profile=runtime_profile,
                    actions=runtime_actions,
                    conversation_id=conversation_id,
                    user_text=text,
                    transcript=self.transcript(conversation_id),
                )
                runtime_profile = execution.profile
                runtime_action_status = execution.statuses
                if runtime_actions and not any(
                    status.get("status") == "completed" for status in runtime_action_status
                ) and not execution.response_text:
                    fallback_reason = "runtime_actions_rejected"
                else:
                    save_runtime_profile(self.db, runtime_profile)
                    response_text = execution.response_text or command.speak or "I updated the voice runtime."
            else:
                parse_errors = parsed.errors or ["structured_output_parse_failed"]
                runtime_profile.setdefault("debug", {})["structured_output_parse_errors"] = parse_errors
                fallback_reason = ",".join(parse_errors)
            raw["structured_output"] = structured_output
            raw["structured_output_parse_errors"] = parse_errors

        if fallback_reason:
            fallback_command = fallback_runtime_command_for_request(
                text,
                runtime_profile,
                self.settings,
                reason=fallback_reason,
                codex_session_active=codex_session_active,
            )
            if fallback_command:
                runtime_actions = [dict(action) for action in fallback_command.runtime_actions]
                structured_output = {
                    "speak": fallback_command.speak,
                    "runtime_actions": runtime_actions,
                    "reasoning_profile": fallback_command.reasoning_profile,
                    "debug": fallback_command.debug,
                }
                runtime_profile.setdefault("debug", {})["last_llm_structured_output"] = structured_output
                runtime_profile.setdefault("debug", {})["structured_output_parse_errors"] = parse_errors
                execution = await execute_voice_runtime_actions(
                    db=self.db,
                    settings=self.settings,
                    profile=runtime_profile,
                    actions=runtime_actions,
                    conversation_id=conversation_id,
                    user_text=text,
                    transcript=self.transcript(conversation_id),
                )
                runtime_profile = execution.profile
                runtime_action_status = execution.statuses
                save_runtime_profile(self.db, runtime_profile)
                raw["fallback_structured_output"] = structured_output
                response_text = execution.response_text or fallback_command.speak
                provider = "runtime-fallback" if provider == "llm-error" else provider
                model = "runtime-fallback" if model == self.settings.active_model and provider == "runtime-fallback" else model
            else:
                save_runtime_profile(self.db, runtime_profile)
                response_text = "I'm having trouble updating the voice runtime right now."

        assistant_turn_id = str(uuid.uuid4())
        self.db.execute(
            """
            INSERT INTO turns(
                id, conversation_id, role, content, latency_ms, model, prompt_version,
                metrics_json
            )
            VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)
            """,
            (
                assistant_turn_id,
                conversation_id,
                response_text,
                latency_ms,
                model,
                prompt_version,
                dumps(
                    {
                        "provider": provider,
                        "raw": raw,
                        "source": "voice_runtime_tools",
                        "runtime_actions": runtime_actions,
                        "runtime_action_status": runtime_action_status,
                        "structured_output": structured_output,
                        "structured_output_parse_errors": parse_errors,
                        "latency_target_ms": self.settings.latency_target_ms,
                    }
                ),
            ),
        )
        return {
            "conversation_id": conversation_id,
            "user_turn_id": user_turn_id,
            "assistant_turn_id": assistant_turn_id,
            "message": response_text,
            "latency_ms": latency_ms,
            "model": model,
            "provider": provider,
            "prompt_version": prompt_version,
            "cost_guard": self.cost_guard.snapshot().to_dict(),
        }

    async def warmup_llm(self) -> None:
        if self.settings.llm_warmup_enabled:
            await self.llm.warmup()

    def transcript(self, conversation_id: str) -> list[dict[str, Any]]:
        rows = self.db.all(
            """
            SELECT id, role, content, latency_ms, model, prompt_version, metrics_json, created_at
            FROM turns
            WHERE conversation_id = ?
            ORDER BY created_at ASC
            """,
            (conversation_id,),
        )
        return [
            {
                "id": row["id"],
                "role": row["role"],
                "content": row["content"],
                "latency_ms": row["latency_ms"],
                "model": row["model"],
                "prompt_version": row["prompt_version"],
                "metrics": loads(row["metrics_json"], {}),
                "created_at": row["created_at"],
            }
            for row in rows
        ]
