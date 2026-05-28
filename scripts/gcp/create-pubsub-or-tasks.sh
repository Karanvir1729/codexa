#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

echo "Creating Pub/Sub topic ${HEAD_DEVELOPER_TOPIC} if needed..."
gcloud pubsub topics describe "${HEAD_DEVELOPER_TOPIC}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1 \
  || gcloud pubsub topics create "${HEAD_DEVELOPER_TOPIC}" --project="${GCP_PROJECT_ID}" --labels="$(label_args)"

echo "Creating Pub/Sub subscription ${HEAD_DEVELOPER_SUBSCRIPTION} if needed..."
gcloud pubsub subscriptions describe "${HEAD_DEVELOPER_SUBSCRIPTION}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1 \
  || gcloud pubsub subscriptions create "${HEAD_DEVELOPER_SUBSCRIPTION}" --project="${GCP_PROJECT_ID}" --topic="${HEAD_DEVELOPER_TOPIC}" --labels="$(label_args)"

echo "Creating Cloud Tasks queue ${HEAD_DEVELOPER_TASKS_QUEUE} if needed..."
gcloud tasks queues describe "${HEAD_DEVELOPER_TASKS_QUEUE}" --project="${GCP_PROJECT_ID}" --location="${GCP_REGION}" >/dev/null 2>&1 \
  || gcloud tasks queues create "${HEAD_DEVELOPER_TASKS_QUEUE}" --project="${GCP_PROJECT_ID}" --location="${GCP_REGION}"
