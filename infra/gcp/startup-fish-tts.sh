#!/usr/bin/env bash
set -euo pipefail

exec > >(tee -a /var/log/voice-agent-fish-tts-startup.log | logger -t voice-agent-fish-tts-startup -s 2>/dev/console) 2>&1

metadata_attr() {
  local key="$1"
  curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" || true
}

FISH_MODEL_ID="${FISH_MODEL_ID:-$(metadata_attr fish-model-id)}"
FISH_MODEL_ID="${FISH_MODEL_ID:-fishaudio/s2-pro}"
FISH_PORT="${FISH_PORT:-$(metadata_attr fish-port)}"
FISH_PORT="${FISH_PORT:-8080}"
FISH_IMAGE="${FISH_IMAGE:-$(metadata_attr fish-image)}"
FISH_IMAGE="${FISH_IMAGE:-fishaudio/fish-speech:server-cuda}"
FISH_COMPILE="${FISH_COMPILE:-$(metadata_attr fish-compile)}"
FISH_COMPILE="${FISH_COMPILE:-true}"
FISH_CHECKPOINT_DIR="${FISH_CHECKPOINT_DIR:-$(metadata_attr fish-checkpoint-dir)}"
FISH_DECODER_CHECKPOINT_PATH="${FISH_DECODER_CHECKPOINT_PATH:-$(metadata_attr fish-decoder-checkpoint-path)}"
FISH_DECODER_CONFIG_NAME="${FISH_DECODER_CONFIG_NAME:-$(metadata_attr fish-decoder-config-name)}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-$(metadata_attr auto-stop-hours)}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-8}"

if [[ -z "${FISH_CHECKPOINT_DIR}" ]]; then
  case "${FISH_MODEL_ID}" in
    fishaudio/fish-speech-1.5)
      FISH_CHECKPOINT_DIR="fish-speech-1.5"
      ;;
    *)
      FISH_CHECKPOINT_DIR="s2-pro"
      ;;
  esac
fi

if [[ -z "${FISH_DECODER_CHECKPOINT_PATH}" ]]; then
  case "${FISH_CHECKPOINT_DIR}" in
    fish-speech-1.5)
      FISH_DECODER_CHECKPOINT_PATH="checkpoints/fish-speech-1.5/firefly-gan-vq-fsq-8x1024-21hz-generator.pth"
      ;;
    *)
      FISH_DECODER_CHECKPOINT_PATH="checkpoints/s2-pro/codec.pth"
      ;;
  esac
fi

if [[ -z "${FISH_DECODER_CONFIG_NAME}" ]]; then
  case "${FISH_CHECKPOINT_DIR}" in
    fish-speech-1.5)
      FISH_DECODER_CONFIG_NAME="firefly_gan_vq"
      ;;
    *)
      FISH_DECODER_CONFIG_NAME="modded_dac_vq"
      ;;
  esac
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  docker.io \
  gnupg \
  python3-pip

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi is missing. Use a GCP Deep Learning VM image with NVIDIA drivers preinstalled." >&2
  exit 1
fi
nvidia-smi

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

python3 -m pip install --upgrade --break-system-packages "huggingface_hub[hf_xet]" || \
  python3 -m pip install --upgrade "huggingface_hub[hf_xet]"

mkdir -p "/opt/fish-speech/checkpoints/${FISH_CHECKPOINT_DIR}" /opt/fish-speech/references
chown -R 1000:1000 /opt/fish-speech/references
if [[ ! -f "/opt/fish-speech/checkpoints/${FISH_CHECKPOINT_DIR}/config.json" ]]; then
  hf download "${FISH_MODEL_ID}" --local-dir "/opt/fish-speech/checkpoints/${FISH_CHECKPOINT_DIR}"
fi

docker rm -f fish-speech-server >/dev/null 2>&1 || true
docker pull "${FISH_IMAGE}"

compile_env=0
if [[ "${FISH_COMPILE}" == "true" || "${FISH_COMPILE}" == "1" ]]; then
  compile_env=1
fi

docker run -d \
  --name fish-speech-server \
  --restart unless-stopped \
  --gpus all \
  -p "${FISH_PORT}:8080" \
  -v /opt/fish-speech/checkpoints:/app/checkpoints \
  -v /opt/fish-speech/references:/app/references \
  -e "API_SERVER_NAME=0.0.0.0" \
  -e "API_SERVER_PORT=8080" \
  -e "LLAMA_CHECKPOINT_PATH=checkpoints/${FISH_CHECKPOINT_DIR}" \
  -e "DECODER_CHECKPOINT_PATH=${FISH_DECODER_CHECKPOINT_PATH}" \
  -e "DECODER_CONFIG_NAME=${FISH_DECODER_CONFIG_NAME}" \
  -e "COMPILE=${compile_env}" \
  "${FISH_IMAGE}"

if [[ "${AUTO_STOP_HOURS}" != "0" ]]; then
  systemd-run --unit=voice-agent-fish-tts-auto-stop --on-active="${AUTO_STOP_HOURS}h" /usr/sbin/shutdown -h now || true
fi

echo "Fish Speech TTS startup configured on port ${FISH_PORT}."
echo "Watch logs with: sudo docker logs -f fish-speech-server"
