from __future__ import annotations

from dataclasses import dataclass

from .db import Database


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
            hints.append("- Keep normal spoken answers under two sentences unless the caller asks for detail.")
        if any(row["label"] == "handoff" and row["rating"] <= 3 for row in feedback_rows):
            hints.append("- Offer a human handoff when the caller asks for an agent or repeats the same unresolved request.")

        if eval_rows and eval_rows[0]["avg_latency"] and eval_rows[0]["avg_latency"] > self.latency_target_ms:
            hints.append(f"- Target first response latency below {self.latency_target_ms} ms with the shortest matching answer.")

        for row in failing_cases:
            case_id = row["case_id"]
            if case_id == "account_lookup_requires_identifier":
                hints.append("- Account help: ask only for the account email or phone number.")
            elif case_id == "cancellation_collects_required_fields":
                hints.append("- Cancellation/refund: ask for the order ID and reason before saying anything is cancelled.")
            elif case_id == "handoff_respected":
                hints.append("- Human handoff: mention a human agent; this intent has priority over account lookup.")
            elif case_id == "latency_strategy":
                hints.append("- Latency questions: mention latency and one mitigation such as streaming or local voice processing.")
            else:
                hints.append(f"- Address failure pattern from eval case {case_id}.")

        if not hints:
            hints.append("- Current evaluations are passing; preserve concise confirmations and explicit next steps.")
        return list(dict.fromkeys(hints))[:5]
