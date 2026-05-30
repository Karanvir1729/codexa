from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DEFAULT_SYSTEM_PROMPT = """You are a fast conversational voice AI.
Prioritize low latency, natural conversation, and accurate listening.
Answer directly at the length the user asks for. Ask one clarifying question only
when required information is missing. Do not claim external actions are complete
unless a tool result proves it. Stay in the conversation as the AI; do not offer
to pass the user to another person."""

LEGACY_SYSTEM_PROMPTS = {
    """You are a high-reasoning voice agent optimized for phone and web voice use.
Prioritize low latency, reliability, and accuracy. Speak naturally.
Ask one clarifying question when required information is missing.
Use tool and evaluation feedback as operating constraints for future turns.""",
}


SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    caller TEXT,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    latency_ms INTEGER,
    model TEXT,
    prompt_version INTEGER,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_id TEXT,
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    label TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id),
    FOREIGN KEY(turn_id) REFERENCES turns(id)
);

CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    suite TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    aggregate_score REAL,
    metrics_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS eval_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    score REAL NOT NULL,
    passed INTEGER NOT NULL,
    latency_ms INTEGER,
    expected_json TEXT NOT NULL DEFAULT '{}',
    transcript_json TEXT NOT NULL DEFAULT '[]',
    feedback_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(run_id) REFERENCES eval_runs(id)
);

CREATE TABLE IF NOT EXISTS prompt_versions (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    system_prompt TEXT NOT NULL,
    learned_hints TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cost_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    amount_usd REAL NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved', 'actual', 'released')),
    units_json TEXT NOT NULL DEFAULT '{}',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS latency_traces (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    transport TEXT NOT NULL,
    user_turn_id TEXT,
    assistant_turn_id TEXT,
    providers_json TEXT NOT NULL DEFAULT '{}',
    timings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id),
    FOREIGN KEY(user_turn_id) REFERENCES turns(id),
    FOREIGN KEY(assistant_turn_id) REFERENCES turns(id)
);

CREATE TABLE IF NOT EXISTS interaction_events (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    transport TEXT NOT NULL,
    event TEXT NOT NULL,
    role TEXT,
    text TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS flow_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'archived')) DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1,
    graph_json TEXT NOT NULL,
    published_graph_json TEXT,
    validation_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TEXT
);

CREATE TABLE IF NOT EXISTS flow_runs (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL,
    conversation_id TEXT,
    active_node_id TEXT NOT NULL,
    slots_json TEXT NOT NULL DEFAULT '{}',
    transcript_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'failed')) DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(flow_id) REFERENCES flow_definitions(id),
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS flow_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    node_id TEXT,
    event TEXT NOT NULL,
    role TEXT,
    text TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(run_id) REFERENCES flow_runs(id),
    FOREIGN KEY(flow_id) REFERENCES flow_definitions(id)
);

CREATE TABLE IF NOT EXISTS runtime_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS codex_orchestrator_sessions (
    conversation_id TEXT PRIMARY KEY,
    codex_session_id TEXT,
    codex_project_id TEXT,
    codex_task_id TEXT,
    codex_worker_id TEXT,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approval_id TEXT,
    last_status TEXT,
    last_response TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_turns_conversation ON turns(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_conversation ON feedback(conversation_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(run_id);
CREATE INDEX IF NOT EXISTS idx_cost_events_status ON cost_events(status, created_at);
CREATE INDEX IF NOT EXISTS idx_latency_traces_conversation ON latency_traces(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_latency_traces_interaction ON latency_traces(interaction_id);
CREATE INDEX IF NOT EXISTS idx_interaction_events_conversation ON interaction_events(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_interaction_events_interaction ON interaction_events(interaction_id, created_at);
CREATE INDEX IF NOT EXISTS idx_flow_definitions_status ON flow_definitions(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs(flow_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_flow_events_run ON flow_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_codex_orchestrator_session ON codex_orchestrator_sessions(codex_session_id);
"""


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


class Database:
    def __init__(self, path: str) -> None:
        raw_path = Path(path)
        repo_root = Path(__file__).resolve().parents[2]
        self.path = raw_path if raw_path.is_absolute() else repo_root / raw_path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.init()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA)
            conn.execute(
                """
                UPDATE prompt_versions
                SET system_prompt = ?
                WHERE system_prompt LIKE '%under 35 words%'
                   OR system_prompt LIKE '%Default to one sentence%'
                   OR system_prompt LIKE '%Speak in short, natural sentences%'
                   OR system_prompt LIKE '%Speak naturally in short sentences%'
                   OR system_prompt LIKE '%customer-intake%'
                   OR system_prompt LIKE '%human agent%'
                   OR system_prompt LIKE '%handoff%'
                   OR system_prompt LIKE '%account email%'
                   OR system_prompt LIKE '%order ID%'
                   OR system_prompt LIKE '%refund%'
                """,
                (DEFAULT_SYSTEM_PROMPT,),
            )
            for legacy_prompt in LEGACY_SYSTEM_PROMPTS:
                conn.execute(
                    """
                    UPDATE prompt_versions
                    SET system_prompt = ?
                    WHERE system_prompt = ?
                    """,
                    (DEFAULT_SYSTEM_PROMPT, legacy_prompt),
                )
            row = conn.execute("SELECT COUNT(*) AS count FROM prompt_versions").fetchone()
            if row["count"] == 0:
                conn.execute(
                    """
                    INSERT INTO prompt_versions(system_prompt, learned_hints, source, active)
                    VALUES (?, '', 'bootstrap', 1)
                    """,
                    (DEFAULT_SYSTEM_PROMPT,),
                )

    def one(self, query: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute(query, params).fetchone()

    def all(self, query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(query, params).fetchall()

    def execute(self, query: str, params: tuple[Any, ...] = ()) -> None:
        with self.connect() as conn:
            conn.execute(query, params)
