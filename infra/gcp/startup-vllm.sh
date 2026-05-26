#!/usr/bin/env bash
set -euo pipefail

exec > >(tee -a /var/log/voice-agent-vllm-startup.log | logger -t voice-agent-vllm-startup -s 2>/dev/console) 2>&1

metadata_attr() {
  local key="$1"
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" || true
}

MODEL_ID="$(metadata_attr model-id)"
MODEL_ID="${MODEL_ID:-nvidia/Llama-3.1-Nemotron-Nano-8B-v1}"
SERVED_MODEL_NAME="$(metadata_attr served-model-name)"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-Llama-3.1-Nemotron-Nano-8B-v1}"
TENSOR_PARALLEL_SIZE="$(metadata_attr tensor-parallel-size)"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-1}"
MAX_MODEL_LEN="$(metadata_attr max-model-len)"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
MAX_NUM_SEQS="$(metadata_attr max-num-seqs)"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-16}"
GPU_MEMORY_UTILIZATION="$(metadata_attr gpu-memory-utilization)"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
VLLM_PORT="$(metadata_attr vllm-port)"
VLLM_PORT="${VLLM_PORT:-5000}"
VLLM_VERSION="$(metadata_attr vllm-version)"
VLLM_VERSION="${VLLM_VERSION:-0.10.2}"
NVIDIA_DRIVER_PACKAGE="$(metadata_attr nvidia-driver-package)"
NVIDIA_DRIVER_PACKAGE="${NVIDIA_DRIVER_PACKAGE:-nvidia-driver-570}"
HF_TOKEN="$(metadata_attr hf-token)"
VLLM_API_KEY="$(metadata_attr vllm-api-key)"
AUTO_STOP_HOURS="$(metadata_attr auto-stop-hours)"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-4}"
REMOTE_WHISPER_MODEL="$(metadata_attr remote-whisper-model)"
REMOTE_WHISPER_MODEL="${REMOTE_WHISPER_MODEL:-large-v3-turbo}"
REMOTE_WHISPER_DEVICE="$(metadata_attr remote-whisper-device)"
REMOTE_WHISPER_DEVICE="${REMOTE_WHISPER_DEVICE:-cuda}"
REMOTE_WHISPER_COMPUTE_TYPE="$(metadata_attr remote-whisper-compute-type)"
REMOTE_WHISPER_COMPUTE_TYPE="${REMOTE_WHISPER_COMPUTE_TYPE:-int8_float16}"
REMOTE_WHISPER_CPU_THREADS="$(metadata_attr remote-whisper-cpu-threads)"
REMOTE_WHISPER_CPU_THREADS="${REMOTE_WHISPER_CPU_THREADS:-4}"
REMOTE_WHISPER_NUM_WORKERS="$(metadata_attr remote-whisper-num-workers)"
REMOTE_WHISPER_NUM_WORKERS="${REMOTE_WHISPER_NUM_WORKERS:-1}"
REMOTE_WHISPER_PORT="$(metadata_attr remote-whisper-port)"
REMOTE_WHISPER_PORT="${REMOTE_WHISPER_PORT:-7001}"
REMOTE_WHISPER_MIN_RMS="$(metadata_attr remote-whisper-min-rms)"
REMOTE_WHISPER_MIN_RMS="${REMOTE_WHISPER_MIN_RMS:-0.002}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl jq python3-venv python3-pip

if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA driver is not active; installing ${NVIDIA_DRIVER_PACKAGE}."
  apt-get install -y "${NVIDIA_DRIVER_PACKAGE}"
  modprobe nvidia || true
fi

if ! nvidia-smi; then
  echo "nvidia-smi still cannot reach the GPU after driver install." >&2
  echo "Reboot the VM once if DKMS installed a new kernel module for the active kernel." >&2
  exit 1
fi

id -u vllm >/dev/null 2>&1 || useradd --system --home-dir /opt/vllm --create-home --shell /usr/sbin/nologin vllm
mkdir -p /opt/huggingface /opt/voice-agent
chown -R vllm:vllm /opt/huggingface /opt/voice-agent

if [[ ! -x /opt/vllm/bin/python ]]; then
  python3 -m venv /opt/vllm
