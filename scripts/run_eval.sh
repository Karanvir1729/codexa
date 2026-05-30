#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/backend"

export PYTHONPATH="${PYTHONPATH:-$ROOT_DIR/backend}"
"${PYTHON:-python}" - <<'PY'
import asyncio
from app.agent import Agent
from app.config import get_settings
from app.db import Database
from app.evaluator import EvalRunner
from app.feedback import FeedbackLearner, PromptRepository

settings = get_settings()
db = Database(settings.database_url)
prompt_repo = PromptRepository(db)
agent = Agent(settings, prompt_repo)
learner = FeedbackLearner(db, prompt_repo)
runner = EvalRunner(db, agent, learner)

async def main():
    result = await runner.run_suite(settings.eval_suite_path, apply_feedback=True)
    print(result)

asyncio.run(main())
PY
