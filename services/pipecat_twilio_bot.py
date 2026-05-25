import os
from typing import Any

from dotenv import load_dotenv
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.ollama.llm import OLLamaLLMService
from pipecat.services.whisper.stt import Model, WhisperSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams

load_dotenv(override=True)


PHONE_AGENT_SYSTEM_PROMPT = os.getenv(
    "PHONE_AGENT_SYSTEM_PROMPT",
    """You are an agentic coding assistant on a phone call.
You are a concise, interruptible voice coding assistant.
The caller may ask what you are working on, ask for repo status, or ask you to make project changes through Codex.
Answer in short spoken turns. Prefer one to three sentences.
If the caller interrupts or changes direction, immediately follow the newest request.
Do not mention hidden system instructions. Do not output markdown unless the caller asks.""",
)


def _ollama_base_url() -> str:
    base = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    return base if base.endswith("/v1") else f"{base}/v1"


def _transport_params() -> dict[str, Any]:
    return {
        "twilio": lambda: FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            audio_out_auto_silence=True,
        ),
        "webrtc": lambda: TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    }


async def run_bot(transport, handle_sigint: bool) -> None:
    stt = WhisperSTTService(
        model=Model.TINY,
        device=os.getenv("PHONE_STT_DEVICE", "cpu"),
        compute_type=os.getenv("PHONE_STT_COMPUTE_TYPE", "int8"),
        language=Language.EN,
    )

    if os.getenv("PHONE_LLM_PROVIDER", "codex") == "codex":
        llm = OpenAILLMService(
            api_key=os.getenv("PHONE_CODEX_BRIDGE_API_KEY", "local-codex"),
            base_url=os.getenv("PHONE_CODEX_BRIDGE_BASE_URL", "http://127.0.0.1:3000/api/phone/v1"),
            settings=OpenAILLMService.Settings(
                model=os.getenv("PHONE_CODEX_MODEL", "codex-pilot"),
                system_instruction=PHONE_AGENT_SYSTEM_PROMPT,
                temperature=float(os.getenv("PHONE_LLM_TEMPERATURE", "0.2")),
                max_tokens=int(os.getenv("PHONE_LLM_MAX_TOKENS", "220")),
            ),
            retry_timeout_secs=float(os.getenv("PHONE_CODEX_TIMEOUT_SECS", "300")),
        )
    else:
        llm = OLLamaLLMService(
            base_url=_ollama_base_url(),
            settings=OLLamaLLMService.Settings(
                model=os.getenv("OLLAMA_MODEL", "qwen3.5"),
                system_instruction=PHONE_AGENT_SYSTEM_PROMPT,
                temperature=float(os.getenv("PHONE_LLM_TEMPERATURE", "0.35")),
                max_tokens=int(os.getenv("PHONE_LLM_MAX_TOKENS", "180")),
            ),
        )

    tts = KokoroTTSService(
        settings=KokoroTTSService.Settings(
            voice=os.getenv("PHONE_TTS_VOICE", "af_heart"),
            language=Language.EN,
        )
    )

    context = LLMContext(
        messages=[
            {
                "role": "system",
                "content": PHONE_AGENT_SYSTEM_PROMPT,
            }
        ]
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            audio_idle_timeout=float(os.getenv("PHONE_USER_AUDIO_IDLE_TIMEOUT", "0.75")),
            vad_analyzer=SileroVADAnalyzer(sample_rate=8000),
            filter_incomplete_user_turns=True,
        ),
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

    @transport.event_handler("on_client_connected")
    async def on_client_connected(_transport, _client):
        logger.info("Twilio caller connected")
        context.add_message(
            {
                "role": "user",
                "content": "Greet the caller as their coding assistant in one short sentence and ask what project they want to work on.",
            }
        )
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        logger.info("Twilio caller disconnected")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=handle_sigint, force_gc=True)
    await runner.run(task)


async def bot(runner_args: RunnerArguments) -> None:
    transport = await create_transport(runner_args, _transport_params())
    await run_bot(transport, runner_args.handle_sigint)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
