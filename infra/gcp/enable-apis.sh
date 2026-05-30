#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: ${name}" >&2
    exit 1
  fi
}

print_cmd() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

require_env GCP_PROJECT_ID
require_env REGION

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required but was not found on PATH." >&2
  exit 1
fi

ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [[ "${ACTIVE_PROJECT}" != "${GCP_PROJECT_ID}" ]]; then
  echo "Active gcloud project '${ACTIVE_PROJECT}' does not match GCP_PROJECT_ID '${GCP_PROJECT_ID}'." >&2
  exit 1
fi

APIS=(
  run.googleapis.com
  compute.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  dialogflow.googleapis.com
  pubsub.googleapis.com
  firestore.googleapis.com
  storage.googleapis.com
  cloudbuild.googleapis.com
  iam.googleapis.com
)

CMD=(gcloud services enable "${APIS[@]}" --project "${GCP_PROJECT_ID}")
print_cmd "${CMD[@]}"

if [[ "${DEPLOY_CONFIRM:-no}" != "yes" ]]; then
  echo "Dry run only. Set DEPLOY_CONFIRM=yes to enable APIs."
  exit 0
fi

"${CMD[@]}"
