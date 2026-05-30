#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "data" / "codexa-generation-benchmarks"
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "timeout"}


@dataclass(frozen=True)
class ProjectSpec:
    slug: str
    prompt: str
    required_files: tuple[str, ...] = ("index.html", "styles.css", "script.js")
    check_commands: tuple[tuple[str, ...], ...] = (("node", "--check", "script.js"),)


PROJECT_SPECS: tuple[ProjectSpec, ...] = (
    ProjectSpec("quote-board", "a tiny static quote board app with saved favorite quotes"),
    ProjectSpec("pomodoro-studio", "a static Pomodoro focus timer with session presets and a progress log"),
    ProjectSpec("habit-garden", "a static habit tracker with streak badges and localStorage persistence"),
    ProjectSpec("mini-kanban", "a static three-column kanban board with draggable-looking task cards and filters"),
    ProjectSpec("palette-lab", "a static color palette generator with saved palettes and contrast notes"),
    ProjectSpec("recipe-box", "a static recipe card organizer with tags, search, and favorites"),
    ProjectSpec("expense-splitter", "a static expense splitter that divides costs across friends and saves recent splits"),
    ProjectSpec("flashcard-trainer", "a static flashcard trainer with flip cards, categories, and study progress"),
    ProjectSpec("markdown-notes", "a static markdown note pad with preview mode and local saved notes"),
    ProjectSpec("mock-weather", "a static weather dashboard using sample data, city tabs, and forecast cards"),
    ProjectSpec("pixel-sketch", "a static pixel art sketchpad with color swatches and clear/export controls"),
    ProjectSpec("interval-workout", "a static interval workout timer with exercise steps and rest periods"),
    ProjectSpec("reading-tracker", "a static reading tracker with books, progress bars, and favorite quotes"),
    ProjectSpec("invoice-estimator", "a static invoice estimator with line items, tax controls, and totals"),
    ProjectSpec("memory-match", "a static memory card matching game with move counter and restart control"),
)


def now_ms() -> int:
    return int(time.time() * 1000)


def request_json(
    method: str,
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: float = 240,
) -> dict[str, Any]:
    data = None
    headers = {"accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {url} failed with HTTP {exc.code}: {body[:1200]}") from exc
    return json.loads(raw) if raw else {}


def post_voice_turn(base_url: str, payload: dict[str, Any], timeout: float) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    response = request_json(
        "POST",
        f"{base_url.rstrip('/')}/api/voice/text-test/turn",
        payload=payload,
        timeout=timeout,
    )
    return response, time.perf_counter() - started


def create_codexa_session(base_url: str, *, label: str, conversation_id: str, timeout: float) -> dict[str, Any]:
    return request_json(
        "POST",
        f"{base_url.rstrip('/')}/sessions",
        payload={
            "label": label,
            "channel": "web_voice",
            "user_id": f"benchmark:{conversation_id}",
        },
        timeout=timeout,
    )


def post_codexa_message(base_url: str, session_id: str, text: str, timeout: float) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    response = request_json(
        "POST",
        f"{base_url.rstrip('/')}/sessions/{urllib.parse.quote(session_id)}/message",
        payload={"text": text, "channel": "web_voice"},
        timeout=timeout,
    )
    return response, time.perf_counter() - started


def codex_metadata(turn: dict[str, Any]) -> dict[str, Any]:
    value = turn.get("codex") or turn.get("codex_orchestrator") or {}
    return value if isinstance(value, dict) else {}


def direct_codexa_metadata(turn: dict[str, Any], session_id: str) -> dict[str, Any]:
    result = turn.get("result") if isinstance(turn.get("result"), dict) else {}
    task_ids = result.get("task_ids") if isinstance(result.get("task_ids"), list) else []
    return {
        "codex_session_id": turn.get("session_id") or result.get("session_id") or session_id,
        "codex_project_id": result.get("project_id"),
        "codex_task_id": result.get("task_id") or (task_ids[0] if task_ids else None),
    }


def session_status(codexa_base_url: str, session_id: str) -> dict[str, Any]:
    query = urllib.parse.urlencode({"session_id": session_id})
    return request_json("GET", f"{codexa_base_url.rstrip('/')}/codex/status?{query}", timeout=60)


