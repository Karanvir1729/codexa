#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults
require_env HEAD_DEVELOPER_WORKER_IMAGE_URI
require_env WORKER_CALLBACK_URL

WORKER_ID="${WORKER_ID:-worker-smoke-$(date +%s)}"
TASK_ID="${TASK_ID:-task-smoke}"
PROJECT_ID="${PROJECT_ID:-project-smoke}"
VM_NAME="${VM_NAME:-hd-${WORKER_ID}}"
MACHINE_TYPE="${HEAD_DEVELOPER_GCP_WORKER_MACHINE_TYPE:-e2-standard-2}"
WORKER_IMAGE_FAMILY="${HEAD_DEVELOPER_GCP_WORKER_IMAGE_FAMILY:-cos-stable}"
WORKER_IMAGE_PROJECT="${HEAD_DEVELOPER_GCP_WORKER_IMAGE_PROJECT:-cos-cloud}"
WORKER_SA="$(sa_email "${HEAD_DEVELOPER_WORKER_VM_SA}")"
WORKER_CALLBACK_AUTH="${WORKER_CALLBACK_AUTH:-google_id_token}"
WORKER_CALLBACK_AUDIENCE="${WORKER_CALLBACK_AUDIENCE:-${WORKER_CALLBACK_URL}}"
STARTUP_SCRIPT="$(mktemp)"
trap 'rm -f "${STARTUP_SCRIPT}"' EXIT

cat >"${STARTUP_SCRIPT}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME=/tmp/cos-docker-home
export DOCKER_CONFIG=/tmp/cos-docker-home/.docker
mkdir -p "\${HOME}"
mkdir -p "\${DOCKER_CONFIG}"
if ! command -v docker >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y docker.io
    systemctl enable --now docker || true
  else
    echo "Docker is required on the worker VM image but was not found." >&2
    exit 1
  fi
fi
echo "Authenticating Docker to Artifact Registry with VM service account..."
TOKEN_JSON="\$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token)"
ACCESS_TOKEN="\$(printf '%s' "\${TOKEN_JSON}" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
printf '%s' "\${ACCESS_TOKEN}" | docker login -u oauth2accesstoken --password-stdin https://${GCP_REGION}-docker.pkg.dev >/dev/null
echo "Pulling worker image ${HEAD_DEVELOPER_WORKER_IMAGE_URI}..."
docker pull ${HEAD_DEVELOPER_WORKER_IMAGE_URI}
echo "Starting worker container ${WORKER_ID} for task ${TASK_ID}..."
docker run --rm --name head-developer-worker-smoke \
  -e HEAD_DEVELOPER_WORKER_ID=${WORKER_ID} \
  -e HEAD_DEVELOPER_WORKER_TYPE=gcp_vm \
  -e HEAD_DEVELOPER_TASK_ID=${TASK_ID} \
  -e HEAD_DEVELOPER_PROJECT_ID=${PROJECT_ID} \
  -e HEAD_DEVELOPER_WORKER_IMAGE_URI=${HEAD_DEVELOPER_WORKER_IMAGE_URI} \
  -e WORKER_CALLBACK_URL=${WORKER_CALLBACK_URL} \
  -e WORKER_CALLBACK_AUTH=${WORKER_CALLBACK_AUTH} \
  -e WORKER_CALLBACK_AUDIENCE=${WORKER_CALLBACK_AUDIENCE} \
  -e GCP_PROJECT_ID=${GCP_PROJECT_ID} \
  -e GOOGLE_CLOUD_PROJECT=${GCP_PROJECT_ID} \
  -e SUPERVISOR_MODEL_PROVIDER=${SUPERVISOR_MODEL_PROVIDER:-vertex} \
  -e VERTEX_PROJECT_ID=${VERTEX_PROJECT_ID:-} \
  -e VERTEX_LOCATION=${VERTEX_LOCATION:-} \
  -e VERTEX_MODEL=${VERTEX_MODEL:-} \
  -e HEAD_DEVELOPER_CODEX_AUTH_METHOD=${HEAD_DEVELOPER_CODEX_AUTH_METHOD:-none} \
  -e HEAD_DEVELOPER_CODEX_API_KEY_SECRET=${HEAD_DEVELOPER_CODEX_API_KEY_SECRET:-} \
  -e HEAD_DEVELOPER_CODEX_API_KEY_SECRET_PROJECT=${HEAD_DEVELOPER_CODEX_API_KEY_SECRET_PROJECT:-${GCP_PROJECT_ID}} \
  -e HEAD_DEVELOPER_CODEX_API_KEY_SECRET_VERSION=${HEAD_DEVELOPER_CODEX_API_KEY_SECRET_VERSION:-latest} \
  -e HEAD_DEVELOPER_WORKER_COMMAND=pwd \
  ${HEAD_DEVELOPER_WORKER_IMAGE_URI}
EOF

echo "Creating no-public-IP worker VM ${VM_NAME}..."
gcloud compute instances create "${VM_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --zone="${GCP_ZONE}" \
  --machine-type="${MACHINE_TYPE}" \
  --image-family="${WORKER_IMAGE_FAMILY}" \
  --image-project="${WORKER_IMAGE_PROJECT}" \
  --no-address \
  --service-account="${WORKER_SA}" \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  --metadata-from-file=startup-script="${STARTUP_SCRIPT}" \
  --labels="app=head-developer,env=${HEAD_DEVELOPER_ENV},project_id=${PROJECT_ID},task_id=${TASK_ID},worker_id=${WORKER_ID}"
