#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STARTUP_SCRIPT="${STARTUP_SCRIPT:-${ROOT_DIR}/infra/gcp/startup-voxtral-tts.sh}"

log() {
  printf '[gcp-voxtral-tts] %s\n' "$*"
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

ZONE="${GCP_ZONE:-northamerica-northeast1-b}"
REGION="${GCP_REGION:-${ZONE%-*}}"
INSTANCE_NAME="${GCP_VOXTRAL_TTS_INSTANCE_NAME:-voice-agent-voxtral-tts}"
MACHINE_TYPE="${GCP_VOXTRAL_TTS_MACHINE_TYPE:-g2-standard-12}"
IMAGE_PROJECT="${GCP_IMAGE_PROJECT:-deeplearning-platform-release}"
IMAGE_FAMILY="${GCP_IMAGE_FAMILY:-common-cu129-ubuntu-2204-nvidia-580}"
IMAGE_NAME="${GCP_IMAGE_NAME:-}"
BOOT_DISK_SIZE_GB="${GCP_VOXTRAL_TTS_BOOT_DISK_SIZE_GB:-250}"
BOOT_DISK_TYPE="${GCP_BOOT_DISK_TYPE:-pd-balanced}"
FIREWALL_RULE="${GCP_VOXTRAL_TTS_FIREWALL_RULE:-voice-agent-voxtral-tts-8000}"
INTERNAL_FIREWALL_RULE="${GCP_VOXTRAL_TTS_INTERNAL_FIREWALL_RULE:-voice-agent-voxtral-tts-internal}"
NETWORK="${GCP_NETWORK:-default}"
NETWORK_TAG="${GCP_VOXTRAL_TTS_NETWORK_TAG:-voice-agent-voxtral-tts}"
INTERNAL_ALLOWED_CIDR="${GCP_VOXTRAL_TTS_ALLOWED_CIDR:-${GCP_APP_INTERNAL_CIDR:-10.0.0.0/8}}"
NVIDIA_DRIVER_PACKAGE="${NVIDIA_DRIVER_PACKAGE:-nvidia-driver-580}"

VOXTRAL_MODEL_ID="${VOXTRAL_TTS_MODEL:-mistralai/Voxtral-4B-TTS-2603}"
VOXTRAL_IMAGE="${VOXTRAL_IMAGE:-vllm/vllm-omni:v0.18.0}"
VOXTRAL_PORT="${VOXTRAL_PORT:-8000}"
VOXTRAL_GPU_MEMORY_UTILIZATION="${VOXTRAL_GPU_MEMORY_UTILIZATION:-0.90}"
VOXTRAL_MAX_MODEL_LEN="${VOXTRAL_MAX_MODEL_LEN:-4096}"
VOXTRAL_EXTRA_ARGS="${VOXTRAL_EXTRA_ARGS:-}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-8}"
HUGGINGFACE_TOKEN="${HUGGINGFACE_TOKEN:-${HF_TOKEN:-}}"
DRY_RUN="${DRY_RUN:-false}"
WAIT_FOR_HEALTH="${WAIT_FOR_HEALTH:-false}"

if [[ "${GCP_BILLING_ACK:-false}" != "true" && "$DRY_RUN" != "true" ]]; then
  cat >&2 <<'EOF'
Refusing to launch paid GCP GPU capacity without GCP_BILLING_ACK=true.
This creates a Compute Engine GPU VM for Voxtral TTS. Set AUTO_STOP_HOURS to limit exposure.
EOF
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

log "Project: $PROJECT_ID"
log "Zone: $ZONE"
log "Instance: $INSTANCE_NAME ($MACHINE_TYPE, ${GPU_COUNT} L4 GPU target)"
log "Model: $VOXTRAL_MODEL_ID"
log "Image: $VOXTRAL_IMAGE"
log "Internal allowed CIDR: $INTERNAL_ALLOWED_CIDR"
if [[ -n "$ALLOWED_CIDR" ]]; then
  log "Allowed external CIDR: $ALLOWED_CIDR"
else
  log "External Voxtral API firewall disabled; set ALLOWED_CIDR to expose a test URL."
fi
log "Auto-stop: ${AUTO_STOP_HOURS}h"

region_json="$(gcloud compute regions describe "$REGION" --project "$PROJECT_ID" --format=json 2>/dev/null || true)"
project_json="$(gcloud compute project-info describe --project "$PROJECT_ID" --format=json 2>/dev/null || true)"
if [[ -n "$region_json" || -n "$project_json" ]]; then
  REGION_JSON="$region_json" PROJECT_JSON="$project_json" python3 - "$GPU_COUNT" "$BOOT_DISK_SIZE_GB" "$BOOT_DISK_TYPE" <<'PY'
import json
import os
import sys

need_gpu = float(sys.argv[1])
need_disk = float(sys.argv[2])
boot_disk_type = sys.argv[3]
disk_metric = "SSD_TOTAL_GB" if boot_disk_type == "pd-ssd" else "DISKS_TOTAL_GB"
blocked = False

region_data = json.loads(os.environ["REGION_JSON"] or "{}")
region_quotas = {item.get("metric"): item for item in region_data.get("quotas", [])}
for metric, need in (("NVIDIA_L4_GPUS", need_gpu), (disk_metric, need_disk)):
    quota = region_quotas.get(metric)
    if not quota:
        print(f"[gcp-voxtral-tts] {metric} quota was not reported; create may still validate it.")
        continue
    limit = float(quota.get("limit", 0))
    usage = float(quota.get("usage", 0))
    available = limit - usage
    print(f"[gcp-voxtral-tts] {metric}: limit={limit:g} usage={usage:g} available={available:g}")
    if available < need:
        print(
            f"[gcp-voxtral-tts] Refusing to deploy: need {need:g} available {metric}.",
            file=sys.stderr,
        )
        blocked = True

project_data = json.loads(os.environ["PROJECT_JSON"] or "{}")
project_quotas = {item.get("metric"): item for item in project_data.get("quotas", [])}
quota = project_quotas.get("GPUS_ALL_REGIONS")
if quota:
    limit = float(quota.get("limit", 0))
    usage = float(quota.get("usage", 0))
    available = limit - usage
    print(f"[gcp-voxtral-tts] GPUS_ALL_REGIONS: limit={limit:g} usage={usage:g} available={available:g}")
    if available < need_gpu:
        print("[gcp-voxtral-tts] Refusing to deploy: project-wide GPU quota is exhausted.", file=sys.stderr)
        blocked = True

raise SystemExit(1 if blocked else 0)
PY
fi

if gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" >/dev/null 2>&1; then
  if [[ "${DELETE_EXISTING:-false}" != "true" ]]; then
    echo "Instance $INSTANCE_NAME already exists. Set DELETE_EXISTING=true to recreate it." >&2
    exit 1
  fi
  gcloud compute instances delete "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --quiet
fi

if gcloud compute firewall-rules describe "$INTERNAL_FIREWALL_RULE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  internal_firewall_cmd=(gcloud compute firewall-rules update "$INTERNAL_FIREWALL_RULE"
    --project "$PROJECT_ID"
    --source-ranges "$INTERNAL_ALLOWED_CIDR"
    --allow "tcp:${VOXTRAL_PORT}"
    --target-tags "$NETWORK_TAG")
