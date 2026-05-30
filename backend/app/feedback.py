from __future__ import annotations

from dataclasses import dataclass

from .db import Database, dumps, loads


DEFAULT_SELF_LEARN_CONFIG = {
    "enabled": True,
    "factor": 0.35,
}


@dataclass(frozen=True)
class PromptVersion:
    version: int
    system_prompt: str
    learned_hints: str

    @property
    def compiled(self) -> str:
        if not self.learned_hints.strip():
            return self.system_prompt
        return f"{self.system_prompt}\n\nLearned:\n{self.learned_hints.strip()}"


class PromptRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def active(self) -> PromptVersion:
        row = self.db.one(
            """
            SELECT version, system_prompt, learned_hints
            FROM prompt_versions
            WHERE active = 1
            ORDER BY version DESC
            LIMIT 1
            """
        )
        if row is None:
            raise RuntimeError("No active prompt version exists.")
        return PromptVersion(row["version"], row["system_prompt"], row["learned_hints"])

    def create(self, system_prompt: str, learned_hints: str, source: str) -> PromptVersion:
        with self.db.connect() as conn:
            conn.execute("UPDATE prompt_versions SET active = 0")
            cursor = conn.execute(
                """
                INSERT INTO prompt_versions(system_prompt, learned_hints, source, active)
                VALUES (?, ?, ?, 1)
                """,
                (system_prompt, learned_hints, source),
            )
            version = int(cursor.lastrowid)
        return PromptVersion(version, system_prompt, learned_hints)


