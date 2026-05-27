from __future__ import annotations

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
    """Deterministic local client for development, CI, and no-credit eval runs."""

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


class OpenAICompatibleLLMClient:
    def __init__(self, settings: Settings, provider: str) -> None:
        self.settings = settings
        self.provider = provider
        self.base_url = settings.active_base_url
        self.api_key = settings.active_api_key
        self.model = settings.active_model
        if not self.base_url:
            raise ValueError("OpenAI-compatible provider requires a base URL.")
        if not self.api_key:
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
        if self.provider == "ollama" and self.settings.ollama_keep_alive:
            payload["keep_alive"] = self.settings.ollama_keep_alive
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        timeout = httpx.Timeout(self.settings.llm_timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()
            data = response.json()
        text = data["choices"][0]["message"]["content"].strip()
        return LLMResult(
            text=text,
            latency_ms=int((time.perf_counter() - start) * 1000),
            model=self.model,
            provider=self.provider,
            raw={"usage": data.get("usage", {})},
        )

    async def warmup(self) -> None:
        if self.provider not in {"ollama", "local"}:
            return
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
        if self.provider == "ollama" and self.settings.ollama_keep_alive:
            payload["keep_alive"] = self.settings.ollama_keep_alive
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        timeout = httpx.Timeout(self.settings.llm_timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json=payload,
            )
            response.raise_for_status()


class VertexNIMLLMClient:
    """OpenAI-shaped chat client for NVIDIA NIM deployed behind Vertex AI rawPredict."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.provider = "vertex_nim"
        self.model = settings.vertex_nim_model
        self.endpoint_url = self._endpoint_url(settings)

    def _endpoint_url(self, settings: Settings) -> str:
        if settings.vertex_nim_endpoint_url:
            return settings.vertex_nim_endpoint_url.rstrip("/")
        if not settings.vertex_nim_project:
            raise ValueError("vertex_nim provider requires VERTEX_NIM_PROJECT.")
        if not settings.vertex_nim_endpoint_id:
            raise ValueError("vertex_nim provider requires VERTEX_NIM_ENDPOINT_ID.")
        return (
            f"https://{settings.vertex_nim_region}-aiplatform.googleapis.com/v1/"
            f"projects/{settings.vertex_nim_project}/locations/{settings.vertex_nim_region}/"
            f"endpoints/{settings.vertex_nim_endpoint_id}:rawPredict"
        )

    async def _access_token(self) -> str:
        import google.auth
        from google.auth.transport.requests import Request

        credentials, _project = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        credentials.refresh(Request())
        return credentials.token

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
        token = await self._access_token()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        timeout = httpx.Timeout(self.settings.llm_timeout_seconds)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(self.endpoint_url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
        text = data["choices"][0]["message"]["content"].strip()
        return LLMResult(
            text=text,
            latency_ms=int((time.perf_counter() - start) * 1000),
            model=self.model,
            provider=self.provider,
            raw={"usage": data.get("usage", {}), "endpoint_url": self.endpoint_url},
        )

    async def warmup(self) -> None:
        system = "Reply with OK."
        if self.settings.reasoning_mode == "off":
            system = f"/no_think\n{system}"
        await self.generate([{"role": "user", "content": "ping"}], system)


def make_llm_client(settings: Settings) -> LLMClient:
    if settings.llm_provider == "mock":
        return MockLLMClient(settings)
    if settings.llm_provider == "vertex_nim":
        return VertexNIMLLMClient(settings)
    return OpenAICompatibleLLMClient(settings, settings.llm_provider)
