#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

require_env WORKER_CALLBACK_URL
require_env HEAD_DEVELOPER_WORKER_IMAGE_URI
require_env HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI

HEAD_DEVELOPER_CODEX_AUTH_METHOD="${HEAD_DEVELOPER_CODEX_AUTH_METHOD:-codex_home_bundle}"
HEAD_DEVELOPER_CODEX_HOME="${HEAD_DEVELOPER_CODEX_HOME:-/codex-home}"
if [[ "${HEAD_DEVELOPER_CODEX_AUTH_METHOD}" != "codex_home_bundle" ]]; then
  echo "This smoke requires HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle." >&2
  exit 1
fi

GKE_CLUSTER_NAME="${HEAD_DEVELOPER_GKE_CLUSTER_NAME:-head-developer-workers}"
GKE_LOCATION="${HEAD_DEVELOPER_GKE_LOCATION:-${GCP_REGION}}"
GKE_NAMESPACE="${HEAD_DEVELOPER_GKE_NAMESPACE:-head-developer-workers}"
GKE_KSA="${HEAD_DEVELOPER_GKE_KSA:-head-developer-worker}"
GKE_GSA="${HEAD_DEVELOPER_GKE_GSA:-gke-worker-sa@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
CLOUD_RUN_SERVICE="${HEAD_DEVELOPER_CLOUD_RUN_SERVICE:-head-developer-api}"
CONTROL_PLANE_GSA="${HEAD_DEVELOPER_CONTROL_PLANE_GSA:-$(sa_email "${HEAD_DEVELOPER_CONTROL_PLANE_SA}")}"
WORKER_CALLBACK_AUDIENCE="${WORKER_CALLBACK_AUDIENCE:-${WORKER_CALLBACK_URL}}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-300}"
PROJECT_API_TIMEOUT_SECONDS="${PROJECT_API_TIMEOUT_SECONDS:-30}"
POLL_SECONDS="${POLL_SECONDS:-1200}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"
NONCE="${NONCE:-NONCE-GKE-CODEX-HOME-$(date +%s)-$RANDOM}"
PROMPT="${PROMPT:-Create a static landing page for a glassblowing studio. Include exact text ${NONCE}.}"

AUTH_HEADER_FILE="$(mktemp)"
REQUEST_FILE="$(mktemp)"
RESPONSE_FILE="$(mktemp)"
task_id=""
worker_id=""
job_name=""
pod_name=""
trap 'rm -f "${AUTH_HEADER_FILE}" "${REQUEST_FILE}" "${RESPONSE_FILE}"' EXIT

refresh_auth_header() {
  local token
  if [[ -n "${SMOKE_API_BEARER_TOKEN:-}" ]]; then
    token="${SMOKE_API_BEARER_TOKEN}"
  elif ! token="$(gcloud auth print-identity-token --audiences="${WORKER_CALLBACK_AUDIENCE}" 2>/dev/null)"; then
    token="$(gcloud auth print-identity-token)"
  fi
  umask 077
  printf 'Authorization: Bearer %s\n' "${token}" >"${AUTH_HEADER_FILE}"
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local timeout="${4:-${API_TIMEOUT_SECONDS}}"
  refresh_auth_header
  if [[ -n "${body}" ]]; then
    printf '%s' "${body}" >"${REQUEST_FILE}"
    curl -fsS -X "${method}" \
      --max-time "${timeout}" \
      -H @"${AUTH_HEADER_FILE}" \
      -H 'Content-Type: application/json' \
      --data @"${REQUEST_FILE}" \
      "${WORKER_CALLBACK_URL%/}${path}" >"${RESPONSE_FILE}"
  else
    curl -fsS -X "${method}" \
      --max-time "${timeout}" \
      -H @"${AUTH_HEADER_FILE}" \
      "${WORKER_CALLBACK_URL%/}${path}" >"${RESPONSE_FILE}"
  fi
  cat "${RESPONSE_FILE}"
}

json_get() {
  local expression="$1"
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); const value=(${expression})(data); if (value !== undefined && value !== null) process.stdout.write(String(value));"
}

