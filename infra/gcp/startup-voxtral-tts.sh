#!/usr/bin/env bash
set -euo pipefail

exec > >(tee -a /var/log/voice-agent-voxtral-tts-startup.log | logger -t voice-agent-voxtral-tts-startup -s 2>/dev/console) 2>&1

metadata_attr() {
  local key="$1"
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" || true
}

VOXTRAL_MODEL_ID="${VOXTRAL_MODEL_ID:-$(metadata_attr voxtral-model-id)}"
VOXTRAL_MODEL_ID="${VOXTRAL_MODEL_ID:-mistralai/Voxtral-4B-TTS-2603}"
VOXTRAL_PORT="${VOXTRAL_PORT:-$(metadata_attr voxtral-port)}"
VOXTRAL_PORT="${VOXTRAL_PORT:-8000}"
VOXTRAL_IMAGE="${VOXTRAL_IMAGE:-$(metadata_attr voxtral-image)}"
VOXTRAL_IMAGE="${VOXTRAL_IMAGE:-vllm/vllm-omni:v0.18.0}"
VOXTRAL_GPU_MEMORY_UTILIZATION="${VOXTRAL_GPU_MEMORY_UTILIZATION:-$(metadata_attr voxtral-gpu-memory-utilization)}"
VOXTRAL_GPU_MEMORY_UTILIZATION="${VOXTRAL_GPU_MEMORY_UTILIZATION:-0.90}"
VOXTRAL_MAX_MODEL_LEN="${VOXTRAL_MAX_MODEL_LEN:-$(metadata_attr voxtral-max-model-len)}"
VOXTRAL_MAX_MODEL_LEN="${VOXTRAL_MAX_MODEL_LEN:-4096}"
VOXTRAL_EXTRA_ARGS="${VOXTRAL_EXTRA_ARGS:-$(metadata_attr voxtral-extra-args)}"
NVIDIA_DRIVER_PACKAGE="${NVIDIA_DRIVER_PACKAGE:-$(metadata_attr nvidia-driver-package)}"
NVIDIA_DRIVER_PACKAGE="${NVIDIA_DRIVER_PACKAGE:-nvidia-driver-580}"
HF_TOKEN="${HF_TOKEN:-$(metadata_attr hf-token)}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-$(metadata_attr auto-stop-hours)}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-8}"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  docker.io \
  gnupg \
  jq

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

install -d -m 0755 /usr/share/keyrings
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list

apt-get update
apt-get install -y --no-install-recommends nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl enable --now docker
systemctl restart docker

mkdir -p /opt/huggingface
chmod 755 /opt/huggingface

docker rm -f voxtral-tts-server >/dev/null 2>&1 || true
docker pull "${VOXTRAL_IMAGE}"

read -r -a extra_args <<<"${VOXTRAL_EXTRA_ARGS}"
docker run -d \
  --name voxtral-tts-server \
  --restart unless-stopped \
  --runtime nvidia \
  --gpus all \
  --ipc=host \
  --network host \
  -v /opt/huggingface:/root/.cache/huggingface \
  -e "HF_TOKEN=${HF_TOKEN}" \
  --entrypoint vllm \
  "${VOXTRAL_IMAGE}" \
  serve "${VOXTRAL_MODEL_ID}" \
  --omni \
  --host 0.0.0.0 \
  --port "${VOXTRAL_PORT}" \
  --gpu-memory-utilization "${VOXTRAL_GPU_MEMORY_UTILIZATION}" \
  --max-model-len "${VOXTRAL_MAX_MODEL_LEN}" \
  "${extra_args[@]}"

echo "Waiting for Voxtral TTS /v1/models on port ${VOXTRAL_PORT}."
for _ in {1..120}; do
  if curl -fsS "http://127.0.0.1:${VOXTRAL_PORT}/v1/models" >/dev/null 2>&1; then
    echo "Voxtral TTS is responding."
    break
  fi
  sleep 10
done

if [[ "${AUTO_STOP_HOURS}" != "0" ]]; then
  systemd-run --unit=voice-agent-voxtral-tts-auto-stop --on-active="${AUTO_STOP_HOURS}h" /usr/sbin/shutdown -h now || true
fi

echo "Voxtral TTS startup configured for ${VOXTRAL_MODEL_ID} on port ${VOXTRAL_PORT}."
echo "Watch logs with: sudo docker logs -f voxtral-tts-server"
