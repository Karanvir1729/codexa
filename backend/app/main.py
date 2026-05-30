from __future__ import annotations

import asyncio
import importlib.util
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import AliasChoices, BaseModel, Field

from .agent import AgentService
from .cekura import (
    assert_cekura_secret,
    build_cekura_agent_message,
    cekura_context_from_headers,
    cekura_conversation_id,
    cleanup_cekura_state,
    parse_result_webhook_run_ids,
    record_cekura_result,
    seed_cekura_state,
)
from .cloud_vm import CloudVLLMError, CloudVLLMManager
from .config import (
    Settings,
    get_settings,
    mainstream_voice_path_errors,
    require_mainstream_voice_path,
    settings_for_speech_path,
)
from .codex_orchestrator import CodexOrchestratorBridge
from .cost_guard import CostGuard, CostLimitExceeded
from .db import Database, dumps, loads
from .eval_scheduler import EvalScheduler
from .evaluator import EvalRunner
from .feedback import FeedbackLearner, PromptRepository
from .flow_runtime import FlowRepository, FlowRuntime, flow_summary, validate_flow_graph
from .llm import make_llm_client
from .local_voice_runtime import require_openai_compatible_llm, run_browser_pipecat_voice_agent
from .pipecat_runtime import run_pipecat_twilio_bot
from .training_data import export_sft_jsonl
from .twilio_routes import error_twiml, inbound_twiml, no_input_twiml, pending_twiml, twilio_conversation_id, voice_turn_twiml
from .voice_self_observe import load_runtime_profile
from .voice_text_test import build_voice_text_tts_payload, run_voice_text_suite, run_voice_text_turn
from .webrtc_sessions import is_known_webrtc_peer


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    conversation_id: str | None = None
    channel: str = "web"
    caller: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class FeedbackRequest(BaseModel):
    conversation_id: str
    turn_id: str | None = None
    rating: int = Field(ge=1, le=5)
    label: str = Field(min_length=1)
    notes: str | None = None


class EvalRunRequest(BaseModel):
    suite_path: str = "backend/evals/conversational_voice.yml"
    apply_feedback: bool = True


class ExportTrainingDataRequest(BaseModel):
    output_path: str = "data/sft/voice-agent-feedback.jsonl"


class EvalSchedulerRequest(BaseModel):
    interval_seconds: int = Field(default=300, ge=10)
    suite_path: str | None = None
    apply_feedback: bool | None = None


class SelfLearnConfigRequest(BaseModel):
    enabled: bool | None = None
    factor: float | None = Field(default=None, ge=0, le=1)


class VoicePrepareRequest(BaseModel):
    voice_speech_path: str | None = None


class VoiceTextTurnRequest(BaseModel):
    message: str = Field(min_length=1, validation_alias=AliasChoices("message", "text"))
    conversation_id: str | None = None
    voice_behavior_mode: str | None = None
    voice_flow_id: str | None = None
    voice_speech_path: str | None = None
    input_mode: str = "push_to_talk"
    force_interrupt: bool = False
    flow_run_id: str | None = None


class VoiceTextAudioRequest(BaseModel):
    text: str = Field(min_length=1)
    voice_speech_path: str | None = None
    user_text: str | None = None


class VoiceTextSuiteCase(BaseModel):
    id: str | None = None
    message: str = Field(min_length=1)
    voice_behavior_mode: str | None = None
    voice_flow_id: str | None = None
    input_mode: str | None = None
    force_interrupt: bool = False
    flow_run_id: str | None = None
    expect_contains: list[str] = Field(default_factory=list)
    expect_not_contains: list[str] = Field(default_factory=list)
    expect_min_words: int | None = Field(default=None, ge=1)
    expect_runtime_action: bool = False
    expect_active_node_id: str | None = None


class VoiceTextSuiteRequest(BaseModel):
    conversation_id: str | None = None
    voice_behavior_mode: str | None = None
    voice_flow_id: str | None = None
    voice_speech_path: str | None = None
    input_mode: str = "push_to_talk"
    cases: list[VoiceTextSuiteCase] | None = None


class CekuraHookRequest(BaseModel):
    run_id: str | None = None
    scenario_id: str | None = None
    result_id: str | None = None
    conversation_id: str | None = None
    reset_runtime_profile: bool = True
    all_cekura: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class TwilioConfigureRequest(BaseModel):
    phone_number_sid: str | None = None
    voice_url: str | None = None
    status_callback_url: str | None = None


class FlowCreateRequest(BaseModel):
    name: str = Field(default="Untitled voice flow", min_length=1)
    description: str = ""


class FlowUpdateRequest(BaseModel):
    name: str = Field(min_length=1)
    description: str = ""
    graph: dict[str, Any]


class FlowValidateRequest(BaseModel):
    graph: dict[str, Any]


class FlowSimulateRequest(BaseModel):
    message: str | None = None
    run_id: str | None = None
    force_interrupt: bool = False
    conversation_id: str | None = None


settings: Settings = get_settings()
REPO_ROOT = Path(__file__).resolve().parents[2]
logger = logging.getLogger(__name__)


def resolve_repo_path(path: str) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    repo_candidate = REPO_ROOT / candidate
    if repo_candidate.exists():
        return repo_candidate
    backend_candidate = REPO_ROOT / "backend" / candidate
    if backend_candidate.exists():
        return backend_candidate
    return repo_candidate


db = Database(settings.database_path)
prompt_repo = PromptRepository(db)
learner = FeedbackLearner(db, prompt_repo, settings.latency_target_ms)
cost_guard = CostGuard(db, settings)
agent = AgentService(db, settings, make_llm_client(settings), cost_guard)
twilio_pending_turns: dict[str, asyncio.Task[dict[str, Any]]] = {}
flow_repo = FlowRepository(db)
flow_runtime = FlowRuntime(db, flow_repo, make_llm_client(settings), settings)
eval_runner = EvalRunner(db, agent, learner)
eval_scheduler = EvalScheduler(
    eval_runner,
    resolve_repo_path,
    settings.eval_suite_path,
    settings.eval_schedule_seconds,
    settings.eval_schedule_apply_feedback,
)
cloud_vllm_manager = CloudVLLMManager(settings)
small_webrtc_handler = None
browser_voice_tasks: set[asyncio.Task] = set()
browser_voice_watchdogs: set[asyncio.Task] = set()
active_browser_voice_sessions: set[str] = set()


