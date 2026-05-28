#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

CODEX_VM_HOME="${CODEX_VM_HOME:-${REPO_ROOT}/.codex-vm-home}"
HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET="${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET:-codex-vm-home-bundle}"
HEAD_DEVELOPER_CODEX_HOME="${HEAD_DEVELOPER_CODEX_HOME:-/codex-home}"
WORKER_MEMBER="serviceAccount:$(sa_email "${HEAD_DEVELOPER_WORKER_VM_SA}")"
SMOKE_NONCE="${SMOKE_NONCE:-NONCE-CODEX-VM-HOME-$(date +%s)-$RANDOM}"
SMOKE_DIR="$(mktemp -d "${REPO_ROOT}/tmp/codex-vm-home-smoke.XXXXXX")"
BUNDLE_FILE="$(mktemp "/tmp/codex-vm-home-bundle.XXXXXX.tgz")"

cleanup() {
  rm -f "${BUNDLE_FILE}"
  rm -rf "${SMOKE_DIR}"
}
trap cleanup EXIT

mkdir -p "${CODEX_VM_HOME}"
chmod 700 "${CODEX_VM_HOME}"

echo "Dedicated Codex VM home: .codex-vm-home"
echo "If login is missing, run: CODEX_HOME=.codex-vm-home codex login"
if ! CODEX_HOME="${CODEX_VM_HOME}" codex login status >/dev/null 2>&1; then
  echo "Codex login is not available for .codex-vm-home. Run CODEX_HOME=.codex-vm-home codex login, then rerun this script." >&2
  CODEX_HOME="${CODEX_VM_HOME}" codex login status
fi

echo "Running local Codex VM home smoke with nonce ${SMOKE_NONCE}..."
(
  CODEX_HOME="${CODEX_VM_HOME}" codex exec \
    --sandbox workspace-write \
    --skip-git-repo-check \
    -C "${SMOKE_DIR}" \
    "Create a file named codex-vm-home-smoke.txt containing ${SMOKE_NONCE}"
)

if [[ ! -f "${SMOKE_DIR}/codex-vm-home-smoke.txt" ]]; then
  echo "Local Codex VM home smoke failed: codex-vm-home-smoke.txt was not created." >&2
  exit 1
fi
if ! grep -Fq "${SMOKE_NONCE}" "${SMOKE_DIR}/codex-vm-home-smoke.txt"; then
  echo "Local Codex VM home smoke failed: nonce was not found in codex-vm-home-smoke.txt." >&2
  exit 1
fi

echo "Packaging dedicated Codex VM home bundle without sessions or logs..."
tar \
  --exclude='./sessions' \
  --exclude='./logs' \
  --exclude='*.log' \
  -czf "${BUNDLE_FILE}" \
  -C "${CODEX_VM_HOME}" .
chmod 600 "${BUNDLE_FILE}"
BUNDLE_BYTES="$(wc -c <"${BUNDLE_FILE}" | tr -d ' ')"
if [[ -z "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI:-}" && "${BUNDLE_BYTES}" -gt 60000 ]]; then
  HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI="gs://${HEAD_DEVELOPER_BUCKET}/codex-auth/codex-vm-home-bundle.tgz"
  echo "Codex home bundle is larger than Secret Manager's payload limit; using restricted GCS instead."
fi

if [[ -n "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI:-}" ]]; then
  BUNDLE_BUCKET="${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI#gs://}"
  BUNDLE_BUCKET="${BUNDLE_BUCKET%%/*}"
  echo "Uploading Codex home bundle to restricted GCS object."
  gcloud storage cp "${BUNDLE_FILE}" "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI}" >/dev/null
  gcloud storage buckets add-iam-policy-binding "gs://${BUNDLE_BUCKET}" \
    --member="${WORKER_MEMBER}" \
    --role="roles/storage.objectViewer" >/dev/null
  echo "Configured auth method: HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle"
  echo "Configured bundle source: HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI=${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI}"
else
  SECRET_PROJECT="${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_PROJECT:-${GCP_PROJECT_ID}}"
  SECRET_NAME="${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET}"
  if [[ "${SECRET_NAME}" == projects/*/secrets/* ]]; then
    SECRET_PROJECT="$(awk -F/ '{print $2}' <<<"${SECRET_NAME}")"
    SECRET_NAME="$(awk -F/ '{print $4}' <<<"${SECRET_NAME}")"
  fi
  if ! gcloud secrets describe "${SECRET_NAME}" --project="${SECRET_PROJECT}" >/dev/null 2>&1; then
    echo "Creating Secret Manager secret for Codex home bundle."
    gcloud secrets create "${SECRET_NAME}" \
      --project="${SECRET_PROJECT}" \
      --replication-policy="automatic" >/dev/null
  fi
  echo "Uploading Codex home bundle as a new Secret Manager version."
  gcloud secrets versions add "${SECRET_NAME}" \
    --project="${SECRET_PROJECT}" \
    --data-file="${BUNDLE_FILE}" >/dev/null
  gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
    --project="${SECRET_PROJECT}" \
    --member="${WORKER_MEMBER}" \
    --role="roles/secretmanager.secretAccessor" >/dev/null
  echo "Configured auth method: HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle"
  echo "Configured bundle source: HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET=${SECRET_NAME}"
  echo "Configured bundle project: HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET_PROJECT=${SECRET_PROJECT}"
fi

echo "Configured worker Codex home: HEAD_DEVELOPER_CODEX_HOME=${HEAD_DEVELOPER_CODEX_HOME}"
echo "Local Codex VM home smoke passed. Temporary unencrypted bundle file will be deleted."
