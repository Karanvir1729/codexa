#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: ${name}" >&2
    exit 1
  fi
}

gcp_defaults() {
  require_env GCP_PROJECT_ID
  export GCP_REGION="${GCP_REGION:-us-central1}"
  export GCP_ZONE="${GCP_ZONE:-us-central1-a}"
  export HEAD_DEVELOPER_ENV="${HEAD_DEVELOPER_ENV:-dev}"
  export HEAD_DEVELOPER_ARTIFACT_REPO="${HEAD_DEVELOPER_ARTIFACT_REPO:-head-developer}"
  export HEAD_DEVELOPER_API_IMAGE_NAME="${HEAD_DEVELOPER_API_IMAGE_NAME:-api}"
  export HEAD_DEVELOPER_WORKER_IMAGE_NAME="${HEAD_DEVELOPER_WORKER_IMAGE_NAME:-worker}"
  export HEAD_DEVELOPER_BUCKET="${HEAD_DEVELOPER_BUCKET:-${GCP_PROJECT_ID}-head-developer-artifacts}"
  export HEAD_DEVELOPER_TOPIC="${HEAD_DEVELOPER_TOPIC:-head-developer-tasks}"
  export HEAD_DEVELOPER_SUBSCRIPTION="${HEAD_DEVELOPER_SUBSCRIPTION:-head-developer-workers}"
  export HEAD_DEVELOPER_TASKS_QUEUE="${HEAD_DEVELOPER_TASKS_QUEUE:-head-developer-tasks}"
  export HEAD_DEVELOPER_CONTROL_PLANE_SA="${HEAD_DEVELOPER_CONTROL_PLANE_SA:-control-plane-sa}"
  export HEAD_DEVELOPER_WORKER_VM_SA="${HEAD_DEVELOPER_WORKER_VM_SA:-worker-vm-sa}"
  export HEAD_DEVELOPER_BUILD_SA="${HEAD_DEVELOPER_BUILD_SA:-build-sa}"
}

label_args() {
  echo "app=head-developer,env=${HEAD_DEVELOPER_ENV}"
}

sa_email() {
  echo "$1@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
}
