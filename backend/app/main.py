from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from urllib.parse import parse_qsl
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .agent import AgentService
from .config import Settings, get_settings
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
from .twilio_routes import inbound_twiml


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
flow_repo = FlowRepository(db)
flow_runtime = FlowRuntime(db, flow_repo, make_llm_client(settings))
eval_runner = EvalRunner(db, agent, learner)
eval_scheduler = EvalScheduler(
    eval_runner,
    resolve_repo_path,
    settings.eval_suite_path,
    settings.eval_schedule_seconds,
    settings.eval_schedule_apply_feedback,
)
small_webrtc_handler = None
browser_voice_tasks: set[asyncio.Task] = set()

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
    return {
        "status": "ok",
        "environment": settings.app_env,
        "llm_provider": settings.llm_provider,
        "model": settings.active_model,
        "vertex_nim_region": settings.vertex_nim_region
        if settings.llm_provider == "vertex_nim"
        else None,
        "vertex_nim_endpoint_id": settings.vertex_nim_endpoint_id
        if settings.llm_provider == "vertex_nim"
        else None,
        "voice_runtime": settings.voice_runtime,
        "voice_behavior_mode": settings.voice_behavior_mode,
        "voice_flow_id": settings.voice_flow_id,
        "voice_emotion_codes_enabled": settings.voice_emotion_codes_enabled,
        "local_stt_provider": settings.local_stt_provider,
        "local_stt_model": settings.local_stt_model,
        "local_tts_provider": settings.local_tts_provider,
        "local_tts_voice": settings.local_tts_voice,
        "local_tts_text_aggregation_mode": settings.local_tts_text_aggregation_mode,
        "webrtc_ice_servers": len(settings.small_webrtc_browser_ice_servers),
        "voxtral_tts_model": settings.voxtral_tts_model
        if settings.local_tts_provider == "voxtral"
        else None,
        "prompt_version": prompt.version,
        "reasoning_mode": settings.reasoning_mode,
        "max_completion_tokens": settings.max_completion_tokens,
        "cost_guard": cost_guard.snapshot().to_dict(),
    }


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "llm_provider": settings.llm_provider,
        "model": settings.active_model,
        "base_url": settings.active_base_url,
        "vertex_nim_region": settings.vertex_nim_region
        if settings.llm_provider == "vertex_nim"
        else None,
        "vertex_nim_endpoint_id": settings.vertex_nim_endpoint_id
        if settings.llm_provider == "vertex_nim"
        else None,
        "voice_runtime": settings.voice_runtime,
        "voice_behavior_mode": settings.voice_behavior_mode,
        "voice_flow_id": settings.voice_flow_id,
        "voice_emotion_codes_enabled": settings.voice_emotion_codes_enabled,
        "local_stt_provider": settings.local_stt_provider,
        "local_stt_model": settings.local_stt_model,
        "local_tts_provider": settings.local_tts_provider,
        "local_tts_text_aggregation_mode": settings.local_tts_text_aggregation_mode,
        "webrtc_ice_servers": len(settings.small_webrtc_browser_ice_servers),
        "voxtral_tts_model": settings.voxtral_tts_model
        if settings.local_tts_provider == "voxtral"
        else None,
        "max_completion_tokens": settings.max_completion_tokens,
        "twilio_ready": bool(settings.twilio_account_sid and settings.twilio_auth_token),
        "pipecat_cloud_ready": bool(settings.pipecat_cloud_ws_url and settings.pipecat_cloud_service_host),
        "cost_guard": cost_guard.snapshot().to_dict(),
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
    try:
        require_openai_compatible_llm(settings)
        from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
        from pipecat.transports.smallwebrtc.request_handler import SmallWebRTCRequest
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Pipecat WebRTC dependencies are not installed. "
                'Run: .venv/bin/python -m pip install -e "backend[voice]".'
            ),
        ) from exc

    request = SmallWebRTCRequest.from_dict(payload)
    request_data = payload.get("requestData") if isinstance(payload.get("requestData"), dict) else {}
    requested_mode = str(request_data.get("voice_behavior_mode") or settings.voice_behavior_mode)
    voice_behavior_mode = requested_mode if requested_mode in {"assistant", "flow"} else settings.voice_behavior_mode
    requested_flow_id = str(request_data.get("voice_flow_id") or settings.voice_flow_id)
    session_id = str(request_data.get("conversation_id") or uuid.uuid4())

    async def webrtc_connection_callback(connection: SmallWebRTCConnection):
        task = asyncio.create_task(
            run_browser_pipecat_voice_agent(
                connection,
                settings,
                db,
                prompt_repo,
                session_id,
                voice_behavior_mode=voice_behavior_mode,
                voice_flow_id=requested_flow_id,
            )
        )
        browser_voice_tasks.add(task)
        task.add_done_callback(browser_voice_tasks.discard)

    return await get_small_webrtc_handler().handle_web_request(
        request=request,
        webrtc_connection_callback=webrtc_connection_callback,
    )


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
    return await agent.respond(
        payload.message,
        conversation_id=payload.conversation_id,
        channel=payload.channel,
        caller=payload.caller,
        metadata=payload.metadata,
    )


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


@app.post("/twilio/inbound")
async def twilio_inbound(request: Request) -> Response:
    if settings.twilio_validate_signature:
        from twilio.request_validator import RequestValidator

        if not settings.twilio_auth_token:
            raise HTTPException(status_code=500, detail="TWILIO_AUTH_TOKEN is required.")
        signature = request.headers.get("X-Twilio-Signature", "")
        raw_body = (await request.body()).decode()
        params = dict(parse_qsl(raw_body, keep_blank_values=True))
        public_url = f"{settings.public_base_url.rstrip('/')}{request.url.path}"
        validator = RequestValidator(settings.twilio_auth_token)
        if not validator.validate(public_url, params, signature):
            raise HTTPException(status_code=403, detail="Invalid Twilio signature.")
    return Response(content=inbound_twiml(settings), media_type="application/xml")


@app.websocket("/twilio/media-stream")
async def twilio_media_stream(websocket: WebSocket) -> None:
    if settings.voice_runtime == "pipecat":
        await run_pipecat_twilio_bot(websocket, settings, prompt_repo)
        return

    await websocket.accept()
    conversation_id = agent.ensure_conversation(None, "twilio", metadata={"mode": "text-fallback"})
    try:
        while True:
            message = await websocket.receive_json()
            event = message.get("event")
            if event == "start":
                db.execute(
                    """
                    INSERT INTO turns(id, conversation_id, role, content, metrics_json)
                    VALUES (?, ?, 'system', ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        conversation_id,
                        "Twilio media stream started. Set VOICE_RUNTIME=pipecat for live STT/LLM/TTS.",
                        dumps(message.get("start", {})),
                    ),
                )
                await websocket.send_json({"event": "mark", "streamSid": message["start"]["streamSid"], "mark": {"name": "ready"}})
            elif event == "media":
                continue
            elif event == "stop":
                break
    except WebSocketDisconnect:
        return
