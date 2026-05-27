#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STARTUP_SCRIPT="${STARTUP_SCRIPT:-${ROOT_DIR}/infra/gcp/startup-vllm.sh}"

log() {
  printf '[gcp-vllm] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

shell_quote() {
  printf '%q ' "$@"
  printf '\n'
}

require_command gcloud
require_command curl
require_command python3

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project <project-id>" >&2
  exit 1
fi

ZONE="${GCP_ZONE:-us-central1-a}"
REGION="${GCP_REGION:-${ZONE%-*}}"
INSTANCE_NAME="${GCP_VLLM_INSTANCE_NAME:-voice-agent-vllm}"
MACHINE_TYPE="${GCP_VLLM_MACHINE_TYPE:-g2-standard-12}"
IMAGE_PROJECT="${GCP_IMAGE_PROJECT:-deeplearning-platform-release}"
IMAGE_FAMILY="${GCP_IMAGE_FAMILY:-common-cu128-ubuntu-2204-nvidia-570}"
IMAGE_NAME="${GCP_IMAGE_NAME:-}"
BOOT_DISK_SIZE_GB="${GCP_BOOT_DISK_SIZE_GB:-250}"
BOOT_DISK_TYPE="${GCP_BOOT_DISK_TYPE:-pd-balanced}"
FIREWALL_RULE="${GCP_VLLM_FIREWALL_RULE:-voice-agent-vllm-5000}"
INTERNAL_FIREWALL_RULE="${GCP_VLLM_INTERNAL_FIREWALL_RULE:-voice-agent-vllm-internal}"
NETWORK="${GCP_NETWORK:-default}"
NETWORK_TAG="${GCP_VLLM_NETWORK_TAG:-voice-agent-vllm}"
APP_INTERNAL_CIDR="${GCP_APP_INTERNAL_CIDR:-10.0.0.0/8}"

MODEL_ID="${MODEL_ID:-nvidia/Llama-3.1-Nemotron-Nano-8B-v1}"
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-Llama-3.1-Nemotron-Nano-8B-v1}"
TENSOR_PARALLEL_SIZE="${TENSOR_PARALLEL_SIZE:-1}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-8192}"
MAX_NUM_SEQS="${MAX_NUM_SEQS:-16}"
GPU_MEMORY_UTILIZATION="${GPU_MEMORY_UTILIZATION:-0.90}"
VLLM_PORT="${VLLM_PORT:-5000}"
VLLM_VERSION="${VLLM_VERSION:-0.10.2}"
NVIDIA_DRIVER_PACKAGE="${NVIDIA_DRIVER_PACKAGE:-nvidia-driver-570}"
REMOTE_WHISPER_MODEL="${REMOTE_WHISPER_MODEL:-large-v3-turbo}"
REMOTE_WHISPER_DEVICE="${REMOTE_WHISPER_DEVICE:-cuda}"
REMOTE_WHISPER_COMPUTE_TYPE="${REMOTE_WHISPER_COMPUTE_TYPE:-int8_float16}"
REMOTE_WHISPER_CPU_THREADS="${REMOTE_WHISPER_CPU_THREADS:-4}"
REMOTE_WHISPER_NUM_WORKERS="${REMOTE_WHISPER_NUM_WORKERS:-1}"
REMOTE_WHISPER_PORT="${REMOTE_WHISPER_PORT:-7001}"
REMOTE_WHISPER_BEAM_SIZE="${REMOTE_WHISPER_BEAM_SIZE:-3}"
REMOTE_WHISPER_BEST_OF="${REMOTE_WHISPER_BEST_OF:-3}"
REMOTE_WHISPER_PATIENCE="${REMOTE_WHISPER_PATIENCE:-1.0}"
REMOTE_WHISPER_REPETITION_PENALTY="${REMOTE_WHISPER_REPETITION_PENALTY:-1.05}"
REMOTE_WHISPER_NO_REPEAT_NGRAM_SIZE="${REMOTE_WHISPER_NO_REPEAT_NGRAM_SIZE:-3}"
REMOTE_WHISPER_CONDITION_ON_PREVIOUS_TEXT="${REMOTE_WHISPER_CONDITION_ON_PREVIOUS_TEXT:-false}"
REMOTE_WHISPER_MULTILINGUAL="${REMOTE_WHISPER_MULTILINGUAL:-true}"
REMOTE_WHISPER_VAD_FILTER="${REMOTE_WHISPER_VAD_FILTER:-false}"
REMOTE_WHISPER_LANGUAGE_DETECTION_THRESHOLD="${REMOTE_WHISPER_LANGUAGE_DETECTION_THRESHOLD:-0.35}"
REMOTE_WHISPER_LANGUAGE_DETECTION_SEGMENTS="${REMOTE_WHISPER_LANGUAGE_DETECTION_SEGMENTS:-2}"
REMOTE_WHISPER_MIN_RMS="${REMOTE_WHISPER_MIN_RMS:-0.003}"
REMOTE_WHISPER_MIN_DURATION_S="${REMOTE_WHISPER_MIN_DURATION_S:-0.10}"
REMOTE_WHISPER_MIN_LANGUAGE_PROB="${REMOTE_WHISPER_MIN_LANGUAGE_PROB:-0.18}"
REMOTE_WHISPER_MIN_AVG_LOGPROB="${REMOTE_WHISPER_MIN_AVG_LOGPROB:--1.1}"
REMOTE_WHISPER_MAX_COMPRESSION_RATIO="${REMOTE_WHISPER_MAX_COMPRESSION_RATIO:-2.6}"
REMOTE_WHISPER_HALLUCINATION_MAX_DURATION_S="${REMOTE_WHISPER_HALLUCINATION_MAX_DURATION_S:-1.6}"
REMOTE_WHISPER_HALLUCINATION_MAX_RMS="${REMOTE_WHISPER_HALLUCINATION_MAX_RMS:-0.018}"
REMOTE_WHISPER_ADAPTIVE_NOISE_FLOOR="${REMOTE_WHISPER_ADAPTIVE_NOISE_FLOOR:-true}"
REMOTE_WHISPER_NOISE_FLOOR_ALPHA="${REMOTE_WHISPER_NOISE_FLOOR_ALPHA:-0.08}"
REMOTE_WHISPER_NOISE_FLOOR_MULTIPLIER="${REMOTE_WHISPER_NOISE_FLOOR_MULTIPLIER:-1.8}"
REMOTE_WHISPER_MAX_ADAPTIVE_MIN_RMS="${REMOTE_WHISPER_MAX_ADAPTIVE_MIN_RMS:-0.03}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-4}"
HUGGINGFACE_TOKEN="${HUGGINGFACE_TOKEN:-${HF_TOKEN:-}}"
VLLM_API_KEY="${VLLM_API_KEY:-}"
DRY_RUN="${DRY_RUN:-false}"
WAIT_FOR_HEALTH="${WAIT_FOR_HEALTH:-false}"

