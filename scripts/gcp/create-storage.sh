#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

echo "Creating artifact bucket gs://${HEAD_DEVELOPER_BUCKET} if needed..."
if gcloud storage buckets describe "gs://${HEAD_DEVELOPER_BUCKET}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "Bucket already exists."
else
  gcloud storage buckets create "gs://${HEAD_DEVELOPER_BUCKET}" \
    --project="${GCP_PROJECT_ID}" \
    --location="${GCP_REGION}" \
    --uniform-bucket-level-access
fi

gcloud storage buckets update "gs://${HEAD_DEVELOPER_BUCKET}" --update-labels="$(label_args)" >/dev/null

WORKER_MEMBER="serviceAccount:$(sa_email "${HEAD_DEVELOPER_WORKER_VM_SA}")"
CONTROL_MEMBER="serviceAccount:$(sa_email "${HEAD_DEVELOPER_CONTROL_PLANE_SA}")"
gcloud storage buckets add-iam-policy-binding "gs://${HEAD_DEVELOPER_BUCKET}" --member="${WORKER_MEMBER}" --role="roles/storage.objectUser" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${HEAD_DEVELOPER_BUCKET}" --member="${CONTROL_MEMBER}" --role="roles/storage.objectUser" >/dev/null
