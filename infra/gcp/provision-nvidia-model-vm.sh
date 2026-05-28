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

require_env GCP_PROJECT_ID
require_env NVIDIA_VM_ZONE
require_env NVIDIA_VM_NAME
require_env NVIDIA_MACHINE_TYPE
require_env NVIDIA_ACCELERATOR_TYPE
require_env NVIDIA_ACCELERATOR_COUNT
require_env NVIDIA_BOOT_DISK_SIZE_GB
require_env NVIDIA_VM_IMAGE_FAMILY
require_env NVIDIA_VM_IMAGE_PROJECT
require_env NVIDIA_MODEL_CONTAINER_IMAGE
require_env NVIDIA_MODEL_ID
require_env NVIDIA_SERVED_MODEL_NAME
require_env NVIDIA_MODEL_SERVER_PORT
require_env NVIDIA_NIM_API_KEY_SECRET

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is required but was not found on PATH." >&2
  exit 1
fi

ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [[ "${ACTIVE_PROJECT}" != "${GCP_PROJECT_ID}" ]]; then
  echo "Active gcloud project '${ACTIVE_PROJECT}' does not match GCP_PROJECT_ID '${GCP_PROJECT_ID}'." >&2
  exit 1
fi

SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID:-codex-phone-supervisor-api}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
FIREWALL_NAME="${NVIDIA_VM_NAME}-model"

cat <<REPORT
NVIDIA model VM plan
project=${GCP_PROJECT_ID}
zone=${NVIDIA_VM_ZONE}
vm=${NVIDIA_VM_NAME}
machine_type=${NVIDIA_MACHINE_TYPE}
accelerator=${NVIDIA_ACCELERATOR_TYPE}:${NVIDIA_ACCELERATOR_COUNT}
container=${NVIDIA_MODEL_CONTAINER_IMAGE}
model=${NVIDIA_MODEL_ID}
served_model_name=${NVIDIA_SERVED_MODEL_NAME}
port=${NVIDIA_MODEL_SERVER_PORT}
api_key_secret=${NVIDIA_NIM_API_KEY_SECRET}
service_account=${SERVICE_ACCOUNT_EMAIL}
image_family=${NVIDIA_VM_IMAGE_FAMILY}
image_project=${NVIDIA_VM_IMAGE_PROJECT}
allowed_source_ranges=${NVIDIA_ALLOWED_SOURCE_RANGES:-none}
REPORT

if [[ "${DEPLOY_CONFIRM:-no}" != "yes" ]]; then
  echo "Dry run only. Set DEPLOY_CONFIRM=yes to create the GPU VM."
  exit 0
fi

if [[ "${GENERATE_NVIDIA_NIM_API_KEY:-no}" == "yes" ]]; then
  if gcloud secrets versions access latest --project "${GCP_PROJECT_ID}" --secret "${NVIDIA_NIM_API_KEY_SECRET}" >/dev/null 2>&1; then
    echo "Secret already has at least one version: ${NVIDIA_NIM_API_KEY_SECRET}"
  else
    secret_value="$(openssl rand -base64 48)"
    printf '%s' "${secret_value}" | gcloud secrets versions add "${NVIDIA_NIM_API_KEY_SECRET}" --project "${GCP_PROJECT_ID}" --data-file=- >/dev/null
    unset secret_value
    echo "Generated and stored model API key in Secret Manager. Value was not printed."
  fi
fi

if ! gcloud secrets versions access latest --project "${GCP_PROJECT_ID}" --secret "${NVIDIA_NIM_API_KEY_SECRET}" >/dev/null 2>&1; then
  echo "Secret ${NVIDIA_NIM_API_KEY_SECRET} has no readable latest version. Add one or set GENERATE_NVIDIA_NIM_API_KEY=yes." >&2
  exit 1
fi

startup_script="$(mktemp)"
trap 'rm -f "${startup_script}"' EXIT
cat >"${startup_script}" <<'STARTUP'
#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[$(date -Iseconds)] $*"
}

required_metadata() {
  local key="$1"
  curl -fsS -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}"
}

MODEL_CONTAINER_IMAGE="$(required_metadata model-container-image)"
MODEL_ID="$(required_metadata model-id)"
SERVED_MODEL_NAME="$(required_metadata served-model-name)"
MODEL_SERVER_PORT="$(required_metadata model-server-port)"
API_KEY_SECRET="$(required_metadata api-key-secret)"

