from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

from .db import Database, dumps

CEKURA_CHANNEL = "cekura_websocket"
CEKURA_SOURCE = "cekura"
RUNTIME_PROFILE_KEY = "agent_runtime_profile"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_cekura_id(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def cekura_conversation_id(run_id: str | None = None) -> str:
    normalized = normalize_cekura_id(run_id)
    if normalized:
        return f"cekura-{normalized}"
    return f"cekura-{uuid.uuid4()}"


def cekura_context_from_headers(headers: Mapping[str, str]) -> dict[str, str]:
    return {
        "source": CEKURA_SOURCE,
        "run_id": normalize_cekura_id(headers.get("x-vocera-run-id")) or "",
        "scenario_id": normalize_cekura_id(headers.get("x-vocera-scenario-id")) or "",
        "result_id": normalize_cekura_id(headers.get("x-vocera-result-id")) or "",
    }


def assert_cekura_secret(headers: Mapping[str, str], expected_secret: str | None) -> None:
    if not expected_secret:
        return
    provided = headers.get("x-vocera-secret") or headers.get("x-cekura-secret")
    if provided != expected_secret:
        raise PermissionError("Invalid Cekura websocket secret.")


def build_cekura_agent_message(turn: Mapping[str, Any], context: Mapping[str, Any]) -> dict[str, Any]:
    metadata = {
        "source": CEKURA_SOURCE,
        "conversation_id": turn.get("conversation_id"),
        "user_turn_id": turn.get("user_turn_id"),
        "assistant_turn_id": turn.get("assistant_turn_id"),
        "latency_trace_id": turn.get("latency_trace_id"),
        "provider": turn.get("provider"),
        "model": turn.get("model"),
        "mode": turn.get("mode"),
        "voice_behavior_mode": turn.get("mode"),
        "runtime_action_status": turn.get("runtime_action_status") or [],
        "events_recorded": turn.get("events_recorded") or [],
        "flow": turn.get("flow") or {},
        "cekura": dict(context),
    }
    return {
        "content": str(turn.get("message") or ""),
        "metadata": metadata,
    }


def _conversation_ids_for_cleanup(
    db: Database,
    *,
    conversation_id: str | None = None,
    run_id: str | None = None,
    result_id: str | None = None,
    all_cekura: bool = False,
) -> list[str]:
    ids: set[str] = set()
    if conversation_id:
        ids.add(conversation_id)
    if run_id:
        ids.add(cekura_conversation_id(run_id))
    if all_cekura:
        rows = db.all(
            "SELECT id FROM conversations WHERE channel = ? OR metadata_json LIKE ?",
            (CEKURA_CHANNEL, '%"source":"cekura"%'),
        )
        ids.update(str(row["id"]) for row in rows)
    elif result_id:
        rows = db.all(
            """
            SELECT id
            FROM conversations
            WHERE channel = ?
              AND metadata_json LIKE ?
            """,
            (CEKURA_CHANNEL, f'%"result_id":"{result_id}"%'),
        )
        ids.update(str(row["id"]) for row in rows)
    return sorted(ids)


def cleanup_cekura_state(
    db: Database,
    *,
    conversation_id: str | None = None,
    run_id: str | None = None,
    result_id: str | None = None,
    all_cekura: bool = False,
    reset_runtime_profile: bool = True,
) -> dict[str, Any]:
    conversation_ids = _conversation_ids_for_cleanup(
        db,
        conversation_id=conversation_id,
        run_id=run_id,
        result_id=result_id,
        all_cekura=all_cekura,
    )
    for cid in conversation_ids:
        run_rows = db.all("SELECT id FROM flow_runs WHERE conversation_id = ?", (cid,))
        for row in run_rows:
            db.execute("DELETE FROM flow_events WHERE run_id = ?", (row["id"],))
        db.execute("DELETE FROM flow_runs WHERE conversation_id = ?", (cid,))
        db.execute("DELETE FROM codex_orchestrator_sessions WHERE conversation_id = ?", (cid,))
        db.execute("DELETE FROM latency_traces WHERE conversation_id = ?", (cid,))
        db.execute("DELETE FROM interaction_events WHERE conversation_id = ?", (cid,))
        db.execute("DELETE FROM feedback WHERE conversation_id = ?", (cid,))
        db.execute("DELETE FROM turns WHERE conversation_id = ?", (cid,))
        db.execute("DELETE FROM conversations WHERE id = ?", (cid,))
    if reset_runtime_profile:
        db.execute("DELETE FROM runtime_settings WHERE key = ?", (RUNTIME_PROFILE_KEY,))
    return {
        "conversation_ids": conversation_ids,
        "deleted_conversation_count": len(conversation_ids),
        "runtime_profile_reset": reset_runtime_profile,
    }


def seed_cekura_state(
    db: Database,
    *,
    run_id: str | None = None,
    scenario_id: str | None = None,
    result_id: str | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    cid = cekura_conversation_id(run_id)
    payload = {
        "source": CEKURA_SOURCE,
        "run_id": run_id,
        "scenario_id": scenario_id,
        "result_id": result_id,
        "seeded_at": utc_now_iso(),
        **dict(metadata or {}),
    }
    cleanup_cekura_state(db, conversation_id=cid, reset_runtime_profile=True)
    db.execute(
        """
        INSERT INTO conversations(id, channel, metadata_json)
        VALUES (?, ?, ?)
        """,
        (cid, CEKURA_CHANNEL, dumps(payload)),
    )
    return {"conversation_id": cid, "metadata": payload}


def record_cekura_result(db: Database, payload: Mapping[str, Any]) -> dict[str, Any]:
    data = payload.get("data") if isinstance(payload.get("data"), Mapping) else payload
    result_id = normalize_cekura_id(data.get("id")) or f"unknown-{uuid.uuid4()}"
    runs = data.get("runs") if isinstance(data.get("runs"), Mapping) else {}
    success_rate = data.get("success_rate")
    if isinstance(success_rate, (int, float)) and success_rate > 1:
        aggregate = float(success_rate) / 100.0
    elif isinstance(success_rate, (int, float)):
        aggregate = float(success_rate)
    else:
        values = [
            1.0 if isinstance(run, Mapping) and run.get("success") else 0.0
            for run in runs.values()
            if isinstance(run, Mapping)
        ]
        aggregate = sum(values) / len(values) if values else 0.0

    run_id = f"cekura-{result_id}"
    status = str(data.get("status") or "completed")
    db.execute(
        """
        INSERT INTO eval_runs(id, suite, status, completed_at, aggregate_score, metrics_json)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            completed_at = CURRENT_TIMESTAMP,
            aggregate_score = excluded.aggregate_score,
            metrics_json = excluded.metrics_json
        """,
        (
            run_id,
            "cekura_external",
            status,
            aggregate,
            dumps({"source": CEKURA_SOURCE, "event": payload, "result_id": result_id}),
        ),
    )

    recorded = 0
    for external_run_id, run in runs.items():
        if not isinstance(run, Mapping):
            continue
        scenario = run.get("scenario") if isinstance(run.get("scenario"), Mapping) else {}
        case_id = str(scenario.get("name") or run.get("scenario_name") or external_run_id)
        transcript = run.get("transcript_object") or []
        passed = bool(run.get("success"))
        result_row_id = f"cekura-{result_id}-{external_run_id}"
        db.execute(
            """
            INSERT INTO eval_results(
                id, run_id, case_id, score, passed, latency_ms,
                expected_json, transcript_json, feedback_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                score = excluded.score,
                passed = excluded.passed,
                latency_ms = excluded.latency_ms,
                expected_json = excluded.expected_json,
                transcript_json = excluded.transcript_json,
                feedback_json = excluded.feedback_json
            """,
            (
                result_row_id,
                run_id,
                case_id,
                1.0 if passed else 0.0,
                int(passed),
                None,
                dumps(
                    {
                        "source": CEKURA_SOURCE,
                        "run_id": external_run_id,
                        "scenario": scenario,
                        "expected_outcome": run.get("expected_outcome") or {},
                    }
                ),
                dumps(transcript if isinstance(transcript, list) else []),
                dumps(
                    {
                        "source": CEKURA_SOURCE,
                        "error_message": run.get("error_message") or "",
                        "evaluation": run.get("evaluation") or {},
                        "checks": [
                            {
                                "name": "cekura_success",
                                "passed": passed,
                            }
                        ],
                    }
                ),
            ),
        )
        recorded += 1
    return {
        "local_eval_run_id": run_id,
        "cekura_result_id": result_id,
        "recorded_runs": recorded,
        "aggregate_score": aggregate,
    }


def parse_result_webhook_run_ids(payload: Mapping[str, Any]) -> list[str]:
    data = payload.get("data") if isinstance(payload.get("data"), Mapping) else payload
    runs = data.get("runs") if isinstance(data.get("runs"), Mapping) else {}
    return [str(run_id) for run_id in runs.keys()]
