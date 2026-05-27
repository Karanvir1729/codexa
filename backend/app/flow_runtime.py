from __future__ import annotations

import re
import time
import uuid
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from .db import Database, dumps, loads
from .llm import LLMClient, Message


FlowGraph = dict[str, Any]

FLOW_NODE_TYPES = [
    "start",
    "say",
    "listen",
    "intent_router",
    "condition",
    "llm_step",
    "tool",
    "codex_task",
    "set_state",
    "guardrail",
    "wait",
    "fallback",
    "handoff",
    "end",
]

VOICE_PRESETS = ["neutral", "calm", "confident", "friendly", "concise", "careful"]
LATENCY_PROFILES = ["instant", "fast", "balanced", "quality", "async"]


DEFAULT_FLOW_GRAPH: FlowGraph = {
    "nodes": [
        {
            "id": "start",
            "type": "flowNode",
            "position": {"x": -760, "y": -40},
            "data": {
                "label": "Start",
                "nodeType": "start",
                "purpose": "Initialize an always-on voice session and enter the planned flow.",
                "prompt": "",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "calm",
                    "speed": 1,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "instant", "targetMs": 150},
                "listen": {"silenceTimeoutMs": 700, "retryLimit": 2, "expected": []},
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "greeting",
            "type": "flowNode",
            "position": {"x": -520, "y": -40},
            "data": {
                "label": "Greeting",
                "nodeType": "say",
                "purpose": "Start naturally and make it clear the agent is ready.",
                "prompt": "I'm here. Tell me what you want to do.",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "friendly",
                    "speed": 1.04,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "instant", "targetMs": 250},
                "listen": {"silenceTimeoutMs": 700, "retryLimit": 2, "expected": []},
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "understand_request",
            "type": "flowNode",
            "position": {"x": -260, "y": -40},
            "data": {
                "label": "Understand Request",
                "nodeType": "listen",
                "purpose": "Capture the user's goal while the audio session remains live.",
                "prompt": "What should I help with?",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "calm",
                    "speed": 1,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "fast", "targetMs": 700},
                "listen": {
                    "silenceTimeoutMs": 700,
                    "retryLimit": 2,
                    "expected": ["account help", "refund", "code task", "human handoff"],
                    "slots": [],
                },
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "route_intent",
            "type": "flowNode",
            "position": {"x": 10, "y": -40},
            "data": {
                "label": "Intent Router",
                "nodeType": "intent_router",
                "purpose": "Route the user into a controlled domain path.",
                "prompt": "Classify the user's intent into one of the outgoing edges.",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "concise",
                    "speed": 1,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "instant", "targetMs": 120},
                "listen": {"silenceTimeoutMs": 700, "retryLimit": 2, "expected": []},
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "customer_intake",
            "type": "flowNode",
            "position": {"x": 300, "y": -220},
            "data": {
                "label": "Customer Intake",
                "nodeType": "llm_step",
                "purpose": "Ask for the missing account, order, or refund detail without claiming completion.",
                "prompt": (
                    "You are in a customer-support intake node. Ask exactly one concise "
                    "question for the missing account email, phone number, order ID, or reason."
                ),
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "careful",
                    "speed": 1,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "fast", "targetMs": 900},
                "llm": {"temperature": 0, "maxTokens": 40, "mode": "constrained"},
                "listen": {
                    "silenceTimeoutMs": 900,
                    "retryLimit": 2,
                    "expected": ["email", "phone", "order ID", "reason"],
                    "slots": [
                        {"name": "account_email", "type": "email", "required": False},
                        {"name": "order_id", "type": "text", "required": False},
                        {"name": "reason", "type": "text", "required": False},
                    ],
                },
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "codex_request",
            "type": "flowNode",
            "position": {"x": 300, "y": 10},
            "data": {
                "label": "Codex Request",
                "nodeType": "listen",
                "purpose": "Collect the coding task before invoking Codex Orchestrator.",
                "prompt": "What should Codex work on, and which repo or files are in scope?",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "confident",
                    "speed": 1.03,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "fast", "targetMs": 800},
                "listen": {
                    "silenceTimeoutMs": 900,
                    "retryLimit": 2,
                    "expected": ["inspect code", "edit files", "run tests", "deploy"],
                    "slots": [{"name": "codex_task", "type": "text", "required": True}],
                },
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "codex_confirm",
            "type": "flowNode",
            "position": {"x": 580, "y": 10},
            "data": {
                "label": "Codex Approval",
                "nodeType": "guardrail",
                "purpose": "Require explicit approval before writes, commits, deploys, or risky commands.",
                "prompt": "I can send that to Codex Orchestrator. Should I proceed?",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "careful",
                    "speed": 0.98,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "instant", "targetMs": 250},
                "listen": {"silenceTimeoutMs": 900, "retryLimit": 2, "expected": ["yes", "no"]},
                "guardrail": {
                    "approvalMode": "ask_before_write",
                    "requiresExplicitYes": True,
                    "blockedActions": ["destructive_shell", "deploy", "commit_without_review"],
                },
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "run_codex",
            "type": "flowNode",
            "position": {"x": 860, "y": 10},
            "data": {
                "label": "Run Codex Task",
                "nodeType": "codex_task",
                "purpose": "Create an async job for Codex Orchestrator and speak progress.",
                "prompt": "I'll hand this to Codex Orchestrator and keep you updated.",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "confident",
                    "speed": 1.02,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "async", "targetMs": 1200},
                "codex": {
                    "taskType": "edit_or_inspect",
                    "approvalMode": "ask_before_write",
                    "allowedPaths": [],
                    "progressSpeech": [
                        "I'm checking the repo now.",
                        "I found the relevant files.",
                        "I'm running verification.",
                    ],
                },
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "cancel", "target": "cancel_task"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "interrupt_router",
            "type": "flowNode",
            "position": {"x": 300, "y": 250},
            "data": {
                "label": "Interrupt Router",
                "nodeType": "intent_router",
                "purpose": "Handle barge-in while preserving the graph state.",
                "prompt": "Classify interruptions into cancel, correction, question, switch topic, or resume.",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "calm",
                    "speed": 1.06,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "instant", "targetMs": 180},
                "listen": {
                    "silenceTimeoutMs": 500,
                    "retryLimit": 1,
                    "expected": ["cancel", "correction", "question", "switch topic", "resume"],
                },
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "answer_inline",
            "type": "flowNode",
            "position": {"x": 580, "y": 210},
            "data": {
                "label": "Answer Inline",
                "nodeType": "llm_step",
                "purpose": "Answer a short interruption question and return to the prior flow when possible.",
                "prompt": "Answer the interruption in one short sentence, then offer to continue.",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "calm",
                    "speed": 1.05,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "fast", "targetMs": 850},
                "llm": {"temperature": 0, "maxTokens": 42, "mode": "constrained"},
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "cancel_task",
            "type": "flowNode",
            "position": {"x": 580, "y": 360},
            "data": {
                "label": "Cancel Current Task",
                "nodeType": "say",
                "purpose": "Stop the current task and ask what to do next.",
                "prompt": "Stopped. What should I do instead?",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "calm",
                    "speed": 1,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "instant", "targetMs": 200},
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "repair", "lowConfidence": "repair", "toolError": "repair"},
            },
        },
        {
            "id": "repair",
            "type": "flowNode",
            "position": {"x": 20, "y": 260},
            "data": {
                "label": "Repair",
                "nodeType": "fallback",
                "purpose": "Recover from silence, unclear speech, tool failure, or low confidence.",
                "prompt": "I missed that. Say it another way, or tell me if you want to switch tasks.",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "careful",
                    "speed": 0.98,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "instant", "targetMs": 220},
                "listen": {"silenceTimeoutMs": 700, "retryLimit": 2, "expected": []},
                "interrupt": {
                    "enabled": True,
                    "stopSpeaking": True,
                    "routes": [{"intent": "any", "target": "interrupt_router"}],
                },
                "fallback": {"noInput": "handoff", "lowConfidence": "handoff", "toolError": "handoff"},
            },
        },
        {
            "id": "handoff",
            "type": "flowNode",
            "position": {"x": 300, "y": -430},
            "data": {
                "label": "Human Handoff",
                "nodeType": "handoff",
                "purpose": "Transfer the session with transcript and active slots.",
                "prompt": "A human agent can help. I can hand you off now.",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "careful",
                    "speed": 1,
                    "language": "en",
                    "allowBargeIn": True,
                },
                "latency": {"profile": "balanced", "targetMs": 1000},
                "handoff": {"channel": "operator", "includeSummary": True},
                "interrupt": {"enabled": False, "stopSpeaking": True, "routes": []},
                "fallback": {"noInput": "end", "lowConfidence": "end", "toolError": "end"},
            },
        },
        {
            "id": "end",
            "type": "flowNode",
            "position": {"x": 1140, "y": 10},
            "data": {
                "label": "End",
                "nodeType": "end",
                "purpose": "Close the flow and store final transcript, slots, and eval trace.",
                "prompt": "Done. I saved the session notes.",
                "voice": {
                    "voiceId": "af_heart",
                    "tone": "neutral",
                    "speed": 1,
                    "language": "en",
                    "allowBargeIn": False,
                },
                "latency": {"profile": "instant", "targetMs": 200},
                "interrupt": {"enabled": False, "stopSpeaking": True, "routes": []},
                "fallback": {"noInput": "end", "lowConfidence": "end", "toolError": "end"},
            },
        },
    ],
    "edges": [
        {"id": "start-greeting", "source": "start", "target": "greeting", "label": "enter"},
        {"id": "greeting-understand", "source": "greeting", "target": "understand_request", "label": "listen"},
        {"id": "understand-route", "source": "understand_request", "target": "route_intent", "label": "classify"},
        {
            "id": "route-customer",
            "source": "route_intent",
            "target": "customer_intake",
            "label": "account / refund / order",
            "data": {"keywords": ["account", "refund", "cancel", "order", "billing"]},
        },
        {
            "id": "route-codex",
            "source": "route_intent",
            "target": "codex_request",
            "label": "code / repo / build",
            "data": {"keywords": ["code", "repo", "build", "bug", "test", "deploy", "codex"]},
        },
        {
            "id": "route-human",
            "source": "route_intent",
            "target": "handoff",
            "label": "human",
            "data": {"keywords": ["human", "operator", "representative", "agent"]},
        },
        {"id": "route-repair", "source": "route_intent", "target": "repair", "label": "unclear"},
        {"id": "customer-repair", "source": "customer_intake", "target": "repair", "label": "still missing"},
        {"id": "customer-end", "source": "customer_intake", "target": "end", "label": "details captured"},
        {"id": "codex-request-confirm", "source": "codex_request", "target": "codex_confirm", "label": "task captured"},
        {
            "id": "codex-confirm-run",
            "source": "codex_confirm",
            "target": "run_codex",
            "label": "yes",
            "data": {"keywords": ["yes", "proceed", "start", "go"]},
        },
        {
            "id": "codex-confirm-cancel",
            "source": "codex_confirm",
            "target": "cancel_task",
            "label": "no",
            "data": {"keywords": ["no", "stop", "cancel"]},
        },
        {"id": "run-codex-end", "source": "run_codex", "target": "end", "label": "job queued"},
        {
            "id": "interrupt-cancel",
            "source": "interrupt_router",
            "target": "cancel_task",
            "label": "cancel / stop",
            "data": {"keywords": ["stop", "cancel", "nevermind", "never mind"]},
        },
        {
            "id": "interrupt-question",
            "source": "interrupt_router",
            "target": "answer_inline",
            "label": "question",
            "data": {"keywords": ["what", "why", "how", "when", "where", "?"]},
        },
        {
            "id": "interrupt-switch",
            "source": "interrupt_router",
            "target": "understand_request",
            "label": "switch topic",
            "data": {"keywords": ["instead", "actually", "switch", "change"]},
        },
        {"id": "answer-inline-understand", "source": "answer_inline", "target": "understand_request", "label": "continue"},
        {"id": "cancel-understand", "source": "cancel_task", "target": "understand_request", "label": "restart"},
        {"id": "repair-route", "source": "repair", "target": "route_intent", "label": "retry"},
        {"id": "handoff-end", "source": "handoff", "target": "end", "label": "transferred"},
    ],
    "viewport": {"x": 760, "y": 340, "zoom": 0.72},
    "metadata": {
        "schemaVersion": 1,
        "defaultVoice": "af_heart",
        "defaultLatencyProfile": "fast",
        "alwaysListening": True,
        "runtime": "pipecat-compatible-flow",
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
        if node_type in {"say", "listen", "llm_step", "guardrail", "fallback", "handoff", "end"}:
            if not str(data.get("prompt") or "").strip():
                warnings.append(f"{node_id} should have a prompt or spoken script.")
        if node_type not in {"start", "handoff", "end"}:
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
        row = self.db.one("SELECT id FROM flow_definitions LIMIT 1")
        if row:
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
                "Realtime Voice Agent Flow",
                "Always-on voice flow with interruption routing and Codex Orchestrator handoff.",
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
    def __init__(self, db: Database, repo: FlowRepository, llm: LLMClient) -> None:
        self.db = db
        self.repo = repo
        self.llm = llm

    async def start_run(self, flow_id: str, conversation_id: str | None = None) -> dict[str, Any]:
        flow = self.repo.get(flow_id)
        graph = flow.published_graph or flow.graph
        start = next((node for node in graph.get("nodes", []) if _node_type(node) == "start"), None)
        if not start:
            raise ValueError("Flow has no start node.")
        run_id = str(uuid.uuid4())
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
        if node_type == "listen":
            self._merge_slots(run_id, self._extract_slots(text, active_node))
            target = _first_outgoing_target(graph, str(active_node["id"]))
            if target:
                return await self._enter_until_waiting(run_id, graph, target, text)
            return self._response(self._get_run(run_id), flow, active_node, [], None)
        if node_type == "intent_router":
            target = self._route_by_keywords(graph, str(active_node["id"]), text)
            return await self._enter_until_waiting(run_id, graph, target, text)
        if node_type == "guardrail":
            target = self._route_by_keywords(graph, str(active_node["id"]), text)
            return await self._enter_until_waiting(run_id, graph, target, text)
        if node_type in {"llm_step", "fallback"}:
            return await self._enter_until_waiting(run_id, graph, str(active_node["id"]), text)

        target = _first_outgoing_target(graph, str(active_node["id"])) or str(active_node["id"])
        return await self._enter_until_waiting(run_id, graph, target, text)

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
                    messages.append(self._assistant_message(current_id, "Flow started."))
                    break
                current_id = target
                continue

            if node_type == "say":
                text = str(data.get("prompt") or "")
                messages.append(self._assistant_message(current_id, text))
                self._append_transcript(run_id, "assistant", text)
                target = _first_outgoing_target(graph, current_id)
                if not target:
                    break
                user_text = None
                current_id = target
                continue

            if node_type == "listen":
                if user_text:
                    self._merge_slots(run_id, self._extract_slots(user_text, node))
                    target = _first_outgoing_target(graph, current_id)
                    if target:
                        current_id = target
                        continue
                else:
                    text = str(data.get("prompt") or "What should I listen for?")
                    messages.append(self._assistant_message(current_id, text))
                    self._append_transcript(run_id, "assistant", text)
                break

            if node_type == "intent_router":
                target = self._route_by_keywords(graph, current_id, user_text or "")
                current_id = target
                continue

            if node_type == "guardrail":
                text = str(data.get("prompt") or "Should I proceed?")
                messages.append(self._assistant_message(current_id, text))
                self._append_transcript(run_id, "assistant", text)
                break

            if node_type == "llm_step":
                text, latency_ms = await self._generate_node_response(node, user_text or "")
                messages.append(self._assistant_message(current_id, text, latency_ms))
                self._append_transcript(run_id, "assistant", text, latency_ms=latency_ms)
                target = _first_outgoing_target(graph, current_id)
                if not target:
                    break
                current_id = target
                continue

            if node_type == "codex_task":
                text = str(data.get("prompt") or "I queued the Codex Orchestrator task.")
                messages.append(self._assistant_message(current_id, text, 0))
                self._append_transcript(run_id, "assistant", text)
                self._record_event(
                    run_id,
                    flow.id,
                    current_id,
                    "codex_orchestrator_job_created",
                    payload={"simulated": True, "codex": data.get("codex") or {}},
                )
                target = _first_outgoing_target(graph, current_id)
                if not target:
                    break
                current_id = target
                continue

            if node_type == "handoff":
                text = str(data.get("prompt") or "A human agent can help.")
                messages.append(self._assistant_message(current_id, text))
                self._append_transcript(run_id, "assistant", text)
                self._record_event(run_id, flow.id, current_id, "handoff_requested")
                break

            if node_type == "end":
                text = str(data.get("prompt") or "Done.")
                messages.append(self._assistant_message(current_id, text))
                self._append_transcript(run_id, "assistant", text)
                self._mark_completed(run_id)
                break

            text = str(data.get("prompt") or "I need one more detail.")
            messages.append(self._assistant_message(current_id, text))
            self._append_transcript(run_id, "assistant", text)
            break

        return self._response(self._get_run(run_id), flow, _target_node(graph, current_id), messages, None)

    async def _generate_node_response(self, node: dict[str, Any], user_text: str) -> tuple[str, int]:
        data = _node_data(node)
        prompt = str(data.get("prompt") or "Answer in one short sentence.")
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
            "- Keep the spoken reply short enough for real-time TTS.\n"
            "- Ask at most one question.\n"
            "- Do not claim an external action is done unless a tool result proves it.\n"
            f"- Node LLM mode: {llm_config.get('mode', 'constrained')}."
        )

    def _should_use_fast_template(self, node_id: str, user_text: str) -> bool:
        normalized = user_text.casefold()
        return node_id == "customer_intake" and any(
            keyword in normalized for keyword in ["account", "refund", "cancel", "order"]
        )

    def _fast_template_response(self, user_text: str) -> str:
        normalized = user_text.casefold()
        if "refund" in normalized or "cancel" in normalized or "order" in normalized:
            return "What order ID and reason should I use before taking action?"
        if "account" in normalized or "billing" in normalized:
            return "What account email or phone number should I use?"
        if "human" in normalized or "operator" in normalized:
            return "A human agent can help; I can hand you off now."
        if "code" in normalized or "repo" in normalized or "codex" in normalized:
            return "Which repo or files should Codex inspect first?"
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
        listen = data.get("listen") if isinstance(data.get("listen"), dict) else {}
        configured_slots = listen.get("slots") if isinstance(listen.get("slots"), list) else []
        slot_names = {
            str(slot.get("name"))
            for slot in configured_slots
            if isinstance(slot, dict) and slot.get("name")
        }
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
        if _node_type(node) == "listen":
            for slot in configured_slots:
                if isinstance(slot, dict) and slot.get("type") == "text" and slot.get("required"):
                    slots[str(slot.get("name"))] = text
        return slots

    def _assistant_message(
        self,
        node_id: str,
        text: str,
        latency_ms: int | None = None,
    ) -> dict[str, Any]:
        return {
            "id": str(uuid.uuid4()),
            "role": "assistant",
            "node_id": node_id,
            "text": text,
            "latency_ms": latency_ms,
        }

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
