#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

IMAGE_TAG="${IMAGE_TAG:-$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
IMAGE_PLATFORM="${HEAD_DEVELOPER_IMAGE_PLATFORM:-linux/amd64}"
API_IMAGE_URI="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${HEAD_DEVELOPER_ARTIFACT_REPO}/${HEAD_DEVELOPER_API_IMAGE_NAME}:${IMAGE_TAG}"
WORKER_IMAGE_URI="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${HEAD_DEVELOPER_ARTIFACT_REPO}/${HEAD_DEVELOPER_WORKER_IMAGE_NAME}:${IMAGE_TAG}"

docker_helper_configured() {
  node -e '
    const fs = require("fs");
    const configPath = `${process.env.HOME}/.docker/config.json`;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      process.exit(config.credHelpers?.[process.argv[1]] ? 0 : 1);
    } catch {
      process.exit(1);
    }
  ' "${GCP_REGION}-docker.pkg.dev" >/dev/null 2>&1
}

configure_docker_auth() {
  if docker_helper_configured; then
    echo "Docker credential helper already configured for ${GCP_REGION}-docker.pkg.dev."
    return
  fi
  echo "Configuring Docker credential helper for ${GCP_REGION}-docker.pkg.dev..."
  gcloud auth configure-docker "${GCP_REGION}-docker.pkg.dev" --quiet &
  local auth_pid=$!
  for _ in $(seq 1 30); do
    if ! kill -0 "${auth_pid}" 2>/dev/null; then
      wait "${auth_pid}"
      return
    fi
    sleep 1
  done
  kill "${auth_pid}" 2>/dev/null || true
  echo "Timed out configuring Docker credential helper for ${GCP_REGION}-docker.pkg.dev." >&2
  exit 1
}

echo "Building frontend assets for API image..."
npm --prefix "${ROOT_DIR}" run build

echo "Building API image ${API_IMAGE_URI} for ${IMAGE_PLATFORM}..."
configure_docker_auth
docker buildx build --platform "${IMAGE_PLATFORM}" -f "${ROOT_DIR}/docker/Dockerfile.api" -t "${API_IMAGE_URI}" --push "${ROOT_DIR}"

echo "Building worker image ${WORKER_IMAGE_URI} for ${IMAGE_PLATFORM}..."
docker buildx build --platform "${IMAGE_PLATFORM}" -f "${ROOT_DIR}/docker/Dockerfile.worker" -t "${WORKER_IMAGE_URI}" --push "${ROOT_DIR}"

echo "API image pushed: ${API_IMAGE_URI}"
echo "Worker image pushed: ${WORKER_IMAGE_URI}"
echo "Export for deploy:"
echo "  export HEAD_DEVELOPER_API_IMAGE_URI=${API_IMAGE_URI}"
echo "  export HEAD_DEVELOPER_WORKER_IMAGE_URI=${WORKER_IMAGE_URI}"
