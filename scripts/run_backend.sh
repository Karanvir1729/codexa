#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
python -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port "${PORT:-8000}" --reload

