#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${GCP_ZONE:-us-central1-a}"
INSTANCE_NAME="${GCP_VLLM_INSTANCE_NAME:-voice-agent-vllm}"
FIREWALL_RULE="${GCP_VLLM_FIREWALL_RULE:-voice-agent-vllm-5000}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project <project-id>" >&2
  exit 1
fi

gcloud compute instances delete "$INSTANCE_NAME" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --quiet

if [[ "${DELETE_FIREWALL:-false}" == "true" ]]; then
  gcloud compute firewall-rules delete "$FIREWALL_RULE" \
    --project "$PROJECT_ID" \
    --quiet
fi
