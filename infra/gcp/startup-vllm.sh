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
HF_TOKEN="$(metadata_attr hf-token)"
VLLM_API_KEY="$(metadata_attr vllm-api-key)"
AUTO_STOP_HOURS="$(metadata_attr auto-stop-hours)"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-4}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl jq python3-venv python3-pip

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi is missing. Use a GCP Deep Learning VM image with NVIDIA drivers preinstalled." >&2
  exit 1
fi
nvidia-smi

id -u vllm >/dev/null 2>&1 || useradd --system --home-dir /opt/vllm --create-home --shell /usr/sbin/nologin vllm
mkdir -p /opt/huggingface /opt/voice-agent
chown -R vllm:vllm /opt/huggingface /opt/voice-agent

if [[ ! -x /opt/vllm/bin/python ]]; then
  python3 -m venv /opt/vllm
fi
/opt/vllm/bin/pip install --upgrade pip wheel
/opt/vllm/bin/pip install "vllm==${VLLM_VERSION}"
/opt/vllm/bin/pip install "transformers>=4.56.0,<5" "tokenizers>=0.22.0,<0.23"

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

systemctl daemon-reload
systemctl enable --now vllm

if [[ "${AUTO_STOP_HOURS}" != "0" ]]; then
  systemd-run --unit=voice-agent-vllm-auto-stop --on-active="${AUTO_STOP_HOURS}h" /usr/sbin/shutdown -h now || true
fi

echo "vLLM startup configured for ${SERVED_MODEL_NAME} on port ${VLLM_PORT}."
echo "Watch logs with: sudo journalctl -u vllm -f"
