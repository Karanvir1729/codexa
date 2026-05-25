from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    database_path: str = "data/voice_agent.sqlite3"
    public_base_url: str = "http://localhost:8000"
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    llm_provider: Literal["mock", "nvidia", "local", "ollama"] = "mock"
    nvidia_api_key: str | None = None
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_model: str = "nvidia/llama-3.3-nemotron-super-49b-v1.5"
    ollama_base_url: str = "http://localhost:11434/v1"
    ollama_api_key: str = "ollama"
    ollama_model: str = "qwen2.5:0.5b"
    local_llm_base_url: str = "http://localhost:5000/v1"
    local_llm_api_key: str = "dummy"
    local_llm_model: str = "Llama-3_3-Nemotron-Super-49B-v1_5"

    reasoning_mode: Literal["on", "off"] = "on"
    llm_temperature: float = 0.6
    llm_top_p: float = 0.95
    max_completion_tokens: int = 512
    llm_timeout_seconds: float = 60

    cost_guard_enabled: bool = True
    cost_guard_cap_usd: float = Field(default=95.0, ge=0)
    cost_guard_reserve_usd_per_call: float = Field(default=0.01, ge=0)
    cost_guard_mock_call_usd: float = Field(default=0.0, ge=0)
    cost_guard_local_call_usd: float = Field(default=0.0, ge=0)
    cost_guard_nvidia_call_usd: float = Field(default=0.01, ge=0)
    cost_guard_nvidia_input_per_1m_tokens_usd: float = Field(default=0.0, ge=0)
    cost_guard_nvidia_output_per_1m_tokens_usd: float = Field(default=0.0, ge=0)

    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    twilio_validate_signature: bool = False

    pipecat_cloud_ws_url: str | None = None
    pipecat_cloud_service_host: str | None = None
    voice_runtime: Literal["text", "pipecat", "local_pipecat"] = "text"
    deepgram_api_key: str | None = None
    cartesia_api_key: str | None = None
    cartesia_voice_id: str = "71a7ad14-091c-4e8e-a314-022ece01c121"
    local_voice_language: str = "en"
    local_audio_input_device_index: int | None = None
    local_audio_output_device_index: int | None = None
    local_audio_input_sample_rate: int = Field(default=16000, ge=8000)
    local_audio_output_sample_rate: int = Field(default=24000, ge=8000)
    local_stt_model: str = "mlx-community/whisper-tiny"
    local_stt_no_speech_prob: float = Field(default=0.6, ge=0, le=1)
    local_stt_temperature: float = Field(default=0.0, ge=0)
    local_stt_ttfs_p99_latency: float = Field(default=1.25, ge=0)
    local_tts_voice: str = "af_heart"
    local_vad_confidence: float = Field(default=0.65, ge=0, le=1)
    local_vad_start_secs: float = Field(default=0.15, ge=0)
    local_vad_stop_secs: float = Field(default=0.25, ge=0)
    local_vad_min_volume: float = Field(default=0.35, ge=0)
    local_user_speech_timeout: float = Field(default=0.45, ge=0)

    latency_target_ms: int = Field(default=1200, ge=100)
    eval_suite_path: str = "backend/evals/customer_intake.yml"
    eval_schedule_seconds: int = Field(default=0, ge=0)
    eval_schedule_apply_feedback: bool = True

    @property
    def origins(self) -> list[str]:
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def active_model(self) -> str:
        if self.llm_provider == "local":
            return self.local_llm_model
        if self.llm_provider == "ollama":
            return self.ollama_model
        if self.llm_provider == "nvidia":
            return self.nvidia_model
        return "mock-agent"

    @property
    def active_base_url(self) -> str | None:
        if self.llm_provider == "local":
            return self.local_llm_base_url
        if self.llm_provider == "ollama":
            return self.ollama_base_url
        if self.llm_provider == "nvidia":
            return self.nvidia_base_url
        return None

    @property
    def active_api_key(self) -> str | None:
        if self.llm_provider == "local":
            return self.local_llm_api_key
        if self.llm_provider == "ollama":
            return self.ollama_api_key
        if self.llm_provider == "nvidia":
            return self.nvidia_api_key
        return None


@lru_cache
def get_settings() -> Settings:
    return Settings()
