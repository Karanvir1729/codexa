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

run() {
  print_cmd "$@"
  "$@"
}

run_with_retry_quiet_stdout() {
  local attempt
  for attempt in 1 2 3 4 5; do
    print_cmd "$@"
    if "$@" >/dev/null; then
      return 0
    fi
    if [[ "${attempt}" == "5" ]]; then
      return 1
    fi
    sleep $((attempt * 2))
  done
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

CONTROL_PLANE_PREFIX="${CONTROL_PLANE_PREFIX:-codex-phone-supervisor}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-${CONTROL_PLANE_PREFIX}}"
BUCKET_NAME="${BUCKET_NAME:-${GCP_PROJECT_ID}-${CONTROL_PLANE_PREFIX}-artifacts}"
FIRESTORE_DATABASE="${FIRESTORE_DATABASE:-(default)}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-${REGION}}"
SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID:-${CONTROL_PLANE_PREFIX}-api}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
PUBSUB_TOPICS="${PUBSUB_TOPICS:-${CONTROL_PLANE_PREFIX}-events ${CONTROL_PLANE_PREFIX}-approvals ${CONTROL_PLANE_PREFIX}-audit ${CONTROL_PLANE_PREFIX}-instructions ${CONTROL_PLANE_PREFIX}-dead-letter}"
SECRET_NAMES="${SECRET_NAMES:-twilio-auth-token twilio-account-sid twilio-phone-number-sid openai-api-key github-token nvidia-nim-api-key ngc-api-key}"

if [[ "${#SERVICE_ACCOUNT_ID}" -gt 30 ]]; then
  echo "SERVICE_ACCOUNT_ID must be 30 characters or fewer." >&2
  exit 1
fi

cat <<REPORT
Control-plane resources
project=${GCP_PROJECT_ID}
region=${REGION}
artifact_repository=${ARTIFACT_REPOSITORY}
bucket=${BUCKET_NAME}
firestore_database=${FIRESTORE_DATABASE}
firestore_location=${FIRESTORE_LOCATION}
service_account=${SERVICE_ACCOUNT_EMAIL}
pubsub_topics=${PUBSUB_TOPICS}
secret_names=${SECRET_NAMES}
REPORT

if [[ "${DEPLOY_CONFIRM:-no}" != "yes" ]]; then
  echo "Dry run only. Set DEPLOY_CONFIRM=yes to create resources."
  exit 0
fi

if gcloud artifacts repositories describe "${ARTIFACT_REPOSITORY}" --project "${GCP_PROJECT_ID}" --location "${REGION}" >/dev/null 2>&1; then
  echo "Artifact Registry repository exists: ${ARTIFACT_REPOSITORY}"
else
  run gcloud artifacts repositories create "${ARTIFACT_REPOSITORY}" \
    --project "${GCP_PROJECT_ID}" \
    --location "${REGION}" \
    --repository-format docker \
    --description "Codex Phone Supervisor container images"
fi

for topic in ${PUBSUB_TOPICS}; do
  if gcloud pubsub topics describe "${topic}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    echo "Pub/Sub topic exists: ${topic}"
  else
    run gcloud pubsub topics create "${topic}" --project "${GCP_PROJECT_ID}"
  fi
done

for secret_name in ${SECRET_NAMES}; do
  if gcloud secrets describe "${secret_name}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    echo "Secret exists: ${secret_name}"
  else
    run gcloud secrets create "${secret_name}" \
      --project "${GCP_PROJECT_ID}" \
      --replication-policy automatic
  fi
done

if gcloud storage buckets describe "gs://${BUCKET_NAME}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "Storage bucket exists: gs://${BUCKET_NAME}"
else
  run gcloud storage buckets create "gs://${BUCKET_NAME}" \
    --project "${GCP_PROJECT_ID}" \
    --location "${REGION}" \
    --uniform-bucket-level-access
fi

run gcloud storage buckets update "gs://${BUCKET_NAME}" \
  --project "${GCP_PROJECT_ID}" \
  --public-access-prevention

if gcloud firestore databases describe --database "${FIRESTORE_DATABASE}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "Firestore database exists: ${FIRESTORE_DATABASE}"
else
  run gcloud firestore databases create \
    --database "${FIRESTORE_DATABASE}" \
    --location "${FIRESTORE_LOCATION}" \
    --type firestore-native \
    --project "${GCP_PROJECT_ID}"
fi

if gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "Service account exists: ${SERVICE_ACCOUNT_EMAIL}"
else
  run gcloud iam service-accounts create "${SERVICE_ACCOUNT_ID}" \
    --project "${GCP_PROJECT_ID}" \
    --display-name "Codex Phone Supervisor API"
fi

PROJECT_ROLES=(
  roles/datastore.user
  roles/dialogflow.client
  roles/logging.logWriter
  roles/pubsub.publisher
  roles/pubsub.subscriber
  roles/secretmanager.secretAccessor
)

for role in "${PROJECT_ROLES[@]}"; do
  run_with_retry_quiet_stdout gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role "${role}" \
    --condition None \
    --quiet
done

run_with_retry_quiet_stdout gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role roles/storage.objectAdmin \
  --quiet

cat <<'REPORT'
Control-plane provisioning complete.
No secret values were created or printed.
No Cloud Run service was deployed.
REPORT
