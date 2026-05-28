#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults
require_env WORKER_CALLBACK_URL
require_env HEAD_DEVELOPER_WORKER_IMAGE_URI

API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-300}"
PROJECT_API_TIMEOUT_SECONDS="${PROJECT_API_TIMEOUT_SECONDS:-30}"
VM_CREATE_TIMEOUT_SECONDS="${VM_CREATE_TIMEOUT_SECONDS:-180}"
HEAD_DEVELOPER_CODEX_AUTH_METHOD="${HEAD_DEVELOPER_CODEX_AUTH_METHOD:-codex_home_bundle}"
HEAD_DEVELOPER_CODEX_HOME="${HEAD_DEVELOPER_CODEX_HOME:-/codex-home}"
if [[ "${HEAD_DEVELOPER_CODEX_AUTH_METHOD}" != "codex_home_bundle" ]]; then
  echo "This smoke requires HEAD_DEVELOPER_CODEX_AUTH_METHOD=codex_home_bundle." >&2
  exit 1
fi
if [[ -z "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET:-}" && -z "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI:-}" ]]; then
  echo "Missing Codex home bundle source. Set HEAD_DEVELOPER_CODEX_HOME_BUNDLE_SECRET or HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI." >&2
  exit 1
fi

WORKER_CALLBACK_AUDIENCE="${WORKER_CALLBACK_AUDIENCE:-${WORKER_CALLBACK_URL}}"
NONCE="${NONCE:-NONCE-GCP-CODEX-HOME-$(date +%s)-$RANDOM}"
PROMPT="${PROMPT:-Create a static landing page for a glassblowing studio. Include exact text ${NONCE}.}"
POLL_SECONDS="${POLL_SECONDS:-1200}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"
AUTH_HEADER_FILE="$(mktemp)"
REQUEST_FILE="$(mktemp)"
RESPONSE_FILE="$(mktemp)"
vm_name=""
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

print_serial_log_tail() {
  local name="${1:-}"
  if [[ -z "${name}" ]]; then
    return
  fi
  echo "Serial log tail for ${name}:"
  gcloud compute instances get-serial-port-output "${name}" \
    --project="${GCP_PROJECT_ID}" \
    --zone="${GCP_ZONE}" \
    --port=1 \
    --start=-20000 2>/dev/null || true
}

cleanup_vm() {
  local name="${1:-}"
  if [[ "${SMOKE_CLEANUP:-1}" == "0" || -z "${name}" ]]; then
    return
  fi
  if gcloud compute instances describe "${name}" --project="${GCP_PROJECT_ID}" --zone="${GCP_ZONE}" >/dev/null 2>&1; then
    gcloud compute instances delete "${name}" --project="${GCP_PROJECT_ID}" --zone="${GCP_ZONE}" --quiet >/dev/null
  fi
}
trap 'code=$?; if [[ ${code} -ne 0 && -n "${vm_name:-}" ]]; then print_serial_log_tail "${vm_name}"; cleanup_vm "${vm_name}"; fi; rm -f "${AUTH_HEADER_FILE}" "${REQUEST_FILE}" "${RESPONSE_FILE}"; exit ${code}' EXIT

echo "Starting GCP VM Codex home bundle smoke. Nonce: ${NONCE}"
echo "Creating smoke project through bounded-time POST /projects..."
if ! project_json="$(api POST /projects '{"workspace_uri":"/workspace"}' "${PROJECT_API_TIMEOUT_SECONDS}")"; then
  echo "Smoke project creation failed or exceeded ${PROJECT_API_TIMEOUT_SECONDS}s. This avoids the old /projects listing hang." >&2
  exit 1
fi
project_id="$(printf '%s' "${project_json}" | json_get "data => data.project?.project_id")"
if [[ -z "${project_id}" ]]; then
  echo "Could not resolve or create a smoke project." >&2
  exit 1
fi

echo "Creating GCP VM task for smoke project ${project_id}..."
task_body="$(node -e 'const body={project_id:process.argv[1],user_goal:process.argv[2],assign_worker:true,worker_type:"gcp_vm"}; process.stdout.write(JSON.stringify(body));' "${project_id}" "${PROMPT}")"
if ! task_json="$(api POST /tasks "${task_body}")"; then
  echo "Smoke task creation failed or exceeded ${API_TIMEOUT_SECONDS}s before VM creation." >&2
  exit 1
fi
task_id="$(printf '%s' "${task_json}" | json_get "data => data.task?.task_id")"
worker_id="$(printf '%s' "${task_json}" | json_get "data => data.worker?.worker_id")"
vm_name="$(printf '%s' "${task_json}" | json_get "data => data.worker?.vm_name || data.worker?.recorded_vm_name")"

if [[ -z "${task_id}" || -z "${worker_id}" ]]; then
  echo "Could not create GCP VM smoke task." >&2
  exit 1
fi
if [[ -z "${vm_name}" ]]; then
  echo "Task was created but no GCP VM name was returned." >&2
  exit 1
fi

