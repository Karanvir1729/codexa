from functools import lru_cache
from typing import Any
from typing import Literal
from urllib.parse import urlparse

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


MAINSTREAM_VOICE_SPEECH_PATH = "nvidia_gradium"
MAINSTREAM_STT_PROVIDER = "nvidia_ws"
MAINSTREAM_TTS_PROVIDER = "gradium"
MAINSTREAM_OPENROUTER_STT_MODEL = "nvidia/parakeet-tdt-0.6b-v3"
MAINSTREAM_SUPERTONIC_LANGUAGE = "na"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), extra="ignore")

    app_env: str = "development"
    database_path: str = "data/voice_agent.sqlite3"
    public_base_url: str = "http://localhost:8000"
    allowed_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:5175,http://127.0.0.1:5175"
    )

    llm_provider: Literal["mock", "nvidia", "vertex_nim", "local", "ollama", "nemotron"] = "nemotron"
    nemotron_llm_url: str = "http://nemotron-fleet-alb-1322439314.us-west-2.elb.amazonaws.com/v1"
    nemotron_llm_model: str = "nvidia/nemotron-3-super"
    nemotron_llm_api_key: str | None = None
    nvidia_api_key: str | None = None
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_model: str = "nvidia/llama-3.3-nemotron-super-49b-v1.5"
    vertex_nim_project: str | None = None
    vertex_nim_region: str = "us-east4"
    vertex_nim_endpoint_id: str | None = None
    vertex_nim_endpoint_url: str | None = None
    vertex_nim_model: str = "nvidia/llama-3.1-nemotron-nano-8b-v1"
    ollama_base_url: str = "http://localhost:11434/v1"
    ollama_api_key: str = "ollama"
    ollama_model: str = "qwen2.5:0.5b"
    ollama_keep_alive: str = "30m"
    local_llm_base_url: str = "http://localhost:5000/v1"
    local_llm_api_key: str = "dummy"
    local_llm_model: str = "Llama-3_3-Nemotron-Super-49B-v1_5"

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
    cost_guard_mock_call_usd: float = Field(default=0.0, ge=0)
    cost_guard_local_call_usd: float = Field(default=0.0, ge=0)
    cost_guard_nvidia_call_usd: float = Field(default=0.01, ge=0)
    cost_guard_nvidia_input_per_1m_tokens_usd: float = Field(default=0.0, ge=0)
    cost_guard_nvidia_output_per_1m_tokens_usd: float = Field(default=0.0, ge=0)
    cost_guard_nemotron_call_usd: float = Field(default=0.01, ge=0)
    cost_guard_nemotron_input_per_1m_tokens_usd: float = Field(default=0.0, ge=0)
    cost_guard_nemotron_output_per_1m_tokens_usd: float = Field(default=0.0, ge=0)

    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    twilio_phone_number: str | None = None
    twilio_phone_number_sid: str | None = None
    twilio_webhook_base_url: str | None = None
    twilio_voice_webhook_url: str | None = None
    twilio_sms_webhook_url: str | None = None
    twilio_status_callback_url: str | None = None
    twilio_validate_signature: bool = False
    twilio_validate_signatures: bool | None = None
    twilio_voice_mode: Literal["auto", "gather", "media_stream"] = "auto"
    twilio_gather_language: str = "en-US"
    twilio_say_voice: str = "alice"
    twilio_gather_timeout: int = Field(default=5, ge=1, le=30)
    twilio_gather_speech_timeout: str = "auto"
    twilio_gather_max_empty_turns: int = Field(default=2, ge=1, le=10)
    twilio_voice_turn_timeout_seconds: float = Field(default=8, ge=0.1, le=14)

    pipecat_cloud_ws_url: str | None = None
    pipecat_cloud_service_host: str | None = None
    voice_runtime: Literal["text", "pipecat", "local_pipecat"] = "text"
    voice_behavior_mode: Literal["assistant", "flow"] = "assistant"
    voice_flow_id: str = "active"
    voice_speech_path: Literal["nvidia_gradium"] = "nvidia_gradium"
    voice_stt_correction_enabled: bool = False
    voice_emotion_codes_enabled: bool = True
    voice_fast_model: str | None = None
    voice_balanced_model: str | None = None
    voice_reasoning_model: str | None = None
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
    cekura_api_key: str | None = None
    cekura_agent_id: str | None = None
    cekura_project_id: str | None = None
    cekura_websocket_secret: str | None = None
    cekura_webhook_secret: str | None = None
    deepgram_api_key: str | None = None
    cartesia_api_key: str | None = None
    cartesia_voice_id: str = "71a7ad14-091c-4e8e-a314-022ece01c121"
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
    local_stt_provider: Literal[
        "whisper",
        "remote_whisper",
        "whisperx",
        "mlx_whisper",
        "nvidia",
        "nvidia_ws",
        "parakeet",
        "openrouter",
        "deepgram",
        "google",
    ] = "nvidia_ws"
    local_stt_model: str = "nemotron-speech-streaming"
    local_stt_no_speech_prob: float = Field(default=0.25, ge=0, le=1)
    local_stt_temperature: float = Field(default=0.0, ge=0)
    local_stt_ttfb_timeout: float = Field(default=0.6, ge=0)
    local_stt_ttfs_p99_latency: float = Field(default=0.8, ge=0)
    local_whisper_device: Literal["auto", "cpu", "cuda"] = "auto"
    local_whisper_compute_type: str = "auto"
    remote_whisper_base_url: str = "http://127.0.0.1:7001"
    remote_whisper_timeout_seconds: float = Field(default=8, ge=0.1)
    remote_whisper_beam_size: int = Field(default=3, ge=1, le=8)
    remote_whisper_best_of: int = Field(default=3, ge=1, le=8)
    remote_whisper_initial_prompt: str | None = None
    remote_whisper_hotwords: str | None = None
    openrouter_api_key: str | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_stt_model: str = "nvidia/parakeet-tdt-0.6b-v3"
    openrouter_stt_timeout_seconds: float = Field(default=20, ge=0.1)
    openrouter_site_url: str | None = None
    openrouter_app_title: str = "Voice Agent Hackathon"
    local_whisperx_device: Literal["auto", "cpu", "cuda"] = "auto"
    local_whisperx_compute_type: str = "auto"
    local_whisperx_batch_size: int = Field(default=1, ge=1)
    local_tts_provider: Literal[
        "auto",
        "kokoro",
        "piper",
        "fish_speech",
        "voxtral",
        "supertonic",
        "gradium",
        "nvidia",
        "cartesia",
        "deepgram",
        "google",
    ] = "gradium"
    local_tts_voice: str = "YTpq7expH9539ERJ"
    local_tts_text_aggregation_mode: Literal["sentence", "token"] = "sentence"
    kokoro_download_dir: str = "/app/data/kokoro"
    piper_download_dir: str = "/app/data/piper"
    nvidia_stt_server: str = "grpc.nvcf.nvidia.com:443"
    nvidia_stt_use_ssl: bool = True
    nvidia_tts_server: str = "grpc.nvcf.nvidia.com:443"
    nvidia_tts_use_ssl: bool = True
    parakeet_api_key: str | None = None
    parakeet_server: str = "grpc.nvcf.nvidia.com:443"
    parakeet_use_ssl: bool = True
    parakeet_function_id: str = "d3fe9151-442b-4204-a70d-5fcc597fd610"
    parakeet_model: str = "parakeet-tdt-0.6b-v2"
    parakeet_language: str = "en-US"
    nvidia_asr_url: str = "ws://44.241.251.184:8080"
    nvidia_asr_sample_rate: int = Field(default=16000, ge=8000)
    nvidia_asr_preroll_seconds: float = Field(default=1.0, ge=0)
    nvidia_asr_strip_interim_prefix: bool = False
    nvidia_asr_ws_ping_interval: float = Field(default=20.0, ge=1)
    nvidia_asr_ws_ping_timeout: float = Field(default=20.0, ge=1)
    local_google_credentials: str | None = None
    local_google_credentials_path: str | None = None
    local_google_stt_location: str = "global"
    local_google_tts_location: str | None = None
    fish_speech_base_url: str = "http://127.0.0.1:8080"
    fish_speech_api_key: str | None = None
    fish_speech_reference_id: str | None = None
    fish_speech_latency: Literal["normal", "balanced"] = "normal"
    fish_speech_chunk_length: int = Field(default=300, ge=50)
    fish_speech_max_new_tokens: int = Field(default=1024, ge=0)
    fish_speech_top_p: float = Field(default=0.8, ge=0, le=1)
    fish_speech_repetition_penalty: float = Field(default=1.1, ge=0)
    fish_speech_temperature: float = Field(default=0.8, ge=0)
    fish_speech_timeout_seconds: float = Field(default=120, ge=1)
    supertonic_base_url: str = "http://127.0.0.1:7788"
    supertonic_model: str = "supertonic-3"
    supertonic_endpoint: str = "/v1/tts"
    supertonic_voice: str = "M1"
    supertonic_language: str = MAINSTREAM_SUPERTONIC_LANGUAGE
    supertonic_steps: int = Field(default=8, ge=1, le=100)
    supertonic_speed: float = Field(default=1.05, ge=0.7, le=2.0)
    supertonic_max_chunk_length: int = Field(default=300, ge=1, le=10000)
    supertonic_silence_duration: float = Field(default=0.3, ge=0, le=10)
    supertonic_response_format: Literal["wav", "flac", "ogg"] = "wav"
    supertonic_expression_mode: Literal["off", "subtle", "demo", "debug"] = "subtle"
    supertonic_max_expression_tags_per_utterance: int = Field(default=1, ge=0, le=2)
    supertonic_timeout_seconds: float = Field(default=60, ge=1)
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
    voxtral_tts_base_url: str = "http://127.0.0.1:8002/v1"
    voxtral_tts_api_key: str | None = None
    voxtral_tts_model: str = "mistralai/Voxtral-4B-TTS-2603"
    voxtral_tts_voice: str | None = "neutral_female"
    voxtral_tts_voice_id: str | None = None
    voxtral_tts_language: str | None = "Auto"
    voxtral_tts_instructions: str | None = (
        "Speak naturally, warmly, and quickly. Match the user's language when possible. "
        "Keep emotional tone calm and helpful unless the text clearly asks for a different tone."
    )
    voxtral_tts_ref_audio_path: str | None = None
    voxtral_tts_whisper_ref_audio_path: str | None = None
    voxtral_tts_ref_audio_enabled: bool = False
    voxtral_tts_response_format: Literal["pcm", "wav"] = "wav"
    voxtral_tts_stream: bool = False
    voxtral_tts_pcm_encoding: Literal["int16", "float32"] = "int16"
    voxtral_tts_speed: float = Field(default=1.0, ge=0.5, le=2.0)
    voxtral_tts_initial_codec_chunk_frames: int | None = Field(default=None, ge=1)
    voxtral_tts_timeout_seconds: float = Field(default=120, ge=1)
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

    gcp_project_id: str | None = None
    gcp_zone: str = "us-central1-a"
    gcp_vllm_instance_name: str = "voice-agent-vllm"
    cloud_vllm_autostart_enabled: bool = False
    cloud_vllm_stop_on_idle_enabled: bool = True
    cloud_vllm_stop_on_backend_shutdown: bool = False
    cloud_vllm_idle_shutdown_seconds: int = Field(default=300, ge=30)
    cloud_vllm_start_timeout_seconds: int = Field(default=900, ge=30)
    cloud_vllm_poll_seconds: float = Field(default=5, ge=1)
    cloud_vllm_health_timeout_seconds: float = Field(default=2, ge=0.25)
    cloud_vllm_health_path: str = "/models"
    cloud_vllm_control_plane: Literal["auto", "metadata", "gcloud"] = "auto"
    cloud_vllm_gcloud_command: str = "gcloud"
    cloud_vllm_ip_mode: Literal["configured", "internal", "external"] = "configured"

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @field_validator("voxtral_tts_initial_codec_chunk_frames", mode="before")
    @classmethod
    def _empty_int_is_none(cls, value):
        if value == "":
            return None
        return value

    @field_validator("voice_fast_model", "voice_balanced_model", "voice_reasoning_model", mode="before")
    @classmethod
    def _empty_model_is_none(cls, value):
        if value == "":
            return None
        return value

    @field_validator("voice_speech_path", mode="before")
    @classmethod
    def _legacy_speech_path_is_nvidia_gradium(cls, value):
        if value in (None, "", "current", "supertone_parakeet"):
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
    def twilio_effective_from_number(self) -> str | None:
        return self.twilio_from_number or self.twilio_phone_number

    @property
    def twilio_effective_public_base_url(self) -> str:
        if self.twilio_webhook_base_url:
            return self.twilio_webhook_base_url.rstrip("/")
        if self.twilio_voice_webhook_url:
            parsed = urlparse(self.twilio_voice_webhook_url)
            if parsed.scheme and parsed.netloc:
                return f"{parsed.scheme}://{parsed.netloc}"
        return self.public_base_url.rstrip("/")

    @property
    def twilio_effective_voice_webhook_url(self) -> str:
        return self.twilio_voice_webhook_url or (
            f"{self.twilio_effective_public_base_url}/twilio/inbound"
        )

    @property
    def twilio_effective_status_callback_url(self) -> str:
        return self.twilio_status_callback_url or (
            f"{self.twilio_effective_public_base_url}/twilio/status"
        )

    @property
    def twilio_should_validate_signature(self) -> bool:
        return bool(self.twilio_validate_signature or self.twilio_validate_signatures)

    @property
    def active_model(self) -> str:
        if self.llm_provider == "local":
            return self.local_llm_model
        if self.llm_provider == "ollama":
            return self.ollama_model
        if self.llm_provider == "nemotron":
            return self.nemotron_llm_model
        if self.llm_provider == "nvidia":
            return self.nvidia_model
        if self.llm_provider == "vertex_nim":
            return self.vertex_nim_model
        return "mock-agent"

    @property
    def active_base_url(self) -> str | None:
        if self.llm_provider == "local":
            return self.local_llm_base_url
        if self.llm_provider == "ollama":
            return self.ollama_base_url
        if self.llm_provider == "nemotron":
            return self.nemotron_llm_url
        if self.llm_provider == "nvidia":
            return self.nvidia_base_url
        return None

    @property
    def active_api_key(self) -> str | None:
        if self.llm_provider == "local":
            return self.local_llm_api_key
        if self.llm_provider == "ollama":
            return self.ollama_api_key
        if self.llm_provider == "nemotron":
            return self.nemotron_llm_api_key
        if self.llm_provider == "nvidia":
            return self.nvidia_api_key or self.parakeet_api_key
        return None

    @property
    def active_requires_api_key(self) -> bool:
        return self.llm_provider not in {"mock", "nemotron"}


@lru_cache
def get_settings() -> Settings:
    return Settings()


def settings_for_speech_path(settings: Settings, speech_path: str | None) -> Settings:
    normalized = (speech_path or settings.voice_speech_path or MAINSTREAM_VOICE_SPEECH_PATH).strip()
    if normalized in {"current", "supertone_parakeet"}:
        normalized = MAINSTREAM_VOICE_SPEECH_PATH
    if normalized != MAINSTREAM_VOICE_SPEECH_PATH:
        raise ValueError(f"Unsupported voice speech path: {normalized}")
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
