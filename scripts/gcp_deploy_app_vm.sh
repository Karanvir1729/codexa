#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STARTUP_SCRIPT="${STARTUP_SCRIPT:-${ROOT_DIR}/infra/gcp/startup-app.sh}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command gcloud
require_command curl

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project <project-id>" >&2
  exit 1
fi

ZONE="${GCP_APP_ZONE:-${GCP_ZONE:-us-central1-a}}"
INSTANCE_NAME="${GCP_APP_INSTANCE_NAME:-voice-agent-app}"
MACHINE_TYPE="${GCP_APP_MACHINE_TYPE:-e2-standard-4}"
IMAGE_FAMILY="${GCP_APP_IMAGE_FAMILY:-ubuntu-2204-lts}"
IMAGE_PROJECT="${GCP_APP_IMAGE_PROJECT:-ubuntu-os-cloud}"
BOOT_DISK_SIZE_GB="${GCP_APP_BOOT_DISK_SIZE_GB:-60}"
FIREWALL_RULE="${GCP_APP_FIREWALL_RULE:-voice-agent-app-8080}"
WEBRTC_FIREWALL_RULE="${GCP_APP_WEBRTC_FIREWALL_RULE:-voice-agent-app-webrtc-udp}"
NETWORK="${GCP_NETWORK:-default}"
NETWORK_TAG="${GCP_APP_NETWORK_TAG:-voice-agent-app}"
APP_PORT="${APP_PORT:-8080}"
WEBRTC_UDP_PORT_RANGE="${WEBRTC_UDP_PORT_RANGE:-32768-60999}"
REMOTE_DIR="${REMOTE_DIR:-/opt/voice-agent}"

if [[ "${GCP_BILLING_ACK:-false}" != "true" && "${DRY_RUN:-false}" != "true" ]]; then
  cat >&2 <<'EOF'
Refusing to launch paid GCP VM capacity without GCP_BILLING_ACK=true.
This creates a CPU VM for FastAPI, Pipecat, and the React console.
EOF
  exit 1
fi

CURRENT_IP="$(curl -fsS https://ifconfig.me 2>/dev/null || true)"
ALLOWED_CIDR="${ALLOWED_CIDR:-${CURRENT_IP:+${CURRENT_IP}/32}}"
if [[ -z "$ALLOWED_CIDR" ]]; then
  echo "Set ALLOWED_CIDR, for example 203.0.113.10/32." >&2
  exit 1
fi

if [[ -z "${LOCAL_LLM_BASE_URL:-}" && -n "${GCP_VLLM_INSTANCE_NAME:-}" ]]; then
  VLLM_ZONE="${GCP_VLLM_ZONE:-${GCP_ZONE:-$ZONE}}"
  VLLM_PORT="${VLLM_PORT:-5000}"
  VLLM_INTERNAL_IP="$(gcloud compute instances describe "$GCP_VLLM_INSTANCE_NAME" --project "$PROJECT_ID" --zone "$VLLM_ZONE" --format='get(networkInterfaces[0].networkIP)')"
  LOCAL_LLM_BASE_URL="http://${VLLM_INTERNAL_IP}:${VLLM_PORT}/v1"
fi

if [[ -z "${LOCAL_LLM_BASE_URL:-}" ]]; then
  echo "Set LOCAL_LLM_BASE_URL, or set GCP_VLLM_INSTANCE_NAME so this script can infer the same-VPC vLLM endpoint." >&2
  exit 1
fi

