#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

echo "Listing Head Developer worker VMs in ${GCP_PROJECT_ID}/${GCP_ZONE}..."
gcloud compute instances list \
  --project="${GCP_PROJECT_ID}" \
  --filter="labels.app=head-developer AND labels.env=${HEAD_DEVELOPER_ENV}" \
  --format="table(name,zone.basename(),machineType.basename(),status,labels.worker_id,labels.task_id,creationTimestamp)"
