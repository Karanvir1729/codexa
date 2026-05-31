from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Mapping

import httpx

from .config import Settings
from .db import Database, dumps, loads

CODEX_ORCHESTRATOR_RUNTIME_TOOLS = {
    "delegate_to_codex_orchestrator",
    "get_codex_orchestrator_status",
}

_APPROVAL_RESPONSES = {
    "approve",
    "approve it",
    "yes approve",
    "go ahead",
}
_DENIAL_RESPONSES = {
    "deny",
    "deny it",
    "no deny",
    "do not approve",
}
_DETAIL_RESPONSES = {
    "details",
    "detail",
    "elaborate",
    "explain",
    "more",
}


@dataclass(frozen=True)
class CodexOrchestratorResult:
    text: str
    conversation_id: str
    status: str
    codex_session_id: str | None = None
    codex_project_id: str | None = None
    codex_task_id: str | None = None
    codex_worker_id: str | None = None
    requires_approval: bool = False
    approval_id: str | None = None
    raw: dict[str, Any] | None = None

    def metadata(self) -> dict[str, Any]:
        metadata = {
            "voice_conversation_id": self.conversation_id,
            "status": self.status,
            "codex_session_id": self.codex_session_id,
            "codex_project_id": self.codex_project_id,
            "codex_task_id": self.codex_task_id,
            "codex_worker_id": self.codex_worker_id,
            "requires_approval": self.requires_approval,
            "approval_id": self.approval_id,
        }
        session = _metadata_session(self.raw)
        if session:
            metadata["codex_session_status"] = session.get("status")
            metadata["codex_current_status"] = session.get("current_status")
        return metadata


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def is_codex_approval_response(text: str) -> bool:
    return _normalize(text) in _APPROVAL_RESPONSES | _DENIAL_RESPONSES


def is_codex_status_request(text: str) -> bool:
    normalized = _normalize(text)
    if not normalized:
        return False
    if "codex" in normalized and any(
        phrase in normalized
        for phrase in [
            "status",
            "summary",
            "events",
            "what changed",
            "pending approval",
            "approval pending",
        ]
    ):
        return True
    return any(
        phrase in normalized
        for phrase in [
            "what is codex doing",
            "what did codex do",
            "what changed in the project",
            "show codex status",
        ]
    )


def is_codex_detail_request(text: str) -> bool:
    normalized = _normalize(text)
    if not normalized:
        return False
    words = set(normalized.split())
    return bool(words & _DETAIL_RESPONSES) or any(
        phrase in normalized
        for phrase in [
            "tell me more",
            "full summary",
            "longer summary",
            "more detail",
            "more details",
            "walk me through",
            "what is the megaplan",
            "show me the megaplan",
        ]
    )


def is_codex_task_request(text: str) -> bool:
    normalized = _normalize(text)
    if not normalized:
        return False
    return "codex" in normalized or "codexa" in normalized


def is_codex_orchestrator_request(text: str) -> bool:
    return (
        is_codex_approval_response(text)
        or is_codex_status_request(text)
        or is_codex_task_request(text)
    )


def has_codex_orchestrator_session(db: Database, conversation_id: str | None) -> bool:
    if not conversation_id:
        return False
    row = db.one(
        """
        SELECT codex_session_id
        FROM codex_orchestrator_sessions
        WHERE conversation_id = ?
        """,
        (conversation_id,),
    )
    return bool(row and row["codex_session_id"])


async def codex_builder_runtime_context(
    db: Database,
    settings: Settings,
    conversation_id: str | None,
) -> str:
    if not settings.codex_orchestrator_enabled:
        return ""
    if not conversation_id:
        return (
            "Builder context: no voice conversation id exists yet. If this is a software "
            "build/change/debug/test/deploy request, create a Builder session with "
            "delegate_to_codex_orchestrator."
        )

    bridge = CodexOrchestratorBridge(db, settings)
    mapping = bridge.load_mapping(conversation_id)
    if not mapping.get("codex_session_id"):
        return (
            "Builder context: no Builder/Codex session is attached yet. Use model judgment: "
            "software/app/game/site/tool/build/change/debug/test/deploy requests should create "
            "a Builder session with delegate_to_codex_orchestrator; ordinary conversation should "
            "return no runtime action."
        )

    status_result: CodexOrchestratorResult | None = None
    try:
        status_result = await bridge.status(
            conversation_id,
            user_text="status",
            allow_spoken_detail=True,
        )
        mapping = bridge.load_mapping(conversation_id) or mapping
    except Exception as exc:
        mapping = dict(mapping)
        mapping["status_fetch_error"] = type(exc).__name__

    return format_codex_builder_runtime_context(mapping, status_result)