def event_duration_ms(session: dict[str, Any], contains: str) -> int | None:
    for event in session.get("raw_events") or []:
        message = str(event.get("message") or "")
        if contains.casefold() not in message.casefold():
            continue
        match = __import__("re").search(r"\b(?:in|finished in)\s+([0-9.]+)\s*(ms|s)\b", message, __import__("re").I)
        if not match:
            continue
        value = float(match.group(1))
        return int(value if match.group(2).casefold() == "ms" else value * 1000)
    return None


def poll_until_terminal(
    codexa_base_url: str,
    session_id: str,
    *,
    timeout_seconds: float,
    poll_interval_seconds: float,
) -> tuple[dict[str, Any], float, list[dict[str, Any]]]:
    started = time.perf_counter()
    history: list[dict[str, Any]] = []
    last_key: tuple[Any, ...] | None = None
    latest: dict[str, Any] = {}
    while time.perf_counter() - started <= timeout_seconds:
        latest = session_status(codexa_base_url, session_id)
        session = latest.get("session") if isinstance(latest.get("session"), dict) else {}
        key = (
            session.get("status"),
            session.get("current_status"),
            session.get("active_task_id"),
            session.get("latest_codex_message"),
            len(session.get("files_modified") or []),
            len(session.get("commands_completed") or []),
            len(session.get("commands_failed") or []),
        )
        if key != last_key:
            history.append(
                {
                    "elapsed_s": round(time.perf_counter() - started, 3),
                    "status": session.get("status"),
                    "current_status": session.get("current_status"),
                    "task_id": session.get("active_task_id"),
                    "files_modified": len(session.get("files_modified") or []),
                    "commands_completed": len(session.get("commands_completed") or []),
                    "commands_failed": len(session.get("commands_failed") or []),
                    "message": str(session.get("latest_codex_message") or "")[:500],
                }
            )
            last_key = key
        status = str(session.get("status") or session.get("current_status") or "")
        current_status = str(session.get("current_status") or "")
        if status in TERMINAL_STATUSES or current_status in TERMINAL_STATUSES:
            return latest, time.perf_counter() - started, history
        time.sleep(poll_interval_seconds)
    history.append({"elapsed_s": round(time.perf_counter() - started, 3), "status": "timeout"})
    return latest, time.perf_counter() - started, history


def approval_ready(session: dict[str, Any]) -> bool:
    status = str(session.get("status") or "")
    current_status = str(session.get("current_status") or "")
    pending = session.get("pending_action") if isinstance(session.get("pending_action"), dict) else {}
    latest_message = str(session.get("latest_codex_message") or "").casefold()
    return (
        status == "waiting_for_approval"
        or current_status == "waiting_for_approval"
        or pending.get("type") == "approve_megaplan"
        or "reply `approve`" in latest_message
        or "reply approve" in latest_message
    )


def poll_until_approval_ready(
    codexa_base_url: str,
    session_id: str,
    *,
    timeout_seconds: float,
    poll_interval_seconds: float,
) -> tuple[dict[str, Any], float, list[dict[str, Any]], bool]:
    started = time.perf_counter()
    history: list[dict[str, Any]] = []
    latest: dict[str, Any] = {}
    last_key: tuple[Any, ...] | None = None
    while time.perf_counter() - started <= timeout_seconds:
        latest = session_status(codexa_base_url, session_id)
        session = latest.get("session") if isinstance(latest.get("session"), dict) else {}
        key = (
            session.get("status"),
            session.get("current_status"),
            (session.get("pending_action") or {}).get("type") if isinstance(session.get("pending_action"), dict) else None,
            session.get("latest_codex_message"),
        )
        if key != last_key:
            history.append(
                {
                    "elapsed_s": round(time.perf_counter() - started, 3),
                    "status": session.get("status"),
                    "current_status": session.get("current_status"),
                    "pending_action": (session.get("pending_action") or {}).get("type") if isinstance(session.get("pending_action"), dict) else None,
                    "message": str(session.get("latest_codex_message") or "")[:500],
                }
            )
            last_key = key
        status = str(session.get("status") or session.get("current_status") or "")
        current_status = str(session.get("current_status") or "")
        if approval_ready(session):
            return latest, time.perf_counter() - started, history, True
        if status in TERMINAL_STATUSES or current_status in TERMINAL_STATUSES:
            return latest, time.perf_counter() - started, history, False
        time.sleep(poll_interval_seconds)
    history.append({"elapsed_s": round(time.perf_counter() - started, 3), "status": "timeout_waiting_for_approval"})
    return latest, time.perf_counter() - started, history, False


