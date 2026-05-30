from __future__ import annotations

import re
import time
import uuid
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from .codex_orchestrator import CodexOrchestratorBridge
from .config import Settings
from .db import Database, dumps, loads
from .llm import LLMClient, Message


FlowGraph = dict[str, Any]

FLOW_NODE_TYPES = [
    "start",
    "dialogue",
    "collect",
    "confirm",
    "condition",
    "api",
    "codex_task",
    "knowledge_base",
    "sms",
    "email",
    "transfer_call",
    "set_state",
    "wait",
    "fallback",
    "handoff",
    "end",
]

VOICE_PRESETS = [
    "neutral",
    "calm",
    "confident",
    "friendly",
    "careful",
    "sympathetic",
    "energetic",
    "spooky",
    "arrogant",
    "condescending",
    "whisper",
]
LATENCY_PROFILES = ["instant", "fast", "balanced", "quality", "async"]


def _voice(tone: str = "calm", speed: float = 1.0, allow_barge_in: bool = True) -> dict[str, Any]:
    return {
        "voiceId": "af_heart",
        "tone": tone,
        "speed": speed,
        "language": "en",
        "allowBargeIn": allow_barge_in,
    }


def _latency(profile: str = "fast", target_ms: int = 800) -> dict[str, Any]:
    return {"profile": profile, "targetMs": target_ms}


def _node(
    node_id: str,
    node_type: str,
    label: str,
    x: int,
    y: int,
    *,
    purpose: str,
    prompt: str = "",
    script: str = "",
    outputs: list[str] | None = None,
    category: str = "in-call",
    tone: str = "calm",
    latency_profile: str = "fast",
    target_ms: int = 800,
    fields: list[dict[str, Any]] | None = None,
    endpoint: str | None = None,
    integration: dict[str, Any] | None = None,
    llm: dict[str, Any] | None = None,
    response_mode: str | None = None,
    auto_advance: bool = False,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "type": "flowNode",
        "position": {"x": x, "y": y},
        "data": {
            "label": label,
            "nodeType": node_type,
            "category": category,
            "purpose": purpose,
            "prompt": prompt,
            "script": script or prompt,
            "outputs": outputs or ["Continue"],
            "fields": fields or [],
            "endpoint": endpoint,
            "integration": integration or {},
            "llm": llm or {},
            "responseMode": response_mode,
            "autoAdvance": auto_advance,
            "voice": _voice(tone=tone),
            "latency": _latency(latency_profile, target_ms),
            "interrupt": {
                "enabled": node_type not in {"start", "end"},
                "stopSpeaking": True,
                "routes": [{"intent": "correction_or_cancel", "target": "clarify_request"}],
            },
            "fallback": {"unclear": "clarify_request", "failed": "repair"},
        },
    }


def _edge(
    edge_id: str,
    source: str,
    target: str,
    label: str,
    keywords: list[str] | None = None,
    style: str = "normal",
) -> dict[str, Any]:
    return {
        "id": edge_id,
        "source": source,
        "target": target,
        "label": label,
        "data": {"keywords": keywords or [], "style": style},
    }