class FeedbackLearner:
    """Turns eval and live feedback data into prompt constraints used on future calls."""

    def __init__(self, db: Database, repo: PromptRepository, latency_target_ms: int) -> None:
        self.db = db
        self.repo = repo
        self.latency_target_ms = latency_target_ms

    def rebuild(self) -> PromptVersion:
        active = self.repo.active()
        hints = self._derive_hints()
        return self.repo.create(active.system_prompt, "\n".join(hints), "feedback-loop")

    def derive_hints(self) -> list[str]:
        return self._derive_hints()

    def config(self) -> dict[str, object]:
        row = self.db.one(
            "SELECT value_json FROM runtime_settings WHERE key = ?",
            ("self_learn_config",),
        )
        saved = loads(row["value_json"], {}) if row else {}
        if not isinstance(saved, dict):
            saved = {}
        enabled = saved.get("enabled", DEFAULT_SELF_LEARN_CONFIG["enabled"])
        factor = saved.get("factor", DEFAULT_SELF_LEARN_CONFIG["factor"])
        return {
            "enabled": bool(enabled),
            "factor": float(factor) if isinstance(factor, (int, float)) else DEFAULT_SELF_LEARN_CONFIG["factor"],
        }

    def update_config(
        self,
        *,
        enabled: bool | None = None,
        factor: float | None = None,
    ) -> dict[str, object]:
        current = self.config()
        if enabled is not None:
            current["enabled"] = bool(enabled)
        if factor is not None:
            current["factor"] = max(0.0, min(1.0, float(factor)))
        self.db.execute(
            """
            INSERT INTO runtime_settings(key, value_json, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = CURRENT_TIMESTAMP
            """,
            ("self_learn_config", dumps(current)),
        )
        return current

    def report(self) -> dict[str, object]:
        active = self.repo.active()
        feedback_rows = self.db.all(
            """
            SELECT label, AVG(rating) AS avg_rating, COUNT(*) AS count
            FROM feedback
            GROUP BY label
            ORDER BY count DESC
            LIMIT 10
            """
        )
        eval_rows = self.db.all(
            """
            SELECT case_id, score, passed, latency_ms, feedback_json, created_at
            FROM eval_results
            ORDER BY created_at DESC
            LIMIT 20
            """
        )
        return {
            "config": self.config(),
            "active_prompt_version": active.version,
            "learned_hints": active.learned_hints,
            "proposed_hints": self._derive_hints(),
            "feedback_summary": [
                {
                    "label": row["label"],
                    "avg_rating": row["avg_rating"],
                    "count": row["count"],
                }
                for row in feedback_rows
            ],
            "recent_eval_results": [
                {
                    "case_id": row["case_id"],
                    "score": row["score"],
                    "passed": bool(row["passed"]),
                    "latency_ms": row["latency_ms"],
                    "failed_checks": _failed_check_names(row["feedback_json"]),
                    "created_at": row["created_at"],
                }
                for row in eval_rows
            ],
        }

    def _derive_hints(self) -> list[str]:
        hints: list[str] = []
        feedback_rows = self.db.all(
            """
            SELECT label, rating, COUNT(*) AS count
            FROM feedback
            GROUP BY label, rating
            ORDER BY count DESC
            """
        )
        eval_rows = self.db.all(
            """
            SELECT AVG(score) AS avg_score, AVG(latency_ms) AS avg_latency
            FROM eval_results
            """
        )
        failing_cases = self.db.all(
            """
            SELECT case_id, feedback_json
            FROM eval_results
            WHERE passed = 0
            ORDER BY created_at DESC
            LIMIT 5
            """
        )

        if any(row["label"] in {"incorrect", "missing_detail"} and row["rating"] <= 3 for row in feedback_rows):
            hints.append("- When information is missing or uncertain, ask exactly one clarifying question before answering.")
        if any(row["label"] == "too_slow" and row["rating"] <= 3 for row in feedback_rows):
            hints.append("- Keep routine spoken answers efficient, but never shorten explicit requests for detail, stories, or explanation.")
        if any(row["label"] == "handoff" and row["rating"] <= 3 for row in feedback_rows):
            hints.append("- Stay conversational; do not route the user away unless an enabled flow or tool explicitly requires it.")

        if eval_rows and eval_rows[0]["avg_latency"] and eval_rows[0]["avg_latency"] > self.latency_target_ms:
            hints.append(
                f"- Target first response latency below {self.latency_target_ms} ms by removing filler, "
                "not by truncating requested detail."
            )

        for row in failing_cases:
            case_id = row["case_id"]
            failed_checks = _failed_check_names(row["feedback_json"])
            for check in failed_checks:
                if check.startswith("must_include:"):
                    concept = check.split(":", 1)[1]
                    hints.append(f"- Eval {case_id}: include the concept '{concept}' when that intent appears.")
                elif check.startswith("must_not_include:"):
                    phrase = check.split(":", 1)[1]
                    hints.append(f"- Eval {case_id}: avoid saying '{phrase}'.")
                elif check.startswith("max_latency_ms:"):
                    hints.append(f"- Eval {case_id}: reduce first response latency before adding extra detail.")
                elif check == "asks_clarifying_question":
                    hints.append(f"- Eval {case_id}: ask one clear follow-up question when the request is underspecified.")
            if case_id in {
                "account_lookup_requires_identifier",
                "cancellation_collects_required_fields",
                "handoff_respected",
            }:
                hints.append("- Avoid customer-support templates; respond as a conversational AI unless a tool result changes the task.")
            elif case_id == "latency_strategy":
                hints.append("- Latency questions: mention latency and one mitigation such as streaming or local voice processing.")
            else:
                hints.append(f"- Address failure pattern from eval case {case_id}.")

        if not hints:
            hints.append("- Current evaluations are passing; preserve concise confirmations and explicit next steps.")
        return list(dict.fromkeys(hints))[:5]


def _failed_check_names(feedback_json: str | None) -> list[str]:
    from .db import loads

    feedback = loads(feedback_json, {})
    checks = feedback.get("checks") if isinstance(feedback, dict) else []
    if not isinstance(checks, list):
        return []
    return [
        str(check.get("name"))
        for check in checks
        if isinstance(check, dict) and check.get("name") and not check.get("passed")
    ]