fi
/opt/vllm/bin/pip install --upgrade pip wheel
/opt/vllm/bin/pip install "vllm==${VLLM_VERSION}"
/opt/vllm/bin/pip install "transformers>=4.56.0,<5" "tokenizers>=0.22.0,<0.23"

if [[ ! -x /opt/remote-whisper/bin/python ]]; then
  python3 -m venv /opt/remote-whisper
fi
/opt/remote-whisper/bin/pip install --upgrade pip wheel
/opt/remote-whisper/bin/pip install \
  "fastapi>=0.115.0,<1" \
  "uvicorn[standard]>=0.30.0,<1" \
  "numpy>=1.26.0,<3" \
  "faster-whisper>=1.1.0,<2"

cat >/etc/voice-agent-vllm.env <<ENV
HF_HOME=/opt/huggingface
HF_TOKEN=${HF_TOKEN}
MODEL_ID=${MODEL_ID}
SERVED_MODEL_NAME=${SERVED_MODEL_NAME}
TENSOR_PARALLEL_SIZE=${TENSOR_PARALLEL_SIZE}
MAX_MODEL_LEN=${MAX_MODEL_LEN}
MAX_NUM_SEQS=${MAX_NUM_SEQS}
GPU_MEMORY_UTILIZATION=${GPU_MEMORY_UTILIZATION}
VLLM_PORT=${VLLM_PORT}
VLLM_API_KEY=${VLLM_API_KEY}
ENV
chmod 600 /etc/voice-agent-vllm.env

cat >/etc/voice-agent-remote-whisper.env <<ENV
HF_HOME=/opt/huggingface
HF_TOKEN=${HF_TOKEN}
REMOTE_WHISPER_MODEL=${REMOTE_WHISPER_MODEL}
REMOTE_WHISPER_DEVICE=${REMOTE_WHISPER_DEVICE}
REMOTE_WHISPER_COMPUTE_TYPE=${REMOTE_WHISPER_COMPUTE_TYPE}
REMOTE_WHISPER_CPU_THREADS=${REMOTE_WHISPER_CPU_THREADS}
REMOTE_WHISPER_NUM_WORKERS=${REMOTE_WHISPER_NUM_WORKERS}
REMOTE_WHISPER_PORT=${REMOTE_WHISPER_PORT}
REMOTE_WHISPER_MIN_RMS=${REMOTE_WHISPER_MIN_RMS}
ENV
chmod 600 /etc/voice-agent-remote-whisper.env

cat >/opt/voice-agent/run-vllm.sh <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail

ARGS=(
  --model "${MODEL_ID}"
  --trust-remote-code
  --seed 1
  --host 0.0.0.0
  --port "${VLLM_PORT}"
  --served-model-name "${SERVED_MODEL_NAME}"
  --tensor-parallel-size "${TENSOR_PARALLEL_SIZE}"
  --max-model-len "${MAX_MODEL_LEN}"
  --max-num-seqs "${MAX_NUM_SEQS}"
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION}"
  --enable-prefix-caching
)

if [[ -n "${VLLM_API_KEY:-}" ]]; then
  ARGS+=(--api-key "${VLLM_API_KEY}")
fi

exec /opt/vllm/bin/python -m vllm.entrypoints.openai.api_server "${ARGS[@]}"
RUNNER
chmod 755 /opt/voice-agent/run-vllm.sh

cat >/opt/voice-agent/remote_whisper_server.py <<'PY'
from __future__ import annotations

import os
import time
from typing import Any

import numpy as np
from fastapi import FastAPI, Query, Request
from faster_whisper import WhisperModel


