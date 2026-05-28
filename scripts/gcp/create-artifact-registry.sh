#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

echo "Creating Artifact Registry repo ${HEAD_DEVELOPER_ARTIFACT_REPO} in ${GCP_REGION} if needed..."
if gcloud artifacts repositories describe "${HEAD_DEVELOPER_ARTIFACT_REPO}" --project="${GCP_PROJECT_ID}" --location="${GCP_REGION}" >/dev/null 2>&1; then
  echo "Artifact Registry repo already exists."
else
  gcloud artifacts repositories create "${HEAD_DEVELOPER_ARTIFACT_REPO}" \
    --project="${GCP_PROJECT_ID}" \
    --location="${GCP_REGION}" \
    --repository-format=docker \
    --description="Head Developer worker images" \
    --labels="$(label_args)"
fi

gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet
