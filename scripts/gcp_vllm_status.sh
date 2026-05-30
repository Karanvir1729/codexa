#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${GCP_ZONE:-us-central1-a}"
INSTANCE_NAME="${GCP_VLLM_INSTANCE_NAME:-voice-agent-vllm}"
VLLM_PORT="${VLLM_PORT:-5000}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project <project-id>" >&2
  exit 1
fi

gcloud compute instances describe "$INSTANCE_NAME" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --format='table(name,status,machineType.basename(),networkInterfaces[0].networkIP,networkInterfaces[0].accessConfigs[0].natIP)'

EXTERNAL_IP="$(gcloud compute instances describe "$INSTANCE_NAME" --project "$PROJECT_ID" --zone "$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
if [[ -n "$EXTERNAL_IP" ]]; then
  echo
  curl -fsS "http://${EXTERNAL_IP}:${VLLM_PORT}/v1/models" || true
  echo
fi

if [[ "${SSH_LOGS:-false}" == "true" ]]; then
  gcloud compute ssh "$INSTANCE_NAME" \
    --project "$PROJECT_ID" \
    --zone "$ZONE" \
    --command 'sudo systemctl --no-pager status vllm; sudo journalctl -u vllm -n 80 --no-pager'
fi
