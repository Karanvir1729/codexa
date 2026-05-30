#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = REPO_ROOT / "config" / "cekura" / "evaluators.json"
DEFAULT_BASE_URL = "https://api.cekura.ai"
TERMINAL_STATUSES = {"completed", "failed", "timeout", "cancelled"}


class CekuraError(RuntimeError):
    pass


class CekuraClient:
    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        if params:
            query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}, doseq=True)
            if query:
                url = f"{url}?{query}"
        data = None
        headers = {
            "accept": "application/json",
            "X-CEKURA-API-KEY": self.api_key,
        }
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["content-type"] = "application/json"
        request = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            raise CekuraError(f"{method} {path} failed with HTTP {exc.code}: {body[:1000]}") from exc
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    def get(self, path: str, **params: Any) -> Any:
        return self.request("GET", path, params=params)

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        return self.request("POST", path, payload=payload)

    def patch(self, path: str, payload: dict[str, Any]) -> Any:
        return self.request("PATCH", path, payload=payload)


def items(response: Any) -> list[dict[str, Any]]:
    if isinstance(response, list):
        return [item for item in response if isinstance(item, dict)]
    if isinstance(response, dict) and isinstance(response.get("results"), list):
        return [item for item in response["results"] if isinstance(item, dict)]
    return []


def load_config(path: Path) -> dict[str, Any]:
    with path.open() as handle:
        return json.load(handle)


