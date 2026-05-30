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

require_env() {
  if [[ -z "${!1:-}" ]]; then
    echo "Missing required environment value: $1" >&2
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

require_env NVIDIA_ASR_URL
require_env NEMOTRON_LLM_URL
require_env NEMOTRON_LLM_MODEL
require_env GRADIUM_API_KEY

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
This creates a CPU VM for the FastAPI backend and React console only.
EOF
  exit 1
fi

CURRENT_IP="$(curl -fsS https://ifconfig.me 2>/dev/null || true)"
ALLOWED_CIDR="${ALLOWED_CIDR:-${CURRENT_IP:+${CURRENT_IP}/32}}"
if [[ -z "$ALLOWED_CIDR" ]]; then
  echo "Set ALLOWED_CIDR, for example 203.0.113.10/32." >&2
  exit 1
fi

if gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" >/dev/null 2>&1; then
  if [[ "${REUSE_EXISTING:-false}" == "true" ]]; then
    echo "Reusing existing instance $INSTANCE_NAME."
  elif [[ "${DELETE_EXISTING:-false}" != "true" ]]; then
    echo "Instance $INSTANCE_NAME already exists. Set DELETE_EXISTING=true to recreate it, or REUSE_EXISTING=true to update it." >&2
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

APP_IP="$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
tmp_env="$(mktemp)"
cat >"$tmp_env" <<ENV
APP_ENV=production
DATABASE_PATH=data/voice_agent.sqlite3
PUBLIC_BASE_URL=http://${APP_IP}:${APP_PORT}
ALLOWED_ORIGINS=*
LLM_PROVIDER=nemotron
NEMOTRON_LLM_URL=${NEMOTRON_LLM_URL}
NEMOTRON_LLM_MODEL=${NEMOTRON_LLM_MODEL}
NEMOTRON_LLM_API_KEY=${NEMOTRON_LLM_API_KEY:-}
VOICE_RUNTIME=local_pipecat
VOICE_SPEECH_PATH=nvidia_gradium
LOCAL_STT_PROVIDER=nvidia_ws
NVIDIA_ASR_URL=${NVIDIA_ASR_URL}
NVIDIA_ASR_SAMPLE_RATE=${NVIDIA_ASR_SAMPLE_RATE:-16000}
LOCAL_TTS_PROVIDER=gradium
GRADIUM_API_KEY=${GRADIUM_API_KEY}
GRADIUM_VAD_WS_URL=${GRADIUM_VAD_WS_URL:-wss://api.gradium.ai/api/speech/asr}
GRADIUM_TTS_WS_URL=${GRADIUM_TTS_WS_URL:-wss://api.gradium.ai/api/speech/tts}
GRADIUM_TTS_VOICE_ID=${GRADIUM_TTS_VOICE_ID:-YTpq7expH9539ERJ}
CODEX_ORCHESTRATOR_ENABLED=${CODEX_ORCHESTRATOR_ENABLED:-true}
CODEX_ORCHESTRATOR_BASE_URL=${CODEX_ORCHESTRATOR_BASE_URL:-http://127.0.0.1:4317}
SMALL_WEBRTC_ICE_SERVERS=${SMALL_WEBRTC_ICE_SERVERS:-stun:stun.l.google.com:19302}
SMALL_WEBRTC_TURN_URLS=${SMALL_WEBRTC_TURN_URLS:-}
SMALL_WEBRTC_TURN_USERNAME=${SMALL_WEBRTC_TURN_USERNAME:-}
SMALL_WEBRTC_TURN_CREDENTIAL=${SMALL_WEBRTC_TURN_CREDENTIAL:-}
CEKURA_PROJECT_ID=${CEKURA_PROJECT_ID:-5817}
CEKURA_AGENT_ID=${CEKURA_AGENT_ID:-18023}
CEKURA_WEBSOCKET_SECRET=${CEKURA_WEBSOCKET_SECRET:-}
CEKURA_WEBHOOK_SECRET=${CEKURA_WEBHOOK_SECRET:-}
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

cat <<EOF

GCP app VM deployed.
Console: http://${APP_IP}:${APP_PORT}
Backend health through proxy: http://${APP_IP}:${APP_PORT}/health
EOF