def format_codex_builder_runtime_context(
    mapping: Mapping[str, Any],
    status_result: CodexOrchestratorResult | None = None,
) -> str:
    raw = status_result.raw if status_result else None
    session = _metadata_session(raw) or _metadata_session(mapping.get("metadata"))
    lines = ["Builder context:"]
    ids = {
        "voice_conversation_id": mapping.get("conversation_id"),
        "codex_session_id": mapping.get("codex_session_id"),
        "project_id": mapping.get("codex_project_id") or (session or {}).get("project_id"),
        "task_id": mapping.get("codex_task_id") or (session or {}).get("active_task_id"),
        "worker_id": mapping.get("codex_worker_id") or (session or {}).get("active_worker_id"),
    }
    lines.append("ids: " + ", ".join(f"{key}={value}" for key, value in ids.items() if value))
    state = {
        "last_status": mapping.get("last_status"),
        "current_status": (session or {}).get("current_status") or (session or {}).get("status"),
        "requires_approval": mapping.get("requires_approval"),
        "approval_id": mapping.get("approval_id"),
    }
    lines.append(
        "state: "
        + ", ".join(f"{key}={value}" for key, value in state.items() if value not in {None, ""})
    )
    if status_result and status_result.text:
        lines.append(f"builder_status_summary: {_truncate_optional(status_result.text, limit=320)}")
    if mapping.get("last_response"):
        lines.append(f"latest_builder_chat: {_truncate_optional(mapping.get('last_response'), limit=320)}")
    if session:
        if session.get("latest_summary"):
            lines.append(f"latest_megaplan_summary: {_truncate_optional(session.get('latest_summary'), limit=420)}")
        if session.get("latest_codex_message"):
            lines.append(f"latest_codex_message: {_truncate_optional(session.get('latest_codex_message'), limit=420)}")
        files = _compact_list(session.get("files_modified"), limit=8)
        if files:
            lines.append(f"files_modified: {', '.join(files)}")
        completed = _compact_list(session.get("commands_completed"), limit=8)
        failed = _compact_list(session.get("commands_failed"), limit=8)
        errors = _compact_list(session.get("errors"), limit=5)
        terminal = []
        if completed:
            terminal.append(f"commands_completed={completed}")
        if failed:
            terminal.append(f"commands_failed={failed}")
        if errors:
            terminal.append(f"errors={errors}")
        if terminal:
            lines.append("terminal_context: " + "; ".join(terminal))
        pending = session.get("pending_action")
        if isinstance(pending, Mapping):
            lines.append(f"pending_action: {_truncate_optional(json.dumps(pending, default=str), limit=320)}")
    if mapping.get("status_fetch_error"):
        lines.append(f"status_fetch_error: {mapping['status_fetch_error']}")
    return "\n".join(line for line in lines if line.strip())[:3000]