async def clear_stale_browser_voice_sessions(reason: str) -> None:
    for done_task in tuple(browser_voice_tasks):
        if done_task.done():
            browser_voice_tasks.discard(done_task)
    if browser_voice_tasks:
        logger.warning(
            "Cancelling %s existing browser voice task(s) before starting a new session: %s",
            len(browser_voice_tasks),
            reason,
        )
        tasks = tuple(browser_voice_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.wait(tasks, timeout=2)
        await asyncio.sleep(0)
        for done_task in tuple(browser_voice_tasks):
            if done_task.done():
                browser_voice_tasks.discard(done_task)
    if not browser_voice_tasks and active_browser_voice_sessions:
        logger.warning(
            "Clearing stale browser voice session reservation(s) before starting a new session: %s",
            reason,
        )
        active_browser_voice_sessions.clear()
        cloud_vllm_manager.session_finished()


def is_small_webrtc_renegotiating(connection: object) -> bool:
    return bool(getattr(connection, "_renegotiation_in_progress", False))

app = FastAPI(title="Voice Agent Feedback Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def start_background_services() -> None:
    cloud_vllm_manager.touch()
    if settings.llm_warmup_enabled:
        async def warmup_model() -> None:
            try:
                await agent.warmup_llm()
            except Exception:
                logger.debug("LLM warmup failed", exc_info=True)

        asyncio.create_task(warmup_model())
    if settings.eval_schedule_seconds > 0:
        await eval_scheduler.start(settings.eval_schedule_seconds)


@app.on_event("shutdown")
async def stop_background_services() -> None:
    await eval_scheduler.stop()
    if small_webrtc_handler is not None:
        await small_webrtc_handler.close()
    for task in tuple(browser_voice_tasks):
        task.cancel()
    for task in tuple(browser_voice_watchdogs):
        task.cancel()
    if browser_voice_tasks:
        await asyncio.gather(*browser_voice_tasks, return_exceptions=True)
    if browser_voice_watchdogs:
        await asyncio.gather(*browser_voice_watchdogs, return_exceptions=True)
    await cloud_vllm_manager.stop_if_configured_for_shutdown()


@app.exception_handler(CostLimitExceeded)
async def cost_limit_handler(_request: Request, exc: CostLimitExceeded) -> Response:
    return Response(
        content=dumps(
            {
                "detail": str(exc),
                "cost_guard": exc.snapshot.to_dict(),
                "attempted_usd": round(exc.attempted_usd, 6),
            }
        ),
        status_code=402,
        media_type="application/json",
    )


@app.get("/health")
async def health() -> dict[str, Any]:
    prompt = prompt_repo.active()
    voice_settings = settings_for_speech_path(settings, settings.voice_speech_path)
    mainstream_errors = mainstream_voice_path_errors(voice_settings)
    return {
        "status": "ok",
        "environment": settings.app_env,
        "llm_provider": voice_settings.llm_provider,
        "model": voice_settings.active_model,
        "vertex_nim_region": settings.vertex_nim_region
        if settings.llm_provider == "vertex_nim"
        else None,
        "vertex_nim_endpoint_id": settings.vertex_nim_endpoint_id
        if settings.llm_provider == "vertex_nim"
        else None,
        "voice_runtime": settings.voice_runtime,
        "voice_behavior_mode": settings.voice_behavior_mode,
        "voice_flow_id": settings.voice_flow_id,
        "voice_speech_path": voice_settings.voice_speech_path,
        "voice_emotion_codes_enabled": voice_settings.voice_emotion_codes_enabled,
        "local_stt_provider": voice_settings.local_stt_provider,
        "local_stt_model": voice_settings.local_stt_model,
        "local_stt_effective_model": voice_settings.local_stt_model,
        "local_tts_provider": voice_settings.local_tts_provider,
        "local_tts_voice": voice_settings.local_tts_voice,
        "local_tts_text_aggregation_mode": voice_settings.local_tts_text_aggregation_mode,
        "codex_orchestrator_enabled": settings.codex_orchestrator_enabled,
        "codex_orchestrator_base_url": settings.codex_orchestrator_base_url,
        "voice_mainstream_ready": not mainstream_errors,
        "voice_mainstream_reasons": mainstream_errors,
        "voice_mainstream": {
            "ready": not mainstream_errors,
            "reasons": mainstream_errors,
            "voice_speech_path": voice_settings.voice_speech_path,
            "voice_runtime": voice_settings.voice_runtime,
            "configured_stt_provider": voice_settings.local_stt_provider,
            "configured_stt_model": voice_settings.local_stt_model,
            "configured_tts_provider": voice_settings.local_tts_provider,
            "configured_tts_language": voice_settings.gradium_vad_language,
            "codex_orchestrator_enabled": settings.codex_orchestrator_enabled,
        },
        "twilio": {
            "ready": bool(
                settings.twilio_account_sid
                and settings.twilio_auth_token
                and settings.twilio_effective_from_number
            ),
            "voice_mode": settings.twilio_voice_mode,
            "voice_webhook_url": settings.twilio_effective_voice_webhook_url,
            "signature_validation": settings.twilio_should_validate_signature,
        },
        "webrtc_ice_servers": len(voice_settings.small_webrtc_browser_ice_servers),
        "voxtral_tts_model": voice_settings.voxtral_tts_model
        if voice_settings.local_tts_provider == "voxtral"
        else None,
        "voxtral_tts_ref_audio_enabled": voice_settings.voxtral_tts_ref_audio_enabled
        if voice_settings.local_tts_provider == "voxtral"
        else None,
        "prompt_version": prompt.version,
        "reasoning_mode": settings.reasoning_mode,
        "max_completion_tokens": settings.max_completion_tokens,
        "cost_guard": cost_guard.snapshot().to_dict(),
        "cloud_vllm": await cloud_vllm_manager.refreshed_snapshot(),
    }


@app.get("/api/config")
async def config() -> dict[str, Any]:
    voice_settings = settings_for_speech_path(settings, settings.voice_speech_path)
    return {
        "llm_provider": voice_settings.llm_provider,
        "model": voice_settings.active_model,
        "base_url": voice_settings.active_base_url,
        "vertex_nim_region": settings.vertex_nim_region
        if settings.llm_provider == "vertex_nim"
        else None,
        "vertex_nim_endpoint_id": settings.vertex_nim_endpoint_id
        if settings.llm_provider == "vertex_nim"
        else None,
        "voice_runtime": settings.voice_runtime,
        "voice_behavior_mode": settings.voice_behavior_mode,
        "voice_flow_id": settings.voice_flow_id,
        "voice_speech_path": voice_settings.voice_speech_path,
        "voice_emotion_codes_enabled": voice_settings.voice_emotion_codes_enabled,
        "local_stt_provider": voice_settings.local_stt_provider,
        "local_stt_model": voice_settings.local_stt_model,
        "local_stt_effective_model": voice_settings.local_stt_model,
        "local_tts_provider": voice_settings.local_tts_provider,
        "local_tts_text_aggregation_mode": voice_settings.local_tts_text_aggregation_mode,
        "webrtc_ice_servers": len(voice_settings.small_webrtc_browser_ice_servers),
        "voxtral_tts_model": voice_settings.voxtral_tts_model
        if voice_settings.local_tts_provider == "voxtral"
        else None,
        "max_completion_tokens": settings.max_completion_tokens,
        "twilio_ready": bool(
            settings.twilio_account_sid
            and settings.twilio_auth_token
            and settings.twilio_effective_from_number
        ),
        "twilio_voice_mode": settings.twilio_voice_mode,
        "twilio_phone_number_configured": bool(settings.twilio_effective_from_number),
        "twilio_voice_webhook_url": settings.twilio_effective_voice_webhook_url,
        "pipecat_cloud_ready": bool(settings.pipecat_cloud_ws_url and settings.pipecat_cloud_service_host),
        "cost_guard": cost_guard.snapshot().to_dict(),
        "cloud_vllm": await cloud_vllm_manager.refreshed_snapshot(),
    }


def _small_webrtc_ice_servers():
    from pipecat.transports.smallwebrtc.connection import IceServer

    return [
        IceServer(
            urls=server["urls"],
            username=server.get("username"),
            credential=server.get("credential"),
        )
        for server in settings.small_webrtc_browser_ice_servers
    ]


@app.get("/api/webrtc/ice-config")
async def webrtc_ice_config() -> dict[str, Any]:
    return {"iceServers": settings.small_webrtc_browser_ice_servers}


async def check_supertonic_http(settings: Settings) -> tuple[bool, str]:
    base = settings.supertonic_base_url.rstrip("/")
    urls = [f"{base}/v1/health", f"{base}/v1/styles", f"{base}/docs"]
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(2.0, connect=1.0)) as client:
            last_status = 0
            for url in urls:
                response = await client.get(url)
                last_status = response.status_code
                if response.status_code == 200:
                    return True, "Supertonic server is healthy."
        return False, f"Supertonic health returned HTTP {last_status} at {urls[-1]}."
    except Exception as exc:
        return False, f"Supertonic is not reachable at {base}: {exc}"


async def check_voice_dependencies(
    runtime_settings: Settings | None = None,
    *,
    allow_autostartable_down: bool = True,
) -> tuple[bool, list[str], list[str], dict[str, Any]]:
    active_settings = runtime_settings or settings
    ready = True
    reasons: list[str] = []
    warnings: list[str] = []
    status: dict[str, Any] = {
        "stt": {
            "provider": active_settings.local_stt_provider,
            "healthy": None,
        },
        "tts": {
            "provider": active_settings.local_tts_provider,
            "healthy": None,
        },
        "vad": {
            "provider": "gradium"
            if active_settings.local_tts_provider == "gradium"
            else "silero",
            "healthy": None,
        },
    }

    if active_settings.local_stt_provider == "nvidia_ws":
        status["stt"].update(
            {
                "healthy": bool(active_settings.nvidia_asr_url),
                "health_url": active_settings.nvidia_asr_url,
                "model": active_settings.local_stt_model,
            }
        )
        if not active_settings.nvidia_asr_url:
            ready = False
            reasons.append("NVIDIA_ASR_URL is required.")

    if active_settings.local_tts_provider == "gradium":
        status["tts"].update(
            {
                "healthy": bool(active_settings.gradium_api_key),
                "health_url": active_settings.gradium_tts_ws_url,
                "model": active_settings.gradium_tts_model,
                "voice_id": active_settings.gradium_tts_voice_id,
            }
        )
        status["vad"].update(
            {
                "healthy": bool(active_settings.gradium_api_key),
                "health_url": active_settings.gradium_vad_ws_url,
                "model": active_settings.gradium_vad_model,
            }
        )
        if not active_settings.gradium_api_key:
            ready = False
            reasons.append("GRADIUM_API_KEY is required for Gradium VAD/TTS.")

    if active_settings.local_stt_provider == "remote_whisper":
        health_url = f"{active_settings.remote_whisper_base_url.rstrip('/')}/health"
        status["stt"]["health_url"] = health_url
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                response = await client.get(health_url)
            response.raise_for_status()
            status["stt"]["healthy"] = True
        except Exception as exc:
            status["stt"]["healthy"] = False
            if active_settings.cloud_vllm_autostart_enabled and allow_autostartable_down:
                warnings.append("Remote Whisper is down now; it will be checked again after VM start.")
            else:
                ready = False
                reasons.append(
                    f"Remote Whisper STT is not reachable at {health_url}. "
                    "Start the speech VM/service or choose a local STT provider before presenting."
                )
            status["stt"]["error"] = str(exc)

    if active_settings.local_stt_provider == "openrouter":
        models_url = f"{active_settings.openrouter_base_url.rstrip('/')}/models"
        requested_model = active_settings.openrouter_stt_model or active_settings.local_stt_model
        status["stt"]["health_url"] = models_url
        status["stt"]["model"] = requested_model
        if not active_settings.openrouter_api_key:
            ready = False
            status["stt"]["healthy"] = False
            reasons.append("OpenRouter STT requires OPENROUTER_API_KEY.")
        else:
            try:
                headers = {"Authorization": f"Bearer {active_settings.openrouter_api_key}"}
                async with httpx.AsyncClient(timeout=5) as client:
                    response = await client.get(
                        models_url,
                        params={"output_modalities": "transcription"},
                        headers=headers,
                    )
                response.raise_for_status()
                model_ids = {
                    str(model.get("id"))
                    for model in response.json().get("data", [])
                    if isinstance(model, dict) and model.get("id")
                }
                status["stt"]["model_available"] = requested_model in model_ids
                if requested_model not in model_ids:
                    ready = False
                    status["stt"]["healthy"] = False
                    reasons.append(
                        f"OpenRouter STT model {requested_model} is not listed as available "
                        "for transcription."
                    )
                else:
                    status["stt"]["healthy"] = True
            except Exception as exc:
                ready = False
                status["stt"]["healthy"] = False
                reasons.append(
                    f"OpenRouter STT is not reachable at {models_url} or the key is invalid."
                )
                status["stt"]["error"] = str(exc)

    if active_settings.local_stt_provider == "parakeet":
        status["stt"]["health_url"] = active_settings.parakeet_server
        if not (active_settings.parakeet_api_key or active_settings.nvidia_api_key):
            ready = False
            status["stt"]["healthy"] = False
            reasons.append("Parakeet STT requires PARAKEET_API_KEY or NVIDIA_API_KEY.")
        elif importlib.util.find_spec("riva") is None:
            ready = False
            status["stt"]["healthy"] = False
            reasons.append(
                "Parakeet STT requires NVIDIA Riva client dependencies. "
                'Run: .venv/bin/python -m pip install "pipecat-ai[nvidia]".'
            )
        else:
            status["stt"]["healthy"] = True

    if active_settings.local_tts_provider == "voxtral":
        health_url = f"{active_settings.voxtral_tts_base_url.rstrip('/')}/models"
        status["tts"]["health_url"] = health_url
        try:
            async with httpx.AsyncClient(timeout=2) as client:
                response = await client.get(health_url)
            response.raise_for_status()
            status["tts"]["healthy"] = True
        except Exception as exc:
            status["tts"]["healthy"] = False
            if active_settings.cloud_vllm_autostart_enabled and allow_autostartable_down:
                warnings.append("Voxtral TTS is down now; it will be checked again after VM start.")
            else:
                ready = False
                reasons.append(
                    f"Voxtral TTS is not reachable at {health_url}. "
                    "Start the speech VM/service or choose another TTS provider before presenting."
                )
            status["tts"]["error"] = str(exc)

    if active_settings.local_tts_provider == "supertonic":
        health_url = f"{active_settings.supertonic_base_url.rstrip('/')}/v1/health"
        status["tts"]["health_url"] = health_url
        healthy, detail = await check_supertonic_http(active_settings)
        status["tts"]["healthy"] = healthy
        if not healthy:
            ready = False
            reasons.append(
                f"{detail} Start it with: supertonic serve --host 127.0.0.1 --port 7788"
            )
            status["tts"]["error"] = detail

    if active_settings.local_tts_provider in {"cartesia"} and not active_settings.cartesia_api_key:
        ready = False
        reasons.append("LOCAL_TTS_PROVIDER=cartesia requires CARTESIA_API_KEY.")
    if active_settings.local_tts_provider in {"deepgram"} and not active_settings.deepgram_api_key:
        ready = False
        reasons.append("LOCAL_TTS_PROVIDER=deepgram requires DEEPGRAM_API_KEY.")
    if active_settings.local_tts_provider in {"nvidia"} and not active_settings.nvidia_api_key:
        ready = False
        reasons.append("LOCAL_TTS_PROVIDER=nvidia requires NVIDIA_API_KEY.")

    return ready, reasons, warnings, status


async def check_codexa_dependency(active_settings: Settings) -> tuple[bool, str | None, dict[str, Any]]:
    base_url = active_settings.codex_orchestrator_base_url.rstrip("/")
    status: dict[str, Any] = {
        "provider": "codexa",
        "healthy": None,
        "health_url": f"{base_url}/health",
    }
    if not active_settings.codex_orchestrator_enabled:
        status["healthy"] = False
        status["error"] = "CODEX_ORCHESTRATOR_ENABLED is false."
        return False, "Codexa orchestration is disabled. Set CODEX_ORCHESTRATOR_ENABLED=true.", status

    healthy = await CodexOrchestratorBridge(db, active_settings).health()
    status["healthy"] = healthy
    if healthy:
        return True, None, status
    status["error"] = f"Codexa is not reachable at {base_url}."
    return False, f"Codexa is not reachable at {base_url}. Start the Codexa backend first.", status


async def require_codexa_dependency(active_settings: Settings) -> dict[str, Any]:
    ready, reason, status = await check_codexa_dependency(active_settings)
    if not ready:
        raise CloudVLLMError(reason or "Codexa orchestration is not ready.")
    return status


async def wait_for_voice_dependencies(runtime_settings: Settings | None = None) -> dict[str, Any]:
    active_settings = runtime_settings or settings
    deadline = asyncio.get_running_loop().time() + active_settings.cloud_vllm_start_timeout_seconds
    should_wait_for_vm_services = (
        active_settings.llm_provider == "local" and active_settings.cloud_vllm_autostart_enabled
    )
    while True:
        ready, reasons, _warnings, status = await check_voice_dependencies(
            active_settings,
            allow_autostartable_down=False
        )
        if ready:
            return status
        if not should_wait_for_vm_services or asyncio.get_running_loop().time() >= deadline:
            raise CloudVLLMError(" ".join(reasons))
        await asyncio.sleep(active_settings.cloud_vllm_poll_seconds)


async def prepare_llm_runtime(runtime_settings: Settings) -> None:
    if runtime_settings.llm_provider == "nemotron":
        if not runtime_settings.nemotron_llm_url:
            raise CloudVLLMError("NEMOTRON_LLM_URL is required.")
        if not runtime_settings.nemotron_llm_model:
            raise CloudVLLMError("NEMOTRON_LLM_MODEL is required.")
        return
    if runtime_settings.llm_provider != "local":
        return
    if runtime_settings.cloud_vllm_autostart_enabled:
        await cloud_vllm_manager.ensure_instance_running()
        await cloud_vllm_manager.ensure_ready()
        cloud_vllm_manager.touch()
        return
    if not await cloud_vllm_manager.health_check():
        raise CloudVLLMError(
            "LOCAL_LLM_BASE_URL is not reachable. Start the local LLM endpoint or enable "
            "CLOUD_VLLM_AUTOSTART_ENABLED=true."
        )


@app.get("/api/voice/preflight")
async def voice_preflight(voice_speech_path: str | None = None) -> dict[str, Any]:
    try:
        runtime_settings = settings_for_speech_path(settings, voice_speech_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    ready = True
    reasons: list[str] = []
    warnings: list[str] = []
    llm_endpoint_healthy: bool | None = None

    mainstream_errors = mainstream_voice_path_errors(runtime_settings)
    if mainstream_errors:
        ready = False
        reasons.extend(mainstream_errors)

    try:
        require_openai_compatible_llm(runtime_settings)
    except RuntimeError as exc:
        ready = False
        reasons.append(str(exc))

    if runtime_settings.voice_runtime != "local_pipecat":
        warnings.append("VOICE_RUNTIME is not local_pipecat; browser voice will use local Pipecat anyway.")

    if importlib.util.find_spec("pipecat") is None:
        ready = False
        reasons.append(
            "Pipecat WebRTC dependencies are not installed. "
            'Run: .venv/bin/python -m pip install -e "backend[voice]".'
        )

    if runtime_settings.llm_provider == "local" and runtime_settings.active_base_url:
        llm_endpoint_healthy = await cloud_vllm_manager.health_check()
        if not llm_endpoint_healthy:
            if runtime_settings.cloud_vllm_autostart_enabled:
                if not runtime_settings.gcp_project_id:
                    ready = False
                    reasons.append("Set GCP_PROJECT_ID before enabling cloud VM auto-start.")
                else:
                    warnings.append("The local LLM endpoint is down; the GCP vLLM VM will start on Connect.")
            else:
                ready = False
                reasons.append(
                    "LOCAL_LLM_BASE_URL is not reachable. Start the vLLM/Ollama endpoint or enable "
                    "CLOUD_VLLM_AUTOSTART_ENABLED=true."
                )

    dependencies_ready, dependency_reasons, dependency_warnings, dependency_status = (
        await check_voice_dependencies(runtime_settings)
    )
    if not dependencies_ready:
        ready = False
        reasons.extend(dependency_reasons)
    warnings.extend(dependency_warnings)

    codexa_ready, codexa_reason, codexa_status = await check_codexa_dependency(runtime_settings)
    dependency_status["codex"] = codexa_status
    if not codexa_ready:
        ready = False
        if codexa_reason:
            reasons.append(codexa_reason)

    return {
        "ready": ready,
        "reasons": reasons,
        "warnings": warnings,
        "llm_endpoint_healthy": llm_endpoint_healthy,
        "dependencies": dependency_status,
        "voice_runtime": runtime_settings.voice_runtime,
        "voice_speech_path": runtime_settings.voice_speech_path,
        "llm_provider": runtime_settings.llm_provider,
        "model": runtime_settings.active_model,
        "cloud_vllm": await cloud_vllm_manager.refreshed_snapshot(),
    }


@app.post("/api/voice/prepare")
async def voice_prepare(payload: VoicePrepareRequest | None = None) -> dict[str, Any]:
    try:
        runtime_settings = settings_for_speech_path(settings, payload.voice_speech_path if payload else None)
        require_mainstream_voice_path(runtime_settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        require_openai_compatible_llm(runtime_settings)
        await prepare_llm_runtime(runtime_settings)
        dependency_status = await wait_for_voice_dependencies(runtime_settings)
        dependency_status["codex"] = await require_codexa_dependency(runtime_settings)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CloudVLLMError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "ready": True,
        "llm_endpoint_healthy": await cloud_vllm_manager.health_check()
        if runtime_settings.llm_provider == "local"
        else None,
        "dependencies": dependency_status,
        "voice_speech_path": runtime_settings.voice_speech_path,
        "cloud_vllm": await cloud_vllm_manager.refreshed_snapshot(),
    }


@app.get("/api/voice/runtime-profile")
async def voice_runtime_profile() -> dict[str, Any]:
    profile = load_runtime_profile(db, settings)
    rows = db.all(
        """
        SELECT created_at, payload_json
        FROM interaction_events
        WHERE event = 'interaction_learning_log'
        ORDER BY created_at DESC
        LIMIT 10
        """
    )
    learning_logs = [
        {"created_at": row["created_at"], "record": loads(row["payload_json"], {})}
        for row in rows
    ]
    return {
        "profile": profile,
        "recent_learning_logs": learning_logs,
    }


@app.post("/api/voice/text-test/turn")
async def voice_text_test_turn(payload: VoiceTextTurnRequest) -> dict[str, Any]:
    runtime_settings = settings_for_speech_path(settings, payload.voice_speech_path)
    try:
        return await run_voice_text_turn(
            message=payload.message,
            conversation_id=payload.conversation_id,
            settings=runtime_settings,
            db=db,
            prompt_repo=prompt_repo,
            agent=agent,
            flow_runtime=flow_runtime,
            voice_behavior_mode=payload.voice_behavior_mode,
            voice_flow_id=payload.voice_flow_id,
            input_mode=payload.input_mode,
            force_interrupt=payload.force_interrupt,
            flow_run_id=payload.flow_run_id,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Flow or run not found.") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/voice/text-test/audio")
async def voice_text_test_audio(payload: VoiceTextAudioRequest) -> Response:
    runtime_settings = settings_for_speech_path(settings, payload.voice_speech_path)
    profile = load_runtime_profile(db, runtime_settings)
    try:
        tts_payload, rendered = build_voice_text_tts_payload(
            runtime_settings,
            profile,
            payload.text,
            user_text=payload.user_text or "",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if runtime_settings.local_tts_provider == "gradium":
        try:
            from .gradium_voice import synthesize_gradium_tts

            audio, tts_metadata = await synthesize_gradium_tts(
                runtime_settings,
                str(tts_payload["text"]),
                output_format="wav",
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail=f"Gradium TTS failed: {exc}") from exc

        if not audio:
            raise HTTPException(status_code=502, detail="Gradium TTS returned an empty audio response.")

        return Response(
            content=audio,
            media_type="audio/wav",
            headers={
                "X-TTS-Provider": runtime_settings.local_tts_provider,
                "X-TTS-Voice": str(tts_metadata.get("voice_id") or ""),
                "X-TTS-Speed": str(tts_metadata.get("speed") or ""),
                "X-TTS-Expression-Tags": ",".join(
                    str(tag) for tag in rendered.get("expression_tags_used") or []
                ),
            },
        )

    endpoint = runtime_settings.supertonic_endpoint
    endpoint = endpoint if endpoint.startswith("/") else f"/{endpoint}"
    url = f"{runtime_settings.supertonic_base_url.rstrip('/')}{endpoint}"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(runtime_settings.supertonic_timeout_seconds, connect=5)
        ) as client:
            response = await client.post(url, json=tts_payload, headers={"content-type": "application/json"})
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Supertonic TTS is not reachable at {runtime_settings.supertonic_base_url}: {exc}",
        ) from exc

    if response.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Supertonic TTS failed (HTTP {response.status_code}): {response.text[:240]}",
        )
    if not response.content:
        raise HTTPException(status_code=502, detail="Supertonic TTS returned an empty audio response.")

    return Response(
        content=response.content,
        media_type="audio/wav",
        headers={
            "X-TTS-Provider": runtime_settings.local_tts_provider,
            "X-TTS-Voice": str(tts_payload.get("voice") or ""),
            "X-TTS-Speed": str(tts_payload.get("speed") or ""),
            "X-TTS-Expression-Tags": ",".join(str(tag) for tag in rendered.get("expression_tags_used") or []),
        },
    )


