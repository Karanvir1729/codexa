#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults
require_env WORKER_CALLBACK_URL
require_env HEAD_DEVELOPER_WORKER_IMAGE_URI
require_env HEAD_DEVELOPER_CODEX_API_KEY_SECRET

WORKER_CALLBACK_AUDIENCE="${WORKER_CALLBACK_AUDIENCE:-${WORKER_CALLBACK_URL}}"
HEAD_DEVELOPER_CODEX_AUTH_METHOD="${HEAD_DEVELOPER_CODEX_AUTH_METHOD:-secret_manager_api_key}"
NONCE="${NONCE:-NONCE-GCP-CODEX-AUTH-$(date +%s)-$RANDOM}"
PROMPT="${PROMPT:-Create a static landing page for a glassblowing studio. Include exact text ${NONCE}.}"
POLL_SECONDS="${POLL_SECONDS:-1200}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"
AUTH_HEADER_FILE="$(mktemp)"
REQUEST_FILE="$(mktemp)"
RESPONSE_FILE="$(mktemp)"
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
  refresh_auth_header
  if [[ -n "${body}" ]]; then
    printf '%s' "${body}" >"${REQUEST_FILE}"
    curl -fsS -X "${method}" \
      -H @"${AUTH_HEADER_FILE}" \
      -H 'Content-Type: application/json' \
      --data @"${REQUEST_FILE}" \
      "${WORKER_CALLBACK_URL%/}${path}" >"${RESPONSE_FILE}"
  else
    curl -fsS -X "${method}" \
      -H @"${AUTH_HEADER_FILE}" \
      "${WORKER_CALLBACK_URL%/}${path}" >"${RESPONSE_FILE}"
  fi
  cat "${RESPONSE_FILE}"
}

json_get() {
  local expression="$1"
  node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); const value=(${expression})(data); if (value !== undefined && value !== null) process.stdout.write(String(value));"
}

echo "Starting GCP VM Codex auth smoke. Nonce: ${NONCE}"
projects_json="$(api GET /projects)"
project_id="$(printf '%s' "${projects_json}" | json_get "data => (data.projects || [])[0]?.project_id")"
if [[ -z "${project_id}" ]]; then
  project_json="$(api POST /projects '{"workspace_uri":"/workspace"}')"
  project_id="$(printf '%s' "${project_json}" | json_get "data => data.project?.project_id")"
fi
if [[ -z "${project_id}" ]]; then
  echo "Could not resolve or create a smoke project." >&2
  exit 1
fi

task_body="$(node -e 'const body={project_id:process.argv[1],user_goal:process.argv[2],assign_worker:true,worker_type:"gcp_vm"}; process.stdout.write(JSON.stringify(body));' "${project_id}" "${PROMPT}")"
task_json="$(api POST /tasks "${task_body}")"
task_id="$(printf '%s' "${task_json}" | json_get "data => data.task?.task_id")"
worker_id="$(printf '%s' "${task_json}" | json_get "data => data.worker?.worker_id")"
vm_name="$(printf '%s' "${task_json}" | json_get "data => data.worker?.vm_name || data.worker?.recorded_vm_name")"

if [[ -z "${task_id}" || -z "${worker_id}" ]]; then
  echo "Could not create GCP VM smoke task." >&2
  exit 1
fi

deadline=$((SECONDS + POLL_SECONDS))
status="running"
commands_json='{"commands":[]}'
while [[ "${SECONDS}" -lt "${deadline}" ]]; do
  task_status_json="$(api GET "/tasks/${task_id}")"
  status="$(printf '%s' "${task_status_json}" | json_get "data => data.task?.status")"
  commands_json="$(api GET "/tasks/${task_id}/commands")"
  nonce_seen="$(printf '%s' "${commands_json}" | node -e 'const fs=require("fs"); const nonce=process.argv[1]; const data=JSON.parse(fs.readFileSync(0,"utf8")); const text=JSON.stringify(data); process.stdout.write(text.includes(nonce) ? "yes" : "no");' "${NONCE}")"
  if [[ "${status}" == "completed" || "${status}" == "failed" ]]; then
    break
  fi
  if [[ "${nonce_seen}" == "yes" ]]; then
    break
  fi
  sleep "${POLL_INTERVAL_SECONDS}"
done

workers_json="$(api GET /workers)"
summary_json="$(api GET "/tasks/${task_id}/summary" || true)"
command_event_id="$(printf '%s' "${commands_json}" | json_get "data => (data.commands || []).find(c => /codex exec/.test(c.command))?.event_id")"
generated_files="$(printf '%s' "${commands_json}" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const files=new Set(); for (const c of data.commands || []) { const text=[c.summary,c.stdout_preview,c.stderr_preview].filter(Boolean).join("\n"); for (const match of text.matchAll(/created:\s+([^\n,]+)/gi)) files.add(match[1].trim()); } process.stdout.write([...files].join(","));')"
nonce_seen="$(printf '%s' "${commands_json}" | node -e 'const fs=require("fs"); const nonce=process.argv[1]; const data=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(JSON.stringify(data).includes(nonce) ? "yes" : "no");' "${NONCE}")"
cleanup_result="not requested"
remaining_vm_count="unknown"
if [[ "${SMOKE_CLEANUP:-1}" != "0" && -n "${vm_name:-}" ]]; then
  if gcloud compute instances describe "${vm_name}" --project="${GCP_PROJECT_ID}" --zone="${GCP_ZONE}" >/dev/null 2>&1; then
    gcloud compute instances delete "${vm_name}" --project="${GCP_PROJECT_ID}" --zone="${GCP_ZONE}" --quiet >/dev/null
    cleanup_result="deleted ${vm_name}"
  else
    cleanup_result="VM ${vm_name} was already absent"
  fi
  remaining_vm_count="$(gcloud compute instances list --project="${GCP_PROJECT_ID}" --filter="name=${vm_name}" --format='value(name)' | wc -l | tr -d ' ')"
fi

cat <<EOF
GCP Codex auth smoke proof:
- VM name: ${vm_name:-unknown}
- Worker image URI: ${HEAD_DEVELOPER_WORKER_IMAGE_URI}
- Cloud Run URL: ${WORKER_CALLBACK_URL}
- Service account used: $(sa_email "${HEAD_DEVELOPER_WORKER_VM_SA}")
- Auth method used: ${HEAD_DEVELOPER_CODEX_AUTH_METHOD} via Secret Manager secret name ${HEAD_DEVELOPER_CODEX_API_KEY_SECRET}
- Codex command event ID: ${command_event_id:-not recorded}
- Generated files: ${generated_files:-not recorded}
- Nonce in generated files/events: ${nonce_seen}
- Validation result: ${status}
- Codex history/session evidence: $(printf '%s' "${commands_json}" | json_get "data => (data.commands || []).find(c => /codex exec/.test(c.command))?.codex_session_id || (data.commands || []).find(c => /codex exec/.test(c.command))?.codex_rollout_relative_path || 'not available'")
- Cleanup result: ${cleanup_result}; remaining matching VMs: ${remaining_vm_count}
EOF

printf '%s' "${workers_json}" >/dev/null
printf '%s' "${summary_json}" >/dev/null