def run_command(cwd: Path, command: tuple[str, ...], timeout: float = 60) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            list(command),
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        return {
            "command": " ".join(command),
            "exit_code": completed.returncode,
            "duration_s": round(time.perf_counter() - started, 3),
            "stdout": completed.stdout.strip()[-1200:],
            "stderr": completed.stderr.strip()[-1200:],
        }
    except Exception as exc:  # noqa: BLE001 - command failures are benchmark data
        return {
            "command": " ".join(command),
            "exit_code": None,
            "duration_s": round(time.perf_counter() - started, 3),
            "error": str(exc),
        }


def github_repo_name_from_remote(remote_url: str | None) -> str | None:
    if not remote_url:
        return None
    remote = remote_url.strip()
    if remote.startswith("git@github.com:"):
        value = remote.removeprefix("git@github.com:").removesuffix(".git")
        return value or None
    parsed = urllib.parse.urlparse(remote)
    if parsed.netloc.casefold().endswith("github.com"):
        value = parsed.path.strip("/").removesuffix(".git")
        return value or None
    return None


def run_repo_checks(workspace: str | None, expected_visibility: str) -> dict[str, Any]:
    if not workspace:
        return {"passed": False, "reason": "session did not report workspace_path", "checks": []}
    root = Path(workspace)
    checks: list[dict[str, Any]] = []

    git_dir_check = {"name": "project:.git", "passed": (root / ".git").exists(), "detail": str(root / ".git")}
    checks.append(git_dir_check)

    repo_root_result = run_command(root, ("git", "rev-parse", "--show-toplevel"), timeout=30)
    repo_root = repo_root_result.get("stdout") if repo_root_result.get("exit_code") == 0 else None
    checks.append(
        {
            "name": "git:repo-root-is-project",
            "passed": Path(str(repo_root)).resolve() == root.resolve() if repo_root else False,
            "detail": repo_root,
            "command": repo_root_result,
        }
    )

    remote_result = run_command(root, ("git", "remote", "get-url", "origin"), timeout=30)
    remote_url = remote_result.get("stdout") if remote_result.get("exit_code") == 0 else None
    github_name = github_repo_name_from_remote(str(remote_url) if remote_url else None)
    checks.append(
        {
            "name": "git:origin-github-remote",
            "passed": bool(github_name),
            "detail": remote_url,
            "repo": github_name,
            "command": remote_result,
        }
    )
    checks.append(
        {
            "name": "git:origin-not-voice-agent-repo",
            "passed": bool(remote_url) and "voice-agent-hackathon" not in str(remote_url),
            "detail": remote_url,
        }
    )

    github_visibility: dict[str, Any] | None = None
    if github_name:
        gh_result = run_command(
            root,
            ("gh", "repo", "view", github_name, "--json", "visibility,isPrivate,nameWithOwner,url"),
            timeout=45,
        )
        if gh_result.get("exit_code") == 0:
            try:
                github_visibility = json.loads(str(gh_result.get("stdout") or "{}"))
            except json.JSONDecodeError as exc:
                github_visibility = {"parse_error": str(exc), "raw": gh_result.get("stdout")}
        checks.append(
            {
                "name": "github:visibility",
                "passed": (
                    bool(github_visibility.get("isPrivate"))
                    if expected_visibility.casefold() == "private" and isinstance(github_visibility, dict)
                    else github_visibility is not None
                ),
                "detail": github_visibility,
                "command": gh_result,
            }
        )

    return {
        "passed": all(check.get("passed") is True for check in checks),
        "workspace_path": workspace,
        "remote_url": remote_url,
        "github_repo": github_name,
        "github_visibility": github_visibility,
        "checks": checks,
    }


