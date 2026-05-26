#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import time
from dataclasses import asdict, dataclass
from typing import Any

import httpx


@dataclass(frozen=True)
class Trial:
    provider: str
    model: str
    ok: bool
    ttfb_ms: int | None
    total_ms: int
    chars: int
    error: str | None = None


def percentile(values: list[int], p: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * p)))
    return ordered[index]


async def openai_trial(
    *,
    provider: str,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    timeout: float,
) -> Trial:
    started = time.perf_counter()
    first_at: float | None = None
    chars = 0
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "/no_think\nAnswer in one short sentence."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": 24,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            async with client.stream(
                "POST",
                f"{base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        break
                    parsed = json.loads(data)
                    choices = parsed.get("choices") or []
                    if not choices:
                        continue
                    delta = choices[0].get("delta") or {}
                    text = delta.get("content") or ""
                    if text and first_at is None:
                        first_at = time.perf_counter()
                    chars += len(text)
        total_ms = int((time.perf_counter() - started) * 1000)
        ttfb_ms = int((first_at - started) * 1000) if first_at else None
        return Trial(provider, model, True, ttfb_ms, total_ms, chars)
    except Exception as exc:
        return Trial(
            provider,
            model,
            False,
            None,
            int((time.perf_counter() - started) * 1000),
            chars,
            f"{type(exc).__name__}: {exc}",
        )


async def vertex_token() -> str:
    import google.auth
    from google.auth.transport.requests import Request

    credentials, _project = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    credentials.refresh(Request())
    return credentials.token


async def vertex_trial(
    *,
    endpoint_url: str,
    model: str,
    prompt: str,
    timeout: float,
) -> Trial:
    started = time.perf_counter()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "/no_think\nAnswer in one short sentence."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": 24,
        "stream": False,
    }
    try:
        token = await vertex_token()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            response = await client.post(endpoint_url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        total_ms = int((time.perf_counter() - started) * 1000)
        return Trial("vertex_nim", model, True, total_ms, total_ms, len(text))
    except Exception as exc:
        return Trial(
            "vertex_nim",
            model,
            False,
            None,
            int((time.perf_counter() - started) * 1000),
            0,
            f"{type(exc).__name__}: {exc}",
        )


def summarize(trials: list[Trial]) -> dict[str, Any]:
    good = [trial for trial in trials if trial.ok]
    ttfb = [trial.ttfb_ms for trial in good if trial.ttfb_ms is not None]
    total = [trial.total_ms for trial in good]
    return {
        "count": len(trials),
        "ok": len(good),
        "errors": [trial.error for trial in trials if trial.error],
        "ttfb_ms": {
            "min": min(ttfb) if ttfb else None,
            "p50": int(statistics.median(ttfb)) if ttfb else None,
            "p95": percentile(ttfb, 0.95),
            "max": max(ttfb) if ttfb else None,
        },
        "total_ms": {
            "min": min(total) if total else None,
            "p50": int(statistics.median(total)) if total else None,
            "p95": percentile(total, 0.95),
            "max": max(total) if total else None,
        },
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark LLM first-token and total latency.")
    parser.add_argument("--provider", choices=["openai", "vertex_nim"], default="openai")
    parser.add_argument("--base-url", default=os.getenv("OPENAI_BASE_URL") or os.getenv("NVIDIA_BASE_URL") or os.getenv("LOCAL_LLM_BASE_URL"))
    parser.add_argument("--api-key", default=os.getenv("OPENAI_API_KEY") or os.getenv("NVIDIA_API_KEY") or os.getenv("LOCAL_LLM_API_KEY") or "dummy")
    parser.add_argument("--model", default=os.getenv("OPENAI_MODEL") or os.getenv("NVIDIA_MODEL") or os.getenv("LOCAL_LLM_MODEL") or "unknown")
    parser.add_argument("--vertex-endpoint-url", default=os.getenv("VERTEX_NIM_ENDPOINT_URL"))
    parser.add_argument("--prompt", default="What account email should I use?")
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()

    trials: list[Trial] = []
    for _ in range(args.trials):
        if args.provider == "vertex_nim":
            if not args.vertex_endpoint_url:
                raise SystemExit("VERTEX_NIM_ENDPOINT_URL or --vertex-endpoint-url is required.")
            trial = await vertex_trial(
                endpoint_url=args.vertex_endpoint_url,
                model=args.model,
                prompt=args.prompt,
                timeout=args.timeout,
            )
        else:
            if not args.base_url:
                raise SystemExit("--base-url or OPENAI_BASE_URL/NVIDIA_BASE_URL is required.")
            trial = await openai_trial(
                provider="openai",
                base_url=args.base_url,
                api_key=args.api_key,
                model=args.model,
                prompt=args.prompt,
                timeout=args.timeout,
            )
        trials.append(trial)
        print(json.dumps(asdict(trial)), flush=True)

    print(json.dumps({"summary": summarize(trials)}, indent=2))
    return 0 if all(trial.ok for trial in trials) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
