from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


class CloudVLLMError(RuntimeError):
    pass


class CloudVLLMManager:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._lock = asyncio.Lock()
        self._active_sessions = 0
        self._last_activity = 0.0
        self._idle_stop_task: asyncio.Task | None = None
        self._last_status: str | None = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "enabled": self.settings.cloud_vllm_autostart_enabled,
            "stop_on_idle_enabled": self.settings.cloud_vllm_stop_on_idle_enabled,
            "idle_shutdown_seconds": self.settings.cloud_vllm_idle_shutdown_seconds,
            "active_sessions": self._active_sessions,
            "last_status": self._last_status,
            "instance_name": self.settings.gcp_vllm_instance_name,
            "zone": self.settings.gcp_zone,
            "project_id": self.settings.gcp_project_id,
            "ip_mode": self.settings.cloud_vllm_ip_mode,
            "control_plane": self.settings.cloud_vllm_control_plane,
        }

    async def refreshed_snapshot(self) -> dict[str, Any]:
        if not self.settings.cloud_vllm_autostart_enabled:
            return self.snapshot()
        snapshot = self.snapshot()
        try:
            instance = await self._describe_instance()
            self._last_status = str(instance.get("status") or "UNKNOWN")
            self._update_base_url_from_instance(instance)
            return self.snapshot()
        except Exception as exc:
            snapshot["status_error"] = str(exc)
            return snapshot

    async def health_check(self) -> bool:
        if self.settings.llm_provider != "local" or not self.settings.local_llm_base_url:
            return False
        url = self._health_url()
        headers = {}
        if self.settings.local_llm_api_key:
            headers["Authorization"] = f"Bearer {self.settings.local_llm_api_key}"
        try:
            async with httpx.AsyncClient(timeout=self.settings.cloud_vllm_health_timeout_seconds) as client:
                response = await client.get(url, headers=headers)
            return response.is_success
        except Exception:
            return False

    async def ensure_ready(self) -> None:
        if not self.settings.cloud_vllm_autostart_enabled:
            return
        if self.settings.llm_provider != "local":
            return
        async with self._lock:
            self.touch()
            await self.ensure_instance_running_locked(skip_health_check=True)
            if await self.health_check():
                return
            await self._wait_until_healthy()

    async def ensure_instance_running(self) -> None:
        if not self.settings.cloud_vllm_autostart_enabled:
            return
        async with self._lock:
            self.touch()
            await self.ensure_instance_running_locked()

    async def ensure_instance_running_locked(self, *, skip_health_check: bool = False) -> None:
        if not skip_health_check and self.settings.llm_provider == "local" and await self.health_check():
            return
        instance = await self._describe_instance()
        self._update_base_url_from_instance(instance)
        status = str(instance.get("status") or "UNKNOWN")
        self._last_status = status
        if status in {"TERMINATED", "STOPPED", "SUSPENDED"}:
            await self._start_instance()
        elif status in {"STOPPING", "SUSPENDING"}:
            await self._wait_for_status({"TERMINATED", "STOPPED", "SUSPENDED"})
            await self._start_instance()
        await self._wait_for_status({"RUNNING"})

    def touch(self) -> None:
        self._last_activity = time.monotonic()
        self._schedule_idle_stop()

    def session_started(self) -> None:
        self._last_activity = time.monotonic()
        self._active_sessions += 1
        logger.info("Cloud vLLM session started; active_sessions=%s", self._active_sessions)
        if self._idle_stop_task is not None:
            self._idle_stop_task.cancel()
            self._idle_stop_task = None

    def try_session_started(self, *, max_sessions: int = 1) -> bool:
        if self._active_sessions >= max_sessions:
            logger.warning(
                "Cloud vLLM session rejected; active_sessions=%s max_sessions=%s",
                self._active_sessions,
                max_sessions,
            )
            return False
        self.session_started()
        return True

    def session_finished(self) -> None:
        self._active_sessions = max(0, self._active_sessions - 1)
        self._last_activity = time.monotonic()
        logger.info("Cloud vLLM session finished; active_sessions=%s", self._active_sessions)
        self._schedule_idle_stop()

    async def stop_if_configured_for_shutdown(self) -> None:
        if (
            self.settings.cloud_vllm_autostart_enabled
            and self.settings.cloud_vllm_stop_on_backend_shutdown
            and self.settings.cloud_vllm_stop_on_idle_enabled
        ):
            await self.stop()

    async def stop(self) -> None:
        if not self.settings.cloud_vllm_autostart_enabled:
            return
        async with self._lock:
            if self._active_sessions:
                return
            instance = await self._describe_instance()
            status = str(instance.get("status") or "UNKNOWN")
            self._last_status = status
            if status == "RUNNING":
                logger.info("Stopping idle cloud vLLM instance %s", self.settings.gcp_vllm_instance_name)
                await self._stop_instance()
                self._last_status = "STOPPING"

    def _schedule_idle_stop(self) -> None:
        if (
            not self.settings.cloud_vllm_autostart_enabled
            or not self.settings.cloud_vllm_stop_on_idle_enabled
            or self._active_sessions
        ):
            return
        if self._idle_stop_task is None or self._idle_stop_task.done():
            logger.info(
                "Scheduling cloud vLLM idle stop in %ss",
                self.settings.cloud_vllm_idle_shutdown_seconds,
            )
            self._idle_stop_task = asyncio.create_task(self._idle_stop_after_delay())

    async def _idle_stop_after_delay(self) -> None:
        try:
            await asyncio.sleep(self.settings.cloud_vllm_idle_shutdown_seconds)
            idle_for = time.monotonic() - self._last_activity
            if self._active_sessions == 0 and idle_for >= self.settings.cloud_vllm_idle_shutdown_seconds:
                await self.stop()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Cloud vLLM idle stop failed")

    async def _wait_until_healthy(self) -> None:
        deadline = time.monotonic() + self.settings.cloud_vllm_start_timeout_seconds
        last_error = "vLLM did not pass health checks before timeout."
        while time.monotonic() < deadline:
            instance = await self._describe_instance()
            self._last_status = str(instance.get("status") or "UNKNOWN")
            self._update_base_url_from_instance(instance)
            if self._last_status == "RUNNING" and await self.health_check():
                return
            await asyncio.sleep(self.settings.cloud_vllm_poll_seconds)
        raise CloudVLLMError(last_error)

    async def _wait_for_status(self, statuses: set[str]) -> dict[str, Any]:
        deadline = time.monotonic() + self.settings.cloud_vllm_start_timeout_seconds
        while time.monotonic() < deadline:
            instance = await self._describe_instance()
            status = str(instance.get("status") or "UNKNOWN")
            self._last_status = status
            if status in statuses:
                return instance
            await asyncio.sleep(self.settings.cloud_vllm_poll_seconds)
        raise CloudVLLMError(f"Timed out waiting for {self.settings.gcp_vllm_instance_name}.")

    async def _describe_instance(self) -> dict[str, Any]:
        if self.settings.cloud_vllm_control_plane in {"auto", "metadata"}:
            try:
                return await self._compute_api(
                    "GET",
                    self._instance_api_path(),
                )
            except Exception:
                if self.settings.cloud_vllm_control_plane == "metadata":
                    raise
                logger.debug("Compute API describe failed; falling back to gcloud", exc_info=True)

        output = await self._gcloud(
            "compute",
            "instances",
            "describe",
            self.settings.gcp_vllm_instance_name,
            "--format=json",
        )
        try:
            return json.loads(output)
        except json.JSONDecodeError as exc:
            raise CloudVLLMError("gcloud returned invalid instance JSON.") from exc

    async def _start_instance(self) -> None:
        await self._instance_action("start")

    async def _stop_instance(self) -> None:
        await self._instance_action("stop")

    async def _instance_action(self, action: str) -> None:
        if self.settings.cloud_vllm_control_plane in {"auto", "metadata"}:
            try:
                await self._compute_api("POST", f"{self._instance_api_path()}/{action}")
                return
            except Exception:
                if self.settings.cloud_vllm_control_plane == "metadata":
                    raise
                logger.debug("Compute API instance %s failed; falling back to gcloud", action, exc_info=True)

        await self._gcloud("compute", "instances", action, self.settings.gcp_vllm_instance_name)

    def _instance_api_path(self) -> str:
        if not self.settings.gcp_project_id:
            raise CloudVLLMError("Set GCP_PROJECT_ID before enabling cloud VM auto-start.")
        return (
            f"https://compute.googleapis.com/compute/v1/projects/{self.settings.gcp_project_id}"
            f"/zones/{self.settings.gcp_zone}/instances/{self.settings.gcp_vllm_instance_name}"
        )

    async def _compute_api(self, method: str, url: str) -> dict[str, Any]:
        token = await self._metadata_access_token()
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.request(
                    method,
                    url,
                    headers={"Authorization": f"Bearer {token}"},
                )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as exc:
            body = exc.response.text.strip()
            if len(body) > 300:
                body = f"{body[:300]}..."
            raise CloudVLLMError(
                f"Compute API {method} failed: HTTP {exc.response.status_code} {body}"
            ) from exc
        except Exception as exc:
            if isinstance(exc, CloudVLLMError):
                raise
            raise CloudVLLMError(f"Compute API {method} failed: {exc}") from exc

    async def _metadata_access_token(self) -> str:
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                response = await client.get(
                    "http://metadata.google.internal/computeMetadata/v1/instance/"
                    "service-accounts/default/token",
                    headers={"Metadata-Flavor": "Google"},
                )
            response.raise_for_status()
            payload = response.json()
            token = payload.get("access_token")
            if isinstance(token, str) and token:
                return token
        except Exception as exc:
            raise CloudVLLMError(f"GCE metadata token is unavailable: {exc}") from exc
        raise CloudVLLMError("GCE metadata token response did not include access_token.")

    async def _gcloud(self, *args: str) -> str:
        if not self.settings.gcp_project_id:
            raise CloudVLLMError("Set GCP_PROJECT_ID before enabling cloud VM auto-start.")
        command = [
            self.settings.cloud_vllm_gcloud_command,
            *args,
            "--project",
            self.settings.gcp_project_id,
            "--zone",
            self.settings.gcp_zone,
            "--quiet",
        ]
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise CloudVLLMError("gcloud is not installed or not on PATH.") from exc
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            message = stderr.decode("utf-8", errors="replace").strip() or "gcloud command failed."
            raise CloudVLLMError(message)
        return stdout.decode("utf-8", errors="replace")

    def _health_url(self) -> str:
        base = self.settings.local_llm_base_url.rstrip("/")
        path = self.settings.cloud_vllm_health_path
        if not path.startswith("/"):
            path = f"/{path}"
        return f"{base}{path}"

    def _update_base_url_from_instance(self, instance: dict[str, Any]) -> None:
        if self.settings.cloud_vllm_ip_mode == "configured":
            return
        replacement_ip = self._instance_ip(instance, self.settings.cloud_vllm_ip_mode)
        if not replacement_ip:
            return
        current = self.settings.local_llm_base_url
        parsed = urlsplit(current)
        port = parsed.port or 5000
        netloc = f"{replacement_ip}:{port}"
        self.settings.local_llm_base_url = urlunsplit(
            (parsed.scheme or "http", netloc, parsed.path or "/v1", "", "")
        )

    @staticmethod
    def _instance_ip(instance: dict[str, Any], mode: str) -> str | None:
        interfaces = instance.get("networkInterfaces") or []
        if not interfaces:
            return None
        interface = interfaces[0]
        if mode == "internal":
            ip = interface.get("networkIP")
            return str(ip) if ip else None
        access_configs = interface.get("accessConfigs") or []
        if not access_configs:
            return None
        ip = access_configs[0].get("natIP")
        return str(ip) if ip else None
