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
require_env SERVICE_NAME
require_env ARTIFACT_REPOSITORY
require_env IMAGE_NAME

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required but was not found on PATH." >&2
  exit 1
fi

ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [[ "${ACTIVE_PROJECT}" != "${GCP_PROJECT_ID}" ]]; then
  echo "Active gcloud project '${ACTIVE_PROJECT}' does not match GCP_PROJECT_ID '${GCP_PROJECT_ID}'." >&2
  exit 1
fi

IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${ARTIFACT_REPOSITORY}/${IMAGE_NAME}:latest"

BUILD_CMD=(gcloud builds submit --tag "${IMAGE}" --project "${GCP_PROJECT_ID}")
DEPLOY_CMD=(
  gcloud run deploy "${SERVICE_NAME}"
  --image "${IMAGE}"
  --project "${GCP_PROJECT_ID}"
  --region "${REGION}"
  --no-allow-unauthenticated
)

print_cmd "${BUILD_CMD[@]}"
print_cmd "${DEPLOY_CMD[@]}"

if [[ "${DEPLOY_CONFIRM:-no}" != "yes" ]]; then
  echo "Dry run only. Set DEPLOY_CONFIRM=yes to build and deploy."
  exit 0
fi

"${BUILD_CMD[@]}"
"${DEPLOY_CMD[@]}"
