from __future__ import annotations

import re
import uuid
from typing import Any

from .voice_runtime_controls import (
    voice_speed_intent,
    voice_speed_response,
    voice_tone_intent,
    voice_tone_response,
)
from .config import Settings
from .cost_guard import CostGuard
from .db import Database, dumps, loads
from .feedback import PromptRepository
from .llm import LLMClient, Message

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
        "- If the user asks about network, speed, or latency, say: We reduce latency with streaming and local voice processing.\n"
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
    if speed_intent := voice_speed_intent(text):
        return voice_speed_response(speed_intent)
    if tone_intent := voice_tone_intent(text):
        return voice_tone_response(tone_intent)
    if "your name" in normalized or "who are you" in normalized:
        return "I am an AI assistant."
    if _latency_intent(normalized, words):
        return "We reduce latency with streaming and local voice processing."
    if (
        normalized in {"hi", "hello", "hey", "what", "no"}
        or "are you there" in normalized
        or "what is going on" in normalized
        or "whats going on" in normalized
    ):
        return "I'm here; how can I help?"
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
            raise
        actual_cost = self.cost_guard.estimate_llm_call(result.provider, result.raw)
        self.cost_guard.finalize(
            reservation_id,
            actual_cost,
            units=result.raw.get("usage", {}),
            metadata={"conversation_id": cid, "channel": channel},
        )
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
                result.text,
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
            "message": result.text,
            "latency_ms": result.latency_ms,
            "model": result.model,
            "provider": result.provider,
            "prompt_version": prompt.version,
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
