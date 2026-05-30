#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STARTUP_SCRIPT="${STARTUP_SCRIPT:-${ROOT_DIR}/infra/gcp/startup-fish-tts.sh}"

log() {
  printf '[gcp-fish-tts] %s\n' "$*"
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
require_command python3

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project <project-id>" >&2
  exit 1
fi

ZONE="${GCP_ZONE:-northamerica-northeast1-c}"
REGION="${GCP_REGION:-${ZONE%-*}}"
INSTANCE_NAME="${GCP_FISH_TTS_INSTANCE_NAME:-voice-agent-fish-tts}"
MACHINE_TYPE="${GCP_FISH_TTS_MACHINE_TYPE:-g2-standard-12}"
IMAGE_PROJECT="${GCP_IMAGE_PROJECT:-deeplearning-platform-release}"
IMAGE_FAMILY="${GCP_IMAGE_FAMILY:-common-cu129-ubuntu-2204-nvidia-580}"
IMAGE_NAME="${GCP_IMAGE_NAME:-}"
BOOT_DISK_SIZE_GB="${GCP_BOOT_DISK_SIZE_GB:-250}"
BOOT_DISK_TYPE="${GCP_BOOT_DISK_TYPE:-pd-balanced}"
NETWORK="${GCP_NETWORK:-default}"
NETWORK_TAG="${GCP_FISH_TTS_NETWORK_TAG:-voice-agent-fish-tts}"
FIREWALL_RULE="${GCP_FISH_TTS_INTERNAL_FIREWALL_RULE:-voice-agent-fish-tts-internal}"
INTERNAL_ALLOWED_CIDR="${GCP_FISH_TTS_ALLOWED_CIDR:-${GCP_APP_INTERNAL_CIDR:-10.0.0.0/8}}"
PROVISIONING_MODEL="${GCP_FISH_TTS_PROVISIONING_MODEL:-SPOT}"
NVIDIA_DRIVER_PACKAGE="${NVIDIA_DRIVER_PACKAGE:-nvidia-driver-580}"
FISH_MODEL_ID="${FISH_MODEL_ID:-fishaudio/s2-pro}"
FISH_IMAGE="${FISH_IMAGE:-fishaudio/fish-speech:server-cuda}"
FISH_PORT="${FISH_PORT:-8080}"
FISH_COMPILE="${FISH_COMPILE:-true}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-8}"
DRY_RUN="${DRY_RUN:-false}"
PROVISIONING_MODEL="$(printf '%s' "$PROVISIONING_MODEL" | tr '[:lower:]' '[:upper:]')"

case "$PROVISIONING_MODEL" in
  STANDARD|SPOT) ;;
  *)
    echo "GCP_FISH_TTS_PROVISIONING_MODEL must be STANDARD or SPOT." >&2
    exit 1
    ;;
esac

if [[ "${GCP_BILLING_ACK:-false}" != "true" && "$DRY_RUN" != "true" ]]; then
  cat >&2 <<'EOF'
Refusing to launch paid GCP GPU capacity without GCP_BILLING_ACK=true.
This creates a Compute Engine Spot GPU VM for Fish Speech TTS.
EOF
  exit 1
fi

if [[ ! -f "$STARTUP_SCRIPT" ]]; then
  echo "Missing startup script: $STARTUP_SCRIPT" >&2
  exit 1
fi

log "Project: $PROJECT_ID"
log "Zone: $ZONE"
log "Instance: $INSTANCE_NAME ($MACHINE_TYPE ${PROVISIONING_MODEL} L4)"
log "Fish model: $FISH_MODEL_ID"
log "Internal allowed CIDR: $INTERNAL_ALLOWED_CIDR"
log "Auto-stop: ${AUTO_STOP_HOURS}h"

quota_json="$(gcloud compute regions describe "$REGION" --project "$PROJECT_ID" --format=json 2>/dev/null || true)"
project_quota_json="$(gcloud compute project-info describe --project "$PROJECT_ID" --format=json 2>/dev/null || true)"
if [[ -n "$quota_json" || -n "$project_quota_json" ]]; then
  REGION_QUOTA_JSON="$quota_json" PROJECT_QUOTA_JSON="$project_quota_json" python3 - "$PROVISIONING_MODEL" <<'PY'
import json
import os
import sys

