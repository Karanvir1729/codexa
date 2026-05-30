from __future__ import annotations

from fastapi import WebSocket

from .config import Settings
from .feedback import PromptRepository


async def run_pipecat_twilio_bot(
    websocket: WebSocket,
    _settings: Settings,
    _prompt_repo: PromptRepository,
) -> None:
    """Twilio voice is disabled for the single-provider browser runtime."""
    await websocket.accept()
    await websocket.close(
        code=1008,
        reason="Twilio runtime disabled; use the browser NVIDIA/Gradium voice path.",
    )