@app.get("/api/voice/codex-orchestrator/status")
async def voice_codex_orchestrator_status(conversation_id: str) -> dict[str, Any]:
    cid = conversation_id.strip()
    if not cid:
        raise HTTPException(status_code=400, detail="conversation_id is required.")
    bridge = CodexOrchestratorBridge(db, settings)
    result = await bridge.status(cid)
    flowchart = await bridge.flowchart(cid)
    return {
        "conversation_id": cid,
        "message": result.text,
        "codex": result.metadata(),
        "raw": result.raw or {},
        "flowchart": flowchart,
    }


@app.post("/api/voice/text-test/run")
async def voice_text_test_run(payload: VoiceTextSuiteRequest | None = None) -> dict[str, Any]:
    payload = payload or VoiceTextSuiteRequest()
    runtime_settings = settings_for_speech_path(settings, payload.voice_speech_path)
    cases = [case.dict(exclude_none=True) for case in payload.cases] if payload.cases else None
    try:
        return await run_voice_text_suite(
            conversation_id=payload.conversation_id,
            settings=runtime_settings,
            db=db,
            prompt_repo=prompt_repo,
            agent=agent,
            flow_runtime=flow_runtime,
            cases=cases,
            voice_behavior_mode=payload.voice_behavior_mode,
            voice_flow_id=payload.voice_flow_id,
            input_mode=payload.input_mode,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Flow or run not found.") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _require_cekura_hook_secret(request: Request) -> None:
    try:
        assert_cekura_secret(request.headers, settings.cekura_webhook_secret)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@app.get("/api/cekura/status")
async def cekura_status() -> dict[str, Any]:
    voice_settings = settings_for_speech_path(settings, settings.voice_speech_path)
    return {
        "status": "ok",
        "websocket_path": "/api/cekura/ws",
        "seed_hook_path": "/api/cekura/hooks/seed",
        "reset_hook_path": "/api/cekura/hooks/reset",
        "result_hook_path": "/api/cekura/hooks/result",
        "websocket_secret_configured": bool(settings.cekura_websocket_secret),
        "webhook_secret_configured": bool(settings.cekura_webhook_secret),
        "voice_speech_path": voice_settings.voice_speech_path,
        "voice_behavior_mode": voice_settings.voice_behavior_mode,
        "llm_provider": voice_settings.llm_provider,
        "model": voice_settings.active_model,
    }


@app.post("/api/cekura/hooks/seed")
async def cekura_seed_hook(payload: CekuraHookRequest, request: Request) -> dict[str, Any]:
    _require_cekura_hook_secret(request)
    seeded = seed_cekura_state(
        db,
        run_id=payload.run_id,
        scenario_id=payload.scenario_id,
        result_id=payload.result_id,
        metadata=payload.metadata,
    )
    return {"status": "seeded", **seeded}


@app.post("/api/cekura/hooks/reset")
async def cekura_reset_hook(payload: CekuraHookRequest, request: Request) -> dict[str, Any]:
    _require_cekura_hook_secret(request)
    cleanup = cleanup_cekura_state(
        db,
        conversation_id=payload.conversation_id,
        run_id=payload.run_id,
        result_id=payload.result_id,
        all_cekura=payload.all_cekura,
        reset_runtime_profile=payload.reset_runtime_profile,
    )
    return {"status": "reset", **cleanup}


@app.post("/api/cekura/hooks/result")
async def cekura_result_hook(payload: dict[str, Any], request: Request) -> dict[str, Any]:
    _require_cekura_hook_secret(request)
    recorded = record_cekura_result(db, payload)
    cleaned: list[dict[str, Any]] = []
    for run_id in parse_result_webhook_run_ids(payload):
        cleaned.append(cleanup_cekura_state(db, run_id=run_id, reset_runtime_profile=False))
    return {"status": "recorded", "recorded": recorded, "cleanup": cleaned}


@app.websocket("/api/cekura/ws")
async def cekura_websocket_chat(websocket: WebSocket) -> None:
    try:
        assert_cekura_secret(websocket.headers, settings.cekura_websocket_secret)
    except PermissionError:
        await websocket.close(code=1008, reason="Invalid Cekura websocket secret.")
        return

    await websocket.accept()
    context = cekura_context_from_headers(websocket.headers)
    conversation_id = cekura_conversation_id(context.get("run_id"))
    runtime_settings = settings_for_speech_path(settings, websocket.query_params.get("voice_speech_path"))
    voice_behavior_mode = websocket.query_params.get("voice_behavior_mode")
    voice_flow_id = websocket.query_params.get("voice_flow_id")
    input_mode = websocket.query_params.get("input_mode") or "push_to_talk"
    try:
        while True:
            payload = await websocket.receive_json()
            metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
            text = str(payload.get("content") or payload.get("text") or "").strip()
            if payload.get("type") == "end_call":
                await websocket.send_json(
                    {
                        "type": "end_call",
                        "content": "Goodbye.",
                        "metadata": {"source": "cekura", "conversation_id": conversation_id, **context},
                    }
                )
                return
            if not text:
                await websocket.send_json(
                    {
                        "metadata": {
                            "source": "cekura",
                            "conversation_id": conversation_id,
                            "ignored_empty_message": True,
                            **context,
                        }
                    }
                )
                continue
            turn = await run_voice_text_turn(
                message=text,
                conversation_id=conversation_id,
                settings=runtime_settings,
                db=db,
                prompt_repo=prompt_repo,
                agent=agent,
                flow_runtime=flow_runtime,
                voice_behavior_mode=metadata.get("voice_behavior_mode") or voice_behavior_mode,
                voice_flow_id=metadata.get("voice_flow_id") or voice_flow_id,
                input_mode=metadata.get("input_mode") or input_mode,
                force_interrupt=bool(metadata.get("force_interrupt")),
                flow_run_id=metadata.get("flow_run_id"),
            )
            await websocket.send_json(build_cekura_agent_message(turn, context))
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.exception("Cekura websocket turn failed")
        await websocket.send_json(
            {
                "content": "I'm having trouble running this test turn right now.",
                "metadata": {
                    "source": "cekura",
                    "conversation_id": conversation_id,
                    "error_type": type(exc).__name__,
                    **context,
                },
            }
        )


def get_small_webrtc_handler():
    global small_webrtc_handler
    if small_webrtc_handler is None:
        try:
            from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequestHandler
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Pipecat WebRTC dependencies are not installed. "
                    'Run: .venv/bin/python -m pip install -e "backend[voice]".'
                ),
            ) from exc
        small_webrtc_handler = SmallWebRTCRequestHandler(ice_servers=_small_webrtc_ice_servers() or None)
    return small_webrtc_handler


