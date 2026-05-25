from __future__ import annotations

from fastapi import WebSocket

from .config import Settings
from .feedback import PromptRepository


async def run_pipecat_twilio_bot(websocket: WebSocket, settings: Settings, prompt_repo: PromptRepository) -> None:
    """Run a self-hosted Pipecat pipeline for Twilio Media Streams.

    Imports stay inside this function so local text/eval mode works without heavy
    speech dependencies. Install with `pip install -e "backend[voice]"`.
    """

    await websocket.accept()

    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.runner import PipelineRunner
    from pipecat.pipeline.task import PipelineParams, PipelineTask
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.serializers.twilio import TwilioFrameSerializer
    from pipecat.services.cartesia.tts import CartesiaTTSService
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

    start_message = await websocket.receive_json()
    if start_message.get("event") != "start":
        await websocket.close(code=1008, reason="Expected Twilio start event.")
        return
    start = start_message["start"]
    stream_sid = start["streamSid"]
    call_sid = start.get("callSid")

    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=settings.twilio_account_sid or "",
        auth_token=settings.twilio_auth_token or "",
        params=TwilioFrameSerializer.InputParams(auto_hang_up=bool(call_sid)),
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )
    llm = OpenAILLMService(
        api_key=settings.active_api_key or "missing",
        base_url=settings.active_base_url,
        settings=OpenAILLMService.Settings(
            model=settings.active_model,
            system_instruction=prompt_repo.active().compiled,
            temperature=settings.llm_temperature,
            top_p=settings.llm_top_p,
            max_completion_tokens=settings.max_completion_tokens,
        ),
    )
    stt = DeepgramSTTService(api_key=settings.deepgram_api_key or "missing")
    tts = CartesiaTTSService(
        api_key=settings.cartesia_api_key or "missing",
        settings=CartesiaTTSService.Settings(voice=settings.cartesia_voice_id),
    )
    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        await task.cancel()

    await PipelineRunner(handle_sigint=False).run(task)
