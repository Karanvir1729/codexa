from __future__ import annotations

import uuid
from typing import Any

from .config import Settings
from .cost_guard import CostGuard
from .db import Database, dumps, loads
from .feedback import PromptRepository
from .llm import LLMClient, Message


def build_runtime_system_prompt(system_prompt: str) -> str:
    return (
        f"{system_prompt}\n\n"
        "Runtime contract:\n"
        "Reply in one concise sentence. "
        "For account help, ask a question that includes account and asks for the email or phone number; do not ask for more details. "
        "For cancellation, refund, or order cancellation, include both order ID and reason before taking action. "
        "For human-agent requests, include the word human and say a human agent can help. "
        "For network-latency questions, include the word latency and give one speed mitigation. "
        "For anything else, ask one concise clarifying question."
    )


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
        reservation_id = self.cost_guard.reserve(
            self.cost_guard.reserve_amount_for_provider(self.settings.llm_provider),
            source="llm_call",
            provider=self.settings.llm_provider,
            model=self.settings.active_model,
            metadata={"conversation_id": cid, "channel": channel},
        )
        try:
            result = await self.llm.generate(messages, build_runtime_system_prompt(prompt.system_prompt))
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
