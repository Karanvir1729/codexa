from __future__ import annotations

import statistics
import uuid
from pathlib import Path
from typing import Any

import yaml

from .agent import AgentService
from .db import Database, dumps
from .feedback import FeedbackLearner


def _contains(text: str, needle: str) -> bool:
    return needle.lower() in text.lower()


class EvalRunner:
    def __init__(self, db: Database, agent: AgentService, learner: FeedbackLearner) -> None:
        self.db = db
        self.agent = agent
        self.learner = learner

    async def run_suite(self, path: str | Path, apply_feedback: bool = True) -> dict[str, Any]:
        suite_path = Path(path)
        suite = yaml.safe_load(suite_path.read_text()) or {}
        run_id = str(uuid.uuid4())
        self.db.execute(
            "INSERT INTO eval_runs(id, suite, status) VALUES (?, ?, 'running')",
            (run_id, suite.get("name", suite_path.stem)),
        )
        results: list[dict[str, Any]] = []
        for case in suite.get("cases", []):
            result = await self._run_case(run_id, case)
            results.append(result)

        aggregate = statistics.mean([r["score"] for r in results]) if results else 0.0
        status = "passed" if all(r["passed"] for r in results) else "failed"
        self.db.execute(
            """
            UPDATE eval_runs
            SET status = ?, completed_at = CURRENT_TIMESTAMP, aggregate_score = ?, metrics_json = ?
            WHERE id = ?
            """,
            (status, aggregate, dumps({"case_count": len(results)}), run_id),
        )
        prompt_version = None
        if apply_feedback:
            prompt_version = self.learner.rebuild().version
        return {
            "run_id": run_id,
            "suite": suite.get("name", suite_path.stem),
            "status": status,
            "aggregate_score": aggregate,
            "prompt_version": prompt_version,
            "results": results,
        }

    async def _run_case(self, run_id: str, case: dict[str, Any]) -> dict[str, Any]:
        conversation_id = str(uuid.uuid4())
        transcript: list[dict[str, Any]] = []
        last_response: dict[str, Any] | None = None
        for user_text in case.get("turns", []):
            last_response = await self.agent.respond(
                user_text,
                conversation_id=conversation_id,
                channel="eval",
                metadata={"case_id": case["id"]},
            )
            transcript.append({"role": "user", "content": user_text})
            transcript.append({"role": "assistant", "content": last_response["message"]})

        assertions = case.get("assertions", {})
        message = last_response["message"] if last_response else ""
        latency_ms = int(last_response["latency_ms"] if last_response else 0)
        checks: list[tuple[str, bool]] = []
        for needle in assertions.get("must_include", []):
            checks.append((f"must_include:{needle}", _contains(message, needle)))
        for needle in assertions.get("must_not_include", []):
            checks.append((f"must_not_include:{needle}", not _contains(message, needle)))
        if "max_latency_ms" in assertions:
            checks.append((f"max_latency_ms:{assertions['max_latency_ms']}", latency_ms <= int(assertions["max_latency_ms"])))
        if assertions.get("asks_clarifying_question"):
            checks.append(("asks_clarifying_question", "?" in message))

        passed_checks = sum(1 for _, ok in checks if ok)
        score = passed_checks / len(checks) if checks else 1.0
        passed = score >= float(case.get("pass_threshold", 1.0))
        feedback = {"checks": [{"name": name, "passed": ok} for name, ok in checks]}
        result_id = str(uuid.uuid4())
        self.db.execute(
            """
            INSERT INTO eval_results(
                id, run_id, case_id, score, passed, latency_ms,
                expected_json, transcript_json, feedback_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                result_id,
                run_id,
                case["id"],
                score,
                int(passed),
                latency_ms,
                dumps(assertions),
                dumps(transcript),
                dumps(feedback),
            ),
        )
        return {
            "case_id": case["id"],
            "score": score,
            "passed": passed,
            "latency_ms": latency_ms,
            "feedback": feedback,
            "last_message": message,
        }