else
  internal_firewall_cmd=(gcloud compute firewall-rules create "$INTERNAL_FIREWALL_RULE"
    --project "$PROJECT_ID"
    --network "$NETWORK"
    --allow "tcp:${VOXTRAL_PORT}"
    --source-ranges "$INTERNAL_ALLOWED_CIDR"
    --target-tags "$NETWORK_TAG"
    --description "Restrict Voxtral TTS API access to voice-agent internal callers")
fi

external_firewall_cmd=()
if [[ -n "$ALLOWED_CIDR" ]]; then
  if gcloud compute firewall-rules describe "$FIREWALL_RULE" --project "$PROJECT_ID" >/dev/null 2>&1; then
    external_firewall_cmd=(gcloud compute firewall-rules update "$FIREWALL_RULE"
      --project "$PROJECT_ID"
      --source-ranges "$ALLOWED_CIDR"
      --allow "tcp:${VOXTRAL_PORT}"
      --target-tags "$NETWORK_TAG")
  else
    external_firewall_cmd=(gcloud compute firewall-rules create "$FIREWALL_RULE"
      --project "$PROJECT_ID"
      --network "$NETWORK"
      --allow "tcp:${VOXTRAL_PORT}"
      --source-ranges "$ALLOWED_CIDR"
      --target-tags "$NETWORK_TAG"
      --description "Restrict external Voxtral TTS OpenAI-compatible API access for testing")
  fi