DEFAULT_FLOW_GRAPH: FlowGraph = {
    "nodes": [
        _node(
            "start",
            "start",
            "Start",
            -720,
            0,
            category="pre-call",
            purpose="Entry point for the live voice session; audio is already always-on.",
            outputs=["Begin"],
            latency_profile="instant",
            target_ms=120,
        ),
        _node(
            "opening",
            "dialogue",
            "Flow Voice Opening",
            -460,
            0,
            purpose="Start the flow-bound conversational voice agent.",
            script="I am an AI assistant. What would you like to do?",
            outputs=["Continue"],
            tone="friendly",
            latency_profile="instant",
            target_ms=250,
            auto_advance=True,
        ),
        _node(
            "listen_for_intent",
            "collect",
            "Listen For Intent",
            -150,
            0,
            purpose="Capture the user's latest request and route it through the flow.",
            script="I'm listening.",
            outputs=["Tone change", "Long form", "Answer", "Needs clarification"],
            fields=[{"name": "user_request", "type": "text", "required": True}],
            tone="calm",
            target_ms=700,
        ),
        _node(
            "tone_control",
            "dialogue",
            "Apply Tone Control",
            170,
            -150,
            purpose="Acknowledge requested tone or speaking-style changes.",
            script="Got it, I'll adjust my tone.",
            outputs=["Continue"],
            tone="confident",
            latency_profile="instant",
            target_ms=250,
        ),
        _node(
            "answer_request",
            "dialogue",
            "Answer Request",
            170,
            0,
            purpose="Answer the user's request naturally while staying inside the flow.",
            prompt=(
                "Answer as a conversational voice AI. Honor requested tone, speed, language, "
                "and length. Do not claim external actions are complete."
            ),
            script="",
            outputs=["Continue"],
            tone="neutral",
            target_ms=900,
            llm={"mode": "open"},
            response_mode="llm",
        ),
        _node(
            "long_form_response",
            "dialogue",
            "Long Form Response",
            170,
            150,
            purpose="Give complete multi-sentence stories, explanations, or detailed answers.",
            prompt=(
                "Give a complete spoken response. If the user requested a story, explanation, "
                "or specific number of sentences, satisfy that length directly."
            ),
            script="",
            outputs=["Continue"],
            tone="careful",
            target_ms=1200,
            llm={"mode": "open"},
            response_mode="llm",
        ),
        _node(
            "clarify_request",
            "dialogue",
            "Clarify Request",
            490,
            0,
            purpose="Ask one focused follow-up when the request is ambiguous.",
            script="I want to make sure I get this right. What should I focus on?",
            outputs=["Continue"],
            tone="careful",
            target_ms=500,
        ),
        _node(
            "repair",
            "fallback",
            "Repair",
            490,
            170,
            purpose="Recover from unclear input, interruptions, and tool failures.",
            script="I missed that. Say it again and I'll stay with the flow.",
            outputs=["Retry"],
            tone="sympathetic",
            latency_profile="instant",
            target_ms=250,
        ),
        _node(
            "end",
            "end",
            "End",
            800,
            0,
            purpose="Close the flow run and persist transcript history.",
            script="Done.",
            outputs=["Complete"],
            tone="neutral",
            latency_profile="instant",
            target_ms=200,
        ),
    ],
    "edges": [
        _edge("start-opening", "start", "opening", "Start"),
        _edge("opening-listen", "opening", "listen_for_intent", "Continue"),
        _edge(
            "listen-tone",
            "listen_for_intent",
            "tone_control",
            "Tone change",
            ["tone", "style", "sound", "arrogant", "condescending", "calm", "friendly", "whisper"],
        ),
        _edge(
            "listen-long",
            "listen_for_intent",
            "long_form_response",
            "Long form",
            ["story", "explain", "detail", "details", "longer", "continue", "narrate"],
        ),
        _edge(
            "listen-answer",
            "listen_for_intent",
            "answer_request",
            "Answer",
            ["who", "what", "when", "where", "why", "how", "tell", "can", "should"],
        ),
        _edge(
            "listen-clarify",
            "listen_for_intent",
            "clarify_request",
            "Needs clarification",
            ["maybe", "something", "whatever", "not sure", "clarify"],
        ),
        _edge(
            "listen-end",
            "listen_for_intent",
            "end",
            "End",
            ["bye", "goodbye", "done", "finish", "end conversation"],
        ),
        _edge("tone-listen", "tone_control", "listen_for_intent", "Continue"),
        _edge("answer-listen", "answer_request", "listen_for_intent", "Continue"),
        _edge("long-listen", "long_form_response", "listen_for_intent", "Continue"),
        _edge("clarify-listen", "clarify_request", "listen_for_intent", "Continue"),
        _edge("repair-listen", "repair", "listen_for_intent", "Retry"),
    ],
    "viewport": {"x": -45, "y": 170, "zoom": 0.42},
    "metadata": {
        "schemaVersion": 4,
        "defaultVoice": "neutral_female",
        "defaultLatencyProfile": "fast",
        "alwaysListening": True,
        "runtime": "flow-bound-conversational-voice-agent",
        "voiceDuties": [
            "listen",
            "route_intent",
            "answer",
            "change_tone",
            "change_speed",
            "handle_interruptions",
            "repair",
        ],
    },
}


@dataclass(frozen=True)
class FlowDefinition:
    id: str
    name: str
    description: str
    status: str
    version: int
    graph: FlowGraph
    published_graph: FlowGraph | None
    validation: dict[str, Any]
    created_at: str
    updated_at: str
    published_at: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "status": self.status,
            "version": self.version,
            "graph": self.graph,
            "published_graph": self.published_graph,
            "validation": self.validation,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "published_at": self.published_at,
        }


def default_flow_graph() -> FlowGraph:
    return deepcopy(DEFAULT_FLOW_GRAPH)


def flow_summary(flow: FlowDefinition) -> dict[str, Any]:
    return {
        "id": flow.id,
        "name": flow.name,
        "description": flow.description,
        "status": flow.status,
        "version": flow.version,
        "node_count": len(flow.graph.get("nodes", [])),
        "edge_count": len(flow.graph.get("edges", [])),
        "validation": flow.validation,
        "updated_at": flow.updated_at,
        "published_at": flow.published_at,
    }


