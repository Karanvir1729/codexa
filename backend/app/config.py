from functools import lru_cache
from typing import Any
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


MAINSTREAM_VOICE_SPEECH_PATH = "nvidia_gradium"
MAINSTREAM_STT_PROVIDER = "nvidia_ws"
MAINSTREAM_TTS_PROVIDER = "gradium"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), extra="ignore")

    app_env: str = "development"
    database_path: str = "data/voice_agent.sqlite3"
    public_base_url: str = "http://localhost:8000"
    allowed_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:5175,http://127.0.0.1:5175"
    )

    llm_provider: str = "nemotron"
    nemotron_llm_url: str = "http://nemotron-fleet-alb-1322439314.us-west-2.elb.amazonaws.com/v1"
    nemotron_llm_model: str = "nvidia/nemotron-3-super"
    nemotron_llm_api_key: str | None = None

    reasoning_mode: Literal["on", "off"] = "on"
    llm_temperature: float = 0.0
    llm_top_p: float = 0.95
    max_completion_tokens: int = Field(default=180, ge=16)
    llm_timeout_seconds: float = 60
    llm_warmup_enabled: bool = True
    voice_llm_context_messages: int = Field(default=8, ge=2)
    voice_llm_context_max_chars: int = Field(default=700, ge=100)

    cost_guard_enabled: bool = True
    cost_guard_cap_usd: float = Field(default=95.0, ge=0)
    cost_guard_reserve_usd_per_call: float = Field(default=0.01, ge=0)
    cost_guard_nemotron_call_usd: float = Field(default=0.01, ge=0)
    cost_guard_nemotron_input_per_1m_tokens_usd: float = Field(default=0.0, ge=0)
    cost_guard_nemotron_output_per_1m_tokens_usd: float = Field(default=0.0, ge=0)

    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    twilio_validate_signature: bool = False

    voice_runtime: Literal["text", "local_pipecat"] = "text"
    voice_behavior_mode: Literal["assistant", "flow"] = "assistant"
    voice_flow_id: str = "active"
    voice_speech_path: Literal["nvidia_gradium"] = "nvidia_gradium"
    voice_stt_correction_enabled: bool = False
    voice_emotion_codes_enabled: bool = True
    voice_default_profile: Literal["fast", "balanced", "reasoning"] = "balanced"
    voice_runtime_command_timeout_seconds: float = Field(default=8, ge=0.5)
    voice_max_llm_ttfb_ms: int = Field(default=800, ge=100)
    voice_target_first_audio_ms: int = Field(default=1500, ge=100)
    voice_vad_debounce_ms: int = Field(default=650, ge=0)
    voice_interruption_debounce_ms: int = Field(default=250, ge=0)
    voice_natural_tts_speed_min: float = Field(default=0.9, ge=0.7, le=2.0)
    voice_natural_tts_speed_max: float = Field(default=1.5, ge=0.7, le=2.0)
    voice_allow_hard_tts_speed_range: bool = False
    codex_orchestrator_enabled: bool = False
    codex_orchestrator_base_url: str = "http://127.0.0.1:4317"
    codex_orchestrator_timeout_seconds: float = Field(default=60, ge=0.5)
    codex_orchestrator_transcript_turns: int = Field(default=12, ge=2)
    codex_orchestrator_transcript_max_chars: int = Field(default=4000, ge=500)
    cekura_websocket_secret: str | None = None
    cekura_webhook_secret: str | None = None
    local_voice_language: str = "en"
    local_stt_language: str = "auto"
    local_tts_language: str = "en"
    local_audio_input_device_index: int | None = None
    local_audio_output_device_index: int | None = None
    local_audio_input_sample_rate: int = Field(default=16000, ge=8000)
    local_audio_output_sample_rate: int = Field(default=24000, ge=8000)
    local_audio_output_10ms_chunks: int = Field(default=1, ge=1)
    local_audio_output_end_silence_secs: int = Field(default=0, ge=0)
    small_webrtc_ice_servers: str = "stun:stun.l.google.com:19302"
    small_webrtc_turn_urls: str = ""
    small_webrtc_turn_username: str | None = None
    small_webrtc_turn_credential: str | None = None
    local_stt_provider: Literal["nvidia_ws"] = "nvidia_ws"
    local_stt_model: str = "nemotron-speech-streaming"
    local_stt_no_speech_prob: float = Field(default=0.25, ge=0, le=1)
    local_stt_temperature: float = Field(default=0.0, ge=0)
    local_stt_ttfb_timeout: float = Field(default=0.6, ge=0)
    local_stt_ttfs_p99_latency: float = Field(default=0.8, ge=0)
    local_tts_provider: Literal["gradium"] = "gradium"
    local_tts_voice: str = "YTpq7expH9539ERJ"
    local_tts_text_aggregation_mode: Literal["sentence", "token"] = "sentence"
    nvidia_asr_url: str = "ws://44.241.251.184:8080"
    nvidia_asr_sample_rate: int = Field(default=16000, ge=8000)
    nvidia_asr_preroll_seconds: float = Field(default=1.0, ge=0)
    nvidia_asr_strip_interim_prefix: bool = False
    nvidia_asr_ws_ping_interval: float = Field(default=20.0, ge=1)
    nvidia_asr_ws_ping_timeout: float = Field(default=20.0, ge=1)
    gradium_api_key: str | None = None
    gradium_vad_ws_url: str = "wss://api.gradium.ai/api/speech/asr"
    gradium_vad_model: str = "default"
    gradium_vad_input_format: str = "pcm_16000"
    gradium_vad_language: str = "en"
    gradium_vad_delay_in_frames: int = Field(default=8, ge=1)
    gradium_vad_start_inactivity_threshold: float = Field(default=0.35, ge=0, le=1)
    gradium_vad_stop_inactivity_threshold: float = Field(default=0.55, ge=0, le=1)
    gradium_vad_start_consecutive_steps: int = Field(default=2, ge=1)
    gradium_vad_stop_consecutive_steps: int = Field(default=3, ge=1)
    gradium_vad_sample_rate: int = Field(default=16000, ge=8000)
    gradium_tts_ws_url: str = "wss://api.gradium.ai/api/speech/tts"
    gradium_tts_model: str = "default"
    gradium_tts_voice_id: str = "YTpq7expH9539ERJ"
    gradium_tts_output_format: str = "pcm_24000"
    gradium_tts_speed: float = Field(default=1.0, ge=0.5, le=2.0)
    gradium_tts_rewrite_rules: str = "en"
    gradium_tts_timeout_seconds: float = Field(default=60, ge=1)
    local_vad_confidence: float = Field(default=0.68, ge=0, le=1)
    local_vad_start_secs: float = Field(default=0.05, ge=0)
    local_vad_stop_secs: float = Field(default=0.85, ge=0)
    local_vad_min_volume: float = Field(default=0.45, ge=0)
    local_vad_speech_activity_period: float = Field(default=0.05, ge=0)
    local_vad_audio_idle_timeout: float = Field(default=1.3, ge=0)
    local_user_speech_timeout: float = Field(default=0.75, ge=0)
    local_user_turn_stop_timeout: float = Field(default=1.6, ge=0.1)

    latency_target_ms: int = Field(default=1200, ge=100)
    eval_suite_path: str = "backend/evals/conversational_voice.yml"
    eval_schedule_seconds: int = Field(default=0, ge=0)
    eval_schedule_apply_feedback: bool = True

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @field_validator("llm_provider", mode="before")
    @classmethod
    def _legacy_llm_provider_is_nemotron(cls, value):
        if value is None or str(value).strip() == "":
            return "nemotron"
        return str(value).strip()

    @field_validator("local_stt_provider", mode="before")
    @classmethod
    def _legacy_stt_provider_is_nvidia_ws(cls, value):
        if value != "nvidia_ws":
            return "nvidia_ws"
        return value

    @field_validator("local_tts_provider", mode="before")
    @classmethod
    def _legacy_tts_provider_is_gradium(cls, value):
        if value != "gradium":
            return "gradium"
        return value

    @field_validator("voice_speech_path", mode="before")
    @classmethod
    def _legacy_speech_path_is_nvidia_gradium(cls, value):
        if value != "nvidia_gradium":
            return "nvidia_gradium"
        return value

    @property
    def small_webrtc_ice_server_list(self) -> list[str]:
        return [server.strip() for server in self.small_webrtc_ice_servers.split(",") if server.strip()]

    @property
    def small_webrtc_browser_ice_servers(self) -> list[dict[str, Any]]:
        servers: list[dict[str, Any]] = [
            {"urls": server} for server in self.small_webrtc_ice_server_list
        ]
        turn_urls = [url.strip() for url in self.small_webrtc_turn_urls.split(",") if url.strip()]
        if turn_urls and self.small_webrtc_turn_username and self.small_webrtc_turn_credential:
            servers.append(
                {
                    "urls": turn_urls,
                    "username": self.small_webrtc_turn_username,
                    "credential": self.small_webrtc_turn_credential,
                }
            )
        return servers

    @property
    def active_model(self) -> str:
        return self.nemotron_llm_model

    @property
    def active_base_url(self) -> str | None:
        return self.nemotron_llm_url

    @property
    def active_api_key(self) -> str | None:
        return self.nemotron_llm_api_key

    @property
    def active_requires_api_key(self) -> bool:
        return False


