#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -x ".venv/bin/python" ]]; then
  .venv/bin/python scripts/check_provider_readiness.py "$@"
else
  python3 scripts/check_provider_readiness.py "$@"
fi