def _node_type(node: dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    value = data.get("nodeType") or node.get("type") or ""
    return str(value)


def _node_data(node: dict[str, Any]) -> dict[str, Any]:
    data = node.get("data")
    return data if isinstance(data, dict) else {}


def _outgoing_edges(graph: FlowGraph, node_id: str) -> list[dict[str, Any]]:
    return [edge for edge in graph.get("edges", []) if edge.get("source") == node_id]


def _target_node(graph: FlowGraph, node_id: str | None) -> dict[str, Any] | None:
    if not node_id:
        return None
    for node in graph.get("nodes", []):
        if node.get("id") == node_id:
            return node
    return None


def _first_outgoing_target(graph: FlowGraph, node_id: str) -> str | None:
    edges = _outgoing_edges(graph, node_id)
    if not edges:
        return None
    return str(edges[0].get("target") or "")


def _implicit_targets(node: dict[str, Any]) -> list[str]:
    data = _node_data(node)
    targets: list[str] = []
    interrupt = data.get("interrupt") if isinstance(data.get("interrupt"), dict) else {}
    routes = interrupt.get("routes") if isinstance(interrupt.get("routes"), list) else []
    for route in routes:
        if isinstance(route, dict) and route.get("target"):
            targets.append(str(route["target"]))
    fallback = data.get("fallback") if isinstance(data.get("fallback"), dict) else {}
    for value in fallback.values():
        if isinstance(value, str):
            targets.append(value)
    return targets


def validate_flow_graph(graph: FlowGraph) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []

    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(nodes, list) or not nodes:
        errors.append("Graph needs at least one node.")
        nodes = []
    if not isinstance(edges, list):
        errors.append("Graph edges must be a list.")
        edges = []

    node_ids = [str(node.get("id")) for node in nodes if node.get("id")]
    duplicate_ids = sorted({node_id for node_id in node_ids if node_ids.count(node_id) > 1})
    if duplicate_ids:
        errors.append(f"Duplicate node ids: {', '.join(duplicate_ids)}.")

    node_id_set = set(node_ids)
    start_nodes = [node for node in nodes if _node_type(node) == "start"]
    if len(start_nodes) != 1:
        errors.append("Graph needs exactly one start node.")

    for node in nodes:
        node_id = str(node.get("id") or "missing")
        data = _node_data(node)
        node_type = _node_type(node)
        if node_type not in FLOW_NODE_TYPES:
            errors.append(f"{node_id} uses unsupported node type '{node_type}'.")
        if node_type != "start" and not str(data.get("label") or "").strip():
            warnings.append(f"{node_id} should have a readable label.")
        if node_type in {
            "dialogue",
            "collect",
            "confirm",
            "api",
            "codex_task",
            "wait",
            "fallback",
            "handoff",
            "transfer_call",
            "end",
        }:
            if not str(data.get("prompt") or "").strip():
                if not str(data.get("script") or "").strip():
                    warnings.append(f"{node_id} should have a prompt or spoken script.")
        if node_type not in {"start", "handoff", "transfer_call", "end"}:
            interrupt = data.get("interrupt") if isinstance(data.get("interrupt"), dict) else {}
            if not interrupt.get("enabled"):
                warnings.append(f"{node_id} has no interruption path.")
        latency = data.get("latency") if isinstance(data.get("latency"), dict) else {}
        profile = latency.get("profile")
        if profile and profile not in LATENCY_PROFILES:
            warnings.append(f"{node_id} uses unknown latency profile '{profile}'.")
        voice = data.get("voice") if isinstance(data.get("voice"), dict) else {}
        tone = voice.get("tone")
        if tone and tone not in VOICE_PRESETS:
            warnings.append(f"{node_id} uses custom tone '{tone}'.")

    for edge in edges:
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        edge_id = str(edge.get("id") or f"{source}->{target}")
        if source not in node_id_set:
            errors.append(f"Edge {edge_id} has missing source '{source}'.")
        if target not in node_id_set:
            errors.append(f"Edge {edge_id} has missing target '{target}'.")

    if len(start_nodes) == 1:
        start_id = str(start_nodes[0].get("id"))
        reachable = {start_id}
        queue = [start_id]
        while queue:
            current = queue.pop(0)
            for edge in edges:
                if edge.get("source") != current:
                    continue
                target = str(edge.get("target") or "")
                if target and target not in reachable:
                    reachable.add(target)
                    queue.append(target)
            node = _target_node(graph, current)
            for target in _implicit_targets(node) if node else []:
                if target in node_id_set and target not in reachable:
                    reachable.add(target)
                    queue.append(target)
        unreachable = sorted(node_id_set - reachable)
        if unreachable:
            warnings.append(f"Unreachable nodes: {', '.join(unreachable)}.")

    end_nodes = [node for node in nodes if _node_type(node) == "end"]
    if not end_nodes:
        warnings.append("Graph should include at least one end node.")

    fallback_nodes = [node for node in nodes if _node_type(node) == "fallback"]
    if not fallback_nodes:
        warnings.append("Graph should include a fallback or repair node.")

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "node_count": len(nodes),
        "edge_count": len(edges),
    }