if [[ "${GCP_BILLING_ACK:-false}" != "true" && "$DRY_RUN" != "true" ]]; then
  cat >&2 <<'EOF'
Refusing to launch paid GCP GPU capacity without GCP_BILLING_ACK=true.
This creates a Compute Engine GPU VM. Set AUTO_STOP_HOURS to limit exposure.
EOF
  exit 1
fi

if [[ "$MACHINE_TYPE" != "g2-standard-12" && "${ALLOW_EXPENSIVE_PROFILE:-false}" != "true" && "$DRY_RUN" != "true" ]]; then
  echo "Refusing to deploy $MACHINE_TYPE without ALLOW_EXPENSIVE_PROFILE=true." >&2
  echo "Use g2-standard-12 for the default single-L4 profile." >&2
  exit 1
fi

if [[ ! -f "$STARTUP_SCRIPT" ]]; then
  echo "Missing startup script: $STARTUP_SCRIPT" >&2
  exit 1
fi

case "$MACHINE_TYPE" in
  g2-standard-24) GPU_COUNT=2 ;;
  g2-standard-48) GPU_COUNT=4 ;;
  g2-standard-96) GPU_COUNT=8 ;;
  *) GPU_COUNT=1 ;;
esac

CURRENT_IP="$(curl -fsS https://ifconfig.me 2>/dev/null || true)"
ALLOWED_CIDR="${ALLOWED_CIDR:-${CURRENT_IP:+${CURRENT_IP}/32}}"
if [[ -z "$ALLOWED_CIDR" ]]; then
  echo "Set ALLOWED_CIDR, for example 203.0.113.10/32." >&2
  exit 1
fi

log "Project: $PROJECT_ID"
log "Zone: $ZONE"
log "Instance: $INSTANCE_NAME ($MACHINE_TYPE, ${GPU_COUNT} L4 GPU target)"
log "Model: $MODEL_ID as $SERVED_MODEL_NAME"
log "Remote Whisper: $REMOTE_WHISPER_MODEL on port $REMOTE_WHISPER_PORT"
log "Allowed vLLM CIDR: $ALLOWED_CIDR"
log "Allowed same-VPC CIDR: $APP_INTERNAL_CIDR"
log "Auto-stop: ${AUTO_STOP_HOURS}h"

quota_json="$(gcloud compute regions describe "$REGION" --project "$PROJECT_ID" --format=json 2>/dev/null || true)"
if [[ -n "$quota_json" ]]; then
  QUOTA_JSON="$quota_json" python3 - "$GPU_COUNT" <<'PY'
import json
import os
import sys