def run_quality_checks(workspace: str | None, spec: ProjectSpec) -> dict[str, Any]:
    if not workspace:
        return {"passed": False, "reason": "session did not report workspace_path", "checks": []}
    root = Path(workspace)
    checks: list[dict[str, Any]] = []
    for required in spec.required_files:
        path = root / required
        checks.append({"name": f"file:{required}", "passed": path.is_file(), "detail": str(path)})
    for command in spec.check_commands:
        started = time.perf_counter()
        try:
            completed = subprocess.run(
                list(command),
                cwd=root,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
                check=False,
            )
            checks.append(
                {
                    "name": "command:" + " ".join(command),
                    "passed": completed.returncode == 0,
                    "exit_code": completed.returncode,
                    "duration_s": round(time.perf_counter() - started, 3),
                    "stdout": completed.stdout[-1200:],
                    "stderr": completed.stderr[-1200:],
                }
            )
        except Exception as exc:  # noqa: BLE001 - command failures are benchmark data
            checks.append({"name": "command:" + " ".join(command), "passed": False, "error": str(exc)})
    return {
        "passed": all(check.get("passed") for check in checks),
        "workspace_path": workspace,
        "checks": checks,
    }


def project_prompt(project_name: str, spec: ProjectSpec) -> str:
    return (
        f"Create a new Codexa project named {project_name} and plan {spec.prompt}. "
        "After I approve, build it as a browser-only static app with index.html, styles.css, script.js, "
        "a README, local validation, and concise continuous progress updates."
    )