MODEL_NAME = os.environ.get("REMOTE_WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("REMOTE_WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("REMOTE_WHISPER_COMPUTE_TYPE", "int8_float16")
CPU_THREADS = int(os.environ.get("REMOTE_WHISPER_CPU_THREADS", "4"))
NUM_WORKERS = int(os.environ.get("REMOTE_WHISPER_NUM_WORKERS", "1"))
MIN_RMS = float(os.environ.get("REMOTE_WHISPER_MIN_RMS", "0.002"))

app = FastAPI()
model: WhisperModel | None = None


@app.on_event("startup")
def startup() -> None:
    global model
    model = WhisperModel(
        MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        cpu_threads=CPU_THREADS,
        num_workers=NUM_WORKERS,
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }


@app.post("/transcribe")
async def transcribe(
    request: Request,
    sample_rate: int = Query(16000, ge=8000),
    model: str = Query(MODEL_NAME),
    language: str | None = None,
    no_speech_prob: float | None = Query(0.35, ge=0, le=1),
) -> dict[str, Any]:
    if model != MODEL_NAME:
        return {
            "text": "",
            "language": language,
            "segments": [],
            "error": f"Worker is loaded with {MODEL_NAME}, not {model}.",
        }
    if globals()["model"] is None:
        return {"text": "", "language": language, "segments": [], "error": "model_not_loaded"}

    raw = await request.body()
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    audio_duration_s = len(audio) / sample_rate if sample_rate else 0
    audio_rms = float(np.sqrt(np.mean(np.square(audio)))) if len(audio) else 0.0
    if audio_duration_s < 0.08 or audio_rms < MIN_RMS:
        return {
            "text": "",
            "language": language,
            "language_probability": None,
            "duration": audio_duration_s,
            "audio_duration_ms": int(audio_duration_s * 1000),
            "elapsed_ms": 0,
            "realtime_factor": 0,
            "segments": [],
            "provider": "remote_whisper",
            "model": MODEL_NAME,
            "device": DEVICE,
            "compute_type": COMPUTE_TYPE,
            "audio_rms": audio_rms,
            "filtered_reason": "silence",
        }

    started = time.perf_counter()
    segments_iter, info = globals()["model"].transcribe(
        audio,
        language=language or None,
        beam_size=1,
        best_of=1,
        temperature=0.0,
        condition_on_previous_text=False,
        vad_filter=False,
    )
    segments = []
    accepted_text = []
    for segment in segments_iter:
        item = {
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
            "avg_logprob": segment.avg_logprob,
            "no_speech_prob": segment.no_speech_prob,
        }
        segments.append(item)
        if no_speech_prob is None or segment.no_speech_prob < no_speech_prob:
            accepted_text.append(segment.text.strip())

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    return {
        "text": " ".join(part for part in accepted_text if part).strip(),
        "language": getattr(info, "language", language),
        "language_probability": getattr(info, "language_probability", None),
        "duration": getattr(info, "duration", audio_duration_s),
        "audio_duration_ms": int(audio_duration_s * 1000),
        "elapsed_ms": elapsed_ms,
        "realtime_factor": round(elapsed_ms / max(1, int(audio_duration_s * 1000)), 4),
        "segments": segments,
        "provider": "remote_whisper",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
    }
PY

cat >/opt/voice-agent/run-remote-whisper.sh <<'RUNNER'
#!/usr/bin/env bash
set -euo pipefail

exec /opt/remote-whisper/bin/uvicorn remote_whisper_server:app \
  --app-dir /opt/voice-agent \
  --host 0.0.0.0 \
  --port "${REMOTE_WHISPER_PORT}"
RUNNER
chmod 755 /opt/voice-agent/run-remote-whisper.sh

cat >/etc/systemd/system/vllm.service <<'SERVICE'
[Unit]
Description=vLLM OpenAI-compatible NVIDIA model server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vllm
Group=vllm
EnvironmentFile=/etc/voice-agent-vllm.env
WorkingDirectory=/opt/voice-agent
ExecStart=/opt/voice-agent/run-vllm.sh
Restart=always
RestartSec=10
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SERVICE

cat >/etc/systemd/system/remote-whisper.service <<'SERVICE'
[Unit]
Description=Remote Faster Whisper STT server for Pipecat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vllm
Group=vllm
EnvironmentFile=/etc/voice-agent-remote-whisper.env
WorkingDirectory=/opt/voice-agent
ExecStart=/opt/voice-agent/run-remote-whisper.sh
Restart=always
RestartSec=10
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now vllm remote-whisper

if [[ "${AUTO_STOP_HOURS}" != "0" ]]; then
  systemd-run --unit=voice-agent-vllm-auto-stop --on-active="${AUTO_STOP_HOURS}h" /usr/sbin/shutdown -h now || true
fi

echo "vLLM startup configured for ${SERVED_MODEL_NAME} on port ${VLLM_PORT}."
echo "Remote Whisper startup configured for ${REMOTE_WHISPER_MODEL} on port ${REMOTE_WHISPER_PORT}."
echo "Watch logs with: sudo journalctl -u vllm -f"