vm_deadline=$((SECONDS + VM_CREATE_TIMEOUT_SECONDS))
while [[ "${SECONDS}" -lt "${vm_deadline}" ]]; do
  if gcloud compute instances describe "${vm_name}" --project="${GCP_PROJECT_ID}" --zone="${GCP_ZONE}" >/dev/null 2>&1; then
    echo "VM created: ${vm_name}"
    break
  fi
  sleep 5
done
if ! gcloud compute instances describe "${vm_name}" --project="${GCP_PROJECT_ID}" --zone="${GCP_ZONE}" >/dev/null 2>&1; then
  echo "VM ${vm_name} was not created within ${VM_CREATE_TIMEOUT_SECONDS}s." >&2
  exit 1
fi

deadline=$((SECONDS + POLL_SECONDS))
status="running"
commands_json='{"commands":[]}'
nonce_seen="no"
while [[ "${SECONDS}" -lt "${deadline}" ]]; do
  task_status_json="$(api GET "/tasks/${task_id}")"
  status="$(printf '%s' "${task_status_json}" | json_get "data => data.task?.status")"
  commands_json="$(api GET "/tasks/${task_id}/commands")"
  nonce_seen="$(printf '%s' "${commands_json}" | node -e 'const fs=require("fs"); const nonce=process.argv[1]; const data=JSON.parse(fs.readFileSync(0,"utf8")); const text=(data.commands || []).map(c => [c.summary,c.stdout_preview,c.stderr_preview].filter(Boolean).join("\\n")).join("\\n"); process.stdout.write(text.includes(nonce) ? "yes" : "no");' "${NONCE}")"
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
flowchart_json="$(api GET /orchestrator/flowchart || true)"
command_event_id="$(printf '%s' "${commands_json}" | json_get "data => (data.commands || []).find(c => /codex exec/.test(c.command))?.event_id")"
generated_files="$(printf '%s' "${commands_json}" | node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const files=new Set(); for (const c of data.commands || []) { const text=[c.summary,c.stdout_preview,c.stderr_preview].filter(Boolean).join("\n"); for (const match of text.matchAll(/(?:created|modified):\s+([^\n,]+)/gi)) files.add(match[1].trim()); } process.stdout.write([...files].join(","));')"
codex_history_evidence="$(printf '%s' "${commands_json}" | json_get "data => (data.commands || []).find(c => /codex exec/.test(c.command))?.codex_session_id || (data.commands || []).find(c => /codex exec/.test(c.command))?.codex_rollout_relative_path || 'not available'")"
flowchart_evidence="$(printf '%s' "${flowchart_json:-{\"nodes\":[],\"edges\":[]}" | node -e 'const fs=require("fs"); const commandId=process.argv[1]; let data={nodes:[],edges:[]}; try { data=JSON.parse(fs.readFileSync(0,"utf8")); } catch {} const text=JSON.stringify(data); const hasCommand=commandId ? text.includes(commandId) : /codex exec/.test(text); const hasGcp=text.includes("gcp_vm"); process.stdout.write(hasCommand && hasGcp ? "yes" : "no");' "${command_event_id:-}")"
if [[ "${status}" == "failed" || "${nonce_seen}" != "yes" ]]; then
  print_serial_log_tail "${vm_name}"
fi
cleanup_result="not requested"
remaining_vm_count="unknown"
if [[ "${SMOKE_CLEANUP:-1}" != "0" && -n "${vm_name:-}" ]]; then
  cleanup_vm "${vm_name}"
  cleanup_result="deleted ${vm_name}"
  remaining_vm_count="$(gcloud compute instances list --project="${GCP_PROJECT_ID}" --filter="name=${vm_name}" --format='value(name)' | wc -l | tr -d ' ')"
fi

bundle_source="Secret Manager bundle"
if [[ -n "${HEAD_DEVELOPER_CODEX_HOME_BUNDLE_GCS_URI:-}" ]]; then
  bundle_source="GCS bundle"
fi

cat <<EOF
GCP Codex home bundle smoke proof:
- VM name: ${vm_name:-unknown}
- Worker image URI: ${HEAD_DEVELOPER_WORKER_IMAGE_URI}
- Cloud Run URL: ${WORKER_CALLBACK_URL}
- Service account used: $(sa_email "${HEAD_DEVELOPER_WORKER_VM_SA}")
- Auth method used: ${HEAD_DEVELOPER_CODEX_AUTH_METHOD}
- Bundle source: ${bundle_source}
- Codex command event ID: ${command_event_id:-not recorded}
- Generated files: ${generated_files:-not recorded}
- Nonce in generated files/events: ${nonce_seen}
- Validation result: ${status}
- Codex history/session evidence: ${codex_history_evidence}
- Flowchart gcp_vm Codex command evidence: ${flowchart_evidence}
- Cleanup result: ${cleanup_result}; remaining matching VMs: ${remaining_vm_count}
EOF

printf '%s' "${workers_json}" >/dev/null
printf '%s' "${summary_json}" >/dev/null