LOCAL_LLM_MODEL="${LOCAL_LLM_MODEL:-${SERVED_MODEL_NAME:-Llama-3.1-Nemotron-Nano-8B-v1}}"
LOCAL_LLM_API_KEY="${LOCAL_LLM_API_KEY:-${VLLM_API_KEY:-dummy}}"
VOICE_RUNTIME="${VOICE_RUNTIME:-local_pipecat}"
LLM_PROVIDER="${LLM_PROVIDER:-local}"
LOCAL_STT_MODEL="${LOCAL_STT_MODEL:-base}"
LOCAL_STT_LANGUAGE="${LOCAL_STT_LANGUAGE:-auto}"
LOCAL_STT_NO_SPEECH_PROB="${LOCAL_STT_NO_SPEECH_PROB:-0.25}"
LOCAL_VAD_CONFIDENCE="${LOCAL_VAD_CONFIDENCE:-0.68}"
LOCAL_VAD_START_SECS="${LOCAL_VAD_START_SECS:-0.05}"
LOCAL_VAD_STOP_SECS="${LOCAL_VAD_STOP_SECS:-0.12}"
LOCAL_VAD_MIN_VOLUME="${LOCAL_VAD_MIN_VOLUME:-0.36}"
LOCAL_VAD_SPEECH_ACTIVITY_PERIOD="${LOCAL_VAD_SPEECH_ACTIVITY_PERIOD:-0.05}"
LOCAL_VAD_AUDIO_IDLE_TIMEOUT="${LOCAL_VAD_AUDIO_IDLE_TIMEOUT:-0.35}"
LOCAL_USER_SPEECH_TIMEOUT="${LOCAL_USER_SPEECH_TIMEOUT:-0.16}"
LOCAL_USER_TURN_STOP_TIMEOUT="${LOCAL_USER_TURN_STOP_TIMEOUT:-0.3}"

if gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" >/dev/null 2>&1; then
  if [[ "${REUSE_EXISTING:-false}" == "true" ]]; then
    echo "Reusing existing instance $INSTANCE_NAME."
  elif [[ "${DELETE_EXISTING:-false}" != "true" ]]; then
    echo "Instance $INSTANCE_NAME already exists. Set DELETE_EXISTING=true to recreate it, or SSH in and run docker compose pull/up manually." >&2
    exit 1
  else
    gcloud compute instances delete "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --quiet
  fi
fi

firewall_cmd=(gcloud compute firewall-rules create "$FIREWALL_RULE"
  --project "$PROJECT_ID"
  --network "$NETWORK"
  --allow "tcp:${APP_PORT}"
  --source-ranges "$ALLOWED_CIDR"
  --target-tags "$NETWORK_TAG"
  --description "Restrict voice-agent app console access")
if gcloud compute firewall-rules describe "$FIREWALL_RULE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  firewall_cmd=(gcloud compute firewall-rules update "$FIREWALL_RULE"
    --project "$PROJECT_ID"
    --source-ranges "$ALLOWED_CIDR")
fi

webrtc_firewall_cmd=(gcloud compute firewall-rules create "$WEBRTC_FIREWALL_RULE"
  --project "$PROJECT_ID"
  --network "$NETWORK"
  --allow "udp:${WEBRTC_UDP_PORT_RANGE}"
  --source-ranges "0.0.0.0/0"
  --target-tags "$NETWORK_TAG"
  --description "Allow browser WebRTC media candidates to reach the Pipecat backend")
if gcloud compute firewall-rules describe "$WEBRTC_FIREWALL_RULE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  webrtc_firewall_cmd=(gcloud compute firewall-rules update "$WEBRTC_FIREWALL_RULE"
    --project "$PROJECT_ID"
    --allow "udp:${WEBRTC_UDP_PORT_RANGE}"
    --source-ranges "0.0.0.0/0")
fi

create_cmd=(gcloud compute instances create "$INSTANCE_NAME"
  --project "$PROJECT_ID"
  --zone "$ZONE"
  --machine-type "$MACHINE_TYPE"
  --image-family "$IMAGE_FAMILY"
  --image-project "$IMAGE_PROJECT"
  --boot-disk-size "${BOOT_DISK_SIZE_GB}GB"
  --boot-disk-type pd-balanced
  --scopes cloud-platform
  --tags "$NETWORK_TAG"
  --metadata-from-file "startup-script=${STARTUP_SCRIPT}")

if [[ "${DRY_RUN:-false}" == "true" ]]; then
  printf '%q ' "${firewall_cmd[@]}"; printf '\n'
  printf '%q ' "${webrtc_firewall_cmd[@]}"; printf '\n'
  printf '%q ' "${create_cmd[@]}"; printf '\n'
  exit 0
fi

"${firewall_cmd[@]}"
"${webrtc_firewall_cmd[@]}"
if [[ "${REUSE_EXISTING:-false}" != "true" ]]; then
  "${create_cmd[@]}"