need = float(sys.argv[1])
data = json.loads(os.environ["QUOTA_JSON"])
quotas = {item.get("metric"): item for item in data.get("quotas", [])}
quota = quotas.get("NVIDIA_L4_GPUS")
if not quota:
    print("[gcp-vllm] NVIDIA_L4_GPUS quota was not reported for this region; create may still validate it.")
    raise SystemExit(0)
limit = float(quota.get("limit", 0))
usage = float(quota.get("usage", 0))
available = limit - usage
print(f"[gcp-vllm] NVIDIA_L4_GPUS quota: limit={limit:g} usage={usage:g} available={available:g}")
if available < need:
    print(f"[gcp-vllm] Refusing to deploy: need {need:g} L4 GPU quota in this region.", file=sys.stderr)
    raise SystemExit(1)
PY
fi

if gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" >/dev/null 2>&1; then
  if [[ "${DELETE_EXISTING:-false}" != "true" ]]; then
    echo "Instance $INSTANCE_NAME already exists. Set DELETE_EXISTING=true to recreate it." >&2
    exit 1
  fi
  gcloud compute instances delete "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --quiet
fi

if gcloud compute firewall-rules describe "$FIREWALL_RULE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  firewall_cmd=(gcloud compute firewall-rules update "$FIREWALL_RULE"
    --project "$PROJECT_ID"
    --source-ranges "$ALLOWED_CIDR")
else
  firewall_cmd=(gcloud compute firewall-rules create "$FIREWALL_RULE"
    --project "$PROJECT_ID"
    --network "$NETWORK"
    --allow "tcp:${VLLM_PORT}"
    --source-ranges "$ALLOWED_CIDR"
    --target-tags "$NETWORK_TAG"
    --description "Restrict vLLM OpenAI-compatible API access for the voice agent")
fi

if gcloud compute firewall-rules describe "$INTERNAL_FIREWALL_RULE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  internal_firewall_cmd=(gcloud compute firewall-rules update "$INTERNAL_FIREWALL_RULE"
    --project "$PROJECT_ID"
    --allow "tcp:${VLLM_PORT},tcp:${REMOTE_WHISPER_PORT}"
    --source-ranges "$APP_INTERNAL_CIDR"
    --target-tags "$NETWORK_TAG")
else
  internal_firewall_cmd=(gcloud compute firewall-rules create "$INTERNAL_FIREWALL_RULE"
    --project "$PROJECT_ID"
    --network "$NETWORK"
    --allow "tcp:${VLLM_PORT},tcp:${REMOTE_WHISPER_PORT}"
    --source-ranges "$APP_INTERNAL_CIDR"
    --target-tags "$NETWORK_TAG"
    --description "Allow same-VPC app VMs to reach vLLM and remote Whisper")
fi

metadata_csv="model-id=${MODEL_ID},served-model-name=${SERVED_MODEL_NAME},tensor-parallel-size=${TENSOR_PARALLEL_SIZE},max-model-len=${MAX_MODEL_LEN},max-num-seqs=${MAX_NUM_SEQS},gpu-memory-utilization=${GPU_MEMORY_UTILIZATION},vllm-port=${VLLM_PORT},vllm-version=${VLLM_VERSION},nvidia-driver-package=${NVIDIA_DRIVER_PACKAGE},remote-whisper-model=${REMOTE_WHISPER_MODEL},remote-whisper-device=${REMOTE_WHISPER_DEVICE},remote-whisper-compute-type=${REMOTE_WHISPER_COMPUTE_TYPE},remote-whisper-cpu-threads=${REMOTE_WHISPER_CPU_THREADS},remote-whisper-num-workers=${REMOTE_WHISPER_NUM_WORKERS},remote-whisper-port=${REMOTE_WHISPER_PORT},remote-whisper-beam-size=${REMOTE_WHISPER_BEAM_SIZE},remote-whisper-best-of=${REMOTE_WHISPER_BEST_OF},remote-whisper-patience=${REMOTE_WHISPER_PATIENCE},remote-whisper-repetition-penalty=${REMOTE_WHISPER_REPETITION_PENALTY},remote-whisper-no-repeat-ngram-size=${REMOTE_WHISPER_NO_REPEAT_NGRAM_SIZE},remote-whisper-condition-on-previous-text=${REMOTE_WHISPER_CONDITION_ON_PREVIOUS_TEXT},remote-whisper-multilingual=${REMOTE_WHISPER_MULTILINGUAL},remote-whisper-vad-filter=${REMOTE_WHISPER_VAD_FILTER},remote-whisper-language-detection-threshold=${REMOTE_WHISPER_LANGUAGE_DETECTION_THRESHOLD},remote-whisper-language-detection-segments=${REMOTE_WHISPER_LANGUAGE_DETECTION_SEGMENTS},remote-whisper-min-rms=${REMOTE_WHISPER_MIN_RMS},remote-whisper-min-duration-s=${REMOTE_WHISPER_MIN_DURATION_S},remote-whisper-min-language-prob=${REMOTE_WHISPER_MIN_LANGUAGE_PROB},remote-whisper-min-avg-logprob=${REMOTE_WHISPER_MIN_AVG_LOGPROB},remote-whisper-max-compression-ratio=${REMOTE_WHISPER_MAX_COMPRESSION_RATIO},remote-whisper-hallucination-max-duration-s=${REMOTE_WHISPER_HALLUCINATION_MAX_DURATION_S},remote-whisper-hallucination-max-rms=${REMOTE_WHISPER_HALLUCINATION_MAX_RMS},remote-whisper-adaptive-noise-floor=${REMOTE_WHISPER_ADAPTIVE_NOISE_FLOOR},remote-whisper-noise-floor-alpha=${REMOTE_WHISPER_NOISE_FLOOR_ALPHA},remote-whisper-noise-floor-multiplier=${REMOTE_WHISPER_NOISE_FLOOR_MULTIPLIER},remote-whisper-max-adaptive-min-rms=${REMOTE_WHISPER_MAX_ADAPTIVE_MIN_RMS},auto-stop-hours=${AUTO_STOP_HOURS}"
if [[ -n "$VLLM_API_KEY" ]]; then
  metadata_csv="${metadata_csv},vllm-api-key=${VLLM_API_KEY}"
