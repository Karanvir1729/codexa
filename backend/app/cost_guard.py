from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass
from typing import Any

from .config import Settings
from .db import Database, dumps, loads


class CostLimitExceeded(RuntimeError):
    def __init__(self, snapshot: "CostSnapshot", attempted_usd: float) -> None:
        self.snapshot = snapshot
        self.attempted_usd = attempted_usd
        super().__init__(
            "Cost guard blocked the request: "
            f"${snapshot.used_usd + attempted_usd:.4f} would exceed "
            f"the ${snapshot.cap_usd:.2f} local cap."
        )


@dataclass(frozen=True)
class CostSnapshot:
    enabled: bool
    cap_usd: float
    used_usd: float
    remaining_usd: float
    reserved_usd: float
    actual_usd: float

    def to_dict(self) -> dict[str, float | bool]:
        data = asdict(self)
        return {
            key: round(value, 6) if isinstance(value, float) else value
            for key, value in data.items()
        }


class CostGuard:
    """Local spend cap for model calls.

    AWS credits and Cost Explorer are delayed account-level billing systems. This guard is the
    runtime's immediate stop sign: it tracks estimated spend that our app causes and blocks before
    a new call would exceed the configured cap.
    """

    def __init__(self, db: Database, settings: Settings) -> None:
        self.db = db
        self.settings = settings

    def snapshot(self) -> CostSnapshot:
        if not self.settings.cost_guard_enabled:
            return CostSnapshot(False, self.settings.cost_guard_cap_usd, 0.0, float("inf"), 0.0, 0.0)
        row = self.db.one(
            """
            SELECT
                COALESCE(SUM(CASE WHEN status = 'reserved' THEN amount_usd ELSE 0 END), 0) AS reserved,
                COALESCE(SUM(CASE WHEN status = 'actual' THEN amount_usd ELSE 0 END), 0) AS actual
            FROM cost_events
            """
        )
        reserved = float(row["reserved"] if row else 0.0)
        actual = float(row["actual"] if row else 0.0)
        used = reserved + actual
        cap = float(self.settings.cost_guard_cap_usd)
        return CostSnapshot(
            enabled=True,
            cap_usd=cap,
            used_usd=used,
            remaining_usd=max(cap - used, 0.0),
            reserved_usd=reserved,
            actual_usd=actual,
        )

    def reserve(
        self,
        amount_usd: float,
        source: str,
        provider: str,
        model: str | None,
        metadata: dict[str, Any] | None = None,
    ) -> str | None:
        if not self.settings.cost_guard_enabled or amount_usd <= 0:
            return None
        snapshot = self.snapshot()
        if snapshot.used_usd + amount_usd > snapshot.cap_usd:
            raise CostLimitExceeded(snapshot, amount_usd)
        event_id = str(uuid.uuid4())
        self.db.execute(
            """
            INSERT INTO cost_events(id, source, provider, model, amount_usd, status, metadata_json)
            VALUES (?, ?, ?, ?, ?, 'reserved', ?)
            """,
            (event_id, source, provider, model, amount_usd, dumps(metadata or {})),
        )
        return event_id

    def finalize(
        self,
        reservation_id: str | None,
        actual_usd: float,
        units: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if not self.settings.cost_guard_enabled or reservation_id is None:
            return
        self.db.execute(
            """
            UPDATE cost_events
            SET amount_usd = ?, status = 'actual', units_json = ?, metadata_json = ?
            WHERE id = ? AND status = 'reserved'
            """,
            (max(actual_usd, 0.0), dumps(units or {}), dumps(metadata or {}), reservation_id),
        )

    def release(self, reservation_id: str | None, metadata: dict[str, Any] | None = None) -> None:
        if not self.settings.cost_guard_enabled or reservation_id is None:
            return
        self.db.execute(
            """
            UPDATE cost_events
            SET amount_usd = 0, status = 'released', metadata_json = ?
            WHERE id = ? AND status = 'reserved'
            """,
            (dumps(metadata or {}), reservation_id),
        )

    def estimate_llm_call(self, provider: str, raw: dict[str, Any]) -> float:
        if provider == "nemotron":
            usage = loads(dumps(raw.get("usage", {})), {})
            input_tokens = float(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
            output_tokens = float(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
            token_cost = (
                input_tokens * self.settings.cost_guard_nemotron_input_per_1m_tokens_usd
                + output_tokens * self.settings.cost_guard_nemotron_output_per_1m_tokens_usd
            ) / 1_000_000
            return max(token_cost, self.settings.cost_guard_nemotron_call_usd)
        return self.settings.cost_guard_reserve_usd_per_call

    def reserve_amount_for_provider(self, provider: str) -> float:
        if provider == "nemotron":
            return self.settings.cost_guard_nemotron_call_usd
        return self.settings.cost_guard_reserve_usd_per_call
