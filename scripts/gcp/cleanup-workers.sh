#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
gcp_defaults

ACTION="${ACTION:-stop}"
if [[ "${ACTION}" != "stop" && "${ACTION}" != "delete" ]]; then
  echo "ACTION must be stop or delete." >&2
  exit 1
fi

VMS=()
while IFS= read -r row; do
  [[ -n "${row}" ]] && VMS+=("${row}")
done < <(gcloud compute instances list \
  --project="${GCP_PROJECT_ID}" \
  --filter="labels.app=head-developer AND labels.env=${HEAD_DEVELOPER_ENV}" \
  --format="value(name,zone.basename())")

if [[ "${#VMS[@]}" -eq 0 ]]; then
  echo "No Head Developer worker VMs found for env=${HEAD_DEVELOPER_ENV}."
  exit 0
fi

for row in "${VMS[@]}"; do
  name="$(awk '{print $1}' <<<"${row}")"
  zone="$(awk '{print $2}' <<<"${row}")"
  echo "${ACTION} worker VM ${name} in ${zone}..."
  if [[ "${ACTION}" == "delete" ]]; then
    gcloud compute instances delete "${name}" --project="${GCP_PROJECT_ID}" --zone="${zone}" --quiet
  else
    gcloud compute instances stop "${name}" --project="${GCP_PROJECT_ID}" --zone="${zone}" --quiet
  fi
done
