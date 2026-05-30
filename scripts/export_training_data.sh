#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
OUTPUT="${1:-data/sft/voice-agent-feedback.jsonl}"

PYTHONPATH=backend python - <<PY
from app.config import get_settings
from app.db import Database
from app.training_data import export_sft_jsonl

settings = get_settings()
result = export_sft_jsonl(Database(settings.database_path), "$OUTPUT")
print(result)
PY
