#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: ${name}" >&2
    exit 1
  fi
}

print_and_run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

print_and_try() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if ! "$@"; then
    echo "WARN: command failed; continuing readiness inspection."
  fi
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

echo "Deployment readiness report"
echo "project=${GCP_PROJECT_ID}"
echo "region=${REGION}"
echo

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

print_and_run gcloud auth list --format='table(account,status)'
print_and_run gcloud projects describe "${GCP_PROJECT_ID}" --format='table(projectId,name,projectNumber,lifecycleState)'
print_and_try gcloud billing projects describe "${GCP_PROJECT_ID}" --format='table(projectId,billingEnabled,billingAccountName)'
print_and_run gcloud services list --enabled --project "${GCP_PROJECT_ID}" --format='table(config.name)'
print_and_try gcloud run services list --project "${GCP_PROJECT_ID}" --region "${REGION}" --format='table(metadata.name,status.url)'
print_and_try gcloud compute instances list --project "${GCP_PROJECT_ID}" --format='table(name,zone.basename(),machineType.basename(),status)'
printf '+ gcloud compute project-info describe %q --format=json\n' "${GCP_PROJECT_ID}"
gcloud compute project-info describe --project "${GCP_PROJECT_ID}" --format=json | node -e 'let input=""; process.stdin.on("data",(chunk)=>input+=chunk); process.stdin.on("end",()=>{const keep=new Set(["TARGET_INSTANCES","CPUS_ALL_REGIONS","GPUS_ALL_REGIONS"]); const rows=(JSON.parse(input).quotas||[]).filter((item)=>keep.has(item.metric)); console.log("PROJECT_QUOTA\tLIMIT\tUSAGE"); for (const item of rows) console.log(`${item.metric}\t${item.limit}\t${item.usage}`);});'
printf '+ gcloud compute regions describe %q --project %q --format=json\n' "${REGION}" "${GCP_PROJECT_ID}"
gcloud compute regions describe "${REGION}" --project "${GCP_PROJECT_ID}" --format=json | node -e 'let input=""; process.stdin.on("data",(chunk)=>input+=chunk); process.stdin.on("end",()=>{const keep=new Set(["CPUS","INSTANCES","NVIDIA_L4_GPUS","NVIDIA_T4_GPUS"]); const rows=(JSON.parse(input).quotas||[]).filter((item)=>keep.has(item.metric)); console.log("REGION_QUOTA\tLIMIT\tUSAGE"); for (const item of rows) console.log(`${item.metric}\t${item.limit}\t${item.usage}`);});'
print_and_try gcloud compute accelerator-types list --project "${GCP_PROJECT_ID}" --filter="zone:(${REGION}-a ${REGION}-b ${REGION}-c ${REGION}-f)" --format='table(name,zone.basename())'
print_and_try gcloud pubsub topics list --project "${GCP_PROJECT_ID}" --format='table(name)'
print_and_try gcloud secrets list --project "${GCP_PROJECT_ID}" --format='table(name)'
print_and_try gcloud artifacts repositories list --project "${GCP_PROJECT_ID}" --location "${REGION}" --format='table(name,format,location)'
print_and_try gcloud storage buckets list --project "${GCP_PROJECT_ID}" --format='table(name,location,public_access_prevention)'
print_and_try gcloud firestore databases list --project "${GCP_PROJECT_ID}" --format='table(name,locationId,type)'
print_and_try gcloud iam service-accounts list --project "${GCP_PROJECT_ID}" --format='table(email,displayName)'

cat <<'REPORT'

Proposed resources:
- Cloud Run service: codex-phone-supervisor-api
- Artifact Registry repository: codex-phone-supervisor
- Pub/Sub topics: codex-phone-supervisor-events, codex-phone-supervisor-approvals, codex-phone-supervisor-audit, codex-phone-supervisor-instructions, codex-phone-supervisor-dead-letter
- Secret Manager secrets: twilio-auth-token, twilio-account-sid, twilio-phone-number-sid, openai-api-key, codex-api-key, github-token
- Firestore database for project/session state
- Cloud Storage bucket for raw logs/artifacts/diffs
- Service account for Cloud Run runtime identity
- Vertex AI/Gemini for supervisor routing, summaries, and risk classification
- Conversational Agents / Dialogflow CX for managed dialog and summaries
- Optional Compute Engine GPU VM for self-hosted NVIDIA NIM/OpenAI-compatible inference

No resources were created by readiness.sh.
REPORT
