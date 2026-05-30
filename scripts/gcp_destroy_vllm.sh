#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${GCP_VLLM_INSTANCE_NAME:-voice-agent-vllm}"
ZONE="${GCP_ZONE:-us-central1-a}"

gcloud compute instances delete "$INSTANCE_NAME" --zone "$ZONE"