provisioning_model = sys.argv[1]
region_metric = (
    "PREEMPTIBLE_NVIDIA_L4_GPUS"
    if provisioning_model == "SPOT"
    else "NVIDIA_L4_GPUS"
)
blocked = False

region_data = json.loads(os.environ["REGION_QUOTA_JSON"] or "{}")
region_quotas = {item.get("metric"): item for item in region_data.get("quotas", [])}
quota = region_quotas.get(region_metric)
if not quota:
    print(f"[gcp-fish-tts] {region_metric} quota was not reported; create may still validate it.")
else:
    limit = float(quota.get("limit", 0))
    usage = float(quota.get("usage", 0))
    available = limit - usage
    print(f"[gcp-fish-tts] {region_metric}: limit={limit:g} usage={usage:g} available={available:g}")
    if available < 1:
        print(f"[gcp-fish-tts] Refusing to deploy: need 1 available {region_metric}.", file=sys.stderr)
        blocked = True

project_data = json.loads(os.environ["PROJECT_QUOTA_JSON"] or "{}")
project_quotas = {item.get("metric"): item for item in project_data.get("quotas", [])}
quota = project_quotas.get("GPUS_ALL_REGIONS")
if quota:
    limit = float(quota.get("limit", 0))
    usage = float(quota.get("usage", 0))
    available = limit - usage
    print(f"[gcp-fish-tts] GPUS_ALL_REGIONS: limit={limit:g} usage={usage:g} available={available:g}")
    if available < 1:
        print("[gcp-fish-tts] Refusing to deploy: project-wide GPU quota is exhausted.", file=sys.stderr)
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

if gcloud compute firewall-rules describe "$FIREWALL_RULE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  firewall_cmd=(gcloud compute firewall-rules update "$FIREWALL_RULE"
    --project "$PROJECT_ID"
    --source-ranges "$INTERNAL_ALLOWED_CIDR"
    --allow "tcp:${FISH_PORT}"
    --target-tags "$NETWORK_TAG")
else
  firewall_cmd=(gcloud compute firewall-rules create "$FIREWALL_RULE"
    --project "$PROJECT_ID"
    --network "$NETWORK"
    --allow "tcp:${FISH_PORT}"
    --source-ranges "$INTERNAL_ALLOWED_CIDR"
    --target-tags "$NETWORK_TAG"
    --description "Restrict Fish Speech TTS API access to voice-agent internal callers")
fi

metadata_csv="fish-model-id=${FISH_MODEL_ID},fish-image=${FISH_IMAGE},fish-port=${FISH_PORT},fish-compile=${FISH_COMPILE},nvidia-driver-package=${NVIDIA_DRIVER_PACKAGE},auto-stop-hours=${AUTO_STOP_HOURS}"

create_cmd=(gcloud compute instances create "$INSTANCE_NAME"
  --project "$PROJECT_ID"
  --zone "$ZONE"
  --machine-type "$MACHINE_TYPE"
  --image-project "$IMAGE_PROJECT"
  --boot-disk-size "${BOOT_DISK_SIZE_GB}GB"
  --boot-disk-type "$BOOT_DISK_TYPE"
  --maintenance-policy TERMINATE
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

if [[ "$PROVISIONING_MODEL" == "SPOT" ]]; then
  create_cmd+=(--provisioning-model SPOT --instance-termination-action STOP)
else
  create_cmd+=(--provisioning-model STANDARD)
fi

if [[ "$DRY_RUN" == "true" ]]; then
  shell_quote "${firewall_cmd[@]}"
  shell_quote "${create_cmd[@]}"
  exit 0
fi

"${firewall_cmd[@]}"
"${create_cmd[@]}"

INTERNAL_IP="$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)')"

cat <<EOF

GCP Fish Speech TTS VM created.

Backend env:
  LOCAL_TTS_PROVIDER=fish_speech
  FISH_SPEECH_BASE_URL=http://${INTERNAL_IP}:${FISH_PORT}
  FISH_SPEECH_LATENCY=balanced
  LOCAL_TTS_TEXT_AGGREGATION_MODE=sentence

Logs:
  gcloud compute ssh ${INSTANCE_NAME} --project ${PROJECT_ID} --zone ${ZONE} --command 'sudo tail -f /var/log/voice-agent-fish-tts-startup.log'
  gcloud compute ssh ${INSTANCE_NAME} --project ${PROJECT_ID} --zone ${ZONE} --command 'sudo docker logs -f fish-speech-server'
EOF