@app.post("/api/offer")
async def browser_webrtc_offer(
    payload: dict[str, Any],
) -> dict[str, str] | None:
    request_data = payload.get("requestData") if isinstance(payload.get("requestData"), dict) else {}
    requested_speech_path = str(request_data.get("voice_speech_path") or settings.voice_speech_path)
    try:
        runtime_settings = settings_for_speech_path(settings, requested_speech_path)
        require_mainstream_voice_path(runtime_settings)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        require_openai_compatible_llm(runtime_settings)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        await prepare_llm_runtime(runtime_settings)
        await wait_for_voice_dependencies(runtime_settings)
        await require_codexa_dependency(runtime_settings)
    except CloudVLLMError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    try:
        from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
        from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Pipecat WebRTC dependencies are not installed. "
                'Run: .venv/bin/python -m pip install -e "backend[voice]".'
            ),
        ) from exc

    request = SmallWebRTCRequest.from_dict(dict(payload))
    requested_mode = str(request_data.get("voice_behavior_mode") or runtime_settings.voice_behavior_mode)
    voice_behavior_mode = (
        requested_mode if requested_mode in {"assistant", "flow"} else runtime_settings.voice_behavior_mode
    )
    requested_flow_id = str(request_data.get("voice_flow_id") or runtime_settings.voice_flow_id)
    requested_input_mode = str(request_data.get("input_mode") or "vad")
    input_mode = "push_to_talk" if requested_input_mode == "push_to_talk" else "vad"
    session_id = str(request_data.get("conversation_id") or uuid.uuid4())
    small_webrtc_request_handler = get_small_webrtc_handler()
    reconnecting_known_peer = is_known_webrtc_peer(small_webrtc_request_handler, request.pc_id)
    if reconnecting_known_peer:
        logger.info("Reusing voice session for WebRTC reconnect: pc_id=%s", request.pc_id)
    else:
        if active_browser_voice_sessions or browser_voice_tasks:
            await clear_stale_browser_voice_sessions("new WebRTC offer")
        if active_browser_voice_sessions or not cloud_vllm_manager.try_session_started(max_sessions=1):
            raise HTTPException(
                status_code=409,
                detail="A voice session is already active. Disconnect it before starting another.",
            )
        active_browser_voice_sessions.add(session_id)
    session_reserved = not reconnecting_known_peer

    async def webrtc_connection_callback(connection: SmallWebRTCConnection):
        nonlocal session_reserved
        connection_connected = asyncio.Event()
        watchdog: asyncio.Task | None = None
        disconnect_grace_task: asyncio.Task | None = None
        task = asyncio.create_task(
            run_browser_pipecat_voice_agent(
                connection,
                runtime_settings,
                db,
                prompt_repo,
                session_id,
                voice_behavior_mode=voice_behavior_mode,
                voice_flow_id=requested_flow_id,
                input_mode=input_mode,
            )
        )
        browser_voice_tasks.add(task)

        async def cancel_on_connection_end(_connection, *_args):
            if is_small_webrtc_renegotiating(_connection):
                logger.info("Ignoring transient WebRTC disconnect during renegotiation for %s", session_id)
                return
            if not task.done():
                logger.info("Browser WebRTC connection ended; cancelling voice task %s", session_id)
                task.cancel()

        async def cancel_on_unrecovered_disconnect(_connection, *_args):
            nonlocal disconnect_grace_task
            if disconnect_grace_task is not None and not disconnect_grace_task.done():
                return

            async def delayed_cancel() -> None:
                nonlocal disconnect_grace_task
                try:
                    await asyncio.sleep(8)
                    if task.done():
                        return
                    try:
                        connected = bool(_connection.is_connected())
                    except Exception:
                        connected = False
                    if connected:
                        logger.info("Browser WebRTC disconnect recovered for %s", session_id)
                        return
                    logger.info(
                        "Browser WebRTC disconnect did not recover; cancelling voice task %s",
                        session_id,
                    )
                    task.cancel()
                finally:
                    current = asyncio.current_task()
                    if current is not None:
                        browser_voice_watchdogs.discard(current)
                    if disconnect_grace_task is current:
                        disconnect_grace_task = None

            logger.info("Browser WebRTC disconnected; waiting for ICE/restart recovery for %s", session_id)
            disconnect_grace_task = asyncio.create_task(delayed_cancel())
            browser_voice_watchdogs.add(disconnect_grace_task)

        async def mark_connection_connected(_connection, *_args):
            nonlocal disconnect_grace_task
            if disconnect_grace_task is not None and not disconnect_grace_task.done():
                disconnect_grace_task.cancel()
                browser_voice_watchdogs.discard(disconnect_grace_task)
                disconnect_grace_task = None
            connection_connected.set()

        connection.add_event_handler("connected", mark_connection_connected)
        connection.add_event_handler("disconnected", cancel_on_unrecovered_disconnect)
        connection.add_event_handler("closed", cancel_on_connection_end)
        connection.add_event_handler("failed", cancel_on_connection_end)

        async def cancel_if_never_connected() -> None:
            try:
                await asyncio.wait_for(connection_connected.wait(), timeout=90)
            except asyncio.TimeoutError:
                if not task.done():
                    logger.warning(
                        "Browser WebRTC session %s did not connect within 90s; cancelling voice task",
                        session_id,
                    )
                    task.cancel()

        def finish_voice_task(done: asyncio.Task) -> None:
            nonlocal session_reserved
            browser_voice_tasks.discard(done)
            if done.cancelled():
                logger.info("Browser voice task %s cancelled", session_id)
            else:
                exc = done.exception()
                if exc is not None:
                    logger.error(
                        "Browser voice task %s failed",
                        session_id,
                        exc_info=(type(exc), exc, exc.__traceback__),
                    )
                else:
                    logger.info("Browser voice task %s completed", session_id)
            if watchdog is not None:
                watchdog.cancel()
                browser_voice_watchdogs.discard(watchdog)
            if disconnect_grace_task is not None:
                disconnect_grace_task.cancel()
                browser_voice_watchdogs.discard(disconnect_grace_task)
            if session_reserved:
                session_reserved = False
                active_browser_voice_sessions.discard(session_id)
                cloud_vllm_manager.session_finished()
            for stale_watchdog in tuple(browser_voice_watchdogs):
                if stale_watchdog.done():
                    browser_voice_watchdogs.discard(stale_watchdog)

        task.add_done_callback(finish_voice_task)
        watchdog = asyncio.create_task(cancel_if_never_connected())
        browser_voice_watchdogs.add(watchdog)

    try:
        return await small_webrtc_request_handler.handle_web_request(
            request=request,
            webrtc_connection_callback=webrtc_connection_callback,
        )
    except Exception:
        if session_reserved:
            session_reserved = False
            active_browser_voice_sessions.discard(session_id)
            cloud_vllm_manager.session_finished()
        raise