fi

create_cmd=(gcloud compute instances create "$INSTANCE_NAME"
  --project "$PROJECT_ID"
  --zone "$ZONE"
  --machine-type "$MACHINE_TYPE"
  --image-project "$IMAGE_PROJECT"
  --boot-disk-size "${BOOT_DISK_SIZE_GB}GB"
  --boot-disk-type "$BOOT_DISK_TYPE"
  --maintenance-policy TERMINATE
  --provisioning-model STANDARD
  --scopes cloud-platform
  --tags "$NETWORK_TAG"
  --metadata "$metadata_csv"
  --metadata-from-file "startup-script=${STARTUP_SCRIPT}")

if [[ -n "$IMAGE_NAME" ]]; then
  create_cmd+=(--image "$IMAGE_NAME")
else
  create_cmd+=(--image-family "$IMAGE_FAMILY")
fi

hf_token_file=""
if [[ -n "$HUGGINGFACE_TOKEN" ]]; then
  hf_token_file="$(mktemp)"
  printf '%s' "$HUGGINGFACE_TOKEN" >"$hf_token_file"
  create_cmd+=(--metadata-from-file "hf-token=${hf_token_file}")
fi

if [[ "$DRY_RUN" == "true" ]]; then
  shell_quote "${firewall_cmd[@]}"
  shell_quote "${internal_firewall_cmd[@]}"
  shell_quote "${create_cmd[@]}"
  [[ -n "$hf_token_file" ]] && rm -f "$hf_token_file"
  exit 0
fi

"${firewall_cmd[@]}"
"${internal_firewall_cmd[@]}"
"${create_cmd[@]}"
[[ -n "$hf_token_file" ]] && rm -f "$hf_token_file"

EXTERNAL_IP="$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
INTERNAL_IP="$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)')"

cat <<EOF

GCP vLLM VM created.

Local/backend env:
  LLM_PROVIDER=local
  LOCAL_LLM_BASE_URL=http://${EXTERNAL_IP}:${VLLM_PORT}/v1
  LOCAL_LLM_MODEL=${SERVED_MODEL_NAME}
  LOCAL_LLM_API_KEY=${VLLM_API_KEY:-dummy}

Same-VPC app env:
  LOCAL_LLM_BASE_URL=http://${INTERNAL_IP}:${VLLM_PORT}/v1
  LOCAL_STT_PROVIDER=remote_whisper
  LOCAL_STT_MODEL=${REMOTE_WHISPER_MODEL}
  REMOTE_WHISPER_BASE_URL=http://${INTERNAL_IP}:${REMOTE_WHISPER_PORT}

Logs:
  gcloud compute ssh ${INSTANCE_NAME} --project ${PROJECT_ID} --zone ${ZONE} --command 'sudo journalctl -u vllm -f'
  gcloud compute ssh ${INSTANCE_NAME} --project ${PROJECT_ID} --zone ${ZONE} --command 'sudo journalctl -u remote-whisper -f'
EOF

if [[ "$WAIT_FOR_HEALTH" == "true" ]]; then
  log "Waiting for /v1/models. First model load can take several minutes."
  for _ in {1..90}; do
    if curl -fsS "http://${EXTERNAL_IP}:${VLLM_PORT}/v1/models" >/dev/null 2>&1; then
      log "vLLM is responding."
      exit 0
    fi
    sleep 10
  done
  echo "Instance is up, but vLLM did not respond before timeout. Check journalctl logs." >&2
  exit 1
fi