fi

echo "Waiting for SSH on $INSTANCE_NAME..."
for _ in {1..60}; do
  if gcloud compute ssh "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --command "true" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

tmp_env="$(mktemp)"
cat >"$tmp_env" <<ENV
APP_ENV=production
DATABASE_PATH=data/voice_agent.sqlite3
PUBLIC_BASE_URL=http://$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)'):${APP_PORT}
ALLOWED_ORIGINS=*
LLM_PROVIDER=${LLM_PROVIDER}
LOCAL_LLM_BASE_URL=${LOCAL_LLM_BASE_URL}
LOCAL_LLM_API_KEY=${LOCAL_LLM_API_KEY}
LOCAL_LLM_MODEL=${LOCAL_LLM_MODEL}
NVIDIA_API_KEY=${NVIDIA_API_KEY:-}
NVIDIA_BASE_URL=${NVIDIA_BASE_URL:-https://integrate.api.nvidia.com/v1}
NVIDIA_MODEL=${NVIDIA_MODEL:-mistralai/mistral-nemotron}
VERTEX_NIM_PROJECT=${VERTEX_NIM_PROJECT:-}
VERTEX_NIM_REGION=${VERTEX_NIM_REGION:-us-east4}
VERTEX_NIM_ENDPOINT_ID=${VERTEX_NIM_ENDPOINT_ID:-}
VERTEX_NIM_ENDPOINT_URL=${VERTEX_NIM_ENDPOINT_URL:-}
VERTEX_NIM_MODEL=${VERTEX_NIM_MODEL:-nvidia/llama-3.1-nemotron-nano-8b-v1}
REASONING_MODE=${REASONING_MODE:-off}
MAX_COMPLETION_TOKENS=${MAX_COMPLETION_TOKENS:-32}
LLM_TIMEOUT_SECONDS=${LLM_TIMEOUT_SECONDS:-15}
LLM_WARMUP_ENABLED=${LLM_WARMUP_ENABLED:-true}
VOICE_LLM_CONTEXT_MESSAGES=${VOICE_LLM_CONTEXT_MESSAGES:-8}
VOICE_LLM_CONTEXT_MAX_CHARS=${VOICE_LLM_CONTEXT_MAX_CHARS:-700}
VOICE_RUNTIME=${VOICE_RUNTIME}
LOCAL_VOICE_LANGUAGE=${LOCAL_VOICE_LANGUAGE:-en}
LOCAL_STT_PROVIDER=${LOCAL_STT_PROVIDER:-whisper}
LOCAL_STT_MODEL=${LOCAL_STT_MODEL}
LOCAL_STT_LANGUAGE=${LOCAL_STT_LANGUAGE}
LOCAL_STT_NO_SPEECH_PROB=${LOCAL_STT_NO_SPEECH_PROB}
LOCAL_WHISPER_DEVICE=${LOCAL_WHISPER_DEVICE:-cpu}
LOCAL_WHISPER_COMPUTE_TYPE=${LOCAL_WHISPER_COMPUTE_TYPE:-int8}
REMOTE_WHISPER_BASE_URL=${REMOTE_WHISPER_BASE_URL:-http://127.0.0.1:7001}
REMOTE_WHISPER_TIMEOUT_SECONDS=${REMOTE_WHISPER_TIMEOUT_SECONDS:-8}
LOCAL_WHISPERX_DEVICE=${LOCAL_WHISPERX_DEVICE:-cpu}
LOCAL_WHISPERX_COMPUTE_TYPE=${LOCAL_WHISPERX_COMPUTE_TYPE:-int8}
LOCAL_TTS_PROVIDER=${LOCAL_TTS_PROVIDER:-kokoro}
LOCAL_TTS_TEXT_AGGREGATION_MODE=${LOCAL_TTS_TEXT_AGGREGATION_MODE:-sentence}
LOCAL_TTS_LANGUAGE=${LOCAL_TTS_LANGUAGE:-en}
LOCAL_TTS_VOICE=${LOCAL_TTS_VOICE:-af_heart}
KOKORO_DOWNLOAD_DIR=${KOKORO_DOWNLOAD_DIR:-/app/data/kokoro}
PIPER_DOWNLOAD_DIR=${PIPER_DOWNLOAD_DIR:-/app/data/piper}
FISH_SPEECH_BASE_URL=${FISH_SPEECH_BASE_URL:-http://127.0.0.1:8080}
FISH_SPEECH_API_KEY=${FISH_SPEECH_API_KEY:-}
FISH_SPEECH_REFERENCE_ID=${FISH_SPEECH_REFERENCE_ID:-}
FISH_SPEECH_LATENCY=${FISH_SPEECH_LATENCY:-normal}
FISH_SPEECH_CHUNK_LENGTH=${FISH_SPEECH_CHUNK_LENGTH:-300}
FISH_SPEECH_MAX_NEW_TOKENS=${FISH_SPEECH_MAX_NEW_TOKENS:-1024}
FISH_SPEECH_TOP_P=${FISH_SPEECH_TOP_P:-0.8}
FISH_SPEECH_REPETITION_PENALTY=${FISH_SPEECH_REPETITION_PENALTY:-1.1}
FISH_SPEECH_TEMPERATURE=${FISH_SPEECH_TEMPERATURE:-0.8}
FISH_SPEECH_TIMEOUT_SECONDS=${FISH_SPEECH_TIMEOUT_SECONDS:-120}
VOXTRAL_TTS_BASE_URL=${VOXTRAL_TTS_BASE_URL:-http://127.0.0.1:8002/v1}
VOXTRAL_TTS_API_KEY=${VOXTRAL_TTS_API_KEY:-}
VOXTRAL_TTS_MODEL=${VOXTRAL_TTS_MODEL:-mistralai/Voxtral-4B-TTS-2603}
VOXTRAL_TTS_VOICE=${VOXTRAL_TTS_VOICE:-neutral_female}
VOXTRAL_TTS_VOICE_ID=${VOXTRAL_TTS_VOICE_ID:-}
VOXTRAL_TTS_LANGUAGE=${VOXTRAL_TTS_LANGUAGE:-Auto}
VOXTRAL_TTS_INSTRUCTIONS=${VOXTRAL_TTS_INSTRUCTIONS:-}
VOXTRAL_TTS_REF_AUDIO_PATH=${VOXTRAL_TTS_REF_AUDIO_PATH:-}
VOXTRAL_TTS_RESPONSE_FORMAT=${VOXTRAL_TTS_RESPONSE_FORMAT:-wav}
VOXTRAL_TTS_STREAM=${VOXTRAL_TTS_STREAM:-false}
VOXTRAL_TTS_INITIAL_CODEC_CHUNK_FRAMES=${VOXTRAL_TTS_INITIAL_CODEC_CHUNK_FRAMES:-}
VOXTRAL_TTS_TIMEOUT_SECONDS=${VOXTRAL_TTS_TIMEOUT_SECONDS:-120}
LOCAL_VAD_CONFIDENCE=${LOCAL_VAD_CONFIDENCE}
LOCAL_VAD_START_SECS=${LOCAL_VAD_START_SECS}
LOCAL_VAD_STOP_SECS=${LOCAL_VAD_STOP_SECS}
LOCAL_VAD_MIN_VOLUME=${LOCAL_VAD_MIN_VOLUME}
LOCAL_VAD_SPEECH_ACTIVITY_PERIOD=${LOCAL_VAD_SPEECH_ACTIVITY_PERIOD}
LOCAL_VAD_AUDIO_IDLE_TIMEOUT=${LOCAL_VAD_AUDIO_IDLE_TIMEOUT}
LOCAL_USER_SPEECH_TIMEOUT=${LOCAL_USER_SPEECH_TIMEOUT}
LOCAL_USER_TURN_STOP_TIMEOUT=${LOCAL_USER_TURN_STOP_TIMEOUT}
NVIDIA_STT_SERVER=${NVIDIA_STT_SERVER:-grpc.nvcf.nvidia.com:443}
NVIDIA_STT_USE_SSL=${NVIDIA_STT_USE_SSL:-true}
NVIDIA_TTS_SERVER=${NVIDIA_TTS_SERVER:-grpc.nvcf.nvidia.com:443}
NVIDIA_TTS_USE_SSL=${NVIDIA_TTS_USE_SSL:-true}
LOCAL_GOOGLE_CREDENTIALS=${LOCAL_GOOGLE_CREDENTIALS:-}
LOCAL_GOOGLE_CREDENTIALS_PATH=${LOCAL_GOOGLE_CREDENTIALS_PATH:-}
LOCAL_GOOGLE_STT_LOCATION=${LOCAL_GOOGLE_STT_LOCATION:-global}
LOCAL_GOOGLE_TTS_LOCATION=${LOCAL_GOOGLE_TTS_LOCATION:-}
SMALL_WEBRTC_ICE_SERVERS=${SMALL_WEBRTC_ICE_SERVERS:-stun:stun.l.google.com:19302}
SMALL_WEBRTC_TURN_URLS=${SMALL_WEBRTC_TURN_URLS:-}
SMALL_WEBRTC_TURN_USERNAME=${SMALL_WEBRTC_TURN_USERNAME:-}
SMALL_WEBRTC_TURN_CREDENTIAL=${SMALL_WEBRTC_TURN_CREDENTIAL:-}
LATENCY_TARGET_MS=${LATENCY_TARGET_MS:-1200}
COST_GUARD_ENABLED=${COST_GUARD_ENABLED:-true}
COST_GUARD_CAP_USD=${COST_GUARD_CAP_USD:-95}
TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID:-}
TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN:-}
TWILIO_FROM_NUMBER=${TWILIO_FROM_NUMBER:-}
TWILIO_VALIDATE_SIGNATURE=${TWILIO_VALIDATE_SIGNATURE:-false}
DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY:-}
CARTESIA_API_KEY=${CARTESIA_API_KEY:-}
CARTESIA_VOICE_ID=${CARTESIA_VOICE_ID:-71a7ad14-091c-4e8e-a314-022ece01c121}
ENV

gcloud compute ssh "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --command "sudo mkdir -p '${REMOTE_DIR}' && sudo chown \"\$USER\" '${REMOTE_DIR}'"
repo_archive="$(mktemp -t voice-agent-app.XXXXXX.tar.gz)"
COPYFILE_DISABLE=1 tar --no-xattrs \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude '.DS_Store' \
  --exclude '._*' \
  --exclude '__pycache__' \
  --exclude '.pytest_cache' \
  --exclude '.ruff_cache' \
  --exclude 'backend/.ruff_cache' \
  --exclude 'backend/.pytest_cache' \
  --exclude 'frontend/node_modules' \
  --exclude 'frontend/dist' \
  --exclude 'frontend/tsconfig.tsbuildinfo' \
  --exclude 'data' \
  -C "$ROOT_DIR" \
  -czf "$repo_archive" \
  backend frontend infra scripts .env.example README.md
gcloud compute scp "$repo_archive" "$INSTANCE_NAME:/tmp/voice-agent-app.tar.gz" --project "$PROJECT_ID" --zone "$ZONE"
rm -f "$repo_archive"
gcloud compute ssh "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --command "sudo rm -rf '${REMOTE_DIR}/backend' '${REMOTE_DIR}/frontend' '${REMOTE_DIR}/infra' '${REMOTE_DIR}/scripts' && mkdir -p '${REMOTE_DIR}' && tar -xzf /tmp/voice-agent-app.tar.gz -C '${REMOTE_DIR}'"
gcloud compute scp "$tmp_env" "$INSTANCE_NAME:${REMOTE_DIR}/.env" --project "$PROJECT_ID" --zone "$ZONE"
rm -f "$tmp_env"

gcloud compute ssh "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --command "cd '${REMOTE_DIR}' && mkdir -p data && if sudo docker compose version >/dev/null 2>&1; then sudo docker compose -f infra/gcp/docker-compose.app.yml up -d --build; else sudo docker-compose -f infra/gcp/docker-compose.app.yml up -d --build; fi"

APP_IP="$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
cat <<EOF

GCP app VM deployed.
Console: http://${APP_IP}:${APP_PORT}
Backend health through proxy: http://${APP_IP}:${APP_PORT}/health

For Twilio phone traffic, put this behind HTTPS/WSS first, then set PUBLIC_BASE_URL to that HTTPS URL.
EOF