@app.patch("/api/offer")
async def browser_webrtc_ice_candidate(payload: dict[str, Any]) -> dict[str, str]:
    try:
        from pipecat.transports.smallwebrtc.request_handler import (
            IceCandidate,
            SmallWebRTCPatchRequest,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Pipecat WebRTC dependencies are not installed. "
                'Run: .venv/bin/python -m pip install -e "backend[voice]".'
            ),
        ) from exc

    request = SmallWebRTCPatchRequest(
        pc_id=payload["pc_id"],
        candidates=[
            IceCandidate(
                candidate=candidate["candidate"],
                sdp_mid=candidate["sdp_mid"],
                sdp_mline_index=candidate["sdp_mline_index"],
            )
            for candidate in payload.get("candidates", [])
        ],
    )
    await get_small_webrtc_handler().handle_patch_request(request)
    return {"status": "success"}


@app.get("/api/cost")
async def cost() -> dict[str, Any]:
    return {"cost_guard": cost_guard.snapshot().to_dict()}


@app.post("/api/chat")
async def chat(payload: ChatRequest) -> dict[str, Any]:
    try:
        return await agent.respond(
            payload.message,
            conversation_id=payload.conversation_id,
            channel=payload.channel,
            caller=payload.caller,
            metadata=payload.metadata,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/flows")
async def list_flows() -> dict[str, Any]:
    return {"flows": [flow_summary(flow) for flow in flow_repo.list()]}


@app.get("/api/flows/active")
async def active_flow() -> dict[str, Any]:
    return {"flow": flow_repo.active().to_dict()}


@app.post("/api/flows")
async def create_flow(payload: FlowCreateRequest) -> dict[str, Any]:
    return {"flow": flow_repo.create(payload.name, payload.description).to_dict()}


@app.get("/api/flows/{flow_id}")
async def get_flow(flow_id: str) -> dict[str, Any]:
    try:
        return {"flow": flow_repo.get(flow_id).to_dict()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Flow not found.") from exc


@app.put("/api/flows/{flow_id}")
async def update_flow(flow_id: str, payload: FlowUpdateRequest) -> dict[str, Any]:
    try:
        return {
            "flow": flow_repo.update(
                flow_id,
                payload.name,
                payload.description,
                payload.graph,
            ).to_dict()
        }
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Flow not found.") from exc


@app.post("/api/flows/{flow_id}/publish")
async def publish_flow(flow_id: str) -> dict[str, Any]:
    try:
        return {"flow": flow_repo.publish(flow_id).to_dict()}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Flow not found.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/flows/validate")
async def validate_flow(payload: FlowValidateRequest) -> dict[str, Any]:
    return {"validation": validate_flow_graph(payload.graph)}


@app.post("/api/flows/{flow_id}/simulate")
async def simulate_flow(flow_id: str, payload: FlowSimulateRequest) -> dict[str, Any]:
    try:
        return await flow_runtime.handle_message(
            flow_id=flow_id,
            message=payload.message,
            run_id=payload.run_id,
            force_interrupt=payload.force_interrupt,
            conversation_id=payload.conversation_id,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Flow or run not found.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/flows/runs/by-conversation/{conversation_id}")
async def flow_run_by_conversation(conversation_id: str) -> dict[str, Any]:
    return {"run": flow_runtime.latest_run_for_conversation(conversation_id)}


@app.get("/api/conversations/{conversation_id}")
async def conversation(conversation_id: str) -> dict[str, Any]:
    return {"conversation_id": conversation_id, "turns": agent.transcript(conversation_id)}


@app.get("/api/latency/recent")
async def recent_latency(limit: int = 25, conversation_id: str | None = None) -> dict[str, Any]:
    bounded_limit = max(1, min(limit, 200))
    if conversation_id:
        rows = db.all(
            """
            SELECT id, conversation_id, interaction_id, channel, transport,
                   user_turn_id, assistant_turn_id, providers_json, timings_json, created_at
            FROM latency_traces
            WHERE conversation_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (conversation_id, bounded_limit),
        )
    else:
        rows = db.all(
            """
            SELECT id, conversation_id, interaction_id, channel, transport,
                   user_turn_id, assistant_turn_id, providers_json, timings_json, created_at
            FROM latency_traces
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (bounded_limit,),
        )
    return {
        "latency_traces": [
            {
                "id": row["id"],
                "conversation_id": row["conversation_id"],
                "interaction_id": row["interaction_id"],
                "channel": row["channel"],
                "transport": row["transport"],
                "user_turn_id": row["user_turn_id"],
                "assistant_turn_id": row["assistant_turn_id"],
                "providers": loads(row["providers_json"], {}),
                "timings": loads(row["timings_json"], {}),
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    }


@app.get("/api/latency/summary")
async def latency_summary(limit: int = 100, conversation_id: str | None = None) -> dict[str, Any]:
    return build_latency_summary(limit, conversation_id)


def build_latency_summary(limit: int = 100, conversation_id: str | None = None) -> dict[str, Any]:
    bounded_limit = max(1, min(limit, 1000))
    if conversation_id:
        rows = db.all(
            """
            SELECT providers_json, timings_json, created_at
            FROM latency_traces
            WHERE conversation_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (conversation_id, bounded_limit),
        )
    else:
        rows = db.all(
            """
            SELECT providers_json, timings_json, created_at
            FROM latency_traces
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (bounded_limit,),
        )

    timing_rows = [loads(row["timings_json"], {}) for row in rows]
    provider_rows = [loads(row["providers_json"], {}) for row in rows]
    metric_names = sorted(
        {
            key
            for timings in timing_rows
            for key, value in timings.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
    )

    def percentile(values: list[float], p: float) -> float | None:
        if not values:
            return None
        ordered = sorted(values)
        index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * p)))
        return ordered[index]

    metrics = {}
    for name in metric_names:
        values = [
            float(timings[name])
            for timings in timing_rows
            if isinstance(timings.get(name), (int, float))
            and not isinstance(timings.get(name), bool)
        ]
        metrics[name] = {
            "count": len(values),
            "min_ms": min(values) if values else None,
            "p50_ms": percentile(values, 0.50),
            "p95_ms": percentile(values, 0.95),
            "max_ms": max(values) if values else None,
        }

    bottleneck_counts: dict[str, int] = {}
    for timings in timing_rows:
        candidates = {
            "stt": timings.get("stt_after_speech_end_ms"),
            "turn_finalization": timings.get("turn_finalization_ms"),
            "llm_ttfb": timings.get("llm_ttfb_ms"),
            "llm_total": timings.get("llm_total_ms"),
            "tts_ttfb": timings.get("tts_ttfb_from_first_text_ms"),
            "tts_total": timings.get("tts_total_ms"),
        }
        numeric = {
            name: float(value)
            for name, value in candidates.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        }
        if numeric:
            bottleneck = max(numeric, key=numeric.get)
            bottleneck_counts[bottleneck] = bottleneck_counts.get(bottleneck, 0) + 1

    target = settings.latency_target_ms
    first_audio_values = [
        timings.get("speech_end_to_first_audio_ms")
        for timings in timing_rows
        if isinstance(timings.get("speech_end_to_first_audio_ms"), (int, float))
    ]
    return {
        "count": len(rows),
        "latency_target_ms": target,
        "target_breaches": sum(1 for value in first_audio_values if value > target),
        "runtime_config": {
            "stt_provider": settings.local_stt_provider,
            "stt_model": settings.local_stt_model,
            "stt_language": settings.local_stt_language,
            "tts_provider": settings.local_tts_provider,
            "tts_voice": settings.local_tts_voice,
            "tts_text_aggregation_mode": settings.local_tts_text_aggregation_mode,
            "voxtral_tts_model": settings.voxtral_tts_model
            if settings.local_tts_provider == "voxtral"
            else None,
            "voxtral_tts_response_format": settings.voxtral_tts_response_format
            if settings.local_tts_provider == "voxtral"
            else None,
            "voxtral_tts_stream": settings.voxtral_tts_stream
            if settings.local_tts_provider == "voxtral"
            else None,
            "voxtral_tts_ref_audio_enabled": settings.voxtral_tts_ref_audio_enabled
            if settings.local_tts_provider == "voxtral"
            else None,
            "llm_provider": settings.llm_provider,
            "llm_model": settings.active_model,
            "vertex_nim_region": settings.vertex_nim_region
            if settings.llm_provider == "vertex_nim"
            else None,
            "vertex_nim_endpoint_id": settings.vertex_nim_endpoint_id
            if settings.llm_provider == "vertex_nim"
            else None,
        },
        "providers_latest": provider_rows[0] if provider_rows else {},
        "bottleneck_counts": bottleneck_counts,
        "metrics": metrics,
    }


def recent_turns(limit: int, conversation_id: str | None = None) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 500))
    if conversation_id:
        rows = db.all(
            """
            SELECT id, conversation_id, role, content, latency_ms, model, prompt_version,
                   metrics_json, created_at
            FROM turns
            WHERE conversation_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (conversation_id, bounded_limit),
        )
    else:
        rows = db.all(
            """
            SELECT id, conversation_id, role, content, latency_ms, model, prompt_version,
                   metrics_json, created_at
            FROM turns
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (bounded_limit,),
        )
    return [
        {
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "role": row["role"],
            "content": row["content"],
            "latency_ms": row["latency_ms"],
            "model": row["model"],
            "prompt_version": row["prompt_version"],
            "metrics": loads(row["metrics_json"], {}),
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def recent_feedback(limit: int, conversation_id: str | None = None) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 500))
    if conversation_id:
        rows = db.all(
            """
            SELECT f.id, f.conversation_id, f.turn_id, f.rating, f.label, f.notes,
                   f.created_at, t.role AS turn_role, t.content AS turn_content,
                   t.prompt_version AS turn_prompt_version
            FROM feedback f
            LEFT JOIN turns t ON t.id = f.turn_id
            WHERE f.conversation_id = ?
            ORDER BY f.created_at DESC
            LIMIT ?
            """,
            (conversation_id, bounded_limit),
        )
    else:
        rows = db.all(
            """
            SELECT f.id, f.conversation_id, f.turn_id, f.rating, f.label, f.notes,
                   f.created_at, t.role AS turn_role, t.content AS turn_content,
                   t.prompt_version AS turn_prompt_version
            FROM feedback f
            LEFT JOIN turns t ON t.id = f.turn_id
            ORDER BY f.created_at DESC
            LIMIT ?
            """,
            (bounded_limit,),
        )
    return [
        {
            "id": row["id"],
            "conversation_id": row["conversation_id"],
            "turn_id": row["turn_id"],
            "rating": row["rating"],
            "label": row["label"],
            "notes": row["notes"],
            "turn_role": row["turn_role"],
            "turn_content": row["turn_content"],
            "turn_prompt_version": row["turn_prompt_version"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def recent_prompt_versions(limit: int) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 100))
    rows = db.all(
        """
        SELECT version, system_prompt, learned_hints, source, active, created_at
        FROM prompt_versions
        ORDER BY version DESC
        LIMIT ?
        """,
        (bounded_limit,),
    )
    return [
        {
            "version": row["version"],
            "system_prompt": row["system_prompt"],
            "learned_hints": row["learned_hints"],
            "source": row["source"],
            "active": bool(row["active"]),
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def recent_flow_events(limit: int, conversation_id: str | None = None) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 500))
    if conversation_id:
        rows = db.all(
            """
            SELECT e.id, e.run_id, e.flow_id, e.node_id, e.event, e.role, e.text,
                   e.payload_json, e.created_at, r.conversation_id, r.active_node_id,
                   r.status
            FROM flow_events e
            JOIN flow_runs r ON r.id = e.run_id
            WHERE r.conversation_id = ?
            ORDER BY e.created_at DESC
            LIMIT ?
            """,
            (conversation_id, bounded_limit),
        )
    else:
        rows = db.all(
            """
            SELECT e.id, e.run_id, e.flow_id, e.node_id, e.event, e.role, e.text,
                   e.payload_json, e.created_at, r.conversation_id, r.active_node_id,
                   r.status
            FROM flow_events e
            JOIN flow_runs r ON r.id = e.run_id
            ORDER BY e.created_at DESC
            LIMIT ?
            """,
            (bounded_limit,),
        )
    return [
        {
            "id": row["id"],
            "run_id": row["run_id"],
            "flow_id": row["flow_id"],
            "conversation_id": row["conversation_id"],
            "node_id": row["node_id"],
            "active_node_id": row["active_node_id"],
            "status": row["status"],
            "event": row["event"],
            "role": row["role"],
            "text": row["text"],
            "payload": loads(row["payload_json"], {}),
            "created_at": row["created_at"],
        }
        for row in rows
    ]


def recent_flow_runs(limit: int, conversation_id: str | None = None) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(limit, 100))
    if conversation_id:
        rows = db.all(
            """
            SELECT id, flow_id, conversation_id, active_node_id, slots_json,
                   transcript_json, status, created_at, updated_at
            FROM flow_runs
            WHERE conversation_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (conversation_id, bounded_limit),
        )
    else:
        rows = db.all(
            """
            SELECT id, flow_id, conversation_id, active_node_id, slots_json,
                   transcript_json, status, created_at, updated_at
            FROM flow_runs
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (bounded_limit,),
        )
    return [
        {
            "id": row["id"],
            "flow_id": row["flow_id"],
            "conversation_id": row["conversation_id"],
            "active_node_id": row["active_node_id"],
            "slots": loads(row["slots_json"], {}),
            "transcript": loads(row["transcript_json"], []),
            "status": row["status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


@app.get("/api/interactions/recent")
async def recent_interactions(limit: int = 50, conversation_id: str | None = None) -> dict[str, Any]:
    bounded_limit = max(1, min(limit, 500))
    if conversation_id:
        rows = db.all(
            """
            SELECT id, conversation_id, interaction_id, channel, transport,
                   event, role, text, payload_json, created_at
            FROM interaction_events
            WHERE conversation_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (conversation_id, bounded_limit),
        )
    else:
        rows = db.all(
            """
            SELECT id, conversation_id, interaction_id, channel, transport,
                   event, role, text, payload_json, created_at
            FROM interaction_events
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (bounded_limit,),
        )
    return {
        "interaction_events": [
            {
                "id": row["id"],
                "conversation_id": row["conversation_id"],
                "interaction_id": row["interaction_id"],
                "channel": row["channel"],
                "transport": row["transport"],
                "event": row["event"],
                "role": row["role"],
                "text": row["text"],
                "payload": loads(row["payload_json"], {}),
                "created_at": row["created_at"],
            }
            for row in rows
        ]
    }


@app.get("/api/self-learn")
async def self_learn(limit: int = 40, conversation_id: str | None = None) -> dict[str, Any]:
    bounded_limit = max(1, min(limit, 200))
    improvement = learner.report()
    interaction_response = await recent_interactions(bounded_limit, conversation_id)
    latency_response = await recent_latency(bounded_limit, conversation_id)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "conversation_id": conversation_id,
        "config": improvement["config"],
        "active_prompt_version": improvement["active_prompt_version"],
        "learned_hints": improvement["learned_hints"],
        "proposed_hints": improvement["proposed_hints"],
        "feedback_summary": improvement["feedback_summary"],
        "recent_eval_results": improvement["recent_eval_results"],
        "recent_turns": recent_turns(bounded_limit, conversation_id),
        "recent_feedback": recent_feedback(bounded_limit, conversation_id),
        "recent_prompt_versions": recent_prompt_versions(12),
        "recent_flow_events": recent_flow_events(bounded_limit, conversation_id),
        "recent_flow_runs": recent_flow_runs(12, conversation_id),
        "interaction_events": interaction_response["interaction_events"],
        "latency_traces": latency_response["latency_traces"],
        "latency_summary": build_latency_summary(max(100, bounded_limit), conversation_id),
    }


@app.patch("/api/self-learn/config")
async def update_self_learn_config(payload: SelfLearnConfigRequest) -> dict[str, Any]:
    return {
        "config": learner.update_config(
            enabled=payload.enabled,
            factor=payload.factor,
        )
    }


@app.websocket("/api/ws")
async def websocket_chat(websocket: WebSocket) -> None:
    await websocket.accept()
    conversation_id: str | None = None
    try:
        while True:
            payload = await websocket.receive_json()
            if payload.get("type") != "user_message":
                await websocket.send_json({"type": "error", "message": "Unsupported message type."})
                continue
            response = await agent.respond(
                payload.get("text", ""),
                conversation_id=payload.get("conversation_id") or conversation_id,
                channel="websocket",
                metadata=payload.get("metadata") or {},
            )
            conversation_id = response["conversation_id"]
            await websocket.send_json({"type": "assistant_message", **response})
    except RuntimeError as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
    except WebSocketDisconnect:
        return


@app.post("/api/feedback")
async def feedback(payload: FeedbackRequest) -> dict[str, Any]:
    feedback_id = str(uuid.uuid4())
    db.execute(
        """
        INSERT INTO feedback(id, conversation_id, turn_id, rating, label, notes)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            feedback_id,
            payload.conversation_id,
            payload.turn_id,
            payload.rating,
            payload.label,
            payload.notes,
        ),
    )
    prompt_version = learner.rebuild()
    return {"feedback_id": feedback_id, "active_prompt_version": prompt_version.version}


@app.get("/api/prompt")
async def prompt() -> dict[str, Any]:
    active = prompt_repo.active()
    return {
        "version": active.version,
        "system_prompt": active.system_prompt,
        "learned_hints": active.learned_hints,
        "compiled": active.compiled,
    }


@app.get("/api/auto-improvement")
async def auto_improvement() -> dict[str, Any]:
    return learner.report()


@app.post("/api/evals/run")
async def run_eval(payload: EvalRunRequest) -> dict[str, Any]:
    path = resolve_repo_path(payload.suite_path)
    return await eval_runner.run_suite(path, apply_feedback=payload.apply_feedback)


@app.get("/api/evals/scheduler")
async def eval_scheduler_status() -> dict[str, Any]:
    return eval_scheduler.status()


@app.post("/api/evals/scheduler/start")
async def eval_scheduler_start(payload: EvalSchedulerRequest) -> dict[str, Any]:
    try:
        return await eval_scheduler.start(
            interval_seconds=payload.interval_seconds,
            suite_path=payload.suite_path,
            apply_feedback=payload.apply_feedback,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/evals/scheduler/stop")
async def eval_scheduler_stop() -> dict[str, Any]:
    return await eval_scheduler.stop()


@app.get("/api/evals/runs")
async def eval_runs() -> dict[str, Any]:
    rows = db.all(
        """
        SELECT id, suite, status, started_at, completed_at, aggregate_score, metrics_json
        FROM eval_runs
        ORDER BY started_at DESC
        LIMIT 20
        """
    )
    return {
        "runs": [
            {
                "id": row["id"],
                "suite": row["suite"],
                "status": row["status"],
                "started_at": row["started_at"],
                "completed_at": row["completed_at"],
                "aggregate_score": row["aggregate_score"],
                "metrics": loads(row["metrics_json"], {}),
            }
            for row in rows
        ]
    }


@app.post("/api/training/export")
async def training_export(payload: ExportTrainingDataRequest) -> dict[str, Any]:
    return export_sft_jsonl(db, payload.output_path)


async def _twilio_form_params(request: Request) -> dict[str, str]:
    raw_body = (await request.body()).decode()
    return dict(parse_qsl(raw_body, keep_blank_values=True))


def _twilio_public_request_url(request: Request) -> str:
    base_url = f"{settings.twilio_effective_public_base_url}{request.url.path}"
    if request.url.query:
        return f"{base_url}?{request.url.query}"
    return base_url


def _validate_twilio_request(request: Request, params: dict[str, str]) -> None:
    if settings.twilio_should_validate_signature:
        from twilio.request_validator import RequestValidator

        if not settings.twilio_auth_token:
            raise HTTPException(status_code=500, detail="TWILIO_AUTH_TOKEN is required.")
        signature = request.headers.get("X-Twilio-Signature", "")
        validator = RequestValidator(settings.twilio_auth_token)
        if not validator.validate(_twilio_public_request_url(request), params, signature):
            raise HTTPException(status_code=403, detail="Invalid Twilio signature.")


def _safe_int(value: str | None, default: int = 0) -> int:
    try:
        return int(value) if value is not None else default
    except ValueError:
        return default


def _log_twilio_pending_failure(task: asyncio.Task[dict[str, Any]]) -> None:
    if task.cancelled():
        return
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    if exc is not None:
        logger.error("Twilio background voice turn failed", exc_info=(type(exc), exc, exc.__traceback__))


async def _wait_for_twilio_pending_turn(
    conversation_id: str,
    timeout_seconds: float,
) -> dict[str, Any] | None:
    task = twilio_pending_turns.get(conversation_id)
    if task is None:
        return None
    if not task.done() and timeout_seconds > 0:
        done, _pending = await asyncio.wait({task}, timeout=timeout_seconds)
        if not done:
            return None
    if not task.done():
        return None
    twilio_pending_turns.pop(conversation_id, None)
    return task.result()


def _twilio_pending_response(conversation_id: str) -> Response:
    return Response(content=pending_twiml(settings, conversation_id), media_type="application/xml")


def _twilio_log_metrics(raw: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {}
    for key in ("source", "provider", "call_sid", "call_status", "duration", "channel"):
        if raw.get(key) is not None:
            summary[key] = raw[key]
    codex = raw.get("codex")
    if isinstance(codex, dict):
        summary["codex"] = {
            key: codex.get(key)
            for key in (
                "status",
                "codex_session_id",
                "codex_project_id",
                "codex_task_id",
                "requires_approval",
                "approval_id",
                "codex_session_status",
                "codex_current_status",
            )
            if codex.get(key) is not None
        }
    return summary


def _twilio_call_log_record(row: Any) -> dict[str, Any]:
    metadata = loads(row["metadata_json"], {})
    call_sid = metadata.get("call_sid")
    turns = [
        {
            "id": turn["id"],
            "role": turn["role"],
            "content": turn["content"],
            "latency_ms": turn["latency_ms"],
            "model": turn["model"],
            "metrics": _twilio_log_metrics(loads(turn["metrics_json"], {})),
            "created_at": turn["created_at"],
        }
        for turn in db.all(
            """
            SELECT id, role, content, latency_ms, model, metrics_json, created_at
            FROM turns
            WHERE conversation_id = ?
            ORDER BY created_at ASC
            LIMIT 80
            """,
            (row["id"],),
        )
    ]
    status_turn = next(
        (
            turn
            for turn in reversed(turns)
            if turn["metrics"].get("source") == "twilio_status_callback"
        ),
        None,
    )
    last_speech_turn = next(
        (
            turn
            for turn in reversed(turns)
            if turn["role"] in {"user", "assistant"} and turn["content"].strip()
        ),
        None,
    )
    codex_turn = next(
        (
            turn
            for turn in reversed(turns)
            if isinstance(turn["metrics"].get("codex"), dict)
            and turn["metrics"]["codex"].get("codex_session_id")
        ),
        None,
    )
    status_metrics = status_turn["metrics"] if status_turn else {}
    return {
        "conversation_id": row["id"],
        "call_sid": call_sid,
        "caller": row["caller"] or metadata.get("from"),
        "to": metadata.get("to"),
        "voice_mode": metadata.get("voice_mode"),
        "status": status_metrics.get("call_status") or "active",
        "duration_seconds": status_metrics.get("duration"),
        "started_at": row["started_at"],
        "updated_at": (turns[-1]["created_at"] if turns else row["started_at"]),
        "last_message": last_speech_turn["content"] if last_speech_turn else "",
        "codex": codex_turn["metrics"]["codex"] if codex_turn else {},
        "turns": turns,
    }


@app.post("/api/twilio/voice")
@app.post("/twilio/inbound")
async def twilio_inbound(request: Request) -> Response:
    params = await _twilio_form_params(request)
    _validate_twilio_request(request, params)
    call_sid = params.get("CallSid")
    conversation_id = twilio_conversation_id(call_sid)
    if conversation_id:
        agent.ensure_conversation(
            conversation_id,
            "twilio",
            caller=params.get("From"),
            metadata={
                "call_sid": call_sid,
                "to": params.get("To"),
                "from": params.get("From"),
                "voice_mode": settings.twilio_voice_mode,
            },
        )
    return Response(content=inbound_twiml(settings, call_sid), media_type="application/xml")


@app.post("/twilio/voice-turn")
async def twilio_voice_turn(request: Request) -> Response:
    params = await _twilio_form_params(request)
    _validate_twilio_request(request, params)
    conversation_id = (
        request.query_params.get("conversation_id")
        or twilio_conversation_id(params.get("CallSid"))
        or str(uuid.uuid4())
    )
    no_input_count = _safe_int(request.query_params.get("no_input_count"))
    user_text = (params.get("SpeechResult") or params.get("Digits") or "").strip()
    if conversation_id in twilio_pending_turns:
        try:
            pending_result = await _wait_for_twilio_pending_turn(
                conversation_id,
                1.0 if request.query_params.get("pending") == "1" else 0.0,
            )
        except Exception:
            logger.exception("Twilio pending voice turn failed")
            return Response(content=error_twiml(settings), media_type="application/xml")
        if pending_result is None:
            return _twilio_pending_response(conversation_id)
        return Response(
            content=voice_turn_twiml(settings, pending_result["message"], conversation_id),
            media_type="application/xml",
        )
    if not user_text:
        return Response(
            content=no_input_twiml(settings, conversation_id, no_input_count),
            media_type="application/xml",
        )
    try:
        task = asyncio.create_task(agent.respond(
            user_text,
            conversation_id=conversation_id,
            channel="twilio",
            caller=params.get("From"),
            metadata={
                "call_sid": params.get("CallSid"),
                "to": params.get("To"),
                "speech_confidence": params.get("Confidence"),
                "voice_mode": "gather",
            },
        ))
        task.add_done_callback(_log_twilio_pending_failure)
        twilio_pending_turns[conversation_id] = task
        result = await _wait_for_twilio_pending_turn(
            conversation_id,
            settings.twilio_voice_turn_timeout_seconds,
        )
    except Exception:
        logger.exception("Twilio voice turn failed")
        return Response(content=error_twiml(settings), media_type="application/xml")
    if result is None:
        return _twilio_pending_response(conversation_id)
    return Response(
        content=voice_turn_twiml(settings, result["message"], conversation_id),
        media_type="application/xml",
    )


@app.post("/twilio/status")
async def twilio_status(request: Request) -> Response:
    params = await _twilio_form_params(request)
    _validate_twilio_request(request, params)
    call_sid = params.get("CallSid")
    conversation_id = twilio_conversation_id(call_sid)
    if conversation_id:
        agent.ensure_conversation(
            conversation_id,
            "twilio",
            caller=params.get("From"),
            metadata={"call_sid": call_sid, "to": params.get("To"), "from": params.get("From")},
        )
        db.execute(
            """
            INSERT INTO turns(id, conversation_id, role, content, metrics_json)
            VALUES (?, ?, 'system', ?, ?)
            """,
            (
                str(uuid.uuid4()),
                conversation_id,
                f"Twilio call status: {params.get('CallStatus', 'unknown')}",
                dumps(
                    {
                        "source": "twilio_status_callback",
                        "call_sid": call_sid,
                        "call_status": params.get("CallStatus"),
                        "duration": params.get("CallDuration") or params.get("Duration"),
                    }
                ),
            ),
        )
    return Response(status_code=204)


@app.get("/api/twilio/status")
async def twilio_config_status() -> dict[str, Any]:
    phone_number = settings.twilio_effective_from_number
    return {
        "ready": bool(
            settings.twilio_account_sid
            and settings.twilio_auth_token
            and phone_number
        ),
        "account_sid_configured": bool(settings.twilio_account_sid),
        "auth_token_configured": bool(settings.twilio_auth_token),
        "from_number_configured": bool(phone_number),
        "phone_number": phone_number,
        "phone_number_sid_configured": bool(settings.twilio_phone_number_sid),
        "voice_mode": settings.twilio_voice_mode,
        "voice_webhook_url": settings.twilio_effective_voice_webhook_url,
        "status_callback_url": settings.twilio_effective_status_callback_url,
        "signature_validation": settings.twilio_should_validate_signature,
    }


@app.get("/api/twilio/call-logs")
async def twilio_call_logs(limit: int = 8) -> dict[str, Any]:
    safe_limit = max(1, min(limit, 20))
    rows = db.all(
        """
        SELECT id, channel, caller, started_at, metadata_json
        FROM conversations
        WHERE channel = 'twilio'
        ORDER BY started_at DESC
        LIMIT ?
        """,
        (safe_limit,),
    )
    return {
        "calls": [_twilio_call_log_record(row) for row in rows],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/api/twilio/configure")
async def twilio_configure(payload: TwilioConfigureRequest) -> dict[str, Any]:
    phone_number_sid = payload.phone_number_sid or settings.twilio_phone_number_sid
    if not (settings.twilio_account_sid and settings.twilio_auth_token and phone_number_sid):
        raise HTTPException(
            status_code=400,
            detail=(
                "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER_SID "
                "are required to configure the Twilio voice webhook."
            ),
        )
    voice_url = payload.voice_url or settings.twilio_effective_voice_webhook_url
    status_callback_url = (
        payload.status_callback_url or settings.twilio_effective_status_callback_url
    )
    from twilio.rest import Client

    client = Client(settings.twilio_account_sid, settings.twilio_auth_token)
    updated = client.incoming_phone_numbers(phone_number_sid).update(
        voice_url=voice_url,
        voice_method="POST",
        status_callback=status_callback_url,
        status_callback_method="POST",
    )
    return {
        "status": "updated",
        "phone_number_sid": updated.sid,
        "phone_number": updated.phone_number,
        "voice_url": updated.voice_url,
        "voice_method": updated.voice_method,
        "status_callback": updated.status_callback,
        "status_callback_method": updated.status_callback_method,
    }


@app.websocket("/twilio/media-stream")
async def twilio_media_stream(websocket: WebSocket) -> None:
    if settings.voice_runtime == "pipecat":
        await run_pipecat_twilio_bot(websocket, settings, prompt_repo)
        return

    await websocket.accept()
    await websocket.send_json(
        {
            "event": "error",
            "message": "Twilio media streaming requires VOICE_RUNTIME=pipecat.",
        }
    )
    await websocket.close(code=1011)
    return