def require_api_key() -> str:
    api_key = os.environ.get("CEKURA_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("Set CEKURA_API_KEY before using this script.")
    return api_key


def default_ws_url() -> str:
    configured = os.environ.get("CEKURA_WEBSOCKET_URL", "").strip()
    if configured:
        return configured
    public_base = os.environ.get("PUBLIC_BASE_URL", "http://127.0.0.1:8000").strip().rstrip("/")
    if public_base.startswith("https://"):
        return f"wss://{public_base.removeprefix('https://')}/api/cekura/ws"
    if public_base.startswith("http://"):
        return f"ws://{public_base.removeprefix('http://')}/api/cekura/ws"
    return f"{public_base}/api/cekura/ws"


def is_local_ws_url(url: str) -> bool:
    lowered = url.casefold()
    return any(host in lowered for host in ["localhost", "127.0.0.1", "0.0.0.0"])


def project_id(client: CekuraClient, explicit: int | None) -> int:
    if explicit:
        return explicit
    projects = items(client.get("/user/v1/projects/", page_size=100))
    if not projects:
        raise CekuraError("No Cekura projects are available for this API key.")
    return int(projects[0]["id"])


def find_personality(client: CekuraClient, desired_name: str) -> int:
    personalities = items(client.get("/test_framework/v1/personalities/", page_size=300))
    desired = desired_name.casefold()
    for personality in personalities:
        if str(personality.get("name", "")).casefold() == desired and personality.get("language") == "en":
            return int(personality["id"])
    for personality in personalities:
        if str(personality.get("name", "")).casefold() == "normal male":
            return int(personality["id"])
    for personality in personalities:
        if personality.get("language") == "en":
            return int(personality["id"])
    raise CekuraError("No English Cekura personality was found.")


def metric_ids(client: CekuraClient, pid: int) -> list[int]:
    metrics = items(client.get("/test_framework/v1/metrics/", project_id=pid, page_size=200))
    for metric in metrics:
        if str(metric.get("name", "")).casefold() == "expected outcome":
            return [int(metric["id"])]
    return []


def ensure_agent(
    client: CekuraClient,
    *,
    pid: int,
    config: dict[str, Any],
    websocket_url: str,
    dry_run: bool,
) -> dict[str, Any]:
    name = str(config["agent_name"])
    agents = items(client.get("/test_framework/v1/aiagents/", project_id=pid, page_size=100))
    existing = next((agent for agent in agents if agent.get("agent_name") == name), None)
    headers: dict[str, str] = {}
    websocket_secret = os.environ.get("CEKURA_WEBSOCKET_SECRET", "").strip()
    if websocket_secret:
        headers["X-VOCERA-SECRET"] = websocket_secret
    payload = {
        "project": pid,
        "agent_name": name,
        "description": config["agent_description"],
        "language": "en",
        "assistant_provider": "self_hosted",
        "transcript_provider": "custom",
        "inbound": False,
        "websocket_url": websocket_url,
        "websocket_headers": headers,
        "llm_system_prompt": (
            "Test the Voice Agent Feedback Engine through its Cekura WebSocket. "
            "The agent under test should stay concise, handle voice controls, route coding requests "
            "to Codexa when configured, and fail gracefully when dependencies are unavailable."
        ),
    }
    if dry_run:
        return {"id": existing.get("id") if existing else None, "agent_name": name, "dry_run": True}
    if existing:
        return client.patch(f"/test_framework/v1/aiagents/{existing['id']}/", payload)
    return client.post("/test_framework/v1/aiagents/", payload)


def scenario_payload(
    *,
    agent_id: int,
    personality_id: int,
    metric_ids_value: list[int],
    tags: list[str],
    evaluator: dict[str, Any],
) -> dict[str, Any]:
    return {
        "agent": agent_id,
        "name": evaluator["name"],
        "scenario_type": "conditional_actions",
        "conditional_actions": {
            "role": (
                "You are a deterministic QA evaluator testing a browser voice coding agent. "
                "Follow each action exactly and end when instructed."
            ),
            "conditions": evaluator["conditions"],
        },
        "expected_outcome_prompt": evaluator["expected_outcome"],
        "personality": personality_id,
        "metrics": metric_ids_value,
        "tags": tags,
    }


def ensure_scenarios(
    client: CekuraClient,
    *,
    agent_id: int,
    personality_id: int,
    metric_ids_value: list[int],
    config: dict[str, Any],
    dry_run: bool,
) -> list[dict[str, Any]]:
    existing = [] if dry_run and not agent_id else items(
        client.get("/test_framework/v1/scenarios/", agent_id=agent_id, page_size=300)
    )
    by_name = {str(scenario.get("name")): scenario for scenario in existing}
    synced: list[dict[str, Any]] = []
    tags = [str(tag) for tag in config.get("tags", [])]
    for evaluator in config["evaluators"]:
        payload = scenario_payload(
            agent_id=agent_id,
            personality_id=personality_id,
            metric_ids_value=metric_ids_value,
            tags=tags,
            evaluator=evaluator,
        )
        current = by_name.get(evaluator["name"])
        if dry_run:
            synced.append({"id": current.get("id") if current else None, "name": evaluator["name"], "dry_run": True})
        elif current:
            synced.append(client.patch(f"/test_framework/v1/scenarios/{current['id']}/", payload))
        else:
            synced.append(client.post("/test_framework/v1/scenarios/", payload))
    return synced


def command_status(args: argparse.Namespace) -> None:
    client = CekuraClient(require_api_key(), args.base_url)
    pid = project_id(client, args.project_id)
    agents = items(client.get("/test_framework/v1/aiagents/", project_id=pid, page_size=100))
    scenarios = items(client.get("/test_framework/v1/scenarios/", project_id=pid, page_size=100))
    print(json.dumps({"project_id": pid, "agents": agents, "scenario_count": len(scenarios)}, indent=2))


def command_sync(args: argparse.Namespace) -> None:
    client = CekuraClient(require_api_key(), args.base_url)
    config = load_config(args.config)
    ws_url = args.websocket_url or default_ws_url()
    if is_local_ws_url(ws_url) and not args.allow_local_url:
        raise SystemExit(
            "CEKURA_WEBSOCKET_URL points at localhost. Expose the backend with ngrok/cloudflared "
            "and pass a public wss:// URL, or use --allow-local-url for local-only setup."
        )
    pid = project_id(client, args.project_id)
    personality_id = find_personality(client, str(config.get("default_personality_name", "Normal Male")))
    metric_ids_value = metric_ids(client, pid)
    agent = ensure_agent(client, pid=pid, config=config, websocket_url=ws_url, dry_run=args.dry_run)
    agent_id = int(agent["id"]) if agent.get("id") else 0
    scenarios = ensure_scenarios(
        client,
        agent_id=agent_id,
        personality_id=personality_id,
        metric_ids_value=metric_ids_value,
        config=config,
        dry_run=args.dry_run,
    )
    summary = {
        "project_id": pid,
        "agent_id": agent_id,
        "agent_name": agent.get("agent_name"),
        "websocket_url": ws_url,
        "personality_id": personality_id,
        "metric_ids": metric_ids_value,
        "scenario_ids": [scenario.get("id") for scenario in scenarios],
        "dry_run": args.dry_run,
    }
    print(json.dumps(summary, indent=2))


def resolve_agent_id(client: CekuraClient, args: argparse.Namespace, config: dict[str, Any]) -> int:
    if args.agent_id:
        return args.agent_id
    pid = project_id(client, args.project_id)
    agents = items(client.get("/test_framework/v1/aiagents/", project_id=pid, page_size=100))
    for agent in agents:
        if agent.get("agent_name") == config["agent_name"]:
            return int(agent["id"])
    raise CekuraError("Agent not found. Run sync first or pass --agent-id.")


def scenario_ids_for_agent(client: CekuraClient, agent_id: int, config: dict[str, Any]) -> list[int]:
    wanted = {item["name"] for item in config["evaluators"]}
    scenarios = items(client.get("/test_framework/v1/scenarios/", agent_id=agent_id, page_size=300))
    ids = [int(scenario["id"]) for scenario in scenarios if scenario.get("name") in wanted]
    if not ids:
        raise CekuraError("No matching Cekura scenarios found. Run sync first.")
    return ids


def command_run(args: argparse.Namespace) -> None:
    client = CekuraClient(require_api_key(), args.base_url)
    config = load_config(args.config)
    agent_id = resolve_agent_id(client, args, config)
    scenario_ids = args.scenarios or scenario_ids_for_agent(client, agent_id, config)
    ws_url = args.websocket_url or default_ws_url()
    if is_local_ws_url(ws_url) and not args.allow_local_url:
        raise SystemExit(
            "CEKURA_WEBSOCKET_URL points at localhost. Expose the backend with ngrok/cloudflared "
            "and pass a public wss:// URL, or use --allow-local-url for local-only smoke tests."
        )
    payload = {
        "agent_id": agent_id,
        "name": args.name,
        "scenarios": scenario_ids,
        "frequency": args.frequency,
        "websocket_url": ws_url,
        "concurrency_limit": args.concurrency_limit,
    }
    result = client.post("/test_framework/v1/scenarios/run_scenarios_text/", payload)
    result_id = result.get("id") or result.get("result_id") if isinstance(result, dict) else None
    print(json.dumps({"started": result, "scenario_ids": scenario_ids}, indent=2))
    if args.wait and result_id:
        wait_for_result(client, int(result_id), args.poll_seconds, args.timeout_seconds)


def wait_for_result(client: CekuraClient, result_id: int, poll_seconds: int, timeout_seconds: int) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        result = client.get(f"/test_framework/v1/results/{result_id}/")
        status = str(result.get("status", "unknown")) if isinstance(result, dict) else "unknown"
        print(json.dumps({"result_id": result_id, "status": status, "success_rate": result.get("success_rate")}, indent=2))
        if status in TERMINAL_STATUSES:
            print(json.dumps(summarize_result(result), indent=2))
            return
        if time.monotonic() >= deadline:
            raise SystemExit(f"Timed out waiting for Cekura result {result_id}.")
        time.sleep(poll_seconds)


def latest_result(client: CekuraClient, agent_id: int) -> dict[str, Any]:
    results = items(client.get("/test_framework/v1/results/", agent_id=agent_id, page_size=10))
    if not results:
        raise CekuraError("No Cekura results found for this agent.")
    return client.get(f"/test_framework/v1/results/{results[0]['id']}/")


def summarize_result(result: dict[str, Any]) -> dict[str, Any]:
    runs = result.get("runs") if isinstance(result.get("runs"), dict) else {}
    grouped: dict[str, dict[str, Any]] = {}
    infra_failures: list[dict[str, Any]] = []
    for run_id, run in runs.items():
        if not isinstance(run, dict):
            continue
        scenario = run.get("scenario") if isinstance(run.get("scenario"), dict) else {}
        name = str(scenario.get("name") or run.get("scenario_name") or run_id)
        bucket = grouped.setdefault(name, {"scenario": name, "passed": 0, "total": 0, "errors": []})
        bucket["total"] += 1
        if run.get("success"):
            bucket["passed"] += 1
        error = str(run.get("error_message") or "")
        if error:
            bucket["errors"].append(error)
            if any(term in error.casefold() for term in ["connect", "websocket", "timeout", "refused", "unreachable"]):
                infra_failures.append({"run_id": run_id, "scenario": name, "error": error})
    triage = []
    for bucket in grouped.values():
        total = int(bucket["total"])
        passed = int(bucket["passed"])
        pass_rate = passed / total if total else 0.0
        if bucket["errors"] and pass_rate == 0:
            classification = "infra_or_connection" if any("websocket" in e.casefold() or "connect" in e.casefold() for e in bucket["errors"]) else "deterministic_bug"
        elif pass_rate == 0:
            classification = "deterministic_bug"
        elif pass_rate < 1:
            classification = "flake_or_prompt_routing"
        else:
            classification = "passing"
        triage.append({**bucket, "pass_rate": pass_rate, "classification": classification})
    return {
        "result_id": result.get("id"),
        "status": result.get("status"),
        "success_rate": result.get("success_rate"),
        "triage": triage,
        "infra_failures": infra_failures,
    }


def command_triage(args: argparse.Namespace) -> None:
    client = CekuraClient(require_api_key(), args.base_url)
    config = load_config(args.config)
    if args.result_id:
        result = client.get(f"/test_framework/v1/results/{args.result_id}/")
    else:
        agent_id = resolve_agent_id(client, args, config)
        result = latest_result(client, agent_id)
    print(json.dumps(summarize_result(result), indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sync and run Cekura coverage for this voice agent.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--project-id", type=int, default=int(os.environ["CEKURA_PROJECT_ID"]) if os.environ.get("CEKURA_PROJECT_ID") else None)
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("status", help="List current project/agent state.")
    status.set_defaults(func=command_status)

    sync = subparsers.add_parser("sync", help="Create or update the Cekura agent and evaluators.")
    sync.add_argument("--websocket-url", default=os.environ.get("CEKURA_WEBSOCKET_URL"))
    sync.add_argument("--allow-local-url", action="store_true")
    sync.add_argument("--dry-run", action="store_true")
    sync.set_defaults(func=command_sync)

    run = subparsers.add_parser("run", help="Run synced evaluators in Cekura text WebSocket mode.")
    run.add_argument("--agent-id", type=int, default=int(os.environ["CEKURA_AGENT_ID"]) if os.environ.get("CEKURA_AGENT_ID") else None)
    run.add_argument("--websocket-url", default=os.environ.get("CEKURA_WEBSOCKET_URL"))
    run.add_argument("--allow-local-url", action="store_true")
    run.add_argument("--scenarios", type=int, nargs="*")
    run.add_argument("--frequency", type=int, default=1)
    run.add_argument("--concurrency-limit", type=int, default=3)
    run.add_argument("--name", default="Voice Agent Feedback Engine regression")
    run.add_argument("--wait", action="store_true")
    run.add_argument("--poll-seconds", type=int, default=10)
    run.add_argument("--timeout-seconds", type=int, default=600)
    run.set_defaults(func=command_run)

    triage = subparsers.add_parser("triage", help="Summarize latest or selected Cekura result.")
    triage.add_argument("--agent-id", type=int, default=int(os.environ["CEKURA_AGENT_ID"]) if os.environ.get("CEKURA_AGENT_ID") else None)
    triage.add_argument("--result-id", type=int)
    triage.set_defaults(func=command_triage)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except CekuraError as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
