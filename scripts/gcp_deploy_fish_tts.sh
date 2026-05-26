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
BOOT_DISK_SIZE_GB="${GCP_BOOT_DISK_SIZE_GB:-250}"
BOOT_DISK_TYPE="${GCP_BOOT_DISK_TYPE:-pd-balanced}"
NETWORK="${GCP_NETWORK:-default}"
NETWORK_TAG="${GCP_FISH_TTS_NETWORK_TAG:-voice-agent-fish-tts}"
FISH_MODEL_ID="${FISH_MODEL_ID:-fishaudio/s2-pro}"
FISH_IMAGE="${FISH_IMAGE:-fishaudio/fish-speech:server-cuda}"
FISH_PORT="${FISH_PORT:-8080}"
FISH_COMPILE="${FISH_COMPILE:-true}"
AUTO_STOP_HOURS="${AUTO_STOP_HOURS:-8}"
DRY_RUN="${DRY_RUN:-false}"

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
log "Instance: $INSTANCE_NAME ($MACHINE_TYPE Spot L4)"
log "Fish model: $FISH_MODEL_ID"
log "Auto-stop: ${AUTO_STOP_HOURS}h"

quota_json="$(gcloud compute regions describe "$REGION" --project "$PROJECT_ID" --format=json 2>/dev/null || true)"
if [[ -n "$quota_json" ]]; then
  QUOTA_JSON="$quota_json" python3 - <<'PY'
import json
import os
import sys

data = json.loads(os.environ["QUOTA_JSON"])
quotas = {item.get("metric"): item for item in data.get("quotas", [])}
quota = quotas.get("PREEMPTIBLE_NVIDIA_L4_GPUS")
if not quota:
    print("[gcp-fish-tts] PREEMPTIBLE_NVIDIA_L4_GPUS quota was not reported; create may still validate it.")
    raise SystemExit(0)
limit = float(quota.get("limit", 0))
usage = float(quota.get("usage", 0))
available = limit - usage
print(f"[gcp-fish-tts] PREEMPTIBLE_NVIDIA_L4_GPUS quota: limit={limit:g} usage={usage:g} available={available:g}")
if available < 1:
    print("[gcp-fish-tts] Refusing to deploy: need 1 preemptible L4 GPU quota in this region.", file=sys.stderr)
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

metadata_csv="fish-model-id=${FISH_MODEL_ID},fish-image=${FISH_IMAGE},fish-port=${FISH_PORT},fish-compile=${FISH_COMPILE},auto-stop-hours=${AUTO_STOP_HOURS}"

create_cmd=(gcloud compute instances create "$INSTANCE_NAME"
  --project "$PROJECT_ID"
  --zone "$ZONE"
  --machine-type "$MACHINE_TYPE"
  --image-project "$IMAGE_PROJECT"
  --image-family "$IMAGE_FAMILY"
  --boot-disk-size "${BOOT_DISK_SIZE_GB}GB"
  --boot-disk-type "$BOOT_DISK_TYPE"
  --maintenance-policy TERMINATE
  --provisioning-model SPOT
  --instance-termination-action STOP
  --scopes cloud-platform
  --network "$NETWORK"
  --tags "$NETWORK_TAG"
  --metadata "$metadata_csv"
  --metadata-from-file "startup-script=${STARTUP_SCRIPT}")

if [[ "$DRY_RUN" == "true" ]]; then
  printf '%q ' "${create_cmd[@]}"
  printf '\n'
  exit 0
fi

"${create_cmd[@]}"

log "Created $INSTANCE_NAME. Startup can take several minutes for model/image download."
log "Check logs: gcloud compute ssh $INSTANCE_NAME --zone $ZONE --command='sudo tail -f /var/log/voice-agent-fish-tts-startup.log'"