def run_one(args: argparse.Namespace, index: int, spec: ProjectSpec) -> dict[str, Any]:
    project_name = f"{args.prefix}-{index:02d}-{spec.slug}-{int(time.time())}"
    conversation_id = f"codexa-benchmark-{project_name}"
    started_ms = now_ms()
    prompt = project_prompt(project_name, spec)
    if args.transport == "codexa":
        created_session = create_codexa_session(
            args.codexa_base_url,
            label=project_name,
            conversation_id=conversation_id,
            timeout=args.voice_turn_timeout,
        )
        session = created_session.get("session") if isinstance(created_session.get("session"), dict) else {}
        created_session_id = session.get("session_id")
        if not created_session_id:
            raise RuntimeError(f"Codexa session creation did not return session_id: {created_session}")
        first_turn, first_turn_s = post_codexa_message(args.codexa_base_url, str(created_session_id), prompt, args.voice_turn_timeout)
        first_codex = direct_codexa_metadata(first_turn, str(created_session_id))
    else:
        first_turn, first_turn_s = post_voice_turn(
            args.voice_base_url,
            {
                "message": prompt,
                "conversation_id": conversation_id,
                "voice_speech_path": "nvidia_gradium",
                "input_mode": "push_to_talk",
            },
            args.voice_turn_timeout,
        )
        first_codex = codex_metadata(first_turn)
    session_id = first_codex.get("codex_session_id")
    if not session_id:
        return {
            "index": index,
            "project_name": project_name,
            "conversation_id": conversation_id,
            "status": "failed",
            "failure": "first turn did not return codex_session_id",
            "first_turn": first_turn,
            "first_turn_duration_s": round(first_turn_s, 3),
            "started_ms": started_ms,
            "finished_ms": now_ms(),
        }

    approval_turn: dict[str, Any] | None = None
    approval_turn_s = 0.0
    approval_wait_s = 0.0
    approval_history: list[dict[str, Any]] = []
    if args.approve:
        approval_status, approval_wait_s, approval_history, ready = poll_until_approval_ready(
            args.codexa_base_url,
            str(session_id),
            timeout_seconds=args.approval_timeout,
            poll_interval_seconds=args.poll_interval,
        )
        if not ready:
            session = approval_status.get("session") if isinstance(approval_status.get("session"), dict) else {}
            return {
                "index": index,
                "project_name": project_name,
                "conversation_id": conversation_id,
                "session_id": session_id,
                "project_id": first_codex.get("codex_project_id"),
                "status": "failed",
                "failure": "Codexa did not reach an approval-ready state before approval timeout.",
                "codexa_status": session.get("status"),
                "codexa_current_status": session.get("current_status"),
                "first_turn_duration_s": round(first_turn_s, 3),
                "approval_wait_duration_s": round(approval_wait_s, 3),
                "approval_wait_history": approval_history,
                "latest_codex_message": str(session.get("latest_codex_message") or "")[:1200],
                "started_ms": started_ms,
                "finished_ms": now_ms(),
            }
        if args.transport == "codexa":
            approval_turn, approval_turn_s = post_codexa_message(args.codexa_base_url, str(session_id), "approve", args.voice_turn_timeout)
        else:
            approval_turn, approval_turn_s = post_voice_turn(
                args.voice_base_url,
                {
                    "message": "approve",
                    "conversation_id": conversation_id,
                    "voice_speech_path": "nvidia_gradium",
                    "input_mode": "push_to_talk",
                },
                args.voice_turn_timeout,
            )

    final_status, generation_s, status_history = poll_until_terminal(
        args.codexa_base_url,
        str(session_id),
        timeout_seconds=args.project_timeout,
        poll_interval_seconds=args.poll_interval,
    )
    session = final_status.get("session") if isinstance(final_status.get("session"), dict) else {}
    quality = run_quality_checks(session.get("workspace_path"), spec) if args.quality_checks else {"passed": None, "checks": []}
    repo = run_repo_checks(session.get("workspace_path"), args.expected_github_visibility) if args.repo_checks else {"passed": None, "checks": []}
    status = str(session.get("status") or session.get("current_status") or "unknown")
    current_status = str(session.get("current_status") or status)
    failed = status not in {"completed"} and current_status not in {"completed"}
    if status_history and status_history[-1].get("status") == "timeout":
        failed = True
        status = "timeout"
    if args.quality_checks and quality.get("passed") is False:
        failed = True
    if args.repo_checks and repo.get("passed") is False:
        failed = True
    return {
        "index": index,
        "transport": args.transport,
        "project_name": project_name,
        "conversation_id": conversation_id,
        "session_id": session_id,
        "project_id": first_codex.get("codex_project_id"),
        "task_id": (
            (
                direct_codexa_metadata(approval_turn, str(session_id))
                if args.transport == "codexa" and isinstance(approval_turn, dict)
                else codex_metadata(approval_turn or {})
            )
            or first_codex
        ).get("codex_task_id") if isinstance(approval_turn, dict) else first_codex.get("codex_task_id"),
        "status": "failed" if failed else "completed",
        "codexa_status": status,
        "codexa_current_status": current_status,
        "workspace_path": session.get("workspace_path"),
        "first_turn_duration_s": round(first_turn_s, 3),
        "approval_wait_duration_s": round(approval_wait_s, 3),
        "approval_turn_duration_s": round(approval_turn_s, 3),
        "generation_poll_duration_s": round(generation_s, 3),
        "total_duration_s": round((now_ms() - started_ms) / 1000, 3),
        "planning_duration_ms": event_duration_ms(session, "planning finished"),
        "project_intake_duration_ms": event_duration_ms(session, "Project intake finished"),
        "files_modified_count": len(session.get("files_modified") or []),
        "commands_completed_count": len(session.get("commands_completed") or []),
        "commands_failed_count": len(session.get("commands_failed") or []),
        "quality": quality,
        "repo": repo,
        "first_turn_message": first_turn.get("message") or first_turn.get("response"),
        "approval_turn_message": (approval_turn.get("message") or approval_turn.get("response")) if isinstance(approval_turn, dict) else None,
        "latest_codex_message": str(session.get("latest_codex_message") or "")[:1200],
        "approval_wait_history": approval_history,
        "status_history": status_history,
        "started_ms": started_ms,
        "finished_ms": now_ms(),
    }


def selected_specs(count: int) -> list[ProjectSpec]:
    specs: list[ProjectSpec] = []
    while len(specs) < count:
        specs.extend(PROJECT_SPECS)
    return specs[:count]


