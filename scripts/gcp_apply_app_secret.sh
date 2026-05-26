#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
ZONE="${GCP_APP_ZONE:-${GCP_ZONE:-northamerica-northeast1-b}}"
INSTANCE_NAME="${GCP_APP_INSTANCE_NAME:-voice-agent-app}"
REMOTE_DIR="${REMOTE_DIR:-/opt/voice-agent}"
ENV_NAME="${1:-}"
SECRET_NAME="${2:-$ENV_NAME}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or run: gcloud config set project <project-id>" >&2
  exit 1
fi
if [[ -z "$ENV_NAME" ]]; then
  echo "Usage: $0 <ENV_VAR_NAME> [secret-name]" >&2
  exit 1
fi

value="$(gcloud secrets versions access latest --secret "$SECRET_NAME" --project "$PROJECT_ID")"
if [[ -z "$value" ]]; then
  echo "Secret $SECRET_NAME is empty; refusing to write it to the app VM." >&2
  exit 1
fi

tmp_env="$(mktemp)"
printf '%s' "$value" >"$tmp_env"
gcloud compute scp "$tmp_env" "$INSTANCE_NAME:/tmp/${ENV_NAME}.secret" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  >/dev/null
rm -f "$tmp_env"

gcloud compute ssh "$INSTANCE_NAME" \
  --project "$PROJECT_ID" \
  --zone "$ZONE" \
  --command="set -euo pipefail; sudo python3 - <<'PY'
from pathlib import Path
env_name = '${ENV_NAME}'
secret_path = Path('/tmp/${ENV_NAME}.secret')
value = secret_path.read_text()
env_path = Path('${REMOTE_DIR}/.env')
lines = env_path.read_text().splitlines() if env_path.exists() else []
out = []
seen = False
for line in lines:
    if line.startswith(env_name + '='):
        out.append(env_name + '=' + value)
        seen = True
    else:
        out.append(line)
if not seen:
    out.append(env_name + '=' + value)
env_path.write_text('\\n'.join(out) + '\\n')
secret_path.unlink(missing_ok=True)
PY
cd '${REMOTE_DIR}'
sudo docker rm -f gcp_backend_1 >/dev/null 2>&1 || true
sudo docker-compose -f infra/gcp/docker-compose.app.yml up -d --no-deps backend >/dev/null" \
  >/dev/null

echo "Applied Secret Manager secret $SECRET_NAME to $ENV_NAME on $INSTANCE_NAME and recreated backend."
