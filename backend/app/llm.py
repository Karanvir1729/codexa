from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from .config import Settings

Message = dict[str, str]


@dataclass(frozen=True)
class LLMResult:
    text: str
    latency_ms: int
    model: str
    provider: str
    raw: dict[str, Any]


class LLMClient(Protocol):
    async def generate(self, messages: list[Message], system_prompt: str) -> LLMResult:
        ...

    async def warmup(self) -> None:
        ...


class MockLLMClient:
    """Deterministic client for tests and no-credit eval runs."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def generate(self, messages: list[Message], system_prompt: str) -> LLMResult:
        start = time.perf_counter()
        user_text = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        text = self._respond(user_text, system_prompt)
        return LLMResult(
            text=text,
            latency_ms=int((time.perf_counter() - start) * 1000),
            model="mock-agent",
            provider="mock",
            raw={"deterministic": True},
        )

    async def warmup(self) -> None:
        return None

    def _respond(self, user_text: str, system_prompt: str) -> str:
        normalized = user_text.lower()
        if "voice runtime protocol for this turn" in system_prompt.lower():
            return self._runtime_command_response(user_text, system_prompt)
        if "latency" in normalized or "network" in normalized:
            return "I will keep responses brief, monitor turn latency, and route voice traffic through the lowest-latency configured transport."
        if "human" in normalized and "agent" in normalized:
            return "I will stay with you as the conversational AI."
        if "story" in normalized:
            return (
                "The old clock in the hallway began ticking after midnight. "
                "Each tick made the house colder and the shadows longer. "
                "When Mira opened the clock face, she heard her own voice whisper from inside. "
                "By morning, the clock was silent, and Mira's room was empty."
            )
        if "hello" in normalized or "hi" in normalized:
            return "Hi, I am ready. What would you like to handle first?"
        if "learned:" in system_prompt.lower():
            return "I will apply the latest evaluation feedback and keep the next step concrete."
        return "I understand. I will answer concisely, verify missing details, and avoid guessing."

    def _runtime_command_response(self, user_text: str, system_prompt: str) -> str:
        normalized = re.sub(r"[^a-z0-9]+", " ", user_text.casefold()).strip()
        current_speed = _runtime_number(system_prompt, r"\bspeed=([0-9.]+)", 1.05)
        natural_min = _runtime_number(system_prompt, r"\bnatural=([0-9.]+)-[0-9.]+", 0.9)
        natural_max = _runtime_number(system_prompt, r"\bnatural=[0-9.]+-([0-9.]+)", 1.5)

        if "normal speed" in normalized or "regular speed" in normalized or "default speed" in normalized:
            target = 1.0
            speak = "Sure, I'll use normal speed."
            action = {"tool": "set_tts_speed", "args": {"speed": target, "reason": "user_requested_normal_speech_speed"}}
        elif "very slow" in normalized or "much slower" in normalized or "super slow" in normalized:
            target = natural_min
            speak = f"Sure, I'll slow down to {target:.2g}x."
            action = {"tool": "set_tts_speed", "args": {"speed": target, "reason": "user_requested_very_slow_speech"}}
        elif (
            "slower" in normalized.split()
            or "slowly" in normalized.split()
            or "slow down" in normalized
            or ("slow" in normalized.split() and "too slow" not in normalized)
            or "too fast" in normalized
        ):
            target = max(natural_min, current_speed - 0.2)
            speak = f"Sure, I'll talk slower at {target:.2g}x."
            action = {"tool": "increment_tts_speed", "args": {"delta": -0.2, "reason": "user_requested_slower_speech"}}
        elif "very fast" in normalized or "really fast" in normalized or "super fast" in normalized or "much faster" in normalized:
            target = natural_max
            speak = f"Got it, I'll apply the faster speed at {target:.2g}x."
            action = {"tool": "set_tts_speed", "args": {"speed": target, "reason": "user_requested_very_fast_speech"}}
        elif "faster" in normalized.split() or "quicker" in normalized.split() or "speed up" in normalized or "too slow" in normalized:
            target = min(natural_max, current_speed + 0.2)
            speak = f"Sure, I'll apply the faster speed at {target:.2g}x."
            action = {"tool": "increment_tts_speed", "args": {"delta": 0.2, "reason": "user_requested_faster_speech"}}
        elif "get_codex_orchestrator_status" in system_prompt and (
            "codex status" in normalized
            or "what changed" in normalized
            or "pending approval" in normalized
        ):
            speak = "I'll check Codex status."
            action = {"tool": "get_codex_orchestrator_status", "args": {"reason": "user_requested_codex_status"}}
        elif "delegate_to_codex_orchestrator" in system_prompt and (
            "active codex planning session" in system_prompt.lower()
            or "codex" in normalized
            or normalized in {"approve", "approve it", "yes approve", "go ahead", "deny", "deny it", "no deny", "do not approve"}
            or any(word in normalized.split() for word in ["build", "create", "fix", "implement", "update", "test"])
        ):
            speak = "I'll route that to Codex planning."
            action = {
                "tool": "delegate_to_codex_orchestrator",
                "args": {
                    "goal": user_text,
                    "mode": "plan_first",
                    "reason": "user_requested_codex_planning",
                },
            }
        else:
            speak = "I understand."
            action = {"tool": "get_voice_runtime_status", "args": {"reason": "user_requested_runtime_status"}}

        return json.dumps(
            {
                "speak": speak,
                "runtime_actions": [action],
                "reasoning_profile": "fast",
                "debug": {
                    "intent": "runtime_control",
                    "current_tts_speed": round(current_speed, 2),
                },
            }
        )


def _runtime_number(text: str, pattern: str, default: float) -> float:
    match = re.search(pattern, text)
    if not match:
        return default
    try:
        return float(match.group(1))
    except ValueError:
        return default


def _runtime_protocol_requires_json(system_prompt: str) -> bool:
    return "Voice runtime protocol for this turn" in system_prompt


class OpenAICompatibleLLMClient:
    def __init__(self, settings: Settings, provider: str) -> None:
        self.settings = settings
        self.provider = provider
        self.base_url = settings.active_base_url
        self.api_key = settings.active_api_key
        self.model = settings.active_model
        if not self.base_url:
            raise ValueError("OpenAI-compatible provider requires a base URL.")
        if settings.active_requires_api_key and not self.api_key:
            raise ValueError(f"{provider} provider requires an API key.")

    async def generate(self, messages: list[Message], system_prompt: str) -> LLMResult:
        start = time.perf_counter()
        system = system_prompt
        if self.settings.reasoning_mode == "off":
            system = f"/no_think\n{system_prompt}"
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, *messages],
            "temperature": self.settings.llm_temperature,
            "top_p": self.settings.llm_top_p,
            "max_tokens": self.settings.max_completion_tokens,
            "stream": False,
        }
        json_response_requested = _runtime_protocol_requires_json(system_prompt)
        if json_response_requested:
            payload["response_format"] = {"type": "json_object"}
            payload["temperature"] = 0
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        timeout = httpx.Timeout(self.settings.llm_timeout_seconds)
        json_response_enforced = json_response_requested
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            )
            try:
                response.raise_for_status()
            except httpx.HTTPStatusError:
                if json_response_requested and response.status_code in {400, 422}:
                    retry_payload = dict(payload)
                    retry_payload.pop("response_format", None)
                    json_response_enforced = False
                    response = await client.post(
                        f"{self.base_url.rstrip('/')}/chat/completions",
                        headers=headers,
                        json=retry_payload,
                    )
                    response.raise_for_status()
                else:
                    raise
            data = response.json()
        message = data["choices"][0].get("message", {})
        content = message.get("content")
        text = content.strip() if isinstance(content, str) else ""
        empty_content_retry = False
        if not text and self.provider == "nemotron" and message.get("reasoning"):
            empty_content_retry = True
            retry_system = (
                "Return the final answer content only. Do not include reasoning."
                if not json_response_requested
                else "Return only the valid JSON object requested by the runtime protocol. Do not include reasoning."
            )
            retry_payload = dict(payload)
            retry_payload["max_tokens"] = max(int(payload.get("max_tokens") or 0), 384)
            retry_payload["messages"] = [
                {"role": "system", "content": f"/no_think\n{retry_system}\n{system_prompt}"},
                *messages,
            ]
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    f"{self.base_url.rstrip('/')}/chat/completions",
                    headers=headers,
                    json=retry_payload,
                )
                response.raise_for_status()
                data = response.json()
            message = data["choices"][0].get("message", {})
            content = message.get("content")
            text = content.strip() if isinstance(content, str) else ""
        return LLMResult(
            text=text,
            latency_ms=int((time.perf_counter() - start) * 1000),
            model=self.model,
            provider=self.provider,
            raw={
                "usage": data.get("usage", {}),
                "json_response_requested": json_response_requested,
                "json_response_enforced": json_response_enforced,
                "empty_content_retry": empty_content_retry,
                "empty_content": not bool(text),
            },
        )

    async def warmup(self) -> None:
        system = "Reply with OK."
        if self.settings.reasoning_mode == "off":
            system = f"/no_think\n{system}"
        payload = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": "ping"}],
            "temperature": 0,
            "top_p": 1,
            "max_tokens": 1,
            "stream": False,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        timeout = httpx.Timeout(self.settings.llm_timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()


def make_llm_client(settings: Settings) -> LLMClient:
    if settings.llm_provider == "mock":
        return MockLLMClient(settings)
    return OpenAICompatibleLLMClient(settings, settings.llm_provider)
