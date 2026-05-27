from __future__ import annotations

import re
import uuid
from typing import Any

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
        "Reply only with the best policy sentence, in one short sentence.\n"
        "- Your name is PipeCAD's voice assistant; if asked your name or who you are, say: I'm PipeCAD's voice assistant.\n"
        "- Default to English. If the latest user message asks for English, reply in English only.\n"
        "- Do not switch to Hindi, Urdu, or another language unless the latest user message explicitly asks for that language.\n"
        "- If the user explicitly asks for a human, live agent, operator, representative, or handoff, say: A human agent can help; I can hand you off now.\n"
        "- Never offer a human handoff for greetings, confusion, account help, or name questions.\n"
        "- Do not infer handoff unless the latest user message contains a clear handoff word.\n"
        "- If the user mentions cancel, refund, or order, ask: What order ID and reason should I use before taking action?\n"
        "- If the user mentions account, ask: What account email or phone number should I use?\n"
        "- If the user greets you, asks if you are there, or asks what is going on, say that you are here and ask how you can help.\n"
        "- If the user says OnePlus One, ask whether they mean the phone or the math problem.\n"
        "- If the user asks you to speak faster or slower, acknowledge the new speed briefly.\n"
        "- If the user asks about network, speed, or latency, say: We reduce latency with streaming and local voice processing.\n"
        "- Otherwise, ask one concise clarifying question.\n"
        "Do not say found, cancelled, refunded, completed, or done unless a tool result proves it."
    )


def voice_speed_intent(text: str) -> str | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    if not normalized:
        return None
    voice_terms = {"talk", "speak", "speaking", "speech", "voice", "talking"}
    words = set(normalized.split())
    if not (words & voice_terms or "speed up" in normalized or "slow down" in normalized):
        return None
    if (
        "normal speed" in normalized
        or "regular speed" in normalized
        or "default speed" in normalized
    ):
        return "normal"
    if "faster" in words or "quicker" in words or "speed up" in normalized:
        return "faster"
    if "slower" in words or "slow down" in normalized:
        return "slower"
    return None


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


def fast_policy_response(text: str) -> str | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()
    words = set(normalized.split())
    if not normalized:
        return None
    if response := simple_math_response(text):
        return response
    if speed_intent := voice_speed_intent(text):
        if speed_intent == "faster":
            return "Sure, I'll talk faster."
        if speed_intent == "slower":
            return "Sure, I'll slow down."
        return "Sure, I'll use normal speed."
    if words & {"human", "operator", "representative", "handoff"} or "live agent" in normalized:
        return "A human agent can help; I can hand you off now."
    if "your name" in normalized or "who are you" in normalized:
        return "I'm PipeCAD's voice assistant."
    if (
        normalized in {"hi", "hello", "hey", "what", "no"}
        or "are you there" in normalized
        or "what is going on" in normalized
        or "whats going on" in normalized
    ):
        return "I'm here; how can I help?"
    if words & {"cancel", "refund", "order"}:
        return "What order ID and reason should I use before taking action?"
    if "account" in words:
        return "What account email or phone number should I use?"
    if words & {"latency", "speed"} or "network latency" in normalized:
        return "We reduce latency with streaming and local voice processing."
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
            result = await self.llm.generate(messages, build_runtime_system_prompt(prompt.compiled))
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
