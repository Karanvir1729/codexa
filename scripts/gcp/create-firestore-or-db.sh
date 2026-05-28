#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

FIRESTORE_DATABASE="${FIRESTORE_DATABASE:-(default)}"
echo "Creating Firestore database ${FIRESTORE_DATABASE} if needed..."
if gcloud firestore databases describe --database="${FIRESTORE_DATABASE}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "Firestore database already exists."
else
  gcloud firestore databases create \
    --database="${FIRESTORE_DATABASE}" \
    --project="${GCP_PROJECT_ID}" \
    --location="${GCP_REGION}" \
    --type=firestore-native
fi