def write_report(path: Path, report: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(report, indent=2), encoding="utf-8")
    tmp.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run voice-to-Codexa project generation benchmarks.")
    parser.add_argument("--count", type=int, default=15, help="Number of projects to generate.")
    parser.add_argument("--prefix", default="codexa-bench", help="Project name prefix.")
    parser.add_argument("--voice-base-url", default=os.environ.get("VOICE_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--codexa-base-url", default=os.environ.get("CODEXA_BASE_URL", "http://127.0.0.1:4317"))
    parser.add_argument("--transport", default="voice", choices=("voice", "codexa"), help="Use the voice text-test wrapper or direct Codexa session API.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_DIR / "latest.json")
    parser.add_argument("--poll-interval", type=float, default=10)
    parser.add_argument("--approval-timeout", type=float, default=10 * 60)
    parser.add_argument("--project-timeout", type=float, default=30 * 60)
    parser.add_argument("--voice-turn-timeout", type=float, default=5 * 60)
    parser.add_argument("--no-approve", action="store_false", dest="approve", help="Only plan projects; do not approve builds.")
    parser.add_argument("--no-quality-checks", action="store_false", dest="quality_checks")
    parser.add_argument("--no-repo-checks", action="store_false", dest="repo_checks")
    parser.add_argument("--expected-github-visibility", default="private", choices=("private", "public", "internal"))
    args = parser.parse_args()
    if args.count < 1:
        raise SystemExit("--count must be >= 1")

    specs = selected_specs(args.count)
    report: dict[str, Any] = {
        "requested_count": args.count,
        "voice_base_url": args.voice_base_url,
        "codexa_base_url": args.codexa_base_url,
        "transport": args.transport,
        "approve": args.approve,
        "quality_checks": args.quality_checks,
        "repo_checks": args.repo_checks,
        "expected_github_visibility": args.expected_github_visibility,
        "started_at_ms": now_ms(),
        "projects": [],
    }
    write_report(args.output, report)
    for index, spec in enumerate(specs, start=1):
        print(f"[{index}/{args.count}] {spec.slug}", flush=True)
        project_started_ms = now_ms()
        try:
            result = run_one(args, index, spec)
        except Exception as exc:  # noqa: BLE001 - keep the batch running and preserve failure data
            result = {
                "index": index,
                "transport": args.transport,
                "spec_slug": spec.slug,
                "project_name": f"{args.prefix}-{index:02d}-{spec.slug}-failed",
                "status": "failed",
                "failure": str(exc),
                "started_ms": project_started_ms,
                "finished_ms": now_ms(),
                "total_duration_s": round((now_ms() - project_started_ms) / 1000, 3),
            }
        report["projects"].append(result)
        completed = sum(1 for item in report["projects"] if item.get("status") == "completed")
        failed = len(report["projects"]) - completed
        report.update(
            {
                "completed_count": completed,
                "failed_count": failed,
                "finished_count": len(report["projects"]),
                "finished_at_ms": now_ms(),
                "total_elapsed_s": round((now_ms() - report["started_at_ms"]) / 1000, 3),
            }
        )
        write_report(args.output, report)
        print(
            json.dumps(
                {
                    "project": result.get("project_name"),
                    "status": result["status"],
                    "total_duration_s": result["total_duration_s"],
                    "quality_passed": result.get("quality", {}).get("passed"),
                    "repo_passed": result.get("repo", {}).get("passed"),
                    "github_repo": result.get("repo", {}).get("github_repo"),
                    "report": str(args.output),
                }
            ),
            flush=True,
        )

    durations = [item["total_duration_s"] for item in report["projects"] if isinstance(item.get("total_duration_s"), (int, float))]
    report["duration_summary"] = {
        "min_s": min(durations) if durations else None,
        "max_s": max(durations) if durations else None,
        "avg_s": round(sum(durations) / len(durations), 3) if durations else None,
    }
    report["completed_count"] = sum(1 for item in report["projects"] if item.get("status") == "completed")
    report["failed_count"] = len(report["projects"]) - report["completed_count"]
    write_report(args.output, report)
    print(json.dumps({k: report[k] for k in ["requested_count", "completed_count", "failed_count", "duration_summary"]}, indent=2))


if __name__ == "__main__":
    main()
