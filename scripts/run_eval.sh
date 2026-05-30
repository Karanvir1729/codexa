#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../backend"
python - <<'PY'
import asyncio
from app.main import eval_runner

async def main():
    result = await eval_runner.run_suite("evals/conversational_voice.yml", apply_feedback=True)
    print(result)

asyncio.run(main())
PY