PROJECT_ID="$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/project/project-id)"

log "Installing Docker and NVIDIA container runtime dependencies."
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io google-cloud-cli
systemctl enable --now docker

log "Installing NVIDIA driver if needed."
if ! command -v nvidia-smi >/dev/null 2>&1; then
  /opt/deeplearning/install-driver.sh || true
fi
nvidia-smi

log "Fetching model API key from Secret Manager."
MODEL_API_KEY="$(gcloud secrets versions access latest --project "${PROJECT_ID}" --secret "${API_KEY_SECRET}")"
if [[ -z "${MODEL_API_KEY}" ]]; then
  echo "Model API key secret is empty." >&2
  exit 1
fi

docker rm -f codex-phone-supervisor-nvidia-model >/dev/null 2>&1 || true
log "Starting OpenAI-compatible NVIDIA model server."
docker run -d \
  --name codex-phone-supervisor-nvidia-model \
  --restart unless-stopped \
  --gpus all \
  -p "${MODEL_SERVER_PORT}:${MODEL_SERVER_PORT}" \
  -e VLLM_API_KEY="${MODEL_API_KEY}" \
  "${MODEL_CONTAINER_IMAGE}" \
  --host 0.0.0.0 \
  --port "${MODEL_SERVER_PORT}" \
  --model "${MODEL_ID}" \
  --served-model-name "${SERVED_MODEL_NAME}" \
  --max-model-len 8192

log "Model server container started."
STARTUP

if gcloud compute instances describe "${NVIDIA_VM_NAME}" --project "${GCP_PROJECT_ID}" --zone "${NVIDIA_VM_ZONE}" >/dev/null 2>&1; then
  echo "VM already exists: ${NVIDIA_VM_NAME}"
else
  run gcloud compute instances create "${NVIDIA_VM_NAME}" \
    --project "${GCP_PROJECT_ID}" \
    --zone "${NVIDIA_VM_ZONE}" \
    --machine-type "${NVIDIA_MACHINE_TYPE}" \
    --accelerator "type=${NVIDIA_ACCELERATOR_TYPE},count=${NVIDIA_ACCELERATOR_COUNT}" \
    --maintenance-policy TERMINATE \
    --provisioning-model STANDARD \
    --boot-disk-size "${NVIDIA_BOOT_DISK_SIZE_GB}GB" \
    --image-family "${NVIDIA_VM_IMAGE_FAMILY}" \
    --image-project "${NVIDIA_VM_IMAGE_PROJECT}" \
    --service-account "${SERVICE_ACCOUNT_EMAIL}" \
    --scopes cloud-platform \
    --tags "${NVIDIA_VM_NAME}" \
    --metadata "install-nvidia-driver=True,model-container-image=${NVIDIA_MODEL_CONTAINER_IMAGE},model-id=${NVIDIA_MODEL_ID},served-model-name=${NVIDIA_SERVED_MODEL_NAME},model-server-port=${NVIDIA_MODEL_SERVER_PORT},api-key-secret=${NVIDIA_NIM_API_KEY_SECRET}" \
    --metadata-from-file "startup-script=${startup_script}"
fi

if [[ -n "${NVIDIA_ALLOWED_SOURCE_RANGES:-}" ]]; then
  if gcloud compute firewall-rules describe "${FIREWALL_NAME}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    echo "Firewall rule exists: ${FIREWALL_NAME}"
  else
    run gcloud compute firewall-rules create "${FIREWALL_NAME}" \
      --project "${GCP_PROJECT_ID}" \
      --allow "tcp:${NVIDIA_MODEL_SERVER_PORT}" \
      --source-ranges "${NVIDIA_ALLOWED_SOURCE_RANGES}" \
      --target-tags "${NVIDIA_VM_NAME}" \
      --description "Restrict access to Codex Phone Supervisor NVIDIA model endpoint"
  fi
else
  echo "No firewall rule created. Set NVIDIA_ALLOWED_SOURCE_RANGES to expose the model endpoint."
fi

cat <<REPORT
NVIDIA model VM provisioning complete.
Set NVIDIA_NIM_BASE_URL to http://<VM_INTERNAL_OR_ALLOWED_EXTERNAL_IP>:${NVIDIA_MODEL_SERVER_PORT}/v1.
Set NVIDIA_NIM_MODEL to ${NVIDIA_SERVED_MODEL_NAME}.
Do not print or commit NVIDIA_NIM_API_KEY.
REPORT