image_repo_parts() {
  node -e 'const uri=process.argv[1]; const m=uri.match(/^([a-z0-9-]+)-docker\.pkg\.dev\/([^/]+)\/([^/]+)\//); if (m) process.stdout.write([m[1],m[2],m[3]].join("\n"));' "${HEAD_DEVELOPER_WORKER_IMAGE_URI}"
}

ensure_gke_setup() {
  echo "Enabling required GKE/worker APIs..."
  gcloud services enable \
    container.googleapis.com \
    artifactregistry.googleapis.com \
    iam.googleapis.com \
    iamcredentials.googleapis.com \
    sts.googleapis.com \
    run.googleapis.com \
    storage.googleapis.com \
    logging.googleapis.com \
    compute.googleapis.com \
    --project="${GCP_PROJECT_ID}" >/dev/null

  if ! gcloud iam service-accounts describe "${GKE_GSA}" --project="${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${GKE_GSA%@*}" \
      --project="${GCP_PROJECT_ID}" \
      --display-name="Head Developer GKE worker" >/dev/null
  fi

  if ! gcloud container clusters describe "${GKE_CLUSTER_NAME}" --project="${GCP_PROJECT_ID}" --location="${GKE_LOCATION}" >/dev/null 2>&1; then
    echo "Creating GKE Autopilot cluster ${GKE_CLUSTER_NAME} in ${GKE_LOCATION}..."
    gcloud container clusters create-auto "${GKE_CLUSTER_NAME}" \
      --project="${GCP_PROJECT_ID}" \
      --location="${GKE_LOCATION}" \
      --release-channel=regular >/dev/null
  fi

  gcloud container clusters get-credentials "${GKE_CLUSTER_NAME}" \
    --project="${GCP_PROJECT_ID}" \
    --location="${GKE_LOCATION}" >/dev/null

  kubectl create namespace "${GKE_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl create serviceaccount "${GKE_KSA}" -n "${GKE_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  gcloud iam service-accounts add-iam-policy-binding "${GKE_GSA}" \
    --project="${GCP_PROJECT_ID}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[${GKE_NAMESPACE}/${GKE_KSA}]" >/dev/null
  kubectl annotate serviceaccount "${GKE_KSA}" -n "${GKE_NAMESPACE}" \
    "iam.gke.io/gcp-service-account=${GKE_GSA}" \
    --overwrite >/dev/null

  local bundle_bucket="${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI#gs://}"
  bundle_bucket="${bundle_bucket%%/*}"
  gcloud storage buckets add-iam-policy-binding "gs://${bundle_bucket}" \
    --member="serviceAccount:${GKE_GSA}" \
    --role="roles/storage.objectViewer" >/dev/null

  gcloud run services add-iam-policy-binding "${CLOUD_RUN_SERVICE}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${GCP_REGION}" \
    --member="serviceAccount:${GKE_GSA}" \
    --role="roles/run.invoker" >/dev/null

  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${GKE_GSA}" \
    --role="roles/logging.logWriter" >/dev/null

  gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
    --member="serviceAccount:${CONTROL_PLANE_GSA}" \
    --role="roles/container.developer" >/dev/null
  kubectl create rolebinding head-developer-api-job-admin \
    -n "${GKE_NAMESPACE}" \
    --clusterrole=admin \
    --user="${CONTROL_PLANE_GSA}" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  local parts
  parts="$(image_repo_parts || true)"
  if [[ -n "${parts}" ]]; then
    local image_location image_project image_repo
    image_location="$(printf '%s\n' "${parts}" | sed -n '1p')"
    image_project="$(printf '%s\n' "${parts}" | sed -n '2p')"
    image_repo="$(printf '%s\n' "${parts}" | sed -n '3p')"
    gcloud artifacts repositories add-iam-policy-binding "${image_repo}" \
      --project="${image_project}" \
      --location="${image_location}" \
      --member="serviceAccount:${GKE_GSA}" \
      --role="roles/artifactregistry.reader" >/dev/null
  fi
}

cleanup_job() {
  if [[ "${SMOKE_CLEANUP:-1}" == "0" || -z "${worker_id:-}" ]]; then
    return
  fi
  kubectl delete job -n "${GKE_NAMESPACE}" \
    -l "app=head-developer,worker_id=${worker_id}" \
    --ignore-not-found=true >/dev/null || true
  kubectl wait --for=delete pod -n "${GKE_NAMESPACE}" \
    -l "app=head-developer,worker_id=${worker_id}" \
    --timeout=90s >/dev/null 2>&1 || true
}

trap 'code=$?; if [[ ${code} -ne 0 && -n "${job_name:-}" ]]; then echo "GKE Job log tail for ${job_name}:"; kubectl logs -n "${GKE_NAMESPACE}" "job/${job_name}" --tail=200 2>/dev/null || true; cleanup_job; fi; rm -f "${AUTH_HEADER_FILE}" "${REQUEST_FILE}" "${RESPONSE_FILE}"; exit ${code}' EXIT

ensure_gke_setup

private_nodes="$(gcloud container clusters describe "${GKE_CLUSTER_NAME}" --project="${GCP_PROJECT_ID}" --location="${GKE_LOCATION}" --format='value(privateClusterConfig.enablePrivateNodes)' 2>/dev/null || true)"
nat_names="$(
  for router in $(gcloud compute routers list --project="${GCP_PROJECT_ID}" --regions="${GCP_REGION}" --format='value(name)' 2>/dev/null || true); do
    gcloud compute routers nats list \
      --project="${GCP_PROJECT_ID}" \
      --router="${router}" \
      --router-region="${GCP_REGION}" \
      --format='value(name)' 2>/dev/null || true
  done | paste -sd, -
)"

