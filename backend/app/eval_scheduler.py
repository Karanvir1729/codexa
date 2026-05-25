from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .evaluator import EvalRunner


def iso_now() -> str:
    return datetime.now(UTC).isoformat()


class EvalScheduler:
    def __init__(
        self,
        runner: EvalRunner,
        resolve_path: Callable[[str], Path],
        suite_path: str,
        interval_seconds: int,
        apply_feedback: bool,
    ) -> None:
        self.runner = runner
        self.resolve_path = resolve_path
        self.suite_path = suite_path
        self.interval_seconds = interval_seconds
        self.apply_feedback = apply_feedback
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()
        self.last_run: dict[str, Any] | None = None
        self.last_error: str | None = None
        self.next_run_at: str | None = None
        self.run_count = 0

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(
        self,
        interval_seconds: int | None = None,
        suite_path: str | None = None,
        apply_feedback: bool | None = None,
    ) -> dict[str, Any]:
        if interval_seconds is not None:
            self.interval_seconds = interval_seconds
        if suite_path is not None:
            self.suite_path = suite_path
        if apply_feedback is not None:
            self.apply_feedback = apply_feedback
        if self.interval_seconds <= 0:
            raise ValueError("interval_seconds must be greater than 0.")
        if self.running:
            return self.status()
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._loop(), name="voice-agent-eval-scheduler")
        return self.status()

    async def stop(self) -> dict[str, Any]:
        if not self.running:
            return self.status()
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self.next_run_at = None
        return self.status()

    async def run_once(self) -> dict[str, Any]:
        try:
            result = await self.runner.run_suite(
                self.resolve_path(self.suite_path),
                apply_feedback=self.apply_feedback,
            )
        except Exception as exc:
            self.last_error = f"{type(exc).__name__}: {exc}"
            raise
        self.run_count += 1
        self.last_error = None
        self.last_run = {**result, "ran_at": iso_now()}
        return result

    async def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                await self.run_once()
            except Exception:
                pass
            next_run = datetime.now(UTC) + timedelta(seconds=self.interval_seconds)
            self.next_run_at = next_run.isoformat()
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.interval_seconds)
            except TimeoutError:
                continue

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "suite_path": self.suite_path,
            "interval_seconds": self.interval_seconds,
            "apply_feedback": self.apply_feedback,
            "run_count": self.run_count,
            "last_run": self.last_run,
            "last_error": self.last_error,
            "next_run_at": self.next_run_at,
        }