class FlowRepository:
    def __init__(self, db: Database) -> None:
        self.db = db
        self.ensure_default_flow()

    def ensure_default_flow(self) -> None:
        row = self.db.one(
            """
            SELECT id, graph_json
            FROM flow_definitions
            WHERE id = 'default-voice-flow'
            """
        )
        if row:
            graph = loads(row["graph_json"], {})
            metadata = graph.get("metadata") if isinstance(graph, dict) else {}
            if isinstance(metadata, dict) and metadata.get("schemaVersion") == 4:
                return
            graph = default_flow_graph()
            validation = validate_flow_graph(graph)
            self.db.execute(
                """
                UPDATE flow_definitions
                SET name = ?, description = ?, status = 'published', version = version + 1,
                    graph_json = ?, published_graph_json = ?, validation_json = ?,
                    updated_at = CURRENT_TIMESTAMP, published_at = CURRENT_TIMESTAMP
                WHERE id = 'default-voice-flow'
                """,
                (
                    "Flow Voice Agent",
                    "Flow-bound conversational voice workflow with tone control, routing, repair, and long-form responses.",
                    dumps(graph),
                    dumps(graph),
                    dumps(validation),
                ),
            )
            return
        graph = default_flow_graph()
        validation = validate_flow_graph(graph)
        flow_id = "default-voice-flow"
        self.db.execute(
            """
            INSERT INTO flow_definitions(
                id, name, description, status, version, graph_json,
                published_graph_json, validation_json, published_at
            )
            VALUES (?, ?, ?, 'published', 1, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                flow_id,
                "Flow Voice Agent",
                "Flow-bound conversational voice workflow with tone control, routing, repair, and long-form responses.",
                dumps(graph),
                dumps(graph),
                dumps(validation),
            ),
        )

    def list(self) -> list[FlowDefinition]:
        rows = self.db.all(
            """
            SELECT id, name, description, status, version, graph_json, published_graph_json,
                   validation_json, created_at, updated_at, published_at
            FROM flow_definitions
            ORDER BY updated_at DESC
            """
        )
        return [self._from_row(row) for row in rows]

    def get(self, flow_id: str) -> FlowDefinition:
        row = self.db.one(
            """
            SELECT id, name, description, status, version, graph_json, published_graph_json,
                   validation_json, created_at, updated_at, published_at
            FROM flow_definitions
            WHERE id = ?
            """,
            (flow_id,),
        )
        if not row:
            raise KeyError(flow_id)
        return self._from_row(row)

    def active(self) -> FlowDefinition:
        row = self.db.one(
            """
            SELECT id
            FROM flow_definitions
            WHERE status = 'published'
            ORDER BY published_at DESC, updated_at DESC
            LIMIT 1
            """
        )
        if not row:
            self.ensure_default_flow()
            row = self.db.one("SELECT id FROM flow_definitions LIMIT 1")
        if not row:
            raise RuntimeError("No flow definition exists.")
        return self.get(row["id"])

    def update(self, flow_id: str, name: str, description: str, graph: FlowGraph) -> FlowDefinition:
        current = self.get(flow_id)
        validation = validate_flow_graph(graph)
        self.db.execute(
            """
            UPDATE flow_definitions
            SET name = ?, description = ?, graph_json = ?, validation_json = ?,
                version = ?, status = CASE WHEN status = 'archived' THEN 'archived' ELSE 'draft' END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                name.strip() or current.name,
                description.strip(),
                dumps(graph),
                dumps(validation),
                current.version + 1,
                flow_id,
            ),
        )
        return self.get(flow_id)

    def publish(self, flow_id: str) -> FlowDefinition:
        current = self.get(flow_id)
        validation = validate_flow_graph(current.graph)
        if not validation["ok"]:
            raise ValueError("; ".join(validation["errors"]))
        self.db.execute(
            """
            UPDATE flow_definitions
            SET status = 'published', published_graph_json = ?, validation_json = ?,
                updated_at = CURRENT_TIMESTAMP, published_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (dumps(current.graph), dumps(validation), flow_id),
        )
        return self.get(flow_id)

    def create(self, name: str, description: str = "") -> FlowDefinition:
        graph = default_flow_graph()
        flow_id = str(uuid.uuid4())
        validation = validate_flow_graph(graph)
        self.db.execute(
            """
            INSERT INTO flow_definitions(
                id, name, description, status, version, graph_json, validation_json
            )
            VALUES (?, ?, ?, 'draft', 1, ?, ?)
            """,
            (
                flow_id,
                name.strip() or "Untitled voice flow",
                description.strip(),
                dumps(graph),
                dumps(validation),
            ),
        )
        return self.get(flow_id)

    def _from_row(self, row) -> FlowDefinition:
        graph = loads(row["graph_json"], default_flow_graph())
        return FlowDefinition(
            id=row["id"],
            name=row["name"],
            description=row["description"],
            status=row["status"],
            version=row["version"],
            graph=graph,
            published_graph=loads(row["published_graph_json"], None),
            validation=validate_flow_graph(graph),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            published_at=row["published_at"],
        )


class FlowRuntime:
    def __init__(
        self,
        db: Database,
        repo: FlowRepository,
        llm: LLMClient,
        settings: Settings | None = None,
    ) -> None:
        self.db = db
        self.repo = repo
        self.llm = llm
        self.settings = settings or Settings()

    async def start_run(self, flow_id: str, conversation_id: str | None = None) -> dict[str, Any]:
        flow = self.repo.get(flow_id)
        graph = flow.published_graph or flow.graph
        start = next((node for node in graph.get("nodes", []) if _node_type(node) == "start"), None)
        if not start:
            raise ValueError("Flow has no start node.")
        run_id = str(uuid.uuid4())
        self._ensure_conversation(conversation_id)
        self.db.execute(
            """
            INSERT INTO flow_runs(
                id, flow_id, conversation_id, active_node_id, slots_json, transcript_json, status
            )
            VALUES (?, ?, ?, ?, '{}', '[]', 'active')
            """,
            (run_id, flow_id, conversation_id, str(start["id"])),
        )
        self._record_event(run_id, flow_id, str(start["id"]), "run_started")
        return await self._enter_until_waiting(run_id, graph, str(start["id"]), None)

    async def handle_message(
        self,
        *,
        flow_id: str,
        message: str | None,
        run_id: str | None = None,
        force_interrupt: bool = False,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        if not run_id:
            if message and message.strip():
                start = await self.start_run(flow_id, conversation_id)
                run_id = start["run_id"]
            else:
                return await self.start_run(flow_id, conversation_id)

        flow = self.repo.get(flow_id)
        graph = flow.published_graph or flow.graph
        run = self._get_run(run_id)
        if run["status"] != "active":
            return self._response(run, flow, None, [], "Run is already complete.")

        text = (message or "").strip()
        if text:
            self._append_transcript(run_id, "user", text)
            self._record_event(run_id, flow_id, run["active_node_id"], "user_message", "user", text)

        active_node = _target_node(graph, run["active_node_id"])
        if not active_node:
            self._mark_failed(run_id)
            raise ValueError("Active node is missing from the graph.")

        if text and (force_interrupt or self._looks_like_interruption(text, active_node)):
            interrupt_target = self._interrupt_target(active_node) or "interrupt_router"
            if _target_node(graph, interrupt_target):
                self._record_event(
                    run_id,
                    flow_id,
                    active_node["id"],
                    "interruption",
                    "user",
                    text,
                    {"target": interrupt_target},
                )
                return await self._enter_until_waiting(run_id, graph, interrupt_target, text)

        node_type = _node_type(active_node)
        if node_type == "collect":
            self._merge_slots(run_id, self._extract_slots(text, active_node))
            target = self._route_collect(graph, str(active_node["id"]), text)
            if target:
                return await self._enter_until_waiting(run_id, graph, target, text)
            return self._response(self._get_run(run_id), flow, active_node, [], None)
        if node_type in {"confirm", "wait"}:
            target = self._route_by_keywords(graph, str(active_node["id"]), text)
            return await self._enter_until_waiting(run_id, graph, target, text)
        if node_type == "condition":
            target = self._route_condition(graph, str(active_node["id"]), text, loads(run["slots_json"], {}))
            return await self._enter_until_waiting(run_id, graph, target, text)
        if node_type == "dialogue":
            self._merge_slots(run_id, self._extract_slots(text, active_node))
            target = self._route_by_keywords(graph, str(active_node["id"]), text)
            return await self._enter_until_waiting(run_id, graph, target, text)
        if node_type == "fallback":
            target = self._route_by_keywords(graph, str(active_node["id"]), text)
            return await self._enter_until_waiting(run_id, graph, target, text)

        target = _first_outgoing_target(graph, str(active_node["id"])) or str(active_node["id"])
        return await self._enter_until_waiting(run_id, graph, target, text)

    def run_state(self, run_id: str) -> dict[str, Any]:
        run = self._get_run(run_id)
        flow = self.repo.get(run["flow_id"])
        graph = flow.published_graph or flow.graph
        return self._response(run, flow, _target_node(graph, run["active_node_id"]), [], None)

    def latest_run_for_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        row = self.db.one(
            """
            SELECT id
            FROM flow_runs
            WHERE conversation_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            (conversation_id,),
        )
        if not row:
            return None
        return self.run_state(row["id"])

    def _ensure_conversation(self, conversation_id: str | None) -> None:
        if not conversation_id:
            return
        self.db.execute(
            """
            INSERT OR IGNORE INTO conversations(id, channel, metadata_json)
            VALUES (?, 'flow', ?)
            """,
            (conversation_id, dumps({"source": "flow_runtime"})),
        )

    async def _enter_until_waiting(
        self,
        run_id: str,
        graph: FlowGraph,
        node_id: str,
        user_text: str | None,
    ) -> dict[str, Any]:
        flow = self.repo.get(self._get_run(run_id)["flow_id"])
        messages: list[dict[str, Any]] = []
        current_id = node_id
        visited: set[str] = set()

        while current_id:
            if current_id in visited:
                messages.append(self._assistant_message("repair", "I hit a loop in this flow."))
                self._set_active_node(run_id, current_id)
                break
            visited.add(current_id)

            node = _target_node(graph, current_id)
            if not node:
                self._mark_failed(run_id)
                raise ValueError(f"Missing flow node: {current_id}")

            self._set_active_node(run_id, current_id)
            self._record_event(run_id, flow.id, current_id, "node_entered", payload={"type": _node_type(node)})
            node_type = _node_type(node)
            data = _node_data(node)

            if node_type == "start":
                target = _first_outgoing_target(graph, current_id)
                if not target:
                    messages.append(self._assistant_message(current_id, "Flow started.", voice=data.get("voice")))
                    break
                current_id = target
                continue

            if node_type == "dialogue":
                if data.get("responseMode") == "llm" and user_text:
                    text, latency_ms = await self._generate_node_response(node, user_text)
                else:
                    text = self._render_script(data, self._get_slots(run_id))
                    latency_ms = None
                messages.append(self._assistant_message(current_id, text, latency_ms, data.get("voice")))
                self._append_transcript(run_id, "assistant", text)
                target = _first_outgoing_target(graph, current_id)
                if not target or not data.get("autoAdvance"):
                    break
                user_text = None
                current_id = target
                continue

            if node_type == "collect":
                if user_text:
                    self._merge_slots(run_id, self._extract_slots(user_text, node))
                    target = self._route_collect(graph, current_id, user_text)
                    if target:
                        current_id = target
                        continue
                else:
                    text = self._render_script(data, self._get_slots(run_id))
                    messages.append(self._assistant_message(current_id, text, voice=data.get("voice")))
                    self._append_transcript(run_id, "assistant", text)
                break

            if node_type == "confirm":
                text = self._render_script(data, self._get_slots(run_id))
                messages.append(self._assistant_message(current_id, text, voice=data.get("voice")))
                self._append_transcript(run_id, "assistant", text)
                break

            if node_type == "condition":
                target = self._route_condition(graph, current_id, user_text or "", self._get_slots(run_id))
                current_id = target
                continue

            if node_type == "api":
                text = self._render_script(data, self._get_slots(run_id)) or "Calling the configured API."
                messages.append(self._assistant_message(current_id, text, voice=data.get("voice")))
                self._append_transcript(run_id, "assistant", text)
                self._record_event(
                    run_id,
                    flow.id,
                    current_id,
                    "api_call_created",
                    payload={"simulated": True, "endpoint": data.get("endpoint")},
                )
                target = _first_outgoing_target(graph, current_id)
                if not target:
                    break
                current_id = target
                continue

            if node_type == "codex_task":
                text = self._render_script(data, self._get_slots(run_id)) or (
                    "I queued the agent task."
                )
                codex_payload: dict[str, Any] = {"simulated": True}
                run = self._get_run(run_id)
                if self.settings.codex_orchestrator_enabled and run["conversation_id"]:
                    goal = str(
                        data.get("prompt")
                        or data.get("task")
                        or data.get("instruction")
                        or data.get("script")
                        or user_text
                        or text
                    ).strip()
                    transcript = loads(run["transcript_json"], [])
                    result = await CodexOrchestratorBridge(self.db, self.settings).delegate(
                        conversation_id=run["conversation_id"],
                        user_text=goal,
                        transcript=transcript if isinstance(transcript, list) else [],
                        mode="plan_first",
                    )
                    text = result.text
                    codex_payload = {"simulated": False, **result.metadata()}
                messages.append(self._assistant_message(current_id, text, 0, data.get("voice")))
                self._append_transcript(run_id, "assistant", text)
                self._record_event(
                    run_id,
                    flow.id,
                    current_id,
                    "agent_job_created",
                    payload={
                        **codex_payload,
                        "integration": data.get("integration") or data.get("codex") or {},
                        "slots": self._get_slots(run_id),
                    },
                )
                target = _first_outgoing_target(graph, current_id)
                if not target:
                    break
                current_id = target
                continue

            if node_type == "wait":
                text = self._render_script(data, self._get_slots(run_id)) or "Waiting for the running process."
                messages.append(self._assistant_message(current_id, text, voice=data.get("voice")))
                self._append_transcript(run_id, "assistant", text)
                break

            if node_type in {"handoff", "transfer_call"}:
                text = self._render_script(data, self._get_slots(run_id)) or "I can summarize the current context."
                messages.append(self._assistant_message(current_id, text, voice=data.get("voice")))
                self._append_transcript(run_id, "assistant", text)
                self._record_event(run_id, flow.id, current_id, "context_summary_requested")
                target = _first_outgoing_target(graph, current_id)
                if target:
                    current_id = target
                    continue
                break

            if node_type == "end":
                text = self._render_script(data, self._get_slots(run_id)) or "Done."
                messages.append(self._assistant_message(current_id, text, voice=data.get("voice")))
                self._append_transcript(run_id, "assistant", text)
                self._mark_completed(run_id)
                break

            text = self._render_script(data, self._get_slots(run_id)) or "I need one more detail."
            messages.append(self._assistant_message(current_id, text, voice=data.get("voice")))
            self._append_transcript(run_id, "assistant", text)
            break

        return self._response(self._get_run(run_id), flow, _target_node(graph, current_id), messages, None)

    async def _generate_node_response(self, node: dict[str, Any], user_text: str) -> tuple[str, int]:
        data = _node_data(node)
        prompt = str(data.get("prompt") or "Answer naturally inside this flow node.")
        llm_config = data.get("llm") if isinstance(data.get("llm"), dict) else {}
        if self._should_use_fast_template(str(node.get("id")), user_text):
            return self._fast_template_response(user_text), 0
        messages: list[Message] = [{"role": "user", "content": user_text or "Continue."}]
        started = time.perf_counter()
        try:
            result = await self.llm.generate(messages, self._node_system_prompt(prompt, llm_config))
            return result.text.strip(), result.latency_ms
        except Exception:
            elapsed = int((time.perf_counter() - started) * 1000)
            return self._fast_template_response(user_text), elapsed

    def _node_system_prompt(self, prompt: str, llm_config: dict[str, Any]) -> str:
        return (
            f"{prompt}\n\n"
            "Runtime contract:\n"
            "- You are inside one flowchart node, not the whole conversation.\n"
            "- Use the right spoken length for this node: brief for simple routing, longer when the user asks for explanation, story, or detail.\n"
            "- Ask at most one question unless the node explicitly collects multiple fields.\n"
            "- Do not claim an external action is done unless a tool result proves it.\n"
            f"- Node LLM mode: {llm_config.get('mode', 'constrained')}."
        )

    def _should_use_fast_template(self, node_id: str, user_text: str) -> bool:
        normalized = user_text.casefold()
        return node_id in {"codex_scope", "agent_scope"} and any(
            keyword in normalized for keyword in ["code", "repo", "task"]
        )

    def _fast_template_response(self, user_text: str) -> str:
        normalized = user_text.casefold()
        if "story" in normalized or "narrate" in normalized:
            return (
                "The old clock stopped at midnight, and the hallway went quiet. "
                "A soft knock came from the room no one used. "
                "When the door opened, only cold air and a silver key were waiting. "
                "By morning, the clock was ticking again from inside the wall."
            )
        if any(word in normalized for word in ["explain", "detail", "details", "tell me about"]):
            return (
                "Here is the short version: the flow routed your request correctly, "
                "then I would expand the answer with the key facts, tradeoffs, and one clear next step."
            )
        if "code" in normalized or "repo" in normalized:
            return "Which repo or files should I inspect first?"
        return "I understand. What detail should I use for the next step?"

    def _route_by_keywords(self, graph: FlowGraph, node_id: str, text: str) -> str:
        normalized = text.casefold()
        edges = _outgoing_edges(graph, node_id)
        fallback = edges[-1]["target"] if edges else node_id
        for edge in edges:
            data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
            keywords = data.get("keywords") if isinstance(data.get("keywords"), list) else []
            label = str(edge.get("label") or "")
            label_tokens = re.findall(r"[a-z0-9?]+", label.casefold())
            candidates = [str(keyword).casefold() for keyword in keywords] + label_tokens
            if any(candidate and candidate in normalized for candidate in candidates):
                return str(edge.get("target"))
        return str(fallback)

    def _route_collect(self, graph: FlowGraph, node_id: str, text: str) -> str:
        edges = _outgoing_edges(graph, node_id)
        if not edges:
            return node_id
        normalized = text.casefold()
        for edge in edges:
            data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
            keywords = data.get("keywords") if isinstance(data.get("keywords"), list) else []
            label = str(edge.get("label") or "")
            label_tokens = re.findall(r"[a-z0-9?]+", label.casefold())
            candidates = [str(keyword).casefold() for keyword in keywords] + label_tokens
            if any(candidate and candidate in normalized for candidate in candidates):
                return str(edge.get("target"))
        needs_clarification = (
            len(re.findall(r"\w+", text)) < 7
            or any(
                phrase in normalized
                for phrase in [
                    "not sure",
                    "maybe",
                    "something",
                    "whatever",
                    "you decide",
                    "clarify",
                    "don't know",
                    "do not know",
                ]
            )
        )
        preferred_label = "Needs clarification" if needs_clarification else "Task details collected"
        for edge in edges:
            if str(edge.get("label") or "").casefold() == preferred_label.casefold():
                return str(edge.get("target"))
        return str(edges[min(1, len(edges) - 1)].get("target") if needs_clarification else edges[0].get("target"))

    def _route_condition(
        self,
        graph: FlowGraph,
        node_id: str,
        text: str,
        slots: dict[str, Any],
    ) -> str:
        edges = _outgoing_edges(graph, node_id)
        if not edges:
            return node_id

        normalized = " ".join(
            [
                text,
                str(slots.get("task_description") or ""),
                str(slots.get("repo_scope") or ""),
                str(slots.get("success_criteria") or ""),
            ]
        ).casefold()
        for edge in edges:
            data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
            keywords = data.get("keywords") if isinstance(data.get("keywords"), list) else []
            label = str(edge.get("label") or "")
            label_tokens = re.findall(r"[a-z0-9?]+", label.casefold())
            candidates = [str(keyword).casefold() for keyword in keywords] + label_tokens
            if any(candidate and candidate in normalized for candidate in candidates):
                return str(edge.get("target"))
        risky_terms = [
            "deploy",
            "production",
            "prod",
            "delete",
            "drop table",
            "rm -rf",
            "secret",
            "credential",
            "api key",
            "commit",
            "push",
            "merge",
            "payment",
            "billing",
        ]
        preferred_label = "Needs approval" if any(term in normalized for term in risky_terms) else "Safe to run"
        for edge in edges:
            if str(edge.get("label") or "").casefold() == preferred_label.casefold():
                return str(edge.get("target"))
        return str(edges[0].get("target"))

    def _get_slots(self, run_id: str) -> dict[str, Any]:
        return loads(self._get_run(run_id)["slots_json"], {})

    def _render_script(self, data: dict[str, Any], slots: dict[str, Any]) -> str:
        template = str(data.get("script") or data.get("prompt") or "").strip()
        if not template:
            return ""
        rendered = template
        for key, value in slots.items():
            if value is None:
                continue
            value_text = str(value)
            rendered = rendered.replace(f"{{{key}}}", value_text)
            rendered = rendered.replace(f"${{{key}}}", value_text)
            rendered = rendered.replace(key.replace("_", " ").title(), value_text)
        if "Task Description" in rendered and slots.get("task_description"):
            rendered = rendered.replace("Task Description", str(slots["task_description"]))
        return rendered

    def _interrupt_target(self, node: dict[str, Any]) -> str | None:
        data = _node_data(node)
        interrupt = data.get("interrupt") if isinstance(data.get("interrupt"), dict) else {}
        routes = interrupt.get("routes") if isinstance(interrupt.get("routes"), list) else []
        for route in routes:
            if isinstance(route, dict) and route.get("target"):
                return str(route["target"])
        return None

    def _looks_like_interruption(self, text: str, node: dict[str, Any]) -> bool:
        data = _node_data(node)
        interrupt = data.get("interrupt") if isinstance(data.get("interrupt"), dict) else {}
        if not interrupt.get("enabled"):
            return False
        normalized = text.casefold()
        return any(
            phrase in normalized
            for phrase in ["stop", "wait", "actually", "instead", "hold on", "no,", "cancel"]
        )

    def _extract_slots(self, text: str, node: dict[str, Any]) -> dict[str, Any]:
        data = _node_data(node)
        slots: dict[str, Any] = {}
        fields = data.get("fields") if isinstance(data.get("fields"), list) else []
        field_names = {
            str(field.get("name"))
            for field in fields
            if isinstance(field, dict) and field.get("name")
        }
        listen = data.get("listen") if isinstance(data.get("listen"), dict) else {}
        configured_slots = listen.get("slots") if isinstance(listen.get("slots"), list) else []
        slot_names = {
            str(slot.get("name"))
            for slot in configured_slots
            if isinstance(slot, dict) and slot.get("name")
        }
        slot_names |= field_names
        email_match = re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text)
        if email_match and ("account_email" in slot_names or "account" in text.casefold()):
            slots["account_email"] = email_match.group(0)
        order_match = re.search(r"\b(?:order\s*)?[#:]?\s*([A-Z0-9][A-Z0-9-]{4,})\b", text, re.I)
        if (
            order_match
            and "@" not in order_match.group(1)
            and ("order_id" in slot_names or "order" in text.casefold())
        ):
            slots["order_id"] = order_match.group(1).upper()
        if _node_type(node) in {"collect", "dialogue", "listen"}:
            if "user_request" in slot_names and text:
                slots["user_request"] = text
            if "task_description" in slot_names and text:
                slots["task_description"] = text
            if "repo_scope" in slot_names:
                repo_match = re.search(
                    r"\b(?:repo|repository|project|file|folder|path)\s+([^\n,.]+)",
                    text,
                    re.I,
                )
                if repo_match:
                    slots["repo_scope"] = repo_match.group(1).strip()
            if "success_criteria" in slot_names and any(
                phrase in text.casefold() for phrase in ["success", "done when", "should pass", "verified"]
            ):
                slots["success_criteria"] = text
            for slot in configured_slots:
                if isinstance(slot, dict) and slot.get("type") == "text" and slot.get("required"):
                    slots[str(slot.get("name"))] = text
        return slots

    def _assistant_message(
        self,
        node_id: str,
        text: str,
        latency_ms: int | None = None,
        voice: Any | None = None,
    ) -> dict[str, Any]:
        message = {
            "id": str(uuid.uuid4()),
            "role": "assistant",
            "node_id": node_id,
            "text": text,
            "latency_ms": latency_ms,
        }
        if isinstance(voice, dict):
            message["voice"] = voice
        return message

    def _response(
        self,
        run,
        flow: FlowDefinition,
        node: dict[str, Any] | None,
        messages: list[dict[str, Any]],
        error: str | None,
    ) -> dict[str, Any]:
        return {
            "run_id": run["id"],
            "flow_id": flow.id,
            "flow_version": flow.version,
            "status": run["status"],
            "active_node_id": run["active_node_id"],
            "active_node": node,
            "slots": loads(run["slots_json"], {}),
            "transcript": loads(run["transcript_json"], []),
            "messages": messages,
            "error": error,
        }

    def _get_run(self, run_id: str):
        row = self.db.one(
            """
            SELECT id, flow_id, conversation_id, active_node_id, slots_json,
                   transcript_json, status, created_at, updated_at
            FROM flow_runs
            WHERE id = ?
            """,
            (run_id,),
        )
        if not row:
            raise KeyError(run_id)
        return row

    def _set_active_node(self, run_id: str, node_id: str) -> None:
        self.db.execute(
            """
            UPDATE flow_runs
            SET active_node_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (node_id, run_id),
        )

    def _append_transcript(
        self,
        run_id: str,
        role: str,
        text: str,
        latency_ms: int | None = None,
    ) -> None:
        run = self._get_run(run_id)
        transcript = loads(run["transcript_json"], [])
        transcript.append(
            {
                "id": str(uuid.uuid4()),
                "role": role,
                "text": text,
                "latency_ms": latency_ms,
                "created_at": time.time(),
            }
        )
        self.db.execute(
            """
            UPDATE flow_runs
            SET transcript_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (dumps(transcript), run_id),
        )

    def _merge_slots(self, run_id: str, slots: dict[str, Any]) -> None:
        if not slots:
            return
        run = self._get_run(run_id)
        current = loads(run["slots_json"], {})
        current.update({key: value for key, value in slots.items() if value})
        self.db.execute(
            """
            UPDATE flow_runs
            SET slots_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (dumps(current), run_id),
        )

    def _mark_completed(self, run_id: str) -> None:
        self.db.execute(
            """
            UPDATE flow_runs
            SET status = 'completed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (run_id,),
        )

    def _mark_failed(self, run_id: str) -> None:
        self.db.execute(
            """
            UPDATE flow_runs
            SET status = 'failed', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (run_id,),
        )

    def _record_event(
        self,
        run_id: str,
        flow_id: str,
        node_id: str | None,
        event: str,
        role: str | None = None,
        text: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        self.db.execute(
            """
            INSERT INTO flow_events(id, run_id, flow_id, node_id, event, role, text, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                run_id,
                flow_id,
                node_id,
                event,
                role,
                text,
                dumps(payload or {}),
            ),
        )