echo "Starting GKE Job Codex home bundle smoke. Nonce: ${NONCE}"
echo "Cluster: ${GKE_CLUSTER_NAME}; namespace: ${GKE_NAMESPACE}; KSA: ${GKE_KSA}; GSA: ${GKE_GSA}; control plane GSA: ${CONTROL_PLANE_GSA}"
echo "Private nodes: ${private_nodes:-unknown}; Cloud NAT in ${GCP_REGION}: ${nat_names:-not detected}"
echo "Creating smoke project through bounded-time POST /projects..."
project_json="$(api POST /projects '{"workspace_uri":"/workspace"}' "${PROJECT_API_TIMEOUT_SECONDS}")"
project_id="$(printf '%s' "${project_json}" | json_get "data => data.project?.project_id")"
if [[ -z "${project_id}" ]]; then
  echo "Could not resolve or create a smoke project." >&2
  exit 1
fi

task_body="$(node -e 'const body={project_id:process.argv[1],user_goal:process.argv[2],assign_worker:true,worker_type:"gke_job"}; process.stdout.write(JSON.stringify(body));' "${project_id}" "${PROMPT}")"
task_json="$(api POST /tasks "${task_body}")"
task_id="$(printf '%s' "${task_json}" | json_get "data => data.task?.task_id")"
worker_id="$(printf '%s' "${task_json}" | json_get "data => data.worker?.worker_id")"
job_name="$(printf '%s' "${task_json}" | json_get "data => data.worker?.metadata?.kubernetes_job_name")"
if [[ -z "${task_id}" || -z "${worker_id}" || -z "${job_name}" ]]; then
  echo "Could not create GKE Job smoke task." >&2
  exit 1
fi

deadline=$((SECONDS + POLL_SECONDS))
status="running"
commands_json='{"commands":[]}'
nonce_seen="no"
workspace_nonce_files=""
while [[ "${SECONDS}" -lt "${deadline}" ]]; do
  pod_name="$(kubectl get pods -n "${GKE_NAMESPACE}" -l "app=head-developer,worker_id=${worker_id}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  task_status_json="$(api GET "/tasks/${task_id}")"
  status="$(printf '%s' "${task_status_json}" | json_get "data => data.task?.status")"
  commands_json="$(api GET "/tasks/${task_id}/commands")"
  nonce_seen="$(printf '%s' "${commands_json}" | node -e 'const fs=require("fs"); const nonce=process.argv[1]; const data=JSON.parse(fs.readFileSync(0,"utf8")); const text=(data.commands || []).map(c => [c.command,c.summary,c.stdout_preview,c.stderr_preview].filter(Boolean).join("\n")).join("\n"); process.stdout.write(text.includes(nonce) ? "yes" : "no");' "${NONCE}")"
  if [[ "${status}" == "completed" || "${status}" == "failed" ]]; then
    break
  fi
  sleep "${POLL_INTERVAL_SECONDS}"
