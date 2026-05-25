from __future__ import annotations

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
from .db import Database, dumps, loads
from .evaluator import EvalRunner
from .feedback import FeedbackLearner, PromptRepository
from .llm import make_llm_client
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
    suite_path: str = "backend/evals/customer_intake.yml"
    apply_feedback: bool = True


class ExportTrainingDataRequest(BaseModel):
    output_path: str = "data/sft/voice-agent-feedback.jsonl"


settings: Settings = get_settings()
db = Database(settings.database_path)
prompt_repo = PromptRepository(db)
learner = FeedbackLearner(db, prompt_repo, settings.latency_target_ms)
agent = AgentService(db, settings, make_llm_client(settings))
eval_runner = EvalRunner(db, agent, learner)

app = FastAPI(title="Voice Agent Feedback Engine", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    prompt = prompt_repo.active()
    return {
        "status": "ok",
        "environment": settings.app_env,
        "llm_provider": settings.llm_provider,
        "model": settings.active_model,
        "voice_runtime": settings.voice_runtime,
        "prompt_version": prompt.version,
        "reasoning_mode": settings.reasoning_mode,
    }


@app.get("/api/config")
async def config() -> dict[str, Any]:
    return {
        "llm_provider": settings.llm_provider,
        "model": settings.active_model,
        "base_url": settings.active_base_url,
        "voice_runtime": settings.voice_runtime,
        "twilio_ready": bool(settings.twilio_account_sid and settings.twilio_auth_token),
        "pipecat_cloud_ready": bool(settings.pipecat_cloud_ws_url and settings.pipecat_cloud_service_host),
    }


@app.post("/api/chat")
async def chat(payload: ChatRequest) -> dict[str, Any]:
    return await agent.respond(
        payload.message,
        conversation_id=payload.conversation_id,
        channel=payload.channel,
        caller=payload.caller,
        metadata=payload.metadata,
    )


@app.get("/api/conversations/{conversation_id}")
async def conversation(conversation_id: str) -> dict[str, Any]:
    return {"conversation_id": conversation_id, "turns": agent.transcript(conversation_id)}


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


@app.post("/api/evals/run")
async def run_eval(payload: EvalRunRequest) -> dict[str, Any]:
    path = Path(payload.suite_path)
    return await eval_runner.run_suite(path, apply_feedback=payload.apply_feedback)


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
