#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 SECRET_NAME SECRET_VALUE" >&2
  exit 2
fi

printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=-