@lru_cache
def get_settings() -> Settings:
    return Settings()


def settings_for_speech_path(settings: Settings, speech_path: str | None) -> Settings:
    normalized = (speech_path or settings.voice_speech_path or MAINSTREAM_VOICE_SPEECH_PATH).strip()
    if normalized != MAINSTREAM_VOICE_SPEECH_PATH:
        normalized = MAINSTREAM_VOICE_SPEECH_PATH
    return settings.model_copy(
        update={
            "llm_provider": "nemotron",
            "voice_speech_path": MAINSTREAM_VOICE_SPEECH_PATH,
            "local_stt_provider": MAINSTREAM_STT_PROVIDER,
            "local_stt_model": "nemotron-speech-streaming",
            "local_tts_provider": MAINSTREAM_TTS_PROVIDER,
            "local_tts_voice": settings.gradium_tts_voice_id,
            "local_tts_language": settings.gradium_vad_language,
            "local_tts_text_aggregation_mode": "sentence",
            "local_audio_input_sample_rate": settings.nvidia_asr_sample_rate,
            "local_audio_output_sample_rate": 24000,
        }
    )


def mainstream_voice_path_errors(settings: Settings) -> list[str]:
    errors: list[str] = []
    if settings.voice_speech_path != MAINSTREAM_VOICE_SPEECH_PATH:
        errors.append(f"VOICE_SPEECH_PATH must be {MAINSTREAM_VOICE_SPEECH_PATH}.")
    if settings.voice_runtime != "local_pipecat":
        errors.append("VOICE_RUNTIME must be local_pipecat for the browser demo path.")
    if settings.local_stt_provider != MAINSTREAM_STT_PROVIDER:
        errors.append("LOCAL_STT_PROVIDER must be nvidia_ws for the browser demo path.")
    if not settings.nvidia_asr_url:
        errors.append("NVIDIA_ASR_URL is required for streaming STT.")
    if settings.llm_provider != "nemotron":
        errors.append("LLM_PROVIDER must be nemotron for the browser demo path.")
    if not settings.nemotron_llm_url:
        errors.append("NEMOTRON_LLM_URL is required.")
    if not settings.nemotron_llm_model:
        errors.append("NEMOTRON_LLM_MODEL is required.")
    if settings.local_tts_provider != MAINSTREAM_TTS_PROVIDER:
        errors.append("LOCAL_TTS_PROVIDER must be gradium for the browser demo path.")
    if not settings.gradium_api_key:
        errors.append("GRADIUM_API_KEY is required for Gradium VAD/TTS.")
    if not settings.codex_orchestrator_enabled:
        errors.append("CODEX_ORCHESTRATOR_ENABLED must be true for voice-to-Codexa.")
    return errors


def require_mainstream_voice_path(settings: Settings) -> None:
    errors = mainstream_voice_path_errors(settings)
    if errors:
        raise ValueError(" ".join(errors))