class CodexOrchestratorBridge:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.transport = transport

    def load_mapping(self, conversation_id: str) -> dict[str, Any]:
        row = self.db.one(
            """
            SELECT conversation_id, codex_session_id, codex_project_id, codex_task_id,
                   codex_worker_id, requires_approval, approval_id, last_status,
                   last_response, metadata_json
            FROM codex_orchestrator_sessions
            WHERE conversation_id = ?
            """,
            (conversation_id,),
        )
        if not row:
            return {}
        return {
            "conversation_id": row["conversation_id"],
            "codex_session_id": row["codex_session_id"],
            "codex_project_id": row["codex_project_id"],
            "codex_task_id": row["codex_task_id"],
            "codex_worker_id": row["codex_worker_id"],
            "requires_approval": bool(row["requires_approval"]),
            "approval_id": row["approval_id"],
            "last_status": row["last_status"],
            "last_response": row["last_response"],
            "metadata": loads(row["metadata_json"], {}),
        }

    def _save_result(self, result: CodexOrchestratorResult) -> None:
        self.db.execute(
            """
            INSERT INTO codex_orchestrator_sessions(
                conversation_id, codex_session_id, codex_project_id, codex_task_id,
                codex_worker_id, requires_approval, approval_id, last_status,
                last_response, metadata_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(conversation_id) DO UPDATE SET
                codex_session_id = COALESCE(excluded.codex_session_id, codex_orchestrator_sessions.codex_session_id),
                codex_project_id = COALESCE(excluded.codex_project_id, codex_orchestrator_sessions.codex_project_id),
                codex_task_id = COALESCE(excluded.codex_task_id, codex_orchestrator_sessions.codex_task_id),
                codex_worker_id = COALESCE(excluded.codex_worker_id, codex_orchestrator_sessions.codex_worker_id),
                requires_approval = excluded.requires_approval,
                approval_id = excluded.approval_id,
                last_status = excluded.last_status,
                last_response = excluded.last_response,
                metadata_json = excluded.metadata_json,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                result.conversation_id,
                result.codex_session_id,
                result.codex_project_id,
                result.codex_task_id,
                result.codex_worker_id,
                1 if result.requires_approval else 0,
                result.approval_id,
                result.status,
                result.text,
                dumps(result.raw or {}),
            ),
        )

    async def health(self) -> bool:
        try:
            payload = await self._request_json("GET", "/health")
        except httpx.HTTPError:
            return False
        return bool(payload.get("ok", True))

    async def delegate(
        self,
        *,
        conversation_id: str,
        user_text: str,
        transcript: list[Mapping[str, Any]] | None = None,
        mode: str = "plan_first",
        allow_spoken_detail: bool = True,
    ) -> CodexOrchestratorResult:
        if not self.settings.codex_orchestrator_enabled:
            return self._local_result(
                conversation_id,
                "Codex orchestration is not enabled for this voice agent.",
                "disabled",
            )

        mapping = self.load_mapping(conversation_id)
        text = (
            user_text.strip()
            if mapping.get("codex_session_id")
            else self._codexa_text(
                conversation_id,
                user_text,
                transcript or [],
                mode,
                allow_spoken_detail=allow_spoken_detail,
            )
        )
        payload = {
            "user_id": f"voice-agent:{conversation_id}",
            "channel": "web_voice",
            "text": text,
            "timestamp": now_iso(),
            "external_conversation_id": conversation_id,
        }
        if mapping.get("codex_session_id"):
            payload["session_id"] = mapping["codex_session_id"]
        if mapping.get("codex_project_id"):
            payload["project_id"] = mapping["codex_project_id"]

        try:
            raw = await self._request_json("POST", "/agent/chat", json=payload)
        except httpx.TimeoutException:
            recovered = await self._recover_timed_out_session(conversation_id)
            if recovered:
                return recovered
            return self._local_result(
                conversation_id,
                "Codex orchestration timed out. I did not start a new action.",
                "timeout",
            )
        except httpx.HTTPStatusError as exc:
            return self._local_result(
                conversation_id,
                f"Codex orchestration failed with HTTP {exc.response.status_code}.",
                "http_error",
                {"body": exc.response.text[:500]},
            )
        except httpx.HTTPError as exc:
            return self._local_result(
                conversation_id,
                f"I cannot reach Codex orchestration at {self.settings.codex_orchestrator_base_url}.",
                "unreachable",
                {"error_type": type(exc).__name__},
            )

        result = CodexOrchestratorResult(
            text=str(raw.get("text") or "Codex did not return a response.").strip(),
            conversation_id=conversation_id,
            status="completed",
            codex_session_id=_optional_str(raw.get("sessionId") or raw.get("session_id")),
            codex_project_id=_optional_str(raw.get("projectId") or raw.get("project_id")),
            codex_task_id=_optional_str(raw.get("taskId") or raw.get("task_id")),
            codex_worker_id=_optional_str(raw.get("workerId") or raw.get("worker_id")),
            requires_approval=bool(raw.get("requiresApproval") or raw.get("requires_approval")),
            approval_id=_optional_str(raw.get("approvalId") or raw.get("approval_id")),
            raw=raw,
        )
        result = await self._enrich_result_with_status(result)
        result = replace(
            result,
            text=self._voice_summary(
                result,
                user_text=user_text,
                allow_spoken_detail=allow_spoken_detail,
            ),
        )
        self._save_result(result)
        return result

    async def status(
        self,
        conversation_id: str,
        *,
        user_text: str | None = None,
        allow_spoken_detail: bool = True,
    ) -> CodexOrchestratorResult:
        if not self.settings.codex_orchestrator_enabled:
            return self._local_result(
                conversation_id,
                "Codex orchestration is not enabled for this voice agent.",
                "disabled",
            )
        mapping = self.load_mapping(conversation_id)
        session_id = mapping.get("codex_session_id")
        if not session_id:
            healthy = await self.health()
            text = (
                "Codex orchestration is reachable, but this voice conversation is not attached to a Codex session yet."
                if healthy
                else f"I cannot reach Codex orchestration at {self.settings.codex_orchestrator_base_url}."
            )
            return self._local_result(conversation_id, text, "not_attached" if healthy else "unreachable")

        try:
            raw = await self._request_json("GET", "/codex/status", params={"session_id": session_id})
        except httpx.TimeoutException:
            return self._local_result(conversation_id, "Codex status timed out.", "timeout")
        except httpx.HTTPError as exc:
            return self._local_result(
                conversation_id,
                "I cannot fetch Codex status right now.",
                "unreachable",
                {"error_type": type(exc).__name__},
            )

        text = self._format_status(raw)
        session = raw.get("session")
        pending = self._pending_approval(session) if isinstance(session, Mapping) else None
        result = CodexOrchestratorResult(
            text=text,
            conversation_id=conversation_id,
            status="completed",
            codex_session_id=session_id,
            codex_project_id=_optional_str(
                mapping.get("codex_project_id")
                or (session.get("project_id") if isinstance(session, Mapping) else None)
                or (session.get("current_project_id") if isinstance(session, Mapping) else None)
            ),
            codex_task_id=_optional_str(
                mapping.get("codex_task_id")
                or (session.get("active_task_id") if isinstance(session, Mapping) else None)
            ),
            codex_worker_id=_optional_str(
                mapping.get("codex_worker_id")
                or (session.get("active_worker_id") if isinstance(session, Mapping) else None)
            ),
            requires_approval=bool(mapping.get("requires_approval")) or bool(pending),
            approval_id=_approval_id(pending) or _optional_str(mapping.get("approval_id")),
            raw=self._compact_status_response(raw),
        )
        result = replace(
            result,
            text=self._voice_status_summary(
                result,
                fallback=text,
                user_text=user_text or "",
                allow_spoken_detail=allow_spoken_detail,
            ),
        )
        self._save_result(result)
        return result

    async def flowchart(self, conversation_id: str) -> dict[str, Any]:
        if not self.settings.codex_orchestrator_enabled:
            return {"status": "disabled", "nodes": [], "edges": []}
        mapping = self.load_mapping(conversation_id)
        if not mapping.get("codex_session_id"):
            return {"status": "not_attached", "nodes": [], "edges": []}
        try:
            raw = await self._request_json("GET", "/orchestrator/flowchart")
        except httpx.TimeoutException:
            return {"status": "timeout", "nodes": [], "edges": []}
        except httpx.HTTPError as exc:
            return {
                "status": "unreachable",
                "nodes": [],
                "edges": [],
                "error_type": type(exc).__name__,
            }
        return self._filter_flowchart(raw, mapping)

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        timeout = httpx.Timeout(
            self.settings.codex_orchestrator_timeout_seconds,
            connect=min(3.0, self.settings.codex_orchestrator_timeout_seconds),
        )
        async with httpx.AsyncClient(
            base_url=self.settings.codex_orchestrator_base_url.rstrip("/"),
            timeout=timeout,
            transport=self.transport,
        ) as client:
            response = await client.request(method, path, json=json, params=params)
            response.raise_for_status()
            data = response.json()
        return data if isinstance(data, dict) else {"value": data}

    async def _recover_timed_out_session(self, conversation_id: str) -> CodexOrchestratorResult | None:
        for delay_seconds in (0.5, 1.0, 2.0):
            await asyncio.sleep(delay_seconds)
            try:
                raw = await self._request_json("GET", "/codex/status")
            except httpx.HTTPError:
                continue
            session = self._find_session_for_conversation(raw, conversation_id)
            if not session:
                continue
            result = self._result_from_session(conversation_id, session, raw)
            self._save_result(result)
            return result
        return None

    def _find_session_for_conversation(
        self,
        raw: Mapping[str, Any],
        conversation_id: str,
    ) -> Mapping[str, Any] | None:
        sessions = raw.get("sessions")
        if not isinstance(sessions, list):
            return None
        user_id = f"voice-agent:{conversation_id}"
        for session in sessions:
            if isinstance(session, Mapping) and session.get("user_id") == user_id:
                return session
        return None

    def _result_from_session(
        self,
        conversation_id: str,
        session: Mapping[str, Any],
        raw: Mapping[str, Any],
    ) -> CodexOrchestratorResult:
        pending = self._pending_approval(session)
        text = str(
            session.get("latest_codex_message")
            or session.get("summary_text")
            or session.get("latest_summary")
            or "Codex completed the request, but did not return a spoken response."
        ).strip()
        result_raw = {
            "recovered_after_timeout": True,
            "session": self._compact_session(session),
            "status_response": self._compact_status_response(raw),
        }
        return CodexOrchestratorResult(
            text=text,
            conversation_id=conversation_id,
            status="completed",
            codex_session_id=_optional_str(session.get("session_id")),
            codex_project_id=_optional_str(session.get("project_id") or session.get("current_project_id")),
            codex_task_id=_optional_str(session.get("active_task_id")),
            codex_worker_id=_optional_str(session.get("active_worker_id")),
            requires_approval=bool(pending),
            approval_id=_approval_id(pending),
            raw=result_raw,
        )

    async def _enrich_result_with_status(
        self,
        result: CodexOrchestratorResult,
    ) -> CodexOrchestratorResult:
        if not result.codex_session_id:
            return result
        try:
            raw_status = await self._request_json(
                "GET",
                "/codex/status",
                params={"session_id": result.codex_session_id},
            )
        except httpx.HTTPError:
            return result
        session = raw_status.get("session")
        if not isinstance(session, Mapping):
            return result
        pending = self._pending_approval(session)
        raw = dict(result.raw or {})
        raw["status_response"] = self._compact_status_response(raw_status)
        return CodexOrchestratorResult(
            text=result.text,
            conversation_id=result.conversation_id,
            status=result.status,
            codex_session_id=result.codex_session_id,
            codex_project_id=(
                result.codex_project_id
                or _optional_str(session.get("project_id") or session.get("current_project_id"))
            ),
            codex_task_id=result.codex_task_id or _optional_str(session.get("active_task_id")),
            codex_worker_id=result.codex_worker_id or _optional_str(session.get("active_worker_id")),
            requires_approval=result.requires_approval or bool(pending),
            approval_id=_approval_id(pending) or result.approval_id,
            raw=raw,
        )

    def _pending_approval(self, session: Mapping[str, Any]) -> Mapping[str, Any] | None:
        pending_approvals = session.get("pending_approvals")
        if isinstance(pending_approvals, list):
            pending = next(
                (
                    item
                    for item in pending_approvals
                    if isinstance(item, Mapping) and item.get("status") == "pending"
                ),
                None,
            )
            if pending:
                return pending
        pending_action = session.get("pending_action")
        if isinstance(pending_action, Mapping):
            return pending_action
        pending_payload = session.get("pending_action_payload")
        if isinstance(pending_payload, Mapping):
            return pending_payload
        if str(session.get("approval_status") or "").strip().lower() == "pending":
            return {"id": "approval_pending"}
        return None

    def _compact_status_response(self, raw: Mapping[str, Any]) -> dict[str, Any]:
        session = raw.get("session")
        if isinstance(session, Mapping):
            return {"session": self._compact_session(session)}
        sessions = raw.get("sessions")
        if isinstance(sessions, list):
            return {
                "sessions": [
                    self._compact_session(item)
                    for item in sessions
                    if isinstance(item, Mapping)
                ][:5]
            }
        return {key: raw[key] for key in ("ok", "error", "code") if key in raw}

    def _compact_session(self, session: Mapping[str, Any]) -> dict[str, Any]:
        pending = self._pending_approval(session)
        return {
            "session_id": _optional_str(session.get("session_id")),
            "status": _optional_str(session.get("status")),
            "current_status": _optional_str(session.get("current_status")),
            "project_id": _optional_str(session.get("project_id") or session.get("current_project_id")),
            "active_task_id": _optional_str(session.get("active_task_id")),
            "active_worker_id": _optional_str(session.get("active_worker_id")),
            "latest_summary": _truncate_optional(session.get("latest_summary")),
            "latest_codex_message": _truncate_optional(session.get("latest_codex_message")),
            "pending_action": (
                {
                    "type": _optional_str(pending.get("type") if pending else None),
                    "action": _optional_str(pending.get("action") if pending else None),
                    "reason": _truncate_optional(pending.get("reason") if pending else None),
                }
                if pending
                else None
            ),
            "files_modified": _compact_list(session.get("files_modified")),
            "commands_completed": _compact_list(session.get("commands_completed")),
            "commands_failed": _compact_list(session.get("commands_failed")),
            "errors": _compact_list(session.get("errors"), limit=5),
        }

    def _filter_flowchart(
        self,
        raw: Mapping[str, Any],
        mapping: Mapping[str, Any],
    ) -> dict[str, Any]:
        nodes = raw.get("nodes")
        edges = raw.get("edges")
        if not isinstance(nodes, list):
            nodes = []
        if not isinstance(edges, list):
            edges = []
        needles = [
            str(value)
            for value in (
                mapping.get("codex_session_id"),
                mapping.get("codex_project_id"),
                mapping.get("codex_task_id"),
                mapping.get("codex_worker_id"),
            )
            if value
        ]
        kept_nodes: list[dict[str, Any]] = []
        kept_ids: set[str] = set()
        for node in nodes:
            if not isinstance(node, Mapping):
                continue
            if needles and not _flowchart_node_mentions(node, needles):
                continue
            compact = self._compact_flowchart_node(node)
            node_id = str(compact.get("id") or "").strip()
            if not node_id or node_id in kept_ids:
                continue
            kept_ids.add(node_id)
            kept_nodes.append(compact)

        kept_edges: list[dict[str, Any]] = []
        for edge in edges:
            if not isinstance(edge, Mapping):
                continue
            source = _optional_str(edge.get("from") or edge.get("source"))
            target = _optional_str(edge.get("to") or edge.get("target"))
            if not source or not target or source not in kept_ids or target not in kept_ids:
                continue
            kept_edges.append(
                {
                    "id": _optional_str(edge.get("id")) or f"{source}->{target}",
                    "from": source,
                    "to": target,
                    "label": _truncate_optional(edge.get("label"), limit=80),
                }
            )

        kept_nodes.sort(key=_flowchart_node_sort_key)
        return {
            "status": "completed",
            "generated_at": _optional_str(raw.get("generated_at")),
            "nodes": kept_nodes[:24],
            "edges": kept_edges[:48],
        }

    def _compact_flowchart_node(self, node: Mapping[str, Any]) -> dict[str, Any]:
        detail = node.get("detail")
        compact_detail = _compact_flowchart_detail(detail if isinstance(detail, Mapping) else {})
        return {
            "id": _optional_str(node.get("id")),
            "type": _optional_str(node.get("type")),
            "label": _truncate_optional(node.get("label"), limit=80),
            "status": _optional_str(node.get("status")),
            "visual_state": _optional_str(node.get("visual_state")),
            "badges": _compact_list(node.get("badges"), limit=6),
            "summary": _truncate_optional(node.get("summary"), limit=220),
            "detail": compact_detail,
        }

    def _codexa_text(
        self,
        conversation_id: str,
        user_text: str,
        transcript: list[Mapping[str, Any]],
        mode: str,
        *,
        allow_spoken_detail: bool = True,
    ) -> str:
        if is_codex_approval_response(user_text):
            return user_text.strip()

        return user_text.strip()

    def _format_transcript(self, transcript: list[Mapping[str, Any]]) -> str:
        lines: list[str] = []
        for turn in transcript[-self.settings.codex_orchestrator_transcript_turns :]:
            role = str(turn.get("role") or "").strip()
            if role not in {"user", "assistant", "system"}:
                continue
            content = str(turn.get("content") or turn.get("text") or "").strip()
            if not content:
                continue
            lines.append(f"{role.title()}: {content}")
        text = "\n".join(lines)
        max_chars = self.settings.codex_orchestrator_transcript_max_chars
        if len(text) <= max_chars:
            return text
        return text[-max_chars:]

    def _format_status(self, raw: Mapping[str, Any]) -> str:
        session = raw.get("session")
        source = session if isinstance(session, Mapping) else raw
        summary = str(
            source.get("latest_codex_message")
            or source.get("summary_text")
            or source.get("summary")
            or source.get("latest_summary")
            or "No Codex summary is available yet."
        ).strip()
        files = source.get("files_modified") if isinstance(source.get("files_modified"), list) else []
        pending = source.get("pending_approvals") if isinstance(source.get("pending_approvals"), list) else []
        pending_action = self._pending_approval(source)
        parts = [summary]
        if files:
            parts.append(f"Files modified: {', '.join(str(item) for item in files[:6])}.")
        if pending:
            approval = pending[0] if isinstance(pending[0], Mapping) else {}
            command = str(approval.get("command") or "approval required")
            parts.append(f"Pending approval: {command}.")
        elif pending_action:
            action = str(pending_action.get("action") or pending_action.get("type") or "approval required")
            reason = str(pending_action.get("reason") or "").strip()
            parts.append(f"Pending approval: {action}.{(' ' + reason) if reason else ''}")
        return " ".join(part for part in parts if part).strip()

    def _voice_summary(
        self,
        result: CodexOrchestratorResult,
        *,
        user_text: str,
        allow_spoken_detail: bool,
    ) -> str:
        if result.status in {"disabled", "timeout", "http_error", "unreachable"}:
            return self._short_text(result.text, limit=110)
        if allow_spoken_detail and is_codex_detail_request(user_text):
            return self._detailed_voice_text(result.text)
        if is_codex_approval_response(user_text):
            return self._short_text(result.text, limit=120) or "Approved. Codex is continuing."
        if result.requires_approval:
            summary = self._approval_summary(result)
            if summary:
                return self._with_builder_megaplan_hint(
                    self._with_approval_hint(summary)
                )
            return self._with_builder_megaplan_hint(
                self._with_approval_hint(self._short_text(result.text, limit=120) or "Plan ready.")
            )
        if "?" in result.text:
            return self._short_text(result.text, limit=110)
        session = _metadata_session(result.raw)
        current_status = _normalize(str(session.get("current_status") or session.get("status") or "")) if session else ""
        if any(word in current_status for word in ("running", "working", "busy", "planning")):
            return self._with_builder_megaplan_hint(
                self._short_text(result.text, limit=120) or "Codex is working."
            )
        if result.codex_session_id:
            return self._with_builder_megaplan_hint(
                self._short_text(result.text, limit=120) or "Builder session updated."
            )
        return self._short_text(result.text, limit=110)

    def _voice_status_summary(
        self,
        result: CodexOrchestratorResult,
        *,
        fallback: str,
        user_text: str,
        allow_spoken_detail: bool,
    ) -> str:
        if allow_spoken_detail and is_codex_detail_request(user_text):
            return self._detailed_voice_text(fallback)
        if result.requires_approval:
            return self._with_builder_megaplan_hint(
                self._with_approval_hint(self._short_text(fallback, limit=120) or "Waiting for approval.")
            )
        session = _metadata_session(result.raw)
        current_status = _normalize(str(session.get("current_status") or session.get("status") or "")) if session else ""
        if any(word in current_status for word in ("running", "working", "busy", "planning")):
            return self._with_builder_megaplan_hint(self._short_text(fallback, limit=120) or "Codex is working.")
        if any(word in current_status for word in ("failed", "error")):
            return self._with_builder_megaplan_hint(
                self._short_text(fallback, limit=120) or "Codex hit an issue."
            )
        return self._with_builder_megaplan_hint(self._short_text(fallback, limit=120) or "Builder is synced.")

    def _approval_summary(self, result: CodexOrchestratorResult) -> str:
        session = _metadata_session(result.raw)
        latest_summary = str((session or {}).get("latest_summary") or "").strip()
        if latest_summary:
            target = self._approval_target(latest_summary)
            if target:
                return f"Megaplan is ready for {target}."
        return "Megaplan is ready."

    def _approval_target(self, summary: str) -> str:
        cleaned = " ".join(str(summary or "").split()).strip()
        if not cleaned:
            return ""
        first_sentence = re.split(r"\.\s+", cleaned, maxsplit=1)[0]
        target = re.sub(r"^build\s+", "", first_sentence, flags=re.IGNORECASE)
        target = re.sub(r"\s+in\s+`?/[^`.,;]+`?", "", target)
        target = re.sub(
            r"\s+using\s+conservative[^.;]*defaults\b",
            "",
            target,
            flags=re.IGNORECASE,
        )
        target = re.sub(
            r"\s+with\s+conservative[^.;]*defaults\b",
            "",
            target,
            flags=re.IGNORECASE,
        )
        target = re.split(
            r"\b(?:include|technical direction|validation|no backend|you will)\b",
            target,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0].strip(" .;:")
        if not target:
            return ""
        return self._short_text(f"{target}.", limit=80).rstrip(" .")

    def _with_builder_megaplan_hint(self, text: str) -> str:
        cleaned = " ".join(str(text or "").split()).strip()
        if not cleaned:
            return "Builder has the Megaplan."
        normalized = cleaned.casefold()
        if "builder" in normalized and "megaplan" in normalized:
            return cleaned
        base = cleaned.rstrip(" .!?")
        return f"{base}; Builder has the Megaplan."

    def _with_approval_hint(self, text: str) -> str:
        cleaned = " ".join(str(text or "").split()).strip()
        if not cleaned:
            return "Say approve to continue."
        if "approve" in cleaned.casefold():
            return cleaned
        base = cleaned.rstrip(" .!?")
        return f"{base}; say approve to continue."

    def _detailed_voice_text(self, text: str) -> str:
        cleaned = " ".join(str(text or "").split()).strip()
        if not cleaned:
            return "I do not have a longer Codex summary yet. Builder has the Megaplan."
        if "builder" in cleaned.casefold() and "megaplan" in cleaned.casefold():
            return cleaned
        return f"{cleaned} Builder has the Megaplan."

    @staticmethod
    def _short_text(text: str, *, limit: int) -> str:
        cleaned = " ".join(str(text or "").split())
        if not cleaned:
            return ""
        match = re.search(r"^(.+?[.!?])(?:\s|$)", cleaned)
        candidate = match.group(1) if match else cleaned
        if len(candidate) <= limit:
            return candidate
        truncated = candidate[:limit].rsplit(" ", 1)[0].rstrip(" ,;:")
        return f"{truncated}..."

    def _local_result(
        self,
        conversation_id: str,
        text: str,
        status: str,
        raw: dict[str, Any] | None = None,
    ) -> CodexOrchestratorResult:
        result = CodexOrchestratorResult(
            text=text,
            conversation_id=conversation_id,
            status=status,
            raw=raw or {"local_status": status},
        )
        conversation = self.db.one(
            "SELECT id FROM conversations WHERE id = ?",
            (conversation_id,),
        )
        if conversation:
            self._save_result(result)
        return result


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _truncate_optional(value: Any, *, limit: int = 600) -> str | None:
    text = _optional_str(value)
    if text is None or len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."


def _compact_list(value: Any, *, limit: int = 20) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value[:limit]]


def _compact_flowchart_detail(detail: Mapping[str, Any]) -> dict[str, Any]:
    compact: dict[str, Any] = {}
    for key in (
        "channel",
        "current_plan",
        "latest_decision",
        "orchestrator",
        "source_of_truth",
        "subagents",
    ):
        if key in detail:
            compact[key] = _compact_json_value(detail[key])
    session = detail.get("session")
    if isinstance(session, Mapping):
        compact["session"] = {
            "session_id": _optional_str(session.get("session_id")),
            "user_id": _optional_str(session.get("user_id")),
            "channel": _optional_str(session.get("channel")),
            "current_project_id": _optional_str(session.get("current_project_id")),
            "active_task_id": _optional_str(session.get("active_task_id")),
            "active_worker_id": _optional_str(session.get("active_worker_id")),
            "current_status": _optional_str(session.get("current_status")),
            "latest_codex_message": _truncate_optional(session.get("latest_codex_message"), limit=180),
        }
    task = detail.get("task")
    if isinstance(task, Mapping):
        compact["task"] = {
            "task_id": _optional_str(task.get("task_id")),
            "project_id": _optional_str(task.get("project_id")),
            "status": _optional_str(task.get("status")),
            "latest_summary": _truncate_optional(task.get("latest_summary"), limit=180),
            "execution_backend": _optional_str(task.get("execution_backend")),
        }
    return compact


def _compact_json_value(value: Any, *, limit: int = 8) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): _compact_json_value(item, limit=limit)
            for key, item in list(value.items())[:limit]
            if key not in {"raw_events", "conversation_history"}
        }
    if isinstance(value, list):
        return [_compact_json_value(item, limit=limit) for item in value[:limit]]
    if isinstance(value, str):
        return _truncate_optional(value, limit=180)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _truncate_optional(value, limit=180)


def _flowchart_node_mentions(node: Mapping[str, Any], needles: list[str]) -> bool:
    try:
        searchable = json.dumps(
            {
                "id": node.get("id"),
                "type": node.get("type"),
                "label": node.get("label"),
                "summary": node.get("summary"),
                "detail": node.get("detail"),
            },
            default=str,
            ensure_ascii=False,
        )
    except TypeError:
        searchable = str(node)
    return any(needle in searchable for needle in needles)


def _flowchart_node_sort_key(node: Mapping[str, Any]) -> tuple[int, str]:
    node_type = str(node.get("type") or "")
    priority = {
        "channel": 0,
        "orchestrator": 1,
        "session": 2,
        "project": 3,
        "task": 4,
        "codex_plan": 5,
        "user_approval": 6,
        "codex_session": 7,
        "subagent_advisor": 8,
        "flowchart_maker": 9,
        "codex_subagent": 10,
        "validation": 11,
        "preview": 12,
        "quality_check": 13,
        "final_summary": 14,
    }.get(node_type, 50)
    return (priority, str(node.get("id") or ""))


def _metadata_session(raw: Mapping[str, Any] | None) -> Mapping[str, Any] | None:
    if not isinstance(raw, Mapping):
        return None
    session = raw.get("session")
    if isinstance(session, Mapping):
        return session
    status_response = raw.get("status_response")
    if isinstance(status_response, Mapping):
        session = status_response.get("session")
        if isinstance(session, Mapping):
            return session
    return None


def _approval_id(pending: Mapping[str, Any] | None) -> str | None:
    if not pending:
        return None
    return _optional_str(
        pending.get("id")
        or pending.get("approval_id")
        or pending.get("type")
        or pending.get("action")
    )
