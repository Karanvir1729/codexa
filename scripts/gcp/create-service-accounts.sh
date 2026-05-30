#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

create_sa() {
  local name="$1"
  local display="$2"
  if gcloud iam service-accounts describe "$(sa_email "${name}")" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    echo "Service account ${name} already exists."
  else
    echo "Creating service account ${name}..."
    gcloud iam service-accounts create "${name}" --project="${GCP_PROJECT_ID}" --display-name="${display}"
  fi
}

grant_role() {
  local member="$1"
  local role="$2"
  echo "Ensuring ${member} has ${role}..."
  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="${member}" \
    --role="${role}" \
    --condition=None >/dev/null
}

create_sa "${HEAD_DEVELOPER_CONTROL_PLANE_SA}" "Head Developer control plane"
create_sa "${HEAD_DEVELOPER_WORKER_VM_SA}" "Head Developer worker VM"
create_sa "${HEAD_DEVELOPER_BUILD_SA}" "Head Developer image builder"

CONTROL="serviceAccount:$(sa_email "${HEAD_DEVELOPER_CONTROL_PLANE_SA}")"
WORKER="serviceAccount:$(sa_email "${HEAD_DEVELOPER_WORKER_VM_SA}")"
BUILD="serviceAccount:$(sa_email "${HEAD_DEVELOPER_BUILD_SA}")"

grant_role "${CONTROL}" "roles/datastore.user"
grant_role "${CONTROL}" "roles/pubsub.publisher"
grant_role "${CONTROL}" "roles/pubsub.subscriber"
grant_role "${CONTROL}" "roles/cloudtasks.enqueuer"
grant_role "${CONTROL}" "roles/logging.logWriter"
grant_role "${CONTROL}" "roles/compute.instanceAdmin.v1"
echo "Allowing control plane to attach only the worker VM service account..."
gcloud iam service-accounts add-iam-policy-binding "$(sa_email "${HEAD_DEVELOPER_WORKER_VM_SA}")" \
  --project="${GCP_PROJECT_ID}" \
  --member="${CONTROL}" \
  --role="roles/iam.serviceAccountUser" >/dev/null

grant_role "${WORKER}" "roles/artifactregistry.reader"
grant_role "${WORKER}" "roles/logging.logWriter"

grant_secret_accessor() {
  local secret_spec="$1"
  local project_hint="${2:-${GCP_PROJECT_ID}}"
  local secret_project="${project_hint}"
  local secret_name="${secret_spec}"
  if [[ "${secret_name}" == projects/*/secrets/* ]]; then
    secret_project="$(awk -F/ '{print $2}' <<<"${secret_name}")"
    secret_name="$(awk -F/ '{print $4}' <<<"${secret_name}")"
  fi
  echo "Granting worker VM service account access to configured Codex auth bundle secret ${secret_name} in project ${secret_project}."
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project="${secret_project}" \
    --member="${WORKER}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
}

if [[ -n "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET:-}" ]]; then
  grant_secret_accessor "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET}" "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_PROJECT:-${GCP_PROJECT_ID}}"
elif [[ -n "${HEAD_DEVELOPER_CODEX_API_KEY_SECRET:-}" ]]; then
  echo "Granting worker VM service account access to the fallback Codex API-key secret name only."
  grant_secret_accessor "${HEAD_DEVELOPER_CODEX_API_KEY_SECRET}" "${HEAD_DEVELOPER_CODEX_API_KEY_SECRET_PROJECT:-${GCP_PROJECT_ID}}"
else
  echo "Codex auth secret access not granted because no Codex home bundle or fallback API-key secret is configured."
fi

if [[ -n "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI:-}" ]]; then
  BUNDLE_BUCKET="${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI#gs://}"
  BUNDLE_BUCKET="${BUNDLE_BUCKET%%/*}"
  echo "Granting worker VM service account read access to Codex home bundle bucket ${BUNDLE_BUCKET}."
  gcloud storage buckets add-iam-policy-binding "gs://${BUNDLE_BUCKET}" \
    --member="${WORKER}" \
    --role="roles/storage.objectViewer" >/dev/null
fi

grant_role "${BUILD}" "roles/artifactregistry.writer"
grant_role "${BUILD}" "roles/logging.logWriter"

echo "No Owner or Editor roles were granted."
