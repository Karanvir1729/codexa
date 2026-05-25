from __future__ import annotations

import uuid
from typing import Any

from .config import Settings
from .db import Database, dumps, loads
from .feedback import PromptRepository
from .llm import LLMClient, Message


class AgentService:
    def __init__(self, db: Database, settings: Settings, llm: LLMClient) -> None:
        self.db = db
        self.settings = settings
        self.llm = llm
        self.prompts = PromptRepository(db)

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
        result = await self.llm.generate(messages, prompt.compiled)
        assistant_turn_id = str(uuid.uuid4())
        metrics = {
            "provider": result.provider,
            "raw": result.raw,
            "latency_target_ms": self.settings.latency_target_ms,
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