done

if [[ -n "${pod_name:-}" ]]; then
  workspace_nonce_files="$(
    kubectl exec -n "${GKE_NAMESPACE}" "${pod_name}" -- node -e '
      const fs = require("fs");
      const path = require("path");
      const nonce = process.argv[1];
      const root = "/workspace";
      const matches = [];
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(absolute);
          else if (entry.isFile()) {
            const content = fs.readFileSync(absolute, "utf8");
            if (content.includes(nonce)) matches.push(path.relative(root, absolute));
          }
        }
      }
      walk(root);
      process.stdout.write(matches.sort().join(","));
    ' "${NONCE}" 2>/dev/null || true
  )"
fi
if [[ -n "${workspace_nonce_files}" ]]; then
  nonce_seen="yes"
fi
command_event_id="$(printf '%s' "${commands_json}" | json_get "data => (data.commands || []).find(c => /codex exec/.test(c.command))?.event_id")"
generated_files="$(printf '%s' "${commands_json}" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const files=new Set(); for (const c of data.commands || []) { const text=[c.summary,c.stdout_preview,c.stderr_preview].filter(Boolean).join("\n"); for (const match of text.matchAll(/(?:created|modified):\s+([^\n,]+)/gi)) files.add(match[1].trim()); } process.stdout.write([...files].join(","));')"
login_status_evidence="$(kubectl logs -n "${GKE_NAMESPACE}" "job/${job_name}" --tail=300 2>/dev/null | grep -E 'Codex auth validated|codex login status' | tail -1 || true)"
cleanup_result="not requested"
remaining_jobs="unknown"
remaining_pods="unknown"
if [[ "${SMOKE_CLEANUP:-1}" != "0" ]]; then
  cleanup_job
  cleanup_result="deleted job label app=head-developer,worker_id=${worker_id}"
  remaining_jobs="$(kubectl get jobs -n "${GKE_NAMESPACE}" -l "app=head-developer,worker_id=${worker_id}" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
  remaining_pods="$(kubectl get pods -n "${GKE_NAMESPACE}" -l "app=head-developer,worker_id=${worker_id}" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
fi

cat <<EOF
GKE Job Codex home bundle smoke proof:
- GKE cluster name: ${GKE_CLUSTER_NAME}
- Namespace: ${GKE_NAMESPACE}
- Kubernetes Job name: ${job_name}
- Pod name: ${pod_name:-not recorded}
- Worker image URI: ${HEAD_DEVELOPER_WORKER_IMAGE_URI}
- Service account / Workload Identity: ${GKE_NAMESPACE}/${GKE_KSA} -> ${GKE_GSA}
- Codex bundle GCS URI: ${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI}
- Cloud Run URL/audience: ${WORKER_CALLBACK_URL} / ${WORKER_CALLBACK_AUDIENCE}
- Private nodes: ${private_nodes:-unknown}; Cloud NAT: ${nat_names:-not detected}
- Codex login status evidence: ${login_status_evidence:-not recorded}
- Codex command event ID: ${command_event_id:-not recorded}
- Generated files: ${generated_files:-not recorded}
- Nonce file proof: ${workspace_nonce_files:-not found in workspace files}
- Nonce in generated files/events: ${nonce_seen}
- Validation result: ${status}
- Cleanup result: ${cleanup_result}; remaining Jobs: ${remaining_jobs}; remaining Pods: ${remaining_pods}
EOF

if [[ "${status}" == "failed" || "${nonce_seen}" != "yes" ]]; then
  exit 1
fi
