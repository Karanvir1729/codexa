#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
SECRET_NAME="${1:-}"
ENV_NAME="${2:-$SECRET_NAME}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project <project-id>" >&2
  exit 1
fi
if [[ -z "$SECRET_NAME" ]]; then
  echo "Usage: $0 <secret-name> [ENV_VAR_NAME]" >&2
  exit 1
fi
if [[ -z "${!ENV_NAME:-}" ]]; then
  echo "Environment variable $ENV_NAME is empty; refusing to create an empty secret." >&2
  exit 1
fi

gcloud services enable secretmanager.googleapis.com --project "$PROJECT_ID" >/dev/null
if ! gcloud secrets describe "$SECRET_NAME" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud secrets create "$SECRET_NAME" \
    --project "$PROJECT_ID" \
    --replication-policy=automatic \
    >/dev/null
fi

printf '%s' "${!ENV_NAME}" | gcloud secrets versions add "$SECRET_NAME" \
  --project "$PROJECT_ID" \
  --data-file=- \
  >/dev/null

echo "Stored $ENV_NAME in Secret Manager secret $SECRET_NAME for project $PROJECT_ID."