fi

metadata_csv="voxtral-model-id=${VOXTRAL_MODEL_ID},voxtral-image=${VOXTRAL_IMAGE},voxtral-port=${VOXTRAL_PORT},voxtral-gpu-memory-utilization=${VOXTRAL_GPU_MEMORY_UTILIZATION},voxtral-max-model-len=${VOXTRAL_MAX_MODEL_LEN},nvidia-driver-package=${NVIDIA_DRIVER_PACKAGE},auto-stop-hours=${AUTO_STOP_HOURS}"
if [[ -n "$VOXTRAL_EXTRA_ARGS" ]]; then
  metadata_csv="${metadata_csv},voxtral-extra-args=${VOXTRAL_EXTRA_ARGS}"
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
  --network "$NETWORK"
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
  shell_quote "${internal_firewall_cmd[@]}"
  if [[ "${#external_firewall_cmd[@]}" -gt 0 ]]; then
    shell_quote "${external_firewall_cmd[@]}"
  fi
  shell_quote "${create_cmd[@]}"
  [[ -n "$hf_token_file" ]] && rm -f "$hf_token_file"
  exit 0
fi

"${internal_firewall_cmd[@]}"
if [[ "${#external_firewall_cmd[@]}" -gt 0 ]]; then
  "${external_firewall_cmd[@]}"
fi
"${create_cmd[@]}"
[[ -n "$hf_token_file" ]] && rm -f "$hf_token_file"

EXTERNAL_IP="$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')"
INTERNAL_IP="$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)')"

cat <<EOF

GCP Voxtral TTS VM created.

Backend env:
  LOCAL_TTS_PROVIDER=voxtral
  VOXTRAL_TTS_BASE_URL=http://${INTERNAL_IP}:${VOXTRAL_PORT}/v1
  VOXTRAL_TTS_MODEL=${VOXTRAL_MODEL_ID}
  VOXTRAL_TTS_VOICE=neutral_female
  VOXTRAL_TTS_RESPONSE_FORMAT=wav

Logs:
  gcloud compute ssh ${INSTANCE_NAME} --project ${PROJECT_ID} --zone ${ZONE} --command 'sudo docker logs -f voxtral-tts-server'
EOF

if [[ -n "$ALLOWED_CIDR" ]]; then
  cat <<EOF

External test URL:
  http://${EXTERNAL_IP}:${VOXTRAL_PORT}/v1/models
EOF
fi

if [[ "$WAIT_FOR_HEALTH" == "true" ]]; then
  log "Waiting for /v1/models. First model load can take several minutes."
  for _ in {1..120}; do
    if [[ -n "$ALLOWED_CIDR" ]] && curl -fsS "http://${EXTERNAL_IP}:${VOXTRAL_PORT}/v1/models" >/dev/null 2>&1; then
      log "Voxtral TTS is responding."
      exit 0
    fi
    if [[ -z "$ALLOWED_CIDR" ]] && gcloud compute ssh "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --command "curl -fsS http://127.0.0.1:${VOXTRAL_PORT}/v1/models >/dev/null" >/dev/null 2>&1; then
      log "Voxtral TTS is responding."
      exit 0
    fi
    sleep 10
  done
  echo "Instance is up, but Voxtral TTS did not respond before timeout. Check docker logs." >&2
  exit 1
fi
